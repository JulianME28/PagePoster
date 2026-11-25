const test=require('node:test'),assert=require('node:assert/strict');
async function fixture(t){const {createStore}=await import('../server/lifecycle/store.mjs'),{createPublicationTurn}=await import('../server/lifecycle/publication-turn.mjs');const store=createStore({filename:':memory:'});t.after(()=>store.close());const project=store.createProject({name:'Local updates'});const turn=createPublicationTurn({store,allRuns:()=>store.listRecords(project.id,'autopilot')});return {store,project,turn};}
test('a native update owns the same global turn through checking, uncertainty and project close',async t=>{
 const {store,project,turn}=await fixture(t),update=store.createRecord(project.id,'native_update',{state:'queued',stage:'publishing',phase:'queued'}),publication=store.createRecord(project.id,'autopilot',{state:'queued',stage:'selecting'});
 assert.equal(turn.claim(update),true);assert.equal(turn.owner()?.id,update.id,'native update must remain a recognized global owner');assert.equal(turn.claim(publication),false);
 let current=store.getRecord(update.id);store.updateRecord(update.id,{state:'checking'},current.revision);turn.complete(update.id);assert.equal(turn.owner().id,update.id);
 current=store.getRecord(update.id);store.updateRecord(update.id,{state:'uncertain',phase:'dispatching'},current.revision);store.updateProject(project.id,{archived:true},project.revision);await turn.retireInactive();assert.equal(turn.owner().id,update.id,'closing a project cannot erase an unknown update');
 current=store.getRecord(update.id);store.updateRecord(update.id,{state:'completed'},current.revision);turn.complete(update.id);assert.equal(turn.owner(),null);
});
test('native turn releases a failed update only with a proven unsent job and no dispatch checkpoint',async t=>{
 const {store,project,turn}=await fixture(t),site=store.createSite(project.id,{name:'Fixture',baseUrl:'https://fixture.example/'}),page=store.createPage(project.id,{title:'Fixture',siteId:site.id});
 const job=store.enqueueJob({projectId:project.id,siteId:site.id,pageId:page.id,type:'replace',payload:{},idempotencyKey:'unsent'}),update=store.createRecord(project.id,'native_update',{state:'failed',stage:'publishing',phase:'prepared',jobId:job.id});turn.claim(update);
 assert.equal(typeof turn.releaseUnsent,'function');assert.equal(turn.releaseUnsent(update.id),false);
 const leased=store.claimJob({workerId:'fixture',leaseMs:1000});store.finishJob(job.id,leased.leaseToken,{state:'failed',result:{writeNotAttempted:true}});assert.equal(turn.releaseUnsent(update.id),true);assert.equal(turn.owner(),null);
 let current=store.getRecord(update.id);store.updateRecord(update.id,{phase:'dispatching'},current.revision);turn.claim(store.getRecord(update.id));assert.equal(turn.releaseUnsent(update.id),false);assert.equal(turn.owner().id,update.id);
});
test('worker selection can hold all writes or allow only the current update while reads continue',async t=>{
 const {store,project}=await fixture(t),a=store.createSite(project.id,{name:'A',baseUrl:'https://a.example/'}),b=store.createSite(project.id,{name:'B',baseUrl:'https://b.example/'}),c=store.createSite(project.id,{name:'C',baseUrl:'https://c.example/'});
 const p1=store.createPage(project.id,{title:'First',siteId:a.id}),p2=store.createPage(project.id,{title:'Second',siteId:b.id});
 const write1=store.enqueueJob({projectId:project.id,siteId:a.id,pageId:p1.id,type:'replace',payload:{},idempotencyKey:'write1'}),write2=store.enqueueJob({projectId:project.id,siteId:b.id,pageId:p2.id,type:'replace',payload:{},idempotencyKey:'write2'}),read=store.enqueueJob({projectId:project.id,siteId:c.id,type:'site_check',payload:{},idempotencyKey:'read'});
 const readLease=store.claimJob({workerId:'reader',leaseMs:1000,allowedWriteJobId:null});assert.equal(readLease?.id,read.id,'unknown update blocks other writes, not safe reads');store.finishJob(read.id,readLease.leaseToken,{state:'completed'});
 assert.equal(store.claimJob({workerId:'held',leaseMs:1000,allowedWriteJobId:null}),null);
 const writeLease=store.claimJob({workerId:'owner',leaseMs:1000,allowedWriteJobId:write2.id});assert.equal(writeLease?.id,write2.id);assert.equal(store.getJob(write1.id).state,'queued');
 assert.throws(()=>store.claimJob({workerId:'bad',leaseMs:1000,allowedWriteJobId:23}),{code:'VALIDATION'});
});
test('job heartbeat extends only an exact active unexpired lease and cannot revive a recovered update',async t=>{
 const {createStore}=await import('../server/lifecycle/store.mjs');let now=Date.parse('2026-11-02T12:00:00Z');const store=createStore({filename:':memory:',clock:()=>now});t.after(()=>store.close());const p=store.createProject({name:'Lease'}),s=store.createSite(p.id,{name:'Fixture',baseUrl:'https://lease.example/'}),page=store.createPage(p.id,{siteId:s.id,title:'Lease'}),job=store.enqueueJob({projectId:p.id,siteId:s.id,pageId:page.id,type:'replace',payload:{},idempotencyKey:'lease'}),leased=store.claimJob({workerId:'one',leaseMs:100});
 assert.equal(typeof store.renewJob,'function');now+=50;const renewed=store.renewJob(job.id,leased.leaseToken,100);assert.equal(Date.parse(renewed.leaseUntil),now+100);assert.throws(()=>store.renewJob(job.id,'foreign',100),{code:'LEASE_CONFLICT'});
 now+=101;assert.throws(()=>store.renewJob(job.id,leased.leaseToken,100),{code:'LEASE_CONFLICT'});store.recoverExpiredJobs();assert.equal(store.getJob(job.id).state,'uncertain');assert.throws(()=>store.renewJob(job.id,leased.leaseToken,100),{code:'LEASE_CONFLICT'});
});
