const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const sourceConfig={spreadsheetId:'requirements-fixture',range:'Sites!A1:F100',serviceAccount:{client_email:'reader@fixture.iam.gserviceaccount.com',private_key:'fixture'},columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'}};
const donor=(id,dr=60)=>({id,baseUrl:'https://'+id+'.example/',username:'private-user',password:'private-password',metrics:{dr,traffic:2000,geo:['PL']}});
const htmlRow=key=>({key,source:'html',title:'Original '+key,html:'<!doctype html><html><body><h1>Original '+key+'</h1><p>Prepared content stays unchanged.</p></body></html>',language:'pl',geo:'PL',siteSelection:{minDr:20,minTraffic:100,geo:'PL'}});
async function fixture(t,{candidates=[donor('first'),donor('second')],reader}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-requirements-'));
 const service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,74).toString('base64'),autopilotOptions:{source:reader||{readCandidates:async()=>({candidates,issues:[]})},planner:{generate:async()=>assert.fail('Requirements edits must not generate content')}},client:{checkSite:async()=>assert.fail('Requirements edits must not contact WordPress')}});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
 const queue=async projectId=>(await q('/project-queue')).projects.find(project=>project.projectId===projectId);
 const add=async(count=1)=>{const body={idempotencyKey:crypto.randomUUID(),name:'Local requirements',type:'html',items:Array.from({length:count},(_,i)=>htmlRow('row-'+i))},result=await q('/project-queue/import',body);assert.equal(result.status,201);return {...result,body};};
 const prepare=async()=>{service.projectQueue.feed();for(let i=0;i<3;i++)for(let slot=0;slot<2;slot++)await service.autopilot.tick({lane:'generation',slot});};
 const ready=async()=>{await prepare();assert.equal((await q('/autopilot/source',sourceConfig)).status,200);await service.autopilot.selectPending();};
 const edit=(items,changes)=>q('/project-queue/requirements',{items:items.map(item=>({id:item.id,expectedRevision:item.requirementsRevision})),changes});
 return {s:service,q,queue,add,prepare,ready,edit};
}

// Catches omission of queue input/hash updates, stale checks, or immutable batch replay.
test('waiting imports edit criteria atomically and retain import replay identity',async t=>{
 const f=await fixture(t),imported=await f.add(),before=(await f.queue(imported.project.id)).items[0],raw=f.s.store.getRecord(before.id);
 assert.equal(before.canEditRequirements,true);assert.equal(typeof before.requirementsRevision,'string');assert.ok(before.requirementsRevision.length>0);
 assert.deepEqual(await f.edit([before],{minDr:0,minTraffic:null}),{status:200,updated:1});
 const after=(await f.queue(imported.project.id)).items[0],changed=f.s.store.getRecord(before.id);assert.deepEqual(after.siteSelection,{minDr:0,minTraffic:null,geo:'PL'});assert.equal(changed.input.html,raw.input.html);assert.notEqual(changed.inputHash,raw.inputHash);assert.equal(f.s.store.getRecord(raw.runId),null);assert.notEqual(after.requirementsRevision,before.requirementsRevision);
 assert.equal((await f.edit([before],{minDr:50})).status,409);assert.equal((await f.q('/project-queue/import',imported.body)).reused,true);
 const duplicate=await f.q('/project-queue/import',{...imported.body,idempotencyKey:crypto.randomUUID(),name:undefined,projectId:imported.project.id,items:[{...htmlRow('row-0'),siteSelection:{minDr:0,minTraffic:null,geo:'PL'}}]});assert.equal(duplicate.status,201,JSON.stringify(duplicate));assert.equal(duplicate.batch.duplicateCount,1);
});

test('batch language and GEO changes retain prepared HTML and fence the old review',async t=>{
 const f=await fixture(t),imported=await f.add(2);
 await f.ready();
 const before=(await f.queue(imported.project.id)).items;
 const previews=await Promise.all(before.map(item=>f.q('/autopilot/'+item.runId+'/html')));
 assert.deepEqual(await f.edit(before,{language:'en-NZ',geo:'NZ'}),{status:200,updated:2});
 const after=(await f.queue(imported.project.id)).items;
 for(const [index,item] of after.entries()){
  const preview=await f.q('/autopilot/'+item.runId+'/html');
  assert.equal(item.language,'en-nz');
  assert.equal(item.geo,'NZ');
  assert.equal(preview.html,previews[index].html);
  assert.notEqual(preview.reviewToken,previews[index].reviewToken);
  assert.equal(item.selectedSite,null);
 }
});

// Catches retained credentials/approval, stale project plans, or accidental HTML changes.
test('editing a reserved donor retains prepared HTML and invalidates prior review and project plan',async t=>{
 const f=await fixture(t),imported=await f.add();await f.ready();const project=await f.queue(imported.project.id),before=project.items[0],run=f.s.store.getRecord(before.runId),page=f.s.store.getPage(before.pageId),preview=await f.q('/autopilot/'+run.id+'/html');
 assert.equal(before.canEditRequirements,true);assert.equal(before.selectedSite.baseUrl,'https://first.example/');assert.ok(run.candidateCredential);
 assert.deepEqual(await f.edit([before],{minDr:70}),{status:200,updated:1});
 const changed=f.s.store.getRecord(run.id),after=(await f.queue(imported.project.id)).items[0];assert.equal(changed.candidate,null);assert.equal(changed.candidateCredential,null);assert.equal(changed.alternateCredential,null);assert.equal(changed.publicationApproval,null);assert.equal(changed.destinationRevision,1);assert.equal(changed.state,'awaiting_review');assert.equal(changed.stage,'selecting');assert.equal(changed.requestHash,run.requestHash);assert.equal(changed.requestId,run.requestId);assert.deepEqual(f.s.store.getPage(page.id),page);assert.equal((await f.q('/autopilot/'+run.id+'/html')).html,preview.html);assert.deepEqual(after.siteSelection,{minDr:70,minTraffic:100,geo:'PL'});
 assert.equal((await f.q('/projects/'+imported.project.id+'/queue/start',{planToken:project.publicationPlan.token})).status,409);assert.ok((await f.q('/project-queue/approve',{items:[{id:before.id,reviewToken:preview.reviewToken}]})).status>=400);
 assert.doesNotMatch(JSON.stringify(after),/private-password|private-user|ciphertext|candidateCredential/);
});

// Catches regeneration or retention of failed-selection diagnostics after changing filters.
test('failed local selection can be edited and selected again without rebuilding its page',async t=>{
 const candidates=[],f=await fixture(t,{candidates}),imported=await f.add();await f.ready();const before=(await f.queue(imported.project.id)).items[0],run=f.s.store.getRecord(before.runId),page=f.s.store.getPage(before.pageId);assert.equal(before.state,'needs_attention');
 f.s.store.updateRecord(run.id,{state:'failed',selectionDiagnostics:{criteria:run.siteSelection,total:0},error:{code:'SOURCE_EMPTY'}},run.revision);const failed=(await f.queue(imported.project.id)).items[0];assert.equal(failed.canEditRequirements,true);
 assert.equal((await f.edit([failed],{minTraffic:0})).status,200);assert.equal(f.s.store.getRecord(run.id).selectionDiagnostics,null);assert.equal(f.s.store.getRecord(run.id).error,null);candidates.push(donor('available'));
 await f.s.autopilot.selectPending();assert.equal((await f.queue(imported.project.id)).items[0].selectedSite.baseUrl,'https://available.example/');assert.deepEqual(f.s.store.getPage(page.id),page);
});

// Catches accepting malformed/empty changes, duplicates, unbounded batches, or no-op resets.
test('requirements validation rejects empty and malformed batches and no-op edits have no side effects',async t=>{
 const f=await fixture(t),imported=await f.add();await f.ready();const before=(await f.queue(imported.project.id)).items[0],run=f.s.store.getRecord(before.runId),raw=f.s.store.getRecord(before.id);
 assert.deepEqual(await f.edit([before],{minDr:20,minTraffic:100}),{status:200,updated:0});assert.deepEqual(f.s.store.getRecord(run.id),run);assert.deepEqual(f.s.store.getRecord(raw.id),raw);
 for(const changes of [{},null,[],{geo:'Poland'},{minDr:-1},{minDr:101},{minDr:'30'},{minTraffic:-1},{minTraffic:0.5},{minTraffic:Number.MAX_SAFE_INTEGER+1}])assert.equal((await f.edit([before],changes)).status,400,JSON.stringify(changes));
 for(const items of [[],[before,before],Array.from({length:1001},()=>before)])assert.equal((await f.edit(items,{minDr:40})).status,400);
 for(const entry of [{id:before.id},{id:before.id,expectedRevision:1},{id:before.id,expectedRevision:before.requirementsRevision,extra:true}])assert.equal((await f.q('/project-queue/requirements',{items:[entry],changes:{minDr:40}})).status,400);
 assert.deepEqual(f.s.store.getRecord(run.id),run);assert.deepEqual(f.s.store.getRecord(raw.id),raw);
});

// Catches partial writes when a later row has become unsafe or stale.
test('an unsafe or stale row rejects the whole batch before any write',async t=>{
 const f=await fixture(t),imported=await f.add(2);await f.ready();const before=(await f.queue(imported.project.id)).items,first=f.s.store.getRecord(before[0].id),firstRun=f.s.store.getRecord(before[0].runId),second=f.s.store.getRecord(before[1].runId);
 f.s.store.updateRecord(second.id,{leaseToken:'unresolved',leaseUntil:'malformed'},second.revision);assert.equal((await f.edit(before,{minDr:40})).status,409);assert.deepEqual(f.s.store.getRecord(first.id),first);assert.deepEqual(f.s.store.getRecord(firstRun.id),firstRun);
 const leased=f.s.store.getRecord(second.id);f.s.store.updateRecord(second.id,{leaseToken:null,leaseUntil:null},leased.revision);assert.equal((await f.edit(before,{minDr:40})).status,409);assert.deepEqual(f.s.store.getRecord(first.id),first);
});

// Catches changing criteria after a remote/manual action, including orphaned evidence.
test('remote, manual, leased and active runs never advertise or accept requirements editing',async t=>{
 const patches=[{state:'queued'},{state:'running'},{state:'uncertain'},{state:'completed'},{stage:'generating'},{stage:'preparing'},{publicationApproval:{reviewToken:'approved'}},{manualTarget:{baseUrl:'https://manual.example/'}},{manualCredential:{ciphertext:'opaque'}},{destinationHistory:[{baseUrl:'https://old.example/'}]},{browserWindow:true},{browserPreparing:true},{browserPreparingUntil:'invalid'},{nativePublication:{phase:'draft',postId:10}},{nativeSnapshot:{pageRevision:1}},{nativeCapacityReserved:true},{nativePublishedRevision:2},{siteId:'site-id'},{jobId:'job-id'},{checkJobId:'check-id'},{bootstrapStage:'ready'},{apiCredential:{ciphertext:'opaque'}},{publicationMode:'native'},{publicationAttempt:1},{donorSkips:[{baseUrl:'https://skipped.example/'}]},{candidateCredentialIndex:1},{candidateCredentialFailures:[{code:'bootstrap_auth_failed'}]},{leaseToken:'expired',leaseUntil:'2000-01-01T00:00:00.000Z'},{leaseToken:'invalid',leaseUntil:'invalid'},{leaseOwner:'orphan'},{leaseUntil:'invalid'},{error:{code:'NATIVE_RESULT_UNCERTAIN'}}];
 const f=await fixture(t,{candidates:[]}),imported=await f.add();await f.prepare();const before=(await f.queue(imported.project.id)).items[0];let base=f.s.store.getRecord(before.runId);
 for(const patch of patches){const current=f.s.store.getRecord(base.id);f.s.store.updateRecord(base.id,{...Object.fromEntries(Object.keys(current).filter(key=>!['id','kind','projectId','revision','createdAt','updatedAt'].includes(key)).map(key=>[key,null])),...Object.fromEntries(Object.entries(base).filter(([key])=>!['id','kind','projectId','revision','createdAt','updatedAt'].includes(key))),...patch},current.revision);const item=(await f.queue(imported.project.id)).items[0];assert.equal(item.canEditRequirements,false,JSON.stringify(patch));assert.equal((await f.edit([item],{minDr:40})).status,409,JSON.stringify(patch));}
});

// Catches ignoring published page evidence, unrelated page jobs, or archived projects.
test('page remote evidence, jobs and closed projects fence otherwise local selection',async t=>{
 for(const evidence of ['siteId','wpId','fullUrl','remoteSnapshot','job','archived']){
  const f=await fixture(t),imported=await f.add();await f.ready();const before=(await f.queue(imported.project.id)).items[0],page=f.s.store.getPage(before.pageId);
  if(evidence==='job')f.s.store.enqueueJob({projectId:imported.project.id,pageId:page.id,type:'page_check',payload:{},idempotencyKey:'read-evidence'});
  else if(evidence==='archived'){const project=f.s.store.getProject(imported.project.id);f.s.store.updateProject(project.id,{archived:true},project.revision);}
  else {const site=evidence==='siteId'?f.s.store.createSite(imported.project.id,{name:'Remote',baseUrl:'https://remote.example/'}):null;f.s.store.updatePage(page.id,{[evidence]:evidence==='wpId'?99:evidence==='remoteSnapshot'?{content:'remote'}:evidence==='fullUrl'?'https://published.example/page':site.id},page.revision);}
  assert.equal((await f.edit([before],{minDr:40})).status,409,evidence);if(evidence!=='archived')assert.equal((await f.queue(imported.project.id)).items[0].canEditRequirements,false,evidence);
 }
});

// Catches attaching old selection results or reusing its candidate cache after an edit.
test('an in-flight donor snapshot cannot attach its old result after requirements change',async t=>{
 let entered,release,reads=0;const began=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),f=await fixture(t,{reader:{readCandidates:async()=>{reads++;if(reads===1){entered();await gate;}return {candidates:[donor(reads===1?'obsolete':'fresh',80)],issues:[]};}}}),imported=await f.add();await f.prepare();await f.q('/autopilot/source',sourceConfig);
 const pending=f.s.autopilot.selectPending();await began;const before=(await f.queue(imported.project.id)).items[0];assert.equal(before.canEditRequirements,true);assert.equal((await f.edit([before],{minDr:75})).status,200);release();await pending;assert.equal((await f.queue(imported.project.id)).items[0].selectedSite,null);
 await f.s.autopilot.selectPending();assert.equal((await f.queue(imported.project.id)).items[0].selectedSite.baseUrl,'https://fresh.example/');assert.equal(reads,2);
});

// Catches failure to route legacy standalone runs through their prepared run record.
test('legacy standalone prepared runs use the same safe requirements contract',async t=>{
 const f=await fixture(t),imported=await f.add();await f.prepare();const template=(await f.queue(imported.project.id)).items[0],prepared=f.s.store.getPage(template.pageId),project=f.s.store.createProject({name:'Legacy standalone'}),run=f.s.autopilot.launch(project.id,{idempotencyKey:crypto.randomUUID(),links:[{url:'https://resource.example/',anchor:'Resource'}]}),page=f.s.store.createPage(project.id,{title:'Legacy prepared',config:prepared.config,expectedUrls:prepared.expectedUrls}),raw=f.s.store.getRecord(run.id);
 f.s.store.updateRecord(run.id,{pageId:page.id,state:'awaiting_review',stage:'selecting',reviewBeforePublish:true},raw.revision);const item=(await f.queue(project.id)).items[0],preview=await f.q('/autopilot/'+run.id+'/html');assert.equal(item.canEditRequirements,true);assert.equal((await f.edit([item],{minDr:33})).status,200);const changed=f.s.store.getRecord(run.id);assert.deepEqual(changed.siteSelection,{minDr:33,minTraffic:null,geo:''});assert.equal(changed.pageId,page.id);assert.equal(changed.requestHash,raw.requestHash);assert.equal((await f.q('/project-queue/approve',{items:[{id:run.id,reviewToken:preview.reviewToken}]})).status,400);
});

// Catches a run-ID alias changing only the run, or counting one page twice.
test('an imported run ID edits its queue snapshot and duplicate aliases reject the batch',async t=>{
 const f=await fixture(t),imported=await f.add();await f.ready();const before=(await f.queue(imported.project.id)).items[0];
 const result=await f.q('/project-queue/requirements',{items:[{id:before.runId,expectedRevision:before.requirementsRevision}],changes:{minDr:45}});assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.s.store.getRecord(before.id).input.siteSelection.minDr,45);assert.equal(f.s.store.getRecord(before.runId).siteSelection.minDr,45);
 const current=(await f.queue(imported.project.id)).items[0],raw=f.s.store.getRecord(before.runId),duplicate=await f.q('/project-queue/requirements',{items:[{id:before.id,expectedRevision:current.requirementsRevision},{id:before.runId,expectedRevision:current.requirementsRevision}],changes:{minDr:55}});assert.equal(duplicate.status,400);assert.deepEqual(f.s.store.getRecord(raw.id),raw);
});

// Catches old individual approvals surviving an edit before any donor exists.
test('requirements edits invalidate an individual preview token before a donor is selected',async t=>{
 const f=await fixture(t),imported=await f.add();await f.prepare();const before=(await f.queue(imported.project.id)).items[0],preview=await f.q('/autopilot/'+before.runId+'/html');assert.equal(before.selectedSite,null);
 assert.equal((await f.edit([before],{minTraffic:500})).status,200);const stale=await f.q('/project-queue/approve',{items:[{id:before.id,reviewToken:preview.reviewToken}]});assert.equal(stale.status,400,JSON.stringify(stale));assert.equal(f.s.store.getRecord(before.runId).state,'awaiting_review');assert.equal(f.s.store.getRecord(before.runId).publicationApproval,null);
});

// Catches treating absent legacy criteria as a change when clearing an already empty limit.
test('clearing an absent legacy requirement is a no-op',async t=>{
 const f=await fixture(t),imported=await f.add();await f.prepare();const source=(await f.queue(imported.project.id)).items[0],prepared=f.s.store.getPage(source.pageId),project=f.s.store.createProject({name:'Legacy defaults'}),page=f.s.store.createPage(project.id,{title:'Default requirements',config:prepared.config}),run=f.s.store.createRecord(project.id,'autopilot',{state:'awaiting_review',stage:'selecting',reviewBeforePublish:true,pageId:page.id,source:'ai'});
 const item=(await f.queue(project.id)).items[0];assert.equal(item.canEditRequirements,true);assert.deepEqual(await f.edit([item],{minDr:null,minTraffic:null}),{status:200,updated:0});assert.deepEqual(f.s.store.getRecord(run.id),run);
});
