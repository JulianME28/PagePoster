'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const sourceConfig={authMode:'user',spreadsheetId:'allocation-fixture',range:'Sites!A1:F100',columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'}};
const donor=(id,dr=90,geo=['PL'])=>({id,baseUrl:'https://'+id+'.example/',rowNumber:2,username:'allocation-private-user',password:'allocation-private-password',metrics:{dr,traffic:2000,geo}});
const row=(key,minDr=20,geo='PL')=>({key,source:'html',title:'Prepared '+key,html:'<!doctype html><html><body><h1>Prepared '+key+'</h1><p>Exact authored material remains unchanged.</p></body></html>',language:'pl',geo,siteSelection:{minDr,minTraffic:100,geo}});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

async function fixture(t,{candidates=[donor('a'),donor('b',40)],reader,picker}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-batch-allocation-'));
 let remoteCalls=0,reads=0,account={connected:true,email:'first@allocation.example',phase:'connected'};
 const activePages=new Set();
 const forbidden=()=>{remoteCalls++;assert.fail('Donor allocation must not contact WordPress, Google, browser publication, or paid APIs');},remote=new Proxy({},{get:()=>forbidden});
 const source=picker?{pickUnused:async(config,options)=>{reads++;return picker(config,options,reads);}}:{readCandidates:async(config,options)=>{reads++;assert.deepEqual(options.criteria,{minDr:null,minTraffic:null,geo:''});assert.deepEqual(options.usedOrigins,[]);assert.deepEqual(options.usedRowIds,[]);assert.equal(options.preserveOrigins,true);return reader?reader(config,options,reads):{candidates,issues:[]};},pickUnused:forbidden};
 const service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,97).toString('base64'),googleAuth:{status:()=>account,accessToken:forbidden,close:async()=>{}},autopilotOptions:{source,planner:{generate:forbidden},bootstrapFactory:forbidden,hasActivePage:id=>activePages.has(id)},client:remote,bridgeClient:remote,browserVerifier:remote});
 t.after(async()=>{await service.close();assert.equal(remoteCalls,0);const target=path.resolve(dir);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep+'pp-batch-allocation-'));fs.rmSync(target,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
 const queue=async id=>(await q('/project-queue')).projects.find(project=>project.projectId===id);
 const add=async rows=>{const result=await q('/project-queue/import',{idempotencyKey:randomUUID(),name:'Synthetic allocation',type:'html',items:rows});assert.equal(result.status,201,JSON.stringify(result));return result.project;};
 const prepare=async project=>{
  const items=service.store.listRecords(project.id,'project_queue_item');
  for(let pass=0;pass<items.length*3+2;pass++){
   service.projectQueue.feed();for(let slot=0;slot<2;slot++)await service.autopilot.tick({lane:'generation',slot});
   if(items.every(item=>service.store.getRecord(item.runId)?.pageId&&service.store.getRecord(item.runId)?.stage==='selecting'))break;
  }
  const prepared=(await queue(project.id)).items;
  for(const item of prepared){assert.ok(item.pageId);assert.equal(item.stage,'selecting');assert.equal(item.selectedSite,null);}
  return prepared;
 };
 const configure=async(config=sourceConfig)=>{const result=await q('/autopilot/source',config);assert.equal(result.status,200,JSON.stringify(result));};
 const snapshot=async items=>Promise.all(items.map(async item=>({id:item.id,key:item.key,run:service.store.getRecord(item.runId),page:service.store.getPage(item.pageId),html:(await q('/autopilot/'+item.runId+'/html')).html,input:service.store.getRecord(item.id).input})));
 const assertMaterial=async snapshots=>{for(const saved of snapshots){const current=service.store.getRecord(saved.run.id);assert.equal(current.pageId,saved.page.id);assert.equal(current.source,saved.run.source);assert.equal(current.requestHash,saved.run.requestHash);assert.deepEqual(current.siteSelection,saved.run.siteSelection);assert.deepEqual(service.store.getPage(saved.page.id),saved.page);assert.equal((await q('/autopilot/'+saved.run.id+'/html')).html,saved.html);assert.deepEqual(service.store.getRecord(saved.id).input,saved.input);assert.equal(current.publicationApproval??null,null);assert.equal(current.jobId??null,null);}};
 const patch=(id,changes)=>{const current=service.store.getRecord(id);return service.store.updateRecord(id,changes,current.revision);};
 return {s:service,q,queue,add,prepare,configure,snapshot,assertMaterial,patch,activePages,get reads(){return reads;},setAccount:changes=>{account={...account,...changes};}};
}

for(const ordering of ['flexible-first','strict-first'])test(`the actual queue allocates strict A and flexible B with ${ordering} rows`,async t=>{
 const f=await fixture(t),rows=ordering==='flexible-first'?[row('flexible'),row('strict',80)]:[row('strict',80),row('flexible')],project=await f.add(rows),items=await f.prepare(project),before=await f.snapshot(items);
 await f.configure();await f.s.autopilot.selectPending();
 const after=(await f.queue(project.id)).items,byKey=Object.fromEntries(after.map(item=>[item.key,item]));
 assert.equal(byKey.strict.selectedSite?.baseUrl,'https://a.example/');assert.equal(byKey.flexible.selectedSite?.baseUrl,'https://b.example/');
 assert.equal(f.reads,1);assert.equal((await f.queue(project.id)).publicationPlan.count,2);await f.assertMaterial(before);
 assert.doesNotMatch(JSON.stringify(after),/allocation-private-user|allocation-private-password|ciphertext|candidateCredential/);
});

test('twenty prepared rows fill scarce exact GEO and DR pools with unique origins in one source read',async t=>{
 const candidates=[...Array.from({length:5},(_,i)=>donor('pl-strict-'+i,90,['PL'])),...Array.from({length:5},(_,i)=>donor('ua-strict-'+i,90,['UA'])),...Array.from({length:10},(_,i)=>donor('flex-'+i,40,['PL','UA']))];
 candidates.splice(1,0,{...candidates[0],id:'duplicate-origin',baseUrl:'https://pl-strict-0.example/duplicate/'});
 const f=await fixture(t,{candidates}),project=await f.add([...Array.from({length:10},(_,i)=>row('flexible-'+i,20,'PL,UA')),...Array.from({length:5},(_,i)=>row('strict-pl-'+i,80,'PL')),...Array.from({length:5},(_,i)=>row('strict-ua-'+i,80,'UA'))]),items=await f.prepare(project),before=await f.snapshot(items);
 await f.configure();await f.s.autopilot.selectPending();const after=(await f.queue(project.id)).items;
 assert.equal(after.filter(item=>item.selectedSite).length,20);assert.equal(new Set(after.map(item=>new URL(item.selectedSite.baseUrl).origin)).size,20);assert.equal(f.reads,1);
 for(const item of after){assert.equal(item.state,'awaiting_review');assert.equal(item.stage,'installing');if(item.key.startsWith('strict-')){assert.equal(item.selectedSite.dr,90);assert.deepEqual(item.selectedSite.geo,item.key.startsWith('strict-pl-')?['PL']:['UA']);}else assert.equal(item.selectedSite.dr,40);}
 await f.assertMaterial(before);
});

test('source ranking is retained when every prepared row accepts the strongest donor',async t=>{
 const f=await fixture(t),project=await f.add([row('one')]),items=await f.prepare(project);await f.configure();await f.s.autopilot.selectPending();
 assert.equal((await f.queue(project.id)).items[0].selectedSite.baseUrl,'https://a.example/');assert.equal(f.reads,1);assert.equal(f.s.store.getRecord(items[0].runId).donorPinned,false);
});

test('a pending manual destination keeps its donor before an earlier automatic row is allocated',async t=>{
 const f=await fixture(t),project=await f.add([row('automatic'),row('manual')]),items=await f.prepare(project),manual=items.find(item=>item.key==='manual'),before=await f.snapshot(items);
 const destination=await f.q('/autopilot/'+manual.runId+'/destination',{baseUrl:'https://a.example/',username:'manual-private-user',password:'manual-private-password',expectedRevision:0});assert.equal(destination.status,200,JSON.stringify(destination));
 const fixed=f.s.store.getRecord(manual.runId);await f.configure();await f.s.autopilot.selectPending();const after=(await f.queue(project.id)).items,byKey=Object.fromEntries(after.map(item=>[item.key,item]));
 assert.equal(byKey.manual.selectedSite.baseUrl,'https://a.example/');assert.equal(byKey.automatic.selectedSite.baseUrl,'https://b.example/');
 const current=f.s.store.getRecord(manual.runId);assert.deepEqual(current.manualTarget,fixed.manualTarget);assert.equal(current.destinationRevision,fixed.destinationRevision);assert.equal(current.candidate.baseUrl,'https://a.example/');assert.equal(current.pageId,fixed.pageId);assert.equal(current.publicationApproval,null);
 for(const saved of before){assert.deepEqual(f.s.store.getPage(saved.page.id),saved.page);assert.equal((await f.q('/autopilot/'+saved.run.id+'/html')).html,saved.html);}
});

test('an explicitly pinned donor remains reserved and unchanged while other rows are batch allocated',async t=>{
 const f=await fixture(t),project=await f.add([row('automatic'),row('pinned',99)]),items=await f.prepare(project),pinned=items.find(item=>item.key==='pinned');await f.configure();
 const catalog=await f.q('/autopilot/'+pinned.runId+'/donors?all=1');assert.equal(catalog.status,200);const choice=await f.q('/autopilot/'+pinned.runId+'/donor',{token:catalog.token,candidateId:'a',expectedRevision:catalog.destinationRevision});assert.equal(choice.status,200,JSON.stringify(choice));
 const fixed=f.s.store.getRecord(pinned.runId),page=f.s.store.getPage(pinned.pageId);await f.s.autopilot.selectPending();
 const byKey=Object.fromEntries((await f.queue(project.id)).items.map(item=>[item.key,item]));assert.equal(byKey.pinned.selectedSite.baseUrl,'https://a.example/');assert.equal(byKey.pinned.donorPinned,true);assert.equal(byKey.automatic.selectedSite.baseUrl,'https://b.example/');assert.deepEqual(f.s.store.getRecord(pinned.runId),fixed);assert.deepEqual(f.s.store.getPage(pinned.pageId),page);assert.equal(f.reads,1);
});

for(const change of ['source','account','account-waiting','criteria','destination-revision','page-revision'])test(`an async source read cannot assign stale results after a ${change} change`,{timeout:15000},async t=>{
 const entered=deferred(),release=deferred(),f=await fixture(t,{reader:async(config,options,count)=>{if(count===1){entered.resolve();await release.promise;}return {candidates:[donor(count===1?'obsolete':'fresh')],issues:[]};}}),project=await f.add([row('racing')]),items=await f.prepare(project),item=items[0];
 await f.configure();const selecting=f.s.autopilot.selectPending();await entered.promise;
 if(change==='source')await f.configure({...sourceConfig,range:'Sites!A1:F200'});
 if(change==='account')f.setAccount({email:'changed@allocation.example'});
 if(change==='account-waiting')f.setAccount({phase:'waiting'});
 if(change==='criteria'){const current=(await f.queue(project.id)).items[0],edited=await f.q('/project-queue/requirements',{items:[{id:current.id,expectedRevision:current.requirementsRevision}],changes:{minDr:75}});assert.equal(edited.status,200,JSON.stringify(edited));}
 if(change==='destination-revision')f.patch(item.runId,{destinationRevision:1});
 if(change==='page-revision'){const page=f.s.store.getPage(item.pageId);f.s.store.updatePage(page.id,{title:'Changed while source was read'},page.revision);}
 release.resolve();await selecting;
 const current=f.s.store.getRecord(item.runId);assert.equal(current.candidate??null,null);assert.equal(current.state,'awaiting_review');assert.equal(current.stage,'selecting');assert.equal(current.pageId,item.pageId);assert.equal(current.publicationApproval??null,null);assert.equal(current.jobId??null,null);
});

test('legacy pick admission rechecks a newly occupied row ID even when the reserved origin differs',{timeout:15000},async t=>{
 const entered=deferred(),release=deferred(),picked=donor('shared-row'),f=await fixture(t,{picker:async(config,options)=>{assert.deepEqual(options.usedRowIds,[]);entered.resolve();await release.promise;return picked;}}),project=await f.add([row('target'),row('other')]),items=await f.prepare(project),target=items.find(item=>item.key==='target'),other=items.find(item=>item.key==='other');
 await f.configure();const selecting=f.s.autopilot.selectPending();await entered.promise;
 const reserved={id:picked.id,baseUrl:'https://already-reserved.example/',metrics:picked.metrics};f.patch(other.runId,{candidate:reserved,stage:'installing',state:'awaiting_review',donorPinned:true});
 release.resolve();await selecting;
 const current=f.s.store.getRecord(target.runId);assert.equal(current.candidate??null,null);assert.equal(current.state,'needs_attention');assert.equal(current.error.code,'SOURCE_RESERVED');assert.deepEqual(f.s.store.getRecord(other.runId).candidate,reserved);assert.equal(f.reads,1);
});

for(const change of ['account','account-waiting'])test(`an obsolete source error leaves the prepared page untouched after an ${change} change`,{timeout:15000},async t=>{
 const entered=deferred(),release=deferred(),f=await fixture(t,{reader:async()=>{entered.resolve();await release.promise;throw Object.assign(Error('Synthetic expired read failure'),{code:'source_read_failed'});}}),project=await f.add([row('racing-error')]),items=await f.prepare(project),item=items[0];
 await f.configure();const before=f.s.store.getRecord(item.runId),page=f.s.store.getPage(item.pageId),selecting=f.s.autopilot.selectPending();await entered.promise;
 if(change==='account')f.setAccount({email:'changed@allocation.example'});else f.setAccount({phase:'waiting'});
 release.resolve();await selecting;
 assert.deepEqual(f.s.store.getRecord(item.runId),before);assert.deepEqual(f.s.store.getPage(item.pageId),page);assert.equal(f.reads,1);
});

test('a page becoming busy during the source read cannot consume the ready page sole donor',{timeout:15000},async t=>{
 const entered=deferred(),release=deferred(),f=await fixture(t,{reader:async()=>{entered.resolve();await release.promise;return {candidates:[donor('sole')],issues:[]};}}),project=await f.add([row('first'),row('second')]),items=await f.prepare(project);
 const ordered=[...items].sort((a,b)=>a.runId.localeCompare(b.runId)),busy=ordered[0],ready=ordered[1],before=f.s.store.getRecord(busy.runId),page=f.s.store.getPage(busy.pageId);
 await f.configure();const selecting=f.s.autopilot.selectPending();await entered.promise;f.activePages.add(busy.pageId);release.resolve();await selecting;
 assert.equal(f.s.store.getRecord(ready.runId).candidate?.baseUrl,'https://sole.example/');assert.deepEqual(f.s.store.getRecord(busy.runId),before);assert.deepEqual(f.s.store.getPage(busy.pageId),page);assert.equal(f.reads,1);
});

test('a manual destination changed during a source read releases its old origin and protects its current origin',{timeout:15000},async t=>{
 const entered=deferred(),release=deferred(),f=await fixture(t,{reader:async(config,options,count)=>{if(count===1){entered.resolve();await release.promise;}return {candidates:count===1?[donor('a')]:[donor('a'),donor('b')],issues:[]};}}),project=await f.add([row('automatic'),row('manual')]),items=await f.prepare(project),automatic=items.find(item=>item.key==='automatic'),manual=items.find(item=>item.key==='manual');
 const initial=await f.q('/autopilot/'+manual.runId+'/destination',{baseUrl:'https://a.example/',username:'manual-private-user',password:'manual-private-password',expectedRevision:0});assert.equal(initial.status,200,JSON.stringify(initial));
 await f.configure();const selecting=f.s.autopilot.selectPending();await entered.promise;
 const changed=await f.q('/autopilot/'+manual.runId+'/destination',{baseUrl:'https://b.example/',username:'manual-private-user',password:'manual-private-password',expectedRevision:1});assert.equal(changed.status,200,JSON.stringify(changed));const currentManual=f.s.store.getRecord(manual.runId);
 release.resolve();await selecting;
 assert.equal(f.s.store.getRecord(automatic.runId).candidate?.baseUrl,'https://a.example/');assert.deepEqual(f.s.store.getRecord(manual.runId),currentManual);assert.equal(currentManual.destinationRevision,2);assert.equal(currentManual.state,'awaiting_review');assert.equal(currentManual.manualTarget.baseUrl,'https://b.example/');
 const laterProject=await f.add([row('later')]),later=(await f.prepare(laterProject))[0];f.s.autopilot.invalidateSelection();await f.s.autopilot.selectPending();
 const protectedManual=f.s.store.getRecord(manual.runId),laterRun=f.s.store.getRecord(later.runId);assert.equal(protectedManual.manualTarget.baseUrl,'https://b.example/');assert.equal(protectedManual.candidate.baseUrl,'https://b.example/');assert.equal(protectedManual.destinationRevision,2);assert.equal(laterRun.candidate??null,null);assert.equal(laterRun.error.code,'SOURCE_EMPTY');assert.equal(f.reads,2);
});

test('an earlier unmatched row reports the later winner committed reservation in its shortage diagnostics',async t=>{
 const f=await fixture(t,{candidates:[donor('sole')]}),project=await f.add([row('earlier'),row('later')]),queued=f.s.store.listRecords(project.id,'project_queue_item'),earlierId='ffffffff-ffff-4fff-8fff-ffffffffffff',laterId='00000000-0000-4000-8000-000000000000';
 // Choose valid UUIDs before the real queue creates its run records. This fixes
 // the pending order opposite to the allocator's documented ID tie breaking.
 f.patch(queued[0].id,{runId:earlierId});f.patch(queued[1].id,{runId:laterId});await f.prepare(project);
 assert.deepEqual(f.s.store.listRecords(project.id,'autopilot').map(run=>run.id),[earlierId,laterId]);await f.configure();await f.s.autopilot.selectPending();
 const after=(await f.queue(project.id)).items,loser=after.find(item=>item.runId===earlierId),winner=after.find(item=>item.runId===laterId);
 assert.equal(winner.selectedSite.baseUrl,'https://sole.example/');assert.equal(loser.selectedSite,null);assert.equal(loser.error.code,'SOURCE_EMPTY');assert.equal(loser.selectionDiagnostics.available,0);assert.equal(loser.selectionDiagnostics.reserved,1);assert.equal(loser.selectionDiagnostics.unavailable.reserved,1);assert.equal(f.reads,1);
});
