// 跨检查器自检与入口自检（对应 tools/std/check_all.py 的 `_contract_examples_selftest`、`_entry_smoke_selftest`、`_shared_fact_selftest`、`_git_env_selftest`、`_hostile_git_config_selftest`；设计 §12.31）。
//
// 契约 §3：单个检查器的 selftest 看不见别的检查器，这几条只能在汇总层断言。**每条探针的标题与 Python 版逐字相同**（id 是标题的哈希）。
// 与 Python 版的有意差异（均在 test/cases/expected-changes.mjs 登记）：
//   · 夹具里的入口文件由 `CLAUDE.md` 改为 `AGENTS.md`（入口名是配置不是写死的，探针标题与 id 不变）；
//   · `_embedded_readonly_selftest`（shared-fact/251040cc）的对象是 `.std/` 内嵌机制，已废弃（§12.28），不迁。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from './checks/index.js';
import { EXCEPTION_CHECK, IDENTITY_CHECK, render, runAll, joinExceptions, configOutsideRoot, sha256File } from './check_all.js';
import { main } from './main.js';
import { workRoot, STATUS_CANDIDATES, itemStatus, statusKind } from './core/docs.js';
import { WORK_ITEM_STATES, DOC_STATES } from './core/cfg.js';
import { FAIL, PASS, SKIP, UNDETERMINED, finding, findingId } from './core/finding.js';
import { gitTrack, writeFiles, writeText } from './core/fixture.js';
import { undeterminedFromException, probe, unreadable } from './core/shell.js';
import { parseYamlSubset } from './core/yaml.js';
import { addDays, toIso, todayLocal } from './core/dates.js';
import { pyRepr } from './core/repr.js';
const J = (v) => JSON.stringify(v);
const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = resolve(HERE, '..', 'tools', 'std', 'CONTRACT.md');
// 入口冒烟与 git 环境自检共用的夹具（入口文件名由 CLAUDE.md 改为 AGENTS.md，见头注释）
const SMOKE_CONFIG = `layout:
  entry:
    - AGENTS.md
  docs_root: docs
  frozen:
    - docs/archive
budgets:
  entry_lines: 150
`;
const SMOKE_ENTRY = `# 冒烟仓

这个仓只为跑通入口冒烟自检而存在，内容不参与任何判定。
`;
function withTmp(fn) {
    const tmp = mkdtempSync(join(tmpdir(), 'ca-'));
    try {
        return fn(tmp);
    }
    finally {
        rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
}
const by = (name) => CHECKS.find((m) => m.NAME === name);
/** Python 的 dict/list 相等：与对象键序无关（数组仍按次序）。 */
function sameJson(a, b) {
    const norm = (v) => (Array.isArray(v) ? v.map(norm) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v);
    return J(norm(a)) === J(norm(b));
}
// --------------------------------------------------------------------------
// 契约文档里的 yaml 示例必须能被本工具的解析器读懂
// --------------------------------------------------------------------------
export function contractExamplesSelftest() {
    let doc;
    try {
        doc = readFileSync(CONTRACT, 'utf8');
    }
    catch (exc) {
        return [undeterminedFromException('contract-examples', exc, '读 CONTRACT.md')];
    }
    const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
    if (!blocks.length)
        return [finding('contract-examples', UNDETERMINED, '契约里没有 yaml 示例', { reason: '没找到 ```yaml 段；是文档被改了还是正则失效，本检查判不了' })];
    const out = [];
    blocks.forEach((block, i0) => {
        const i = i0 + 1;
        try {
            parseYamlSubset(block);
            out.push(finding('contract-examples', PASS, `CONTRACT.md 第 ${i} 段 yaml 示例解析通过`, { where: 'tools/std/CONTRACT.md' }));
        }
        catch (exc) {
            out.push(finding('contract-examples', FAIL, `CONTRACT.md 第 ${i} 段 yaml 示例本工具自己解析不了`, { where: 'tools/std/CONTRACT.md', why: '文档示例是可执行工件；照抄示例就该能跑通', evidence: `${exc.name}: ${exc.message}` }));
        }
    });
    // §5 写明「唯一接受的流式写法是空列表 []，且只作键的值」。三种形状各钉一下
    let got = null;
    const bad = [];
    try {
        got = parseYamlSubset('k: []\n').k;
    }
    catch (exc) {
        bad.push(`k: [] 被拒：${exc.message}`);
    }
    if (J(got) !== J([]))
        bad.push(`k: [] 应得 []，实得 ${J(got)}`);
    for (const text of ['k:\n  - []\n', 'k: [a, b]\n']) {
        try {
            const val = parseYamlSubset(text);
            bad.push(`${pyRepr(text)} 应被拒收，实得 ${J(val)}`);
        }
        catch { /* 拒收才对 */ }
    }
    out.push(finding('contract-examples', bad.length ? FAIL : PASS, '解析器的流式写法边界与 CONTRACT §5 一致：只有键值 [] 被接受', {
        where: 'tools/std/CONTRACT.md', why: '歧义即拒绝；列表项位置的 [] 若被静默收下会解析成嵌套空列表',
        evidence: bad.join('；') || '键值 [] → []；- [] 与 [a, b] 均拒收',
    }));
    return out;
}
// --------------------------------------------------------------------------
// 跨检查器：同一事实只报一次、同一工件只有一份候选
// --------------------------------------------------------------------------
export function sharedFactSelftest() {
    const need = ['layout', 'evidence', 'freshness', 'drift'];
    if ([...need, 'entry-budget'].some((n) => !CHECKS.some((m) => m.NAME === n)))
        return [finding('shared-fact', UNDETERMINED, '跨检查器自检缺检查器', { reason: `需要 ${[...need, 'entry-budget'].join('/')}` })];
    const repo = (tmp, files) => { writeFiles(tmp, files); gitTrack(tmp); };
    const out = [];
    try {
        // A：L1 项目没有工作项目录，缺省与声明两种 work_root 各跑一遍四个检查器：目录缺失这件事只由 layout 报一次
        const gotA = [];
        withTmp((tmp) => {
            repo(tmp, { 'AGENTS.md': '# 入口\n' });
            for (const extra of [{}, { work_root: 'items' }]) {
                const layout = { entry: ['AGENTS.md'], docs_root: 'docs', ...extra };
                const cfg = { _root: tmp, tier: 'L1', layout };
                const wr = workRoot(cfg)[0];
                const fs = need.flatMap((n) => by(n).run(cfg));
                const told = fs.filter((f) => (f.status === UNDETERMINED || f.status === FAIL) && (f.title.includes('工作项目录') || f.title.includes('（work_current）')));
                const skips = fs.filter((f) => f.id.endsWith('/work-root-absent') && f.evidence.includes('负责报告的检查器：layout')).map((f) => f.id).sort();
                const ok = told.length === 1 && told[0].check === 'layout' && ((told[0].where ?? '') + told[0].evidence).includes(wr) && J(skips) === J(['evidence/work-root-absent', 'freshness/work-root-absent']);
                gotA.push([wr, ok, told.map((f) => [f.id, f.title]), skips]);
            }
        });
        out.push(probe('shared-fact', gotA.every((g) => g[1]), '工作项目录不在：未定只由 layout 报一次，evidence/freshness 记不适用并指向它', { why: '契约 §1：同一事实只由一个检查器报；报两次采用方就得登记两行', evidence: `实得 ${J(gotA)}` }));
        // B：只放一份状态文件，layout 与 drift 对它在不在给同一个答案；候选之外的名字两边都不认
        const gotB = [];
        for (const rel of [...STATUS_CANDIDATES, 'PROJECT_STATUS.md']) {
            withTmp((tmp) => {
                repo(tmp, { 'AGENTS.md': '# 入口\n', [rel]: '# 状态\n\n- WI-0001 在做。\n', 'docs/state/work/WI-0001-a.md': '# WI-0001\n' });
                const cfg = { _root: tmp, tier: 'L0', layout: { entry: ['AGENTS.md'], docs_root: 'docs' } };
                const lay = by('layout').run(cfg).some((f) => f.status === PASS && f.where === rel);
                const dri = by('drift').run(cfg).some((f) => f.id === 'drift/work-item' && f.where === rel);
                gotB.push([rel, lay, dri]);
            });
        }
        const wantB = gotB.map(([r]) => [r, STATUS_CANDIDATES.includes(r), STATUS_CANDIDATES.includes(r)]);
        out.push(probe('shared-fact', J(gotB) === J(wantB), '状态工件候选：layout 与 drift 认同一份（stdlib.STATUS_CANDIDATES）', { why: '01 §1 G2：同一事实一处权威；两份候选让同一个项目被说成既有又没有状态工件', evidence: `实得 (路径, layout 命中, drift 命中) ${J(gotB)}；应得 ${J(wantB)}` }));
        // C：未配 layout.docs_root：四个检查器按同一个缺省读，不再有的兜底、有的记「未配置文档根目录」
        withTmp((tmp) => {
            repo(tmp, { 'AGENTS.md': '# 入口\n', 'docs/architecture/a.md': '# 架构\n' });
            const cfg = { _root: tmp, tier: 'L1', layout: { entry: ['AGENTS.md'] } };
            const fs = need.flatMap((n) => by(n).run(cfg));
            const unset = fs.filter((f) => f.title.includes('未配置文档根目录')).map((f) => f.id);
            const judged = fs.filter((f) => f.id === 'freshness/undated-by-convention' && f.evidence.includes('docs/architecture/a.md') && f.evidence.includes('未配 layout.docs_root')).map((f) => f.id);
            out.push(probe('shared-fact', unset.length === 0 && judged.length === 1, '未配 layout.docs_root：各检查器取同一个缺省 docs 并注明，不再一家兜底一家记未定', { why: '契约 §5：缺省只有一处（stdlib.docs_root_of），取了默认就在证据里写明', evidence: `记未配置的 ${J(unset)}；freshness 按缺省判出的 ${J(judged)}` }));
        });
        // D：未配 layout.entry：layout 与 entry-budget 认同一个入口，候选超预算记未定，入口缺失只报一次
        const gotD = {};
        const other = ['status', 'handoff', 'work_item', 'module'].map((r) => `entry-budget/budget-undeclared/${r}_lines`);
        withTmp((tmp) => {
            repo(tmp, { 'AGENTS.md': 'x\n'.repeat(20), 'CLAUDE.md': '@AGENTS.md\n' });
            const cfg = { _root: tmp, tier: 'L0', budgets: { entry_lines: 10 } };
            gotD.layout = by('layout').run(cfg).filter((f) => f.status === PASS && f.title.startsWith('入口 ')).map((f) => f.where).sort();
            gotD.guessed = by('entry-budget').run(cfg).filter((f) => !other.includes(f.id)).map((f) => [f.id, f.status]);
            cfg.layout = { entry: ['AGENTS.md'] };
            gotD.declared = by('entry-budget').run(cfg).filter((f) => !other.includes(f.id)).map((f) => f.status);
        });
        withTmp((tmp) => {
            repo(tmp, { 'README.md': '# 说明\n' });
            const cfg = { _root: tmp, tier: 'L0' };
            let fs = [...by('layout').run(cfg), ...by('entry-budget').run(cfg)];
            gotD.absent = fs.filter((f) => f.title.includes('入口')).map((f) => [f.id, f.status]).sort((a, b) => (J(a) < J(b) ? -1 : 1));
            cfg.layout = { entry: ['GONE.md'] }; // 声明了、文件不在：同样只由 layout 报
            fs = [...by('layout').run(cfg), ...by('entry-budget').run(cfg)];
            gotD.declared_absent = fs.filter((f) => f.title.includes('入口')).map((f) => [f.check, f.status, f.where]).sort((a, b) => (J(a) < J(b) ? -1 : 1));
        });
        const wantD = {
            layout: ['AGENTS.md'], guessed: [['entry-budget/candidate-over/AGENTS.md', UNDETERMINED]], declared: [FAIL],
            declared_absent: [['entry-budget', SKIP, 'GONE.md'], ['layout', FAIL, 'GONE.md']],
            absent: [['entry-budget/entry-absent', SKIP], [findingId('layout', '★ 入口 类工件没找到（entry）'), UNDETERMINED]].sort((a, b) => (J(a) < J(b) ? -1 : 1)),
        };
        out.push(probe('shared-fact', sameJson(gotD, wantD), '未配 layout.entry：layout 与 entry-budget 认同一个入口，候选超预算记未定，入口缺失只报一次', { why: '01 §1 G2：同一配置一种读法（stdlib.entry_files）；契约 §1.1 候选只出通过或未定；契约 §1 同一事实只报一次', evidence: `实得 ${J(gotD)}；应得 ${J(wantD)}` }));
        // E：工作项状态按一份映射归到 01 §4.1 六态（D-127）。认不出的记未定且只报一次；别名、开头词后跟日期、项目声明的词都按所属态判
        const judge = (files, extra = {}) => withTmp((tmp) => {
            repo(tmp, Object.fromEntries(files.map(([k, v]) => [`work/WI-${String(k).padStart(2, '0')}-x.md`, v.startsWith('# ') ? v : `# WI\n\n状态：${v}\n`])));
            const { layout: extraLayout, ...rest } = extra;
            const cfg = { _root: tmp, tier: 'L1', layout: { docs_root: 'docs', work_root: 'work', ...(extraLayout ?? {}) }, ...rest };
            const res = {};
            for (const n of ['freshness', 'evidence']) {
                for (const f of by(n).run(cfg)) {
                    const w = (f.where ?? '').split(':')[0];
                    if (w.startsWith('work/WI-')) {
                        const s = res[n] ?? new Set();
                        s.add(Number(w.slice(8, 10)));
                        res[n] = s;
                    }
                    else if (f.id.includes('unknown') || (n === 'evidence' && f.status === UNDETERMINED)) {
                        res[f.id] = [f.status, [...f.evidence.matchAll(/work\/WI-\d\d/g)].map((m) => Number(m[0].slice(8, 10))).sort((a, b) => a - b)];
                    }
                }
            }
            for (const k of Object.keys(res))
                if (res[k] instanceof Set)
                    res[k] = [...res[k]].sort((a, b) => a - b);
            return res;
        });
        const enumerate = (xs) => xs.map((v, i) => [i, v]);
        const tmpl = readFileSync(resolve(HERE, '..', 'templates', 'WORK_ITEM.md'), 'utf8');
        const gotE = {
            default: judge(enumerate(['DEFINED', 'IMPLEMENTING', 'planned', 'blocked', 'in_validation', 'cancelled', '**已完成**', 'done 2026-02-20', 'In Progress（阶段二）', 'in progress'])),
            declared: judge(enumerate(['done', 'closed', 'in_progress', 'doing']), { work_item_done_states: ['closed'], work_item_in_progress_states: 'doing' }),
            single: judge([[0, 'DEFINED']]),
            // 模板原样复制、状态没选：状态行是括注，截掉后为空，须记未定而不是认成 planned（R2-1）
            template: judge([[0, tmpl]]),
            tailored: judge([[0, 'DEFINED']], { tailoring: [{ check: 'freshness', applicable: false, reason: 'x' }] }),
            frozen: judge([[0, 'DEFINED'], [1, 'DEFINED']], { layout: { frozen: ['work/WI-00-x.md'] } }),
        };
        const wantE = {
            default: { freshness: [8, 9], evidence: [6, 7], 'freshness/unknown-state': [UNDETERMINED, [0, 1]], 'evidence/unknown-state-by-freshness': [SKIP, [0, 1]] },
            declared: { freshness: [2, 3], evidence: [0, 1] },
            single: { 'freshness/unknown-state': [UNDETERMINED, [0]], 'evidence/unknown-state-by-freshness': [SKIP, [0]] },
            template: { 'freshness/unknown-state': [UNDETERMINED, [0]], 'evidence/unknown-state-by-freshness': [SKIP, [0]] },
            tailored: { 'evidence/unknown-state': [UNDETERMINED, [0]] },
            frozen: { 'freshness/unknown-state': [UNDETERMINED, [1]], 'evidence/unknown-state-by-freshness': [SKIP, [1]], 'evidence/unknown-state': [UNDETERMINED, [0]] },
        };
        out.push(probe('shared-fact', sameJson(gotE, wantE), '工作项状态一份映射：别名与声明词按所属态判，认不出的记未定且只报一次', { why: '01 §1 G2：进行中/完成的认法一处权威；契约 §1.1：约定落空只记未定，不当\'非进行中/非完成\'静默放过；契约 §1：同一事实只报一次', evidence: `实得 ${J(gotE)}；应得 ${J(wantE)}` }));
        // F：文档状态与工作项状态分流（D-134，statusKind 一处）。声明工件写 01 §3.5 的 superseded 记 document-state，不再记 unknown-state；
        //    声明工件写六态的（L1 的 current.md 兼作工作项）照按工作项判，两表都认不出记 unknown-doc-state；B-* 工作项照按六态巡检、查完成证据；
        //    目录内未声明的写文档四值仍记 unknown-state；YAML 头只有日期、状态在一级标题下的照读（超期进行中 FAIL），layout 与之同一处头部划界；二级标题下的状态字样不读
        const old = '---\nupdated_at: 2026-09-01\n---\n\n# 交接\n\n> 下次改回 `status: active`。\n';
        const gotF = [];
        let acc = '';
        withTmp((tmp) => {
            repo(tmp, {
                'work/handoff.md': '---\nstatus: superseded\nupdated_at: 2026-09-01\n---\n\n# 交接\n',
                'work/current.md': '# 当前\n\n状态：wibble\n',
                'work/B-1-a.md': '# B\n\nstatus: in_progress\n\n## 状态转换记录\n\n- a → b | 2020-01-01\n',
                'work/B-2-b.md': '# B\n\nstatus: done\n',
                'work/B-3-c.md': '# B\n\nstatus: retired\n',
                'work/B-4-d.md': '# B\n\nstatus: wibble\n',
                'work/B-5-e.md': old, 'work/WI-001-f.md': '# WI\n\nstatus: retired\n',
                'docs/r.md': '# r\n', 'work/now.md': '# 现状\n\nstatus: planned\n',
                'work/B-6-g.md': '---\nupdated_at: 2026-09-01\n---\n\n# B\n\n状态：进行中\n\n## 状态转换记录\n\n- a → b | 2020-01-01\n',
                'docs/s.md': '# s\n\nupdated_at: 2026-09-01\n\n## 记录\n\nstatus: active\n',
                'ACC.md': '# 验收\n\nupdated_at: 2026-09-01\n\n## 条目\n\nstatus: active\n',
            });
            const cfg = { _root: tmp, tier: 'L1', metadata_required: ['work/B-5-e.md', 'docs/s.md'], layout: { work_root: 'work', artifacts: { handoff: 'work/handoff.md', work_current: './work/current.md', status: 'work/now.md', acceptance: 'ACC.md' } } };
            for (const n of ['freshness', 'evidence']) {
                for (const f of by(n).run(cfg)) {
                    const hay = `${f.where ?? ''} ${f.evidence}`;
                    if (!hay.includes('work/'))
                        continue;
                    const key = /^[a-z-]+\/[0-9a-f]{8}$/.test(f.id) ? f.check : f.id;
                    gotF.push([key, f.status, [...new Set([...hay.matchAll(/work\/[\w-]+\.md/g)].map((m) => m[0]))].sort().join(' ')]);
                }
            }
            for (const f of by('freshness').run(cfg))
                if (f.id === 'freshness/no-status-field')
                    gotF.push([f.id, f.status, f.evidence.split('；')[0]]);
            for (const f of by('layout').run(cfg))
                if (f.where === 'ACC.md:1')
                    gotF.push([f.id, f.status, 'ACC.md']);
            acc = tmp;
        });
        void acc;
        const wantF = [
            ['evidence/no-evidence-section/work/B-2-b.md', UNDETERMINED, 'work/B-2-b.md'],
            ['evidence/not-done', SKIP, 'work/B-1-a.md work/B-6-g.md work/now.md'],
            ['freshness/document-state', SKIP, 'work/handoff.md'],
            ['freshness/unknown-doc-state', UNDETERMINED, 'work/current.md'],
            ['freshness/unknown-state', UNDETERMINED, 'work/B-3-c.md work/B-4-d.md work/B-5-e.md work/WI-001-f.md'],
            ['freshness', PASS, 'work/B-5-e.md'],
            ['freshness/work-item-stale/work/B-1-a.md', FAIL, 'work/B-1-a.md'],
            ['freshness/work-item-stale/work/B-6-g.md', FAIL, 'work/B-6-g.md'],
            ['layout/meta-unrecognized/ACC.md', UNDETERMINED, 'ACC.md'],
            ['freshness/no-status-field', UNDETERMINED, 'docs/s.md'],
            ['evidence/unknown-state-by-freshness', SKIP, 'work/B-3-c.md work/B-4-d.md work/B-5-e.md work/WI-001-f.md'],
            ['freshness/not-in-progress', SKIP, 'work/B-2-b.md work/now.md'],
        ];
        const srt = (a) => a.map((x) => J(x)).sort();
        const dkind = (cfg, rel, st) => statusKind(cfg, rel, st);
        const decl = { layout: { work_root: 'work', artifacts: { handoff: 'work/h.md', status: 'work/WI-009-s.md' } } };
        const unit = [dkind(decl, 'work/h.md', 'retired'), dkind(decl, 'work/h.md', 'wibble'), dkind(decl, 'work/x.md', 'retired'), dkind(decl, 'work/WI-009-s.md', 'retired'),
            itemStatus('---\nupdated_at: x\n---\n\n# t\n\n## 记录\n\nstatus: active\n'), itemStatus('# t\n\n状态：done\n\n## 记录\n\nstatus: active\n'),
            itemStatus('---\nstatus: superseded\n---\n\n# t\n\n状态：进行中\n'), itemStatus('---\nstate: done\n---\n\n# t\n\n> 旧稿 status: in_progress\n'),
            itemStatus('# t\n\n## 记录\n\nstatus: active\n'),
            [...new Set(WORK_ITEM_STATES.flatMap(([, al]) => al).filter((a) => DOC_STATES.some(([, al2]) => al2.includes(a))))]];
        const wantUnit = [['document', 'retired'], ['document', null], ['work_item', null], ['work_item', null], null, 'done', 'superseded', 'done', null, []];
        out.push(probe('shared-fact', J(srt(gotF)) === J(srt(wantF)) && J(unit) === J(wantUnit), '文档状态与工作项状态分流：声明工件写文档四值不当工作项，B-* 工作项照判，二级标题下的状态字样不读', { why: '01 §3.5 文档状态与 01 §4.1 工作项六态是两套词表（D-134）；契约 §1.1：认不出记未定', evidence: `实得 ${J(srt(gotF))} / ${J(unit)}；应得 ${J(srt(wantF))} / ${J(wantUnit)}` }));
    }
    catch (exc) {
        out.push(undeterminedFromException('shared-fact', exc, '跑跨检查器自检'));
    }
    return out;
}
// --------------------------------------------------------------------------
// 入口冒烟：check_all 自己能不能跑一遍
// --------------------------------------------------------------------------
/**
 * 契约 §3 的自检只覆盖各检查器，**不覆盖入口**。这条来自一次真实翻车：`run_all` 改成返回 `(findings, cfg)` 之后 `main` 仍按列表接收，`check_all .` 直接崩——
 * 而当时每个检查器的自检都是绿的，`--selftest` 退出码 0。所以这里不是再验一遍检查器，而是造一个临时项目 + 一份放在项目之外的配置，
 * 真正走一遍 runAll → render → main（含参数解析与三态退出码），断言不抛异常、返回形状对、三态计数拿得到。
 */
export function entrySmokeSelftest() {
    const out = [];
    const fail = (msg) => { throw new Error(msg); };
    try {
        withTmp((tmp) => {
            const proj = join(tmp, 'proj');
            mkdirSync(proj, { recursive: true });
            writeText(join(proj, 'AGENTS.md'), SMOKE_ENTRY);
            const cfgPath = join(tmp, 'outside', 'project.yaml');
            writeText(cfgPath, SMOKE_CONFIG);
            gitTrack(proj);
            // 1) runAll 的返回形状：必须是 [findings, cfg]
            const [findings, cfg] = runAll(proj, { configPath: cfgPath });
            if (!Array.isArray(findings) || !findings.length)
                fail(`runAll 的 findings 应是非空数组，实得 ${J(findings)}`);
            for (const f of findings)
                if (![PASS, FAIL, UNDETERMINED, SKIP].includes(f.status))
                    fail(`findings 里有非法条目：${J(f)}`);
            if (cfg === null || cfg._root !== proj)
                fail(`外部配置下 cfg[_root] 应仍是被扫描项目，实得 ${J(cfg)}`);
            // 2) 三态计数可得
            const counts = Object.fromEntries([PASS, FAIL, UNDETERMINED, SKIP].map((s) => [s, findings.filter((f) => f.status === s).length]));
            if (Object.values(counts).reduce((a, b) => a + b, 0) !== findings.length)
                fail(`三态计数与条数对不上：${J(counts)}`);
            // 3) render 真跑一遍，含覆盖边界
            const text = render(findings, proj, cfg, true);
            if (!text.includes('覆盖边界'))
                fail('render 没有产出带覆盖边界的文本');
            if (!text.includes('外部配置'))
                fail('--config 下 render 应标注外部配置');
            // 3b) 契约 §8：身份块要出现在文本输出头部
            if (!text.includes('检查器身份') || !text.includes('sha256:'))
                fail('文本输出头部没有检查器身份块');
            // 3c) --config 指向**项目内部**时，不许标「外部配置」
            const insideCfg = join(proj, 'inside-project.yaml');
            writeText(insideCfg, SMOKE_CONFIG);
            const [f2, c2] = runAll(proj, { configPath: insideCfg });
            const t2 = render(f2, proj, c2, false);
            if (t2.includes('外部配置'))
                fail(`--config 指向项目内部时不应标注外部配置：${J(t2.split('\n').slice(0, 4))}`);
            if (!t2.includes('（在被扫描项目内）'))
                fail('--config 指向项目内部时应如实标注在项目内');
            // 3d) 前缀比较必须带分隔符：断言的是**取值**——proj 不许把 project 吞成内部。用本平台的真实路径形态
            const base = join(tmp, 'zz'), sibling = join(tmp, 'zzz', 'x.yaml'), under = join(tmp, 'zz', 'x.yaml');
            if (configOutsideRoot(base, sibling)[0] !== true)
                fail('zz 不该把 zzz/x.yaml 吞成内部');
            if (configOutsideRoot(base, under)[0] !== false)
                fail('zz 下的 zz/x.yaml 应判为项目内');
            // 3e) 默认配置的 `_path` 是相对被扫根的，判在不在项目内时不得按当前工作目录解析
            const dfltCfg = join(proj, 'governance', 'project.yaml');
            writeText(dfltCfg, SMOKE_CONFIG);
            const cwdBefore = process.cwd();
            process.chdir(tmp); // 换个目录跑，才验得出
            try {
                if (process.cwd() === proj)
                    fail(`这一节要在工作目录 ≠ 被扫根时验，实得两者都是 ${proj}`);
                const [f3, c3] = runAll(proj);
                const t3 = render(f3, proj, c3, false);
                if (t3.includes('外部配置'))
                    fail(`项目内的默认配置不该被说成外部配置：${J(t3.split('\n').slice(0, 4))}`);
                if (!t3.includes('（在被扫描项目内）'))
                    fail(`项目内的默认配置应如实标注在被扫描项目内：${J(t3.split('\n').slice(0, 4))}`);
            }
            finally {
                process.chdir(cwdBefore);
            }
            // 3f) 契约 §8：身份对行尾归一化——同内容的 LF / CRLF / 裸 CR 副本身份相等，改一个字节则不等
            const eol = {};
            for (const [name, data] of [['lf', 'a\nb\n'], ['crlf', 'a\r\nb\r\n'], ['cr', 'a\rb\n'], ['mut', 'a\nb!\n']]) {
                const p = join(tmp, 'eol-' + name);
                writeFileSync(p, Buffer.from(data, 'latin1'));
                eol[name] = sha256File(p);
            }
            if (eol.lf !== eol.crlf)
                fail(`契约 §8：同内容的 LF/CRLF 副本身份应相等，实得 ${eol.lf.slice(0, 16)} / ${eol.crlf.slice(0, 16)}`); // py-semantics-ok: 十六进制摘要，纯 ASCII
            if (eol.lf !== eol.cr)
                fail(`契约 §8：裸 CR 也应归一，实得 ${eol.lf.slice(0, 16)} / ${eol.cr.slice(0, 16)}`); // py-semantics-ok: 同上
            if (eol.lf === eol.mut)
                fail('契约 §8：内容不同的文件身份不应相等');
            // 3g) 契约 §9 例外登记。五条断言**打在结果上，不打在退出码上**——退出码只有三个取值，靠它分不清「登记生效了」与「这次恰好没别的未定」
            const und = findings.filter((f) => f.status === UNDETERMINED);
            if (!und.length)
                fail('冒烟仓没有未定项，登记这一支无从自检');
            const target = und[0].id;
            const exPath = join(dirname(cfgPath), 'exceptions.md');
            const today = todayLocal();
            const okDay = toIso(addDays(today, 30)), yesterday = toIso(addDays(today, -1));
            const reg = (rule, expires, extra = '', more = []) => {
                writeFileSync(exPath, `# 例外登记\n\n| id | 规则 | 理由 | 范围 | 批准人 | 到期 | 状态 |\n|---|---|---|---|---|---|---|\n| EX-001 | ${rule} | 入口冒烟自检用 | 该项 | 自检 | ${expires} | active |\n${extra}`, 'utf8');
                // 登记只在检查器跑完之后 join（契约 §9），检查器结论不随登记册变：复用第一遍的结论只重做 join，不再把全部检查器重跑六遍（R1-12）
                const fs = [...findings, ...more].map((f) => ({ ...f, registered: null }));
                const c = { ...cfg };
                joinExceptions(fs, c);
                const hit = fs.filter((f) => f.id === target);
                if (!hit.length)
                    fail(`登记自检：目标未定项 ${target} 消失了`);
                return [fs, hit[0], c];
            };
            const has = (fs, kind) => fs.some((f) => f.id.startsWith('exception-register/' + kind));
            const regLine = (fs, c) => {
                for (const ln of render(fs, proj, c, false).split('\n'))
                    if (ln.startsWith('登记 · '))
                        return ln;
                return fail('首部没有「登记 · 」行');
            };
            let [fs, hit, cEx] = reg(target, okDay);
            if (hit.registered?.id !== 'EX-001')
                fail(`① 有效登记应标已登记 EX-001，实得 ${J(hit.registered)}`);
            if (cEx._exceptions.expired !== 0)
                fail(`① 没有过期行时 _exceptions[expired] 应是 0，实得 ${J(cEx._exceptions.expired)}`);
            let line = regLine(fs, cEx);
            if (!line.includes('1 行有效）') || line.includes('已过期'))
                fail(`① 没有过期行时首部应逐字是「（1 行有效）」，实得 ${J(line)}`);
            [fs, hit, cEx] = reg(target, yesterday);
            if (hit.registered !== null)
                fail(`② 到期在昨天的登记不得生效，实得 ${J(hit.registered)}`);
            if (!has(fs, 'expired'))
                fail('② 过期登记应多一条 exception-register/expired');
            if (cEx._exceptions.expired !== 1)
                fail(`② 有 1 行过期时 _exceptions[expired] 应是 1，实得 ${J(cEx._exceptions.expired)}`);
            line = regLine(fs, cEx);
            if (!line.includes('1 行有效，其中 1 行已过期'))
                fail(`② 过期行要标在首部，否则「N 行有效」与计数行的已登记数对不上，实得 ${J(line)}`);
            [fs] = reg(target, okDay, `| EX-002 | freshness/stale/没有这份文件.md | 缺范围与批准人 |  |  | ${okDay} | active |\n`);
            if (!has(fs, 'invalid-rows'))
                fail('③ 写坏一行应多一条 exception-register/invalid-rows');
            [fs, hit] = reg('freshness/stale/根本不存在的判据.md', okDay);
            if (hit.registered !== null)
                fail('④ rule 指向不存在的 id 时，原发现应仍是未登记');
            if (has(fs, 'expired'))
                fail('④ 没过期的孤儿行不得报 expired');
            if (!has(fs, 'orphan'))
                fail('④ rule 匹配不到任何 id 应多一条 exception-register/orphan');
            const skips = findings.filter((f) => f.status === SKIP && !f.id.startsWith('tool-identity/') && !f.id.startsWith('exception-register/')).map((f) => f.id);
            if (!skips.length)
                fail('冒烟仓没有 SKIP 发现，⑤ 无从自检');
            [fs] = reg(skips[0], okDay);
            if (!has(fs, 'orphan'))
                fail('⑤ rule 匹配到 SKIP（不是未定）也应报 exception-register/orphan，否则死行会在日后该条转回未定时静默复活');
            [fs, hit] = reg(target, okDay, [
                `| EX-003 | G9 依赖规则 | 过期 | 全仓 | 自检 | ${yesterday} | active |\n`,
                `| EX-004 | G6 依赖审计 | 未到期 | 全仓 | 自检 | ${okDay} | active |\n`,
                '| EX-005 | G11 文档新鲜度 | 无到期 | 全仓 | 自检 |  | active |\n',
                `| EX-006 | G7 | 已关闭 | 全仓 | 自检 | ${yesterday} | 已处理 |\n`,
                `| EX-007 | G8 | 待关闭不是关闭 | 全仓 | 自检 | ${yesterday} | 待关闭 |\n`,
                `| EX-00A | G12 | 太远 | 全仓 | 自检 | ${toIso(addDays(today, 366))} | active |\n`,
                `| EX-00B | G13 | 恰一年 | 全仓 | 自检 | ${toIso(addDays(today, 365))} | active |\n`,
            ].join(''));
            const own = fs.filter((f) => f.id.startsWith(EXCEPTION_CHECK + '/')).map((f) => [f.status, f.id]).sort((a, b) => (J(a) < J(b) ? -1 : 1));
            const wantOwn = [[FAIL, 'exception-register/own-expired/EX-003'], [FAIL, 'exception-register/own-expired/EX-007'], [UNDETERMINED, 'exception-register/own-too-far'], [UNDETERMINED, 'exception-register/own-undated']].sort((a, b) => (J(a) < J(b) ? -1 : 1));
            if (J(own) !== J(wantOwn))
                fail(`⑥ 项目自有例外应只得 own-expired/EX-003、EX-007（状态「待关闭」不是关闭）FAIL、own-too-far（+366 天，+365 天不报）与 own-undated，实得 ${J(own)}`);
            if (hit.registered?.id !== 'EX-001')
                fail('⑥ 项目自有例外行不得影响 Finding id 行的登记');
            // ⑦ 检查器自身出错（崩溃、自检闸门不过）的未定不可登记：登记即退出 0 等于登记了被崩溃顶掉的 FAIL；该行记不合格，那条未定仍是未登记（契约 §9）
            const crash = undeterminedFromException('layout', new TypeError('x'), '跑 layout');
            [fs] = reg(target, okDay, `| EX-008 | ${crash.id} | 崩溃 | 全仓 | 自检 | ${okDay} | active |\n`, [crash]);
            let got = fs.filter((f) => f.id === crash.id).map((f) => f.registered);
            if (crash.id !== 'layout/internal-error' || J(got) !== J([null]) || !has(fs, 'invalid-rows'))
                fail(`⑦ 崩溃未定 ${crash.id} 登记后应仍未登记并报 invalid-rows，实得 ${J(got)}`);
            //    对照：读不了的文件（unreadable/<路径>）是对象的事，登记照常生效（R126-1）
            const unr = unreadable('evidence', 'work/WI-9.md', new Error('x'));
            [fs] = reg(target, okDay, `| EX-009 | ${unr.id} | 读不了 | 该文件 | 自检 | ${okDay} | active |\n`, [unr]);
            const got2 = fs.filter((f) => f.id === unr.id).map((f) => f.registered?.id);
            if (J(got2) !== J(['EX-009']) || has(fs, 'invalid-rows'))
                fail(`⑦ unreadable 未定登记应生效，实得 ${J(got2)}`);
            [fs, hit] = reg(target, toIso(addDays(today, 365)));
            if (hit.registered?.id !== 'EX-001' || has(fs, 'invalid-rows'))
                fail(`⑧ 到期恰为今天 + 365 天应生效，实得 ${J(hit.registered)}`);
            [fs, hit] = reg(target, toIso(addDays(today, 366)));
            if (hit.registered !== null || !has(fs, 'invalid-rows'))
                fail(`⑧ 到期晚于今天 + 365 天应不生效并报 invalid-rows，实得 ${J(hit.registered)}`);
            rmSync(exPath, { force: true });
            // 4) main 整条走一遍（参数解析 + 输出 + 退出码），不允许抛异常
            for (const argv of [[proj, '--config', cfgPath, '--no-scope'], [proj, '--config', cfgPath, '--json']]) {
                const sink = [];
                const code = main(argv, undefined, { out: (t) => sink.push(t), err: (t) => sink.push(t) });
                if (![0, 1, 2].includes(code))
                    fail(`main(${J(argv)}) 退出码 ${code} 不在 {0,1,2}`);
                if (!sink.join('\n').trim())
                    fail(`main(${J(argv)}) 什么都没输出`);
                if (argv.includes('--json')) {
                    const data = JSON.parse(sink.join('\n'));
                    const ids = data.filter((f) => f.check === IDENTITY_CHECK);
                    if (ids.length !== 1 || !(ids[0].evidence ?? '').includes('tool_identity_digest'))
                        fail('--json 里没有检查器身份字段');
                }
            }
        });
    }
    catch (exc) {
        out.push(finding('entry-smoke', FAIL, '入口冒烟自检没跑通：check_all 自己就跑不起来', {
            where: 'lib/cli.js', why: '契约 §3 只管各检查器的反例；入口崩了的话所有检查器的绿都没有意义',
            evidence: `${exc.name}: ${exc.message}`,
        }));
        return out;
    }
    out.push(finding('entry-smoke', PASS, '入口冒烟：run_all / render / main 在临时仓 + 外部配置下跑通', {
        where: 'lib/cli.js', why: '契约 §3：守卫存在不等于守卫在执行——入口本身也要有反例',
        evidence: 'run_all 返回二元组、findings 三态合法、render 出覆盖边界与外部配置标注、文本与 --json 都带检查器身份块、--config 指向项目内部时不标外部配置、工作目录 ≠ 被扫根时项目内的默认配置仍标『在被扫描项目内』、例外登记五条、main 两种 argv 退出码合法且有输出',
    }));
    return out;
}
