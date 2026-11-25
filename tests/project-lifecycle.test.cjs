'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
async function fixture(t,extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-project-life-')),{createLifecycleService}=await import('../server/lifecycle/service.mjs');
 const app=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,36).toString('base64'),...extra});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=async(id,body,method='POST')=>{const response=await app.handle(new Request('http://127.0.0.1:4317/api/lifecycle/projects/'+id+'/lifecycle',{method,headers:{Origin:'http://127.0.0.1:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,...await response.json()};};
 const project=app.store.createProject({name:'Project to manage',workflowType:'html'});
 const site=app.store.createSite(project.id,{name:'WP',baseUrl:'https://donor.example/'});
 const page=app.store.createPage(project.id,{siteId:site.id,title:'Published page',wpId:42,fullUrl:'https://donor.example/page/'});
 const job=app.store.enqueueJob({projectId:project.id,siteId:site.id,type:'site_check',idempotencyKey:'queued-check'});
 return {app,request,project,site,page,job};
}
test('closing a project pauses queued work and preserves pages and history',async t=>{
 const {app,request,project:p,page,job}=await fixture(t),run=app.store.createRecord(p.id,'autopilot',{state:'queued',stage:'generating',source:'ai',reviewBeforePublish:true});
 const result=await request(p.id,{action:'close',expectedRevision:p.revision});assert.equal(result.status,200);assert.equal(result.project.archived,true);
 assert.equal(app.store.getJob(job.id).state,'paused');assert.equal(app.store.getRecord(run.id).state,'paused');assert.equal(app.store.getRecord('queue-control:'+p.id).paused,true);
 assert.equal(app.store.claimJob({workerId:'fixture',leaseMs:1000}),null);assert.equal(app.store.getPage(page.id).fullUrl,page.fullUrl);assert.equal(app.store.getPage(page.id).wpId,42);
 assert.equal(app.projectQueue.overview().projects.some(value=>value.projectId===p.id),false);
});
test('trash and restore preserve published data and never restart queued tasks automatically',async t=>{
 const {app,request,project:p,page,job}=await fixture(t);
 const trashed=await request(p.id,{action:'trash',expectedRevision:p.revision});assert.equal(trashed.status,200);assert.equal(trashed.project.trashed,true);assert.equal(trashed.project.archived,true);
 assert.equal(app.store.exportBackup().projects.find(value=>value.id===p.id).trashed,true);
 assert.throws(()=>app.store.updateProject(p.id,{archived:false},trashed.project.revision));
 const restored=await request(p.id,{action:'restore',expectedRevision:trashed.project.revision});assert.equal(restored.status,200);assert.equal(restored.project.archived,false);assert.equal(restored.project.trashed,false);
 assert.equal(app.store.getJob(job.id).state,'paused');assert.equal(app.store.getRecord('queue-control:'+p.id).paused,true);assert.equal(app.store.getPage(page.id).wpId,42);
});
test('closing is refused while a remote job or AI action is active and changes nothing',async t=>{
 const {app,request,project:p,job}=await fixture(t),claimed=app.store.claimJob({workerId:'fixture',leaseMs:100000});assert.equal(claimed.id,job.id);
 let result=await request(p.id,{action:'trash',expectedRevision:p.revision});assert.equal(result.status,409);assert.equal(result.code,'PROJECT_BUSY');assert.equal(app.store.getProject(p.id).archived,false);
 app.store.finishJob(claimed.id,claimed.leaseToken,{state:'completed',result:{}});
 app.store.createRecord(p.id,'autopilot',{state:'running',stage:'generating',leaseToken:'fixture',leaseUntil:new Date(Date.now()+100000).toISOString()});
 result=await request(p.id,{action:'close',expectedRevision:p.revision});assert.equal(result.status,409);assert.equal(result.code,'PROJECT_BUSY');
});
test('stale revisions and invalid lifecycle transitions cannot pause or hide a project',async t=>{
 const {app,request,project:p,job}=await fixture(t);
 for(const body of [{action:'close',expectedRevision:0},{action:'close',expectedRevision:999},{action:'restore',expectedRevision:p.revision},{action:'invalid',expectedRevision:p.revision}]){
  const result=await request(p.id,body);assert.ok([400,409].includes(result.status));assert.equal(app.store.getProject(p.id).archived,false);assert.equal(app.store.getJob(job.id).state,'queued');
 }
 const closed=await request(p.id,{action:'close',expectedRevision:p.revision});const reopened=await request(p.id,{action:'reopen',expectedRevision:closed.project.revision});assert.equal(reopened.status,200);assert.equal(reopened.project.archived,false);assert.equal(app.store.getJob(job.id).state,'paused');
});
test('closing pauses accepted writes and rejects new writes until the project is reopened',async t=>{
 const {app,request,project:p,page,site}=await fixture(t),write={projectId:p.id,siteId:site.id,pageId:page.id,type:'replace',idempotencyKey:'blocked-write'};
 const queued=app.store.enqueueJob(write);assert.equal((await request(p.id,{action:'close',expectedRevision:p.revision})).status,200);
 assert.equal(app.store.getJob(queued.id).state,'paused');assert.equal(app.store.claimJob({workerId:'fixture',leaseMs:1000}),null);assert.throws(()=>app.store.enqueueJob({...write,idempotencyKey:'new-write'}),{code:'CONFLICT'});
});
async function api(app,route,body,method='POST'){
 const response=await app.handle(new Request('http://127.0.0.1:4317/api/lifecycle'+route,{method,headers:{Origin:'http://127.0.0.1:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};
}
test('legacy launch/resume and worker dispatch cannot generate for closed projects',async t=>{
 let calls=0;const {app,request,project:p}=await fixture(t,{ai:{env:{OPENAI_API_KEY:'fixture'},handler:async()=>{calls++;return new Response('{}');}}});
 const page=app.store.createPage(p.id,{title:'Legacy draft',config:structuredClone(require('../dist/generator.js').DEFAULT_DATA)}),body={expectedRevision:page.revision,idempotencyKey:require('node:crypto').randomUUID(),status:'review',paths:['intro']};
 const run=app.automation.launch(page.id,body);const closed=await request(p.id,{action:'close',expectedRevision:p.revision});assert.equal(closed.status,200);
 assert.equal((await api(app,'/runs/'+run.id+'/resume',{})).status,409);
 assert.equal((await api(app,'/pages/'+page.id+'/runs',{...body,idempotencyKey:require('node:crypto').randomUUID()})).status,409);
 // Defensive guard also covers pre-existing direct archive flags.
 app.automation.runs.resumeRun(run.id,{expectedRevision:app.automation.runs.getRun(run.id).revision});await app.automation.tick();
 assert.equal(app.automation.runs.getRun(run.id).state,'paused');assert.equal(calls,0);
});
test('the compatibility PATCH uses the same busy protection and pause behavior',async t=>{
 const {app,project:p,job}=await fixture(t),claimed=app.store.claimJob({workerId:'fixture',leaseMs:100000});
 let response=await api(app,'/projects/'+p.id,{archived:true,expectedRevision:p.revision},'PATCH');assert.equal(response.status,409);assert.equal(response.code,'PROJECT_BUSY');assert.equal(app.store.getProject(p.id).archived,false);
 app.store.finishJob(claimed.id,claimed.leaseToken,{state:'completed',result:{}});response=await api(app,'/projects/'+p.id,{archived:true,expectedRevision:p.revision},'PATCH');assert.equal(response.status,200);assert.equal(response.project.archived,true);assert.equal(app.store.getRecord('queue-control:'+p.id).paused,true);assert.equal(app.store.getJob(job.id).state,'completed');
});
test('closing preserves the completed state of finished campaign history',async t=>{
 const {app,request,project:p}=await fixture(t);
 const accepted=await api(app,'/projects/'+p.id+'/campaigns',{idempotencyKey:require('node:crypto').randomUUID(),name:'Completed review',topics:['Sample topic'],siteIds:[],status:'review',mode:'manual',paths:[],config:structuredClone(require('../dist/generator.js').DEFAULT_DATA),brief:{}});assert.equal(accepted.status,202);
 await app.campaigns.tick();await app.automation.tick();const read=()=>api(app,'/campaigns/'+accepted.campaign.id,undefined,'GET');assert.equal((await read()).campaign.state,'completed');
 const closed=await request(p.id,{action:'close',expectedRevision:p.revision});assert.equal(closed.status,200);await request(p.id,{action:'reopen',expectedRevision:closed.project.revision});assert.equal((await read()).campaign.state,'completed');
});
