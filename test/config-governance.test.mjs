import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewProject, reviewExceptions, sha256, decodeRaw, assertText } from '../lib/config-governance.js'
import { parseExceptionsText } from '../lib/core/exceptions.js'

const keys = ['entry_lines','stale_days','work_item_stale_days','status_lines','handoff_lines','work_item_lines','module_lines','duplicate_min_lines','duplicate_min_chars']
const budget = (key, value) => `budgets:\n  ${key}: ${value}\n`
for (const key of keys) {
  for (const [after, direction, approval] of [[11,'relax',true],[9,'tighten',false]]) test(`${key}: 10→${after} ${direction}`, () => {
    const r=reviewProject(budget(key,after),budget(key,10),'before')
    assert.equal(r.valid,true); assert.equal(r.needsApproval,approval)
    assert.deepEqual(r.changes.map(c=>[c.path,c.direction]),[[`/budgets/${key}`,direction]])
    assert.deepEqual(r.changes[0].before,{present:true,value:10})
  })
  for (const [a,b] of [[null,10],[10,null],['missing',10],[10,'missing'],[0,10],[-1,10],[9007199254740992,10]]) test(`${key}: no comparable declaration ${a}→${b}`,()=>{
    const text=v=>v==='missing'?'budgets:\n':budget(key,v)
    const r=reviewProject(text(b),text(a),'before')
    // Invalid duplicate thresholds stay invalid, never gain a schema-based rescue.
    if(r.valid) { assert.ok(r.changes.every(c=>c.direction==='unknown')); assert.equal(r.needsApproval,true) }
    else { assert.ok(key.startsWith('duplicate') || a === 9007199254740992); assert.ok(r.problem) }
  })
}
test('literal dotted/slashed/tilde keys cannot collide with nested keys',()=>{
  const r=reviewProject('budgets.entry_lines: 11\nbudgets:\n  entry_lines: 9\nx/y~z: 2\n','budgets.entry_lines: 10\nbudgets:\n  entry_lines: 10\nx/y~z: 1\n','before')
  assert.deepEqual(r.changes.map(c=>[c.path,c.direction]),[['/budgets/entry_lines','tighten'],['/budgets.entry_lines','unknown'],['/x~1y~0z','unknown']])
  assert.equal(r.needsApproval,true); assert.doesNotThrow(()=>JSON.parse(JSON.stringify(r)))
})
test('container/null/array/presence changes survive without undefined evidence',()=>{
  const r=reviewProject('custom:\n  child: 1\narray:\n  - a\n','custom: null\narray:\n  - b\nempty:\n','before')
  assert.deepEqual(r.changes.map(c=>c.path),['/array','/custom','/empty'])
  assert.deepEqual(r.changes[2].after,{present:false})
  assert.ok(r.changes.every(c=>c.direction==='unknown'))
  assert.equal(JSON.stringify(r).includes('undefined'),false)
})
test('mapping order and comments equivalent, declared defaults deletion unknown',()=>{
  assert.deepEqual(reviewProject('# c\nb: 2\na: 1\n','a: 1\nb: 2\n','before').changes,[])
  assert.equal(reviewProject('tier: L1\n','tier: L1\nbudgets:\n  entry_lines: 150\n','before').changes[0].direction,'unknown')
})
test('non-budget fields always unknown and mixed changes never offset',()=>{
  const a='budgets:\n  entry_lines: 10\n  stale_days: 10\nlayout:\n  frozen:\n    - a\n'
  const b='budgets:\n  entry_lines: 9\n  stale_days: 11\nlayout:\n  frozen:\n    - a/b\n'
  const r=reviewProject(b,a,'before')
  assert.deepEqual(r.changes.map(c=>c.direction),['tighten','relax','unknown']); assert.equal(r.needsApproval,true)
  for(const key of ['metadata_fields','metadata_required','aliases','repos','derived','tailoring','compatibility','rootrolemap','unknown']) {
    const r=reviewProject(`${key}:\n`,`${key}:\n`,'b'); assert.equal(r.valid,true)
  }
})
test('first missing is explicit unknown; invalid old baseline never becomes empty',()=>{
  const first=reviewProject('tier: L1\n',null,null)
  assert.equal(first.needsApproval,true); assert.deepEqual(first.changes[0].before,{present:false})
  assert.equal(reviewProject('tier: L1\n','bad: [','b').valid,false)
})
test('governance rejects nonfinite values and lone surrogates without changing loader',()=>{
  assert.equal(reviewProject('custom: '+ '9'.repeat(400)+'.0\n',null,null).valid,false)
  assert.equal(reviewProject('custom: \ud800\n',null,null).valid,false)
  assert.throws(()=>assertText('\udc00')); assert.throws(()=>decodeRaw(Uint8Array.of(0xff)))
  assert.throws(()=>assertText('中'.repeat(10923)))
})
test('raw BOM CRLF hash survives while parse strips only one BOM',()=>{
  const a='\ufefftier: L1\r\n', b='tier: L1\n'
  const r=reviewProject(b,a,sha256(a)); assert.equal(r.valid,true); assert.deepEqual(r.changes,[])
  assert.notEqual(r.beforeSha256,r.afterSha256); assert.equal(decodeRaw(Buffer.from(a)),a)
})
const header='| 编号 | 规则 | 理由 | 范围 | 批准人 | 到期 | 状态 |\n|---|---|---|---|---|---|---|\n'
const date=new Date(); date.setDate(date.getDate()+7); const until=date.toISOString().slice(0,10)
const valid=header+`| E1 | layout/missing | reason | docs | owner | ${until} | open |\n`
test('exceptions actual before/after text, byte-only changes require approval',()=>{
  const r=reviewExceptions(valid+'\n',valid,'b')
  assert.equal(r.valid,true); assert.equal(r.needsApproval,true); assert.equal(r.changes[0].before.value,valid); assert.equal(r.changes[0].after.value,valid+'\n')
  assert.equal(reviewExceptions(valid,valid,'b').needsApproval,false)
  assert.equal(reviewExceptions(valid,null,null).needsApproval,true)
})
for(const [label,text] of [['missing table','no table'],['missing date',header+'| E1 | x/y | r | d | o | | open |\n'],['internal',header+`| E1 | x/internal-error | r | d | o | ${until} | open |\n`],['own date',header+'| E1 | G6 | r | d | o | garbage | open |\n'],['duplicate header',valid.replace('批准人','理由批准人')]]) test(`exceptions rejects ${label} new and old`,()=>{
  assert.equal(reviewExceptions(text,valid,'b').valid,false)
  assert.equal(reviewExceptions(valid,text,'b').valid,false)
})
test('first table and closed-first original consumer semantics retained',()=>{
  const text=header+'| E1 | x/internal-error | | | | invalid | closed |\n'
  assert.equal(reviewExceptions(text+'\n'+valid,text,'b').valid,true)
  assert.deepEqual(parseExceptionsText(text).slice(0,2),[[],[]])
  assert.equal(reviewExceptions('no table\n'+valid,valid,'b').valid,true)
})
