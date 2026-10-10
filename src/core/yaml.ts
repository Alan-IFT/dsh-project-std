// 严格 YAML 子集解析器（对应 tools/std/stdlib.py 的 parse_yaml_subset 及其辅助函数，契约 §5）。
// 原则：歧义即拒绝，不猜。每条拒收信息都带行号并指明写法，**不回显行内容**（安全 2：配置可能是被扫方写的）。
// 与 Python 版的有意差异见设计 §12.6：D2 递归上限（固定 100 层，同一条消息）、D3 超出安全整数范围抛、D4 \d 只认 ASCII、D6 不用 \s/trim。

import { PY_WHITESPACE, isPyWs, pyRstrip, pyStrip } from './finding.js'
import { pyRepr } from './repr.js'

/** 配置无法被无歧义地解析。 */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** 解析结果的值类型。`undefined` 不会出现；YAML 的 null/空值是 `null`。 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue }

const SCALAR_TRUE = new Set(['true', 'yes', 'on'])
const SCALAR_FALSE = new Set(['false', 'no', 'off'])

/** D2：JS 的栈深度与 Python 不同；配置只需两三层，100 层远超任何真实输入。同一输入在两版本里都被拒、消息相同。 */
const MAX_DEPTH = 100

const WS = `[${PY_WHITESPACE}]`

function scalar(raw: string, lineno: number): YamlValue {
  const s = pyStrip(raw)
  if (!s) return ''
  if (s === '[]') return [] // 唯一接受的流式写法：空列表没有歧义，且 metadata_required 靠它区分「声明一类都没有」与「没声明」（契约 §5）
  const first = s[0]!
  if ('[{&*|>!%@`'.includes(first)) {
    throw new ConfigError(
      `第 ${lineno} 行用了本解析器不支持的 YAML 语法 ${pyRepr(first)}。本工具只接受最简子集（缩进映射、短横线列表、纯量），看不懂即拒绝而不是猜。` +
        (first === '!' ? '以 ! 起头的值须加引号（例如 metadata_required 的排除前缀写 "!docs/x"）。' : ''),
    )
  }
  if (first === '"' || first === "'") {
    if (s.length < 2 || s[s.length - 1] !== first || s.slice(1, -1).includes(first)) {
      throw new ConfigError(`第 ${lineno} 行的引号没有成对闭合（或引号里又有同种引号），本解析器不处理`)
    }
    const body = s.slice(1, -1)
    if (body.includes('\\')) throw new ConfigError(`第 ${lineno} 行的引号字符串含转义，本解析器不处理`)
    return body
  }
  if (s.includes(': ')) {
    throw new ConfigError(`第 ${lineno} 行的值里有「: 」：YAML 不收这种写法（\`a: b: c\`），值里要带冒号请整体加引号`)
  }
  const low = s.toLowerCase()
  if (SCALAR_TRUE.has(low)) return true
  if (SCALAR_FALSE.has(low)) return false
  if (low === 'null' || low === '~') return null
  if (/^-?[0-9]+$/.test(s)) return safeInt(s, lineno)
  if (/^-?[0-9]+\.[0-9]+$/.test(s)) return Number(s)
  return s
}

/** D3：超出安全整数范围抛，不静默丢精度（「歧义即拒绝」）。 */
function safeInt(s: string, lineno: number): number {
  const n = Number(s)
  if (!Number.isSafeInteger(n)) throw new ConfigError(`第 ${lineno} 行的整数超出 ±2^53，本解析器不处理`)
  return n
}

/**
 * 去行尾注释。只在 # 前有空白或位于行首时才算注释，避免吃掉值里的 #。
 * 引号只在值的开头（行首、`:` 或 `- ` 之后）才开启引用：`don't # 注释` 里的撇号是正文，不许把后面的注释吞进值里。
 */
export function stripComment(line: string): string {
  const out: string[] = []
  let inQ = false
  let q = ''
  let last = '' // 已收下的最后一个非空白字符（不每次 join，免平方级）
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQ) {
      out.push(ch)
      if (ch === q) inQ = false
    } else if (ch === '"' || ch === "'") {
      if (last === '' || last === ':' || last === '-') {
        inQ = true
        q = ch
      }
      out.push(ch)
    } else if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      break
    } else {
      out.push(ch)
    }
    if (!isPyWs(ch)) last = ch
  }
  return pyRstrip(out.join(''))
}

// 映射行：键（裸词或整体加引号）后跟冒号，冒号后是空白或行尾——YAML 的写法；`https://x` 不是映射。
// 裸键不带 `\s*` 接冒号（键尾空白由 splitKv 去掉）：`[^:]*?\s*:` 在长空白行上是平方级回溯。
const BARE_KEY_FIRST = `[^${PY_WHITESPACE}"'#:]`
const MAP_LINE = new RegExp(`^(?:"([^"]*)"${WS}*|'([^']*)'${WS}*|(${BARE_KEY_FIRST}[^:]*)):(?:${WS}+(.*)|)$`, 's')

function notKv(body: string, lineno: number): ConfigError {
  let what: string
  if (body.startsWith('---') || body.startsWith('...')) what = 'YAML 文档分隔符（--- / ...）'
  else if (body.startsWith('[') || body.startsWith('{')) what = '流式写法（[...] / {...}）'
  else if (body.includes(':')) what = '冒号后没有空格（须写成 `键: 值`），或键里带引号、冒号'
  else what = '没有 `键: 值` 的冒号'
  return new ConfigError(`第 ${lineno} 行不是 \`键: 值\`：本解析器不支持${what}`)
}

function splitKv(body: string, lineno: number): [string, string] | null {
  const m = MAP_LINE.exec(body)
  if (!m) return null
  const key = pyStrip([m[1], m[2], m[3]].find((g) => g !== undefined) ?? '')
  if (!key) throw new ConfigError(`第 ${lineno} 行的键为空`)
  return [key, m[4] ?? '']
}

/**
 * 在映射上建一个**自有数据属性**。键是被扫方写的任意字符串，包括 `__proto__`：直接 `obj[k] = v` 在 JS 里对 `__proto__` 会改原型（值是对象时）或被静默吞掉（值是标量时），
 * 而 Python 的 dict 里它只是普通键。`defineProperty` 不走 setter，保证「读到什么键就存什么键」。
 */
function put(obj: { [k: string]: YamlValue }, k: string, v: YamlValue): void {
  Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true })
}

interface Line {
  n: number
  indent: number
  body: string
}

/**
 * 等价于 Python 的 `str.splitlines()`：除 \n、\r\n、\r 外还在 \v \f \x1c \x1d \x1e \x85 \u2028 \u2029 处断行；
 * 不产生末尾空串。这与 JS 的 `split('\n')` 不同。
 */
export function splitLinesPy(text: string, keepends = false): string[] {
  if (!keepends) {
    const out = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
    if (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out
  }
  // keepends：每一行带上它自己的终止符（`\r\n` 算一个）；末尾没有终止符的最后一行照常给出
  return text.match(/[^\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])|[^\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]+$/g) ?? []
}

/** 解析 CONTRACT.md §5 所述结构。不支持的语法一律抛 ConfigError，不静默误读。 */
export function parseYamlSubset(text: string): YamlValue {
  const lines: Line[] = []
  const raws = splitLinesPy(text)
  for (let k = 0; k < raws.length; k++) {
    const raw = raws[k]!
    const n = k + 1
    if (raw.split('#')[0]!.includes('\t')) throw new ConfigError(`第 ${n} 行含制表符；请用空格缩进`)
    const body = stripComment(raw)
    if (pyStrip(body)) lines.push({ n, indent: body.length - body.replace(/^ +/, '').length, body: pyStrip(body) })
  }

  /** 返回 [value, nextIdx]。indent 是本块的缩进量。 */
  function block(idx: number, indent: number, depth: number): [YamlValue, number] {
    if (depth > MAX_DEPTH) throw new ConfigError('嵌套层数超出本解析器的递归上限；本工具的配置只需两三层')
    if (idx >= lines.length) return [null, idx]
    if (lines[idx]!.body.startsWith('- ')) {
      const items: YamlValue[] = []
      while (idx < lines.length && lines[idx]!.indent === indent && lines[idx]!.body.startsWith('- ')) {
        const { n, body } = lines[idx]!
        const rest = pyStrip(body.slice(2))
        const kv = splitKv(rest, n)
        if (kv && pyStrip(kv[1])) {
          // 列表项是行内起始的映射：- name: x
          const [k, v] = kv
          const item: { [k: string]: YamlValue } = { [k]: scalar(v, n) }
          idx++
          const childIndent = indent + 2
          while (idx < lines.length && lines[idx]!.indent >= childIndent && !lines[idx]!.body.startsWith('- ')) {
            const { n: n2, indent: ind2, body: b2 } = lines[idx]!
            if (ind2 !== childIndent) throw new ConfigError(`第 ${n2} 行缩进不一致`)
            const kv2 = splitKv(b2, n2)
            if (kv2 === null) throw notKv(b2, n2)
            const [k2, v2] = kv2
            if (Object.hasOwn(item, k2)) throw new ConfigError(`第 ${n2} 行的键 ${pyRepr(k2)} 在同一列表项里重复；重复键的取值有歧义`)
            if (!pyStrip(v2)) {
              // 空值：下一行更深才是子块，否则取 None（与映射分支一致）
              if (idx + 1 < lines.length && lines[idx + 1]!.indent > childIndent) {
                const [sub, ni] = block(idx + 1, lines[idx + 1]!.indent, depth + 1)
                put(item, k2, sub)
                idx = ni
              } else {
                put(item, k2, null)
                idx++
              }
              continue
            }
            put(item, k2, scalar(v2, n2))
            idx++
          }
          items.push(item)
        } else if (kv && rest.endsWith(':')) {
          throw new ConfigError(`第 ${n} 行的列表项 - key: 后面没有值；本解析器不支持这种嵌套写法`)
        } else if (rest === '[]') {
          // 空列表只作键的值才有意义（区分「声明没有」与「没声明」）；作列表项是嵌套空列表，没有哪个键收这个形状
          throw new ConfigError(`第 ${n} 行的列表项是空列表 []；只有键的值可以写 []`)
        } else if (rest) {
          items.push(scalar(rest, n))
          idx++
        } else {
          throw new ConfigError(`第 ${n} 行是空列表项`)
        }
      }
      return [items, idx]
    }
    const mapping: { [k: string]: YamlValue } = {}
    while (idx < lines.length && lines[idx]!.indent === indent) {
      const { n, body } = lines[idx]!
      if (body.startsWith('- ')) break
      const kv = splitKv(body, n)
      if (kv === null) throw notKv(body, n)
      const [k, v] = kv
      if (Object.hasOwn(mapping, k)) throw new ConfigError(`第 ${n} 行的键 ${pyRepr(k)} 重复；重复键的取值有歧义`)
      if (pyStrip(v)) {
        put(mapping, k, scalar(v, n))
        idx++
        continue
      }
      if (idx + 1 < lines.length && lines[idx + 1]!.indent > indent) {
        const [sub, ni] = block(idx + 1, lines[idx + 1]!.indent, depth + 1)
        put(mapping, k, sub)
        idx = ni
      } else {
        put(mapping, k, null)
        idx++
      }
    }
    return [mapping, idx]
  }

  if (lines.length === 0) return {}
  const [value, end] = block(0, lines[0]!.indent, 0)
  if (end !== lines.length) {
    if (lines[end]!.body.startsWith('- ')) {
      throw new ConfigError(`第 ${lines[end]!.n} 行的列表项与它的键同列：本解析器要求列表项比键多缩进（\`键:\` 下一行写 \`  - 值\`）`)
    }
    throw new ConfigError(`第 ${lines[end]!.n} 行缩进层级无法归属`)
  }
  return value
}

export const _internal = { MAX_DEPTH }
