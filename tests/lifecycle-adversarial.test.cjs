'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const G=require('../dist/generator.js');
function gate(){let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);return{entered,release,run:async()=>{enter();await wait;return{layoutState:'ok',viewports:[]};}};}
async function fixture(t,{verifier,bridgeOverride,maxPages}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),{bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-adversarial-')),sent=[];
 const bridge=bridgeOverride||{submitOperation:async({operation})=>{sent.push(operation);return{operationId:operation.operationId,state:'completed',postId:77,postType:operation.postType,status:operation.status,contentHash:bridgeContentHash(operation),url:'https://example.com/?page_id=77',warnings:[]};}};
 const a=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,31).toString('base64'),bridgeClient:bridge,maxPages,browserVerifier:{verifyGenerated:verifier||(async()=>({layoutState:'ok',viewports:[]})),verifyPublished:async()=>({state:'unknown',evidence:'No isolated live browser'})},client:{checkPage:async()=>['wp_access','wp_status','wp_content','public','content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'Known fixture state'})),checkSite:async()=>({state:'ok'})}});
 t.after(async()=>{await a.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body,method=body===undefined?'GET':'POST')=>{const response=await a.handle(new Request('http://localhost:4317/api/lifecycle'+route,{method,headers:{Origin:'http://localhost:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return{status:response.status,body:await response.json()};};
 const p=(await q('/projects',{name:'P'})).body.project,site=(await q('/projects/'+p.id+'/sites',{name:'Site',baseUrl:'https://example.com',username:'editor',applicationPassword:'private-adversarial-password'})).body.site;
 const config=G.normalizeConfig({title:'Review page',cards:[{name:'Offer',url:'https://offer.example/?a=%2f&b=1',button:'View'}],moreCards:[],tiles:[],services:[],reviews:[],navLinks:[],sections:[],faq:[]});
 const page=(await q('/projects/'+p.id+'/pages',{title:'Page',config})).body.page;
 const queue=async(mode='draft')=>{const current=a.store.getPage(page.id),response=await q('/pages/'+page.id+'/publish',{siteId:site.id,mode,expectedRevision:current.revision,idempotencyKey:randomUUID()});assert.equal(response.status,202);return response.body.job;};
 return{a,q,p,site,page,config,sent,queue,dir};
}
test('pausing a running write during offline verification prevents a not-yet-started remote POST',async t=>{
 const hold=gate(),{a,q,sent,queue}=await fixture(t,{verifier:hold.run}),job=await queue(),running=a.tick({schedule:false});
 await hold.entered;
 const paused=await q('/jobs/'+job.id+'/pause',{});assert.equal(paused.status,200);assert.equal(sent.length,0);
 hold.release();await running;
 assert.equal(sent.length,0,'A pause committed before dispatch must prevent the remote write');
});
test('disabling a site while offline verification is pending prevents new remote publication',async t=>{
 const hold=gate(),{a,q,site,sent,queue}=await fixture(t,{verifier:hold.run});await queue();const running=a.tick({schedule:false});
 await hold.entered;
 const disabled=await q('/sites/'+site.id,{enabled:false,expectedRevision:site.revision},'PATCH');assert.equal(disabled.status,200);assert.equal(sent.length,0);
 hold.release();await running;
 assert.equal(sent.length,0,'A disabled site must be checked again immediately before remote dispatch');
});
test('a proved CAS conflict is terminal failure rather than an unknown remote write',async t=>{
 const {bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');
 const {a,q,p,page,queue}=await fixture(t,{bridgeOverride:{submitOperation:async({operation})=>{
  if(operation.kind==='create')return{state:'completed',operationId:operation.operationId,postId:77,postType:operation.postType,status:operation.status,contentHash:bridgeContentHash(operation),url:'https://example.com/?page_id=77'};
  // A concurrent WordPress save wins after the read precheck but before the atomic CAS.
  return{state:'conflict',operationId:operation.operationId,postId:77,postType:'page',status:'draft',contentHash:'f'.repeat(64),previousContentHash:'f'.repeat(64),url:'https://example.com/?page_id=77',warnings:[]};
 }}});
 await queue();await a.tick({schedule:false});
 const info=(await q('/pages/'+page.id+'/placements')).body,cta=info.placements.find(x=>x.role==='offer-cta');
 const proposed=(await q('/pages/'+page.id+'/proposals',{expectedRevision:info.pageRevision,changes:[{id:cta.id,url:'https://changed.example/?x=%2f',expectedUrl:cta.url,expectedAnchor:cta.anchor}]})).body.proposal;
 const confirmed=await q('/proposals/'+proposed.id+'/confirm',{expectedRevision:proposed.revision,confirmed:true});assert.equal(confirmed.status,202);
 const job=confirmed.body.job;await a.tick({schedule:false});
 assert.equal(a.store.getJob(job.id).state,'failed');
 assert.equal(a.store.getJob(job.id).error.code,'CONFLICT');assert.equal(a.store.listJobs(p.id).filter(j=>j.state==='uncertain').length,0);
});
test('manual page content changed during a real in-flight request survives remote acceptance',async t=>{
 let release,entered;const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const {bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');
 const {a,q,page,queue}=await fixture(t,{bridgeOverride:{submitOperation:async({operation})=>{entered();await wait;return{state:'completed',operationId:operation.operationId,postId:77,postType:operation.postType,status:operation.status,contentHash:bridgeContentHash(operation),url:'https://example.com/?page_id=77'};}}});
 const job=await queue(),running=a.tick({schedule:false});await started;
 const before=a.store.getPage(page.id),config={...before.config,intro:'Manual unsent revision'};
 const changed=await q('/pages/'+page.id,{config,expectedRevision:before.revision},'PATCH');assert.equal(changed.status,200);
 release();await running;
 const current=a.store.getPage(page.id);assert.equal(current.config.intro,'Manual unsent revision');assert.notEqual(current.remoteSnapshot.config.intro,current.config.intro);
 assert.equal(current.lifecycleState,'review_required');assert.equal(a.store.getJob(job.id).state,'completed');
});
test('the backup restore HTTP route accepts a valid backup produced by its own store beyond two MiB',async t=>{
 const {a,p,config,q}=await fixture(t);
 for(let i=0;i<55;i++)a.store.createPage(p.id,{title:'Page '+i,config:{...config,intro:'x'.repeat(20000)}});
 const backup=(await q('/backup')).body;
 assert.ok(Buffer.byteLength(JSON.stringify({backup}))>2*1024*1024);
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-adversarial-restore-'));
 const target=await createLifecycleService({dataDir:dir});t.after(async()=>{await target.close();fs.rmSync(dir,{recursive:true,force:true});});
 const response=await target.handle(new Request('http://localhost:4317/api/lifecycle/backup/restore',{method:'POST',headers:{Origin:'http://localhost:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},body:JSON.stringify({backup})}));
 assert.equal(response.status,201,'A valid exported project backup must be restorable');
 assert.equal(target.store.listPages(p.id).length,56);
});
test('screenshot routes cannot read outside a registered page artifact directory',async t=>{
 const {a,page,dir}=await fixture(t),filename='pageposter-'+randomUUID()+'-desktop.png',folder=path.join(dir,'screenshots',page.id);
 fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,filename),Buffer.from([137,80,78,71]));
 const get=route=>a.handle(new Request('http://localhost:4317/api/lifecycle'+route));
 assert.equal((await get('/pages/'+page.id+'/screenshots/'+filename)).status,200);
 for(const value of ['../pageposter.sqlite','%2e%2e%2fpageposter.sqlite','..%5cpageposter.sqlite','C:%5cpageposter.sqlite',filename+'%00'])assert.notEqual((await get('/pages/'+page.id+'/screenshots/'+value)).status,200);
 assert.notEqual((await get('/pages/not-a-registered-page/screenshots/'+filename)).status,200);
});
