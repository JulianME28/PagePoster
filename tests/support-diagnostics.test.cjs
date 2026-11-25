'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const secret='INJECTED_PRIVATE_TOKEN_42';
const KEY=Buffer.alloc(32,64).toString('base64');
const load=()=>import('../server/lifecycle/support-diagnostics.mjs');
test('support phase quantiles are exact bounded aggregates with separate fixed metric scopes and no samples',async()=>{
 const {createSupportReport}=await load(),rows=[10,20,30,40,50].map(elapsedMs=>({phase:'login',timingScope:'operation',elapsedMs,networkMs:null,code:'OK'}));rows.push({phase:'manual_wait',timingScope:'manual_wait_wall',manualWaitMs:60000,elapsedMs:null,code:'OK'});rows.push({phase:'check',timingScope:'worker_operation',elapsedMs:25,workerQueueWaitMs:5000,workerQueueWaitScope:'job_created_to_claim_wall',jobLifetimeMs:6025,code:'OK'});
 const store={listProjects:()=>[{id:'private'}],listPageSummaries:()=>[],listJobs:()=>[],listRecords:()=>[{state:'completed',publicationDiagnostics:rows}]},report=createSupportReport({store});const login=report.phaseTimings.login;assert.equal(login.p50Ms,30);assert.equal(login.p95Ms,50);assert.equal(login.scopes.operation.elapsedMs.samples,5);assert.equal(report.phaseTimings.manual_wait.samples,0);assert.equal(report.phaseTimings.manual_wait.scopes.manual_wait_wall.manualWaitMs.p95Ms,60000);assert.equal(report.phaseTimings.check.scopes.worker_operation.workerQueueWaitMs.p50Ms,5000);assert.doesNotMatch(JSON.stringify(report),/private|\[10,20,30,40,50\]/);
});
test('support report constructs a bounded allowlist without backup, content, identifiers or free text',async()=>{
 const {createSupportReport}=await load();let backupCalls=0;
 const project={id:secret,name:secret,sourceSheet:secret};
 const run={id:secret,state:secret,stage:secret,title:secret,url:secret,error:{message:secret,stack:secret},nativePublication:{phase:secret,postId:42,url:secret},publicationDiagnostics:[{phase:secret,code:secret,url:secret,elapsedMs:123},{phase:'login',code:secret,url:secret,cookies:secret,requestClass:secret,method:secret,elapsedMs:123,budgetMs:secret,safeReadRetries:999999}]};
 const store={listProjects:()=>Array(150).fill(project),listPageSummaries:()=>Array(2000).fill({title:secret}),listJobs:()=>Array(2000).fill({state:secret}),listRecords:()=>Array(2000).fill(run),getPage:()=>({title:secret}),exportBackup:()=>{backupCalls++;throw Error('must not export');}};
 const metadata={build:{state:'available',manifestSha256:secret},runtime:{node:secret,electron:secret},startup:{format:1,startedAt:1000,phases:{'main-entered':100,'queue-response':200,[secret]:secret}},path:secret,stack:secret};
 const report=await createSupportReport({store,metadata,now:12345});const serialized=JSON.stringify(report);
 assert.equal(backupCalls,0);assert.doesNotMatch(serialized,new RegExp(secret));assert.ok(serialized.length<65536);assert.equal(report.build.state,'unavailable');assert.equal(report.coverage.truncated,true);
 assert.deepEqual(report.startup.phases,{'main-entered':100,'queue-response':200});assert.equal(report.runStates.unknown,1000);assert.equal(report.phaseTimings.login.samples,1000);assert.equal(report.phaseTimings.login.totalMs,123000);assert.deepEqual(report.phaseCodes.login,{UNKNOWN:1000});assert.equal(report.phaseTimings.login.safeReadRetries,3000);
});
test('support report uses only real manifest hashes and fixed startup phase timing values',async()=>{
 const {createSupportReport}=await load();const hash='b7'.repeat(32),store={listProjects:()=>[]};
 const report=await createSupportReport({store,metadata:{build:{state:'available',manifestSha256:hash},startup:{format:1,startedAt:1000,phases:{'main-entered':-1,'backend-ready':Infinity,'queue-response':23}}}});
 assert.deepEqual(report.build,{state:'available',manifestSha256:hash});assert.deepEqual(report.startup.phases,{'queue-response':23});
 const local=await createSupportReport({store});assert.deepEqual(local.build,{state:'unavailable'});assert.equal(local.startup,null);
});
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-support-'));let metadataCalls=0;
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 const app=await createLifecycleService({dataDir:dir,masterKey:KEY,supportMetadata:()=>{metadataCalls++;return {build:{state:'available',manifestSha256:'ab'.repeat(32)},startup:{format:1,startedAt:1,phases:{'queue-response':25}}};}});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=(body={},headers={})=>app.handle(new Request('http://127.0.0.1:4317/api/lifecycle/support/export',{method:'POST',headers:{Origin:'http://127.0.0.1:4317','Content-Type':'application/json','X-PagePoster-Request':'1',...headers},body:JSON.stringify(body)}));
 return {app,request,calls:()=>metadataCalls};
}
test('support export requires exact empty body and same origin guard; metadata cannot come from caller',async t=>{
 const {request,calls}=await setup(t);
 for(const body of [[],null,{path:'C:/private'},{screenshots:true},{supportMetadata:{build:{state:'available'}}}])assert.equal((await request(body)).status,400);
 for(const headers of [{Origin:'https://evil.example'},{'X-PagePoster-Request':''},{'Sec-Fetch-Site':'cross-site'},{'Content-Type':'text/plain'}])assert.ok([400,403].includes((await request({},headers)).status));
 assert.equal(calls(),0);const response=await request();assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/^attachment; filename="pageposter-support\.json"$/);assert.equal(response.headers.get('cache-control'),'no-store');
 const report=await response.json();assert.equal(report.build.manifestSha256,'ab'.repeat(32));assert.equal(report.startup.phases['queue-response'],25);assert.equal(calls(),1);
});
test('support export leaves project/run/job and queue state unchanged and never invokes backup',async t=>{
 const {app,request}=await setup(t);const project=app.store.createProject({name:secret}),run=app.store.createRecord(project.id,'autopilot',{state:'queued',stage:'installing',title:secret,manualTarget:{baseUrl:'https://private.example'},candidateCredential:secret},'fixture');
 app.store.createRecord(project.id,'project_queue_control',{paused:true,priority:7},'queue-control:'+project.id);
 const before=JSON.stringify({projects:app.store.listProjects(),runs:app.store.listRecords(project.id,'autopilot'),jobs:app.store.listJobs(project.id),queue:app.store.getRecord('queue-control:'+project.id)});
 const response=await request();assert.equal(response.status,200);const text=await response.text();assert.doesNotMatch(text,new RegExp(secret+'|private.example|'+run.id));
 const after=JSON.stringify({projects:app.store.listProjects(),runs:app.store.listRecords(project.id,'autopilot'),jobs:app.store.listJobs(project.id),queue:app.store.getRecord('queue-control:'+project.id)});assert.equal(after,before);
});
