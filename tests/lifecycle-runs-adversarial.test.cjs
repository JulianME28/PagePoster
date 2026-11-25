'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const G=require('../dist/generator.js'),MASTER=Buffer.alloc(32,37).toString('base64');
function cleanup(dir){const resolved=path.resolve(dir),root=path.resolve(os.tmpdir())+path.sep;assert.ok(resolved.startsWith(root)&&path.basename(resolved).startsWith('pp-runs-adversarial-'));fs.rmSync(resolved,{recursive:true,force:true});}
function temporary(){return fs.mkdtempSync(path.join(os.tmpdir(),'pp-runs-adversarial-'));}
function source(){return {...G.DEFAULT_DATA,title:'Manual title',intro:'Manual intro',cards:[{name:'Manual offer',url:'https://offer.invalid/?x=%2F&a=1',button:'View offer'}],moreCards:[],sections:[],faq:[],tiles:[],services:[],reviews:[],navLinks:[]};}
async function fixture(t,{maxPages=1000,handler,clock=Date.now}={}){
 const dir=temporary(t),{createLifecycleService}=await import('../server/lifecycle/service.mjs');let calls=0;
 const service=await createLifecycleService({dataDir:dir,masterKey:MASTER,maxPages,clock,ai:{env:{OPENAI_API_KEY:'fake-key-never-external'},handler:async request=>{calls++;const body=await request.json();if(handler)return handler(body);return new Response(JSON.stringify({requestId:body.requestId,updates:body.targets.map(x=>({targetId:x.targetId,value:'Generated verified text'})),notes:[]}));}},client:{checkSite:async()=>({state:'ok'}),checkPage:async()=>[]},bridgeClient:{submitOperation:async()=>assert.fail('No WordPress write permitted in these tests')},browserVerifier:{verifyGenerated:async()=>({layoutState:'ok',viewports:[]}),verifyPublished:async()=>({state:'unknown'})}});
 t.after(async()=>{await service.close();cleanup(dir);});
 const q=async(route,body,method=body===undefined?'GET':'POST')=>{const result=await service.handle(new Request('http://localhost:4317/api/lifecycle'+route,{method,headers:{Origin:'http://localhost:4317','Content-Type':'application/json','X-PagePoster-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:result.status,...await result.json()};};
 const project=(await q('/projects',{name:'Adversarial fixture'})).project,site=(await q('/projects/'+project.id+'/sites',{name:'Fake site',baseUrl:'https://wp.invalid',username:'fake',applicationPassword:'fake-password'})).site;
 const makePage=async()=> (await q('/projects/'+project.id+'/pages',{title:'Manual title',config:source()})).page,page=await makePage();
 const launch=(selected=page,extra={})=>q('/pages/'+selected.id+'/runs',{expectedRevision:selected.revision,idempotencyKey:randomUUID(),status:'draft',siteId:site.id,paths:['intro'],...extra});
 return {service,q,project,site,page,makePage,launch,calls:()=>calls};
}
test('page capacity is rejected before any paid batch when an existing page fills the project',async t=>{
 const f=await fixture(t,{maxPages:1});f.service.store.createPage(f.project.id,{title:'Already published',siteId:f.site.id,wpId:99,config:source()});
 const result=await f.launch();assert.equal(result.status,400);assert.equal(result.code,'CAPACITY_EXCEEDED');await f.service.automation.tick();assert.equal(f.calls(),0);
});
test('queued automatic publications reserve capacity against a second launch',async t=>{
 const f=await fixture(t,{maxPages:1}),first=await f.launch();assert.equal(first.status,202);const second=await f.launch(await f.makePage());assert.equal(second.status,400);assert.equal(second.code,'CAPACITY_EXCEEDED');assert.equal(f.calls(),0);
});
test('manual publication cannot replace an active automatic launch with pre-generation content',async t=>{
 const f=await fixture(t);assert.equal((await f.launch()).status,202);
 const manual=await f.q('/pages/'+f.page.id+'/publish',{siteId:f.site.id,mode:'draft',expectedRevision:f.page.revision,idempotencyKey:randomUUID()});
 assert.equal(manual.status,409);assert.equal(manual.code,'CONFLICT');assert.equal(f.service.store.listJobs(f.project.id).filter(x=>x.effect==='write').length,0);assert.equal(f.service.store.getPage(f.page.id).revision,f.page.revision);
});
test('a disabled destination before execution prevents AI dispatch and page changes',async t=>{
 const f=await fixture(t),run=(await f.launch()).run;
 assert.equal((await f.q('/sites/'+f.site.id,{enabled:false,expectedRevision:f.site.revision},'PATCH')).status,200);
 await f.service.automation.tick();assert.equal(f.calls(),0);assert.equal(f.service.automation.runs.getRun(run.id).state,'failed');assert.equal(f.service.automation.runs.getRun(run.id).error.code,'disabled');assert.equal(f.service.store.getPage(f.page.id).revision,1);
});
test('disabling a destination during a paid response blocks checkpoint and publication',async t=>{
 let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
 const f=await fixture(t,{handler:async body=>{entered();await gate;return new Response(JSON.stringify({requestId:body.requestId,updates:body.targets.map(x=>({targetId:x.targetId,value:'Paid text after disable'})),notes:[]}));}}),run=(await f.launch()).run;
 const pending=f.service.automation.tick();await ready;await f.q('/sites/'+f.site.id,{enabled:false,expectedRevision:f.site.revision},'PATCH');release();await pending;
 const saved=f.service.automation.runs.getRun(run.id);assert.equal(f.calls(),1);assert.equal(saved.state,'failed');assert.equal(saved.error.code,'disabled');assert.equal(saved.cursor,0);assert.equal(saved.batchResults.length,0);assert.equal(f.service.store.getPage(f.page.id).config.intro,'Manual intro');assert.equal(f.service.store.listJobs(f.project.id).length,0);
});
test('receipt recovery after the page commit does not reapply over newer manual edits',async t=>{
 let now=Date.UTC(2026,9,15);const f=await fixture(t,{clock:()=>now}),run=(await f.launch(f.page,{paths:[]})).run;
 const claimed=f.service.automation.runs.claimRun({workerId:'crashed-worker',leaseMs:180000});assert.equal(claimed.id,run.id);
 const {finishGeneration}=await import('../server/lifecycle/generation.mjs'),{renderPage}=await import('../server/lifecycle/render.mjs');
 const rendered=renderPage(finishGeneration(claimed.spec.generation,[]));
 const receipt=f.service.store.commitGeneration(run.id,{pageId:f.page.id,sourceRevision:f.page.revision,patch:{title:rendered.title,config:rendered.config,expectedUrls:rendered.expectedUrls,expectedMarker:'pp-landing',siteId:f.site.id,lifecycleState:'queued'},publication:{idempotencyKey:run.id,mode:'draft',html:rendered.html,maxPages:1000}});
 f.service.store.updatePage(f.page.id,{title:'Manual after successful commit'},receipt.pageRevision);now+=181000;
 await f.service.automation.tick();const saved=f.service.automation.runs.getRun(run.id);assert.equal(saved.state,'completed');assert.deepEqual(saved.result,receipt);assert.equal(f.service.store.getPage(f.page.id).title,'Manual after successful commit');assert.equal(f.service.store.listJobs(f.project.id).length,1);assert.equal(f.calls(),0);
});
test('saved API key restores for automatic batches, with origin protection and no plaintext backup',async t=>{
 const dir=temporary(t),{createLocalServer}=require('../server/local.cjs');const key='sk-test-key-never-real-123456';let providerCalls=0,authorization='';
 const fetchImpl=async(_url,options)=>{providerCalls++;authorization=options.headers.Authorization||options.headers.authorization;const body=JSON.parse(JSON.parse(options.body).input);return new Response(JSON.stringify({status:'completed',usage:{input_tokens:20,output_tokens:30},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({updates:body.targets.map(x=>({targetId:x.targetId,value:'Restored-key fixture text'})),notes:[]})}]}]}));};
 let server;
 const stop=async()=>{if(!server)return;const old=server;server=null;await new Promise(r=>{old.close(r);old.closeAllConnections();});await old.closeResources();};t.after(async()=>{await stop();cleanup(dir);});
 const start=async()=>{server=await createLocalServer({env:{},fetchImpl,lifecycle:{dataDir:dir,masterKey:MASTER,workerIntervalMs:3600000,client:{checkSite:async()=>({state:'ok'}),checkPage:async()=>[]},browserVerifier:{verifyGenerated:async()=>({layoutState:'ok',viewports:[]}),verifyPublished:async()=>({state:'unknown'})}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port;};
 let base=await start();
 assert.equal((await fetch(base+'/api/ai/connect',{method:'POST',headers:{Origin:'https://untrusted.invalid','Content-Type':'application/json'},body:JSON.stringify({apiKey:key})})).status,403);
 assert.equal((await fetch(base+'/api/ai/connect',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({apiKey:key})})).status,200);await stop();
 assert.ok(!fs.readFileSync(path.join(dir,'openai-key.json'),'utf8').includes(key));base=await start();assert.equal((await(await fetch(base+'/api/ai/status')).json()).configured,true);
 const q=async(route,body)=>{const response=await fetch(base+'/api/lifecycle'+route,{method:'POST',headers:{Origin:base,'X-PagePoster-Request':'1','Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(response.ok);return response.json();};
 const p=(await q('/projects',{name:'API restore'})).project,page=(await q('/projects/'+p.id+'/pages',{title:'Manual title',config:source()})).page;
 const run=(await q('/pages/'+page.id+'/runs',{expectedRevision:page.revision,idempotencyKey:randomUUID(),status:'review',paths:['intro']})).run;await server.lifecycle.automation.tick();
 assert.equal(providerCalls,1);assert.equal(authorization,'Bearer '+key);assert.equal(server.lifecycle.automation.runs.getRun(run.id).cursor,1);assert.ok(!(await(await fetch(base+'/api/lifecycle/backup')).text()).includes(key));
});

test('manual publication of another page cannot consume an automatic run reservation',async t=>{
 const f=await fixture(t,{maxPages:1});assert.equal((await f.launch()).status,202);const other=await f.makePage();
 const manual=await f.q('/pages/'+other.id+'/publish',{siteId:f.site.id,mode:'draft',expectedRevision:other.revision,idempotencyKey:randomUUID()});
 assert.equal(manual.status,400);assert.equal(manual.code,'CAPACITY_EXCEEDED');assert.equal(f.service.store.listJobs(f.project.id).length,0);
});
test('concurrent automatic launch and manual publication cannot both be accepted',async t=>{
 const f=await fixture(t);
 const [automatic,manual]=await Promise.all([f.launch(),f.q('/pages/'+f.page.id+'/publish',{siteId:f.site.id,mode:'draft',expectedRevision:f.page.revision,idempotencyKey:randomUUID()})]);
 assert.notDeepEqual([automatic.status,manual.status],[202,202]);assert.equal([automatic,manual].filter(x=>x.status===202).length,1);assert.equal([automatic,manual].filter(x=>x.code==='CONFLICT').length,1);
});
