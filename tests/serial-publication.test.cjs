const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
async function fixture(t,{initialChallenge=false,manualReview=false}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-serial-publication-'));let service,blocked=true,visualProblem=false,finishThrows=false,resetHook=null;const opened=[],openModes=[],prepared=[],resumed=[],resets=[],written=[],publicVisits=[];
 const session=id=>({status:async()=>{},login:async()=>{if(blocked)throw Object.assign(Error('manual challenge'),{code:'BROWSER_CAPTCHA_REQUIRED',state:'needs_attention'});},ensureCleanLinks:async()=>{},publishPage:async input=>{await input.checkpoint({postId:80+written.length,phase:'draft'});input.beforeSend();written.push(id);const postId=79+written.length;await input.checkpoint({postId,phase:'published',url:'https://'+id+'.example/published/'});return {postId,url:'https://'+id+'.example/published/',title:input.title,content:input.html,status:'publish'};}});
 const trashed=[];let stopBeforeTrash=false,canProvePublished=false;let lostTrashReply=false,trashProofAvailable=true,trashHook=null;
 const browser={nativeEditor:true,prepare:async id=>{prepared.push(id);if(initialChallenge)throw Object.assign(Error('Initial challenge'),{code:'BROWSER_CAPTCHA_REQUIRED',state:'needs_attention'});},open:async (id,_url,{headless}={})=>{opened.push(id);openModes.push({id,headless});return {...session(id),
  trashPublished:async({saved,checkpoint,beforeSend})=>{await trashHook?.();await checkpoint({postId:saved.postId,phase:'dispatching'});beforeSend();if(stopBeforeTrash){stopBeforeTrash=false;throw Error("Stopped before applying Trash");}trashed.push(saved.postId);if(lostTrashReply)throw Object.assign(Error('Lost response'),{code:'NATIVE_TRASH_UNCERTAIN',uncertain:true});await checkpoint({postId:saved.postId,phase:'trashed'});return {postId:saved.postId,status:'trash'};},
  inspectOwnedPublished:async({saved})=>({postId:saved.postId,status:canProvePublished&&!trashed.includes(saved.postId)?"publish":"unknown",url:saved.url}),
  inspectOwnedTrash:async({saved})=>({postId:saved.postId,status:trashProofAvailable&&trashed.includes(saved.postId)?'trash':'unknown'})
 };},resume:async id=>{resumed.push(id);return true;},assertOpen:()=>{},reset:async id=>{resets.push(id);await resetHook?.(id);},result:async id=>{publicVisits.push(id);},error:async()=>{},done:async()=>{if(finishThrows)throw Error('Window closed after successful verification.');},close:async()=>{}};
 const settings={dataDir:dir,masterKey:Buffer.alloc(32,75).toString('base64'),visibleBrowser:browser,client:{checkPage:async()=>['public','content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'Fixture'}))},browserVerifier:{verifyPublished:async()=>({state:visualProblem?'problem':'ok',code:visualProblem?'published_browser_problem':'published_verified',viewports:[]})}};
 if(manualReview)settings.desktop=true;
 service=await createLifecycleService(settings);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const r=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','Content-Type':'application/json','X-PagePoster-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,...await r.json()};};
 const add=async name=>{const project=service.store.createProject({name}),input={source:'html',html:'<h1>'+name+'</h1><p>Exact fixture content.</p>',reviewBeforePublish:true},preview=await q('/autopilot/preview',{source:'html',html:input.html}),id=crypto.randomUUID(),launched=await q('/projects/'+project.id+'/autopilot',{...input,idempotencyKey:id,reviewToken:preview.reviewToken});assert.equal(launched.status,202);await service.autopilot.tick({lane:'generation'});await q('/autopilot/'+id+'/destination',{baseUrl:'https://'+id+'.example/',username:'fixture-user',password:'fixture-secret'});return {id,projectId:project.id};};
 const approve=async id=>{const p=await q('/autopilot/'+id+'/html');return q('/autopilot/'+id+'/approve',{reviewToken:p.reviewToken});};
 return {dir,q,add,approve,opened,openModes,prepared,resumed,resets,written,publicVisits,trashed,holdTrash:fn=>{trashHook=fn;},loseTrashReply:()=>{lostTrashReply=true;trashProofAvailable=false;},restoreTrashProof:()=>{trashProofAvailable=true;},interruptTrash:()=>{stopBeforeTrash=true;},provePublished:()=>{canProvePublished=true;},get service(){return service;},run:id=>service.store.getRecord(id),solve:()=>{blocked=false;},challenge:()=>{blocked=true;},badVisual:value=>visualProblem=value,closedFinish:()=>{finishThrows=true;},holdReset:fn=>{resetHook=fn;},ticks:async(n=6)=>{for(let i=0;i<n;i++)await service.tick();},restart:async({desktop=settings.desktop}={})=>{await service.close();service=await createLifecycleService({...settings,desktop});}};
}
test('desktop publication releases the turn without public verification and persists manual decisions',async t=>{
 const f=await fixture(t,{manualReview:true}),a=await f.add('First live page'),b=await f.add('Second live page');
 f.solve();f.badVisual(true);await f.approve(a.id);await f.approve(b.id);await f.ticks(12);
 assert.deepEqual(f.written,[a.id,b.id]);
 assert.deepEqual(f.publicVisits,[]);
 assert.equal((await f.q('/project-queue')).publication.owner,null);
 for(const run of [a,b]){
  assert.equal(f.run(run.id).state,'completed');
  assert.equal(f.service.store.listJobs(run.projectId).filter(job=>job.type==='page_check').length,0);
 }
 let overview=await f.q('/project-queue');
 const first=overview.projects.find(project=>project.projectId===a.projectId).items[0];
 assert.equal(first.manualReview.state,'pending');
 assert.equal(first.manualReview.editorUrl,'https://'+a.id+'.example/wp-admin/post.php?post='+first.wpId+'&action=edit');
 const route='/project-queue/items/'+first.id+'/published-review';
 assert.equal((await f.q(route,{decision:'approved',expectedPageRevision:first.pageRevision+1})).status,409);
 assert.equal((await f.q(route,{decision:'approved',expectedPageRevision:first.pageRevision})).status,200);
 await f.restart();
 overview=await f.q('/project-queue');
 assert.equal(overview.projects.find(project=>project.projectId===a.projectId).items[0].manualReview.state,'approved');
 const reject={decision:'declined',expectedPageRevision:first.pageRevision};
 assert.equal((await f.q(route,reject)).manualReview.state,'trash_queued');
 assert.equal((await f.q(route,reject)).manualReview.state,'trash_queued');
 assert.deepEqual(f.trashed,[]);
 f.loseTrashReply();await f.ticks(3);
 let current=(await f.q('/project-queue')).projects.find(project=>project.projectId===a.projectId).items[0];
 assert.equal(current.manualReview.state,'trash_uncertain');
 assert.equal(current.fullUrl,first.fullUrl);
 assert.deepEqual(f.trashed,[first.wpId]);
 await f.restart();f.restoreTrashProof();
 assert.equal((await f.q(route,reject)).manualReview.state,'trash_queued');
 await f.ticks(3);
 overview=await f.q('/project-queue');
 current=overview.projects.find(project=>project.projectId===a.projectId).items[0];
 assert.equal(current.manualReview.state,'trashed');
 assert.equal(current.fullUrl,'');
 assert.equal(overview.projects.find(project=>project.projectId===b.projectId).items[0].manualReview.state,'pending');
 assert.deepEqual(f.trashed,[first.wpId]);
 assert.deepEqual(f.written,[a.id,b.id]);
});
test('two pending Trash requests pass an idle browser timeout without releasing the blocked publication queue',async t=>{
 const f=await fixture(t,{manualReview:true}),first=await f.add('Published first'),second=await f.add('Published second');
 f.solve();await f.approve(first.id);await f.approve(second.id);await f.ticks(10);
 const stuck=await f.add('Timed-out publication'),waiting=await f.add('Later publication');
 await f.approve(stuck.id);await f.approve(waiting.id);
 const blocked=f.run(stuck.id);
 f.service.store.updateRecord(stuck.id,{state:'failed',stage:'publishing',publicationMode:'native',error:{code:'BROWSER_TIMEOUT'}},blocked.revision);
 const list=async projectId=>(await f.q('/project-queue')).projects.find(project=>project.projectId===projectId).items[0];
 const rows=await Promise.all([list(first.projectId),list(second.projectId)]);
 for(const row of rows){
  const response=await f.q('/project-queue/items/'+row.id+'/published-review',{decision:'declined',expectedPageRevision:row.pageRevision});
  assert.equal(response.manualReview.state,'trash_queued');
 }
 let failedClose=true;
 f.holdReset(async id=>{if(id===stuck.id&&failedClose){failedClose=false;throw Error('Browser context is still closing');}});
 await f.ticks(1);
 assert.deepEqual(f.trashed,[]);
 await f.restart();
 await f.ticks(6);
 for(const run of [first,second])assert.equal((await list(run.projectId)).manualReview.state,'trashed');
 assert.deepEqual(f.trashed,rows.map(row=>row.wpId));
 assert.deepEqual(f.written,[first.id,second.id]);
 assert.equal(f.run(stuck.id).error.code,'BROWSER_TIMEOUT');
 assert.equal(f.run(waiting.id).state,'queued');
 assert.equal(f.service.autopilot.publicationTurn.owner().id,stuck.id);
});
test('a pending Trash request cannot pass a timeout with an unfinished WordPress write checkpoint',async t=>{
 const f=await fixture(t,{manualReview:true}),first=await f.add('Published page');
 f.solve();await f.approve(first.id);await f.ticks(6);
 const stuck=await f.add('Unconfirmed page');await f.approve(stuck.id);
 const blocked=f.run(stuck.id);
 f.service.store.updateRecord(stuck.id,{state:'failed',stage:'publishing',publicationMode:'native',nativePublication:{postId:null,phase:'creating'},error:{code:'BROWSER_TIMEOUT'}},blocked.revision);
 const row=(await f.q('/project-queue')).projects.find(project=>project.projectId===first.projectId).items[0];
 const response=await f.q('/project-queue/items/'+row.id+'/published-review',{decision:'declined',expectedPageRevision:row.pageRevision});
 assert.equal(response.manualReview.state,'trash_queued');await f.ticks(3);
 assert.deepEqual(f.trashed,[]);
 assert.equal(f.service.autopilot.publicationTurn.owner().id,stuck.id);
});
test('a legacy automatic check stops holding the desktop queue once its publication is confirmed',async t=>{
 const f=await fixture(t),a=await f.add('Already live'),b=await f.add('Waiting behind the old check');
 f.solve();f.badVisual(true);await f.approve(a.id);await f.approve(b.id);await f.ticks(8);
 const run=f.run(a.id);
 assert.equal(run.stage,'checking');
 assert.deepEqual(f.written,[a.id]);
 const legacyCheck=f.service.store.enqueueJob({projectId:a.projectId,pageId:run.pageId,siteId:run.siteId,type:'page_check',idempotencyKey:'previous-check',payload:{}});
 f.service.store.updateRecord(run.id,{checkJobId:legacyCheck.id},run.revision);
 await f.restart({desktop:true});await f.ticks(10);
 assert.equal(f.service.store.getJob(legacyCheck.id).state,'paused');
 assert.deepEqual(f.written,[a.id,b.id]);
 assert.deepEqual(f.publicVisits,[a.id]);
 const row=(await f.q('/project-queue')).projects.find(project=>project.projectId===a.projectId).items[0];
 assert.equal(row.manualReview.state,'pending');assert.equal(row.error,null);
});
test('closing and reopening a project requires a fresh click for an unsent WordPress Trash request',async t=>{
 const f=await fixture(t,{manualReview:true}),page=await f.add('Close before sending');
 f.solve();await f.approve(page.id);await f.ticks(7);
 const row=(await f.q('/project-queue')).projects[0].items[0];
 const decline=()=>f.q('/project-queue/items/'+row.id+'/published-review',{decision:'declined',expectedPageRevision:row.pageRevision});
 assert.equal((await decline()).manualReview.state,'trash_queued');
 const lifecycle='/projects/'+page.projectId+'/lifecycle';
 const revision=()=>f.service.store.getProject(page.projectId).revision;
 assert.equal((await f.q(lifecycle,{action:'close',expectedRevision:revision()})).status,200);
 assert.equal((await f.q(lifecycle,{action:'reopen',expectedRevision:revision()})).status,200);
 await f.ticks(4);
 assert.deepEqual(f.trashed,[]);
 assert.equal((await f.q('/project-queue')).projects[0].items[0].manualReview.state,'trash_failed');
 assert.equal((await decline()).manualReview.state,'trash_queued');
 let release,entered;
 const waiting=new Promise(resolve=>{entered=resolve;}),resume=new Promise(resolve=>{release=resolve;});
 f.holdTrash(async()=>{entered();await resume;});
 const tick=f.ticks(1);
 try{
  await Promise.race([waiting,tick.then(()=>{throw Error('The Trash action did not reach its dispatch fence.');})]);
  assert.equal((await f.q(lifecycle,{action:'close',expectedRevision:revision()})).code,'PROJECT_BUSY');
  assert.deepEqual(f.trashed,[]);
 }finally{release();await tick;}
 assert.deepEqual(f.trashed,[row.wpId]);
});
test('a CAPTCHA owner blocks other approved pages across projects and resumes its existing browser',async t=>{
 const f=await fixture(t),a=await f.add('First'),b=await f.add('Second');await f.approve(a.id);await f.approve(b.id);await f.ticks(10);
 assert.equal(f.run(a.id).error.code,'BROWSER_CAPTCHA_REQUIRED');assert.equal(f.run(b.id).state,'queued');assert.deepEqual([...new Set(f.opened)],[a.id]);assert.deepEqual(f.prepared,[a.id]);
 f.solve();const before=f.resets.length;assert.equal((await f.q('/autopilot/'+a.id+'/resume',{})).status,202);assert.equal(f.resets.length,before);assert.equal(f.resumed.at(-1),a.id);await f.ticks(12);
 assert.equal(f.run(a.id).state,'completed');assert.equal(f.run(b.id).state,'completed');assert.deepEqual(f.written,[a.id,b.id]);
});
test('a stopped CAPTCHA owner survives service restart without advancing another page',async t=>{
 const f=await fixture(t),a=await f.add('Persistent first'),b=await f.add('Persistent second');await f.approve(a.id);await f.approve(b.id);await f.ticks(6);await f.restart();await f.ticks(8);
 assert.equal(f.run(a.id).state,'needs_attention');assert.equal(f.run(b.id).state,'queued');assert.deepEqual([...new Set(f.opened)],[a.id]);assert.equal((await f.q('/project-queue')).publication.owner.runId,a.id);
});
test('continuing a hidden CAPTCHA opens the same publication visibly and keeps the next page queued',async t=>{
 const f=await fixture(t);assert.equal((await f.q('/autopilot/browser-settings',{mode:'hidden'})).status,200);
 const a=await f.add('Hidden first'),b=await f.add('Hidden second');
 await f.approve(a.id);await f.approve(b.id);await f.ticks(6);
 assert.equal(f.run(a.id).error.code,'BROWSER_CAPTCHA_REQUIRED');assert.deepEqual(f.openModes,[{id:a.id,headless:true}]);
 assert.match((await f.q('/project-queue')).publication.owner.message,/видимому вікні/);
 const before=f.resets.length;
 assert.equal((await f.q('/autopilot/'+a.id+'/resume',{})).status,202);
 await f.ticks(6);
 assert.equal(f.run(a.id).error.code,'BROWSER_CAPTCHA_REQUIRED');
 assert.deepEqual(f.openModes,[{id:a.id,headless:true},{id:a.id,headless:false}]);
 assert.deepEqual(f.resets.slice(before),[a.id]);
 assert.equal(f.run(b.id).state,'queued');assert.deepEqual(f.written,[]);
 assert.equal((await f.q('/autopilot/status')).browserMode,'hidden');
 f.solve();assert.equal((await f.q('/autopilot/'+a.id+'/resume',{})).status,202);await f.ticks(12);
 assert.deepEqual(f.written,[a.id,b.id]);
 assert.equal(f.openModes.find(value=>value.id===b.id).headless,true);
});
test('published but unverified owner retains the queue until the same page passes its checks',async t=>{
 const f=await fixture(t),a=await f.add('First verified'),b=await f.add('Second waiting');f.solve();f.badVisual(true);await f.approve(a.id);await f.approve(b.id);await f.ticks(12);
 assert.equal(f.run(a.id).state,'needs_attention');assert.equal(f.run(a.id).stage,'checking');assert.equal(f.run(b.id).state,'queued');assert.deepEqual(f.written,[a.id]);
 const queue=await f.q('/project-queue');assert.equal(queue.publication.owner.runId,a.id);assert.equal(queue.publication.owner.blocked,true);
 f.badVisual(false);await f.q('/autopilot/'+a.id+'/resume',{});await f.ticks(12);assert.equal(f.run(b.id).state,'completed');assert.deepEqual(f.written,[a.id,b.id]);
});
test('a closed success-notification window cannot invalidate confirmed publication or block the next page',async t=>{
 const f=await fixture(t),a=await f.add('Confirmed first'),b=await f.add('Confirmed second');f.solve();f.closedFinish();await f.approve(a.id);await f.approve(b.id);await f.ticks(12);assert.equal(f.run(a.id).state,'completed');assert.equal(f.run(b.id).state,'completed');assert.deepEqual(f.written,[a.id,b.id]);
});
test('a challenge on the initial WordPress navigation keeps its browser reachable without preparing another page',async t=>{
 const f=await fixture(t,{initialChallenge:true}),a=await f.add('Initial challenge'),b=await f.add('Queued after challenge');await f.approve(a.id);await f.approve(b.id);assert.equal(f.run(a.id).browserWindow,true);assert.equal(f.run(a.id).error.code,'BROWSER_CAPTCHA_REQUIRED');assert.deepEqual(f.prepared,[a.id]);assert.equal(f.run(b.id).state,'queued');
});
test('explicitly deleting a provably local owner closes only that session before the next page starts',async t=>{
 const f=await fixture(t),a=await f.add('Cancelled local page'),b=await f.add('Next local page');await f.approve(a.id);const before=f.resets.length;assert.equal((await f.q('/autopilot/'+a.id+'/delete',{})).status,200);assert.equal(f.resets.length,before+1);assert.equal(f.resets.at(-1),a.id);f.solve();await f.approve(b.id);await f.ticks(8);assert.equal(f.run(b.id).state,'completed');assert.deepEqual(f.written,[b.id]);
});
test('later monitoring cannot reacquire an already confirmed turn, including after restart',async t=>{
 for(const restart of [false,true]){
  const f=await fixture(t),a=await f.add('Already confirmed'),b=await f.add('Next after monitoring');f.solve();await f.approve(a.id);await f.approve(b.id);
  for(let i=0;i<8&&f.run(a.id).state!=='completed';i++)await f.ticks(1);assert.equal(f.run(a.id).state,'completed');assert.equal(f.run(b.id).state,'queued');
  const page=f.service.store.getPage(f.run(a.id).pageId);f.service.store.observeChecks(page.id,[{kind:'live_browser',state:'unknown',evidence:{code:'network_failed'}}],page.revision);if(restart)await f.restart();await f.ticks(12);
  assert.equal(f.run(b.id).state,'completed','later monitoring must not block the following page');assert.deepEqual(f.written,[a.id,b.id]);
 }
});
test('cancelling a local owner retains its turn until the private context has closed',async t=>{
 const f=await fixture(t),a=await f.add('Retiring owner'),b=await f.add('Waiting for context close');await f.approve(a.id);await f.approve(b.id);let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.holdReset(async id=>{assert.equal(id,a.id);entered();await gate;});f.solve();
 const deleting=f.q('/autopilot/'+a.id+'/delete',{});await started;try{await f.ticks(6);assert.equal(f.run(b.id).state,'queued');assert.deepEqual(f.opened,[]);}finally{release();await deleting;}
 await f.ticks(12);assert.equal(f.run(b.id).state,'completed');assert.deepEqual(f.written,[b.id]);
});
test('a stale approval cannot prepare a browser while the same local page is being deleted',async t=>{
 const f=await fixture(t),a=await f.add('Draft being cancelled');let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.holdReset(async()=>{entered();await gate;});const deleting=f.q('/autopilot/'+a.id+'/delete',{});await started;
 try{const approval=await f.approve(a.id);assert.equal(approval.status,409);assert.deepEqual(f.prepared,[]);}finally{release();await deleting;}
 assert.equal(f.run(a.id).state,'deleted');
});

test('destination correction fences approval until its previous browser context closes',async t=>{
 const f=await fixture(t),a=await f.add('Changing local destination');let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.holdReset(async()=>{entered();await gate;});
 const changing=f.q('/autopilot/'+a.id+'/destination',{baseUrl:'https://'+a.id+'.example/corrected/',username:'fixture-user',password:'fixture-secret'});await started;
 try{
  assert.equal((await f.approve(a.id)).status,409);assert.equal((await f.q('/autopilot/'+a.id+'/resume',{})).status,409);
  assert.equal((await f.q('/autopilot/'+a.id+'/destination',{baseUrl:'https://stale.example/',username:'fixture-user',password:'fixture-secret'})).status,409);
  assert.deepEqual(f.prepared,[]);await f.ticks(3);assert.deepEqual(f.opened,[]);
 }finally{release();await changing;}
 f.solve();assert.equal((await f.approve(a.id)).status,202);await f.ticks(8);assert.equal(f.run(a.id).state,'completed');assert.deepEqual(f.written,[a.id]);
});

test('a failed destination reset releases its fence so the corrected draft can be approved',async t=>{
 const f=await fixture(t),a=await f.add('Retry after reset failure');let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.holdReset(async()=>{entered();await gate;throw Object.assign(Error('Context close failed'),{code:'BROWSER_CLOSED'});});
 const changing=f.q('/autopilot/'+a.id+'/destination',{baseUrl:'https://'+a.id+'.example/corrected/',username:'fixture-user',password:'fixture-secret'});await started;
 try{assert.equal((await f.approve(a.id)).status,409);}finally{release();assert.equal((await changing).status,400);}
 assert.equal(f.run(a.id).browserPreparing,false);assert.equal(f.run(a.id).browserPreparingUntil,null);assert.equal(f.run(a.id).state,'awaiting_review');
 f.holdReset(null);f.solve();assert.equal((await f.approve(a.id)).status,202);await f.ticks(8);assert.equal(f.run(a.id).state,'completed');assert.deepEqual(f.written,[a.id]);
});

test('deletion cannot overlap a destination reset or clear its approval fence',async t=>{
 const f=await fixture(t),a=await f.add('Destination reset being cancelled');let release,entered,calls=0;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.holdReset(async()=>{if(++calls===1){entered();await gate;}});
 const changing=f.q('/autopilot/'+a.id+'/destination',{baseUrl:'https://corrected.example/',username:'fixture-user',password:'fixture-secret'});await started;
 try{
  assert.equal((await f.q('/autopilot/'+a.id+'/delete',{})).status,409);
  assert.equal(calls,1);assert.equal(f.run(a.id).browserPreparing,true);assert.equal((await f.approve(a.id)).status,409);
 }finally{release();await changing;}
 f.holdReset(null);const run=f.run(a.id);f.service.store.updateRecord(a.id,{browserPreparing:true,browserPreparingUntil:new Date(0).toISOString()},run.revision);assert.equal((await f.q('/autopilot/'+a.id+'/delete',{})).status,200);assert.equal(f.run(a.id).state,'deleted');assert.deepEqual(f.prepared,[]);
});

test('a trashed historical owner releases the queue without retrying its uncertain draft',async t=>{
 const f=await fixture(t),a=await f.add('Old uncertain project'),b=await f.add('New queued project');await f.approve(a.id);await f.approve(b.id);
 const run=f.run(a.id);f.service.store.updateRecord(a.id,{state:'failed',stage:'publishing',publicationMode:'native',nativePublication:{postId:null,phase:'creating'},error:{code:'unsafe_address'}},run.revision);
 const project=f.service.store.getProject(a.projectId);assert.equal((await f.q('/projects/'+a.projectId+'/lifecycle',{action:'trash',expectedRevision:project.revision})).status,200);
 const saved=structuredClone(f.run(a.id)),page=structuredClone(f.service.store.getPage(saved.pageId));await f.restart();f.solve();await f.ticks(12);
 assert.equal(f.run(b.id).state,'completed');assert.deepEqual(f.written,[b.id]);assert.deepEqual(f.run(a.id),saved);assert.deepEqual(f.service.store.getPage(saved.pageId),page);
 assert.equal((await f.q('/project-queue')).publication.owner,null);await f.ticks(4);assert.deepEqual(f.written,[b.id]);
 const closed=f.service.store.getProject(a.projectId);assert.equal((await f.q('/projects/'+a.projectId+'/lifecycle',{action:'restore',expectedRevision:closed.revision})).status,200);await f.ticks(4);assert.deepEqual(f.run(a.id),saved);assert.deepEqual(f.written,[b.id]);
});

test('closing a stopped owner waits for its browser to close before starting the next project',async t=>{
 const f=await fixture(t),a=await f.add('Closed challenge project'),b=await f.add('Waiting project');await f.approve(a.id);await f.approve(b.id);await f.ticks(4);
 const project=f.service.store.getProject(a.projectId);assert.equal((await f.q('/projects/'+a.projectId+'/lifecycle',{action:'close',expectedRevision:project.revision})).status,200);
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.holdReset(async id=>{assert.equal(id,a.id);entered();await gate;});f.solve();
 const tick=f.ticks(1);await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('Archived browser was not retired')),1000))]);
 try{assert.equal((await f.q('/project-queue')).publication.owner.runId,a.id);assert.equal(f.run(b.id).state,'queued');assert.deepEqual(f.written,[]);}finally{release();await tick;}
 await f.ticks(12);assert.equal(f.run(b.id).state,'completed');assert.deepEqual(f.written,[b.id]);assert.equal(f.resets.filter(id=>id===a.id).length,2);
});

test('a closed paused native owner consumes its legacy job stop before the next project starts',async t=>{
 const f=await fixture(t),a=await f.add('Closed legacy owner'),b=await f.add('Next native project');await f.approve(a.id);await f.approve(b.id);
 const old=f.run(a.id),site=f.service.store.createSite(a.projectId,{name:'Accepted legacy site',baseUrl:'https://'+a.id+'.example/'}),page=f.service.store.updatePage(old.pageId,{siteId:site.id},f.service.store.getPage(old.pageId).revision);
 const job=f.service.store.enqueueJob({projectId:a.projectId,pageId:page.id,siteId:site.id,type:'publish',idempotencyKey:'closed-legacy-write',payload:{}});
 f.service.store.updateRecord(a.id,{state:'publishing',stage:'publishing',publicationMode:'native',jobId:job.id},old.revision);
 const project=f.service.store.getProject(a.projectId);assert.equal((await f.q('/projects/'+a.projectId+'/lifecycle',{action:'close',expectedRevision:project.revision})).status,200);assert.equal(f.service.store.getJob(job.id).state,'paused');
 f.solve();await f.ticks(16);
 assert.equal(f.run(a.id).state,'failed');assert.equal(f.run(a.id).error?.code,'NATIVE_LEGACY_PUBLICATION');assert.equal(f.run(b.id).state,'completed');assert.deepEqual(f.written,[b.id]);
 const stopped=f.service.store.getJob(job.id);assert.equal(stopped.state,'paused');assert.equal(stopped.attempt,0);assert.equal((await f.q('/project-queue')).publication.owner,null);
});

test('an interrupted Trash needs exact published proof and another explicit decline to resend',async t=>{
 const f=await fixture(t,{manualReview:true}),run=await f.add('Interrupted Trash');
 f.solve();await f.approve(run.id);await f.ticks(6);
 const review=async()=>(await f.q('/project-queue')).projects.find(p=>p.projectId===run.projectId).items[0];
 const row=await review(),route='/project-queue/items/'+row.id+'/published-review',decline=()=>f.q(route,{decision:'declined',expectedPageRevision:row.pageRevision});
 f.interruptTrash();await decline();await f.ticks(2);
 assert.equal((await review()).manualReview.state,'trash_uncertain');
 await f.restart();await decline();await f.ticks(2);
 assert.equal((await review()).manualReview.state,'trash_uncertain');
 f.provePublished();await decline();await f.ticks(4);
 assert.equal((await review()).manualReview.state,'trash_failed');
 assert.deepEqual(f.trashed,[]);
 await f.restart();await f.ticks(2);assert.deepEqual(f.trashed,[]);
 assert.equal((await decline()).status,409);assert.deepEqual(f.trashed,[]);
 const confirmed={decision:'declined',expectedPageRevision:row.pageRevision,expectedTrashRevision:(await review()).manualReview.retryTrashRevision};
 f.challenge();await f.q(route,confirmed);await f.q(route,confirmed);await f.ticks(4);
 f.solve();assert.equal((await decline()).status,409);assert.equal((await f.q(route,confirmed)).status,409);
 await f.ticks(3);assert.deepEqual(f.trashed,[]);
 const fresh=(await review()).manualReview.retryTrashRevision;assert.ok(Number.isSafeInteger(fresh));assert.notEqual(fresh,confirmed.expectedTrashRevision);
 assert.equal((await f.q(route,{...confirmed,expectedTrashRevision:fresh})).status,200);await f.ticks(4);
 assert.equal((await review()).manualReview.state,'trashed');assert.deepEqual(f.trashed,[row.wpId]);
});
test('explicit parking closes the challenged context and preserves the run across restart',async t=>{
 const f=await fixture(t),a=await f.add('Parked'),b=await f.add('Queued');
 await f.approve(a.id);await f.approve(b.id);await f.ticks(5);
 const park=()=>f.q('/project-queue/items/'+a.id+'/park',{});
 const before=f.run(a.id);assert.equal(before.error.code,'BROWSER_CAPTCHA_REQUIRED');
 f.holdReset(async()=>{throw Error('Close failed');});
 assert.notEqual((await park()).status,200);assert.equal(f.service.autopilot.publicationTurn.owner().id,a.id);
 f.holdReset(null);assert.equal((await park()).status,200);assert.equal(f.service.autopilot.publicationTurn.owner(),null);
 await f.restart();f.solve();await f.ticks(12);
 const parked=f.run(a.id);assert.ok(parked.publicationParked);assert.equal(parked.state,'needs_attention');assert.deepEqual(parked.publicationApproval,before.publicationApproval);assert.deepEqual(parked.candidate,before.candidate);assert.deepEqual(f.written,[b.id]);
 assert.equal((await f.q('/autopilot/'+a.id+'/resume',{})).status,202);await f.ticks(10);assert.deepEqual(f.written,[b.id,a.id]);
});

test('parking a paused project retains its pinned donor and unknown creation across restart',async t=>{
 const f=await fixture(t),a=await f.add('Unknown creation'),b=await f.add('Independent');
 await f.approve(a.id);await f.approve(b.id);await f.ticks(4);
 const run=f.run(a.id),checkpoint={phase:'creating',postId:null};
 f.service.store.updateRecord(a.id,{state:'uncertain',stage:'publishing',publicationMode:'native',nativePublication:checkpoint,donorPinned:true},run.revision);
 const projectRoute='/projects/'+a.projectId+'/queue';
 await f.q(projectRoute,{action:'pause'});
 const parking=await f.q('/project-queue/items/'+a.id+'/park',{});assert.equal(parking.status,200);assert.equal(parking.item.publicationParked,true);
 await f.restart();f.solve();await f.ticks(9);
 assert.deepEqual(f.written,[b.id]);assert.equal(f.run(a.id).donorPinned,true);assert.deepEqual(f.run(a.id).candidate,run.candidate);assert.deepEqual(f.run(a.id).nativePublication,checkpoint);
 assert.equal((await f.q('/autopilot/'+a.id+'/resume',{})).status,409);
 await f.q(projectRoute,{action:'resume'});
 assert.notEqual((await f.q('/autopilot/'+a.id+'/resume',{})).status,202);
 assert.equal(f.run(a.id).publicationParked,true);assert.equal(f.service.autopilot.publicationTurn.owner(),null);
 await f.ticks(3);assert.deepEqual(f.written,[b.id]);
});