// 配置加载与校验（对应 tools/std/stdlib.py 的 load_config / _read_config / _bad_shape / _bad_dup_budgets / _bad_state_words /
// _bad_metadata_required / _escaping_paths / metadata_required_hit，契约 §4、§5）。
//
// 原则：**写错不猜**。形状不对、取值越界、撞词、路径越出项目，整份拒收，报键名与行号，**不回显文件内容**（配置可能是被扫方写的）；
// 拒收返回 `[{}, problem]`，调用方据此记未定，不得取默认值当事实（契约 §5）。
// 有意差异：D3、D4、D6（见设计 §12.6）。
import { cfgGet, DECLARED_STATES, DOC_STATES, stateList, WORK_ITEM_STATES, pyStr } from './cfg.js';
import { PY_WHITESPACE, pyStrip } from './finding.js';
import { inside, isFile, lexists, readBytes, isReadRefusal } from './fs.js';
import { pyRepr } from './repr.js';
import { firstInvalidUtf8 } from './utf8.js';
import { ConfigError, parseYamlSubset, splitLinesPy } from './yaml.js';
import { isAbsolute, join, resolve } from 'node:path';
export const CONFIG_CANDIDATES = ['governance/project.yaml', 'governance/project.yml'];
// 值是项目内路径的配置键。写 `..` 段或绝对路径就是让检查器去读项目之外的文件，拒收整份配置。
// `repos[].path` 不在此列：多仓系统的兄弟仓本来就在项目之外（01 §3.8），由 cross-repo 按仓读。
const PATH_KEYS = ['layout.entry', 'layout.docs_root', 'layout.work_root', 'layout.frozen', 'layout.rule_files', 'metadata_required'];
function escapingPaths(cfg) {
    const vals = [];
    for (const key of PATH_KEYS) {
        const v = cfgGet(cfg, key);
        for (const x of Array.isArray(v) ? v : [v])
            vals.push([key, x]);
    }
    const arts = cfgGet(cfg, 'layout.artifacts');
    if (arts && typeof arts === 'object' && !Array.isArray(arts))
        for (const [k, v] of Object.entries(arts))
            vals.push(['layout.artifacts.' + k, v]);
    const derived = cfgGet(cfg, 'derived');
    (Array.isArray(derived) ? derived : []).forEach((item, i) => {
        if (item && typeof item === 'object' && !Array.isArray(item))
            for (const k of ['artifact', 'source'])
                vals.push([`derived[${i}].${k}`, item[k]]);
    });
    const bad = [];
    for (const [key, v] of vals) {
        if (typeof v !== 'string' || !pyStrip(v))
            continue;
        const p = pyStrip(v).replaceAll('\\', '/');
        if (isPosixOrWinAbs(p) || /^[A-Za-z]:\//.test(p) || p.split('/').includes('..'))
            bad.push(key);
    }
    return bad;
}
/** Python 的 `os.path.isabs`：POSIX 上以 `/` 起头；Windows 上还含盘符与 UNC。本函数的输入已把 `\` 换成 `/`，所以 `//server/share` 与 `/x` 都以 `/` 起头。 */
function isPosixOrWinAbs(p) {
    return p.startsWith('/') || isAbsolute(p);
}
/** 值必须是整数的阈值键与下限。写错不许静默换成默认值（与「不许静默误读」同一条规则），整份配置拒收。 */
const DUP_BUDGETS = [['duplicate_min_lines', 2], ['duplicate_min_chars', 1]];
/** 键 key 首次出现的行号（报错定位用，不回显内容）；找不到给 0。 */
function keyLine(text, key) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Python：re.match(r"""\s*(?:-\s+)?["']?%s["']?\s*:""")，\s 是 Python 的空白集合（D6）
    const re = new RegExp(`^[${PY_WHITESPACE}]*(?:-[${PY_WHITESPACE}]+)?["']?${esc}["']?[${PY_WHITESPACE}]*:`);
    const lines = splitLinesPy(text);
    for (let i = 0; i < lines.length; i++)
        if (re.test(lines[i]))
            return i + 1;
    return 0;
}
function badDupBudgets(cfg, text, kinds) {
    const budgets = cfg.budgets;
    if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets))
        return null;
    for (const [key, low] of DUP_BUDGETS) {
        if (!Object.hasOwn(budgets, key))
            continue;
        const v = budgets[key];
        if (typeof v === 'number' && kinds.isInt(['budgets', key]) && v >= low)
            continue;
        return `第 ${keyLine(text, key)} 行 budgets.${key} 须是 ≥${low} 的整数；写错不取默认值`;
    }
    return null;
}
/** work_item_*_states 的声明词与 01 §4.1 六态别名、或两键之间撞词（归到不同态）即整份拒收（R127 R2-2）。 */
function badStateWords(cfg, text) {
    const seen = new Map();
    for (const [c, al] of WORK_ITEM_STATES)
        for (const a of al)
            seen.set(a, c);
    for (const [c, al] of DOC_STATES)
        for (const a of al)
            seen.set(a, '01 §3.5 文档状态 ' + c); // 撞文档状态词同样拒收（D-134）
    for (const [c, key] of DECLARED_STATES) {
        for (const w of stateList(cfg, key, [])) {
            if (!seen.has(w))
                seen.set(w, c);
            if (seen.get(w) !== c) {
                return `第 ${keyLine(text, key)} 行 ${key} 的「${w}」已归 ${seen.get(w)}，声明到 ${c} 有歧义；撞词不猜归哪一态`;
            }
        }
    }
    return null;
}
/**
 * 配置键的形状（契约 §5 类型表）。写成别的形状不许静默误读——frozen 写成字符串被逐字符迭代、
 * tailoring 写成映射静默不生效、layout.entry: 5 让两个检查器崩溃——整份拒收，报键名与行号。空值＝没写。
 */
const SHAPES = [
    ['tier', 'str'], ['layout.docs_root', 'str'], ['layout.work_root', 'str'],
    ['layout', 'map'], ['layout.artifacts', 'map'], ['budgets', 'map'],
    ['tailoring', 'maps'], ['derived', 'maps'], ['repos', 'maps'],
    ['layout.frozen', 'strs'], ['layout.rule_files', 'strs'], ['metadata_required', 'strs'],
    ['layout.entry', 'str|strs'], ['metadata_fields', 'str|strs'],
    ['work_item_done_states', 'str|strs'], ['work_item_in_progress_states', 'str|strs'],
];
const SHAPE_NAMES = { str: '字符串', map: '映射', maps: '映射组成的列表', strs: '字符串列表', 'str|strs': '字符串或字符串列表' };
/** 字符串、整数或浮点（不含布尔——YAML 的 true 是布尔，Python 里 bool 是 int 的子类，这里要显式排除）。 */
const isScalarStrNum = (x) => typeof x === 'string' || typeof x === 'number';
const isMap = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function shapeOk(v, shape) {
    if (v === null || v === undefined || (shape === 'str|strs' && typeof v === 'string'))
        return true;
    if (shape === 'str')
        return isScalarStrNum(v);
    if (shape === 'map')
        return isMap(v);
    return Array.isArray(v) && v.every((x) => (shape === 'maps' ? isMap(x) : isScalarStrNum(x)));
}
function badShape(cfg, text) {
    const items = SHAPES.map(([key, shape]) => [key, cfgGet(cfg, key), shape]);
    const lists = [
        ['repos', [['name', 'str'], ['path', 'str'], ['role', 'str'], ['former_names', 'strs']]],
        ['derived', [['artifact', 'str'], ['source', 'str'], ['regen', 'str']]],
        ['tailoring', [['check', 'str'], ['reason', 'str']]],
    ];
    for (const [lst, subs] of lists) {
        const rows = cfgGet(cfg, lst) // 写成非列表（如 `tailoring: 5`）由上面的顶层形状报，这里不迭代
        ;
        (Array.isArray(rows) ? rows : []).forEach((r, i) => {
            if (!isMap(r))
                return;
            for (const [k, shape] of subs)
                items.push([`${lst}[${i}].${k}`, r[k], shape]);
        });
    }
    const arts = cfgGet(cfg, 'layout.artifacts');
    if (isMap(arts))
        for (const [k, v] of Object.entries(arts))
            items.push(['layout.artifacts.' + k, v, k === 'entry' ? 'str|strs' : 'str']);
    for (const [key, v, shape] of items) {
        if (!shapeOk(v, shape)) {
            const last = key.slice(key.lastIndexOf('.') + 1);
            return `第 ${keyLine(text, last)} 行 ${key} 须是${SHAPE_NAMES[shape]}；写成别的形状不猜`;
        }
    }
    return null;
}
/** metadata_required 列表拆成（包含前缀, 排除前缀）；`!` 起头的是排除（D-133）。只做写法归一（`\` 改 `/`，开头的 `./` 去掉），不校验。 */
export function metadataPrefixes(v) {
    const inc = [], exc = [];
    for (const x of v) {
        let p = pyStrip(pyStr(x)).replaceAll('\\', '/');
        const neg = p.startsWith('!');
        if (neg)
            p = pyStrip(p.slice(1));
        while (p.startsWith('./') && p !== './')
            p = p.slice(2) // "./docs" 即 "docs"；单独的 "./" 留给校验拒收
            ;
        (neg ? exc : inc).push(p);
    }
    return [inc, exc];
}
function stripSlashes(s) {
    return s.replace(/^\/+|\/+$/g, '');
}
function prefixHit(rel, pre) {
    const p = stripSlashes(pre);
    return p !== '' && (rel === p || rel.startsWith(p + '/'));
}
/** rel 是否在项目声明的 metadata_required 之内；全仓只此一处判定（D-133）。未配（不是列表）返回 null。 */
export function metadataRequiredHit(cfg, rel) {
    const v = cfgGet(cfg, 'metadata_required');
    if (!Array.isArray(v))
        return null;
    const [inc, exc] = metadataPrefixes(v);
    const r = String(rel).replaceAll('\\', '/').split('/').filter((x) => x).join('/');
    return inc.some((p) => prefixHit(r, p)) && !exc.some((p) => prefixHit(r, p));
}
/**
 * metadata_required 写错整份拒收，报键名与行号，与 duplicate_* 写错同口径（D-131、D-133）。
 * 元素（`!` 排除前缀去掉 `!` 后同）写成空、`.`、`./`，或以 `/`、`..` 起头：没有一种无歧义的读法。
 * 排除前缀不落在任何包含前缀之下、或与某条包含前缀相同（等于删掉那条包含），同样拒收。
 */
function badMetadataRequired(cfg, text) {
    const v = cfgGet(cfg, 'metadata_required');
    if (!Array.isArray(v))
        return null;
    const line = keyLine(text, 'metadata_required');
    const [inc, exc] = metadataPrefixes(v);
    for (const x of v) {
        const [i1, e1] = metadataPrefixes([x]);
        const p = [...i1, ...e1][0];
        if (p === '' || p === '.' || p === './' || p.startsWith('/') || p.startsWith('..')) {
            return `第 ${line} 行 metadata_required 的元素 ${pyRepr(pyStr(x))} 不是项目内的路径前缀（空、. 、./ 或以 / 、.. 起头，! 之后同）；不猜整仓还是不命中`;
        }
    }
    for (const e of exc) {
        // 只有排除、没有包含时每条排除都落在包含之外，同由这里拒收
        if (inc.map(stripSlashes).includes(stripSlashes(e))) {
            return `第 ${line} 行 metadata_required 的排除前缀 ${pyRepr('!' + e)} 与包含前缀相同，等于删掉那条包含；不猜`;
        }
        if (!inc.some((i) => prefixHit(stripSlashes(e), i))) {
            return `第 ${line} 行 metadata_required 的排除前缀 ${pyRepr('!' + e)} 不落在任何包含前缀之下；多半是笔误，不猜`;
        }
    }
    return null;
}
// 冒号两侧的空白用 Python 的空白集合（设计 §12.6 D6），不用 JS 的 `\s`
const BUDGETS_HEAD = new RegExp(`^["']?budgets["']?[${PY_WHITESPACE}]*:[${PY_WHITESPACE}]*$`);
const BUDGET_ENTRY = new RegExp(`^["']?([^"':]+?)["']?[${PY_WHITESPACE}]*:[${PY_WHITESPACE}]*(.*)$`);
function numKinds(text) {
    // 只需要 budgets.<key> 的字面：找 `budgets:` 之后缩进更深的 `key: value` 行
    const lines = splitLinesPy(text);
    const found = new Map();
    let inBudgets = false;
    let baseIndent = -1;
    for (const raw of lines) {
        const noComment = raw.split('#')[0];
        if (!pyStrip(noComment))
            continue;
        const indent = noComment.length - noComment.replace(/^ +/, '').length;
        const body = pyStrip(noComment);
        if (indent === 0) {
            inBudgets = BUDGETS_HEAD.test(body);
            baseIndent = -1;
            continue;
        }
        if (!inBudgets)
            continue;
        if (baseIndent < 0)
            baseIndent = indent;
        if (indent !== baseIndent)
            continue;
        const m = BUDGET_ENTRY.exec(body);
        if (m)
            found.set(pyStrip(m[1]), /^-?[0-9]+$/.test(pyStrip(m[2])));
    }
    return { isInt: (path) => path.length === 2 && path[0] === 'budgets' && (found.get(path[1]) ?? false) };
}
/** 读并解析一份配置。返回 [cfg, problem]；报错只给路径与行号，不回显文件内容。 */
export function validateConfigText(text, shown = '候选配置') {
    let cfg;
    try {
        cfg = parseYamlSubset(text);
    }
    catch (e) {
        if (e instanceof ConfigError)
            return [{}, `${shown} 无法无歧义解析：${e.message}`];
        throw e;
    }
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg))
        return [{}, `${shown} 的顶层不是映射`];
    const injected = Object.keys(cfg).filter((k) => k.startsWith('_')).sort();
    if (injected.length)
        return [{}, `${shown} 第 ${keyLine(text, injected[0])} 行的顶层键以 _ 开头；这类键只由代码注入，项目配置写了整份拒收`];
    const c = cfg;
    const badBudget = badShape(c, text) ?? badDupBudgets(c, text, numKinds(text)) ?? badStateWords(c, text) ?? badMetadataRequired(c, text);
    if (badBudget)
        return [{}, `${shown} 无法无歧义解析：${badBudget}`];
    const bad = escapingPaths(c);
    if (bad.length)
        return [{}, `${shown} 里 ${bad.join('、')} 的路径含 .. 段或是绝对路径，指向项目之外；本工具只读被扫项目之内的文件`];
    return [c, null];
}
function readConfig(p, shown) {
    try {
        const raw = readBytes(p);
        const bad = firstInvalidUtf8(raw);
        if (bad >= 0)
            return [{}, `${shown} 不是 UTF-8 编码（第 ${bad} 字节起解不开）；本工具只读 UTF-8`];
        const body = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
        const text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(body);
        return validateConfigText(text, shown);
    }
    catch (e) {
        if (isReadRefusal(e) || typeof e.code === 'string')
            return [{}, `${shown} 读不了：${errName(e)}`];
        throw e;
    }
}
/** 与 Python `type(exc).__name__` 同口径：文件不存在是 FileNotFoundError、权限是 PermissionError、本模块的拒读类按各自的名字。 */
function errName(e) {
    if (isReadRefusal(e))
        return e.name;
    const code = e.code;
    if (code === 'ENOENT')
        return 'FileNotFoundError';
    if (code === 'EACCES' || code === 'EPERM')
        return 'PermissionError';
    if (code === 'EISDIR')
        return 'IsADirectoryError';
    return 'OSError';
}
/**
 * 读配置。默认读 <root>/governance/project.yaml。
 * configPath 给了就读那个文件，可以在被扫描项目之外——这样才能在不往被测项目写任何东西的前提下扫只读项目。
 * 此时 cfg._root 仍是被扫描的 root，cfg._path 记配置文件的绝对路径。
 *
 * 返回 [cfg, problem]。problem 非 null 时 cfg 为 {}，调用方据此记未定，不得取默认值当事实（契约 §5）。
 */
export function loadConfig(root, configPath) {
    if (configPath !== undefined && configPath !== null) {
        const p = resolve(configPath);
        if (!isFile(p))
            return [{}, `指定的外部配置 ${p} 不存在（--config）；本工具不回退去猜项目布局`];
        const [cfg, problem] = readConfig(p, `指定的外部配置 ${p}`);
        if (problem)
            return [{}, problem];
        cfg._path = p;
        cfg._root = root;
        return [cfg, null];
    }
    for (const rel of CONFIG_CANDIDATES) {
        const p = join(root, rel);
        if (lexists(p)) { // lstat，不跟随：先判真实位置再探测目标
            if (!inside(root, p))
                return [{}, `${rel} 的真实位置在被扫项目之外（符号链接），未读`];
            if (!isFile(p))
                continue;
            const [cfg, problem] = readConfig(p, rel);
            if (problem)
                return [{}, problem];
            cfg._path = rel;
            cfg._root = root;
            return [cfg, null];
        }
    }
    return [{}, `未找到 ${CONFIG_CANDIDATES.join(' 或 ')}；本工具不猜项目布局`];
}
