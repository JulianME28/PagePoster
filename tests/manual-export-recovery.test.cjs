'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const MASTER=Buffer.alloc(32,121).toString('base64'),REKEYED=Buffer.alloc(32,122).toString('base64'),PASSPHRASE='fixture manual export recovery password';
const rawMarker='raw-original-only-recovery-marker';
const original='\uFEFF<!doctype html>\r\n<!-- '+rawMarker+' -->\r\n<html lang="pl"><head><title>Recovery exact title</title><style>.cta { padding: 12px; color: #246; }</style></head><body><h1>Recovery exact title</h1><a id="offer" class="cta" href="https://publisher.org/a%2fb?x=1&amp;x=2&amp;ref=%2520#part">  Exact Łódź anchor  </a><p>Unchanged current material.</p><script>window.originalOnly="'+rawMarker+'";</script></body></html>\r\n';
const digest=value=>crypto.createHash('sha256').update(value,'utf8').digest('hex');

async function fixture(t){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-c02-manual-recovery-')),opened=new Set();let remoteCalls=0;
 const forbidden=()=>{remoteCalls++;assert.fail('Manual export recovery must not generate, read donors, open browsers or contact WordPress');};
 const open=async(dataDir=dir,masterKey=MASTER)=>{
  const service=await createLifecycleService({dataDir,masterKey,autopilotOptions:{source:{readCandidates:forbidden,pickUnused:forbidden},planner:{generate:forbidden}},client:{checkSite:forbidden,fetchPage:forbidden,createPage:forbidden,updatePage:forbidden},bridgeClient:{checkStatus:forbidden},browserVerifier:{verifyPublished:forbidden},wordPressFactory:forbidden});
  opened.add(service);return service;
 };
 let service=await open();
 t.after(async()=>{for(const current of opened)await current.close();assert.equal(remoteCalls,0);assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.match(path.basename(dir),/^pp-c02-manual-recovery-/);fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body,target=service)=>{
  const response=await target.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));assert.ok(response,route);return {status:response.status,...await response.json()};
 };
 const launch=async()=>{
  const project=service.store.createProject({name:'Recovery direct HTML'}),input={source:'html',html:original,chromeMode:'overlay-only'},preview=await q('/autopilot/preview',input);assert.equal(preview.status,200,JSON.stringify(preview));
  const body={...input,idempotencyKey:crypto.randomUUID(),reviewBeforePublish:true,reviewToken:preview.reviewToken},started=await q('/projects/'+project.id+'/autopilot',body);assert.equal(started.status,202,JSON.stringify(started));await service.autopilot.tick({lane:'generation'});const run=service.store.getRecord(started.run.id);assert.ok(run.pageId);return {project,input,body,id:run.id};
 };
 const queue=async()=>{
  const preview=await q('/project-import/preview',{type:'html',files:[{name:'pl-recovery.html',html:original}],defaults:{language:'pl',geo:'PL',minDr:25}});assert.equal(preview.status,200);assert.deepEqual(preview.issues,[]);
  const imported=await q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Recovery queued HTML',type:'html',items:preview.items});assert.equal(imported.status,201,JSON.stringify(imported));service.projectQueue.feed();await service.autopilot.tick({lane:'generation',slot:0});
  const item=service.store.listRecords(imported.project.id,'project_queue_item')[0],run=service.store.getRecord(item.runId);assert.ok(run.pageId);return {project:imported.project,id:run.id,itemId:item.id};
 };
 const restart=async()=>{await service.close();opened.delete(service);service=await open();};
 const archive=async()=>{
  const {createRunStore}=await import('../server/lifecycle/run-store.mjs'),{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs'),{exportFullBackup}=await import('../server/lifecycle/full-recovery.mjs');
  createRunStore({filename:path.join(dir,'generation-runs.sqlite')}).close();createAIBudget({filename:path.join(dir,'ai-budget.sqlite')}).close();return exportFullBackup({dataDir:dir,masterKey:MASTER,passphrase:PASSPHRASE});
 };
 const restore=async(backup,name='restored')=>{const {restoreFullBackup}=await import('../server/lifecycle/full-recovery.mjs'),target=path.join(dir,name);await restoreFullBackup({dataDir:target,masterKey:REKEYED,backup,passphrase:PASSPHRASE});return open(target,REKEYED);};
 return {dir,q,open,launch,queue,restart,archive,restore,get service(){return service;}};
}

async function exported(f,id,target=f.service){
 const run=target.store.getRecord(id),page=target.store.getPage(run.pageId),current=await f.q('/autopilot/'+id+'/html',undefined,target);assert.equal(current.status,200);
 const raw=await f.q('/autopilot/'+id+'/manual-export?variant=original',undefined,target),prepared=await f.q('/autopilot/'+id+'/manual-export?variant=prepared',undefined,target);assert.equal(raw.status,200,JSON.stringify(raw));assert.equal(prepared.status,200,JSON.stringify(prepared));
 for(const value of [raw,prepared]){assert.equal(value.runId,id);assert.equal(value.pageId,page.id);assert.equal(value.pageRevision,page.revision);assert.equal(value.title,page.title);assert.equal(value.available.original,true);}
 assert.equal(raw.html,original);assert.equal(prepared.html,current.html);assert.notEqual(prepared.html,original);assert.equal(digest(raw.html),digest(original));
 assert.deepEqual(target.store.getRecord(id),run,'Manual reads must not change the run');assert.deepEqual(target.store.getPage(page.id),page,'Manual reads must not change current page material');assert.deepEqual(target.store.listJobs(run.projectId),[]);
 return {raw,prepared,page,run};
}

const material=run=>({id:run.id,projectId:run.projectId,pageId:run.pageId,requestHash:run.requestHash,approvedHtmlHash:run.approvedHtmlHash,customerConfig:run.customerConfig,siteSelection:run.siteSelection,chromeMode:run.chromeMode,source:run.source,title:run.title,links:run.links,reviewBeforePublish:run.reviewBeforePublish,queueItemId:run.queueItemId});

async function assertPublicProjections(f,project,id,target=f.service){
 const listing=await f.q('/projects/'+project.id+'/autopilot',undefined,target),support=await f.q('/support/export',{},target),backup=await f.q('/backup',undefined,target);assert.equal(listing.status,200);assert.equal(support.status,200);assert.equal(backup.status,200);
 for(const [name,projection] of [['listing',listing],['support',support]]){const text=JSON.stringify(projection);assert.equal(text.includes(rawMarker),false,name+': private raw original must not enter ordinary public projections');assert.equal(text.includes(JSON.stringify(original).slice(1,-1)),false,name+': exact raw source leaked');}
 // Explicit page/config backups keep authored content under their established
 // contract. The new private workspace envelope must add no public collection.
 for(const projection of [listing,support,backup])assert.doesNotMatch(JSON.stringify(projection),/customerOriginalHtml|customer_original|original-html:/);
 assert.equal(Object.hasOwn(backup,'workspaceRecords'),false);assert.equal(Object.hasOwn(backup,'records'),false);
 const rawRun=target.store.getRecord(id);for(const field of ['customerOriginalHtml','originalHtml','customerOriginal','originalSource'])assert.equal(Object.hasOwn(rawRun,field),false,'Hot autopilot records must not add duplicate private-original fields');
 assert.deepEqual(target.store.listJobs(project.id),[]);
}

test('direct original and current prepared manual exports survive restart without leaking into ordinary projections',async t=>{
 const f=await fixture(t),direct=await f.launch(),before=await exported(f,direct.id),record=f.service.store.getRecord('original-html:'+direct.id);assert.equal(record.kind,'customer_original');assert.equal(record.runId,direct.id);assert.equal(record.html,original);assert.equal(record.sourceHash,digest(original));
 await f.restart();const after=await exported(f,direct.id);assert.deepEqual(after.raw,before.raw);assert.deepEqual(after.prepared,before.prepared);assert.deepEqual(after.page,before.page);assert.deepEqual(material(after.run),material(before.run));assert.deepEqual(f.service.store.getRecord(record.id),record);await assertPublicProjections(f,direct.project,direct.id);
});

test('direct and immutable queue originals survive encrypted full recovery under a new master key with unchanged current material',async t=>{
 const f=await fixture(t),direct=await f.launch(),queued=await f.queue();
 // Local persisted evidence only: no WordPress adapter or publication is run.
 const run=f.service.store.getRecord(direct.id),page=f.service.store.getPage(run.pageId),current=await f.q('/autopilot/'+direct.id+'/html'),content=current.html.replaceAll('https://publisher.org/a%2fb?x=1','https://publisher.org/current%2F?x=3'),site=f.service.store.createSite(direct.project.id,{name:'Local saved native evidence',baseUrl:'https://native-fixture.org/'}),url='https://native-fixture.org/current-page/';
 const remoteSnapshot={mode:'browser',postId:71,postType:'page',title:page.title,url,status:'publish',content,contentHash:digest(JSON.stringify(['page',page.title,content,'publish']))};f.service.store.updatePage(page.id,{siteId:site.id,wpId:71,fullUrl:url,remoteSnapshot},page.revision);f.service.store.updateRecord(run.id,{state:'completed',stage:'completed'},run.revision);
 const directBefore=await exported(f,direct.id),queueBefore=await exported(f,queued.id),queueItem=f.service.store.getRecord(queued.itemId),privateRecord=f.service.store.getRecord('original-html:'+direct.id);assert.equal(directBefore.prepared.html,content);assert.notEqual(content,current.html);
 assert.equal(queueItem.input.html,original);assert.equal(f.service.store.getRecord('original-html:'+queued.id),null,'Queue sources use their existing immutable input snapshot');
 const backup=await f.archive();assert.doesNotMatch(JSON.stringify(backup),new RegExp(rawMarker));assert.equal(JSON.stringify(backup).includes(JSON.stringify(original).slice(1,-1)),false);const restored=await f.restore(backup);
 for(const [entry,before] of [[direct,directBefore],[queued,queueBefore]]){const after=await exported(f,entry.id,restored);assert.deepEqual(after.raw,before.raw);assert.deepEqual(after.prepared,before.prepared);assert.deepEqual(after.page,before.page);assert.deepEqual(material(after.run),material(before.run));}
 assert.deepEqual(restored.store.getRecord(queued.itemId),queueItem);assert.deepEqual(restored.store.getRecord(privateRecord.id),privateRecord);assert.deepEqual(f.service.store.getPage(directBefore.page.id),directBefore.page);assert.deepEqual(f.service.store.getPage(queueBefore.page.id),queueBefore.page);
 await assertPublicProjections(f,direct.project,direct.id,restored);await assertPublicProjections(f,queued.project,queued.id,restored);
});

test('explicit local run deletion clears its private original and restart or full recovery cannot resurrect it',async t=>{
 const f=await fixture(t),direct=await f.launch(),before=await exported(f,direct.id),removed=await f.q('/autopilot/'+direct.id+'/delete',{});assert.equal(removed.status,200,JSON.stringify(removed));assert.equal(removed.deleted,true);
 const tombstone=f.service.store.getRecord(direct.id),privateRecord=f.service.store.getRecord('original-html:'+direct.id);assert.equal(tombstone.state,'deleted');assert.ok(tombstone.deletedAt);assert.equal(privateRecord.html,null);assert.ok(privateRecord.deletedAt);assert.equal(privateRecord.sourceHash,digest(original));assert.equal(f.service.store.getPage(before.page.id),null);assert.equal((await f.q('/autopilot/'+direct.id+'/manual-export?variant=original')).status,404);
 assert.equal((await f.q('/projects/'+direct.project.id+'/autopilot',direct.body)).status,404,'An old launch replay must not recreate a deleted original');await f.restart();assert.equal(f.service.store.getRecord(privateRecord.id).html,null);assert.equal((await f.q('/autopilot/'+direct.id+'/manual-export?variant=prepared')).status,404);
 const restored=await f.restore(await f.archive(),'deleted-restored');assert.equal(restored.store.getRecord(privateRecord.id).html,null);assert.ok(restored.store.getRecord(direct.id).deletedAt);assert.equal((await f.q('/autopilot/'+direct.id+'/manual-export?variant=original',undefined,restored)).status,404);assert.deepEqual(restored.store.listJobs(direct.project.id),[]);await assertPublicProjections(f,direct.project,direct.id,restored);
});
