'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const G=require('../dist/generator.js');
const source=()=>({...G.DEFAULT_DATA,title:'Saved title',intro:'Saved intro',cards:[],moreCards:[],sections:[],faq:[],tiles:[],services:[],reviews:[],navLinks:[]});
async function fixture(t,{maxPages=1000,env={OPENAI_API_KEY:'fixture-key'},prepare,handler}={}){
 const [{createStore},{createRuns},module]=await Promise.all([import('../server/lifecycle/store.mjs'),import('../server/lifecycle/runs.mjs'),import('../server/lifecycle/campaigns.mjs').catch(()=>({}))]);
 assert.equal(typeof module.createCampaigns,'function','Durable campaigns must be implemented');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-campaigns-'));let store,automation,campaigns,calls=0;
 const f={get store(){return store;},get automation(){return automation;},get campaigns(){return campaigns;},calls:()=>calls,open(){store=createStore({filename:path.join(dir,'pages.sqlite'),masterKey:Buffer.alloc(32,45).toString('base64')});automation=createRuns({filename:path.join(dir,'runs.sqlite'),store,env,maxPages,handler:handler||(async request=>{calls++;const body=await request.json();return new Response(JSON.stringify({requestId:body.requestId,updates:body.targets.map(target=>({targetId:target.targetId,value:'Generated useful introduction'})),notes:[]}));})});campaigns=module.createCampaigns({store,automation,env,maxPages,prepare:prepare||((input)=>({name:input.name,status:input.status,entries:input.topics.map(topic=>({page:{title:topic,keyword:topic,siteId:input.siteIds[0],config:{...source(),title:topic},expectedUrls:[],expectedMarker:'pp-landing'},launch:{status:input.status,siteId:input.siteIds[0],paths:input.paths,brief:{topic},linkInsertions:[]}}))}))});},close(){automation.close();store.close();},async q(route,body){const result=await campaigns.handle(new Request('http://localhost'+route,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})}),route,r=>r.json());assert.ok(result,'Campaign route must return a response: '+route);return {status:result.status,...await result.json()};},body(extra={}){return {idempotencyKey:randomUUID(),name:'Saved campaign',status:'publish',topics:['First topic','Second topic'],siteIds:[f.site.id],paths:[],...extra};},create(body=f.body()){return f.q('/projects/'+f.project.id+'/campaigns',body);}};
 f.open();f.project=store.createProject({name:'Campaign project'});f.site=store.createSite(f.project.id,{name:'WordPress',baseUrl:'https://example.test',username:'fixture',applicationPassword:'fixture-password'});
 t.after(()=>{f.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('pp-campaigns-'));fs.rmSync(resolved,{recursive:true,force:true});});return f;
}
test('campaign acceptance atomically saves stable page/run identities and replay survives restart',async t=>{
 const f=await fixture(t),body=f.body(),first=await f.create(body);assert.equal(first.status,202);assert.equal(first.campaign.items.length,2);assert.equal(f.store.listPages(f.project.id).length,2);assert.equal(f.automation.runs.listRuns(f.project.id).length,0);
 const identities=first.campaign.items.map(item=>[item.pageId,item.runId]);identities.flat().forEach(value=>assert.match(value,/^[a-f0-9-]{36}$/));
 await f.campaigns.tick();assert.deepEqual(f.automation.runs.listRuns(f.project.id).map(run=>[run.spec.pageId,run.id]),identities);f.close();f.open();
 const replay=await f.create(body);assert.equal(replay.campaign.id,first.campaign.id);assert.deepEqual(replay.campaign.items.map(item=>[item.pageId,item.runId]),identities);assert.equal(f.store.listPages(f.project.id).length,2);
 await assert.rejects(()=>f.create({...body,name:'Changed authorization'}),e=>e.code==='CONFLICT');assert.equal(JSON.stringify(replay).includes('config'),false);assert.equal(JSON.stringify(replay).includes('fixture-password'),false);
});

test('paid generation commits automatically but campaign publication waits for the remote job',async t=>{
 const f=await fixture(t),created=await f.create(f.body({topics:['AI topic'],paths:['intro']})),item=created.campaign.items[0];
 await f.campaigns.tick();await f.automation.tick();assert.equal(f.calls(),1);await f.automation.tick();assert.equal(f.automation.runs.getRun(item.runId).state,'completed');
 const waiting=(await f.q('/campaigns/'+created.campaign.id)).campaign;assert.equal(waiting.items[0].state,'queued');assert.equal(waiting.items[0].stage,'publication');assert.equal(waiting.counts.published,0);assert.equal(f.store.getPage(item.pageId).config.intro,'Generated useful introduction');
 const {createWorkflow}=await import('../server/lifecycle/workflow.mjs'),{bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');
 const workflow=createWorkflow({store:f.store,bridge:{submitOperation:async({operation,beforeSend})=>{beforeSend();return {operationId:operation.operationId,state:'completed',postId:71,postType:'page',status:'publish',contentHash:bridgeContentHash(operation),url:'https://example.test/?page_id=71',warnings:[]};}},verifier:{verifyGenerated:async()=>({layoutState:'ok',viewports:[]})}});
 const job=f.store.claimJob({workerId:'campaign-worker',leaseMs:10000});assert.equal((await f.q('/campaigns/'+created.campaign.id)).campaign.items[0].state,'running');
 await workflow.perform(job,f.site,f.store.getSiteCredentials(f.site.id));const finished=(await f.q('/campaigns/'+created.campaign.id)).campaign;assert.equal(finished.counts.published,1);assert.equal(finished.items[0].fullUrl,'https://example.test/?page_id=71');assert.equal(finished.state,'completed');
});
test('invalid later page rolls back every campaign page and missing key blocks only AI paths',async t=>{
 const f=await fixture(t,{env:{},prepare:input=>({name:input.name,status:input.status,entries:input.topics.map((topic,index)=>({page:{title:index?'':topic,config:source()},launch:{status:'review',paths:[],brief:{topic}}}))})});
 await assert.rejects(()=>f.create(f.body({status:'review'})),e=>e.code==='VALIDATION');assert.equal(f.store.listPages(f.project.id).length,0);assert.equal(f.store.listCampaigns(f.project.id).length,0);
 const g=await fixture(t,{env:{}});assert.equal((await g.create(g.body({topics:['Manual page']}))).status,202);await assert.rejects(()=>g.create(g.body({topics:['AI page'],paths:['intro']})),e=>e.code==='not_configured');assert.equal(g.store.listPages(g.project.id).length,1);
});
test('manual edits before dispatch fail only that item and never overwrite or publish it',async t=>{
 const f=await fixture(t),campaign=(await f.create()).campaign,first=campaign.items[0];f.store.updatePage(first.pageId,{title:'Human revision'},1);
 await f.campaigns.tick();const actual=(await f.q('/campaigns/'+campaign.id)).campaign;assert.equal(actual.items[0].state,'failed');assert.equal(actual.items[0].errorCode,'CONFLICT');assert.equal(actual.items[1].state,'queued');assert.equal(f.automation.runs.listRuns(f.project.id).length,1);assert.equal(f.store.getPage(first.pageId).title,'Human revision');
});
test('pause survives restart before dispatch and resumes only campaign-owned paused runs',async t=>{
 const f=await fixture(t),campaign=(await f.create()).campaign;await f.q('/campaigns/'+campaign.id+'/pause',{});f.close();f.open();await f.campaigns.tick();assert.equal(f.automation.runs.listRuns(f.project.id).length,0);
 const paused=(await f.q('/campaigns/'+campaign.id)).campaign;assert.equal(paused.counts.paused,2);await f.q('/campaigns/'+campaign.id+'/resume',{});await f.campaigns.tick();
 const [manual,owned]=f.automation.runs.listRuns(f.project.id);f.automation.runs.pauseRun(manual.id,{expectedRevision:manual.revision});await f.q('/campaigns/'+campaign.id+'/pause',{});assert.equal(f.automation.runs.getRun(owned.id).state,'paused');f.close();f.open();await f.q('/campaigns/'+campaign.id+'/resume',{});
 assert.equal(f.automation.runs.getRun(owned.id).state,'queued');assert.equal(f.automation.runs.getRun(manual.id).state,'paused');
});
test('campaign pause holds queued publication but lets an already running remote write finish',async t=>{
 const f=await fixture(t),campaign=(await f.create()).campaign;await f.campaigns.tick();await f.automation.tick();await f.automation.tick();const jobs=f.store.listJobs(f.project.id);assert.equal(jobs.length,2);
 const running=f.store.claimJob({workerId:'remote-worker',leaseMs:10000});await f.q('/campaigns/'+campaign.id+'/pause',{});assert.equal(f.store.getJob(running.id).state,'running');const queued=jobs.find(job=>job.id!==running.id);assert.equal(f.store.getJob(queued.id).state,'paused');
 const page=f.store.getPage(running.pageId);f.store.completeRemoteWrite(running.id,{leaseToken:running.leaseToken,expectedPageRevision:page.revision,patch:{wpId:9,fullUrl:'https://example.test/committed',lifecycleState:'published'},result:{}});assert.equal((await f.q('/campaigns/'+campaign.id)).campaign.counts.published,1);
 await f.q('/campaigns/'+campaign.id+'/resume',{});assert.equal(f.store.getJob(queued.id).state,'queued');assert.equal(f.store.getJob(running.id).state,'completed');
});
test('undispatched campaigns reserve publication capacity and block manual publication of owned pages',async t=>{
 const f=await fixture(t,{maxPages:2}),campaign=(await f.create()).campaign;assert.throws(()=>f.automation.beforePublish(f.store.getPage(campaign.items[0].pageId)),e=>e.code==='CONFLICT');
 const manual=f.store.createPage(f.project.id,{title:'Manual',siteId:f.site.id,config:source()});assert.throws(()=>f.automation.beforePublish(manual),e=>e.code==='CAPACITY_EXCEEDED');
 assert.throws(()=>f.store.enqueueJob({projectId:f.project.id,pageId:manual.id,siteId:f.site.id,type:'publish',payload:{},idempotencyKey:randomUUID(),maxPages:2}),e=>e.code==='CAPACITY_EXCEEDED');
 await assert.rejects(()=>f.create(f.body({topics:['Excess']})),e=>e.code==='CAPACITY_EXCEEDED');assert.equal(f.store.listCampaigns(f.project.id).length,1);
});
test('failed and uncertain children never resume through a campaign toggle',async t=>{
 const f=await fixture(t,{handler:async()=>new Response(JSON.stringify({code:'AI_RESULT_UNCERTAIN'}),{status:502})}),campaign=(await f.create(f.body({topics:['Uncertain'],paths:['intro']}))).campaign;await f.campaigns.tick();await f.automation.tick();const runId=campaign.items[0].runId;assert.equal(f.automation.runs.getRun(runId).state,'uncertain');
 await f.q('/campaigns/'+campaign.id+'/pause',{});await f.q('/campaigns/'+campaign.id+'/resume',{});await f.campaigns.tick();await f.automation.tick();assert.equal(f.automation.runs.getRun(runId).state,'uncertain');assert.equal((await f.q('/campaigns/'+campaign.id)).campaign.items[0].state,'uncertain');
});

test('campaign store enforces publication reservations inside the page creation transaction',async t=>{
 const f=await fixture(t,{maxPages:2}),campaign=(await f.create()).campaign,saved=f.store.getCampaign(campaign.id),item=saved.items[0];
 assert.throws(()=>f.store.createCampaign(f.project.id,{idempotencyKey:randomUUID(),requestHash:'a'.repeat(64),name:'Second transaction',status:'publish',maxPages:2,runReservations:[],entries:[{page:{title:'Over capacity',siteId:f.site.id,config:source()},launch:{status:'publish',siteId:f.site.id,paths:[],brief:{}},generation:item.generation}]}),e=>e.code==='CAPACITY_EXCEEDED');assert.equal(f.store.listPages(f.project.id).length,2);
});
test('credential-shaped fields are rejected before saving campaign content',async t=>{
 const f=await fixture(t,{prepare:input=>({name:input.name,status:'review',entries:[{page:{title:'Unsafe',config:{...source(),openaiApiKey:'not-a-real-key'}},launch:{status:'review',paths:[],brief:{}}}]})});
 await assert.rejects(()=>f.create(f.body({status:'review',topics:['Unsafe']})),e=>e.code==='VALIDATION');assert.equal(f.store.listPages(f.project.id).length,0);
});
test('a crash after run acceptance recovers the same saved run without duplicate pages or launches',async t=>{
 const f=await fixture(t),body=f.body({topics:['Crash recovery']}),campaign=(await f.create(body)).campaign,{createCampaigns}=await import('../server/lifecycle/campaigns.mjs');
 const recovering=createCampaigns({store:f.store,automation:{...f.automation,launch(...args){f.automation.launch(...args);throw Error('Crash after acceptance');}},prepare:()=>assert.fail('No preparation on restart')});
 recovering.tick();f.close();f.open();await f.campaigns.tick();const actual=(await f.create(body)).campaign;assert.equal(actual.id,campaign.id);assert.equal(actual.items[0].runId,campaign.items[0].runId);assert.equal(actual.items[0].state,'queued');assert.equal(f.automation.runs.listRuns(f.project.id).length,1);assert.equal(f.store.listPages(f.project.id).length,1);
});
test('schema three upgrades without changing existing project or page revisions',async t=>{
 const {DatabaseSync}=await import('node:sqlite'),{createStore}=await import('../server/lifecycle/store.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-campaigns-migrate-')),filename=path.join(dir,'pages.sqlite');let store=createStore({filename});const project=store.createProject({name:'Existing project'}),page=store.createPage(project.id,{title:'Existing page',config:source()});store.close();const db=new DatabaseSync(filename);db.exec('DROP TABLE campaigns; PRAGMA user_version=3;');db.close();store=createStore({filename});
 try{assert.equal(store.getPage(page.id).revision,1);assert.equal(store.getProject(project.id).name,'Existing project');assert.deepEqual(store.listCampaigns(project.id),[]);}finally{store.close();const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('pp-campaigns-migrate-'));fs.rmSync(resolved,{recursive:true,force:true});}
});
