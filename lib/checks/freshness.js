// 文档新鲜度与工作项活性巡检。对应 tools/std/checks/check_freshness.py；契约见 tools/std/CONTRACT.md。
// 执行 01 §3.5（重要文档头部带 `updated_at` 等元信息）与 01 §4.1（活性：任一未终结状态停留超过约定复查时间即触发核实）。
//
// 三态取向（01 §2 N1）：
// - 文档久未更新记 **未定**，不记失败——久未更新可能只是内容稳定，是否过期要人看。
// - 文档没有日期字段：项目在 metadata_required 与 metadata_fields 里都声明了才记 **失败**；任一处靠工具约定都只记未定（契约 §1.1）。
// - 进行中工作项长期无状态转换记 **失败**，但标题写「需核实」：01 §4.1 说的是超龄触发核实，不是自动判违规。
// - metadata_required 命中的文档头部没认出状态字段记 **未定**（D-131）。
//
// 迁移约束：与 Python 版逐 id 相同（黄金样本）。动笔前对每个 Python 字符串、正则、容器操作都问过「JS 里对应的在非 ASCII、非 BMP、边界值上等价吗」（设计 §12.22）：
//   `s[:n]`           → `headChars`（D18，按码点）
//   `\s` / `strip`    → 显式 `PY_WHITESPACE` / `pyStrip`（D6）
//   `\d{4}-\d{2}-\d{2}` → `[0-9]`（D4；D19：Python 的 `\d` 认全角与阿拉伯数字，TS 只认 ASCII——**有意差异**，见设计 §12.6 D19）
//   `splitlines()`    → `splitLinesPy`
//   `str.lower()`     → `toLowerCase()`（两边对全部码点一致，D5 的实测）
//   `lstrip("#")`     → 只去开头的 `#`（不去空白）；`lstrip()` 无参 → 去 Python 空白
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cfgGet, pyStr, pyTruthy } from '../core/cfg.js';
import { metadataRequiredHit, loadConfig } from '../core/config.js';
import { addDays, compareDays, parseDate, toIso, todayLocal } from '../core/dates.js';
import { ACCEPTANCE_CANDIDATES, HEAD_CHARS, STATUS_CANDIDATES, STATUS_FIELDS, artifactTailored, clean, dateFieldsOf, docsRootOf, findField, headChars, inFrozen, isTailoredOut, isWorkItemName, itemStatus, normRel, rebaseDocs, statusKind, under, workRoot, } from '../core/docs.js';
import { FAIL, PASS, SKIP, UNDETERMINED, PY_WHITESPACE, finding, pyLstrip, pyStrip } from '../core/finding.js';
import { fixtureEnv, gitTrack, writeText } from '../core/fixture.js';
import { __testHooks, exists as pathExists, isDir, isFile, readText } from '../core/fs.js';
import { hardenedEnv, shallowProblem } from '../core/git.js';
import { pyRepr } from '../core/repr.js';
import { agg, noteDefault, once, probe, runGuarded, undeterminedFromException, unreadable, workRootAbsent } from '../core/shell.js';
import { dirnameOf, markdownUnder, workItems } from '../core/tracked.js';
import { splitLinesPy, parseYamlSubset } from '../core/yaml.js';
export const NAME = 'freshness';
export const STANDARD_REFS = ['01 §2 N1', '01 §3.2', '01 §3.5', '01 §4.1'];
const DEFAULT_STALE_DAYS = 90; // 标准正文未给文档新鲜度默认值，本工具取 90 天作起步参数
const DEFAULT_WORK_ITEM_STALE_DAYS = 14; // 01 §4.1 的 in_progress 复查参数默认 5 天，本工具放宽到 14
// 01 §3.5 的元信息要求是一个封闭清单：验收、架构、模块、契约、ADR、runbook。索引页、README、PLAYBOOK 不在其列——§3.2 那张表说 INDEX.md 过期是靠链接检查发现的。
// 按目录名约定识别；项目可用 metadata_required 覆盖（路径前缀，相对仓库根）。
const IMPORTANT_DIRS = new Set(['acceptance', 'architecture', 'modules', 'contracts', 'decisions', 'runbooks']);
/**
 * 该文档属不属于 01 §3.5 要求带元信息的那一类。返回五值（**不再返回硬布尔**）：
 *  required      项目配置 metadata_required 命中（项目声明，缺日期可判 FAIL）；
 *  convention    项目没配，路径里出现约定的目录名。约定命中只说明「像」，缺日期按契约 §1.1 只记未定；
 *  not_required  项目配了 metadata_required 而本文件不在清单内（含被 `!` 排除的）：项目自己的声明，确定结论，可记 SKIP；
 *  declared_none 项目把 metadata_required 显式写成空列表 []：声明本项目没有那六类文档，调用方整轮聚成一条 SKIP；与「键缺失」必须分开；
 *  unknown       项目没配，目录名约定也没命中：「算不算那六类」要看内容，不是机械可判定的（契约 §7），按 01 §2 N1 记未定，**不能**记 SKIP。
 */
export function metadataRequirement(cfg, rel) {
    const hit = metadataRequiredHit(cfg, rel); // 包含／`!` 排除只在 core/config 一处判（D-133）
    if (hit !== null)
        return hit ? 'required' : pyTruthy(cfgGet(cfg, 'metadata_required')) ? 'not_required' : 'declared_none';
    const parts = pyStr(rel).replaceAll('\\', '/').split('/').filter((p) => p);
    if (parts.slice(0, -1).some((seg) => IMPORTANT_DIRS.has(seg)))
        return 'convention';
    return 'unknown';
}
// 状态字段词表已并进 core/docs 的 STATUS_FIELDS（01 §1 G2：同一事实一处权威）。
const TRANSITION_FIELDS = ['last_transition_at', 'state_changed_at', '最后状态转换时间', '状态更新时间'];
const TRANSITION_HEADINGS = ['状态转换记录', '状态转换', '转换记录', 'transition'];
const WS = `[${PY_WHITESPACE}]`;
/** 取标题含关键词的那一节正文（到下一个标题为止）。找不到返回 null。 */
export function sectionBody(text, keywords) {
    const lines = splitLinesPy(text);
    let start = null;
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (!pyLstrip(ln).startsWith('#'))
            continue;
        const title = pyStrip(pyLstrip(ln).replace(/^#+/, '')).toLowerCase(); // `ln.lstrip("#")`：去开头的 #；`.strip().lower()`
        if (keywords.some((k) => title.includes(pyStr(k).toLowerCase()))) {
            start = i + 1;
            break;
        }
    }
    if (start === null)
        return null;
    const out = [];
    for (const ln of lines.slice(start)) {
        if (pyLstrip(ln).startsWith('#'))
            break;
        out.push(ln);
    }
    return out.join('\n');
}
/**
 * 该文件最后一次提交的时间。返回 [date, null] 或 [null, 原因]。
 * memo 是一次扫描共用的空数组：浅克隆只探测一次，不每份工作项起一个子进程（C22）。
 * 路径按字面（C02）：`--literal-pathspecs`，文件名带 `[ ]` 时 git 不按通配解读，否则会取到别的文件的提交。
 */
function gitCommitDate(root, rel, memo) {
    if (memo.length === 0)
        memo.push(shallowCheck(root));
    if (memo[0])
        return [null, memo[0]];
    let r;
    try {
        r = spawnSync('git', ['--literal-pathspecs', '-C', root, 'log', '-1', '--format=%cI', '--', rel], { encoding: 'utf8', timeout: 60_000, env: hardenedEnv(process.env) });
    }
    catch (exc) {
        return [null, `跑不了 git log：${exc.message}`];
    }
    if (r.error)
        return [null, `跑不了 git log：${r.error.message}`];
    if (r.status !== 0)
        return [null, `git log 退出码 ${r.status}：${pyStrip(r.stderr ?? '').slice(0, 200)}`]; // py-semantics-ok: 展示——进 reason 的文字，不进判据
    const s = pyStrip(r.stdout ?? '');
    if (!s)
        return [null, 'git log 无输出：该文件没有提交历史'];
    return parseDate(s);
}
const shallowCheck = (root) => shallowProblem(root, hardenedEnv(process.env));
/**
 * 最后一次状态转换时间。成功返回 {d, how}；失败返回 {err: [类别, 原因]}：
 * 类别 'absent' 表示文件里根本没写，可以退到提交时间；'bad' 表示写了但解析不了，按 01 §2 N1 记未定，不退到提交时间去猜。
 */
export function lastTransition(text) {
    const [val, name] = findField(text, TRANSITION_FIELDS);
    if (val) {
        const [d, err] = parseDate(val);
        if (d)
            return { d, how: `取自显式字段 ${name} = ${clean(val)}`, err: null };
        return { d: null, how: null, err: ['bad', `字段 ${name} 的值解析不了（${err}）`] };
    }
    const block = sectionBody(text, TRANSITION_HEADINGS);
    if (block === null)
        return { d: null, how: null, err: ['absent', '文件里没有状态转换记录小节，也没有显式转换时间字段'] };
    // 取最后一条记录（表格行或列表项）里的第一个日期（C10）。不取全节最大值——小节里的备注、计划日期会把停滞的工作项洗成活着；
    // 记录是按发生顺序追加的，最后一条就是最后一次转换。只认小节里第一段连续的记录行：其后的空行、备注列表、第二张表都不算（R2-3）。
    // `re.match(r"\s*(?:\||[-*+]\s)")`：行首 Python 空白，然后 `|`，或 `- * +` 后跟一个 Python 空白。\d 在 Python 里认 Unicode 数字，这里只认 ASCII（D19）。
    const RECORD_LINE = new RegExp(`^${WS}*(?:\\||[-*+]${WS})`);
    const DATE_TOKEN = /[0-9]{4}-[0-9]{2}-[0-9]{2}/g;
    let last = null;
    let started = false;
    for (const ln of splitLinesPy(block)) {
        if (!RECORD_LINE.test(ln)) {
            if (started)
                break;
            continue;
        }
        started = true;
        for (const token of ln.match(DATE_TOKEN) ?? []) {
            const [d] = parseDate(token);
            if (d) {
                last = d;
                break;
            }
        }
    }
    if (last === null) {
        // 有小节却找不到一条带日期的记录：不退到提交时间去猜（01 §2 N1）
        return { d: null, how: null, err: ['bad', '状态转换记录小节里找不到带日期的记录行（表格行或列表项）'] };
    }
    return { d: last, how: `取自状态转换记录的最后一条（${toIso(last)}）`, err: null };
}
/**
 * 距基准日几天。晚一天按当天算（C18）：基准日取运行环境本地日期，记录日期按作者时区写，UTC 的机器上读 UTC+8 当天写的日期就是「明天」；晚两天以上才记未定。
 */
export function age(today, d) {
    const a = compareDays(today, d);
    return a === -1 ? 0 : a;
}
/** 预算取值：缺省取默认并注明；布尔不是整数；非正整数返回原因。返回 [值, 是否用默认, 原因]。 */
export function intBudget(cfg, path, dflt) {
    const raw = cfgGet(cfg, path);
    if (raw === undefined || raw === null)
        return [dflt, true, null];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0)
        return [null, false, `${path} = ${pyRepr(raw)}，不是正整数`];
    return [raw, false, null];
}
export function note(usedDefault, name, value) {
    return usedDefault ? `${name} 用的是本工具默认值 ${value}，项目未校准（契约 §5）` : `${name} = ${value}，取自 project.yaml`;
}
// --------------------------------------------------------------------------
// 契约接口
// --------------------------------------------------------------------------
/**
 * 文档巡检的扫描面：docs_root 与 metadata_required 各包含前缀下（减去 ! 排除的）git 跟踪的 *.md 的并集。
 * 只扫 docs_root 时，项目声明在文档根之外的前缀（根下的 ACCEPTANCE.md、L1 的 work/）一条结论都不出，而契约 §5 说 metadata_required「给了就只认它」——声明了要查却静默不查（D-131）。
 */
function docFiles(cfg, root) {
    const [files, problem] = markdownUnder(root, '');
    if (problem)
        return [null, problem];
    const docsRoot = docsRootOf(cfg)[0];
    return [files.filter((r) => under(r, docsRoot) || metadataRequirement(cfg, r) === 'required'), null];
}
/**
 * layout 已查头部元信息的两件 ★ 工件（验收、状态；落点是单份 .md 时）。取落点与 layout 同一规则：声明了取声明，没声明取候选里第一个存在的。
 * 它们缺日期、缺状态字段由 layout 报，这里不重报（契约 §1 同一事实只报一次）。layout 整个被裁、或该工件在 tailoring 里登记为不适用时 layout 不查，这里照报。
 */
function layoutMetaFiles(cfg, root) {
    if (isTailoredOut(cfg, 'layout')[0])
        return new Set();
    let arts = cfgGet(cfg, 'layout.artifacts');
    if (!pyTruthy(arts))
        arts = {};
    const a = arts !== null && typeof arts === 'object' && !Array.isArray(arts) ? arts : {};
    const out = new Set();
    for (const [role, cands] of [['acceptance', ACCEPTANCE_CANDIDATES], ['status', STATUS_CANDIDATES]]) {
        if (artifactTailored(cfg, role)[0])
            continue;
        const paths = pyTruthy(a[role]) ? [a[role]] : cands.map((c) => rebaseDocs(c, docsRootOf(cfg)[0]));
        for (const p0 of paths) {
            const p = normRel(p0).replace(/^\/+|\/+$/g, '');
            const full = join(root, ...p.split('/'));
            if (pathExists(full)) {
                if (isFile(full) && p.toLowerCase().endsWith('.md'))
                    out.add(p);
                break;
            }
        }
    }
    return out;
}
/**
 * 本次扫描面（docs_root 与 metadata_required 包含前缀，减去 ! 排除的）下各分类各有几份。纯按路径算，不读文件内容。
 * 只为把覆盖边界说准：契约 §2 要求写明「没检查什么」，而「有多少份文档根本没被分类」正是这个检查器最大的盲区。取不到时返回 null，不猜。
 */
function classifyStats(cfg) {
    const root = cfg._root || '.';
    let files, problem;
    try {
        ;
        [files, problem] = docFiles(cfg, root);
    }
    catch {
        return null; // 覆盖边界不该把主流程带崩
    }
    if (problem || files === null)
        return null;
    const stats = { required: 0, not_required: 0, unknown: 0, frozen: 0, scanned: 0 };
    for (const rel of files) {
        if (inFrozen(cfg, rel)) {
            stats.frozen++;
            continue;
        }
        const need = metadataRequirement(cfg, rel);
        // 同是项目声明不需要；约定命中计入「需要」（统计只为说准覆盖边界）
        const key = need === 'declared_none' ? 'not_required' : need === 'convention' ? 'required' : need;
        stats[key]++;
    }
    stats.scanned = stats.required + stats.not_required + stats.unknown;
    return stats;
}
export function scope(cfg) {
    const [docsRoot, dnote] = docsRootOf(cfg);
    const stats = classifyStats(cfg);
    const cls = stats === null
        ? '本次未能统计分类结果（列不出 git 跟踪的文档）'
        : `本次参与分类的 ${stats.scanned} 份文档里（另有归档区 ${stats.frozen} 份不参与），判定为需要元信息 ${stats.required} 份、项目声明不需要 ${stats.not_required} 份、**未能分类 ${stats.unknown} 份**`;
    return {
        covered: [
            `layout.docs_root（当前 ${pyRepr(docsRoot)}${dnote ? '，默认' : ''}）与 metadata_required 各包含前缀下（减去 ! 排除的）git 跟踪的 *.md：日期字段是否存在、是否可解析、距基准日是否超 budgets.stale_days`,
            `layout.work_root（当前 ${pyRepr(workRoot(cfg)[0])}）下状态为进行中的工作项：最后一次状态转换距基准日是否超 budgets.work_item_stale_days。` +
                '最后一次转换取显式转换时间字段，否则取状态转换记录小节第一段连续记录行的最后一条，没有该小节才退到 git 提交时间（浅克隆记未定）',
            'metadata_required 命中的文档头部有没有状态字段（stdlib.STATUS_FIELDS）：没认出的汇成一条未定（freshness/no-status-field），不判取值是否在 01 §3.5 的四值里；' +
                'layout 已查的验收、状态工件与工作项目录里的 WI-* 不在此列（各由 layout、freshness/no-status 报；layout 已查的两件缺日期也不重报，layout 被裁或该工件在 tailoring 里登记不适用时照报）',
            '日期晚基准日一天按当天算（基准日是运行环境本地日期，作者可能在更早的时区写当天日期），晚两天以上记未定',
        ],
        not_covered: [
            'L0 合在状态工件（WORK.md 之类）里的工作项不扫：活性巡检只扫工作项目录，目录不在记 SKIP，目录在不在由 layout 报',
            '**不判断一份文档到底属不属于 01 §3.5 的六类**（验收、架构、模块、契约、ADR、runbook）。未配 metadata_required 时只按目录名约定（' +
                `${[...IMPORTANT_DIRS].sort().join('/')}）识别，这是约定不是判定，会两头误：runbook 放在 docs/ops/ 认不出，中文目录树（docs/架构图、docs/审计记录）天然零命中；` +
                `反过来叫 architecture 的目录里也可能放着别的东西。${cls}。未能分类的不逐份记不适用，整轮汇总成一条未定`,
            '不判断文档内容是否仍然正确，只判它的日期字段——内容对不对不是机械可判定的（契约 §7）',
            '不判断超期文档是否真的过期：超期只记未定，交人确认它是否仍然有效（01 §2 N1）',
            '不看归档区 layout.frozen 里的任何文件（01 §3.1：一次性对齐工件不承担更新义务）',
            '不看未被 git 跟踪的文件，不看 .md 以外的文件（.json、.yaml、.sh、代码注释都不看）',
            '只巡检进行中的工作项；planned / blocked / in_validation 的停滞不看——01 §4.1 里它们的复查时间是每项自己约定的值，工具读不到那个约定',
            '不核实工作项状态是否属实，只读它自己写的状态字段；状态认不出（不在 stdlib.WORK_ITEM_STATES 的六态别名与 project.yaml 声明的词里）的记未定（freshness/unknown-state），不查活性；' +
                'layout.artifacts 声明的工件状态不属六态时按文档认（stdlib.status_kind）：属 01 §3.5 文档四值的不巡检，两表都认不出的记 freshness/unknown-doc-state；未声明的文件写文档四值仍记 unknown-state',
            '状态转换记录只认小节里第一段连续的表格行或列表项，取最后一条里的第一个日期：按新的在上倒序写的记录会取到最旧那条（偏向报超龄）；' +
                '记录行里不按列区分，occurred_at 空着而别的列写了日期时取到那个日期；只有表头、没有记录行的转换表记未定，不退到提交时间',
            '不判断谁该处置超龄工作项，也不代为转 blocked（01 §4.1：巡检只通知负责人核实）',
            '自检不覆盖 git 不可用的分支与自定义日期字段名（metadata_fields 写成 updated_at 以外的名字）的分支，它们的正确性未被反例证明',
        ],
    };
}
export function run(cfg) {
    return runGuarded(NAME, doRun, cfg);
}
/** Python 的 `str(x)` 对 `"%s" % hit` 之类：hit 是字段名（字符串或 null）。 */
const S = (v) => pyStr(v);
function doRun(cfg) {
    const root = cfg._root || '.';
    const today = todayLocal();
    const base = `比较基准日 ${toIso(today)}（取自运行时系统日期）`;
    const texts = new Map(); // 工作项目录在文档根之下时，文档巡检读过的工作项留给活性巡检，不读第二遍（C22）
    // 文档部分整组依赖 docs_root：取了默认就在这里统一注明，不在各条 finding 里逐个拼
    const out = [...noteDefault(checkDocs(cfg, root, today, base, texts), docsRootOf(cfg)[1]), ...checkWorkItems(cfg, root, today, base, texts)];
    return once(out); // 工作项在文档根下且读不了时，文档巡检与活性巡检只报一次（R1-10）
}
function checkDocs(cfg, root, today, base, texts) {
    const [docsRoot, dnote] = docsRootOf(cfg);
    const [days, usedDefault, bad] = intBudget(cfg, 'budgets.stale_days', DEFAULT_STALE_DAYS);
    if (bad) {
        return [finding(NAME, UNDETERMINED, '文档新鲜度阈值不是正整数', { reason: bad, why: '01 §3.5 的复核周期是参数，但必须是可比较的数' })];
    }
    const nt = note(usedDefault, 'budgets.stale_days', days);
    const [names, namesDefault] = dateFieldsOf(cfg);
    const fnote = namesDefault ? `日期字段名用的是默认 ${names.join(', ')}（未配 metadata_fields）` : `日期字段名取自 metadata_fields：${names.join(', ')}`;
    const path = join(root, ...normRel(docsRoot).split('/'));
    if (!isDir(path)) {
        return [finding(NAME, UNDETERMINED, `文档根目录不存在：${docsRoot}`, {
                where: String(docsRoot),
                reason: !dnote ? 'layout.docs_root 指向的目录不在；是配置过期还是目录被移走，本工具判不了' : '未配 layout.docs_root，默认的文档根不在；文档放在别处就在 project.yaml 写明',
                why: '01 §3.1：文档树是约定的位置，位置不成立则新鲜度无从判起',
            })];
    }
    const [files, problem] = docFiles(cfg, root);
    if (problem)
        return [finding(NAME, UNDETERMINED, '列不出 git 跟踪的文档', { reason: problem, why: '契约 §1：依赖不可用记未定，不记通过' })];
    if (!files || files.length === 0) {
        return [finding(NAME, UNDETERMINED, `${docsRoot} 下没有 git 跟踪的 markdown`, {
                where: String(docsRoot), reason: "空集上说不出'全部文档都新鲜'（01 §2 N1：X 为空集时'全部 X 通过'判未定）",
            })];
    }
    const wdir = normRel(workRoot(cfg)[0]).replace(/\/+$/, '');
    const byLayout = layoutMetaFiles(cfg, root);
    const out = [];
    const frozen = [], unclassified = [], declaredNone = [], byConvention = [], fieldGuessed = [], noStatus = [];
    for (const rel of files) {
        if (inFrozen(cfg, rel)) {
            frozen.push(rel);
            continue;
        }
        let text;
        try {
            text = readText(join(root, ...rel.split('/')), root);
        }
        catch (exc) {
            out.push(unreadable(NAME, rel, exc));
            continue;
        }
        const inWdir = dirnameOf(rel) === wdir;
        if (inWdir)
            texts.set(rel, text);
        // 01 §3.5 的状态字段：只查项目声明的清单；layout 已查的两件、WI-* 工作项（活性巡检报 no-status）不重报
        if (!byLayout.has(rel) && !(inWdir && isWorkItemName(rel)) && metadataRequirement(cfg, rel) === 'required' && itemStatus(text) === null)
            noStatus.push(rel);
        const [value, hit] = findField(headChars(text, HEAD_CHARS), names);
        if (value === null || !clean(value)) {
            if (byLayout.has(rel))
                continue; // layout 已查这件的日期字段（契约 §1）；解析不了、超期 layout 不判，照下文走
            const need = metadataRequirement(cfg, rel);
            if (need === 'not_required') {
                out.push(finding(NAME, SKIP, `不要求元信息：${rel}`, {
                    where: String(rel),
                    reason: '项目在 project.yaml 的 metadata_required 里给出了清单，本文件不在其内。这是项目自己的声明，故记不适用（01 §3.5 的元信息要求只覆盖重要文档：验收、架构、模块、契约、ADR、runbook）',
                }));
                continue;
            }
            if (need === 'unknown') {
                unclassified.push(rel);
                continue;
            }
            if (need === 'declared_none') {
                declaredNone.push(rel);
                continue;
            }
            if (need === 'convention') {
                byConvention.push(rel);
                continue;
            }
            if (namesDefault) {
                fieldGuessed.push(rel);
                continue;
            } // 字段名是工具默认，没认出推不出没写（C11，与 layout 同口径）
            out.push(finding(NAME, FAIL, `缺日期字段：${rel}`, {
                where: `${rel}:1`,
                why: `01 §3.5 要求重要文档头部带 ${names.join('/')}；01 §3.2 要求每份文档答得出'它过期了怎么被发现'——没有日期就发现不了`,
                evidence: `文件头 ${HEAD_CHARS} 字符内没有找到 ${names.join('/')}。${fnote}`,
            }));
            continue;
        }
        const [d, err] = parseDate(value);
        if (d === null) {
            out.push(finding(NAME, UNDETERMINED, `日期解析不了：${rel}`, {
                where: `${rel}:1`, reason: `${S(hit)} 的原文是 ${pyRepr(clean(value))}，${err}；本工具不猜日期`, why: '01 §2 N1：证据不足而无法判定记未定', evidence: fnote,
            }));
            continue;
        }
        const a = age(today, d);
        if (a < 0) {
            out.push(finding(NAME, UNDETERMINED, `日期晚于基准日：${rel}`, {
                where: `${rel}:1`, reason: `${S(hit)} = ${toIso(d)}，比基准日晚 ${-a} 天；是笔误还是系统时钟不对，本工具判不了`, why: '01 §2 N1', evidence: base,
            }));
        }
        else if (a > days) {
            out.push(finding(NAME, UNDETERMINED, `${rel} 已 ${a} 天未更新（阈值 ${days} 天）`, {
                where: `${rel}:1`, kind: 'stale', key: rel,
                reason: '超期不等于过期，需人确认它是否仍然有效——久未更新也可能只是内容稳定',
                why: '01 §3.5 元信息带 review_at 是为了到期复核；01 §2 N1 不把判不了的记成通过',
                evidence: `${S(hit)} = ${toIso(d)}，${base}，${nt}。${fnote}`,
            }));
        }
        else {
            out.push(finding(NAME, PASS, `${rel} 距今 ${a} 天，在阈值 ${days} 天内`, { where: rel, evidence: `${S(hit)} = ${toIso(d)}，${base}，${nt}` }));
        }
    }
    if (frozen.length) {
        out.push(agg(NAME, SKIP, '归档区文档不参与新鲜度', frozen, '落在 layout.frozen 内；01 §3.1：一次性对齐工件不承担更新义务', '', 'frozen-docs'));
    }
    if (declaredNone.length) {
        out.push(agg(NAME, SKIP, '缺日期字段，项目声明没有需要日期元数据的文档类', declaredNone, 'project.yaml 把 metadata_required 显式写成空列表：项目声明自己没有 01 §3.5 那六类文档（验收、架构、模块、契约、ADR、runbook）。这是项目自己的声明，故记不适用；' +
            '声明错了由写下它的人负责，本工具不复核。键缺失不是这个意思——那种情况记未定', "契约 §5：metadata_required 给了就只认它；空列表即『一类都不要求』", 'undated-declared-none'));
    }
    if (byConvention.length) {
        out.push(agg(NAME, UNDETERMINED, '缺日期字段，按目录名约定像是 01 §3.5 的六类', byConvention, `项目未配 metadata_required，这些路径里出现了 ${[...IMPORTANT_DIRS].sort().join(' / ')} 之一。目录名是工具的约定，不是项目的声明（契约 §1.1）：命中只说明『像』，推不出『这份必须带日期』，` +
            '故记未定不判 FAIL。要给出定论，在 project.yaml 写 metadata_required', '01 §3.5 元信息要求覆盖六类重要文档；契约 §1.1 约定落空或命中都不产出 FAIL', 'undated-by-convention'));
    }
    if (fieldGuessed.length) {
        out.push(agg(NAME, UNDETERMINED, `metadata_required 要求带日期，但没认出默认日期字段 ${names.join('/')}`, fieldGuessed, '这些文档在 metadata_required 清单内（项目声明），但日期字段名是本工具的默认值、项目没在 metadata_fields 里声明；没认出推不出没写（契约 §1.1）。声明 metadata_fields 之后仍缺才判 FAIL', '01 §3.5 要求重要文档头部带日期；契约 §1.1 字段名约定落空只记未定', 'undated-fields-default'));
    }
    if (noStatus.length) {
        out.push(agg(NAME, UNDETERMINED, 'metadata_required 命中的文档头部没认出状态字段', noStatus, `这些文档在项目声明的 metadata_required 内，但状态字段名是本工具的词表（stdlib.STATUS_FIELDS：${STATUS_FIELDS.join(' / ')}），没认出推不出没写（契约 §1.1），故记未定不判 FAIL；` +
            '取值是否在 01 §3.5 的四值里不判。补状态字段、收窄 metadata_required，或登记例外', '01 §3.5 要求重要文档头部带 status：没有它，读者分不出这份是现行、草稿还是已被取代（D-131）', 'no-status-field'));
    }
    if (unclassified.length) {
        // 整轮一条，不逐份。逐份 SKIP 会把「没看」混进「不适用」里，而且数量一大就把真正的 FAIL 淹掉；聚成一条未定，退出码从 0/1 变 2，报告里也留得下路径清单。
        out.push(agg(NAME, UNDETERMINED, '缺日期字段，且判不了它们属不属于 01 §3.5 的六类', unclassified, '项目未配 metadata_required，且这些路径里没有出现 acceptance / architecture / modules / contracts / decisions / runbooks 任一目录名。' +
            '『这份文档算不算验收/架构/模块/契约/ADR/runbook』要看内容，本工具只按目录名约定识别，机械判不了（契约 §7），故按 01 §2 N1 记未定，不记不适用——不适用是确定结论，这里没有结论。' +
            '要给出定论，在 project.yaml 写 metadata_required（路径前缀清单，**整体替换**目录名约定，不是追加）', '01 §3.5 元信息要求覆盖六类重要文档；01 §2 N1 判不了的不记通过也不记不适用', 'undated-unclassified'));
    }
    return out;
}
// --------------------------------------------------------------------------
// 自检：反例与正例各一（契约 §3）
// --------------------------------------------------------------------------
function sampleCfg(tmp, extra) {
    const cfg = { _root: tmp, layout: { docs_root: 'docs', work_root: 'work' }, budgets: { stale_days: 90, work_item_stale_days: 14 } };
    if (extra)
        Object.assign(cfg, extra);
    return cfg;
}
/**
 * 放在 architecture/ 下：这份样本是**照着被测约定造的**，所以它只能证明「约定命中时判得对」，结构上永远抓不到「约定与标准不匹配」那一类缺陷。
 * 那一类由 sampleUnconventional 覆盖。
 */
function sample(tmp, docText, workText, declared = true) {
    writeText(join(tmp, 'docs', 'architecture', 'a.md'), docText);
    writeText(join(tmp, 'work', 'WI-0001-x.md'), workText);
    const err = gitTrack(tmp);
    return [sampleCfg(tmp, declared ? { metadata_required: ['docs/architecture'], metadata_fields: ['updated_at'] } : undefined), err];
}
/**
 * 路径**不匹配任何目录名约定**的两份无日期文档，其中一份是中文名。造法：一份用真实踩过的形态（RCMS 的 runbook 在 `docs/ops/`，目录名不在 IMPORTANT_DIRS 里），
 * 一份用本工具自己仓库的形态（中文目录 + 中文文件名，一套英文目录名约定对它零命中）。中文名那份是关键——上面那份还能靠加 `*runbook*` 文件名模式蒙对，中文树连蒙的机会都没有。
 */
function sampleUnconventional(tmp, workText, metadataRequired) {
    writeText(join(tmp, 'docs', 'ops', 'pitr-runbook.md'), '# PITR 恢复手册\n\n正文：按时间点恢复的操作步骤。\n');
    writeText(join(tmp, 'docs', '运维', '数据恢复手册.md'), '# 数据恢复手册\n\n正文：故障后的数据恢复步骤。\n');
    writeText(join(tmp, 'work', 'WI-0001-x.md'), workText);
    const err = gitTrack(tmp);
    return [sampleCfg(tmp, metadataRequired !== undefined ? { metadata_required: [...metadataRequired], metadata_fields: ['updated_at'] } : undefined), err];
}
const J = (v) => JSON.stringify(v);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cmpCp = (a, b) => {
    const x = [...a], y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = x[i].codePointAt(0) - y[i].codePointAt(0);
        if (d)
            return d;
    }
    return x.length - y.length;
};
export function selftest() {
    const results = [];
    const tmps = [];
    const mk = (prefix = 'frself-') => { const t = mkdtempSync(join(tmpdir(), prefix)); tmps.push(t); return t; };
    const today = todayLocal();
    const old = toIso(addDays(today, -100));
    const fresh = toIso(addDays(today, -1));
    const gitErr = (err) => (err ? `；git 准备失败：${err}` : '');
    const statuses = (fs) => fs.map((f) => f.status);
    try {
        {
            const tmp = mk();
            const [cfg, err] = sample(tmp, '# 一份没有日期的文档\n\nstatus: active\n\n正文。\n', `# WI-0001\n\n状态：**in_progress**\n\n## 状态转换记录\n\n| from → to | 时间 |\n|---|---|\n| planned → in_progress | ${old} |\n`);
            const got = err ? [] : statuses(run(cfg));
            const ok = !err && got.length > 0 && new Set(got).size === 1 && got[0] === FAIL && got.length === 2;
            results.push(probe(NAME, ok, '反例：无日期文档 + 停滞 100 天的进行中工作项，应各判一条 FAIL', { evidence: `实得 ${J(got)}${gitErr(err)}`, why: '契约 §3 静默失效探测：抓不出违规的检查器，其结论作废' }));
        }
        {
            const tmp = mk();
            const [cfg, err] = sample(tmp, `---\nid: DOC-1\nstatus: active\nupdated_at: ${fresh}\n---\n\n# 有日期的文档\n`, `# WI-0001\n\n状态：**in_progress**\n\n## 状态转换记录\n\n| from → to | 时间 |\n|---|---|\n| planned → in_progress | ${fresh} |\n`);
            const got = err ? [] : statuses(run(cfg));
            const ok = !err && got.length > 0 && new Set(got).size === 1 && got[0] === PASS && got.length === 2;
            results.push(probe(NAME, ok, '正例：昨天更新的文档 + 昨天刚转换的进行中工作项，应各判一条 PASS', { evidence: `实得 ${J(got)}${gitErr(err)}`, why: '契约 §3 静默失效探测：把正常样本判成违规的检查器同样不可用' }));
        }
        const workFresh = `# WI-0001\n\n状态：**in_progress**\n\n## 状态转换记录\n\n| from → to | 时间 |\n|---|---|\n| planned → in_progress | ${fresh} |\n`;
        // 反例三：路径不匹配约定（含中文名），未配 metadata_required。必须落到聚合未定，**不得**出现逐份 SKIP「不要求元信息」——那是拿「没看」冒充「不适用」。
        {
            const tmp = mk();
            const [cfg, err] = sampleUnconventional(tmp, workFresh);
            const res = err ? [] : run(cfg);
            const skips = res.filter((f) => f.status === SKIP && f.title.includes('不要求元信息'));
            const aggs = res.filter((f) => f.status === UNDETERMINED && f.title.includes('判不了它们'));
            const ev = aggs.length ? aggs[0].evidence ?? '' : '';
            const ok = !err && skips.length === 0 && aggs.length === 1 && ev.includes('docs/ops/pitr-runbook.md') && ev.includes('docs/运维/数据恢复手册.md');
            results.push(probe(NAME, ok, '反例三：路径不匹配目录名约定（含中文名）的无日期文档，未配 metadata_required 时须记聚合未定，不得逐份记不适用', {
                evidence: `实得 ${J(statuses(res))}；逐份 SKIP ${skips.length} 条，聚合未定 ${aggs.length} 条，证据 ${pyRepr(ev.slice(0, 160))}${gitErr(err)}`, // py-semantics-ok: 展示
                why: '契约 §7 只做机械判定 + 01 §2 N1 判不了记未定；SKIP 是确定结论，『这份算不算重要文档』不是机械可判定的',
            }));
        }
        // 反例四：同一样本配上 metadata_required。同时钉死它的**替换语义**：只写 docs/ops，中文那份就从「未分类」变成「项目声明不需要」，而不是继续按目录名约定判。
        {
            const tmp = mk();
            const [cfg, err] = sampleUnconventional(tmp, workFresh, ['docs/ops']);
            const res = err ? [] : run(cfg);
            const fails = res.filter((f) => f.status === FAIL && f.title.includes('pitr-runbook'));
            const skips = res.filter((f) => f.status === SKIP && f.title.includes('数据恢复手册'));
            const aggs = res.filter((f) => f.status === UNDETERMINED && f.title.includes('判不了它们'));
            const ok = !err && fails.length === 1 && skips.length === 1 && aggs.length === 0;
            results.push(probe(NAME, ok, '反例四：配了 metadata_required: [docs/ops] 后，命中的判 FAIL、未命中的判不适用，不再有未分类（钉死『替换而非追加』的语义）', {
                evidence: `实得 ${J(statuses(res))}；命中 FAIL ${fails.length} 条，未命中 SKIP ${skips.length} 条，残留聚合未定 ${aggs.length} 条${gitErr(err)}`,
                why: '契约 §5：metadata_required 给了就只认它，整体替换目录名约定',
            }));
        }
        // 反例四之二：metadata_required 显式写成空列表 `[]`，是项目声明「一类都不要求」，须整轮一条 SKIP、不留聚合未定；同一样本不配这个键（反例三）才记未定——两者不得混同。
        // 取值经解析器读出，连同「解析器接受 `[]`」一起钉住。
        {
            const tmp = mk();
            const declared = parseYamlSubset('metadata_required: []\n').metadata_required;
            const [cfg, err] = sampleUnconventional(tmp, workFresh, declared);
            const res = err ? [] : run(cfg);
            const skips = res.filter((f) => f.status === SKIP && f.title.includes('项目声明没有'));
            const aggs = res.filter((f) => f.status === UNDETERMINED && f.title.includes('判不了它们'));
            const ev = skips.length ? skips[0].evidence ?? '' : '';
            const ok = !err && skips.length === 1 && aggs.length === 0 && !statuses(res).includes(FAIL) && ev.includes('docs/ops/pitr-runbook.md') && ev.includes('docs/运维/数据恢复手册.md');
            results.push(probe(NAME, ok, '反例四之二：metadata_required: [] 时无日期文档整轮记一条不适用，不留聚合未定（键缺失才记未定，见反例三）', {
                evidence: `实得 ${J(statuses(res))}；声明型 SKIP ${skips.length} 条，残留聚合未定 ${aggs.length} 条${gitErr(err)}`,
                why: '契约 §5：空列表是项目的声明，键缺失是没声明，前者可给确定结论、后者不能',
            }));
        }
        // 反例六（契约 §1.1，D-123）：未配 metadata_required，目录名约定命中的无日期文档只记未定
        {
            const tmp = mk();
            const [cfg, err] = sample(tmp, '# 一份没有日期的文档\n\n正文。\n', workFresh, false);
            const res = err ? [] : run(cfg);
            const conv = res.filter((f) => f.id === `${NAME}/undated-by-convention`);
            const ok = !err && conv.length === 1 && conv[0].status === UNDETERMINED && !statuses(res).includes(FAIL);
            results.push(probe(NAME, ok, '反例六：未配 metadata_required 时目录名约定命中的无日期文档只记未定，不判 FAIL', {
                evidence: `实得 ${J(res.map((f) => [f.status, f.id]))}${gitErr(err)}`, why: '契约 §1.1：目录名是工具约定，约定命中或落空都不产出 FAIL',
            }));
        }
        // 反例八（D-131）：metadata_required 前缀在 docs_root 之外（L1 的 work/）时照样扫——无日期判 FAIL、有日期判 PASS；修前这两份一条结论都不出
        {
            const got = {};
            for (const [tag, body] of [['undated', '# 留证\n\n状态：active\n'], ['dated', `状态：active\nupdated_at: ${fresh}\n`]]) {
                const tmp = mk();
                writeText(join(tmp, 'work', 'artifacts', 'x.md'), body);
                const [cfg, err] = sample(tmp, `状态：active\nupdated_at: ${fresh}\n`, workFresh);
                cfg.metadata_required = ['docs/architecture', 'work'];
                got[tag] = err ? err : run(cfg).filter((f) => (f.where ?? '').startsWith('work/artifacts/x.md')).map((f) => f.status);
            }
            results.push(probe(NAME, eq(got, { undated: [FAIL], dated: [PASS] }), '反例八：docs_root 之外的 metadata_required 前缀照扫，无日期判 FAIL、有日期判 PASS', {
                evidence: `实得 ${J(got)}`, why: '契约 §5：metadata_required 给了就只认它，声明了要查不能静默不查',
            }));
        }
        // 反例九（D-131）：metadata_required 命中、头部没认出状态字段的文档汇成一条未定（id 不随份数变），不判 FAIL；带状态字段的不进；
        // layout 已查的状态工件、活性巡检已报 no-status 的 WI-* 不重报（契约 §1）
        const nostatus = (extra) => {
            const tmp = mk();
            const dated = `updated_at: ${fresh}\n`;
            for (let i = 0; i < extra; i++)
                writeText(join(tmp, 'docs', 'architecture', `n${i}.md`), dated);
            writeText(join(tmp, 'docs', 'architecture', 'b.md'), '状态：进行中\n' + dated);
            writeText(join(tmp, 'docs', 'architecture', 'S.md'), '# 声明的状态工件，缺日期也缺状态\n');
            writeText(join(tmp, 'docs', 'architecture', 'late.md'), dated + 'x'.repeat(HEAD_CHARS) + '\nstatus: active\n');
            writeText(join(tmp, 'ACCEPTANCE.md'), dated); // 验收走候选路径，未声明落点
            writeText(join(tmp, 'work', 'WI-0002-y.md'), dated);
            const [cfg, err] = sample(tmp, dated, workFresh);
            cfg.metadata_required = ['docs/architecture', 'work', 'ACCEPTANCE.md'];
            cfg.layout.artifacts = { status: 'docs/architecture/S.md' };
            if (err)
                return err;
            // 与 Python 版同一写法：过滤看 where（work/WI-0001 那份样本工作项的 FAIL 不算），输出取 evidence 或 where
            return run(cfg).filter((f) => f.status !== PASS && f.id !== `${NAME}/not-work-item` && !(f.where ?? '').startsWith('work/WI-0001')).map((f) => [f.status, f.id, f.evidence || f.where]);
        };
        {
            const a = nostatus(0), b = nostatus(2);
            const ok = eq(a, [[UNDETERMINED, `${NAME}/no-status-field`, 'docs/architecture/a.md；docs/architecture/late.md'], [UNDETERMINED, `${NAME}/no-status`, 'work/WI-0002-y.md']]) &&
                Array.isArray(b) && eq(b.map((x) => x[1]), a.map((x) => x[1]));
            results.push(probe(NAME, ok, '反例九：metadata_required 命中而没认出状态字段的文档记一条聚合未定，状态字段只认头部；带状态的、layout 已查的（声明落点与候选路径两种，缺日期也不重报）、WI-* 不进；份数变 id 不变', {
                evidence: `1 份：${J(a)}；3 份：${J(b)}`, why: '01 §3.5 要求头部带 status；状态字段名是工具词表，契约 §1.1 只记未定；契约 §1 同一事实只报一次',
            }));
        }
        // 反例九之二（D-131）：验收工件在 tailoring 里登记为不适用、或 layout 整个被裁时 layout 不查它，缺状态字段改由这里报（仍只一次）
        {
            const got = {};
            for (const tag of ['layout:acceptance', 'layout']) {
                const tmp = mk();
                writeText(join(tmp, 'ACCEPTANCE.md'), `updated_at: ${fresh}\n`);
                const [cfg, err] = sample(tmp, `status: active\nupdated_at: ${fresh}\n`, workFresh);
                cfg.metadata_required = ['docs/architecture', 'ACCEPTANCE.md'];
                cfg.tailoring = [{ check: tag, applicable: false, reason: '样本' }];
                got[tag] = err ? err : run(cfg).filter((f) => f.status !== PASS).map((f) => [f.id, f.evidence]);
            }
            const want = [[`${NAME}/no-status-field`, 'ACCEPTANCE.md']];
            results.push(probe(NAME, eq(got, { 'layout:acceptance': want, layout: want }), '反例九之二：验收工件被 tailoring 裁掉、或 layout 整个被裁时，它缺状态字段由 freshness 报一条未定', {
                evidence: `非通过项 ${J(got)}`, why: '契约 §1：layout 不查的，不能因以为它查了而谁都不报',
            }));
        }
        // 反例八之二（D-131）：落在 layout.frozen 内的前缀不产出结论（归档区）；metadata_required 写成 "./"、"."、空或以 / 、.. 起头时整份配置拒收并报行号——
        // 不猜整仓（会扫进内嵌 .std/）也不当不命中（拿没看冒充不适用）
        {
            const tmp = mk();
            writeText(join(tmp, 'work', 'old', 'y.md'), '# 归档\n');
            const [cfg, err] = sample(tmp, `status: active\nupdated_at: ${fresh}\n`, workFresh);
            cfg.metadata_required = ['docs/architecture', 'work'];
            cfg.layout.frozen = ['work/old'];
            const got = err ? err : run(cfg).filter((f) => (f.status === FAIL || f.status === UNDETERMINED) && `${f.where}${f.evidence}`.includes('work/old')).map((f) => [f.status, f.id]);
            const rejected = {};
            for (const v of ['"./"', '"."', '""', '/abs', '../x']) {
                writeText(join(tmp, 'governance', 'project.yaml'), `tier: L0\nmetadata_required:\n  - docs\n  - ${v}\n`);
                const [, prob] = loadConfig(tmp);
                rejected[v] = !!prob && prob.includes('第 2 行 metadata_required');
            }
            const ok = eq(got, []) && Object.values(rejected).every((x) => x);
            results.push(probe(NAME, ok, '反例八之二：layout.frozen 内的前缀不产出失败或未定；metadata_required 写成 ./ 、. 、空、/ 或 .. 起头整份拒收并报行号', {
                evidence: `归档区 ${J(got)}；拒收 ${J(rejected)}`, why: '01 §3.1 归档区不承担更新义务；契约 §5 写错不猜',
            }));
        }
        // 反例八之三（D-133）：`!` 排除前缀从包含里减——被排除的无日期无状态文档在文档根内只记一条不适用、不进缺日期 FAIL 与缺状态未定（同一事实只报一次），在文档根外不进扫描面；
        // 未排除的照判 FAIL。开头带 "./" 的写法（包含与排除）与不带的同判——此前 "./docs" 合法却永远不命中（D-133 记原有缺陷）
        {
            const got = {};
            for (const [tag, pre] of [['plain', ''], ['dot', './']]) {
                const tmp = mk();
                writeText(join(tmp, 'docs', 'architecture', 'index.md'), '# 索引\n');
                writeText(join(tmp, 'docs', 'architecture', 'keep.md'), 'status: active\n');
                writeText(join(tmp, 'work', 'raw', 'r.md'), '# 工具原文\n');
                const [cfg, err] = sample(tmp, `status: active\nupdated_at: ${fresh}\n`, workFresh);
                cfg.metadata_required = [`${pre}docs/architecture`, `${pre}work`, `!${pre}docs/architecture/index.md`, `!${pre}work/raw/`];
                const res = err ? [] : run(cfg);
                got[tag] = err ? err : Object.fromEntries(['index.md', 'keep.md', 'work/raw'].map((k) => [k, res.filter((f) => `${f.where}|${f.evidence}`.includes(k)).map((f) => f.status)]));
            }
            const want = { 'index.md': [SKIP], 'keep.md': [FAIL], 'work/raw': [] };
            results.push(probe(NAME, eq(got, { plain: want, dot: want }), '反例八之三：! 排除的文档只记一条不适用、文档根外的不扫，未排除的无日期照判 FAIL；开头带 ./ 的写法同判', {
                evidence: `实得 ${J(got)}`, why: '契约 §5：排除是项目声明，从包含里减；契约 §1 同一事实只报一次',
            }));
        }
        // 反例八之四（D-133）：排除前缀写法非法、不落在包含之下、只有排除没有包含、与包含相同，整份拒收并报行号；裸写 ! 被解析器拒收时提示加引号；合法的（含 ./ 起头）照收
        {
            const rej = '第 2 行 metadata_required';
            const cases = [
                ["  - docs\n  - '!'\n", rej], ["  - docs\n  - '!/docs/x'\n", rej], ["  - docs\n  - '!../x'\n", rej], ["  - docs\n  - '!.'\n", rej], ["  - docs\n  - '!./'\n", rej],
                ["  - docs\n  - '!work/x'\n", rej], ["  - '!docs/x'\n", rej], ["  - docs\n  - '!docs'\n", rej], ["  - docs\n  - '!./docs/'\n", rej],
                ['  - docs\n  - !docs/x\n', '须加引号'], ["  - docs\n  - '!docs/x'\n", null], ["  - ./docs\n  - '!./docs/x'\n", null],
            ];
            const tmp = mk();
            const verdict = {};
            for (const [body, wantMsg] of cases) {
                writeText(join(tmp, 'governance', 'project.yaml'), 'tier: L0\nmetadata_required:\n' + body);
                const [, prob] = loadConfig(tmp);
                verdict[body] = wantMsg === null ? !prob : !!prob && prob.includes(wantMsg);
            }
            results.push(probe(NAME, Object.values(verdict).every((x) => x), '反例八之四：! 后为空、/ 或 .. 起头、. 、./ ，排除不在包含之下、只有排除、与包含相同，均整份拒收；裸写 ! 提示加引号；合法排除（含 ./ 起头）照收', {
                evidence: `符合预期与否 ${J(verdict)}`, why: '契约 §5 写错不猜：排除不存在的范围多半是笔误',
            }));
        }
        // C10：取最后一条转换记录的日期——小节里的备注日期、全文别处的 from|…| 行都不算；有小节却没有带日期的记录记未定，不退到提交时间
        {
            const got = {};
            const cases = [
                ['note', `## 状态转换记录\n\n| from → to | 时间 |\n|---|---|\n| planned → in_progress | ${old} |\n\n备注：计划 ${fresh} 前完成\n`],
                ['elsewhere', `## 其他\n\n| from | to | ${fresh} |\n|---|---|---|\n`],
                ['empty', '## 状态转换记录\n\n（无）\n'],
            ];
            for (const [tag, body] of cases) {
                const tmp = mk();
                const [cfg, err] = sample(tmp, `updated_at: ${fresh}\n`, '# WI-0001\n\n状态：in_progress\n\n' + body);
                if (!err) { // 退到提交时间的那支按 100 天前提交
                    const when = `${old} 12:00:00 +0000`;
                    spawnSync('git', ['-C', tmp, '-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 's'], { timeout: 60_000, env: fixtureEnv({ GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when }) });
                }
                got[tag] = err ? err : run(cfg).filter((f) => (f.where ?? '') === 'work/WI-0001-x.md').map((f) => f.status);
            }
            const want = { note: [FAIL], elsewhere: [FAIL], empty: [UNDETERMINED] };
            results.push(probe(NAME, eq(got, want), 'C10：取最后一条转换记录；备注日期与别处的 from 行不洗白停滞工作项，空记录记未定', {
                evidence: `实得 ${J(got)}；应得 ${J(want)}`, why: '01 §4.1：活性看最后一次状态转换；01 §2 N1 判不了不猜',
            }));
        }
        // C18：作者时区比运行环境早一天时，日期写成「明天」不算晚于基准日；晚两天仍记未定
        {
            const got = {};
            for (const n of [1, 2]) {
                const tmp = mk();
                const [cfg, err] = sample(tmp, `updated_at: ${toIso(addDays(today, n))}\n`, workFresh);
                got[n] = err ? err : run(cfg).filter((f) => (f.where ?? '').startsWith('docs/')).map((f) => f.status);
            }
            results.push(probe(NAME, eq(got, { 1: [PASS], 2: [UNDETERMINED] }), 'C18：日期晚基准日一天按当天算，晚两天记未定', {
                evidence: `实得 ${J(got)}`, why: '基准日是运行环境本地日期，作者可能在更早的时区写当天日期',
            }));
        }
        // R2-3：转换表之后隔一个空行的备注列表、第二张计划表，不许把停滞工作项洗成活着
        {
            const got = [];
            for (const tail of [`\n- 备注：计划 ${fresh} 复查\n`, `\n| 计划 | 日期 |\n|---|---|\n| 复查 | ${fresh} |\n`]) {
                const tmp = mk();
                const [cfg, err] = sample(tmp, `updated_at: ${fresh}\n`, `# WI-0001\n\n状态：in_progress\n\n## 状态转换记录\n\n| from → to | 时间 |\n|---|---|\n| planned → in_progress | ${old} |\n` + tail);
                got.push(err ? err : run(cfg).filter((f) => (f.where ?? '') === 'work/WI-0001-x.md').map((f) => f.status));
            }
            results.push(probe(NAME, eq(got, [[FAIL], [FAIL]]), 'R2-3：只认第一段连续的记录行，其后的备注列表与第二张表不算转换记录', { evidence: `实得 ${J(got)}`, why: '01 §4.1：活性看最后一次状态转换' }));
        }
        // C11：metadata_required 声明了而 metadata_fields 没声明，无日期文档只记一条聚合未定，不判 FAIL（与 layout 的 meta-unrecognized 同口径：字段名是工具默认，没认出推不出没写）
        {
            const tmp = mk();
            const [cfg, err] = sample(tmp, '# 无日期\n\nstatus: active\n日期：2026-09-01\n', workFresh);
            delete cfg.metadata_fields;
            const got = err ? err : run(cfg).filter((f) => f.status !== PASS).map((f) => [f.status, f.id]);
            results.push(probe(NAME, eq(got, [[UNDETERMINED, `${NAME}/undated-fields-default`]]), 'C11：未声明 metadata_fields 时 metadata_required 命中的无日期文档只记未定', {
                evidence: `非通过项 ${J(got)}`, why: '契约 §1.1 与 §5 metadata_fields：声明后仍缺才判 FAIL',
            }));
        }
        // 反例七（D-123 bug 1）：浅克隆下退到提交时间的工作项须记未定。非浅克隆同一样本判 FAIL，浅克隆取到的是克隆时刻，旧实现会把它翻成 PASS。
        {
            const tmp = mk();
            const src = join(tmp, 'src'), dst = join(tmp, 'dst');
            writeText(join(src, 'work', 'WI-0001-x.md'), '# WI-0001\n\n状态：in_progress\n');
            writeText(join(src, 'docs', 'architecture', 'a.md'), `updated_at: ${fresh}\n`);
            const when = `${old} 12:00:00 +0000`;
            const env = fixtureEnv({ GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when });
            const gid = ['-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false'];
            const steps = [
                ['git', '-c', 'init.defaultBranch=main', 'init', '-q', src],
                ['git', '-C', src, ...gid, 'add', '-A'],
                ['git', '-C', src, ...gid, 'commit', '-q', '-m', 's'],
                ['git', '-C', src, ...gid, 'commit', '-q', '--allow-empty', '-m', 't'],
                ['git', 'clone', '-q', '--depth', '1', pathToFileURL(src).href, dst],
            ];
            let err = null;
            for (let i = 0; i < steps.length; i++) {
                const cmd = steps[i];
                const r = spawnSync(cmd[0], cmd.slice(1), { timeout: 60_000, env: i < 4 ? env : fixtureEnv() });
                if (r.status !== 0) {
                    err = `${cmd.slice(0, 4).join(' ')} 退出码 ${r.status}`;
                    break;
                }
            }
            const got = {};
            if (!err)
                for (const [tag, d] of [['full', src], ['shallow', dst]])
                    got[tag] = run(sampleCfg(d)).filter((f) => (f.where ?? '') === 'work/WI-0001-x.md').map((f) => f.status);
            const ok = !err && eq(got.full, [FAIL]) && eq(got.shallow, [UNDETERMINED]);
            results.push(probe(NAME, ok, '反例七：退到提交时间的超龄工作项，完整仓判 FAIL、浅克隆记未定', {
                evidence: `实得 ${J(got)}${gitErr(err)}`, why: '01 §2 N1：浅克隆的提交时间是克隆时刻，据它判活性会把 FAIL 翻成 PASS',
            }));
        }
        // 反例七之二（C02）：工作项文件名带 [ ] 时 git 按通配解读，会取到 WI-0001-a.md 刚才的提交，把 100 天前提交、无转换记录的进行中工作项判成活着
        {
            const tmp = mk();
            writeText(join(tmp, 'work', 'WI-0001-[a].md'), '# WI-0001\n\n状态：in_progress\n');
            writeText(join(tmp, 'docs', 'architecture', 'a.md'), `updated_at: ${fresh}\n`);
            const gid = ['-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'commit.gpgsign=false'];
            let err = null;
            const steps = [
                [null, ['git', '-c', 'init.defaultBranch=main', 'init', '-q', tmp]],
                [null, ['git', '-C', tmp, ...gid, 'add', '-A']],
                [old, ['git', '-C', tmp, ...gid, 'commit', '-q', '-m', 's']],
                [null, ['@write', join(tmp, 'work', 'WI-0001-a.md')]], // 同目录再放一个名字能被 `WI-0001-[a].md` 通配到的文件
                [null, ['git', '-C', tmp, ...gid, 'add', '-A']],
                [fresh, ['git', '-C', tmp, ...gid, 'commit', '-q', '-m', 't']],
            ];
            for (const [when, cmd] of steps) {
                if (cmd[0] === '@write') {
                    writeText(cmd[1], 'x\n');
                    continue;
                }
                const env = when ? fixtureEnv({ GIT_COMMITTER_DATE: `${when} 12:00:00 +0000`, GIT_AUTHOR_DATE: `${when} 12:00:00 +0000` }) : fixtureEnv();
                const r = spawnSync(cmd[0], cmd.slice(1), { timeout: 60_000, env });
                if (r.status !== 0) {
                    err = `${cmd.slice(0, 4).join(' ')} 退出码 ${r.status}`;
                    break;
                }
            }
            const got = err ? err : run(sampleCfg(tmp)).filter((f) => (f.where ?? '') === 'work/WI-0001-[a].md').map((f) => f.status);
            results.push(probe(NAME, eq(got, [FAIL]), '反例七之二：文件名带 [ ] 的超龄工作项按字面取提交时间，仍判 FAIL', { evidence: `实得 ${J(got)}`, why: '01 §4.1：活性看的是这一份工作项自己的提交，不是被通配到的别的文件' }));
        }
        // C22：工作项目录在文档根之下（缺省形态）时每份工作项只读一遍；浅克隆一次扫描只探测一次
        {
            const tmp = mk();
            for (const i of [1, 2])
                writeText(join(tmp, 'docs', 'state', 'work', `WI-000${i}-x.md`), '# WI\n\n状态：in_progress\n');
            const err = gitTrack(tmp);
            const before = __testHooks.opened;
            if (!err)
                run({ _root: tmp });
            const reads = __testHooks.opened - before;
            // 浅克隆探测次数：一次扫描里经 gitCommitDate 的 memo 只探测一次。这里数 `git rev-parse --is-shallow-repository` 的调用，借 PATH 上放一个计数的 git 包装不现实，
            // 改为直接验证 memo 语义：同一个 memo 数组连续两次 gitCommitDate，只有第一次写入 memo。
            const memo = [];
            gitCommitDate(tmp, 'docs/state/work/WI-0001-x.md', memo);
            const n1 = memo.length;
            gitCommitDate(tmp, 'docs/state/work/WI-0002-x.md', memo);
            const ok = !err && reads === 2 && n1 === 1 && memo.length === 1;
            results.push(probe(NAME, ok, 'C22：工作项目录在文档根下时每份只读一遍，浅克隆只探测一次', {
                evidence: `读 ${reads} 次（2 份），探测记忆 ${memo.length} 项${gitErr(err)}`, why: '一次扫描里同一份文件不重复 I/O，不为每份工作项起子进程',
            }));
        }
        // 反例五之二（D-123 bug 10）：超龄工作项的 FAIL 标题带天数，id 须不随天数变；聚合未定的标题带份数，id 须不随份数变
        {
            const idsOf = (daysAgo, extraUnclassified) => {
                const tmp = mk();
                const day = toIso(addDays(today, -daysAgo));
                for (let i = 0; i < extraUnclassified; i++)
                    writeText(join(tmp, 'docs', '杂项', `n${i}.md`), '# 无日期\n');
                const [cfg, err] = sample(tmp, `updated_at: ${fresh}\n`, `# WI-0001\n\n状态：**in_progress**\n\n## 状态转换记录\n\n| from → to | 时间 |\n|---|---|\n| planned → in_progress | ${day} |\n`, false);
                return err ? err : run(cfg).filter((f) => f.status === FAIL || f.status === UNDETERMINED).map((f) => f.id).sort(cmpCp);
            };
            const a = idsOf(100, 2), b = idsOf(300, 3);
            const want = [`${NAME}/undated-unclassified`, `${NAME}/work-item-stale/work/WI-0001-x.md`].sort(cmpCp);
            results.push(probe(NAME, eq(a, b) && eq(a, want), '反例五之二：超龄天数与聚合份数变了，FAIL 与未定的 id 都不变', {
                evidence: `100 天 2 份：${J(a)}；300 天 3 份：${J(b)}`, why: '契约 §4/§9：id 随天数或份数漂，登记行就成孤儿',
            }));
        }
        // 只看工作项目录直接一层（D-123 裁定 3）；工作项按 01 §3.2 的 WI-* 命名认（审查 B5）：样板 L1 的 current.md / handoff.md 与子目录留证不报 no-status，无状态的 WI-* 才报
        {
            const tmp = mk();
            writeText(join(tmp, 'work', 'artifacts', 'README.md'), '# 留证说明\n');
            writeText(join(tmp, 'work', 'current.md'), '# 当前\n');
            writeText(join(tmp, 'work', 'handoff.md'), '# 交接\n');
            writeText(join(tmp, 'work', 'WI-0002-y.md'), '# 没写状态\n');
            const [cfg, err] = sample(tmp, `status: active\nupdated_at: ${fresh}\n`, workFresh);
            const got = err ? [] : run(cfg).filter((f) => f.status !== PASS).map((f) => [f.status, f.id, f.evidence || '']);
            const ok = !err && eq(got.map(([st, i]) => [st, i]), [[UNDETERMINED, `${NAME}/no-status`], [SKIP, `${NAME}/not-work-item`]]) && got[0][2] === 'work/WI-0002-y.md' && got[1][2] === 'work/current.md；work/handoff.md';
            results.push(probe(NAME, ok, '工作项按 WI-* 命名认：current.md/handoff.md 不报 no-status、子目录不数，无状态的 WI-* 记未定', {
                evidence: `非通过项 ${J(err ?? got)}`, why: '01 §3.2 state/work/WI-*；样板 L1（templates/文件树与落地路径.md §3）不许恒退 2',
            }));
        }
        // 反例五（id 稳定性，契约 §9）：同一份文档再放一阵子，**标题里的天数要变、id 不能变**。id 跟着天数走的话，例外登记里写下的那一行第二天就失效——登记会退化成每天重抄一遍。
        {
            const staleOne = (daysAgo) => {
                const tmp = mk();
                const [cfg, err] = sample(tmp, `---\nid: DOC-1\nstatus: active\nupdated_at: ${toIso(addDays(today, -daysAgo))}\n---\n\n# 有日期的文档\n`, workFresh);
                if (err)
                    return null;
                const hits = run(cfg).filter((f) => f.id.startsWith(`${NAME}/stale/`));
                return hits.length === 1 ? hits[0] : null;
            };
            const a = staleOne(100), b = staleOne(300);
            const ok = a !== null && b !== null && a.id === b.id && a.title !== b.title && a.id === `${NAME}/stale/${(a.where ?? '').slice(0, -2)}`;
            results.push(probe(NAME, ok, '反例五：同一份文档放得更久，标题里的天数变而 id 不变（id = freshness/stale/<路径>）', {
                evidence: `100 天：id=${a ? a.id : '（无）'} title=${pyRepr(a ? a.title : '（无）')}；300 天：id=${b ? b.id : '（无）'} title=${pyRepr(b ? b.title : '（无）')}`,
                why: '契约 §9：例外登记行写的就是 id，id 随天数漂就等于登记每天失效一次',
            }));
        }
    }
    catch (exc) {
        results.push(undeterminedFromException(NAME, exc, '跑自检'));
    }
    finally {
        for (const t of tmps)
            rmSync(t, { recursive: true, force: true });
    }
    return results;
}
function checkWorkItems(cfg, root, today, base, texts) {
    const [wroot, wnote] = workRoot(cfg);
    const [days, usedDefault, bad] = intBudget(cfg, 'budgets.work_item_stale_days', DEFAULT_WORK_ITEM_STALE_DAYS);
    if (bad) {
        return [finding(NAME, UNDETERMINED, '工作项活性阈值不是正整数', { reason: bad, why: '01 §4.1 的复查时间是参数，但必须是可比较的数' })];
    }
    const nt = note(usedDefault, 'budgets.work_item_stale_days', days) + '；' + wnote;
    const absent = workRootAbsent(NAME, cfg); // 目录在不在归 layout 报，这里不重复记未定
    if (absent)
        return [absent];
    const [files, problem] = workItems(root, wroot); // 只看直接一层
    if (problem)
        return [finding(NAME, UNDETERMINED, '列不出 git 跟踪的工作项', { reason: problem, why: '契约 §1：依赖不可用记未定' })];
    const out = [];
    const frozen = [], nostatus = [], unknown = [], other = [], notItems = [];
    const docs = [], unknownDocs = [];
    const memo = [];
    for (const rel of files) {
        if (inFrozen(cfg, rel)) {
            frozen.push(rel);
            continue;
        }
        let text;
        try {
            const cached = texts.get(rel);
            texts.delete(rel);
            text = cached === undefined ? readText(join(root, ...rel.split('/')), root) : cached;
        }
        catch (exc) {
            out.push(unreadable(NAME, rel, exc));
            continue;
        }
        const status = itemStatus(text);
        if (status === null) {
            // 工作项按 01 §3.2 的 `WI-*` 命名认；不带这个名字又读不到状态的（样板 L1 的 current.md、handoff.md、README 之类）不是工作项。
            // 带状态字段的是工作项还是文档由 statusKind 判
            ;
            (isWorkItemName(rel) ? nostatus : notItems).push(rel);
            continue;
        }
        const [kind, cls] = statusKind(cfg, rel, status); // 工作项还是文档，只在 core/docs 一处分（D-134）
        if (cls === null) {
            ;
            (kind === 'document' ? unknownDocs : unknown).push(`${rel}（${status || '空'}）`);
            continue;
        }
        if (kind === 'document') {
            docs.push(`${rel}（${status}）`);
            continue;
        }
        if (cls !== 'in_progress') {
            other.push(`${rel}（${status || '空'}）`);
            continue;
        }
        const lt = lastTransition(text);
        let d;
        let how;
        let usedGit = false;
        if (lt.err === null) {
            d = lt.d;
            how = lt.how;
        }
        else if (lt.err[0] === 'absent') {
            const [gd, gerr] = gitCommitDate(root, rel, memo);
            if (gd === null) {
                out.push(finding(NAME, UNDETERMINED, `取不到最后状态转换时间：${rel}`, {
                    where: rel, reason: `${lt.err[1]}；退到提交时间也不成：${gerr}`,
                    why: '01 §4.1 要求每次转换留一行带时间；取不到就判不了它超没超龄（01 §2 N1）', evidence: nt,
                }));
                continue;
            }
            d = gd;
            usedGit = true;
            how = `用的是提交时间，不是显式状态时间戳（git log -1 --format=%cI -- ${rel}）`;
        }
        else {
            out.push(finding(NAME, UNDETERMINED, `状态转换时间解析不了：${rel}`, {
                where: rel, reason: lt.err[1] || '未知', why: '01 §2 N1：解析不了不猜', evidence: nt,
            }));
            continue;
        }
        const a = age(today, d);
        const caveat = usedGit ? `。注意：${how}` : `。${how}`;
        if (a < 0) {
            out.push(finding(NAME, UNDETERMINED, `状态转换时间晚于基准日：${rel}`, {
                where: rel, reason: `记录的时间 ${toIso(d)} 比基准日晚 ${-a} 天；是笔误还是时钟不对，本工具判不了`, why: '01 §2 N1', evidence: `${base}${caveat}`,
            }));
        }
        else if (a > days) {
            out.push(finding(NAME, FAIL, `进行中工作项 ${a} 天无状态转换，需核实：${rel}`, {
                where: rel, kind: 'work-item-stale', key: rel, // 标题带天数，id 不许每天变（契约 §4）
                why: '01 §4.1 要求活性巡检：长期无转换的进行中工作项要么在做要么被忘了，二者都要有人处置——补进度与下次检查时间、转 blocked、或拆分。' +
                    '01 §4.1 明确超龄需核实原因，不强造阻塞，也不许空转状态清零年龄',
                evidence: `状态 ${status}，最后转换 ${toIso(d)}，距今 ${a} 天，阈值 ${days} 天。${base}，${nt}${caveat}`,
            }));
        }
        else {
            out.push(finding(NAME, PASS, `进行中工作项 ${rel} 距上次转换 ${a} 天，在阈值 ${days} 天内`, { where: rel, evidence: `最后转换 ${toIso(d)}。${base}，${nt}${caveat}` }));
        }
    }
    if (frozen.length)
        out.push(agg(NAME, SKIP, '归档区工作项不参与活性巡检', frozen, '落在 layout.frozen 内；01 §3.1：一次性对齐工件不承担更新义务', '', 'frozen-work-items'));
    if (nostatus.length) {
        out.push(agg(NAME, UNDETERMINED, 'WI-* 工作项读不到状态字段', nostatus, '文件按 01 §3.2 的 WI-* 命名是工作项，但状态字段名是本工具的词表（stdlib.STATUS_FIELDS），读不到推不出它没写（契约 §1.1）：它的活性与完成证据本次都没查', '', 'no-status'));
    }
    if (unknown.length) {
        out.push(agg(NAME, UNDETERMINED, '工作项状态不在已知词表', unknown, '已知词表是 01 §4.1 六态及别名（stdlib.WORK_ITEM_STATES），并入 project.yaml 的 work_item_*_states；认不出就说不清它是进行中还是完成，超龄与完成证据两道检查本次都没查（契约 §1.1）。' +
            '改用 01 §4.1 的状态词，或在 project.yaml 声明自己的词', '', 'unknown-state'));
    }
    if (unknownDocs.length) {
        out.push(agg(NAME, UNDETERMINED, '文档状态不在 01 §3.5 词表', unknownDocs, '这些是 layout.artifacts 声明的工件，状态在工作项六态与 01 §3.5 文档四值（stdlib.DOC_STATES）两表里都认不出，说不清它是否有效（契约 §1.1）', '', 'unknown-doc-state'));
    }
    if (docs.length) {
        out.push(agg(NAME, SKIP, '工作项目录下的文档不做工作项巡检', docs, 'layout.artifacts 声明的工件、状态属 01 §3.5 文档四值（stdlib.DOC_STATES）的是文档，不是 01 §4.1 的工作项：不查活性、不查完成证据（stdlib.status_kind，D-134）', '', 'document-state'));
    }
    if (notItems.length) {
        out.push(agg(NAME, SKIP, '工作项目录下既不按 WI-* 命名、也没有状态字段的文件', notItems, '01 §3.2 的工作项是 state/work/WI-*；这些文件不按该名、自己也没写状态，不当工作项（样板 L1 的 current.md、handoff.md、README 之类）', '', 'not-work-item'));
    }
    if (other.length) {
        out.push(agg(NAME, SKIP, '非进行中状态的工作项', other, '01 §4.1 对 planned / blocked / in_validation 也要求巡检，但复查时间是每项自己约定的值，工具读不到，故不判', '', 'not-in-progress'));
    }
    if (out.length === 0) {
        out.push(finding(NAME, UNDETERMINED, `${wroot} 下没有可判定的工作项`, { where: wroot, reason: "空集上说不出'全部工作项都活着'（01 §2 N1）", evidence: nt }));
    }
    return out;
}
