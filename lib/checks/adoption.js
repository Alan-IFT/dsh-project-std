// 采用记录：项目级声明 `compatibility.policy`（01 §5.3 必填）。
// 对应 tools/std/checks/check_adoption.py；契约见 tools/std/CONTRACT.md。
//
// 与 Python 版的有意差异（设计 §12.28 与 §12.33，D-135 废弃技术栈，逐条经用户决定）：不迁移——
//   · 内嵌 `.std/` 机制：版本值与内嵌 README 修订号比对、内嵌目录只读（git status）、及其三个 finding id（embedded-*、version-mismatch）；采用项目不再内嵌 `.std/`；
//   · 免审批清单（读 Claude Code 的 `.claude/settings.json`）：`_settings_allow`、`_wildcard_allow` 及它们的 5 个 finding id、自检；该宿主已废弃，DSH 的审批策略是会话级旋钮，没有项目级入库清单可读；
//   · **版本记录（`governance/STANDARD_VERSION`）**：01 §8 第一条要的是「采用的标准版本可追溯」，载体由项目里一份人维护、机器不核对的文件，换成包管理器的锁文件（profile 的 package.json + pnpm-lock.yaml）加报告自带的工具身份摘要
//     （`tool-identity`，覆盖 lib/ 与契约），**零人工**。原来的两条 PASS（记了版本值、记了采用日期）与两条未定/FAIL 的分支（缺文件、读不出版本值、没有采用日期）随判据对象一起消失；
//     解析函数 `parse`／`rawHead` 与两张键名表一并删除。依据见设计 §12.33；黄金样本里 `adoption/8714bd62`、`adoption/8baf1c92` 登记为预期消失，见 test/cases/expected-changes.mjs 的 ADOPTION。
//   · 因此本检查器现在只剩 compatibility.policy 一个判据。名字仍叫 adoption：id 前缀 `adoption/` 是对外稳定承诺（CONTRACT §4），采用项目的 tailoring 与例外登记可能引用它。
//
// 迁移约束：与 Python 版逐 id 相同（黄金样本，上述预期消失的除外）。动笔前对每个 Python 字符串、正则、容器操作都问过「JS 里对应的在非 ASCII、非 BMP、边界值上等价吗」并在 Python 上实测（设计 §12.22）：
//   `"%s" % value`                    → `pyStr`（映射与嵌套容器按 repr，见 core/cfg 与 test/cases/pystr.mjs）
import { cfgGet, pyStr, pyTruthy } from '../core/cfg.js';
import { headChars, isTailoredOut } from '../core/docs.js';
import { FAIL, PASS, SKIP, finding } from '../core/finding.js';
import { probe } from '../core/shell.js';
export const NAME = 'adoption';
export const STANDARD_REFS = ['01 §8', '01 §4.7', '01 §3.1', '01 §5.3'];
export function scope(cfg) {
    void cfg;
    return {
        covered: [
            '配置里有没有非空的 compatibility.policy（01 §5.3 必填，不分档），没有判 FAIL',
            'tailoring 裁掉本检查时，compatibility.policy 不可裁剪、照判，其余记 SKIP',
        ],
        not_covered: [
            '不记录、也不核对「采用的是标准的哪一版」：版本由 profile 的锁文件钉住，报告首部的 tool-identity 摘要随每次检查自动带出（设计 §12.33）；本检查不读任何项目里的版本文件',
            '不与工具侧任何常量比对（check_all 的 _SMOKE_CONFIG、check_layout 的 _SNAPSHOT_DATE 都不比）；拿工具自己的常量当真相比，结论就是编的',
            '不判裁剪内容是否合理、是否完整——那是内容判断，契约 §7 说了不做',
            '不判裁剪登记齐不齐：裁剪的权威位置是 governance/project.yaml 的 tailoring（01 §3.2 职责卡的权威域逐字含『裁剪与派生登记』）；' +
                '规则本身还不存在，按契约 §4『why 追不到标准条款的检查项不进本工具』，本检查对该项不产出任何发现：调和该由上游做，不由每份报告里塞一条恒定未定代劳',
            'compatibility.policy 只判有没有，不判写得对不对、是否覆盖数据/接口/配置/旧客户端四项（契约 §7）',
        ],
    };
}
export function run(cfg) {
    // compatibility.policy 必填不可裁剪（D-126），照判；其余的随裁剪记 SKIP
    const [tailored, reason] = isTailoredOut(cfg, NAME);
    if (tailored)
        return [finding(NAME, SKIP, '项目已裁剪本检查（compatibility.policy 不可裁剪，照判）', { reason: reason || 'project.yaml 未写理由' }), compatibility(cfg)];
    // 注意：Python 版 run() 没有包 run_guarded（直接 `_version + [_compatibility]`），内部异常向上抛、由 check_all 的外层兜；这里保持一致，不加 runGuarded
    return [compatibility(cfg)];
}
/** 01 §5.3：`project.yaml` 的 `compatibility.policy` 必填。 */
export function compatibility(cfg) {
    const rawPath = cfg._path;
    const where = pyTruthy(rawPath) ? pyStr(rawPath) : 'governance/project.yaml';
    const why = '01 §5.3：`project.yaml` 的 `compatibility.policy` 必填——数据、接口、配置、旧版本客户端各支持到什么程度；未上线项目可选破坏性重构，但要记录前提';
    const val = cfgGet(cfg, 'compatibility.policy');
    // Python：`val is None or val is False or (isinstance(val, (str, list, dict)) and not val)`——0 与 0.0 不算缺（只有 None、False、空串、空列表、空映射算缺）
    const missing = val === undefined || val === null || val === false || ((typeof val === 'string' || typeof val === 'object') && !pyTruthy(val));
    if (missing) {
        return finding(NAME, FAIL, '配置里没有 compatibility.policy', {
            where, kind: 'compatibility-policy', why,
            reason: `在 ${where} 里加 \`compatibility:\` 下的 \`policy:\`，写明数据、接口、配置、旧版本客户端各支持到什么程度；未上线的写明“可破坏性重构”及其前提`,
        });
    }
    return finding(NAME, PASS, '配置里写了 compatibility.policy', { where, kind: 'compatibility-policy', why, evidence: `原样值：${pyStr(val)}（内容写得对不对不判，契约 §7）` });
}
// --------------------------------------------------------------------------
// 自检（契约 §3）
// --------------------------------------------------------------------------
const J = (v) => JSON.stringify(v);
export function selftest() {
    const results = [];
    // compatibility.policy（01 §5.3）：缺、空串、空映射、空列表、false 判 FAIL；有值（含映射）PASS。
    // 这条替换 Python 版 `adoption/d5d57eb2`——它把 compatibility.policy 与免审批清单的通配放行合在一条探针里，后一半随废弃宿主一起删，前一半在这里单独守护（test/cases/expected-changes.mjs 的 ADOPTION.added_probes）。
    const cfgs = [{}, { compatibility: {} }, { compatibility: { policy: '' } }, { compatibility: { policy: [] } }, { compatibility: { policy: false } }, { compatibility: { policy: 'x' } }, { compatibility: { policy: { data: '两个版本' } } }, { compatibility: { policy: 0 } }];
    const cs = cfgs.map((c) => compatibility(c).status);
    results.push(probe(NAME, J(cs) === J([FAIL, FAIL, FAIL, FAIL, FAIL, PASS, PASS, PASS]), 'compatibility.policy 缺、空串、空列表、false 判 FAIL；有值（字符串、映射、0）PASS', {
        evidence: `实得 ${J(cs)}`, why: '01 §5.3 compatibility.policy 必填；契约 §3',
    }));
    // 裁剪 adoption：本检查记 SKIP，但 compatibility.policy 不可裁剪、照判
    const tailored = { tailoring: [{ check: NAME, applicable: false, reason: '自检' }], compatibility: { policy: 'x' } };
    const ts = run(tailored).map((f) => f.status);
    results.push(probe(NAME, J(ts) === J([SKIP, PASS]), '裁剪 adoption：一条 SKIP，compatibility.policy 照判（不可裁剪）', {
        evidence: `实得 ${J(ts)}；headChars 预览：${headChars(J(ts), 20)}`, why: '01 §5.3 必填不分档；D-126 compatibility.policy 不可裁剪',
    }));
    return results;
}
