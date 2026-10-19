import { createHash } from 'node:crypto'
import { validateConfigText } from './core/config.js'
import { parseExceptionsText } from './core/exceptions.js'

export type Direction = 'equivalent' | 'tighten' | 'relax' | 'unknown'
export type GovernanceTarget = 'project' | 'exceptions'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type PresentValue = { present: false } | { present: true; value: Json }
export interface FieldChange { path: string; direction: Direction; reason: string; before: PresentValue; after: PresentValue }
export interface Review { valid: boolean; target: GovernanceTarget; beforeSha256: string | null; afterSha256: string; needsApproval: boolean; changes: FieldChange[]; problem?: string }
export const TEXT_MAX_BYTES = 32768
export const REASON_MAX_BYTES = 131072
export const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex')
const budgets = new Set(['entry_lines', 'stale_days', 'work_item_stale_days', 'status_lines', 'handoff_lines', 'work_item_lines', 'module_lines', 'duplicate_min_lines', 'duplicate_min_chars'])

/** Do not let UTF-8 encoding or JSON serialization silently change review evidence. */
export function assertText(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('文本含孤立 Unicode surrogate')
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error('文本含孤立 Unicode surrogate')
  }
  if (Buffer.byteLength(text, 'utf8') > TEXT_MAX_BYTES) throw new Error(`文本超过 ${TEXT_MAX_BYTES} UTF-8 字节`)
}
export function decodeRaw(bytes: Uint8Array): string {
  if (bytes.byteLength > TEXT_MAX_BYTES) throw new Error(`文件超过 ${TEXT_MAX_BYTES} 字节`)
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  assertText(text)
  return text
}
export const parseBody = (text: string): string => text.startsWith('\ufeff') ? text.slice(1) : text
function assertJson(v: unknown): asserts v is Json {
  if (v === null || typeof v === 'boolean') return
  if (typeof v === 'string') { assertText(v); return }
  if (typeof v === 'number' && Number.isFinite(v)) return
  if (Array.isArray(v)) { for (const x of v) assertJson(x); return }
  if (typeof v === 'object' && v !== null) {
    for (const k of Object.keys(v)) { assertText(k); assertJson((v as Record<string, unknown>)[k]) }
    return
  }
  throw new Error('解析值不是可无损编码的有限 JSON 值')
}
const isMap = (v: Json): v is { [key: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v)
function equal(a: Json, b: Json): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]!))
  if (isMap(a) && isMap(b)) {
    const ak = Object.keys(a), bk = Object.keys(b)
    return ak.length === bk.length && ak.every(k => Object.hasOwn(b, k) && equal(a[k]!, b[k]!))
  }
  return Object.is(a, b) || a === b
}
const presence = (v: Json | undefined): PresentValue => v === undefined ? { present: false } : { present: true, value: v }
const pointer = (segments: string[]): string => '/' + segments.map(k => k.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')
/** Same segment-boundary prefix semantics as core/docs.inFrozen; only compare two explicit lists. */
function frozenDirection(before: Json | undefined, after: Json | undefined): Direction | null {
  if (!Array.isArray(before) || !Array.isArray(after) ||
      !before.every(x => typeof x === 'string') || !after.every(x => typeof x === 'string')) return null
  const prefixes = (list: Json[]) => list.map(x => (x as string).replaceAll('\\', '/').replace(/\/+$/, '')).filter(Boolean)
  const a = prefixes(before), b = prefixes(after)
  const covers = (wide: string[], narrow: string[]) => narrow.every(p => wide.some(q => p === q || p.startsWith(q + '/')))
  const added = covers(b, a), removed = covers(a, b)
  return added && removed ? 'equivalent' : added ? 'relax' : removed ? 'tighten' : 'unknown'
}
function diff(a: Json | undefined, b: Json | undefined, segments: string[], changes: FieldChange[]): void {
  if (a !== undefined && b !== undefined && equal(a, b)) return
  if (a !== undefined && b !== undefined && isMap(a) && isMap(b)) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      diff(Object.hasOwn(a, k) ? a[k] : undefined, Object.hasOwn(b, k) ? b[k] : undefined, [...segments, k], changes)
    }
    return
  }
  let direction: Direction = 'unknown'
  let reason = 'v1 仅证明九种预算双侧明示正安全整数的方向；声明来源、容器、数组及其它语义变化需送审'
  if (segments.length === 2 && segments[0] === 'budgets' && budgets.has(segments[1]!) && typeof a === 'number' && typeof b === 'number' && Number.isSafeInteger(a) && Number.isSafeInteger(b) && a > 0 && b > 0) {
    direction = b > a ? 'relax' : 'tighten'
    reason = '明示预算／重复检测阈值增大放宽，减小收紧；不抵消其它字段变化'
  } else if (segments.length === 2 && segments[0] === 'layout' && segments[1] === 'frozen') {
    direction = frozenDirection(a, b) ?? 'unknown'
    reason = '双侧明示的 frozen 整段前缀并集：新增豁免范围放宽，减少收紧；交叉变化或缺省仍送审'
  }
  changes.push({ path: segments.length ? pointer(segments) : '', direction, reason, before: presence(a), after: presence(b) })
}
export function invalidReview(target: GovernanceTarget, candidate: string, beforeSha: string | null, problem: string): Review {
  return { valid: false, target, beforeSha256: beforeSha, afterSha256: sha256(candidate), needsApproval: true, changes: [], problem }
}
export function reviewProject(candidate: string, beforeText: string | null, beforeSha: string | null): Review {
  try {
    assertText(candidate)
    const [after, problem] = validateConfigText(parseBody(candidate))
    if (problem) return invalidReview('project', candidate, beforeSha, problem)
    assertJson(after)
    let prior: Json | undefined
    if (beforeText !== null) {
      assertText(beforeText)
      const [cfg, oldProblem] = validateConfigText(parseBody(beforeText), '现有配置')
      if (oldProblem) return invalidReview('project', candidate, beforeSha, `既有配置无效：${oldProblem}`)
      assertJson(cfg)
      prior = cfg
    }
    const changes: FieldChange[] = []
    diff(prior, after, [], changes)
    return { valid: true, target: 'project', beforeSha256: beforeSha, afterSha256: sha256(candidate), needsApproval: beforeText === null || changes.some(c => c.direction === 'relax' || c.direction === 'unknown'), changes }
  } catch (e) { return invalidReview('project', candidate, beforeSha, (e as Error).message) }
}
export function reviewExceptions(candidate: string, beforeText: string | null, beforeSha: string | null): Review {
  try {
    for (const [label, text] of [['候选例外', candidate], ['现有例外', beforeText]] as const) {
      if (text === null) continue
      assertText(text)
      const [, problems, , own] = parseExceptionsText(parseBody(text))
      const errors = [...problems, ...own.filter(r => r.error).map(r => `第 ${r.lineno} 行：${r.error}`)]
      if (errors.length) return invalidReview('exceptions', candidate, beforeSha, `${label}无效：${errors.join('；')}`)
    }
    const changes: FieldChange[] = beforeText === candidate ? [] : [{ path: '', direction: 'unknown', reason: '例外登记任何文本变化均送审；登记中的批准人不构成宿主批准', before: presence(beforeText === null ? undefined : beforeText), after: presence(candidate) }]
    return { valid: true, target: 'exceptions', beforeSha256: beforeSha, afterSha256: sha256(candidate), needsApproval: beforeText === null || changes.length > 0, changes }
  } catch (e) { return invalidReview('exceptions', candidate, beforeSha, (e as Error).message) }
}
export const reviewText = (target: GovernanceTarget, candidate: string, before: string | null, hash: string | null): Review => target === 'project' ? reviewProject(candidate, before, hash) : reviewExceptions(candidate, before, hash)
