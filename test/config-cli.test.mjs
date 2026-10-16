import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { main, parseArgs } from '../lib/main.js'
import { parseConfigReviewArgs } from '../lib/config-cli.js'
import { sha256 } from '../lib/config-governance.js'
// Owned workspace fixture paths, not system TEMP. Every cleanup checks the created absolute prefix.
const base=resolve('.staging');mkdirSync(base,{recursive:true})
function fixture(fn) {
  const dir=mkdtempSync(join(base,'config-cli-'));const root=join(dir,'project'),candidate=join(dir,'proposal.yaml')
  mkdirSync(join(root,'governance'),{recursive:true})
  writeFileSync(join(root,'governance/project.yaml'),'\ufeffbudgets:\r\n  entry_lines: 10\r\n')
  writeFileSync(candidate,'budgets:\n  entry_lines: 9\n')
  try {return fn({dir,root,candidate})} finally {assert.ok(dir.startsWith(base+requireSep()));rmSync(dir,{recursive:true,force:false})}
}
const requireSep=()=>process.platform==='win32'?'\\':'/'
function run(args) {const out=[],err=[];const code=main(args,undefined,{out:t=>out.push(t),err:t=>err.push(t)});return {out,err,code}}
test('legacy parseArgs object shape unchanged and old check/migrate reject new flags',()=>{
  assert.deepEqual(Object.keys(parseArgs([])),['root','selftest','json','noScope','config','migrate'])
  for(const prefix of [[],['migrate']])for(const flag of ['--candidate','--target'])assert.equal(run([...prefix,'.',flag,'anything']).code,2)
})
for(const args of [[],['--candidate='],['--candidate',''],['--candidate','--json'],['--candidate','x','--candidate=y'],['--candidate','x','--json','--json'],['--candidate','x','--target'],['--candidate','x','--target='],['--candidate','x','--target=no'],['--candidate','x','--target=project','--target=exceptions'],['--candidate','x','--approved'],['--candidate','x','--apply'],['--candidate','x','--config','other'],['--candidate','x','--selftest'],['a','b','--candidate','x']])test(`strict config-review parser rejects ${JSON.stringify(args)}`,()=>{
  assert.equal(typeof parseConfigReviewArgs(args),'string');assert.equal(run(['config-review',...args]).code,2)
})
test('explicit external candidate accepted read-only, raw baseline BOM/CRLF hash retained',()=>fixture(({root,candidate})=>{
  const file=join(root,'governance/project.yaml'),bytes=readFileSync(file),proposal=readFileSync(candidate)
  const r=run(['config-review',root,'--candidate',candidate,'--json']);assert.equal(r.code,0);assert.deepEqual(r.err,[])
  const review=JSON.parse(r.out[0]);assert.equal(review.valid,true);assert.equal(review.needsApproval,false);assert.equal(review.beforeSha256,sha256(bytes));assert.equal(review.afterSha256,sha256(proposal));assert.equal(review.changes[0].direction,'tighten')
  assert.deepEqual(readFileSync(file),bytes);assert.deepEqual(readFileSync(candidate),proposal)
  const text=run(['config-review',root,'--candidate',candidate]);assert.equal(text.code,0);assert.match(text.out[0],/\n  before=/);assert.match(text.out[0],/"value":10/);assert.match(text.out[0],/"value":9/)
}))
test('missing baseline yields explicit null and not an approval receipt',()=>fixture(({root,candidate})=>{
  const file=join(root,'governance/project.yaml');assert.equal(resolve(file),join(root,'governance/project.yaml'));rmSync(file)
  const r=run(['config-review',root,'--candidate',candidate,'--json']);assert.equal(r.code,0)
  const review=JSON.parse(r.out[0]);assert.equal(review.beforeSha256,null);assert.equal(review.needsApproval,true);assert.equal('applied' in review,false)
}))
test('dual candidate directory conflicts for project and exceptions',()=>fixture(({root,candidate})=>{
  mkdirSync(join(root,'governance/project.yml'))
  for(const target of ['project','exceptions']) {const r=run(['config-review',root,'--candidate',candidate,'--target',target,'--json']);assert.equal(r.code,2);assert.equal(JSON.parse(r.out[0]).valid,false)}
}))
test('bounded regular candidate and invalid UTF8 baseline rejected',()=>fixture(({root,candidate})=>{
  writeFileSync(candidate,'中'.repeat(10923));assert.equal(run(['config-review',root,'--candidate',candidate]).code,2)
  writeFileSync(candidate,'tier: L1\n');writeFileSync(join(root,'governance/project.yaml'),Uint8Array.of(255));assert.equal(run(['config-review',root,'--candidate',candidate]).code,2)
  assert.equal(run(['config-review',root,'--candidate',root]).code,2)
}))
test('CLI baseline symlink and candidate symlink are not followed',()=>fixture(({dir,root,candidate})=>{
  const linked=join(dir,'linked.yaml');symlinkSync(candidate,linked,'file')
  assert.equal(run(['config-review',root,'--candidate',linked]).code,2)
  const baseline=join(root,'governance/project.yaml');assert.equal(resolve(baseline),join(root,'governance/project.yaml'));rmSync(baseline);symlinkSync(candidate,baseline,'file')
  assert.equal(run(['config-review',root,'--candidate',candidate]).code,2)
}))
