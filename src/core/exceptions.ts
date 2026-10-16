// 例外登记册（对应 tools/std/stdlib.py 的 load_exceptions / _ex_closed / _md_cells / _first_md_table / _ex_field，契约 §9）。
//
// 登记册是项目写的 markdown 表，**配置文件同目录**的 `exceptions.md`。一行登记＝「这条发现我看过并接受到某日」，粒度是单条发现（不是整个检查器，那走 tailoring）。
// 与项目自己的门号例外（`G6` 之类）共用一张表：**规则列不含 `/` 的行本工具不登记、不校验五项**——那是项目的门，不是本工具的发现。
// 有意差异：D10（系统错误的整句措辞，见设计 §12.6）。

import { inside, guard, isFile, lexists, readBytes, isReadRefusal } from './fs.js'
import { PY_WHITESPACE, pyStrip } from './finding.js'
import { addDays, compareDays, parseDate, toIso, todayLocal, type CalDate } from './dates.js'
import { diagnoseUtf8, pyUtf8ErrorMessage } from './utf8.js'
import { splitLinesPy } from './yaml.js'
import { join } from 'node:path'

export const EXCEPTIONS_FILE = 'exceptions.md'
/** 检查器自身出错的 Finding id 的 kind 段（`<检查器>/internal-error`）。登记它等于登记被顶掉的 FAIL，按不合格行处置（契约 §9）。 */
export const INTERNAL_ERROR_KIND = 'internal-error'
/** 登记到期的上限：运行日起一年（契约 §9）。更远的到期等于长期静音，按不合格行处置。 */
export const EXCEPTION_MAX_DAYS = 365

type ExField = 'ex_id' | 'rule' | 'reason' | 'scope' | 'approver' | 'expires' | 'status'

/**
 * 表头按「包含」匹配，先命中者为准；`id` 只认整格（不区分大小写）——按包含，「到期 / valid until」「Rule ID」「Provider」都会被当成编号列，
 * 到期或规则列随之丢失。
 */
const EX_HEADERS: ReadonlyArray<readonly [string, ExField]> = [
  ['编号', 'ex_id'], ['规则', 'rule'], ['理由', 'reason'], ['范围', 'scope'], ['批准', 'approver'], ['到期', 'expires'], ['状态', 'status'],
]

const WS = `[${PY_WHITESPACE}]`

/**
 * 关闭态先判：关闭行不登记、不报过期、不参与有效性校验。**某一段以关闭词整词开头**才算关闭——
 * 含词即关闭会把「没关闭」「not yet closed」「open (to be closed)」这类尚在生效的例外当成历史行放过；
 * 按否定前缀排除又列不全（D-123）；只看前缀又会把「已处理中」「done? 否」「closed-loop 待复核」当成关闭。
 * 关闭词后面只许是段尾、空白、加粗/反引号、括号或冒号、句号。
 */
const EX_CLOSED_RE = new RegExp(`^(?:关闭|已关闭|closed|done|已处理)(?=$|${WS}|[*\`（(【\\[：:。.])`)

/** Python 的 `str.lower()` 在本模块输入上与 JS 的 `toLowerCase()` 一致（关闭词与表头词都是 ASCII 或中文；对带 Kelvin 符号等极端输入的差异见 §12.6 D5 同类：不复现）。 */
function exClosed(status: string): boolean {
  // 按逗号、分号、顿号、斜杠、竖线切段（连续分隔符合并），任一段（去首尾加粗与反引号）以关闭词整词开头即关闭
  for (const seg of status.toLowerCase().split(/[，,;；、/|]+/)) {
    const s = stripAround(pyStrip(seg), '*`')
    if (EX_CLOSED_RE.test(pyStrip(s))) return true
  }
  return false
}

/** Python 的 `s.strip(chars)`：只去首尾属于 chars 的字符。 */
function stripAround(s: string, chars: string): string {
  let a = 0, b = s.length
  while (a < b && chars.includes(s[a]!)) a++
  while (b > a && chars.includes(s[b - 1]!)) b--
  return s.slice(a, b)
}

export { exClosed as _exClosed }

const MD_SEP_RE = new RegExp(`^\\|(?:${WS}*:?-+:?${WS}*\\|)+$`)

/** 拆一行 markdown 表格的单元格。`\|` 是转义的竖线，不拆。 */
export function mdCells(line: string): string[] {
  let s = pyStrip(line)
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur: string[] = []
  let esc = false
  for (const ch of s) {
    if (esc) {
      cur.push(ch === '|' ? ch : '\\' + ch)
      esc = false
    } else if (ch === '\\') {
      esc = true
    } else if (ch === '|') {
      cells.push(pyStrip(cur.join('')))
      cur = []
    } else {
      cur.push(ch)
    }
  }
  if (esc) cur.push('\\')
  cells.push(pyStrip(cur.join('')))
  return cells
}

/** 第一张 markdown 表。返回 [表头行号, 表头单元格, [[行号, 单元格], ...]] 或 null。 */
export function firstMdTable(text: string): [number, string[], Array<[number, string[]]>] | null {
  const lines = splitLinesPy(text)
  for (let i = 0; i < lines.length - 1; i++) {
    if (!pyStrip(lines[i]!).startsWith('|')) continue
    if (!MD_SEP_RE.test(pyStrip(lines[i + 1]!))) continue
    const rows: Array<[number, string[]]> = []
    let j = i + 2
    while (j < lines.length && pyStrip(lines[j]!).startsWith('|')) {
      rows.push([j + 1, mdCells(lines[j]!)])
      j++
    }
    return [i + 1, mdCells(lines[i]!), rows]
  }
  return null
}

export function exField(headerCell: string): ExField | null {
  if (pyStrip(headerCell).toLowerCase() === 'id') return 'ex_id'
  for (const [token, field] of EX_HEADERS) {
    if (headerCell.includes(token) || headerCell.toLowerCase().includes(token)) return field
  }
  return null
}

export interface ExRow {
  ex_id: string
  rule: string
  reason: string
  scope: string
  approver: string
  expires: string
  expires_date: CalDate
  status: string
  lineno: number
}
/** 项目自有例外行（规则不含 `/`）：只取到期；`expires_date` 解析不了时为 null。 */
export interface OwnRow {
  ex_id: string
  rule: string
  expires: string
  expires_date: CalDate | null
  error: string | null
  lineno: number
}
export type ExceptionsResult = [rows: ExRow[], problems: string[], sourcePath: string | null, own: OwnRow[]]

/**
 * 读例外登记册：配置文件**同目录**的 `exceptions.md`（契约 §9）。不带 `--config` 时就是 `<项目根>/governance/exceptions.md`。
 *
 * 返回 `[rows, problems, sourcePath, own]`：
 * - rows：本工具认领且五项齐全的登记行（规则含 `/`，即 Finding id 的形态）。
 * - problems：本工具认领但不合格的行（行号 + 缺什么；到期晚于 today + 一年、或规则是检查器自身出错 `<检查器>/internal-error` 的，同样不合格）。today 缺省取运行日。
 * - sourcePath：文件路径；文件不存在时为 null。
 * - own：未关闭的项目自有例外行（规则不含 `/`），只取到期。02 §4「到期未清理 CI 转红」对它们同样成立，到期由调用方按运行日判。
 */
export function loadExceptions(configDir: string, root?: string | null, today?: CalDate): ExceptionsResult {
  const path = join(configDir, EXCEPTIONS_FILE)
  if (!lexists(path)) return [[], [], null, []] // 只 lstat 这一处，先不跟随链接
  // 护栏：配置在项目内时登记册须在项目内，外部配置（--config）时须在配置目录内；越界不读、不回显
  const base = root && inside(root, configDir) ? root : configDir
  let text: string
  try {
    guard(base, path)
    if (!isFile(path)) return [[], [], null, []]
    const raw = readBytes(path, base)
    const body = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw
    const bad = diagnoseUtf8(body)
    // Python 的 decode('utf-8-sig') 报的位置相对 BOM 之后，pyUtf8ErrorMessage 收的正是去掉 BOM 的数据
    if (bad) return [[], [`${EXCEPTIONS_FILE} 读不了：${pyUtf8ErrorMessage(body, bad)}`], path, []]
    text = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(body)
  } catch (e) {
    // Python 只捕获 (OSError, UnicodeDecodeError)；其它异常（程序错误）向外抛，不伪装成「登记册读不了」
    if (isReadRefusal(e)) return [[], [`${EXCEPTIONS_FILE} 读不了：${e.message}`], path, []]
    const code = (e as NodeJS.ErrnoException).code
    if (typeof code === 'string') return [[], [`${EXCEPTIONS_FILE} 读不了：${errnoName(code)}: ${path}`], path, []] // D10
    throw e
  }
  return parseExceptionsText(text, today, path)
}

/** 纯文本入口；复用登记册原有第一表、关闭优先、项目自有行和到期校验，不做文件访问。 */
export function parseExceptionsText(text: string, today?: CalDate, path: string | null = null): ExceptionsResult {
  const table = firstMdTable(text)
  if (table === null) return [[], [`${EXCEPTIONS_FILE} 里没有 markdown 表；本工具只读第一张表`], path, []]

  const [hdrLineno, header, rawRows] = table
  const cols = new Map<ExField, number>()
  const dup: string[] = []
  const problems: string[] = []
  header.forEach((cell, idx) => {
    const field = exField(cell)
    if (field === null) return
    if (cols.has(field)) { dup.push(field); return }
    cols.set(field, idx)
  })
  if (dup.length) problems.push(`第 ${hdrLineno} 行（表头）有多列都命中 ${[...new Set(dup)].sort().join('、')}，按先命中者为准`)

  const rows: ExRow[] = []
  const own: OwnRow[] = []
  const lim = addDays(today ?? todayLocal(), EXCEPTION_MAX_DAYS)
  for (const [lineno, cells] of rawRows) {
    if (!cells.some((c) => c)) continue
    const get = (field: ExField): string => {
      const i = cols.get(field)
      return i !== undefined && i < cells.length ? pyStrip(cells[i]!) : ''
    }
    const status = get('status')
    if (exClosed(status)) continue // 先判关闭
    const rule = pyStrip(stripAround(pyStrip(get('rule')), '`'))
    const exId = get('ex_id'), reason = get('reason'), scope = get('scope')
    const approver = get('approver'), expiresRaw = get('expires')
    if (!rule.includes('/')) { // 项目自己的例外：只取到期
      const [day, err] = parseDate(expiresRaw, true)
      own.push({ ex_id: exId, rule, expires: expiresRaw, expires_date: day, error: err, lineno })
      continue
    }
    const missing = ([['规则', rule], ['理由', reason], ['范围', scope], ['批准人', approver]] as const).filter(([, v]) => !v).map(([n]) => n as string)
    const [day, err] = parseDate(expiresRaw, true)
    if (day === null) missing.push(`到期（${err}）`)
    const tag = exId ? `（${exId}）` : ''
    if (missing.length) {
      problems.push(`第 ${lineno} 行${tag}缺：${missing.join('、')}`)
      continue
    }
    if (rule.split('/')[1] === INTERNAL_ERROR_KIND) { // Python：rule.split('/')[1:2] == [KIND]，段数不够时切片是空、不等
      problems.push(`第 ${lineno} 行${tag}登记的是检查器自身出错（${rule}），不可登记：崩溃顶掉了该检查器（或某条判据）本次的结论，登记它等于登记 FAIL；修好检查器或它的输入`)
      continue
    }
    if (compareDays(day!, lim) > 0) {
      problems.push(`第 ${lineno} 行${tag}到期 ${toIso(day!)} 晚于上限 ${toIso(lim)}（运行日起 ${EXCEPTION_MAX_DAYS} 天）`)
      continue
    }
    rows.push({ ex_id: exId, rule, reason, scope, approver, expires: toIso(day!), expires_date: day!, status, lineno })
  }
  return [rows, problems, path, own]
}

/** 系统错误码 → Python 的异常类名（只覆盖本模块会遇到的）。 */
function errnoName(code: string): string {
  if (code === 'ENOENT') return 'FileNotFoundError'
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError'
  if (code === 'EISDIR') return 'IsADirectoryError'
  if (code === 'ENOTDIR') return 'NotADirectoryError'
  return 'OSError'
}


