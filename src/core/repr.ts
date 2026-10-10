// Python 的 `repr()`（即 `%r`）：全仓唯一一份。此前六个文件各写了一份互不一致的 pyRepr（有的只处理字符串、有的不转义控制字符、有的不选引号），
// 检查器的 reason / evidence 里写 `%r` 的地方（日期原文、预算值、锚点……）都该走这里。
//
// 与 Python 逐字相同的规则（test/cases/repr.mjs 逐条比对）：
//   字符串：含单引号且不含双引号时用双引号，否则用单引号；反斜杠、与外层相同的引号、\n \r \t 转义；
//           不可打印字符（Python 的 `str.isprintable()` 为假：Unicode 类别 C* 与 Z*，U+0020 除外）按码点写 \xNN、\uNNNN、\UNNNNNNNN；可打印的非 ASCII 原样保留。
//   整数：十进制；浮点：最短往返表示；True/False/None；列表 `[a, b]`；字典 `{k: v}`。
//
// 与 Python 版的有意差异（设计 §12.6 D5 的又一处表现，不是逻辑差异）：「可打印」取决于 Unicode 版本。Python 3.12.14 用 Unicode 15.0，Node 24 用 17.0；
// 17.0 新分配的约一万个码点（Python 15.0 里是未分配 Cn，会被转义）在这里被当作可打印原样保留。实测 JS 近似**没有任何一个多判**（Python 认可打印而这里转义的为零）。

/** Python 的 `str.isprintable()` 的 JS 近似：非 Other（C*）、非 Separator（Z*）。只对 ≥ 0x7f 的字符调用（ASCII 在调用前已分流，所以 U+0020 不会走到这里）。 */
const isPrintable = (ch: string): boolean => !/^[\p{C}\p{Z}]$/u.test(ch)

function reprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (ch === '\\') out += '\\\\'
    else if (ch === q) out += '\\' + q
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (cp < 0x20) out += '\\x' + cp.toString(16).padStart(2, '0')
    else if (cp < 0x7f) out += ch
    else if (!isPrintable(ch)) out += cp <= 0xff ? '\\x' + cp.toString(16).padStart(2, '0') : cp <= 0xffff ? '\\u' + cp.toString(16).padStart(4, '0') : '\\U' + cp.toString(16).padStart(8, '0')
    else out += ch
  }
  return q + out + q
}

/** Python 的 `repr(v)`，v 是 YAML 能产生的值（字符串、整数、浮点、布尔、None、列表、映射）。 */
export function pyRepr(v: unknown): string {
  if (typeof v === 'string') return reprStr(v)
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']'
  if (v !== null && typeof v === 'object') return '{' + Object.entries(v as object).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ') + '}'
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  // 数字：整数与浮点的 JS 最短往返表示都与 Python 的 repr 相同。浮点来自 YAML 的 `-?\d+\.\d+`（无指数、无 inf/nan）；整数值的 number 一律当 int（JS 区分不了 1 与 1.0）
  if (typeof v === 'number') return String(v)
  return JSON.stringify(v)
}
