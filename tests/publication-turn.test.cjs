'use strict';
const test=require('node:test'),assert=require('node:assert/strict');

async function fixture(t,{archived=true,trashed=false,closeBrowser,isActive=()=>false,queuedJob=false,runningJob=false}={}){
 const [{createStore},{createPublicationTurn}]=await Promise.all([import('../server/lifecycle/store.mjs'),import('../server/lifecycle/publication-turn.mjs')]);
 const now=Date.parse('2026-10-27T08:00:00Z'),clock=()=>now,store=createStore({filename:':memory:',masterKey:Buffer.alloc(32,69).toString('base64'),clock});t.after(()=>store.close());
 const project=store.createProject({name:'Old project',workflowType:'html'}),nextProject=store.createProject({name:'Next project',workflowType:'html'});
 const page=store.createPage(project.id,{title:'Unconfirmed old page'});
 const old=store.createRecord(project.id,'autopilot',{state:'failed',stage:'publishing',pageId:page.id,publicationMode:'native',nativePublication:{phase:'creating',postId:null},error:{code:'unsafe_address'},browserWindow:true});
 const next=store.createRecord(nextProject.id,'autopilot',{state:'queued',stage:'installing'}),closed=[];
 const turn=createPublicationTurn({store,allRuns:()=>store.listProjects().flatMap(p=>store.listRecords(p.id,'autopilot')),clock,isActive,closeBrowser:async id=>{closed.push(id);await closeBrowser?.(id);}});
 assert.equal(turn.claim(old),true);
 let job;
 if(queuedJob||runningJob){const site=store.createSite(project.id,{name:'Local fixture',baseUrl:'https://old.example/'});job=store.enqueueJob({projectId:project.id,siteId:site.id,type:'site_check',idempotencyKey:'remote-fixture'});if(runningJob)assert.equal(store.claimJob({workerId:'fixture',leaseMs:60000}).id,job.id);}
 if(archived)store.updateProject(project.id,{archived:true,trashed},project.revision);
 return {store,turn,project,nextProject,page,old,next,closed,now,job,patch:patch=>{const r=store.getRecord(old.id);return store.updateRecord(old.id,patch,r.revision);}};
}

test('an inactive archived owner releases the queue without altering its uncertain remote checkpoint',async t=>{
 const f=await fixture(t),old=structuredClone(f.store.getRecord(f.old.id)),page=structuredClone(f.store.getPage(f.page.id));
 f.turn.adoptLegacy();assert.equal(f.turn.claim(f.next),false);
 await f.turn.retireInactive();
 assert.equal(f.turn.owner(),null);assert.equal(f.turn.status(),null);assert.deepEqual(f.closed,[f.old.id]);
 assert.deepEqual(f.store.getRecord(f.old.id),old);assert.deepEqual(f.store.getPage(f.page.id),page);
 assert.equal(f.turn.claim(f.next),true);assert.equal(f.turn.owner().id,f.next.id);
});

test('a trashed owner is retired once across repeated maintenance and startup adoption',async t=>{
 const f=await fixture(t,{trashed:true});await f.turn.retireInactive();await f.turn.retireInactive();f.turn.adoptLegacy();await f.turn.retireInactive();
 assert.equal(f.turn.owner(),null);assert.deepEqual(f.closed,[f.old.id]);assert.deepEqual(f.store.getRecord(f.old.id).nativePublication,{phase:'creating',postId:null});
});

test('pausing an open project keeps its CAPTCHA owner and blocks the next publication',async t=>{
 const f=await fixture(t,{archived:false});f.patch({state:'needs_attention',stage:'installing',error:{code:'BROWSER_CAPTCHA_REQUIRED'}});f.store.createRecord(f.project.id,'project_queue_control',{paused:true},'queue-control:'+f.project.id);
 await f.turn.retireInactive();assert.equal(f.turn.owner().id,f.old.id);assert.equal(f.turn.claim(f.next),false);assert.deepEqual(f.closed,[]);
});

test('live run activity prevents retirement even when its project was already archived',async t=>{
 for(const [label,patch,active] of [
  ['lease',{leaseToken:'live-lease',leaseUntil:'2026-10-27T08:01:00Z'},false],
  ['browser preparation',{browserPreparing:true,browserPreparingUntil:'2026-10-27T08:01:00Z'},false],
  ['unbounded browser preparation',{browserPreparing:true,browserPreparingUntil:null},false],
  ['running workflow',{state:'running'},false],
  ['local worker',{},true]
 ])await t.test(label,async st=>{
  const f=await fixture(st,{isActive:id=>active&&id===f.old.id});f.patch(patch);await f.turn.retireInactive();
  assert.equal(f.turn.owner().id,f.old.id);assert.equal(f.turn.claim(f.next),false);assert.deepEqual(f.closed,[]);
 });
});

test('a running remote job prevents retiring an archived project owner',async t=>{
 const f=await fixture(t,{runningJob:true});await f.turn.retireInactive();assert.equal(f.turn.owner().id,f.old.id);assert.equal(f.turn.claim(f.next),false);assert.deepEqual(f.closed,[]);assert.equal(f.store.getJob(f.job.id).state,'running');
});

test('an unsettled queued remote job prevents retiring its archived project owner',async t=>{
 const f=await fixture(t,{queuedJob:true});await f.turn.retireInactive();assert.equal(f.turn.owner().id,f.old.id);assert.equal(f.turn.claim(f.next),false);assert.deepEqual(f.closed,[]);assert.equal(f.store.getJob(f.job.id).state,'queued');
});

test('expired leases and browser preparation fences do not leave an archived owner blocked forever',async t=>{
 const f=await fixture(t);f.patch({leaseToken:'expired-lease',leaseUntil:'2026-10-27T07:59:00Z',browserPreparing:true,browserPreparingUntil:'2026-10-27T07:59:00Z'});
 await f.turn.retireInactive();assert.equal(f.turn.owner(),null);assert.equal(f.turn.claim(f.next),true);
});

test('concurrent retirement waits for the old browser to close before allowing another owner',async t=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const f=await fixture(t,{closeBrowser:async()=>{entered();await gate;}}),first=f.turn.retireInactive(),second=f.turn.retireInactive();await started;
 try{assert.equal(f.turn.owner().id,f.old.id);assert.equal(f.turn.claim(f.next),false);assert.deepEqual(f.closed,[f.old.id]);}finally{release();await Promise.all([first,second]);}
 assert.equal(f.turn.owner(),null);assert.equal(f.turn.claim(f.next),true);assert.deepEqual(f.closed,[f.old.id]);
});

test('a failed browser closure keeps ownership and a later successful retry can retire it',async t=>{
 let broken=true;const f=await fixture(t,{closeBrowser:async()=>{if(broken)throw Error('Context still open');}});
 await assert.rejects(f.turn.retireInactive(),/Context still open/);assert.equal(f.turn.owner().id,f.old.id);assert.equal(f.turn.claim(f.next),false);
 broken=false;await f.turn.retireInactive();assert.equal(f.turn.owner(),null);assert.equal(f.turn.claim(f.next),true);
});

test('an owner reopened while its browser is closing is not retired',async t=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),f=await fixture(t,{closeBrowser:async()=>{entered();await gate;}});
 const retiring=f.turn.retireInactive();await started;const project=f.store.getProject(f.project.id);f.store.updateProject(project.id,{archived:false},project.revision);release();await retiring;
 assert.equal(f.turn.owner().id,f.old.id);assert.equal(f.turn.claim(f.next),false);
});

test('an archived native publication without a job can retire while preserving its published checkpoint',async t=>{
 const f=await fixture(t);f.patch({state:'publishing',nativePublication:{phase:'published',postId:80,url:'https://old.example/published/'}});const before=f.store.getRecord(f.old.id);
 await f.turn.retireInactive();assert.equal(f.turn.owner(),null);assert.equal(f.turn.claim(f.next),true);assert.deepEqual(f.store.getRecord(f.old.id),before);
});

test('accepted publication and checking jobs retain the turn until the workflow consumes their settled result',async t=>{
 for(const stage of ['publishing','checking'])for(const terminal of ['failed','uncertain','completed'])await t.test(stage+' then '+terminal,async st=>{
  const f=await fixture(st,{archived:false}),site=f.store.createSite(f.project.id,{name:'Accepted operation',baseUrl:'https://accepted.example/'}),page=f.store.updatePage(f.page.id,{siteId:site.id},f.page.revision);
  const job=f.store.enqueueJob({projectId:f.project.id,siteId:site.id,pageId:page.id,type:stage==='publishing'?'publish':'page_check',idempotencyKey:'accepted-'+stage,payload:{}}),claimed=f.store.claimJob({workerId:'fixture',leaseMs:60000});assert.equal(claimed.id,job.id);
  if(stage==='publishing')f.store.completeRemoteWrite(job.id,{leaseToken:claimed.leaseToken,expectedPageRevision:page.revision,patch:{wpId:80,fullUrl:'https://accepted.example/published/'},result:{}});else f.store.finishJob(job.id,claimed.leaseToken,{state:'completed',result:{}});
  f.patch({state:stage,stage,[stage==='publishing'?'jobId':'checkJobId']:job.id});f.store.updateProject(f.project.id,{archived:true},f.project.revision);
  await f.turn.retireInactive();assert.equal(f.turn.owner()?.id,f.old.id);assert.equal(f.turn.claim(f.next),false);assert.deepEqual(f.closed,[]);
  f.patch({state:terminal,...(terminal==='completed'?{stage:'completed'}:{})});await f.turn.retireInactive();assert.equal(f.turn.owner(),null);assert.equal(f.turn.claim(f.next),true);assert.deepEqual(f.closed,[f.old.id]);
 });
});
