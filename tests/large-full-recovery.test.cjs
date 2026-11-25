'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomBytes,createHash,createCipheriv,scryptSync}=require('node:crypto'),{gzipSync}=require('node:zlib'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const key=Buffer.alloc(32,17).toString('base64'),otherKey=Buffer.alloc(32,19).toString('base64'),passphrase='large fixture backup password';
const names=['pageposter.sqlite','generation-runs.sqlite','ai-budget.sqlite'];
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-large-recovery-')),src=path.join(dir,'source');fs.mkdirSync(src);
 const {createStore}=await import('../server/lifecycle/store.mjs'),{createRunStore}=await import('../server/lifecycle/run-store.mjs'),{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs'),{createSecretBox}=await import('../server/lifecycle/secrets.mjs');
 const store=createStore({filename:path.join(src,names[0]),masterKey:key}),runs=createRunStore({filename:path.join(src,names[1])}),budget=createAIBudget({filename:path.join(src,names[2])});let closed=false;
 const close=()=>{if(!closed){closed=true;store.close();runs.close();budget.close();}};
 t.after(()=>{close();fs.rmSync(dir,{recursive:true,force:true});});
 const project=store.createProject({name:'Large recovery',description:'All metadata survives',tags:['large-html'],workflowType:'html'}),site=store.createSite(project.id,{name:'Protected fixture',baseUrl:'https://example.org',username:'fixture-user',applicationPassword:'fixture-site-secret'});
 return {dir,src,store,runs,budget,project,site,close,createStore,createRunStore,createSecretBox};
}
function seal(payload,version){
 const salt=Buffer.alloc(16,31),iv=Buffer.alloc(12,37),derived=scryptSync(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}),cipher=createCipheriv('aes-256-gcm',derived,iv);cipher.setAAD(Buffer.from('PagePoster full recovery v'+version));
 const json=Buffer.from(JSON.stringify(payload)),bytes=Buffer.concat([cipher.update(version===1?gzipSync(json):json),cipher.final()]);derived.fill(0);
 return {kind:'pageposter-full-encrypted-backup',version,kdf:'scrypt-32768-8-1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:bytes.toString('base64')};
}
function payloadFor(f,version){return {version,createdAt:'2026-10-26T12:00:00.000Z',masterKey:key,files:names.map(name=>{const bytes=fs.readFileSync(path.join(f.src,name));return {name,sha256:createHash('sha256').update(bytes).digest('hex'),...(version===2?{encoding:'gzip',size:bytes.length}:{}),data:(version===2?gzipSync(bytes):bytes).toString('base64')};})};}

async function largeRoundTrip(t){
 const f=await fixture(t),api=await import('../server/lifecycle/full-recovery.mjs'),selected=new Map();
 // Each valid HTML page is just below the importer limit. Immutable page_versions
 // also stores its config, reproducing a database above the previous 100 MiB limit.
 for(let i=0;i<110;i++){
  const prefix='<!doctype html><html><body><h1>Page '+i+'</h1>',suffix='</body></html>',block='<section><h2>Useful fixture content</h2><p>'+randomBytes(192).toString('base64')+'</p></section>',content=block.repeat(Math.floor((489934-prefix.length-suffix.length)/block.length)),html=prefix+content+' '.repeat(489934-prefix.length-content.length-suffix.length)+suffix;
  assert.equal(Buffer.byteLength(html),489934);
  const p=f.store.createPage(f.project.id,{title:'Large '+i,keyword:'keyword '+i,siteId:f.site.id,fullUrl:'https://example.org/large-'+i+'/',config:{contentMode:'html',importHtml:html}});if([0,37,109].includes(i))selected.set(p.id,{html,title:p.title,keyword:p.keyword});
 }
 const job=f.store.enqueueJob({projectId:f.project.id,siteId:f.site.id,type:'site_check',idempotencyKey:'large-read'}),run=f.runs.createRun({projectId:f.project.id,idempotencyKey:'large-generation',spec:{pageId:selected.keys().next().value,sourceRevision:1,siteId:f.site.id,status:'draft',batches:[],generation:{config:{title:'Queued fixture'}}}});
 const active=f.runs.claimRun({workerId:'fixture-worker'});assert.equal(active.id,run.id);
 const credentials={username:'google-oauth',applicationPassword:JSON.stringify({refreshToken:'fixture-refresh-secret'})};fs.writeFileSync(path.join(f.src,'google-oauth.json'),JSON.stringify(f.createSecretBox(key).encrypt('pageposter:google-oauth:v1',credentials)));
 f.close();assert.ok(fs.statSync(path.join(f.src,names[0])).size>100*1024*1024);
 const archive=await api.exportFullBackup({dataDir:f.src,masterKey:key,passphrase});assert.equal(archive.version,2);assert.ok(Buffer.byteLength(JSON.stringify(archive))<150*1024*1024);assert.doesNotMatch(JSON.stringify(archive),/fixture-site-secret|fixture-refresh-secret|Useful fixture content/);
 const inspection=await api.inspectFullBackup({backup:archive,passphrase});assert.equal(inspection.summary.pages,110);assert.equal(inspection.summary.jobs,1);assert.equal(inspection.summary.runs,1);
 const target=path.join(f.dir,'restored');fs.mkdirSync(target);const result=await api.restoreFullBackup({dataDir:target,masterKey:otherKey,backup:archive,passphrase});assert.equal(result.summary.pages,110);
 const restored=f.createStore({filename:path.join(target,names[0]),masterKey:otherKey}),restoredRuns=f.createRunStore({filename:path.join(target,names[1])});
 try{
  for(const [id,expected] of selected){const p=restored.getPage(id);assert.equal(p.config.importHtml,expected.html);assert.equal(p.versions[0].snapshot.config.importHtml,expected.html);assert.equal(p.title,expected.title);assert.equal(p.keyword,expected.keyword);}
  assert.deepEqual(restored.getProject(f.project.id).tags,['large-html']);assert.equal(restored.getProject(f.project.id).description,'All metadata survives');assert.equal(restored.getSiteCredentials(f.site.id).applicationPassword,'fixture-site-secret');assert.equal(restored.getSite(f.site.id).enabled,false);assert.equal(restored.getJob(job.id).state,'paused');assert.equal(restoredRuns.getRun(run.id).state,'uncertain');
  const envelope=JSON.parse(fs.readFileSync(path.join(target,'google-oauth.json'),'utf8'));assert.deepEqual(f.createSecretBox(otherKey).decrypt('pageposter:google-oauth:v1',envelope),credentials);assert.throws(()=>f.createSecretBox(key).decrypt('pageposter:google-oauth:v1',envelope));
 }finally{restored.close();restoredRuns.close();}
}
test('110 large valid HTML pages export, inspect and restore under a bounded JS heap', {timeout:90000},async t=>{
 if(process.env.PAGEPOSTER_LARGE_BACKUP_WORKER==='1')return largeRoundTrip(t);
 const env={...process.env,PAGEPOSTER_LARGE_BACKUP_WORKER:'1'};delete env.NODE_TEST_CONTEXT;
 const {stdout,stderr}=await promisify(execFile)(process.execPath,['--max-old-space-size=96','--test','--test-reporter=tap','--test-name-pattern=110 large valid',__filename],{env,timeout:85000,maxBuffer:1024*1024});assert.match(stdout,/# pass 1/);assert.doesNotMatch(stderr,/heap out of memory/);
});
test('legacy v1 archives restore under a new key and keep queued work paused',async t=>{
 const f=await fixture(t),api=await import('../server/lifecycle/full-recovery.mjs'),page=f.store.createPage(f.project.id,{title:'Legacy',siteId:f.site.id,config:{importHtml:'<h1>Legacy bytes</h1>'}}),job=f.store.enqueueJob({projectId:f.project.id,siteId:f.site.id,type:'site_check',idempotencyKey:'legacy-read'});f.close();
 const archive=seal(payloadFor(f,1),1),inspection=await api.inspectFullBackup({backup:archive,passphrase});assert.equal(inspection.summary.pages,1);
 const target=path.join(f.dir,'legacy');await api.restoreFullBackup({dataDir:target,masterKey:otherKey,backup:archive,passphrase});const s=f.createStore({filename:path.join(target,names[0]),masterKey:otherKey});try{assert.equal(s.getPage(page.id).config.importHtml,'<h1>Legacy bytes</h1>');assert.equal(s.getSiteCredentials(f.site.id).applicationPassword,'fixture-site-secret');assert.equal(s.getJob(job.id).state,'paused');}finally{s.close();}
});
test('v2 validates compressed sizes, hashes, paths, schemas and authentication before replacing an empty target',async t=>{
 const f=await fixture(t),api=await import('../server/lifecycle/full-recovery.mjs');f.close();
 assert.equal((await api.inspectFullBackup({backup:seal(payloadFor(f,2),2),passphrase})).summary.projects,1);
 const cases=[
  ['decompression exceeds declared size',p=>{p.files[0].size=1;p.files[0].data=gzipSync(Buffer.alloc(65536)).toString('base64');}],
  ['declared size exceeds total limit',p=>p.files[0].size=512*1024*1024+1],
  ['combined declared size exceeds total limit',p=>p.files.forEach(f=>f.size=200*1024*1024)],
  ['wrong exact size',p=>p.files[0].size++],
  ['wrong hash',p=>p.files[0].sha256='0'.repeat(64)],
  ['truncated gzip',p=>p.files[0].data=p.files[0].data.slice(0,-8)],
  ['unsafe path',p=>p.files[0].name='../pageposter.sqlite'],
  ['duplicate file',p=>p.files.push({...p.files[0]})],
  ['unexpected file',p=>p.files.push({...p.files[0],name:'unexpected.sqlite'})],
  ['missing database',p=>p.files.pop()],
  ['wrong schema',p=>{const bytes=Buffer.from('not a SQLite database');p.files[0]={name:names[0],encoding:'gzip',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data:gzipSync(bytes).toString('base64')};}]
 ];
 for(const [label,change] of cases){const target=path.join(f.dir,'reject-'+cases.findIndex(c=>c[0]===label));fs.mkdirSync(target);fs.writeFileSync(path.join(target,'sentinel'),'keep');const payload=payloadFor(f,2);change(payload);await assert.rejects(api.restoreFullBackup({dataDir:target,masterKey:otherKey,backup:seal(payload,2),passphrase}),{code:'BACKUP_INVALID'},label);assert.equal(fs.readFileSync(path.join(target,'sentinel'),'utf8'),'keep',label);assert.deepEqual(fs.readdirSync(target),['sentinel'],label);assert.equal(fs.readdirSync(f.dir).some(name=>name.startsWith('.pageposter-restore-')),false,label);}
 const archive=seal(payloadFor(f,2),2);await assert.rejects(api.inspectFullBackup({backup:archive,passphrase:'incorrect fixture passphrase'}),{code:'BACKUP_PASSWORD_INVALID'});
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',noncanonicalTag=archive.tag.slice(0,-3)+alphabet[alphabet.indexOf(archive.tag.at(-3))+1]+'==';
 for(const changed of [{...archive,version:1},{...archive,tag:Buffer.alloc(16).toString('base64')},{...archive,ciphertext:(archive.ciphertext[0]==='A'?'B':'A')+archive.ciphertext.slice(1)},{...archive,tag:noncanonicalTag}])await assert.rejects(api.inspectFullBackup({backup:changed,passphrase}),{code:'BACKUP_PASSWORD_INVALID'});
});
test('recovery form inspects v1 and v2 files, rejects newer formats and enforces the encoded file limit',async t=>{
 const {JSDOM}=require('jsdom'),dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../dist/autopilot.html'),'utf8'),{url:'http://localhost:8787',runScripts:'outside-only'});t.after(()=>dom.window.close());await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));
 const {window}=dom,doc=window.document,calls=[];window.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({summary:{createdAt:'2026-10-26T12:00:00Z',projects:1,pages:110,sites:1,runs:1,jobs:1,files:3},canRestore:false})};};window.eval(fs.readFileSync(path.join(__dirname,'../dist/autopilot-recovery.js'),'utf8'));
 for(const [version,size,accepted] of [[1,1024,true],[2,150*1024*1024,true],[3,1024,false],[2,150*1024*1024+1,false]]){
  const archive={kind:'pageposter-full-encrypted-backup',version,ciphertext:'fixture'},file={size,text:async()=>JSON.stringify(archive)},before=calls.length;Object.defineProperty(doc.getElementById('ap-backup-file'),'files',{configurable:true,value:[file]});doc.getElementById('ap-backup-import-password').value=passphrase;
  doc.getElementById('ap-backup-inspect-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length-before,accepted?1:0,'version '+version+', size '+size);if(accepted){assert.equal(calls.at(-1).body.backup.version,version);assert.match(doc.getElementById('ap-backup-counts').textContent,/Сторінок: 110/);}else assert.equal(doc.getElementById('ap-backup-review').hidden,true);
 }
});
test('inspection rejects an oversized credential file before loading or re-encrypting its JSON',async t=>{
 const f=await fixture(t),api=await import('../server/lifecycle/full-recovery.mjs');f.close();const payload=payloadFor(f,2),bytes=Buffer.alloc(1024*1024+1,120);payload.files.push({name:'google-oauth.json',encoding:'gzip',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data:gzipSync(bytes).toString('base64')});
 await assert.rejects(api.inspectFullBackup({backup:seal(payload,2),passphrase}),{code:'BACKUP_INVALID'});
});
