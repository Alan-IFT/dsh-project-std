// 文档漂移的机械信号：写下的日期、ADR 就地修订、索引对账、STATUS 声明的工作项。对应 tools/std/checks/check_drift.py；契约见 tools/std/CONTRACT.md。
//
// 四条判据都只回答「文档说的和仓库里的对不对得上」，不回答「内容对不对」：
//  1. `future-date`   记录里写成既成事实的日期，晚于写下它的那次提交（基准取 `git blame` 行级提交时刻在最晚时区 UTC+14 下的日期）。
//  2. `adr-revision`  ADR 正文里出现就地修订的标记（02 §8「ADR 不就地修订」）；围栏代码块不看，英文标记只认标题/标签形态，「修订后」开头的指代句不算。
//  3. `adr-index-*`   ADR 索引与目录里实物的双向对账（02 §8）。
//  4. `work-item-missing` STATUS 声明的工作项没有载体（01 §4.1）。
// 三态取向（01 §2 N1 与契约 §1.1）：前两条与第 4 条靠工具常量词表/ID 形态，是猜测，**永不 FAIL**；只有第 3 条的反向对账（目录里有实物、索引里没有）是确定事实，
// 且**只在项目用 `layout.artifacts.decisions` 声明了 ADR 目录时**才 FAIL。
//
// 迁移约束：与 Python 版逐 id 相同（黄金样本）。动笔前对本检查器用到的每个 Python 字符串、正则、容器操作都问过「JS 里对应的在非 ASCII、非 BMP、边界值上等价吗」，并在 Python 上实测（设计 §12.22）：
//   `str.lower()`          → `toLowerCase()`（两边对全部码点一致，`İ` 都变成两个码点；本文件**不**拿 low 的下标去切 s：Python 同，`s[len(mark):]` 用的是 s）
//   `s[:40]`               → `headChars(s, 40)`（D18，按码点）
//   `lstrip(chars)`        → 显式字符集（含全角空格 U+3000 与 `>`）；无参 `rstrip()` → `pyStrip` 一族（D6）
//   `\d{4}-\d{2}-\d{2}`    → `[0-9]`（D4/D19：Python 的 `\d` 认全角；TS 只认 ASCII——**有意差异**）
//   `\bWI-\d{3,}\b`        → `(?<![\p{L}\p{N}_])WI-[0-9]{3,}(?![\p{L}\p{N}_])`（D5：`\b` 是 Unicode 词边界；D4/D19：数字只认 ASCII）
//   `date.fromisoformat`   → 严格 YYYY-MM-DD（D1）；字面量已由 DATE_RE 限定为 4-2-2 位 ASCII 数字，所以只剩「日期存不存在」这一问
//   `text.split("\n")`     → 只按 \n 切（git 的行号不认 U+2028、\x0c；不用 `splitLinesPy`，也不用 readText——它把孤立 \r 归一，行号与 blame 错位，B14）
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cfgGet, pyStr, pyTruthy } from '../core/cfg.js';
import { addDays, compareDays, todayLocal, toIso, validDate } from '../core/dates.js';
import { DEFAULT_WORK_ROOT, LIST_CAP, STATUS_CANDIDATES, WORK_ITEM_NAME, docsRootOf, headChars, inFrozen, normRel, rebaseDocs, under, workRoot } from '../core/docs.js';
import { firstMdTable } from '../core/exceptions.js';
import { FAIL, PASS, SKIP, UNDETERMINED, PY_WHITESPACE, finding, pyRstrip, pyStrip } from '../core/finding.js';
import { fixtureEnv, gitTrack, writeText } from '../core/fixture.js';
import { exists as pathExists, inside, isDir, isFile, readBytes, readText } from '../core/fs.js';
import { filterEnv, hardenedEnv } from '../core/git.js';
import { pyRepr } from '../core/repr.js';
import { noteDefault, once, outsideRoot, probe, runGuarded, undeterminedFromException, unreadable, workRootAbsent } from '../core/shell.js';
import { trackedFiles } from '../core/tracked.js';
import { splitLinesPy } from '../core/yaml.js';
export const NAME = 'drift';
export const STANDARD_REFS = ['01 §2 N1', '01 §4.1', '02 §8'];
// --------------------------------------------------------------------------
// 工具常量：两份词表都是**猜测**（契约 §1.1「标记词」），换一种写法就漏。它们不做成配置键——判据自身的召回位置不是项目参数（契约 §1.1 末段）。
// --------------------------------------------------------------------------
/** 日期后面跟着它，这个日期读起来就像「已经发生了」。 */
export const PAST_ACTS = ['裁定', '拍板', '裁准', '批准', '验收通过', '已完成', '完成于', '达成', '已生效', '已落地', '已发布', '发布于', '已确认', '已复核', '已复查', '已取代', '决议', '签字'];
const ACT_WINDOW = 10; // 窗口从日期末尾起算的定长，不分句、不切表格
/**
 * 日期**左边**跟着它，这个日期是计划位（复查日、到期日），不是既成事实。
 * 由来：`- 复查：2026-12-08（半年）——已复查，无回退。` 这一行右窗口命中 `已复查`，是实测出来的真误报形态。
 */
export const PLAN_WORDS = ['复查', '到期', '下次', '计划', '截止', '保留至', '有效期'];
const PLAN_WINDOW = 6;
/**
 * ADR 正文里的就地修订标记。**必须从剥掉行首装饰后的第 0 个字符开始**——放宽到「前 8 个字符内」时，本仓 docs/ 的候选行数成倍增加，全是正文句子，那是实测出来的误报形态（数字见 Python 版同处，不抄）。
 */
export const REVISION_MARKERS = ['修订', '变更记录', '补充', '更新于', '追加', '修改记录', '版本历史', 'revision', 'changelog'];
/** 以标记词开头却是指代句（「修订后的结论见 §13.1」），不是修订块——采用项目实测误报。 */
const REVISION_NOT = ['修订后'];
/** 英文标记常作普通名词（`revision id "0053_x"`），只在标题或标签形态才算：`#` 标题行，或去装饰后该词后面紧跟 `:`／`：`／表格竖线／行尾。 */
const REVISION_LABEL_ONLY = ['revision', 'changelog'];
/** 行首装饰：引用、标题、列表、加粗、表格竖线。 */
const LEAD_TRIM = ' \t\u3000>#-*|';
const INDEX_NAMES = ['README.md', 'INDEX.md'];
// D4/D19：只认 ASCII 数字；D5：`\b` → 显式的 Unicode 词边界（字母、数字、下划线）
const DATE_RE = /[0-9]{4}-[0-9]{2}-[0-9]{2}/g;
const WORD = '[\\p{L}\\p{N}_]';
const WI_RE = new RegExp(`(?<!${WORD})WI-[0-9]{3,}(?!${WORD})`, 'gu');
const WS = `[${PY_WHITESPACE}]`;
/** WORK_ITEM 模板的首字段，照模板写法只认行首；正文里提到的 ID 不算载体。 */
const WI_FIELD_RE = new RegExp(`^work_item_id[:：]${WS}*(WI-[0-9]{3,})(?!${WORD})`, 'u');
export { WI_RE as WI_PATTERN_FOR_TEST, WI_FIELD_RE as WI_FIELD_PATTERN_FOR_TEST };
const ADR_RE = /ADR-[0-9]+/;
const ADR_FILE_RE = /^(ADR-[0-9]+)/;
/** SHA-1 仓行头 40 位、SHA-256 仓 64 位。 */
const BLAME_HEAD = new RegExp(`^([0-9a-f]{40}(?:[0-9a-f]{24})?)${WS}+([0-9]+)${WS}+([0-9]+)(?:${WS}+([0-9]+))?$`);
/** CommonMark 围栏：同一字符连续 3 个以上；闭合须同字符、不短于开围栏、其后只有空白。 */
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const MD_LINK_RE = /\]\(([^)]+)\)/;
// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------
export function mdUnder(files, sub) {
    return files.filter((f) => f.toLowerCase().endsWith('.md') && under(f, sub)).sort(cmpCp);
}
export function cap(items) {
    const shown = items.slice(0, LIST_CAP); // py-semantics-ok: items 是数组，LIST_CAP 是元素个数，不是字符串切分
    const more = items.length <= LIST_CAP ? '' : `；另有 ${items.length - LIST_CAP} 条未列出`;
    return shown.join('、') + more;
}
const cmpCp = (a, b) => {
    const x = [...a], y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = x[i].codePointAt(0) - y[i].codePointAt(0);
        if (d)
            return d;
    }
    return x.length - y.length;
};
/** 返回 [退出码, stdout 文本, 错误串]。跑不起来时退出码为 null。 */
function git(root, args, env, timeout = 120_000) {
    let r;
    try {
        r = spawnSync('git', ['-C', root, ...args], { timeout, env, maxBuffer: 1 << 30 });
    }
    catch (exc) {
        return [null, '', `跑不了 git ${args[0]}：${exc.message}`];
    }
    if (r.error)
        return [null, '', `跑不了 git ${args[0]}：${r.error.message}`];
    const text = (r.stdout ?? Buffer.alloc(0)).toString('utf8');
    const err = pyStrip((r.stderr ?? Buffer.alloc(0)).toString('utf8')).slice(0, 200); // py-semantics-ok: 展示——错误串进 reason，不进判据；git 的 stderr 是 ASCII
    return [r.status, text, err];
}
/**
 * 该时刻在最晚时区（UTC+14）下的日期，作「写下时最晚可能是哪天」的基准。
 * 纯函数，不读机器时区，也不用提交自带的 committer-tz：写日期的人与提交者的时区未必相同，`2026-09-13 21:46 -0700` 的提交在 +0800 已是 09-14，按 -0700 取日会把正确的『09-14』报成未来。
 * 取 UTC+14 只会少报、不会漏掉真正的未来日期。
 */
export function latestDay(epochSeconds) {
    const dt = new Date((Math.trunc(epochSeconds) + 14 * 3600) * 1000);
    const year = dt.getUTCFullYear();
    // Python 的 datetime 只表示 1..9999 年，越界抛 OverflowError（run 的外壳转未定）；JS 的 Date 不会，所以显式抛，行为一致。git 不会产出这种时间，这条只防「悄悄给出一个 Python 给不出的日期」
    if (!(year >= 1 && year <= 9999))
        throw new RangeError('date value out of range');
    return { year, month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}
/** Python 的 `int(s)` 对 git 输出的子集：可带正负号的 ASCII 十进制整数；其余抛错（Python 抛 ValueError，如 `1789000000.5`）。Python 的 `int` 还认 Unicode 数字与下划线分隔，git 的输出是纯 ASCII，不会出现（D19 同类）。 */
function pyInt(s) {
    if (!/^[+-]?[0-9]+$/.test(s))
        throw new SyntaxError(`invalid literal for int(): ${pyRepr(s)}`);
    return Number(s);
}
// --------------------------------------------------------------------------
// 判据 1：记录里的日期晚于写下它的提交
// --------------------------------------------------------------------------
/**
 * 返回 [[行号, 日期字面量]]。左窗口排除计划位，右窗口要求动作词。
 *
 * 窗口按**码点**取：Python 的 `m.start()` 是码点下标，`line[a:b]` 按码点切；JS 的 `m.index` 是码元下标，`slice` 按码元切，含 emoji 的行下标不通用（D18）。
 * 做法：把 `line` 转成码点数组 `cps`；日期起点的码点下标 = `[...line.slice(0, m.index)].length`；日期本身是纯 ASCII（`[0-9]` 与 `-`），长度 10，码点数 = 码元数。
 * 窗口都在码点下标上加减，最后 `cps.slice(a, b).join('')`。
 */
export function candidates(text) {
    const out = [];
    const lines = text.split('\n'); // 只按 \n 切：git 的行号不认 U+2028、\x0c
    for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const cps = [...line];
        for (const m of line.matchAll(DATE_RE)) {
            const start = [...line.slice(0, m.index)].length; // 码点下标
            const end = start + m[0].length; // 日期是纯 ASCII：码点数 = 码元数
            const left = cps.slice(Math.max(0, start - PLAN_WINDOW), start).join('');
            if (PLAN_WORDS.some((w) => left.includes(w)))
                continue;
            const right = cps.slice(end, end + ACT_WINDOW).join('');
            if (PAST_ACTS.some((w) => right.includes(w)))
                out.push([li + 1, m[0]]);
        }
    }
    return out;
}
/** `git blame -p` 的 committer-time 与行头解析。纯函数（输入是 blame 的文本输出），便于对样本逐条比对。返回 [{行号: [sha, 日期|null]}, 问题|null]。 */
export function parseBlame(text) {
    // porcelain 的 `committer-time` **只在一个 commit 首次出现时输出**，后续行头只有 sha。不先建 commit→时间缓存再按行头摊开，94% 的行会读成 None。
    const times = new Map();
    const lines = new Map();
    let cur = null;
    for (const raw of text.split('\n')) {
        const m = BLAME_HEAD.exec(raw);
        if (m) {
            cur = m[1];
            lines.set(pyInt(m[3]), cur);
            continue;
        }
        if (cur === null)
            continue;
        if (raw.startsWith('\t'))
            cur = null;
        else if (raw.startsWith('committer-time '))
            times.set(cur, pyStrip(raw.slice(raw.indexOf(' ') + 1)));
    }
    const out = new Map();
    for (const [lineno, sha] of lines) {
        if (!sha.replace(/^0+|0+$/g, '')) { // `sha.strip("0")`：未提交行是全零 sha（SHA-1 40 位 / SHA-256 64 位）
            out.set(lineno, [sha, null]);
            continue;
        }
        const epoch = times.get(sha);
        if (epoch === undefined)
            return [null, `blame 输出里 ${sha.slice(0, 7)} 这个提交没有 committer-time`];
        out.set(lineno, [sha, latestDay(pyInt(epoch))]);
    }
    return [out, null];
}
/** `git blame -p` 的行级提交时间。返回 [{行号: [sha, 日期]}, 问题]。 */
export function blame(root, rel) {
    const base = hardenedEnv(process.env);
    const env = filterEnv(root, base);
    if (env === null)
        return [null, '列不出被扫仓配置的过滤器（git config 失败或超时），不在未压住过滤器时读工作区'];
    // `--no-textconv`：diff.<驱动>.textconv 的驱动名由被扫方起、列不全，blame 会读工作区内容，所以要写在命令行上（core/git.ts 头注释的责任划分）
    const [code, text, err] = git(root, ['blame', '-p', '--no-textconv', '--', rel], env);
    if (code === null)
        return [null, err];
    if (code !== 0)
        return [null, `git blame 退出码 ${code}：${err}`];
    return parseBlame(text);
}
// --------------------------------------------------------------------------
// ADR 目录定位（判据 2 与判据 3 共用）
// --------------------------------------------------------------------------
/** 返回 [目录相对路径, 是否项目声明, 说不通时的 Finding]。 */
export function adrDir(cfg, root, files, docsRoot) {
    const declared = cfgGet(cfg, 'layout.artifacts.decisions');
    if (pyTruthy(declared)) {
        let rel = normRel(declared).replace(/\/+$/, '');
        let path = join(root, ...rel.split('/'));
        if (!inside(root, path))
            return [null, true, outsideRoot(NAME, rel)]; // 先护栏（R1-07）
        if (isFile(path)) {
            rel = dirnameOf(rel) || '.';
            path = join(root, ...rel.split('/'));
        }
        if (!isDir(path)) {
            return [null, true, finding(NAME, UNDETERMINED, `ADR 目录不存在：${pyStr(declared)}`, {
                    where: String(pyStr(declared)),
                    reason: `layout.artifacts.decisions 指向 ${pyStr(declared)}，它既不是目录也不是文件；是配置过期还是目录被移走，本工具判不了`,
                    why: '02 §8：ADR 与它的索引以目录为对象，对象不在则判不了',
                })];
        }
        return [rel, true, null];
    }
    const found = new Set();
    for (const f of files) {
        if (!under(f, docsRoot))
            continue;
        const parts = f.split('/');
        for (let i = 0; i < parts.length - 1; i++)
            if (parts[i] === 'decisions')
                found.add(parts.slice(0, i + 1).join('/'));
    }
    if (found.size === 1)
        return [[...found][0], false, null];
    // 适用性先判（契约 §1）：决策登记是 L2 起的工件。L0/L1 没有 ADR 目录不适用；L2 起、档位不明，或有多个候选目录时，目录名是约定（§1.1），没定位到只记未定
    const tierRaw = cfgGet(cfg, 'tier');
    const tier = pyTruthy(tierRaw) ? pyStr(tierRaw) : '';
    const status = found.size === 0 && (tier === 'L0' || tier === 'L1') ? SKIP : UNDETERMINED;
    const sorted = [...found].sort(cmpCp);
    return [null, false, finding(NAME, status, '未定位到 ADR 目录，判据 2（就地修订）与判据 3（索引对账）本次未执行', {
            kind: 'adr-dir-unlocated',
            reason: `未声明 layout.artifacts.decisions，且 ${docsRoot} 下${found.size === 0 ? '没有名为 decisions 的目录' : `有 ${found.size} 个名为 decisions 的目录（${cap(sorted)}）`}` +
                (status === SKIP ? `。tier ${tier} 不要求决策登记（L2 起），故不适用` : '。ADR 在别处就在 layout.artifacts.decisions 声明'),
            why: '02 §8 以 decisions 目录为对象；契约 §1.1：目录名是约定，猜不到不记通过',
        })];
}
/** Python 的 `os.path.dirname`（入参已规范成 `/` 分隔）：最后一个 `/` 之前，没有则空串。 */
const dirnameOf = (r) => { const i = r.lastIndexOf('/'); return i < 0 ? '' : r.slice(0, i); };
// --------------------------------------------------------------------------
// 判据 2：ADR 就地修订的标记
// --------------------------------------------------------------------------
/** Python 的 `s.lstrip(chars)`：去开头属于 chars 的字符（按码点；chars 全是 BMP 字符，逐个码元去即可）。 */
const lstripChars = (s, chars) => { let i = 0; while (i < s.length && chars.includes(s[i]))
    i++; return s.slice(i); };
export function revisionHits(text) {
    const out = [];
    let fence = null;
    const lines = splitLinesPy(text);
    for (let li = 0; li < lines.length; li++) {
        const n = li + 1;
        const line = lines[li];
        const bare = lstripChars(line, ' \t\u3000>');
        const fm = FENCE_RE.exec(bare);
        if (fence !== null) { // 围栏代码块里的行是样例，不是正文
            if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && !pyStrip(fm[2]))
                fence = null;
            continue;
        }
        if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) { // ```x``` 是行内代码
            fence = fm[1];
            continue;
        }
        const s = lstripChars(line, LEAD_TRIM);
        const low = s.toLowerCase();
        if (REVISION_NOT.some((x) => low.startsWith(x)))
            continue;
        for (const mark of REVISION_MARKERS) {
            if (!low.startsWith(mark))
                continue;
            const rest = pyRstrip(lstripChars(s.slice(mark.length), '* \t'));
            if (REVISION_LABEL_ONLY.includes(mark) && !bare.startsWith('#') && rest && !':：|'.includes([...rest][0]))
                continue;
            out.push([n, headChars(s, 40), mark]);
            break;
        }
    }
    return out;
}
function checkRevision(root, adrDirRel, adrFiles) {
    const out = [];
    for (const rel of adrFiles) {
        let hits;
        try {
            hits = revisionHits(readText(join(root, ...rel.split('/')), root));
        }
        catch (exc) {
            out.push(unreadable(NAME, rel, exc));
            continue;
        }
        if (hits.length === 0)
            continue;
        out.push(finding(NAME, UNDETERMINED, `${rel} 里有就地修订的标记（${hits.length} 处）`, {
            where: `${rel}:${hits[0][0]}`, kind: 'adr-revision', key: rel,
            reason: `命中标记词只说明这份 ADR 的行首写了『${hits[0][2]}』；它是改了决定，还是 02 §8 允许的事实性更正（错别字、失效链接、补证据指针），本工具判不了`,
            why: '02 §8「**ADR 不就地修订**：决定变了——哪怕只改一句——就开新 ADR」；标记词是工具常量（契约 §1.1），永不 FAIL',
            evidence: cap(hits.map(([n, s]) => `第 ${n} 行：${s}`)),
        }));
    }
    if (out.length || adrFiles.length === 0)
        return out; // 空集上说不出「全部通过」（01 §2 N1）
    return [finding(NAME, PASS, `adr-revision：${adrDirRel} 下 ${adrFiles.length} 份 ADR，行首都没有就地修订标记`, {
            where: adrDirRel, kind: 'adr-revision', why: '01 §5.6：门跑过与没跑过要分得出；本条列出来是为了让静默失效看得见',
            evidence: `对象＝${adrDirRel} 下除 ${INDEX_NAMES.join('/')} 外、不在 layout.frozen 内的 *.md；标记词 ${REVISION_MARKERS.length} 个，须从剥掉行首装饰后的第 0 个字符开始`,
        })];
}
// --------------------------------------------------------------------------
// 判据 3：索引与实物对账
// --------------------------------------------------------------------------
/** 「文件」列里可用的路径；不是路径（裸 ID、括注）返回 null。 */
export function indexTarget(cell) {
    const m = MD_LINK_RE.exec(cell);
    if (m)
        return pyStrip(m[1].split('#')[0]);
    const s = pyStrip(pyStrip(cell).replace(/^`+|`+$/g, ''));
    return s.toLowerCase().endsWith('.md') ? s : null;
}
function checkIndex(root, adrDirRel, adrFiles, indexRel, declared) {
    // 索引对账。不读 ADR 头、不比状态与日期——那两侧的写法（`**draft**`、`superseded → ADR-0012`）没有无歧义的归一化，比出来的不一致会是假 FAIL。
    const dirIds = new Map();
    for (const rel of adrFiles) {
        const m = ADR_FILE_RE.exec(basenameOf(rel));
        if (m && !dirIds.has(m[1]))
            dirIds.set(m[1], rel);
    }
    if (indexRel === null) {
        if (dirIds.size === 0)
            return [];
        return [finding(NAME, UNDETERMINED, `${adrDirRel} 下有 ${dirIds.size} 份 ADR，但没有索引`, {
                where: adrDirRel, kind: 'adr-index-absent', key: adrDirRel,
                reason: `目录里没有 ${INDEX_NAMES.join(' 或 ')}；索引是另起了名字，还是确实没建，本工具判不了`,
                why: '02 §8「`decisions/README.md` 是索引：ID、标题、状态、日期、影响模块」', evidence: `目录里的 ADR：${cap([...dirIds.keys()].sort(cmpCp))}`,
            })];
    }
    let table;
    try {
        table = firstMdTable(readText(join(root, ...indexRel.split('/')), root));
    }
    catch (exc) {
        return [unreadable(NAME, indexRel, exc)];
    }
    let idCol = null, fileCol = null;
    if (table !== null) {
        const header = table[1];
        header.forEach((cell, i) => {
            const low = cell.toLowerCase();
            if (idCol === null && low.includes('id'))
                idCol = i;
            if (fileCol === null && cell.includes('文件'))
                fileCol = i;
        });
    }
    if (table === null || idCol === null) {
        return [finding(NAME, UNDETERMINED, `${indexRel} 读不出 ADR 索引表`, {
                where: indexRel, kind: 'adr-index-unreadable', key: indexRel,
                reason: `文件里${table === null ? '没有 markdown 表' : '第一张表没有 ID 列'}；本工具只读第一张表，表头按包含匹配 \`ID\` 与 \`文件\``,
                why: '02 §8「`decisions/README.md` 是索引：ID、标题、状态、日期、影响模块」', evidence: `目录里的 ADR：${cap([...dirIds.keys()].sort(cmpCp)) || '（无）'}`,
            })];
    }
    const rows = table[2];
    const listed = new Set();
    const missing = [];
    for (const [, cells] of rows) {
        const cell = idCol < cells.length ? cells[idCol] : '';
        const m = ADR_RE.exec(cell);
        if (!m)
            continue;
        const adrId = m[0];
        listed.add(adrId);
        const target = fileCol !== null && fileCol < cells.length ? indexTarget(cells[fileCol]) : null;
        // 先护栏：「文件」列写绝对路径或 `..` 时，字面出仓的不碰文件系统（B11）。Python 的 `os.path.join(root, adr_dir, target)`：target 是绝对路径时直接取 target
        if (target && [pyJoin(root, adrDirRel, target), pyJoin(root, target)].some((p) => inside(root, p) && isFile(p)))
            continue;
        if (dirIds.has(adrId))
            continue; // 「文件」列不是可用路径时回落到 <ID>*.md
        missing.push(adrId);
    }
    const out = [];
    if (missing.length) {
        out.push(finding(NAME, UNDETERMINED, `${indexRel} 列了 ${missing.length} 个没有实物的 ADR`, {
            where: indexRel, kind: 'adr-index-missing', key: indexRel,
            reason: `索引里有这些 ID，但「文件」列指的路径与 ${adrDirRel} 下的 \`<ID>*.md\` 都没找到；是还没展开、放在别处，还是真的丢了，本工具判不了`,
            why: '02 §8「`decisions/README.md` 是索引：ID、标题、状态、日期、影响模块」', evidence: `缺实物：${cap(missing)}`,
        }));
    }
    const unindexed = [...dirIds.keys()].filter((i) => !listed.has(i)).sort(cmpCp);
    for (const adrId of unindexed) {
        out.push(finding(NAME, declared ? FAIL : UNDETERMINED, `${adrId} 在 ${adrDirRel} 里，索引没有它`, {
            where: dirIds.get(adrId), kind: 'adr-unindexed', key: adrId,
            reason: declared ? '' : 'ADR 目录是按目录名猜到的（项目未声明 layout.artifacts.decisions），猜中的前提下才谈得上漏登；契约 §1.1：猜测得出的结论只能记未定',
            why: '02 §8「`decisions/README.md` 是索引：ID、标题、状态、日期、影响模块」；索引漏了一份实物，等于这份决定在索引这条必经路径上不存在',
            evidence: `实物 ${dirIds.get(adrId)}；索引列出的 ID：${cap([...listed].sort(cmpCp)) || '（无）'}`,
        }));
    }
    if (out.length || listed.size === 0)
        return out; // 空集上说不出「全部通过」（01 §2 N1）
    return [finding(NAME, PASS, `adr-index：索引 ${listed.size} 行、目录 ${dirIds.size} 份，全部对上`, {
            where: indexRel, kind: 'adr-index', why: '01 §5.6：门跑过与没跑过要分得出；本条列出来是为了让静默失效看得见',
            evidence: `索引 ${indexRel} 的第一张表；对象＝${adrDirRel} 下不在 layout.frozen 内的 \`ADR-<数字>*.md\`；双向对账：索引每个 ID 都定位到实物，每份实物的 ID 都在索引 ID 列`,
        })];
}
/** Python 的 `os.path.basename`（入参已规范成 `/` 分隔）。 */
const basenameOf = (r) => { const i = r.lastIndexOf('/'); return i < 0 ? r : r.slice(i + 1); };
/** Python 的 `os.path.join(a, b, ...)`：后一段是绝对路径时丢弃前面的。 */
function pyJoin(...parts) {
    let acc = parts[0];
    for (const p of parts.slice(1))
        acc = isAbsolutePy(p) ? p : join(acc, p);
    return acc;
}
const isAbsolutePy = (p) => p.startsWith('/') || (process.platform === 'win32' && (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\')));
function parseDay(s) {
    const y = Number(s.slice(0, 4)), mo = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
    return validDate(y, mo, d) ? [{ year: y, month: mo, day: d }, null] : [null, `不是合法日期：${pyRepr(s)}`];
}
function checkDates(cfg, root, files, docsRoot) {
    const hot = [];
    let scanned = 0, candTotal = 0;
    const unread = [];
    for (const rel of files) {
        if (inFrozen(cfg, rel))
            continue;
        let cand;
        try {
            // 不走 readText：它把孤立的 \r 归一成 \n，行号就与只认 \n 的 git blame 错位（B14）
            cand = candidates(readBytes(join(root, ...rel.split('/')), root).toString('utf8'));
        }
        catch (exc) { // 一份读不了只记它自己，不丢整条判据（B16）
            unread.push(unreadable(NAME, rel, exc));
            continue;
        }
        scanned++;
        if (cand.length) {
            hot.push([rel, cand]);
            candTotal += cand.length;
        }
    }
    if (scanned === 0)
        return unread; // 空集上说不出「全部通过」（01 §2 N1）
    const cleanPass = () => [finding(NAME, PASS, `future-date：扫 ${scanned} 份文档、${candTotal} 个候选行，无晚于写下时间的日期`, {
            where: String(docsRoot), kind: 'future-date',
            why: '01 §5.6：门跑过与没跑过要分得出；本条列出来是为了让静默失效看得见',
            evidence: `扫描面 ${docsRoot}（git 跟踪、不在 layout.frozen 内的 *.md）；候选＝日期后 ${ACT_WINDOW} 字内带动作词且左侧 ${PLAN_WINDOW} 字内不带计划词；基准＝该行 git blame 的提交时刻在 UTC+14 下的日期`,
        })];
    if (hot.length === 0)
        return [...unread, ...cleanPass()];
    const [code, text, err] = git(root, ['rev-parse', '--is-shallow-repository'], hardenedEnv(process.env), 60_000);
    if (code === null || code !== 0) {
        return [...unread, finding(NAME, UNDETERMINED, '判不了日期：探测不出是不是浅克隆', {
                kind: 'future-date', reason: err || `git rev-parse --is-shallow-repository 退出码 ${code === null ? 'None' : code}`,
                why: '01 §2 N1：依赖不可用记未定，不记通过', evidence: `${docsRoot} 下有 ${hot.length} 份文档含候选日期`,
            })];
    }
    if (pyStrip(text).toLowerCase() === 'true') {
        return [...unread, finding(NAME, UNDETERMINED, '浅克隆下判不了日期是否晚于写下它的提交', {
                kind: 'future-date',
                reason: '浅克隆下 blame 时间不可信：git blame 退出 0，但全部行都归到边界提交、时间等于当下，逐文件比会得出整仓无问题的假结论',
                why: '01 §2 N1：判不了的记未定，不记通过',
                evidence: `git rev-parse --is-shallow-repository = true；${docsRoot} 下有 ${hot.length} 份文档含候选日期未判`,
            })];
    }
    const today = latestDay(Date.now() / 1000);
    const out = [];
    for (const [rel, cand] of hot) {
        const [blamed, problem] = blame(root, rel);
        if (problem || blamed === null) {
            out.push(finding(NAME, UNDETERMINED, `取不到 ${rel} 的行级提交时间`, {
                where: rel, kind: 'blame-unavailable', key: rel, reason: problem ?? '', why: '01 §2 N1：依赖不可用记未定，不记通过', evidence: `该文件有 ${cand.length} 处候选日期未判`,
            }));
            continue;
        }
        const groups = new Map();
        const lost = [];
        for (const [lineno, day] of cand) {
            const [got] = parseDay(day);
            if (got === null)
                continue;
            const hit = blamed.get(lineno);
            if (hit === undefined) {
                lost.push(lineno);
                continue;
            }
            const [sha, baseDay] = hit;
            let base, note;
            if (baseDay === null) { // parseBlame 只对全零 sha（未提交行）给 null：日期本身就是「是否已提交」的权威，这里不再对 sha 重判一遍
                base = today;
                note = `该行未提交，基准取运行时刻在 UTC+14 下的日期 ${toIso(today)}`;
            }
            else {
                base = baseDay;
                note = `比较基准：git blame 提交时刻在 UTC+14 下的日期 ${toIso(base)}（${sha.slice(0, 7)}）`;
            }
            if (compareDays(got, base) > 0) {
                const g = groups.get(day) ?? [];
                g.push([lineno, note]);
                groups.set(day, g);
            }
        }
        if (lost.length) {
            out.push(finding(NAME, UNDETERMINED, `${rel} 有 ${lost.length} 个候选行在 blame 结果里找不到`, {
                where: rel, kind: 'blame-line-missing', key: rel, reason: '行号与 git blame 对不上，这些行写下的时间取不到，判不了',
                why: '01 §2 N1：依赖不可用记未定，不记通过', evidence: `第 ${lost.slice(0, LIST_CAP).join('、')} 行`, // py-semantics-ok: lost 是数组，LIST_CAP 是元素个数
            }));
        }
        for (const day of [...groups.keys()].sort(cmpCp)) {
            const hits = groups.get(day);
            out.push(finding(NAME, UNDETERMINED, `${rel} 里的 ${day} 写成已经发生，却晚于写下它的那次提交`, {
                where: `${rel}:${hits[0][0]}`, kind: 'future-date', key: `${rel}|${day}`,
                reason: `日期后 ${ACT_WINDOW} 字内出现动作词（${PAST_ACTS.slice(0, 4).join('/')}…之一），读起来是既成事实；是预告、笔误，还是真的提前写下，本工具判不了`,
                why: '01 §2 N1：判不了的记未定不记通过；词表是工具常量（契约 §1.1），永不 FAIL',
                evidence: cap(hits.map(([n, nt]) => `第 ${n} 行：${nt}`)),
            }));
        }
    }
    return [...unread, ...(out.length ? out : cleanPass())];
}
// --------------------------------------------------------------------------
// 判据 4：STATUS 声明的工作项没有文件
// --------------------------------------------------------------------------
function checkWorkItems(cfg, root, files) {
    const declared = cfgGet(cfg, 'layout.artifacts.status');
    let statusRel;
    if (pyTruthy(declared)) {
        statusRel = normRel(declared).replace(/\/+$/, '');
        const statusPath = join(root, ...statusRel.split('/'));
        if (!inside(root, statusPath))
            return [outsideRoot(NAME, statusRel)];
        if (!(isFile(statusPath) || isDir(statusPath))) {
            return [finding(NAME, UNDETERMINED, `状态文件不存在：${statusRel}`, {
                    where: statusRel, kind: 'status-missing', key: statusRel,
                    reason: 'layout.artifacts.status 声明了它，但文件与目录都不在；是配置过期还是文件被移走，本工具判不了',
                    why: '01 §4.1 的工作项以 STATUS 的声明为入口，入口不在则判不了',
                })];
        }
    }
    else {
        statusRel = null;
        const cands = STATUS_CANDIDATES.map((c) => rebaseDocs(c, docsRootOf(cfg)[0]));
        for (const cand of cands) {
            const p = join(root, ...cand.split('/'));
            if (!inside(root, p) || pathExists(p)) { // 出仓的候选不探测，读时记未定
                statusRel = cand;
                break;
            }
        }
        if (statusRel === null) {
            return [finding(NAME, SKIP, '没有状态文件，判据 4（STATUS 声明的工作项）本次未执行', {
                    reason: `未声明 layout.artifacts.status，候选 ${cands.join(' / ')} 也都不存在；本工具不猜状态文件叫什么`,
                    why: '01 §4.1 以工作项为对象；契约 §1.1：候选路径是约定，猜不到不记通过',
                })];
        }
    }
    // 状态源是目录（一件一文件即状态源）时，ID 取它直接一层的 *.md，不递归。
    const statusAbs = join(root, ...statusRel.split('/'));
    const sources = inside(root, statusAbs) && isDir(statusAbs) ? files.filter((f) => f.toLowerCase().endsWith('.md') && dirnameOf(f) === statusRel) : [statusRel];
    const seen = new Map();
    const unread = [];
    const inline = new Set(); // 状态源文件里自带 work_item_id 字段的工作项
    for (const src of sources) {
        let text;
        try {
            text = readText(join(root, ...src.split('/')), root);
        }
        catch (exc) { // 一份读不了只记它自己，不丢其余状态源（B16）
            unread.push(unreadable(NAME, src, exc));
            continue;
        }
        const lines = splitLinesPy(text);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const m of line.matchAll(WI_RE))
                if (!seen.has(m[0]))
                    seen.set(m[0], `${src}:${i + 1}`);
            const m = src === statusRel ? WI_FIELD_RE.exec(line) : null;
            if (m)
                inline.add(m[1]);
        }
    }
    if (seen.size === 0)
        return unread; // 一个 ID 都没有：无结论，不产条目
    let [wroot, wnote] = workRoot(cfg);
    wroot = normRel(wroot).replace(/\/+$/, ''); // 与 dirname 比较：`work/` 须等于 `work`，`.` 即仓根 ""
    if (wroot === '.')
        wroot = '';
    // 目录不在是 layout 报的那一件事（契约 §1）；逐 ID 再报一遍就是同一事实报 N 次。L0 按模板把工作项写在 WORK.md 里、本就没有这个目录，更不该逐条报「没有文件」。
    const absent = workRootAbsent(NAME, cfg);
    if (absent)
        return [...unread, absent];
    // 只认直接一层：work_root 下的子目录（如 L1 的 work/artifacts/）放的是留证与产物，文件名以 ID 开头也不是工作项本身。
    // 文件名开头的完整 ID（数字取尽）查集合：WI-001 不许被 WI-0010-x.md 冒充，也不逐 ID 逐文件正则比对
    const have = new Set(inline);
    for (const rel of mdUnder(files, wroot)) {
        if (dirnameOf(rel) !== wroot)
            continue;
        const m = WORK_ITEM_NAME.exec(basenameOf(rel));
        if (m)
            have.add(m[0]);
    }
    const out = [];
    for (const wid of [...seen.keys()].filter((w) => !have.has(w)).sort(cmpCp)) {
        out.push(finding(NAME, UNDETERMINED, `${wid} 在 ${statusRel} 里声明了，${wroot} 直接一层没有它的文件，状态源文件里也没有它的 work_item_id 行`, {
            where: seen.get(wid), kind: 'work-item-missing', key: wid,
            reason: `${wroot} 直接一层没有文件名以 ${wid} 开头的工件；是还没建、建在别处，还是这个 ID 只是正文里提了一句，本工具判不了。ID 形态 WI-<三位以上数字> 是工具约定（契约 §1.1），永不 FAIL`,
            why: '01 §4.1：每个状态都写明**必需工件**，`planned` 起就要有工作项文件；工件缺失即不得进入该状态',
            evidence: wnote,
        }));
    }
    if (out.length)
        return [...unread, ...out];
    return [...unread, finding(NAME, PASS, `work-item：状态文件列了 ${seen.size} 个 ID，都有载体（${wroot} 直接一层的文件或状态源里的 work_item_id 字段）`, {
            where: statusRel, kind: 'work-item', why: '01 §5.6：门跑过与没跑过要分得出；本条列出来是为了让静默失效看得见',
            evidence: `状态文件 ${statusRel}；ID 形态 \`WI-<三位以上数字>\`；${wnote}`,
        })];
}
// --------------------------------------------------------------------------
// 契约接口
// --------------------------------------------------------------------------
export function scope(cfg) {
    const [docsRoot, dnote] = docsRootOf(cfg);
    const decisions = cfgGet(cfg, 'layout.artifacts.decisions');
    const status = cfgGet(cfg, 'layout.artifacts.status');
    const wroot = workRoot(cfg)[0];
    const frozen = cfgGet(cfg, 'layout.frozen');
    const frozenList = pyTruthy(frozen) ? (Array.isArray(frozen) ? frozen : []) : [];
    return {
        covered: [
            `layout.docs_root（当前 ${pyRepr(docsRoot)}${dnote ? '，默认' : ''}）下 git 跟踪、不在 frozen 内的 *.md：日期后 ${ACT_WINDOW} 字内带动作词且左侧 ${PLAN_WINDOW} 字内不带计划词的那些日期，` +
                '是否晚于该行 `git blame` 提交时刻在最晚时区 UTC+14 下的日期（未提交行取运行时刻）',
            `ADR 目录（layout.artifacts.decisions，当前 ${pyRepr(pyTruthy(decisions) ? decisions : '（未声明）')}；未声明则在 docs_root 内找名为 decisions 的目录）里除索引外、不在 frozen 内的 *.md：` +
                '围栏代码块之外的行首是否以就地修订标记词开头（围栏按 CommonMark 开闭；英文 revision/changelog 只认 `#` 标题或后跟冒号/表格竖线/行尾的标签形态；「修订后」开头的指代句不算）',
            `同一目录的索引（${INDEX_NAMES.join(' 或 ')} 的第一张表）与目录里 \`ADR-<数字>\` 实物的双向对账：索引有 ID 无实物、实物不在索引 ID 列`,
            `状态文件（layout.artifacts.status，当前 ${pyRepr(pyTruthy(status) ? status : '（未声明）')}；声明为目录时取其直接一层、git 跟踪的 *.md，不递归）正文里的 \`WI-<三位以上数字>\`，有没有载体：` +
                `${wroot} 直接一层（不含子目录里的留证与产物）以该 ID 开头的 *.md，或状态源文件里行首的 \`work_item_id：<ID>\`（WORK_ITEM 模板首字段，冒号全角半角皆可）`,
        ],
        not_covered: [
            `**两份词表都是工具常量，换一种写法就漏**：日期动作词 ${PAST_ACTS.length} 个、ADR 修订标记词 ${REVISION_MARKERS.length} 个。命中率没有召回数据，只有误报数据；按契约 §1.1 它们永不 FAIL`,
            `**不判日期的语义**：到期日、计划日、复查日不在候选句式里（左侧 ${PLAN_WINDOW} 字带 ${PLAN_WORDS.join('/')} 之一即丢弃），所以它们晚于提交日也不看——那本来就该晚`,
            '只看 docs_root 与 ADR 目录，别处不看。`.std/` 里的标准副本**通常**不在扫描面，因为它一般不在 docs_root 之下——这是路径关系，不是工具对 `.std/` 做了特判；采用项目把它放进 docs_root 就会被扫',
            'decisions 目录里非 ADR 的 md（模板、会议纪要、说明页）照样按判据 2 判，工具分不出',
            '浅克隆下 blame 时间不可信（全部行归边界提交、时间等于当下），判据 1 整条记一条未定，不逐文件报',
            '**merge 带进来的改动照样按 blame 时间判**：判据看的是行的提交时间，不受提交钩子是否触发影响（pre-commit 对 merge 与 `--no-verify` 静默失效，这里不受那层影响）',
            '判据 3 不读 ADR 头、不比索引与正文的状态/日期——`**draft**` 与 `superseded → ADR-0012` 这类写法没有无歧义的归一化，比出来的不一致会是假 FAIL',
            '反向不报：work_root 下有文件而 STATUS 没提、目录里有 ADR 而索引没列（后者报，前者不报）',
            `**归档区（layout.frozen：${frozenList.map((x) => pyStr(x)).join('、') || '未配置'}）整体不看**：四条判据的对象集合都先减掉它——归档区里的 ADR 既不判就地修订，也不参与索引对账` +
                '（放进 frozen 的 ADR 会让索引那一侧看起来『少了实物』，工具只当它不存在）。依据 01 §3.1：归档区不承担更新义务',
            '每条判据干净时各出一条 PASS，**那条 PASS 只承诺「扫了多少、都对上了」**，不承诺扫描面之外的事；判据没执行时出的是 SKIP 或未定，不会出 PASS',
        ],
    };
}
// --------------------------------------------------------------------------
// 自检（契约 §3：必须有反例；本检查器四条判据里三条永不 FAIL，用**结果断言**钉死）
// --------------------------------------------------------------------------
/** 自检样本要**真提交**（gitTrack 给 when）：判据 1 的基准来自 blame，没有提交就没有基准。 */
const COMMIT_DATE = '2026-09-21T05:26:00+08:00'; // 基准日 2026-09-21，不随运行机日期漂
const idsOf = (res, kind) => res.filter((f) => f.id.startsWith(`${NAME}/${kind}`)).map((f) => f.id).sort(cmpCp);
const J = (v) => JSON.stringify(v);
const eqJ = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tail = (got, err) => `实得 ${J(got)}${err ? `；git 准备失败：${err}` : ''}`;
export function selftest() {
    const results = [];
    const tmps = [];
    const mk = () => { const t = mkdtempSync(join(tmpdir(), 'drself-')); tmps.push(t); return t; };
    const assertP = (ok, title, evidence, why = '契约 §3 静默失效探测') => { results.push(probe(NAME, ok, title, { evidence, why })); };
    const cfgDocs = (tmp, extra = {}) => ({ _root: tmp, layout: { docs_root: 'docs', ...extra } });
    try {
        // ---- 1e/1f：基准取提交时刻在 UTC+14 下的日期，不取提交自带时区 ----
        {
            const tmp = mk();
            writeText(join(tmp, 'docs', 'a.md'), '# 样本\n\n- 2026-09-14 裁定 X。\n- 2026-09-15 裁定 Y。\n');
            const err = gitTrack(tmp, '2026-09-13T21:46:00-07:00'); // +0800 下已是 09-14 12:46
            const res = err ? [] : run(cfgDocs(tmp));
            const got = idsOf(res, 'future-date');
            assertP(!err && !got.includes('drift/future-date/docs/a.md｜2026-09-14'), '1e 正例：-0700 时区 09-13 晚上的提交里写『2026-09-14 裁定』不得报——同一时刻在东边已是 09-14', tail(got, err), '写日期的人与提交者时区未必相同；按提交自带时区取日会把正确日期报成未来');
            assertP(!err && got.includes('drift/future-date/docs/a.md｜2026-09-15'), '1f 反例：同一提交里写『2026-09-15 裁定』须照报——UTC+14 下也还没到那天', tail(got, err), '放宽只许到最晚时区为止，再宽就漏掉真正的未来日期');
        }
        // ---- 1a/1b/1d：真提交后比 blame 日；1c：未提交行取运行时刻 ----
        {
            const tmp = mk();
            const doc = join(tmp, 'docs', 'a.md');
            writeText(doc, '# 样本\n\n' +
                '- 协调方 2026-09-22 裁定 X。\n' + // 1a 报
                '- v1 保留至 2026-12-31。\n' + // 1b 不报
                '- 批准 2026-05-12 → 到期 2026-10-31，届时复核。\n' + // 1b 不报
                '- 复查：2026-12-08（半年）——已复查，无回退。\n'); // 1d 不报
            const err = gitTrack(tmp, COMMIT_DATE);
            const cfg = cfgDocs(tmp);
            const res = err ? [] : run(cfg);
            const got = idsOf(res, 'future-date');
            assertP(!err && eqJ(got, ['drift/future-date/docs/a.md｜2026-09-22']) && eqJ(res.filter((f) => got.includes(f.id)).map((f) => f.status), [UNDETERMINED]), '1a 反例 + 1b/1d 正例：『2026-09-22 裁定』写于 09-21 须报出且状态是 UNDETERMINED；保留至/到期/复查三行不得报', tail(got, err), '契约 §3 静默失效探测；契约 §1.1：词表是猜测，永不 FAIL');
            if (!err) {
                const future = toIso(addDays(todayLocal(), 30));
                appendLine(doc, `- ${future} 拍板追加一条。\n`);
                const res2 = run(cfg);
                const hit = res2.filter((f) => f.id === `drift/future-date/docs/a.md｜${future}`);
                assertP(hit.length === 1 && (hit[0].evidence ?? '').includes('未提交'), '1c 反例：提交后追加的未提交行，基准取运行时刻，证据要写明『未提交』', `实得 ${J(res2.map((f) => f.id))}；证据 ${pyRepr(hit.length ? hit[0].evidence : '（无）')}`);
            }
        }
        // ---- 2a/2b/2c：ADR 就地修订标记从第 0 个字符起 ----
        {
            const tmp = mk();
            writeText(join(tmp, 'docs', 'decisions', 'README.md'), '# 索引\n\n| ID | 标题 | 状态 | 文件 |\n|---|---|---|---|\n| ADR-0001 | 甲 | active | [ADR-0001](ADR-0001-x.md) |\n| ADR-0002 | 乙 | active | ADR-0002 |\n');
            writeText(join(tmp, 'docs', 'decisions', 'ADR-0001-x.md'), '# ADR-0001\n\n> **修订二**：补充了一段说明。\n'); // 2a 报
            writeText(join(tmp, 'docs', 'decisions', 'ADR-0002-y.md'), '# ADR-0002\n\n正文里补充索引后，检索更快。\n'); // 2b 不报
            writeText(join(tmp, 'docs', 'notes', '变更记录.md'), '# 变更记录\n\n修订三：这份不在 decisions 下。\n'); // 2c 不报
            const err = gitTrack(tmp, COMMIT_DATE);
            const res = err ? [] : run(cfgDocs(tmp, { artifacts: { decisions: 'docs/decisions' } }));
            const got = idsOf(res, 'adr-revision');
            assertP(!err && eqJ(got, ['drift/adr-revision/docs/decisions/ADR-0001-x.md']), '2a 反例 + 2b/2c 正例：`> **修订二**：` 须报出；『正文里补充索引后』（标记词在第 3 位）与 decisions 之外的 `变更记录.md` 都不得报', tail(got, err), 'D-3：放宽成『前 8 个字符内』时本仓 docs/ 的候选行数成倍增加，全是正文句子');
            // 2d/2e：围栏代码块、英文词作普通名词、「修订后」指代句不命中；标题/标签形态仍命中
            const mustHit = ['## 修订记录', '修订五：补一段。', '> **修订：** 改了一句。', '补充说明（2026-09-01）', '## Changelog', 'Revision: 2'];
            const mustMiss = ['```', '修订：围栏里的样例', '## Changelog', '```', '~~~sql', 'Revision: 9', '~~~', 'revision id `"0053_x"`（迁移脚本名）照旧。', '修订后的结论见 §13.1。', '修订后：以新表为准。'];
            const hits = revisionHits([...mustMiss, ...mustHit].join('\n'));
            const hitLines = hits.map(([n]) => n).sort((a, b) => a - b);
            const want = Array.from({ length: mustHit.length }, (_, i) => mustMiss.length + 1 + i);
            assertP(eqJ(hitLines, want), '2d 正例 + 2e 反例：围栏代码块内、`revision id …` 叙述行、「修订后」开头的指代句都不得命中；`## 修订记录`、`修订五：`、`> **修订：**`、`补充说明（…）`、`## Changelog`、`Revision: 2` 缺一即失败', `期望命中行 ${J(want)}，实得 ${J(hits.map(([n, s]) => [n, s]))}`, '采用项目实测误报：围栏里的样例、英文 revision 作普通名词、「修订后」作指代');
            // 2f/2g/2h：围栏按 CommonMark 开闭（同字符、长度 ≥ 开围栏；行首 ```x``` 是内联不开围栏）；表格标签行 `| Revision | 2 |` 仍命中
            const sample = ['````md', '```', '修订：外层围栏里的样例', '```', '````', '修订六：外层围栏之后的真标记', '```x``` 是行内代码，不开围栏', '修订七：内联代码之后的真标记', '| Revision | 2 |'];
            const got2 = revisionHits(sample.join('\n')).map(([n]) => n).sort((a, b) => a - b);
            assertP(eqJ(got2, [6, 8, 9]), '2f/2g/2h：4 反引号外层内嵌 ``` 后的真标记、行首 ```x``` 后的真标记、表格行 `| Revision | 2 |` 都须命中，外层围栏里的样例不得命中', `期望命中行 [6, 8, 9]，实得 ${J(got2)}`, 'CommonMark：闭合围栏须同字符且不短于开围栏；反引号围栏的信息串不得含反引号');
            // 3d：「文件」列写裸 ID 而实物叫 ADR-0002-y.md → 不得计入缺实物
            assertP(!err && idsOf(res, 'adr-index-missing').length === 0, '3d 正例：索引「文件」列写裸 `ADR-0002`，实物叫 `ADR-0002-y.md`，两段式定位须找到它', `实得 ${J(idsOf(res, 'adr-index-missing'))}`, 'D-5：只认「文件」列、不回落 glob 时，这一行会成为假的 adr-index-missing');
        }
        // ---- 3e（B11）：索引「文件」列写绝对路径或 `..` 出仓时不探测存在性，按缺实物记未定 ----
        {
            const tmp = mk(), outsideDir = mk();
            for (const n of ['0008', '0009'])
                writeText(join(outsideDir, `ADR-${n}.md`), '# 仓外\n');
            const up = relative(join(tmp, 'docs', 'decisions'), outsideDir).replaceAll('\\', '/');
            writeText(join(tmp, 'docs', 'decisions', 'README.md'), `| ID | 文件 |\n|---|---|\n| ADR-0008 | ${outsideDir.replaceAll('\\', '/')}/ADR-0008.md |\n| ADR-0009 | [x](${up}/ADR-0009.md) |\n`);
            // 不探测仓外：这里不 monkey-patch 文件系统（Python 版替换 os.path.isfile 记录探测），改为**结果断言**——仓外两份实物真实存在，若被探测则会被认作「有实物」，缺实物就报不出来
            const res = checkIndex(tmp, 'docs/decisions', [], 'docs/decisions/README.md', true);
            const got = res.filter((f) => f.id.startsWith('drift/adr-index-missing')).map((f) => f.id);
            assertP(eqJ(got, ['drift/adr-index-missing/docs/decisions/README.md']), '3e 反例：索引「文件」列指向仓外（绝对路径、`..`）不得探测存在性，按缺实物记未定', `实得 ${J(res.map((f) => f.id))}`, '契约 §5：字面就在项目之外的路径连存在性也不探测');
        }
        // ---- 3a/3b/3c：索引对账，声明与回退的结论必须不同 ----
        {
            const tmp = mk();
            writeText(join(tmp, 'docs', 'decisions', 'README.md'), '# 索引\n\n| ID | 标题 | 状态 | 文件 |\n|---|---|---|---|\n| ADR-0001 | 甲 | active | [ADR-0001](ADR-0001-x.md) |\n| ADR-0002 | 乙 | active | ADR-0002 |\n');
            writeText(join(tmp, 'docs', 'decisions', 'ADR-0001-x.md'), '# ADR-0001\n\n正文。\n');
            writeText(join(tmp, 'docs', 'decisions', 'ADR-0003-y.md'), '# ADR-0003\n\n正文。\n');
            const err = gitTrack(tmp, COMMIT_DATE);
            const res = err ? [] : run(cfgDocs(tmp, { artifacts: { decisions: 'docs/decisions' } }));
            const miss = res.filter((f) => f.id.startsWith('drift/adr-index-missing'));
            const unix = res.filter((f) => f.id === 'drift/adr-unindexed/ADR-0003');
            assertP(!err && miss.length === 1 && (miss[0].evidence ?? '').includes('ADR-0002') && miss[0].status === UNDETERMINED, '3a 反例：索引列了 ADR-0002 而目录里没有实物，须聚合成一条 adr-index-missing 未定', `实得 ${J(idsOf(res, 'adr-index-missing'))}；证据 ${pyRepr(miss.length ? miss[0].evidence : '（无）')}${err ? `；git 准备失败：${err}` : ''}`);
            assertP(!err && unix.length === 1 && unix[0].status === FAIL, '3b 反例：目录里有 ADR-0003 实物而索引没列，且项目**声明了** layout.artifacts.decisions，须判 FAIL', `实得 ${J(unix.map((f) => [f.id, f.status]))}`);
            const res2 = err ? [] : run(cfgDocs(tmp));
            const unix2 = res2.filter((f) => f.id === 'drift/adr-unindexed/ADR-0003');
            assertP(!err && unix2.length === 1 && unix2[0].status === UNDETERMINED, '3c 正例：同一棵树，ADR 目录靠目录名回退猜到时，同一条须降为 UNDETERMINED 不是 FAIL', `实得 ${J(unix2.map((f) => [f.id, f.status]))}`, '契约 §1.1：判据靠猜测得出的结论只能是 PASS 或 UNDETERMINED，永不 FAIL');
        }
        // ---- 4a/4b/4c：STATUS 声明的工作项 ----
        {
            const tmp = mk();
            writeText(join(tmp, 'docs', 'state', 'STATUS.md'), '# 状态\n\n- WI-0001 在做。\n- WI-0003 也在做。\n');
            writeText(join(tmp, 'docs', 'state', 'work', 'WI-0003-a.md'), '# WI-0003\n');
            writeText(join(tmp, 'docs', 'state', 'work', 'WI-0002-b.md'), '# WI-0002\n');
            const err = gitTrack(tmp, COMMIT_DATE);
            const res = err ? [] : run(cfgDocs(tmp, { artifacts: { status: 'docs/state/STATUS.md' } }));
            const got = idsOf(res, 'work-item-missing');
            assertP(!err && eqJ(got, ['drift/work-item-missing/WI-0001']) && eqJ(res.filter((f) => got.includes(f.id)).map((f) => f.status), [UNDETERMINED]), '4a 反例 + 4b/4c 正例：STATUS 写了 WI-0001 而 work/ 下没有它，须报一条未定；有文件的 WI-0003 与只有文件没进 STATUS 的 WI-0002 都不得报', tail(got, err), '契约 §3 静默失效探测；契约 §1.1：ID 形态是工具约定，永不 FAIL');
            const passes = res.filter((f) => f.status === PASS).map((f) => f.id).sort(cmpCp);
            assertP(!err && eqJ(passes, ['drift/future-date']), 'PASS 的两个方向：判据 1 这次干净，须出一条 `drift/future-date` PASS 让它看得出跑过；判据 4 这次有问题，就**不得**再出 `drift/work-item` PASS', `实得 PASS ${J(passes)}`, '01 §5.6 静默失效探测：跑过与没跑过要在报告里分得出；有问题的判据再报一条通过，等于两句话互相抵消');
            const hit0 = res.filter((f) => got.includes(f.id))[0];
            assertP(!err && (hit0?.evidence ?? '').includes('默认'), `4a 附带：未声明 layout.work_root 时取常量 ${DEFAULT_WORK_ROOT}，证据里须注明用的是默认`, `证据 ${pyRepr(hit0?.evidence ?? '')}`);
        }
        // ---- 4d/4e：状态源声明为目录（一件一文件）视为存在；路径不存在仍报 ----
        {
            const tmp = mk();
            writeText(join(tmp, 'docs', 'items', 'a.md'), '# 甲\n\n- WI-0007 在做。\n');
            writeText(join(tmp, 'docs', 'items', 'sub', 'b.md'), '- WI-0009 不递归。\n');
            writeText(join(tmp, 'docs', 'state', 'work', 'WI-0007-a.md'), '# WI-0007\n');
            const err = gitTrack(tmp, COMMIT_DATE);
            let res = err ? [] : run(cfgDocs(tmp, { artifacts: { status: 'docs/items' } }));
            const got = res.filter((f) => f.id.startsWith('drift/status') || f.id.startsWith('drift/work-item')).map((f) => f.id).sort(cmpCp);
            assertP(!err && eqJ(got, ['drift/work-item']), '4d 正例：layout.artifacts.status 指向目录时视为存在，不报 status-missing；ID 取目录下直接一层 *.md（WI-0007 有文件→PASS；子目录里的 WI-0009 不递归、不报）', tail(got, err));
            res = err ? [] : run(cfgDocs(tmp, { artifacts: { status: 'docs/nope' } }));
            assertP(!err && eqJ(idsOf(res, 'status-missing'), ['drift/status-missing/docs/nope']), '4e 反例：layout.artifacts.status 指向的路径文件与目录都不存在，仍须报 status-missing', `实得 ${J(idsOf(res, 'status-missing'))}`);
        }
        // ---- 4f：L0 形态——WORK.md 里写着 WI-，没有工作项目录 ----
        {
            const tmp = mk();
            writeText(join(tmp, 'WORK.md'), '# 工作\n\n- WI-0001 在做。\n');
            writeText(join(tmp, 'docs', 'a.md'), '# 甲\n');
            const err = gitTrack(tmp, COMMIT_DATE);
            const res = err ? [] : run(cfgDocs(tmp));
            const got = res.filter((f) => f.id.startsWith('drift/status') || f.id.startsWith('drift/work')).map((f) => f.id).sort(cmpCp);
            assertP(!err && eqJ(got, ['drift/work-root-absent']), '4f 正例：状态文件列了 ID 而工作项目录不在，只记一条 work-root-absent（SKIP），不逐 ID 报 work-item-missing——目录不在由 layout 报一次（契约 §1），L0 本不要求它', tail(got, err));
        }
        // ---- 4g/4h/4i：L1 形态——工作项写在状态源 work/current.md 的小节里 ----
        {
            const tmp = mk();
            writeText(join(tmp, 'work', 'current.md'), '# 工作项：甲\n\nwork_item_id：WI-0001\n状态：IMPLEMENTING\n\n# 工作项：乙\n\n状态：DEFINED（小节里没有 work_item_id 行）\n\n- 依赖 WI-0002；留证见 WI-0003；WI-0004 有独立文件。\n');
            writeText(join(tmp, 'work', 'artifacts', 'WI-0003-回灌记录.md'), '# 留证\n');
            writeText(join(tmp, 'work', 'WI-0004-a.md'), '# WI-0004\n');
            const err = gitTrack(tmp, COMMIT_DATE);
            const layout = { docs_root: 'docs', work_root: 'work', artifacts: { status: 'work/current.md' } };
            const cfg = { _root: tmp, layout };
            let res = err ? [] : run(cfg);
            let got = idsOf(res, 'work-item-missing');
            assertP(!err && !got.includes('drift/work-item-missing/WI-0001'), '4g 正例：状态源文件里行首 `work_item_id：WI-0001` 的小节就是该工作项的载体，不得报 missing', tail(got, err), 'L1 模板允许工作项写在状态源 work/current.md 里，不要求一件一文件');
            assertP(!err && got.includes('drift/work-item-missing/WI-0002'), '4h 反例：WI-0002 只在正文里被提到、没有 work_item_id 行，仍须报 missing', tail(got, err), '只认模板首字段，放宽到任意提及就等于不查');
            assertP(!err && got.includes('drift/work-item-missing/WI-0003') && !got.includes('drift/work-item-missing/WI-0004'), '4i 反例：work_root 子目录 artifacts/ 下以 WI-0003 开头的留证不是工作项文件，须报 missing；直接一层的 WI-0004-a.md 照旧算载体', tail(got, err), '子目录里是留证与产物，按文件名前缀递归匹配会把它们当成工作项，出假 PASS');
            layout.work_root = 'work/';
            res = err ? [] : run(cfg);
            got = idsOf(res, 'work-item-missing');
            assertP(!err && !got.includes('drift/work-item-missing/WI-0004'), '4i 附带：`work_root: work/` 带尾斜杠时，直接一层的 WI-0004-a.md 照样算载体', `实得 ${J(got)}`, '直接一层按目录名相等比较，尾斜杠不归一就一件都认不出');
        }
        // ---- 1g/1h（D-123 bug 5）：行号只按 \n 切（\x0c、U+2028 不许让行号与 blame 错位后静默跳过）；SHA-256 仓的 64 位行头照样解析 ----
        for (const [tag, fmt] of [['1g', null], ['1h', 'sha256']]) {
            const tmp = mk();
            writeText(join(tmp, 'docs', 'a.md'), '# 样本\x0c分页\u2028续\r孤立回车\n- 2026-09-22 裁定 X。\n');
            let err = null;
            if (fmt) {
                const r = spawnSync('git', ['init', '-q', `--object-format=${fmt}`, tmp], { timeout: 60_000, env: fixtureEnv() });
                err = r.status === 0 ? null : `git init --object-format 退出码 ${r.status}`;
            }
            err = err ?? gitTrack(tmp, COMMIT_DATE);
            const res = err ? [] : run(cfgDocs(tmp));
            const got = res.filter((f) => f.id.startsWith('drift/future-date') || f.id.startsWith('drift/blame')).map((f) => [f.id, f.where ?? null]);
            assertP(!err && eqJ(got, [['drift/future-date/docs/a.md｜2026-09-22', 'docs/a.md:2']]), `${tag} 反例：${fmt ? 'SHA-256 仓' : '含 \\x0c、U+2028 与孤立 \\r（B14）的行'}里写于 09-21 的『2026-09-22 裁定』须报出，行号按 \\n 计为第 2 行`, tail(got, err), '行号或行头对不上时旧实现静默跳过该行，把未来日期漏成通过');
        }
        // ---- 4k（B16）：一份文档或一份状态源读不了，只记它自己一条未定，其余文件照判 ----
        // 「读不了」的夹具：POSIX 用 FIFO；Windows 没有 mkfifo，改让一个目录占住这条已跟踪文件的路径。两种夹具都走 `catch` 之后「只记这一份自己的 unreadable、其余照判」这条路径；
        // 但目录占位不经过 readBytes 的「非常规文件」那一行，所以 FIFO「不阻塞、判为非常规文件」只在 POSIX 上被验证。
        {
            const tmp = mk();
            writeText(join(tmp, 'docs', 'a.md'), '- 2026-09-22 裁定 X。\n');
            writeText(join(tmp, 'docs', 'items', 'a.md'), '- WI-0007 在做。\n');
            writeText(join(tmp, 'docs', 'state', 'work', 'WI-0007-a.md'), '# WI-0007\n');
            for (const rel of ['docs/b.md', 'docs/items/b.md'])
                writeText(join(tmp, rel), '占位\n');
            const err = gitTrack(tmp, COMMIT_DATE);
            for (const rel of ['docs/b.md', 'docs/items/b.md']) {
                rmSync(join(tmp, rel));
                if (process.platform === 'win32')
                    mkdirSync(join(tmp, rel));
                else
                    spawnSync('mkfifo', [join(tmp, rel)]);
            }
            const res = err ? [] : run(cfgDocs(tmp, { artifacts: { status: 'docs/items' } }));
            const got = res.filter((f) => ['drift/future-date', 'drift/status', 'drift/work-item', 'drift/unreadable'].some((p) => f.id.startsWith(p))).map((f) => [f.status, f.id]).sort((a, b) => cmpCp(a[0], b[0]) || cmpCp(a[1], b[1]));
            assertP(!err && eqJ(got, [[PASS, 'drift/work-item'], [UNDETERMINED, 'drift/future-date/docs/a.md｜2026-09-22'], [UNDETERMINED, 'drift/unreadable/docs/b.md'], [UNDETERMINED, 'drift/unreadable/docs/items/b.md']]), '4k 反例：一份文档、一份状态源读不了只各记一条未定，其余照判（未来日期照报、工作项照核）', tail(got, err), '01 §2 N1：没读的记未定；读得了的照常判，不因一份读不了整条作废');
        }
        // ---- 4j（D-123 bug 5）：WI-001 不许被 WI-0010-x.md 冒充成已有文件 ----
        {
            const tmp = mk();
            writeText(join(tmp, 'work', 'current.md'), '# 状态\n\n- WI-001 在做。\n');
            writeText(join(tmp, 'work', 'WI-0010-x.md'), '# WI-0010\n');
            const err = gitTrack(tmp, COMMIT_DATE);
            const res = err ? [] : run(cfgDocs(tmp, { work_root: 'work', artifacts: { status: 'work/current.md' } }));
            const got = idsOf(res, 'work-item-missing');
            assertP(!err && got.includes('drift/work-item-missing/WI-001'), '4j 反例：只有 WI-0010-x.md 时 WI-001 仍须报 missing', tail(got, err), '按前缀比会让编号更长的文件冒充');
        }
        // ---- 5（D-123）：没定位到 ADR 目录——L0/L1 不要求决策登记记不适用；L2 起或档位不明记未定（契约 §1.1） ----
        {
            const got5 = {};
            for (const tier of ['L1', 'L2', null]) {
                const [, , f5] = adrDir(tier ? { tier } : {}, '.', ['docs/a.md'], 'docs');
                got5[String(tier)] = f5 ? f5.status : null;
            }
            assertP(eqJ(got5, { L1: SKIP, L2: UNDETERMINED, null: UNDETERMINED }), '5 ADR 目录没定位到：L1 记不适用，L2 与档位不明记未定', `实得 ${J(got5)}`, '契约 §1 先判适用；§1.1 目录名是约定，落空不记不适用');
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
/** 往已有文件末尾追加文本（UTF-8、不转换换行），夹具专用。 */
function appendLine(path, text) { appendFileSync(path, text, { encoding: 'utf8' }); }
export function run(cfg) {
    return runGuarded(NAME, doRun, cfg);
}
function doRun(cfg) {
    const root = cfg._root || '.';
    const [docsRoot, dnote] = docsRootOf(cfg);
    const [tracked, problem] = trackedFiles(root, ['*.md']);
    if (problem || tracked === null) {
        return [finding(NAME, UNDETERMINED, '列不出 git 跟踪的文档', { reason: problem ?? '', why: '01 §2 N1：依赖不可用记未定，不记通过' })];
    }
    const files = tracked.map((f) => normRel(f)).filter((f) => f.toLowerCase().endsWith('.md'));
    const out = [];
    try {
        out.push(...checkDates(cfg, root, mdUnder(files, docsRoot), docsRoot));
    }
    catch (exc) { // 契约 §4：run 不抛异常
        out.push(undeterminedFromException(NAME, exc, '判日期是否晚于提交'));
    }
    noteDefault(out, dnote); // 日期判据整组依赖 docs_root，取了默认在此统一注明
    try {
        const [adrDirRel, declared, problemF] = adrDir(cfg, root, files, docsRoot);
        const adrNote = declared ? '' : dnote; // 未声明时 ADR 目录是在 docs_root 下找的
        if (problemF !== null) {
            out.push(noteDefault([problemF], adrNote)[0]);
        }
        else {
            // 归档区不承担更新义务（01 §3.1）：既不判就地修订，也不参与索引对账。
            const adrAll = mdUnder(files, adrDirRel).filter((f) => dirnameOf(f) === adrDirRel && !inFrozen(cfg, f));
            let indexRel = null;
            for (const name of INDEX_NAMES) {
                const cand = `${adrDirRel}/${name}`;
                if (adrAll.includes(cand)) {
                    indexRel = cand;
                    break;
                }
            }
            const adrFiles = adrAll.filter((f) => !INDEX_NAMES.includes(basenameOf(f)));
            out.push(...noteDefault([...checkRevision(root, adrDirRel, adrFiles), ...checkIndex(root, adrDirRel, adrFiles, indexRel, declared)], adrNote));
        }
    }
    catch (exc) {
        out.push(undeterminedFromException(NAME, exc, '对账 ADR 索引'));
    }
    try {
        out.push(...checkWorkItems(cfg, root, files));
    }
    catch (exc) {
        out.push(undeterminedFromException(NAME, exc, '核对 STATUS 声明的工作项'));
    }
    return once(out); // 同一份文件读不了只报一次，哪条判据先碰到都一样（契约 §1）
}
