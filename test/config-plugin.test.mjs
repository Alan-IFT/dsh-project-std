// Structural host-adapter simulation, NOT a real Host pipeline/sandbox proof.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, relative, sep } from 'node:path'
import { apply, validateConfig, inject } from '../lib/config_plugin.js'
import { sha256 } from '../lib/config-governance.js'
const ROOT=resolve('config-fake-root'), PROJECT=resolve(ROOT,'governance/project.yaml')
const before='budgets:\n  entry_lines: 10\n', strict='budgets:\n  entry_lines: 9\n', relaxed='budgets:\n  entry_lines: 11\n'
function harness(options={}) {
  const entries=new Map(), effects=[], events=[], listeners=[]; let generation=0
  const put=(path,type,text='')=>entries.set(resolve(path),{type,version:`v${++generation}`,size:Buffer.byteLength(text),bytes:Buffer.from(text)})
  put(ROOT,'directory'); put(resolve(ROOT,'governance'),'directory')
  if(!options.missing) put(PROJECT,'file',before)
  const controller=new AbortController(), exec={agent:{session:{header:{cwd:ROOT}}},signal:controller.signal,callId:'test-call',name:'std_config',arguments:{},deferContext(){},concludeTurn(){}}
  let onRead=()=>{}, onResolve=()=>{}, onStat=()=>{}
  const fs={
    sandboxMode:options.sandboxMode,
    async resolve(path,opts) { assert.equal(opts.cwd,exec.agent.session.header.cwd); assert.equal(opts.signal,controller.signal); onResolve(path); return {targetKey:resolve(opts.cwd,path),displayPath:resolve(opts.cwd,path)} },
    async lstat(path,opts,signal) { assert.equal(opts.cwd,exec.agent.session.header.cwd); assert.equal(opts.signal,signal); const e=entries.get(resolve(opts.cwd,path)); return e?{type:e.type,version:e.version,size:e.size}:undefined },
    async stat(target) { onStat(target); const e=entries.get(target.targetKey); return e?{type:e.type,version:e.version,size:e.size}:undefined },
    contains(parent,target) { const r=relative(parent.targetKey,target.targetKey); return r===''||r!=='..'&&!r.startsWith('..'+sep)&&!r.startsWith(sep) },
    async readBytes(target,signal,max) { assert.equal(max,32768); onRead(target); return entries.get(target.targetKey).bytes },
    async writeText(target,text,expected,signal,policy) {
      signal.throwIfAborted()
      // Synchronous critical section stands in for host target queue+CAS.
      const existing=entries.get(target.targetKey)
      if(expected.kind==='createIfAbsent' ? existing!==undefined : existing?.version!==expected.version) throw new Error('stale')
      if(policy?.mode==='read-only') throw new Error('sandbox denied')
      effects.push({target,text,expected,policy}); put(target.targetKey,'file',text)
      return {version:entries.get(target.targetKey).version}
    },
  }
  let definition, approval=options.approval, policy=options.policy
  const ctx={get(key){return key==='fs'?fs:key==='approval'?approval:key==='sandboxPolicy'?policy:undefined},tools:{register(d){definition=d}},on(...a){listeners.push(a)},emit(...a){events.push(a)}}
  apply(ctx,options.config)
  const call=(args,e=exec)=>definition.execute(args,e)
  const proposal=(text=relaxed)=>({action:'apply',content:text,before_sha256:options.missing?null:sha256(before),after_sha256:sha256(text)})
  return {entries,effects,events,listeners,exec,controller,fs,put,call,proposal,definition,setApproval(v){approval=v},setPolicy(v){policy=v},setRead(v){onRead=v},setResolve(v){onResolve=v},setStat(v){onStat=v}}
}
test('each registration keeps its own parameters and reject boundary (clone or freeze both satisfy)',async()=>{
  const a=harness(), b=harness()
  const before=JSON.stringify(b.definition.parameters)
  // 旧 defineTool 每次产出新对象。这里只断言行为，不锁定实现：深克隆与「冻结共享模板」都满足。
  try {
    a.definition.parameters.properties.root={type:'string'}
    a.definition.parameters.required.push('root')
  } catch { /* 冻结实现会抛 TypeError，同样满足不变量 */ }
  assert.equal(JSON.stringify(b.definition.parameters),before)
  assert.deepEqual(b.definition.parameters.required,['action'])
  // 白名单必须与交给宿主的对象解耦：改过 a 的 schema 也不能让 root 溜过拒收。
  await assert.rejects(b.call({action:'inspect',root:'.'}),/不支持参数 root/)
  await assert.rejects(a.call({action:'inspect',root:'.'}),/不支持参数 root/)
})
test('real defineTool registers with actual module DSL; nullable before SHA and open output',()=>{
  assert.deepEqual(inject,['tools','fs'])
  const h=harness(); assert.equal(h.definition.name,'std_config')
  assert.ok(h.definition.parameters.properties.before_sha256.oneOf)
  assert.deepEqual(validateConfig(),{enabled:true,protectNativeEdits:false})
  for(const v of [{enabled:'true'},{protectNativeEdits:1},{extra:true},[]]) assert.throws(()=>validateConfig(v))
  assert.throws(()=>apply({get(){},tools:{register(){}}}),/fs/)
})
test('inspect includes raw text/hash/validation and finite content-free artifacts with sources',async()=>{
  const h=harness(); h.put(resolve(ROOT,'AGENTS.md'),'file','do not read me')
  const read=[]; h.setRead(t=>read.push(t.targetKey))
  const r=await h.call({action:'inspect'})
  assert.equal(r.files[0].content,before); assert.equal(r.files[0].sha256,sha256(before)); assert.equal(r.files[0].validation.valid,true)
  assert.ok(r.artifacts.find(a=>a.path==='AGENTS.md'&&a.exists&&a.sources.includes('default:entry')))
  assert.deepEqual(read,[PROJECT]); assert.equal(h.effects.length,0); assert.equal(h.events.length,0)
})
test('strict/equivalent apply do not need approval service and emit actual CAS outcome',async()=>{
  for(const text of [strict,before+'# c\n']) {
    const h=harness(),r=await h.call(h.proposal(text))
    assert.equal(r.applied,true); assert.equal(h.effects.length,1)
    assert.deepEqual(h.effects[0].expected,{kind:'replaceIfVersion',version:'v3'})
    assert.equal(h.events[0][0],'fs/observed'); assert.equal(h.events[0][2].version,r.version)
  }
})
for(const decision of [undefined,'rejected','cancelled','never','unavailable','allowed','allow']) test(`needsApproval ${decision} yields zero effects`,async()=>{
  const h=harness({approval:decision===undefined?undefined:{async request(){return decision}}})
  await assert.rejects(h.call(h.proposal())); assert.equal(h.effects.length,0); assert.equal(h.events.length,0)
})
test('approval error/no open turn and abort after approval cannot write',async()=>{
  for(const mode of ['throw','abort']) {
    const h=harness(); h.setApproval({async request(){if(mode==='throw')throw new Error('no open turn');h.controller.abort();return 'allowed-once'}})
    await assert.rejects(h.call(h.proposal())); assert.equal(h.effects.length,0)
  }
})
test('approval reason contains actual values, hashes and scope; no token/cache authority',async()=>{
  const h=harness(); let calls=0
  h.setApproval({async request(input){calls++;assert.equal(input.toolName,'std_config');assert.equal(input.agent,h.exec.agent);const r=JSON.parse(input.reason);assert.equal(r.root,ROOT);assert.equal(r.path,'governance/project.yaml');assert.equal(r.before_sha256,sha256(before));assert.equal(r.changes[0].before.value,10);assert.equal(r.changes[0].after.value,11);return 'allowed-once'}})
  assert.equal((await h.call(h.proposal())).applied,true);assert.equal(calls,1)
})
test('reject root/approved/permission/unknown and missing hashes before effects',async()=>{
  for(const extra of [{root:ROOT},{approved:true},{permission:'full'},{candidate:relaxed},{unknown:1}]) {
    const h=harness();await assert.rejects(h.call({...h.proposal(),...extra}));assert.equal(h.effects.length,0)
  }
  for(const key of ['before_sha256','after_sha256']){const h=harness();const a=h.proposal();delete a[key];await assert.rejects(h.call(a));assert.equal(h.effects.length,0)}
})
test('no agent/root even strict apply rejected',async()=>{
  for(const mutate of [e=>delete e.agent,e=>delete e.agent.session.header.cwd,e=>e.agent.session.header.cwd='relative']) {
    const h=harness();mutate(h.exec);await assert.rejects(h.call(h.proposal(strict)));assert.equal(h.effects.length,0)
  }
})
// Managed-target drift (existence/type/version/bytes/targetKey) vs parent identity/type drift. Directory version/size churn is NOT drift (see below).
const GOV=resolve(ROOT,'governance'), rekey=(h,match)=>{const original=h.fs.resolve;h.fs.resolve=async(p,o)=>{const t=await original(p,o);return resolve(p)===match?{...t,targetKey:t.targetKey+'-changed'}:t}}
for(const change of ['bytes','sameBytesVersion','candidate','targetkey','cwd','exceptionsAppears','governanceRemoved','governanceKey','rootKey']) test(`approved snapshot ${change} drift stops without retry`,async()=>{
  const h=harness()
  h.setApproval({async request(){
    if(change==='bytes')h.put(PROJECT,'file','tier: L1\n')
    if(change==='sameBytesVersion')h.put(PROJECT,'file',before)
    if(change==='candidate')h.put(resolve(ROOT,'governance/project.yml'),'file','tier: L1\n')
    if(change==='cwd')h.exec.agent.session.header.cwd=resolve(ROOT,'other')
    if(change==='targetkey')rekey(h,PROJECT)
    if(change==='exceptionsAppears')h.put(resolve(GOV,'exceptions.md'),'file','x')
    if(change==='governanceRemoved')h.entries.delete(GOV)
    if(change==='governanceKey')rekey(h,GOV)
    if(change==='rootKey')rekey(h,ROOT)
    return 'allowed-once'
  }})
  await assert.rejects(h.call(h.proposal()));assert.equal(h.effects.length,0)
})
test('drift errors distinguish managed-target drift from parent identity/type change',async()=>{
  const m=harness();m.setApproval({async request(){m.put(PROJECT,'file',before);return 'allowed-once'}})
  await assert.rejects(m.call(m.proposal()),/受管配置／例外目标的存在性、类型、版本或原字节发生漂移/);assert.equal(m.effects.length,0)
  const p=harness();p.setApproval({async request(){rekey(p,GOV);return 'allowed-once'}})
  await assert.rejects(p.call(p.proposal()),/cwd／root／governance 的身份或类型发生变化/);assert.equal(p.effects.length,0)
  const r=harness();r.setApproval({async request(){r.entries.delete(GOV);return 'allowed-once'}})
  await assert.rejects(r.call(r.proposal()),/cwd／root／governance 的身份或类型发生变化/);assert.equal(r.effects.length,0)
})
test('unrelated directory version churn during approval does not void a human-approved write',async()=>{
  for(const churn of ['governanceVersion','rootVersion','siblingFile','rootSibling']) {
    const h=harness()
    h.setApproval({async request(){
      if(churn==='governanceVersion')h.put(GOV,'directory')
      if(churn==='rootVersion')h.put(ROOT,'directory')
      if(churn==='siblingFile'){h.put(resolve(GOV,'notes.txt'),'file','unrelated');h.put(GOV,'directory')}
      if(churn==='rootSibling'){h.put(resolve(ROOT,'scratch.tmp'),'file','x');h.put(ROOT,'directory')}
      return 'allowed-once'
    }})
    const r=await h.call(h.proposal());assert.equal(r.applied,true,churn);assert.equal(h.effects.length,1,churn);assert.equal(h.effects[0].text,relaxed)
    assert.deepEqual(h.effects[0].expected,{kind:'replaceIfVersion',version:'v3'})
  }
})
test('stable stat/read/stat refuses concurrent read mutation',async()=>{
  const h=harness();h.setRead(()=>h.put(PROJECT,'file',before))
  await assert.rejects(h.call({action:'inspect'}),/读取期间变化/);assert.equal(h.effects.length,0)
})
for(const type of ['directory','symlink','other']) test(`dual candidate ${type} counts conflict for both targets`,async()=>{
  const h=harness();h.put(resolve(ROOT,'governance/project.yml'),type)
  assert.equal((await h.call({action:'inspect'})).conflict,true)
  for(const target of ['project','exceptions']) {
    const r=await h.call({action:'review',target,content:strict});assert.equal(r.valid,false);assert.equal(r.conflict,true)
    await assert.rejects(h.call({...h.proposal(strict),target}));assert.equal(h.effects.length,0)
  }
})
test('missing target before=null can be approved, but governance absent cannot create parents',async()=>{
  const h=harness({missing:true,approval:{async request(){return 'allowed-once'}}})
  assert.equal((await h.call(h.proposal(strict))).applied,true);assert.deepEqual(h.effects[0].expected,{kind:'createIfAbsent'})
  const g=harness({missing:true});g.entries.delete(resolve(ROOT,'governance'))
  assert.equal((await g.call({action:'inspect'})).governanceExists,false)
  await assert.rejects(g.call(g.proposal(strict)),/父目录/);assert.equal(g.effects.length,0)
})
for(const type of ['symlink','directory','other']) test(`target ${type} never writes`,async()=>{
  const h=harness();h.put(PROJECT,type);await assert.rejects(h.call(h.proposal()));assert.equal(h.effects.length,0)
})
test('current sandbox is resolved after approval without overrides, missing policy fails closed',async()=>{
  const h=harness({sandboxMode:'workspace-write'});let policyCalls=0,mode='workspace-write'
  h.setPolicy({resolve(input){policyCalls++;assert.deepEqual(Object.keys(input),['session']);assert.equal(input.session,h.exec.agent.session);return {mode}}})
  h.setApproval({async request(){mode='read-only';return 'allowed-once'}})
  await assert.rejects(h.call(h.proposal()),/sandbox denied/);assert.equal(policyCalls,1);assert.equal(h.effects.length,0)
  const m=harness({sandboxMode:'workspace-write'});await assert.rejects(m.call(m.proposal(strict)),/sandboxPolicy/);assert.equal(m.effects.length,0)
})
test('same-key concurrent proposals have one CAS winner and one stale failure',async()=>{
  const h=harness();const results=await Promise.allSettled([h.call(h.proposal(strict)),h.call(h.proposal(strict))])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(h.effects.length,1)
})
test('read cap/UTF8 and candidate unicode failures have no write/approval effects',async()=>{
  const h=harness();h.put(PROJECT,'file','中'.repeat(10923));assert.ok((await h.call({action:'inspect'})).files[0].problem)
  await assert.rejects(h.call(h.proposal()));assert.equal(h.effects.length,0)
  const bad=harness();bad.entries.get(PROJECT).bytes=Uint8Array.of(255);assert.ok((await bad.call({action:'inspect'})).files[0].problem)
  await assert.rejects(bad.call(bad.proposal()));await assert.rejects(bad.call({action:'review',content:'\ud800'}))
})
test('captured content cannot drift through mutable caller args during approval',async()=>{
  const h=harness(),args=h.proposal();h.setApproval({async request(){args.content='tier: L3\n';args.target='exceptions';return 'allowed-once'}})
  const r=await h.call(args);assert.equal(r.applied,true);assert.equal(h.effects[0].text,relaxed);assert.equal(h.effects[0].target.targetKey,PROJECT)
})
test('root/governance links and host containment refusal cannot reach writes',async()=>{
  for(const path of [ROOT,resolve(ROOT,'governance')]) {
    const h=harness();h.put(path,'symlink');await assert.rejects(h.call(h.proposal(strict)));assert.equal(h.effects.length,0)
  }
  const h=harness();h.fs.contains=()=>false;await assert.rejects(h.call(h.proposal(strict)),/越出/);assert.equal(h.effects.length,0)
})
test('abort immediately after read prevents review and all effects',async()=>{
  const h=harness();h.setRead(()=>h.controller.abort());await assert.rejects(h.call({action:'review',content:strict}));assert.equal(h.effects.length,0);assert.equal(h.events.length,0)
})
test('native canonical alias uses host identity and refuses the known target only',async()=>{
  const h=harness({config:{protectNativeEdits:true}}),original=h.fs.resolve
  h.fs.resolve=async(p,o)=>resolve(p)===resolve(ROOT,'alias.yaml')?{targetKey:PROJECT,displayPath:p}:original(p,o)
  const handler=h.listeners[0][1]
  assert.equal((await handler({...h.exec,name:'write',arguments:{file_path:resolve(ROOT,'alias.yaml')}},async()=>({kind:'allow'}))).kind,'deny')
})
test('approval reason refuses JSON escaping expansion over cap without truncation or asking',async()=>{
  const h=harness(); const a='custom: '+ '\u0001'.repeat(15000)+'\n',b='custom: '+ '\u0002'.repeat(15000)+'\n';h.put(PROJECT,'file',a)
  let asked=0;h.setApproval({async request(){asked++;return 'allowed-once'}})
  await assert.rejects(h.call({action:'apply',content:b,before_sha256:sha256(a),after_sha256:sha256(b)}),/131072/)
  assert.equal(asked,0);assert.equal(h.effects.length,0)
})
test('exceptions uses same guarded approval seam with actual full texts',async()=>{
  const h=harness();const path=resolve(ROOT,'governance/exceptions.md')
  const header='| 规则 | 到期 | 状态 |\n|---|---|---|\n',beforeText=header+'| G6 | bad | closed |\n',afterText=beforeText+'\nexplanation\n';h.put(path,'file',beforeText)
  h.setApproval({async request(input){const r=JSON.parse(input.reason);assert.equal(r.beforeText,undefined);assert.equal(r.afterText,undefined);assert.equal(r.changes[0].before.value,beforeText);assert.equal(r.changes[0].after.value,afterText);return 'allowed-once'}})
  const r=await h.call({action:'apply',target:'exceptions',content:afterText,before_sha256:sha256(beforeText),after_sha256:sha256(afterText)})
  assert.equal(r.applied,true);assert.equal(h.effects[0].target.targetKey,path)
})
test('raw BOM/CRLF baseline identity is checked and preserved in review hashes',async()=>{
  const h=harness();const raw='\ufeff'+before.replaceAll('\n','\r\n');h.put(PROJECT,'file',raw)
  const review=await h.call({action:'review',content:strict});assert.equal(review.beforeSha256,sha256(Buffer.from(raw)));assert.equal(review.changes[0].direction,'tighten')
  const r=await h.call({action:'apply',content:strict,before_sha256:review.beforeSha256,after_sha256:review.afterSha256});assert.equal(r.applied,true)
})
test('native guard opt-in only, preserves downstream decisions; mutating editor only',async()=>{
  assert.equal(harness().listeners.length,0)
  const h=harness({config:{protectNativeEdits:true}}),handler=h.listeners[0][1]
  const decision={kind:'deny',reason:'prior'}
  assert.equal(await handler({...h.exec,name:'write',arguments:{file_path:PROJECT}},async()=>decision),decision)
  for(const [name,args,expected] of [['write',{file_path:PROJECT},'deny'],['edit',{file_path:'governance/exceptions.md'},'deny'],['str_replace_editor',{command:'view',path:PROJECT},'allow'],['str_replace_editor',{command:'str_replace',path:PROJECT},'deny'],['write',{file_path:'src/app.ts'},'allow'],['write',{file_path:33},'allow'],['pwsh',{command:'opaque'},'allow']]) {
    assert.equal((await handler({...h.exec,name,arguments:args},async()=>({kind:'allow'}))).kind,expected)
  }
  for(const kind of ['ask','cancel']){const d={kind,reason:'prior'};assert.equal(await handler({...h.exec,name:'write',arguments:{file_path:PROJECT}},async()=>d),d)}
})

test('exceptions near per-text cap (~31900 B each, legal tables) still reach approval and write; reason stays under cap',async()=>{
  const h=harness();const path=resolve(ROOT,'governance/exceptions.md')
  const due=new Date(Date.now()+30*864e5).toISOString().slice(0,10)
  const header='| 编号 | 规则 | 理由 | 范围 | 批准人 | 到期 | 状态 |\n|---|---|---|---|---|---|---|\n',row=`| G1 | G1 | r | s | a | ${due} | 关闭 |\n`
  let beforeText=header;while(Buffer.byteLength(beforeText+row)<=31900)beforeText+=row
  const afterText=beforeText+row
  assert.ok(Buffer.byteLength(beforeText)>=31850&&Buffer.byteLength(afterText)<=32768)
  h.put(path,'file',beforeText);let asked=0,reasonBytes=0
  h.setApproval({async request(input){asked++;reasonBytes=Buffer.byteLength(input.reason,'utf8');return 'allowed-once'}})
  const r=await h.call({action:'apply',target:'exceptions',content:afterText,before_sha256:sha256(beforeText),after_sha256:sha256(afterText)})
  assert.equal(r.applied,true);assert.equal(asked,1);assert.equal(h.effects.length,1);assert.ok(reasonBytes>0&&reasonBytes<=131072,String(reasonBytes))
})
test('write committed then abort: apply still reports applied and emits fs/observed once with actual version',async()=>{
  const h=harness({approval:{async request(){return 'allowed-once'}}}),original=h.fs.writeText
  h.fs.writeText=async(...a)=>{const out=await original(...a);h.controller.abort();return out}
  const r=await h.call(h.proposal())
  assert.equal(r.applied,true);assert.equal(h.effects.length,1)
  const observed=h.events.filter(e=>e[0]==='fs/observed');assert.equal(observed.length,1)
  assert.equal(observed[0][2].version,r.version);assert.equal(observed[0][2].kind,'present')
})
test('abort before write (after policy/approval) still prevents the write',async()=>{
  const h=harness({approval:{async request(){h.controller.abort();return 'allowed-once'}}})
  await assert.rejects(h.call(h.proposal()));assert.equal(h.effects.length,0);assert.equal(h.events.length,0)
})
test('str_replace_editor is a blacklist: only view passes; unknown/missing/non-string command on managed paths denied',async()=>{
  const h=harness({config:{protectNativeEdits:true}}),handler=h.listeners[0][1]
  const run=(args)=>handler({...h.exec,name:'str_replace_editor',arguments:args},async()=>({kind:'allow'}))
  for(const p of [PROJECT,'governance/exceptions.md','governance/project.yml']) {
    assert.equal((await run({command:'view',path:p})).kind,'allow')
    for(const command of ['write_file','create','str_replace','insert','undo_edit','VIEW','',null,7,{},['view']]) assert.equal((await run({command,path:p})).kind,'deny',String(command))
    assert.equal((await run({path:p})).kind,'deny')
  }
  assert.equal((await run({command:'write_file',path:'src/app.ts'})).kind,'allow')
  assert.equal((await run({path:'src/app.ts'})).kind,'allow')
})
test('Config schema export: unusable schemastery only omits mount-time schema; validateConfig behaviour unchanged',async()=>{
  const mod=await import('../lib/config_plugin.js')
  assert.ok(mod.Config===undefined||typeof mod.Config==='object'||typeof mod.Config==='function')
  assert.deepEqual(validateConfig({enabled:false}),{enabled:false,protectNativeEdits:false})
  assert.throws(()=>validateConfig({extra:1}),/未知 config/)
})
test('buildConfig: any unusable schemastery omits the mount-time schema instead of breaking the entry (real createRequire)',async()=>{
  const { buildConfig }=await import('../lib/config_plugin.js')
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync }=await import('node:fs')
  const { tmpdir }=await import('node:os')
  const { join }=await import('node:path')
  const { createRequire }=await import('node:module')
  const dir=mkdtempSync(join(tmpdir(),'std-schemastery-'))
  try {
    const project=(name,index)=>{const root=join(dir,name),pkg=join(root,'node_modules','@deepseek-ai','schemastery');writeFileSync(join(mkdirSync(root,{recursive:true})??root,'package.json'),'{"type":"commonjs"}');if(index!==undefined){mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'package.json'),'{"name":"@deepseek-ai/schemastery","main":"index.js"}');writeFileSync(join(pkg,'index.js'),index)}return createRequire(join(root,'entry.cjs'))}
    assert.equal(buildConfig(project('absent')),undefined)
    // 导入期抛错会让整个 /config 条目无法激活，而 apply 内无条件校验才是安全依据，因此损坏的包也只省略 schema。
    assert.equal(buildConfig(project('broken',"require('@deepseek-ai/schemastery/lib/core')\n")),undefined)
    const ok=buildConfig(project('ok',"module.exports={any:()=>({}),transform:(s,f)=>({validator:f})}\n"))
    assert.equal(ok.validator,validateConfig)
    const missingMain=project('missing-main','')
    writeFileSync(join(dir,'missing-main','node_modules','@deepseek-ai','schemastery','package.json'),'{"name":"@deepseek-ai/schemastery","main":"dist/index.js"}')
    rmSync(join(dir,'missing-main','node_modules','@deepseek-ai','schemastery','index.js'))
    assert.equal(buildConfig(missingMain),undefined)
    assert.equal(buildConfig(project('wrong-shape',"module.exports={}\n")),undefined)
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
