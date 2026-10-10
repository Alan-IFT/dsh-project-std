// 三态 Finding 与 id（对应 tools/std/stdlib.py 的 finding / finding_id / normalize_key，契约 §1、§9）。
// 迁移约束：id 必须与 Python 版逐字相同——它被例外登记册抄进 markdown 表格，是跨版本稳定的公共标识。
import { createHash } from 'node:crypto';
export const PASS = 'PASS';
export const FAIL = 'FAIL';
export const UNDETERMINED = 'UNDETERMINED';
export const SKIP = 'SKIP';
export const STATUSES = [PASS, FAIL, UNDETERMINED, SKIP];
/**
 * Python 的 `\s`（`re` 的 Unicode 空白）与 `str.strip()` 认的空白集合，逐码点实测得出（设计 §12.6 D6）。
 * 与 JS 的差别：多 U+001C 到 U+001F、U+0085；少 U+FEFF。所以**不能用 `\s` 和 `trim()`**——BOM 开头的文本两版本会得出不同结果。
 */
export const PY_WHITESPACE = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_RUN = new RegExp(`[${PY_WHITESPACE}]+`, 'g');
const PY_WS_CHAR = new RegExp(`^[${PY_WHITESPACE}]$`);
/** 单个字符是不是 Python 认的空白（str.isspace() 对单字符的判定，设计 §12.6 D6）。strip 族与需要逐字符判空白的调用方共用这一处。 */
export const isPyWs = (ch) => PY_WS_CHAR.test(ch);
/**
 * 等价于 Python 的 `str.strip()`（不带参数）。
 *
 * **不用 `/^WS+|WS+$/` 一条正则**：`WS+$` 在「中间夹一大片空白、末尾不是空白」的串上，每个空白起点都吞完整片再发现不在末尾、回溯重试，是平方级——
 * 10 万个空格的一行要 11 秒，而 `pyStrip` 全仓有近百处调用，配置文件、文档头部都经它。两端各一次线性扫描，BMP 空白都是单个码元，按码元扫即可。
 */
export function pyStrip(s) {
    let a = 0, b = s.length;
    while (a < b && isPyWs(s[a]))
        a++;
    while (b > a && isPyWs(s[b - 1]))
        b--;
    return a === 0 && b === s.length ? s : s.slice(a, b); // py-semantics-ok: 按已扫出的码元下标切，空白集都在 BMP，不涉及码点计数
}
/** 等价于 Python 的 `str.lstrip()`（不带参数）：只去开头的 Python 空白。 */
export function pyLstrip(s) {
    let a = 0;
    while (a < s.length && isPyWs(s[a]))
        a++;
    return a === 0 ? s : s.slice(a); // py-semantics-ok: 同 pyStrip
}
/** 等价于 Python 的 `str.rstrip()`（不带参数）：只去末尾的 Python 空白，整行全空白得空串。线性，理由同 `pyStrip`。 */
export function pyRstrip(s) {
    let b = s.length;
    while (b > 0 && isPyWs(s[b - 1]))
        b--;
    return b === s.length ? s : s.slice(0, b); // py-semantics-ok: 同 pyStrip
}
/**
 * Finding id 里 key 段的归一化：去首尾空白、内部空白与换行折成 `_`、`|` 换成 `｜`。
 * `|` 要换掉是因为 id 会被人抄进 markdown 表格的「规则」列，裸竖线会把那一行拆成两格。
 */
export function normalizeKey(key) {
    return pyStrip(String(key)).replace(PY_WS_RUN, '_').replaceAll('|', '｜');
}
/**
 * Python 对含孤立代理字符的字符串用 `surrogateescape` 编码（非 UTF-8 文件名经 git ls-files 解码后带代理字符）。
 * JS 的字符串是 UTF-16，孤立代理单元用 Buffer.from(s, 'utf8') 会被替换成 U+FFFD，**得到不同的哈希**。
 * 这里按 Python 的 surrogateescape 规则手工编码：U+DC80..U+DCFF 的孤立代理 → 单字节 0x80..0xFF。
 */
export function encodeSurrogateEscape(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const n = s.charCodeAt(i + 1);
            if (n >= 0xdc00 && n <= 0xdfff) {
                out.push(...Buffer.from(s.slice(i, i + 2), 'utf8'));
                i++;
                continue;
            }
        }
        if (c >= 0xdc80 && c <= 0xdcff)
            out.push(c - 0xdc00);
        else if (c >= 0xd800 && c <= 0xdfff)
            throw new RangeError(`孤立代理字符 U+${c.toString(16).toUpperCase()} 不在 surrogateescape 的范围内`);
        else
            out.push(...Buffer.from(s[i], 'utf8'));
    }
    return Buffer.from(out);
}
/**
 * Finding 的稳定标识（契约 §9）。
 * `kind` 给了 → `check/kind[/归一化 key]`，判据不变它就不变，标题怎么改都不影响；
 * 没给 → `check/` + `sha1(title)[:8]`，只在同一工具身份内稳定（标题一改就换）。
 */
export function findingId(check, title, kind, key) {
    if (kind) {
        let out = `${check}/${kind}`;
        if (key !== undefined && key !== null && pyStrip(String(key)) !== '')
            out += '/' + normalizeKey(key);
        return out;
    }
    return `${check}/${createHash('sha1').update(encodeSurrogateEscape(title)).digest('hex').slice(0, 8)}`;
}
/** 构造一条 Finding。status 非法即抛——不允许悄悄产生第四种状态。 */
export function finding(check, status, title, init = {}) {
    if (!STATUSES.includes(status))
        throw new Error(`非法状态 ${JSON.stringify(status)}`);
    const reason = init.reason ?? '';
    if ((status === UNDETERMINED || status === SKIP) && !reason)
        throw new Error(`${status} 必须给 reason（契约 §1）`);
    return {
        check,
        id: findingId(check, title, init.kind, init.key),
        status: status,
        title,
        where: init.where ?? null,
        why: init.why ?? '',
        reason,
        evidence: init.evidence ?? '',
        registered: null,
    };
}
