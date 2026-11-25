const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const sourceConfig={spreadsheetId:'selection-sheet',range:'Sites!A1:F100',serviceAccount:{client_email:'reader@fixture.iam.gserviceaccount.com',private_key:'fixture'},columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'}};
const donor=(id,geo,dr=50)=>({id,baseUrl:'https://'+id+'.example/',rowNumber:2,username:'selection-user',password:'selection-secret',metrics:{dr,traffic:2000,geo:[geo]}});
async function fixture(t,{candidates=[donor('polish-one','PL'),donor('polish-two','PL',40),donor('hungarian','HU')],delay,reader,googleBrowser}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-selection-'));let reads=0,remote=0;
 const source=reader||{readCandidates:async()=>{reads++;if(delay)await delay();return {candidates,issues:[]};},pickUnused:async()=>assert.fail('Batch selection must share a source snapshot')};
 const service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,63).toString('base64'),autopilotOptions:{source},...(googleBrowser?{googleBrowser}:{}),visibleBrowser:{nativeEditor:true,prepare:async()=>{remote++;},open:async()=>{remote++;throw Object.assign(Error('Test stop before login'),{code:'BROWSER_LOGIN_REQUIRED'});},error:async()=>{},close:async()=>{}},client:{checkSite:async()=>{remote++;assert.fail('No remote writes before explicit start');}}});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
 const add=async(geos=['PL','HU','PL'])=>q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Prepared donors',type:'html',items:geos.map((geo,index)=>({key:crypto.randomUUID(),source:'html',title:'Page '+index,html:'<!doctype html><html><body><h1>Page '+index+'</h1><p>Exact original content.</p></body></html>',language:geo==='PL'?'pl':'hu',geo,siteSelection:{minDr:20,minTraffic:100,geo}}))});
 const queue=async projectId=>(await q('/project-queue')).projects.find(p=>p.projectId===projectId);
 return {service,q,add,queue,get reads(){return reads;},get remote(){return remote;},ready:async()=>{await q('/autopilot/source',sourceConfig);for(let i=0;i<5;i++)await service.tick();}};
}
test('imported pages reserve distinct matching donors before approval without opening WordPress',async t=>{
 const f=await fixture(t),imported=await f.add();await f.ready();const project=await f.queue(imported.project.id);
 assert.ok(project.items.every(item=>item.state==='awaiting_review'&&item.selectedSite));assert.deepEqual(project.items.map(item=>item.selectedSite.baseUrl),['https://polish-one.example/','https://hungarian.example/','https://polish-two.example/']);assert.equal(f.reads,1);assert.equal(f.remote,0);
 assert.ok(project.items.every(item=>item.selectedSite.dr>=20&&item.selectedSite.traffic>=100&&item.selectedSite.geo.includes(item.geo)));
 assert.doesNotMatch(JSON.stringify(project),/selection-secret|selection-user|candidateCredential|ciphertext/);assert.match(project.publicationPlan.token,/^[a-f0-9]{64}$/);assert.equal(project.publicationPlan.count,3);
 for(const item of project.items){const run=f.service.store.getRecord(item.runId);assert.ok(run.candidateCredential.ciphertext);assert.equal(run.stage,'installing');}
});
test('imported donor and slug are retained and no different donor is selected',async t=>{
 const f=await fixture(t);
 const imported=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Exact destinations',type:'html',items:[
  {key:'one',html:'<h1>First page</h1>',language:'pl',geo:'PL',slug:'exact-slug',donor:'polish-two.example'},
  {key:'two',html:'<h1>Second page</h1>',language:'pl',geo:'PL',donor:'not-in-catalog.example'}
 ]});
 assert.equal(imported.status,201);
 await f.ready();
 const [first,second]=(await f.queue(imported.project.id)).items;
 assert.equal(first.slug,'exact-slug');
 assert.equal(first.selectedSite.baseUrl,'https://polish-two.example/');
 assert.equal(first.donorPinned,true);
 assert.equal(f.service.store.getRecord(first.runId).slug,'exact-slug');
 assert.equal(second.selectedSite,null);
 assert.equal(second.error.code,'IMPORT_DONOR_UNAVAILABLE');
 assert.equal(f.remote,0);
});
test('project start approves only the displayed plan and repeated requests never include appended pages',async t=>{
 const f=await fixture(t),imported=await f.add();assert.equal((await f.q('/projects/'+imported.project.id+'/queue/start',{planToken:'0'.repeat(64)})).status,409);await f.ready();const project=await f.queue(imported.project.id),body={planToken:project.publicationPlan.token};
 const first=await f.q('/projects/'+imported.project.id+'/queue/start',body);assert.equal(first.status,202,JSON.stringify(first));assert.equal(first.queued,3);assert.equal(f.remote,0);
 const items=(await f.queue(imported.project.id)).items;assert.ok(items.every(item=>item.state==='queued'));assert.ok(items.every(item=>f.service.store.getRecord(item.runId).publicationApproval));
 await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:imported.project.id,type:'html',items:[{key:'later',html:'<h1>Later</h1>',language:'en',geo:'GB'}]});
 const again=await f.q('/projects/'+imported.project.id+'/queue/start',body);assert.equal(again.status,202);assert.equal(again.reused,true);assert.equal(again.queued,3);assert.equal((await f.queue(imported.project.id)).items.find(item=>item.key==='later').state,'waiting');
 await f.service.autopilot.tick({lane:'publication'});assert.ok(f.remote>0);assert.equal(f.service.store.listAllSites().length,0);
});
test('missing donors and changed content or destination prevent a stale project start atomically',async t=>{
 const missing=await fixture(t,{candidates:[]}),noSites=await missing.add(['PL']);await missing.ready();const blocked=await missing.queue(noSites.project.id);assert.equal(blocked.publicationPlan.token,null);assert.equal(blocked.items[0].error.code,'SOURCE_EMPTY');assert.equal(missing.remote,0);
 const f=await fixture(t),imported=await f.add();await f.ready();const before=await f.queue(imported.project.id),item=before.items[0],run=f.service.store.getRecord(item.runId);
 f.service.store.updateRecord(run.id,{candidate:{...run.candidate,baseUrl:'https://changed.example/'}},run.revision);assert.equal((await f.q('/projects/'+imported.project.id+'/queue/start',{planToken:before.publicationPlan.token})).status,409);
 const next=await f.queue(imported.project.id),page=f.service.store.getPage(item.pageId);f.service.store.updatePage(page.id,{title:'Changed after display'},page.revision);assert.equal((await f.q('/projects/'+imported.project.id+'/queue/start',{planToken:next.publicationPlan.token})).status,409);assert.ok((await f.queue(imported.project.id)).items.every(item=>!f.service.store.getRecord(item.runId).publicationApproval));assert.equal(f.remote,0);
});
test('deleting a reserved unpublished page releases its donor for another page',async t=>{
 const f=await fixture(t),imported=await f.add(['PL']);await f.ready();const first=(await f.queue(imported.project.id)).items[0];assert.equal((await f.q('/autopilot/'+first.runId+'/delete',{})).status,200);
 const second=await f.add(['PL']);for(let i=0;i<3;i++)await f.service.tick();assert.equal((await f.queue(second.project.id)).items[0].selectedSite.baseUrl,'https://polish-one.example/');assert.equal(f.remote,0);
});
test('source changes during an in-flight selection do not attach obsolete sites',async t=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>entered=resolve);const f=await fixture(t,{delay:async()=>{entered();await gate;}}),imported=await f.add(['PL']);await f.service.tick();await f.q('/autopilot/source',sourceConfig);
 const selection=f.service.autopilot.selectPending();await began;await f.q('/autopilot/source',{...sourceConfig,spreadsheetId:'replacement-sheet'});release();await selection;assert.equal((await f.queue(imported.project.id)).items[0].selectedSite,null);assert.equal(f.remote,0);
});
test('a failed selection can be retried without approving publication or regenerating HTML',async t=>{
 const candidates=[],f=await fixture(t,{candidates}),imported=await f.add(['PL']);await f.ready();const item=(await f.queue(imported.project.id)).items[0],pageId=item.pageId;candidates.push(donor('now-available','PL'));
 assert.equal((await f.q('/project-queue/items/'+item.id+'/retry',{})).status,200);await f.service.autopilot.selectPending();const retried=(await f.queue(imported.project.id)).items[0];assert.equal(retried.pageId,pageId);assert.equal(retried.selectedSite.baseUrl,'https://now-available.example/');assert.equal(retried.state,'awaiting_review');assert.equal(f.remote,0);
});
test('same-origin rows with different regions are filtered before origin deduplication',async t=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),reader=createSiteSource({readSheet:async()=>({values:[['url','user','password','dr','traffic','geo'],['https://mixed.example/','admin','secret',80,2000,'HU'],['https://mixed.example/','admin','secret',50,1000,'PL']]})}),f=await fixture(t,{reader}),imported=await f.add(['PL']);await f.ready();const item=(await f.queue(imported.project.id)).items[0];assert.equal(item.selectedSite?.baseUrl,'https://mixed.example/');assert.deepEqual(item.selectedSite.geo,['PL']);assert.equal(item.selectedSite.dr,50);
});
test('reconnecting a browser Google session invalidates the previous account candidate pool',async t=>{
 const spreadsheetUrl='https://docs.google.com/spreadsheets/d/selection-sheet/edit#gid=0';let connected=true,reads=0,pool=[donor('account-a-one','PL'),donor('account-a-two','PL')];
 const googleBrowser={status:()=>({connected,spreadsheetUrl}),disconnect:async()=>{connected=false;},connect:async()=>{connected=true;pool=[donor('account-b','PL')];return {connected,spreadsheetUrl};},close:async()=>{}},reader={readCandidates:async()=>{reads++;return {candidates:[...pool],issues:[]};}};
 const f=await fixture(t,{reader,googleBrowser}),first=await f.add(['PL']);await f.q('/autopilot/source',{...sourceConfig,authMode:'browser',spreadsheetUrl,sheetId:0});for(let i=0;i<3;i++)await f.service.tick();assert.equal((await f.queue(first.project.id)).items[0].selectedSite.baseUrl,'https://account-a-one.example/');
 await f.q('/google/browser/disconnect',{});await f.q('/google/browser/connect',{spreadsheetUrl});const second=await f.add(['PL']);for(let i=0;i<3;i++)await f.service.tick();assert.equal((await f.queue(second.project.id)).items[0].selectedSite.baseUrl,'https://account-b.example/');assert.equal(reads,2);
});
test('pausing a project blocks start and a bad final page cannot partially approve earlier pages',async t=>{
 const f=await fixture(t),imported=await f.add();await f.ready();let project=await f.queue(imported.project.id);await f.q('/projects/'+imported.project.id+'/queue',{action:'pause'});assert.equal((await f.q('/projects/'+imported.project.id+'/queue/start',{planToken:project.publicationPlan.token})).status,409);await f.q('/projects/'+imported.project.id+'/queue',{action:'resume'});
 const last=project.items.at(-1),page=f.service.store.getPage(last.pageId);f.service.store.updatePage(page.id,{title:'Unexpected title drift'},page.revision);project=await f.queue(imported.project.id);assert.equal((await f.q('/projects/'+imported.project.id+'/queue/start',{planToken:project.publicationPlan.token})).status,400);assert.ok(project.items.every(item=>!f.service.store.getRecord(item.runId).publicationApproval));assert.equal(f.remote,0);
});
test('project start queues ready selected pages while missing donors remain untouched for later retry',async t=>{
 const f=await fixture(t),imported=await f.add(['PL','HU','SK']);await f.ready();const project=await f.queue(imported.project.id);assert.equal(project.publicationPlan.count,2);assert.equal(project.publicationPlan.unreadyCount,1);assert.match(project.publicationPlan.token,/^[a-f0-9]{64}$/);
 const start=await f.q('/projects/'+imported.project.id+'/queue/start',{planToken:project.publicationPlan.token});assert.equal(start.status,202);assert.equal(start.queued,2);const items=(await f.queue(imported.project.id)).items;assert.deepEqual(items.map(item=>item.state),['queued','queued','needs_attention']);assert.ok(!f.service.store.getRecord(items[2].runId).publicationApproval);assert.equal(f.remote,0);
});
test('missing donor rows explain their exact criteria and source check groups imported pages by geo',async t=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const reader=createSiteSource({readSheet:async()=>({values:[['url','user','password','dr','traffic','geo'],['one.example','private-user','private-secret',30,200,'PL'],['small.example','private-user','private-secret',40,10,'SK'],['other.example','private-user','private-secret',5,200,'SK']]})});
 const f=await fixture(t,{reader}),imported=await f.add(['PL','SK']);await f.ready();
 const missing=(await f.queue(imported.project.id)).items.find(i=>i.geo==='SK');
 assert.deepEqual(missing.selectionDiagnostics,{criteria:{minDr:20,minTraffic:100,geo:'SK'},total:3,geo:2,dr:1,eligible:0,reserved:0,available:0,input:{unit:'rows',nonempty:3,disabled:0,invalidUrl:0,invalidRow:0,missingCredentials:0},unknown:{unit:'origins',dr:0,traffic:0,geo:0},unavailable:{unit:'origins',published:0,reserved:0,excluded:0,other:0}});
 const checked=await f.q('/autopilot/source/check',{projectId:imported.project.id});assert.equal(checked.status,200);
 assert.deepEqual(checked.groups.map(g=>({geo:g.criteria.geo,pages:g.pages,selected:g.selected,eligible:g.eligible,available:g.available})),[{geo:'PL',pages:1,selected:1,eligible:1,available:0},{geo:'SK',pages:1,selected:0,eligible:0,available:0}]);
 assert.doesNotMatch(JSON.stringify(checked),/private-secret|private-user|candidateCredential|ciphertext/);
});
test('closing an unused project releases its donor and reopening requires a fresh selection',async t=>{
 const f=await fixture(t,{candidates:[donor('only','PL')]}),first=await f.add(['PL']);await f.ready();
 const initial=(await f.queue(first.project.id)).items[0],old=f.service.store.getRecord(initial.runId),beforePage=f.service.store.getPage(old.pageId);
 const closed=await f.q('/projects/'+first.project.id+'/lifecycle',{action:'close',expectedRevision:f.service.store.getProject(first.project.id).revision});assert.equal(closed.status,200);
 const second=await f.add(['PL']);for(let i=0;i<3;i++)await f.service.tick();assert.equal((await f.queue(second.project.id)).items[0].selectedSite?.baseUrl,'https://only.example/');
 const reopened=await f.q('/projects/'+first.project.id+'/lifecycle',{action:'reopen',expectedRevision:closed.project.revision});assert.equal(reopened.status,200);
 const after=f.service.store.getRecord(old.id);assert.equal(after.candidate,null);assert.equal(after.state,'awaiting_review');assert.equal(after.stage,'selecting');assert.equal(after.publicationApproval,null);assert.equal(after.pageId,beforePage.id);assert.deepEqual(f.service.store.getPage(after.pageId).config,beforePage.config);assert.equal(f.remote,0);
});
test('closed projects retain donor reservations with a draft or uncertain remote operation',async t=>{
 for(const phase of ['draft','dispatching','published']){
  const f=await fixture(t,{candidates:[donor('guarded','PL')]}),first=await f.add(['PL']);await f.ready();const item=(await f.queue(first.project.id)).items[0],run=f.service.store.getRecord(item.runId);
  f.service.store.updateRecord(run.id,{nativePublication:{postId:99,phase},state:phase==='dispatching'?'uncertain':'needs_attention'},run.revision);
  assert.equal((await f.q('/projects/'+first.project.id+'/lifecycle',{action:'close',expectedRevision:f.service.store.getProject(first.project.id).revision})).status,200);
  const second=await f.add(['PL']);for(let i=0;i<3;i++)await f.service.tick();assert.equal((await f.queue(second.project.id)).items[0].error.code,'SOURCE_EMPTY');assert.equal(f.service.store.getRecord(run.id).candidate.baseUrl,'https://guarded.example/');assert.equal(f.remote,0);
 }
});
test('a legacy archived reservation with an invalid lease remains fenced',async t=>{
 const f=await fixture(t,{candidates:[donor('guarded-lease','PL')]}),first=await f.add(['PL']);await f.ready();const item=(await f.queue(first.project.id)).items[0],run=f.service.store.getRecord(item.runId);
 f.service.store.updateRecord(run.id,{leaseToken:'unresolved-lease',leaseUntil:'invalid'},run.revision);const project=f.service.store.getProject(first.project.id);f.service.store.updateProject(project.id,{archived:true},project.revision);
 const second=await f.add(['PL']);for(let i=0;i<3;i++)await f.service.tick();assert.equal((await f.queue(second.project.id)).items[0].error?.code,'SOURCE_EMPTY');assert.equal(f.remote,0);
});
