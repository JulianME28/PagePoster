const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const G=require('../dist/generator.js');
async function fixture(t){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-queue-legacy-'));
 const service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,82).toString('base64'),autopilotOptions:{planner:{generate:async()=>assert.fail('No generation in legacy queue tests')},source:{readCandidates:async()=>assert.fail('No source reads in legacy queue tests')}},client:{checkSite:async()=>assert.fail('No WordPress access in legacy queue tests')},browserVerifier:{verifyPublished:async()=>assert.fail('No browser probes in legacy queue tests')}});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
 const queue=async projectId=>(await q('/project-queue')).projects.find(project=>project.projectId===projectId);
 const published=(project,title='Saved page',extra={})=>service.store.createPage(project.id,{title,config:{...G.DEFAULT_DATA,title},wpId:81,fullUrl:'https://published.example/'+crypto.randomUUID(),lifecycleState:'published',...extra});
 const runFor=(page,patch={})=>service.store.createRecord(page.projectId,'autopilot',{pageId:page.id,title:page.title,source:'html',state:'completed',stage:'completed',siteSelection:{minDr:20,minTraffic:100,geo:'PL'},...patch});
 const prepare=async()=>{const imported=await q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Pending HTML',type:'html',items:[{key:'local',title:'Prepared',source:'html',html:'<h1>Prepared</h1><p>Exact saved content.</p>',language:'pl',geo:'PL'}]});assert.equal(imported.status,201);service.projectQueue.feed();await service.autopilot.tick({lane:'generation',slot:0});return {project:imported.project,item:(await queue(imported.project.id)).items[0]};};
 return {s:service,q,queue,published,runFor,prepare};
}

// Catches the workspace hiding old projects or leaking saved site credentials.
test('published pages without queue runs appear as safe read-only workspace rows',async t=>{
 const f=await fixture(t),project=f.s.store.createProject({name:'Old published project',language:'de',country:'DE'}),site=f.s.store.createSite(project.id,{name:'Private site',baseUrl:'https://published.example/blog/',username:'private-user',applicationPassword:'private-password'}),page=f.published(project,'Original saved page',{siteId:site.id,config:{...G.DEFAULT_DATA,title:'Original saved page',source:'ai'},remoteSnapshot:{content:'<h1>Exact published HTML</h1>'}}),view=await f.queue(project.id);
 assert.ok(view,'A project with old published pages must be listed');assert.equal(view.items.length,1);const item=view.items[0];assert.equal(item.id,page.id);assert.equal(item.key,page.id);assert.equal(item.pageId,page.id);assert.equal(item.runId,null);assert.equal(item.title,page.title);assert.equal(item.source,'ai');assert.equal(item.language,'de');assert.equal(item.geo,'DE');assert.equal(item.fullUrl,page.fullUrl);assert.equal(item.state,'completed');assert.equal(item.stage,'completed');assert.equal(item.canApprove,false);assert.equal(item.canEditRequirements,false);assert.deepEqual(item.verification,page.verification);assert.deepEqual(item.selectedSite,{baseUrl:'https://published.example/blog/',dr:null,traffic:null,geo:[]});assert.doesNotMatch(JSON.stringify(view),/private-user|private-password|applicationPassword|ciphertext/);
 assert.equal(view.counts.total,1);assert.equal(view.counts.completed,1);assert.equal(view.publicationPlan.token,null);assert.equal(view.publicationPlan.unreadyCount,0);assert.equal((await f.q('/pages/'+page.id)).page.remoteSnapshot.content,'<h1>Exact published HTML</h1>');
});

// Catches duplicating pages already represented by direct and imported runs.
test('backed published pages appear once and expose their current verification',async t=>{
 const f=await fixture(t),project=f.s.store.createProject({name:'Backed pages'}),direct=f.published(project,'Direct'),imported=f.published(project,'Imported'),directRun=f.runFor(direct),importedRun=f.runFor(imported);
 f.s.store.observeChecks(direct.id,[{kind:'links',state:'problem'}],direct.revision);f.s.store.observeChecks(imported.id,[{kind:'links',state:'ok'}],imported.revision);
 const item=f.s.store.createRecord(project.id,'project_queue_item',{key:'imported-key',batchId:'historical-batch',runId:importedRun.id,state:'queued',input:{title:'Imported',language:'pl',source:'html',siteSelection:{minDr:20,minTraffic:100,geo:'PL'}}});
 const view=await f.queue(project.id);assert.equal(view.items.length,2);assert.deepEqual(new Set(view.items.map(row=>row.id)),new Set([directRun.id,item.id]));assert.equal(view.items.find(row=>row.id===directRun.id).verification.state,'problem');assert.equal(view.items.find(row=>row.id===item.id).verification.state,'ok');assert.equal(view.counts.completed,2);assert.equal(view.counts.attention,1);
});

// Catches including synthetic rows in approval inputs, plan hashes or the feeder.
test('legacy published rows cannot change or enter a pending project publication plan',async t=>{
 const f=await fixture(t),{project,item}=await f.prepare(),run=f.s.store.getRecord(item.runId);f.s.store.updateRecord(run.id,{candidate:{id:'local-donor',baseUrl:'https://donor.example/'},stage:'installing'},run.revision);const before=await f.queue(project.id);assert.equal(before.publicationPlan.count,1);
 const legacy=f.published(project,'Historical');let view=await f.queue(project.id);assert.equal(view.items.length,2);assert.equal(view.publicationPlan.token,before.publicationPlan.token);assert.equal(view.publicationPlan.unreadyCount,0);
 f.s.store.observeChecks(legacy.id,[{kind:'links',state:'problem'}],legacy.revision);f.s.store.updatePage(legacy.id,{title:'Historical revised'},legacy.revision);view=await f.queue(project.id);assert.equal(view.publicationPlan.token,before.publicationPlan.token);
 assert.equal((await f.q('/project-queue/approve',{items:[{id:legacy.id,reviewToken:'not-approvable'}]})).status,404);assert.equal((await f.q('/project-queue/requirements',{items:[{id:legacy.id,expectedRevision:'read-only'}],changes:{minDr:40}})).status,404);assert.equal((await f.q('/project-queue/items/'+legacy.id+'/retry',{})).status,404);
 const result=await f.q('/projects/'+project.id+'/queue/start',{planToken:before.publicationPlan.token});assert.equal(result.status,202,JSON.stringify(result));assert.equal(result.queued,1);f.s.projectQueue.feed();assert.ok(f.s.store.getRecord(run.id).publicationApproval);assert.equal(f.s.store.listRecords(project.id,'autopilot').some(value=>value.pageId===legacy.id),false);assert.equal(f.s.store.getPage(legacy.id).fullUrl,legacy.fullUrl);
});

// Catches reporting published check failures as unpublished or hiding their attention count.
test('published verification problems and unknown checks add attention while retaining published totals',async t=>{
 const f=await fixture(t),project=f.s.store.createProject({name:'Published checks'});
 for(const state of ['ok','problem','unknown','pending']){const page=f.published(project,state);if(state!=='pending')f.s.store.observeChecks(page.id,[{kind:'links',state}],page.revision);}
 const completed=f.published(project,'Completed run'),failed=f.published(project,'Failed checks'),checking=f.published(project,'Checking');f.runFor(completed);f.runFor(failed,{state:'needs_attention',stage:'checking',error:{code:'CHECK_FAILED'}});f.runFor(checking,{state:'checking',stage:'checking'});for(const page of [completed,failed])f.s.store.observeChecks(page.id,[{kind:'links',state:'problem'}],page.revision);
 const view=await f.queue(project.id);assert.equal(view.counts.total,7);assert.equal(view.counts.completed,7);assert.equal(view.counts.attention,4);assert.equal(view.counts.publishing,1);assert.equal(view.items.find(item=>item.pageId===failed.id).verification.state,'problem');assert.equal(view.items.find(item=>item.title==='unknown').verification.state,'unknown');assert.equal(view.items.find(item=>item.title==='pending').verification.state,'pending');
});

// Catches resurrecting user-deleted runs as a new synthetic published row.
test('archived and discarded pages remain hidden and deleted run references never revive',async t=>{
 const f=await fixture(t),archived=f.s.store.createProject({name:'Closed',archived:true}),discarded=f.s.store.createProject({name:'Discarded'}),deleted=f.s.store.createProject({name:'Previously deleted'});f.published(archived);const discardedPage=f.published(discarded,'Discarded page',{lifecycleState:'discarded'});f.runFor(discardedPage,{state:'deleted',deletedAt:new Date().toISOString()});const deletedPage=f.published(deleted,'Old deletion without discard');f.runFor(deletedPage,{state:'deleted',deletedAt:new Date().toISOString()});
 const view=await f.q('/project-queue');assert.equal(view.projects.some(project=>project.projectId===archived.id),false);const rows=view.projects.flatMap(project=>project.items);assert.equal(rows.some(item=>item.pageId===discardedPage.id||item.pageId===deletedPage.id),false);assert.equal(view.projects.some(project=>project.projectId===discarded.id),false);
});

// Catches manual imported destinations becoming invisible/unapprovable in the workspace.
test('manual imported destinations expose safe selected sites and start only the exact displayed plan',async t=>{
 const f=await fixture(t),{project,item}=await f.prepare(),destination={baseUrl:'https://manual.example/blog/',username:'manual-private-user',password:'manual-private-password'};assert.equal((await f.q('/autopilot/'+item.runId+'/destination',destination)).status,200);const before=await f.queue(project.id),manual=before.items[0];assert.deepEqual(manual.selectedSite,{baseUrl:'https://manual.example/blog/',dr:null,traffic:null,geo:[],manual:true});assert.equal(manual.canApprove,true);assert.equal(manual.canEditRequirements,false);assert.equal(before.publicationPlan.count,1);assert.match(before.publicationPlan.token,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(before),/manual-private-user|manual-private-password|manualCredential|ciphertext/);
 assert.equal((await f.q('/autopilot/'+item.runId+'/destination',{...destination,baseUrl:'https://replacement.example/'})).status,200);assert.equal((await f.q('/projects/'+project.id+'/queue/start',{planToken:before.publicationPlan.token})).status,409);const current=await f.queue(project.id),started=await f.q('/projects/'+project.id+'/queue/start',{planToken:current.publicationPlan.token});assert.equal(started.status,202,JSON.stringify(started));assert.equal(started.queued,1);assert.equal(f.s.store.getRecord(item.runId).state,'queued');assert.ok(f.s.store.getRecord(item.runId).publicationApproval);
});

// Catches broadening manual readiness beyond the existing remote phase guard.
test('manual project plans retain native publication phase guards',async t=>{
 const f=await fixture(t),{project,item}=await f.prepare();assert.equal((await f.q('/autopilot/'+item.runId+'/destination',{baseUrl:'https://manual.example/',username:'user',password:'secret'})).status,200);
 let run=f.s.store.getRecord(item.runId);f.s.store.updateRecord(run.id,{nativePublication:{phase:'draft',postId:99}},run.revision);assert.equal((await f.queue(project.id)).publicationPlan.count,1);run=f.s.store.getRecord(run.id);f.s.store.updateRecord(run.id,{nativePublication:{phase:'dispatching',postId:99}},run.revision);assert.equal((await f.queue(project.id)).publicationPlan.count,0);
});
