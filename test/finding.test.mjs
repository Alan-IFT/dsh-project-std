// core/finding 的单元测试。金标准来自 Python 版：golden/unit/stdlib-pure.json（函数输出）与 golden/unit/whitespace.json（逐码点空白集合）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { STRIP as WS_STRIP, RE_S as WS_RE_S } from './cases/whitespace.mjs'
import { NORMALIZE_KEY, FINDING_ID } from './cases/stdlib-pure.mjs'
import { PY_WHITESPACE, pyStrip, pyLstrip, pyRstrip, normalizeKey, findingId, finding, encodeSurrogateEscape, PASS, FAIL, SKIP, UNDETERMINED } from '../lib/core/finding.js'

const here = dirname(fileURLToPath(import.meta.url))
const unit = (name) => ({ 'whitespace.json': { strip: WS_STRIP, re_s: WS_RE_S }, 'stdlib-pure.json': { normalize_key: NORMALIZE_KEY, finding_id: FINDING_ID } })[name]

test('PY_WHITESPACE 逐码点等于 Python 的 str.strip() 与 re 的 \\s（0 到 0x10FFFF 全部码点，设计 §12.6 D6）', () => {
  const gold = unit('whitespace.json')
  assert.deepEqual(gold.strip, gold.re_s, '金标准自洽：Python 里 strip 与 \\s 是同一个集合')
  const inGold = (cp) => gold.strip.some(([a, b]) => cp >= a && cp <= b)
  const mine = new RegExp(`^[${PY_WHITESPACE}]$`, 'u')
  const wrong = []
  for (let cp = 0; cp < 0x110000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    if (mine.test(String.fromCodePoint(cp)) !== inGold(cp)) wrong.push(cp)
  }
  assert.deepEqual(wrong, [], '与 Python 不一致的码点: ' + wrong.slice(0, 10).map((x) => 'U+' + x.toString(16)).join(' '))
})

test('pyStrip 与 JS 的 trim 在 U+FEFF 上不同：Python 留着 BOM，pyStrip 也留着（D6）', () => {
  assert.equal(pyStrip('\ufeffx\ufeff'), '\ufeffx\ufeff')
  assert.equal('\ufeffx\ufeff'.trim(), 'x', '对照：JS 的 trim 会去掉 BOM——这就是不能用它的原因')
  assert.equal(pyStrip('\u001cx\u0085'), 'x', 'U+001C 与 U+0085 Python 认作空白，JS 的 trim 不认')
  assert.equal('\u001cx\u0085'.trim(), '\u001cx\u0085')
  assert.equal(pyStrip('\u3000x\u00a0'), 'x')
})

test('normalizeKey：与 Python 版逐条一致', () => {
  const rows = unit('stdlib-pure.json').normalize_key
  assert.ok(rows.length >= 7)
  for (const { input, result } of rows) assert.equal(normalizeKey(input), result.ok, JSON.stringify(input))
})

test('findingId：与 Python 版逐条一致（含含代理字符的输入）', () => {
  const rows = unit('stdlib-pure.json').finding_id
  assert.ok(rows.length >= 7)
  for (const { args, result } of rows) {
    const real = args.map((a) => (a && typeof a === 'object' && 'surrogate_escaped' in a ? JSON.parse(`"${a.surrogate_escaped}"`) : a))
    assert.equal(findingId(...real), result.ok, JSON.stringify(args))
  }
})

test('encodeSurrogateEscape：合法字符串等于 UTF-8；DC80..DCFF 的孤立代理变成单字节；其它孤立代理抛（Python 同样抛）', () => {
  assert.deepEqual([...encodeSurrogateEscape('a中😀')], [...Buffer.from('a中😀', 'utf8')])
  assert.deepEqual([...encodeSurrogateEscape('t\udcff')], [0x74, 0xff])
  assert.deepEqual([...encodeSurrogateEscape('\udc80\udcfe')], [0x80, 0xfe])
  assert.throws(() => encodeSurrogateEscape('\ud800'), RangeError)
  assert.throws(() => encodeSurrogateEscape('\udc7f'), RangeError)
  assert.notDeepEqual([...Buffer.from('t\udcff', 'utf8')], [0x74, 0xff], '对照：Buffer.from 会把孤立代理换成 U+FFFD，哈希会不同')
})

test('finding：非法状态抛；未定与不适用必须给 reason；registered 初值为 null', () => {
  assert.throws(() => finding('c', 'MAYBE', 't'), /非法状态/)
  assert.throws(() => finding('c', UNDETERMINED, 't'), /必须给 reason/)
  assert.throws(() => finding('c', SKIP, 't'), /必须给 reason/)
  const f = finding('c', PASS, 't')
  assert.equal(f.registered, null); assert.equal(f.where, null); assert.equal(f.why, '')
  assert.equal(finding('c', FAIL, 't', { kind: 'k', key: 'a b' }).id, 'c/k/a_b')
  assert.equal(finding('c', UNDETERMINED, 't', { reason: 'r', kind: 'k', key: '  ' }).id, 'c/k', 'key 全空白等同没给')
})

test('pyStrip / pyLstrip 线性：10 万个空白夹在两端之间不得是平方级（改前一条 /^WS+|WS+$/ 正则，10 万空白要 11 秒；全仓近百处调用都经它）', () => {
  const t0 = performance.now()
  assert.equal(pyStrip('a' + ' '.repeat(100000) + 'b').length, 100002)
  assert.equal(pyStrip(' '.repeat(100000) + 'b' + ' '.repeat(100000)), 'b')
  assert.equal(pyLstrip(' '.repeat(100000) + 'b'), 'b')
  const spent = (performance.now() - t0) / 1000
  assert.ok(spent < 1, `三次调用共 ${spent.toFixed(2)}s，超过 1s（线性实现应在毫秒级）`)
})

test('pyLstrip 只去左边（Python 的 str.lstrip()）：右边的空白原样留着；全空白得空串；BOM 不去', () => {
  assert.equal(pyLstrip(' \t\u3000x \u3000'), 'x \u3000')
  assert.equal(pyLstrip('   '), '')
  assert.equal(pyLstrip(''), '')
  assert.equal(pyLstrip('\ufeff x'), '\ufeff x', 'U+FEFF 不是 Python 空白（D6）')
  assert.equal(pyLstrip('x  '), 'x  ')
})

test('pyRstrip 只去右边（Python 的 str.rstrip()）：左边的空白原样留着；全空白得空串；BOM 不去；10 万个空白仍是线性', () => {
  assert.equal(pyRstrip(' \u3000x \t\u3000'), ' \u3000x')
  assert.equal(pyRstrip('   '), '')
  assert.equal(pyRstrip(''), '')
  assert.equal(pyRstrip('x \ufeff'), 'x \ufeff', 'U+FEFF 不是 Python 空白（D6）')
  assert.equal(pyRstrip('  x'), '  x')
  const t0 = performance.now()
  assert.equal(pyRstrip('b' + ' '.repeat(100000)), 'b')
  assert.equal(pyRstrip(' '.repeat(100000) + 'b'), ' '.repeat(100000) + 'b')
  assert.ok((performance.now() - t0) / 1000 < 1, '线性实现应在毫秒级')
})

test('pyStrip 与旧正则实现对同一批边界输入逐条相同（线性化没改语义）', () => {
  const ws = new RegExp(`[${PY_WHITESPACE}]`)
  const old = (s) => s.replace(new RegExp(`^[${PY_WHITESPACE}]+|[${PY_WHITESPACE}]+$`, 'g'), '')
  const alphabet = ['a', ' ', '\t', '\u3000', '\ufeff', '\u0085', '\u001c', '😀']
  let n = 0
  const walk = (s, depth) => { assert.equal(pyStrip(s), old(s), JSON.stringify(s)); n++; if (depth) for (const c of alphabet) walk(s + c, depth - 1) }
  walk('', 5)
  assert.ok(n > 30000 && ws.test(' '))
})