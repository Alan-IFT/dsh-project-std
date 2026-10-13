// v2 项目路径矩阵定义；本轮 SOURCE ONLY，不 import / 执行本文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { validateConfig, normalizeForCompare, decide } from '../lib/guard/policy.js'
import { apply, Config, name, inject } from '../lib/guard/index.js'

const WIN = process.platform === 'win32'
const A = WIN ? 'D:\\A' : '/A'
const B = WIN ? 'D:\\B' : '/B'
const config = (projects = [{ root: A, protect: ['locked', 'contract.md'] }, { root: B, protect: ['private'] }]) => ({ enabled: true, policyVersion: 2, projects })
const call = (file_path, cwd = A, name = 'write') => ({ name, arguments: { file_path }, agent: { session: { header: { cwd } } } })
const suffix = (root, rel) => root + (WIN ? '\\' : '/') + rel
const cases = [
  ['GP1 exact protected', call('locked'), 'ask'],
  ['protected child edit', call('locked/x', A, 'edit'), 'ask'],
  ['absolute same project', call(suffix(A, 'contract.md')), 'ask'],
  ['GP2 prefix sibling', call('locked-other/x'), 'allow'],
  ['filename suffix', call('contract.md.bak'), 'allow'],
  ['GP3 subdir relative not root', call('contract.md', suffix(A, 'sub')), 'allow'],
  ['subdir parent returns root', call('../contract.md', suffix(A, 'sub')), 'ask'],
  ['normal dotdot returns protect', call('sub/../locked/x'), 'ask'],
  ['GP4 genuinely outside root', call('../outside/contract.md'), 'allow'],
  ['dotdot-prefixed ordinary name', call('..prefix/contract.md'), 'allow'],
  ['B own rule', call('private/x', B), 'ask'],
  ['B absolute target A does not consume A binding', call(suffix(A, 'locked/x'), B), 'allow'],
  ['A absolute target B does not consume B binding', call(suffix(B, 'private/x')), 'allow'],
  ['unmatched cwd all targets abstain', call(suffix(A, 'locked/x'), WIN ? 'D:\\other' : '/other'), 'allow'],
  ['unmatched cwd missing target abstains', call(undefined, WIN ? 'D:\\other' : '/other'), 'allow'],
  ['no implicit AGENTS', call('AGENTS.md'), 'allow'],
  ['no implicit hook', call('.githooks/pre-commit'), 'allow'],
  ['no implicit state', call('PROJECT_STATUS.md'), 'allow'],
  ['no implicit contract', call('CONTEXT_MANIFEST.md'), 'allow'],
  ...[undefined, null, '', '  ', 4, {}].map((target) => ['GP5 malformed target ' + String(target), call(target), 'ask']),
  ...['read', 'glob', 'pwsh', 'bash', 'unknown', 'toString', undefined].map((name) => ['nonwrite ' + String(name), { name, get arguments() { throw new Error('must not read arguments') }, get agent() { throw new Error('must not read cwd') } }, 'allow']),
]
test('matrix nonempty with ask and abstention definitions', () => {
  assert.ok(cases.length >= 30)
  assert.ok(cases.some(([, , expected]) => expected === 'ask'))
  assert.ok(cases.some(([, , expected]) => expected === 'allow'))
})
for (const [title, exec, expected] of cases) test(title, () => {
  const got = decide(exec, validateConfig(config()))
  assert.equal(got.kind, expected)
  if (expected === 'ask') assert.ok(got.reason.length > 0)
})

for (const cwd of [null, '', 'relative', WIN ? 'C:sub' : 'sub']) test('GP6 invalid cwd only writes ask: ' + String(cwd), () => {
  const cfg = validateConfig(config())
  assert.equal(decide(call('locked', cwd), cfg).kind, 'ask')
  for (const name of ['read', 'pwsh', 'unknown']) assert.equal(decide(call('locked', cwd, name), cfg).kind, 'allow')
})
// Explicit missing cwd (call's default argument otherwise supplies A).
test('missing cwd asks and getters are confined to known managed writes', () => {
  const cfg = validateConfig(config())
  assert.equal(decide({ name: 'write', arguments: { file_path: 'locked' } }, cfg).kind, 'ask')
  assert.equal(decide({ get name() { throw new Error('unknown name') } }, cfg).kind, 'allow')
  assert.equal(decide({ name: 'write', get agent() { throw new Error('cwd') } }, cfg).kind, 'ask')
  assert.equal(decide({ ...call('locked'), get arguments() { throw new Error('args') } }, cfg).kind, 'ask')
  assert.equal(decide({ ...call('locked'), arguments: { get file_path() { throw new Error('target') } } }, cfg).kind, 'ask')
})

const invalidConfig = [
  false, true, 3, '', [], new Date(),
  { enabled: 'false' }, { enabled: undefined }, { policyVersion: 1 }, { policyVersion: undefined },
  { enabled: true }, { enabled: true, policyVersion: 2 }, { enabled: true, policyVersion: 2, projects: [] },
  { enabled: false, root: '' }, { enabled: false, protect: [] }, { root: undefined }, { protect: undefined },
  { typo: true }, { enabled: false, projects: undefined }, { projects: null },
  ...['', 'relative', WIN ? 'C:foo' : 'relative/sub', WIN ? '\\single' : 'relative'].map((root) => ({ projects: [{ root, protect: ['x'] }] })),
  ...[undefined, [], '', [''], ['.'], ['..'], ['a/../x'], ['./x'], ['a//x'], ['/x'], [null], [4], ['x/']].map((protect) => ({ enabled: false, projects: [{ root: A, protect }] })),
  { projects: Array(1) }, { projects: [{ root: A, protect: Array(1) }] },
  { projects: [{ root: A, protect: ['x'], typo: true }] },
  { projects: [{ root: A, protect: ['x'] }, { root: A, protect: ['y'] }] },
  { projects: [{ root: A, protect: ['x'] }, { root: suffix(A, 'sub'), protect: ['y'] }] },
]
for (const raw of invalidConfig) test('GP7 strict complete input rejects ' + JSON.stringify(raw), () => assert.throws(() => validateConfig(raw)))
test('sparse projects and protect arrays reject missing entries', () => {
  assert.throws(() => validateConfig({ enabled: true, policyVersion: 2, projects: Array(1) }))
  assert.throws(() => validateConfig({ enabled: true, policyVersion: 2, projects: [{ root: A, protect: Array(1) }] }))
})
test('nonenumerable unknown config keys are rejected', () => {
  const raw = Object.defineProperty({}, 'typo', { value: true })
  assert.throws(() => validateConfig(raw), /未知配置键 typo/)
})
test('symbol project keys are rejected', () => {
  const raw = { projects: [{ root: A, protect: ['x'], [Symbol('typo')]: true }] }
  assert.throws(() => validateConfig(raw), /未知配置键 Symbol\(typo\)/)
})
test('config getter exceptions propagate without fallback defaults', () => {
  const failure = new Error('config getter failure')
  const raw = { get enabled() { throw failure } }
  assert.throws(() => validateConfig(raw), (error) => error === failure)
})
test('defaults disabled v2; disabled still validates supplied projects; normalized values deeply frozen', () => {
  for (const raw of [undefined, null, {}, { enabled: false }, { policyVersion: 2, projects: [] }]) assert.deepEqual(validateConfig(raw), { enabled: false, policyVersion: 2, projects: [] })
  const raw = config()
  const result = validateConfig(raw)
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.projects))
  for (const project of result.projects) { assert.ok(Object.isFrozen(project)); assert.ok(Object.isFrozen(project.protect)) }
  raw.projects[0].protect.push('ordinary')
  assert.equal(result.projects[0].protect.length, 2)
  assert.equal(validateConfig({ enabled: false, projects: [{ root: A, protect: ['x'] }] }).projects.length, 1)
  assert.equal(decide(call('locked'), validateConfig()).kind, 'allow')
})

test('Windows pure lexical matrix, drive/UNC/full qualification and aliases', () => {
  const root = 'D:\\Proj'
  const cfg = validateConfig({ enabled: true, policyVersion: 2, projects: [{ root, protect: ['Locked', 'contract.md'] }] }, 'win32')
  for (const target of ['LOCKED/x', 'Locked. /x', 'contract.md:stream', '\\\\?\\D:\\Proj\\locked\\x']) assert.equal(decide(call(target, root), cfg, 'win32').kind, 'ask', target)
  for (const target of ['...', ':stream', 'C:foo', '\\locked', '/locked', '\\\\server', '\\\\server\\', '\\\\?\\UNC\\server']) assert.equal(decide(call(target, root), cfg, 'win32').kind, 'ask', target)
  for (const cwd of ['C:foo', '\\Proj', '\\\\server']) assert.equal(decide(call('locked', cwd), cfg, 'win32').kind, 'ask')
  for (const badRoot of ['C:foo', '\\Proj', '/Proj', '\\\\server', '\\\\server\\', '\\\\server\\..', '\\\\server\\...']) assert.throws(() => validateConfig({ projects: [{ root: badRoot, protect: ['x'] }] }, 'win32'))
  for (const protect of ['...', '   ', ':stream', 'x/:stream', 'x/:stream/y', 'x/.. ', 'D:foo', '\\x', 'x\\\\y']) assert.throws(() => validateConfig({ projects: [{ root, protect: [protect] }] }, 'win32'))
  for (const alias of ['d:\\PROJ', 'D:\\Proj. ', '\\\\?\\D:\\Proj', 'D:\\Proj:stream']) assert.throws(() => validateConfig({ projects: [{ root, protect: ['x'] }, { root: alias, protect: ['y'] }] }, 'win32'))
  const unc = '\\\\server\\share\\project'
  const uncCfg = validateConfig({ enabled: true, policyVersion: 2, projects: [{ root: unc, protect: ['locked'] }] }, 'win32')
  assert.equal(decide(call('locked/x', '\\\\?\\UNC\\SERVER\\SHARE\\project'), uncCfg, 'win32').kind, 'ask')
  assert.equal(normalizeForCompare('D:\\Proj\\Locked. \\a:stream', 'win32'), 'd:\\proj\\locked\\a')
})
test('POSIX lexical matrix is case sensitive and session relative', () => {
  const cfg = validateConfig({ enabled: true, policyVersion: 2, projects: [{ root: '/A', protect: ['Locked'] }] }, 'linux')
  assert.equal(decide(call('Locked/x', '/A'), cfg, 'linux').kind, 'ask')
  assert.equal(decide(call('locked/x', '/A'), cfg, 'linux').kind, 'allow')
  assert.equal(decide(call('../Locked/x', '/A/sub'), cfg, 'linux').kind, 'ask')
  assert.equal(decide(call('../../Locked/x', '/A/sub'), cfg, 'linux').kind, 'allow')
  assert.equal(normalizeForCompare('/A/../B', 'linux'), '/B')
})
test('POSIX protect preserves colons and backslashes as literal characters', () => {
  const protect = ['contract.md:stream', 'locked\\name']
  const cfg = validateConfig({ enabled: true, policyVersion: 2, projects: [{ root: '/A', protect }] }, 'linux')
  assert.deepEqual(cfg.projects[0].protect, protect)
  for (const target of ['contract.md:stream', 'contract.md:stream/x', 'locked\\name', 'locked\\name/x']) assert.equal(decide(call(target, '/A'), cfg, 'linux').kind, 'ask', target)
  for (const target of ['contract.md', 'locked/name']) assert.equal(decide(call(target, '/A'), cfg, 'linux').kind, 'allow', target)
})

function wire(raw) {
  const handlers = []
  apply({ on: (event, handler) => handlers.push([event, handler]) }, raw)
  return handlers
}
test('default/null/false no listeners; stable plugin entry', () => {
  for (const raw of [undefined, null, {}, { enabled: false }]) assert.equal(wire(raw).length, 0)
  assert.equal(name, 'dsh-project-std'); assert.deepEqual(inject, [])
  assert.equal(wire(config())[0][0], 'tools/pre-execute')
  for (const raw of invalidConfig) assert.throws(() => wire(raw))
})
test('GP8 next first, stricter ask/deny/cancel same object, throw same error', async () => {
  const handler = wire(config())[0][1]
  const unreadable = new Proxy({}, { get() { throw new Error('exec must not be read') } })
  for (const decision of [{ kind: 'ask', reason: 'down' }, { kind: 'deny', info: 'down' }, { kind: 'cancel', info: 'down' }]) assert.equal(await handler(unreadable, async () => decision), decision)
  const failure = new Error('next failure')
  await assert.rejects(handler(unreadable, async () => { throw failure }), (error) => error === failure)
  const allowed = { kind: 'allow' }
  assert.equal(await handler(call('ordinary'), async () => allowed), allowed)
  assert.equal((await handler(call('locked'), async () => allowed)).kind, 'ask')
  let nextCalled = false
  const exec = { get name() { assert.ok(nextCalled); return 'read' } }
  assert.equal(await handler(exec, async () => { nextCalled = true; return allowed }), allowed)
})

test('optional schema rejects invalid input and preserves nullable values; apply supplies fallback defaults', (t) => {
  let Schema
  try { const module = createRequire(import.meta.url)('@deepseek-ai/schemastery'); Schema = module.default ?? module } catch { t.skip('宿主可选 schemastery 不可用；apply strict 独立覆盖'); return }
  assert.equal(typeof Schema.transform, 'function')
  assert.ok(Config, '可用 schema 必须实际导出')
  for (const raw of invalidConfig) assert.throws(() => Config['~standard'].validate(raw), Error, JSON.stringify(raw))
  const failure = new Error('schema config getter failure')
  assert.throws(() => Config['~standard'].validate({ get enabled() { throw failure } }), (error) => error === failure)
  const valid = Config['~standard'].validate(config())
  assert.equal(valid.issues, undefined)
  assert.deepEqual(valid.value, validateConfig(config()))
  // schemastery 的 nullable shortcut 不调用 transform；apply 独立负责默认值。
  assert.equal(Config['~standard'].validate(undefined).value, undefined)
  assert.equal(Config['~standard'].validate(null).value, null)
  for (const raw of [undefined, null]) assert.equal(wire(Config['~standard'].validate(raw).value).length, 0)
})

for (const decision of [
  { kind: 'ask', reason: 'downstream approval required', displayReason: 'Keep downstream approval prompt' },
  { kind: 'deny', info: 'downstream denied protected write', displayReason: 'Keep downstream denial' },
  { kind: 'cancel', info: 'downstream cancelled protected write', displayReason: 'Keep downstream cancellation' },
]) test('GP8 real local protected-path ask preserves downstream ' + decision.kind + ' object', async () => {
  const handler = wire(config())[0][1]
  // A real protected write would ask locally; it must not replace the downstream ask/deny/cancel object.
  assert.strictEqual(await handler(call('locked'), () => decision), decision)
})
