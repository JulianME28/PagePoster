"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
async function fixture(t){
 const {createRunStore}=await import('../server/lifecycle/run-store.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-runs-store-')),filename=path.join(dir,'generation-runs.sqlite');let time=Date.parse('2026-10-15T12:00:00Z');const opened=[];
 const open=()=>{const s=createRunStore({filename,clock:()=>time});opened.push(s);return s;};
 t.after(()=>{opened.forEach(s=>s.close());const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('pp-runs-store-'));fs.rmSync(resolved,{recursive:true,force:true});});
 return {store:open(),open,filename,advance:ms=>time+=ms};
}
function input(key='launch-1',patch={}){return {projectId:'project-1',idempotencyKey:key,spec:{pageId:'page-1',sourceRevision:7,siteId:'site-1',status:'publish',brief:{topic:'Manual topic'},batches:[{targets:[{targetId:'t1',field:'intro'}]},{targets:[{targetId:'t2',field:'title'}]}],generation:{config:{title:'Original',url:'https://example.test/?x=%2F&y=2#keep'}},...patch}};}
function batch(lease,index=0,patch={}){return {leaseToken:lease.leaseToken,batchIndex:index,requestId:'ai-batch-'+index,validated:true,result:{updates:[{targetId:'t'+(index+1),value:'Validated text'}],notes:[]},jobResult:{requestId:'ai-batch-'+index,state:'completed'},...patch};}

test('run snapshots persist immutable specs and canonical idempotency across connections and caller mutation',async t=>{
 const {store:s,open}=await fixture(t),source=input(),r=s.createRun(source);assert.equal(r.state,'queued');assert.equal(r.nextBatchIndex,0);assert.equal(r.revision,1);assert.equal(r.stage,'generation');assert.equal(r.leaseToken,undefined);
 source.spec.generation.config.title='Changed source';r.spec.brief.topic='Changed return';assert.equal(s.getRun(r.id).spec.generation.config.title,'Original');assert.equal(s.getRun(r.id).spec.brief.topic,'Manual topic');
 const same=input();same.spec={generation:same.spec.generation,batches:same.spec.batches,brief:same.spec.brief,status:same.spec.status,siteId:same.spec.siteId,sourceRevision:7,pageId:'page-1'};
 assert.equal(open().createRun(same).id,r.id);assert.throws(()=>s.createRun(input('launch-1',{sourceRevision:8})),{code:'CONFLICT'});assert.throws(()=>s.createRun({...input(),projectId:'project-2'}),{code:'CONFLICT'});assert.equal(open().getRun(r.id).spec.generation.config.url,'https://example.test/?x=%2F&y=2#keep');assert.equal(s.getRun('missing'),null);
});

test('listRuns filters by project and exact state and returns detached bounded records',async t=>{
 const {store:s}=await fixture(t),a=s.createRun(input()),b=s.createRun({...input('two'),projectId:'project-2'});assert.deepEqual(s.listRuns('project-1').map(x=>x.id),[a.id]);assert.equal(s.listRuns(undefined,{limit:1}).length,1);
 s.pauseRun(a.id,{expectedRevision:a.revision});assert.equal(s.listRuns('project-1',{states:['queued']}).length,0);assert.equal(s.listRuns('project-1',{states:['paused']}).length,1);assert.equal(s.listRuns('project-2')[0].id,b.id);assert.throws(()=>s.listRuns(null,{states:['fake']}),{code:'VALIDATION'});
});

test('lease claim is globally single-worker across connections and ownership is required for writes',async t=>{
 const {store:s,open,advance}=await fixture(t),a=s.createRun(input()),b=s.createRun(input('next'));const worker=s.claimRun({workerId:'worker-a',leaseMs:2000});assert.equal(worker.id,a.id);assert.ok(worker.leaseToken);assert.equal(worker.attempt,1);assert.equal(open().claimRun({workerId:'worker-b'}),null);assert.equal(s.getRun(a.id).leaseToken,undefined);
 assert.throws(()=>s.finishBatch(a.id,batch({...worker,leaseToken:'wrong'})),{code:'LEASE_CONFLICT'});advance(1000);const renewed=s.renewRun(a.id,{leaseToken:worker.leaseToken,leaseMs:3000});assert.ok(Date.parse(renewed.leaseUntil)>Date.parse(worker.leaseUntil));assert.equal(s.getRun(b.id).state,'queued');
});

test('validated batch checkpoint and cursor advance together; exact replay is idempotent and changes are rejected',async t=>{
 const {store:s,open}=await fixture(t),r=s.createRun(input()),lease=s.claimRun({workerId:'worker'}),payload=batch(lease);assert.throws(()=>s.finishBatch(r.id,{...payload,validated:false}),{code:'VALIDATION'});assert.throws(()=>s.finishBatch(r.id,{...payload,batchIndex:1}),{code:'CONFLICT'});
 const finished=s.finishBatch(r.id,payload);assert.equal(finished.nextBatchIndex,1);assert.equal(finished.batchResults.length,1);assert.equal(finished.batchResults[0].validated,true);assert.deepEqual(finished.batchResults[0].jobResult,payload.jobResult);const revision=finished.revision;
 assert.equal(s.finishBatch(r.id,payload).revision,revision);assert.throws(()=>s.finishBatch(r.id,{...payload,result:{updates:[]}}),{code:'CONFLICT'});payload.result.updates[0].value='Mutated';finished.batchResults[0].result.updates[0].value='Mutated return';assert.equal(open().getRun(r.id).batchResults[0].result.updates[0].value,'Validated text');assert.equal(open().getRun(r.id).nextBatchIndex,1);
 assert.throws(()=>s.finishBatch(r.id,batch(lease,1,{requestId:'ai-batch-0'})),{code:'CONFLICT'});
});

test('pause invalidates in-flight ownership and resume preserves successful checkpoints',async t=>{
 const {store:s}=await fixture(t),r=s.createRun(input()),lease=s.claimRun({workerId:'first'});s.finishBatch(r.id,batch(lease));const current=s.getRun(r.id);assert.throws(()=>s.pauseRun(r.id,{expectedRevision:r.revision}),{code:'CONFLICT'});
 const paused=s.pauseRun(r.id,{expectedRevision:current.revision});assert.equal(paused.state,'paused');assert.equal(paused.leaseUntil,null);assert.throws(()=>s.finishBatch(r.id,batch(lease,1)),{code:'LEASE_CONFLICT'});assert.throws(()=>s.resumeRun(r.id,{expectedRevision:current.revision}),{code:'CONFLICT'});
 const resumed=s.resumeRun(r.id,{expectedRevision:paused.revision});assert.equal(resumed.state,'queued');assert.equal(resumed.nextBatchIndex,1);const second=s.claimRun({workerId:'second'});assert.notEqual(second.leaseToken,lease.leaseToken);assert.equal(second.batchResults.length,1);s.finishBatch(r.id,batch(second,1));assert.equal(s.transition(r.id,{leaseToken:second.leaseToken,state:'completed',result:{pageRevision:8}}).state,'completed');
});

test('expired recovery returns queued runs with original AI request checkpoints and fences the old worker',async t=>{
 const {store:s,open,advance}=await fixture(t),r=s.createRun(input()),lease=s.claimRun({workerId:'crashed',leaseMs:1000});s.finishBatch(r.id,batch(lease));advance(1001);assert.throws(()=>s.renewRun(r.id,{leaseToken:lease.leaseToken,leaseMs:1000}),{code:'LEASE_CONFLICT'});
 const other=open(),recovered=other.recoverExpiredRuns();assert.equal(recovered.length,1);assert.equal(recovered[0].id,r.id);assert.equal(recovered[0].state,'queued');assert.equal(recovered[0].nextBatchIndex,1);assert.equal(recovered[0].batchResults[0].requestId,'ai-batch-0');assert.equal(recovered[0].error.code,'LEASE_EXPIRED');assert.deepEqual(other.recoverExpiredRuns(),[]);
 const next=other.claimRun({workerId:'new'});assert.equal(next.attempt,2);assert.throws(()=>s.finishBatch(r.id,batch(lease,1)),{code:'LEASE_CONFLICT'});assert.equal(other.finishBatch(r.id,batch(next,1)).nextBatchIndex,2);
});

test('review/completed transitions require all batches and running stage/result checkpoints retain lease',async t=>{
 const {store:s}=await fixture(t),r=s.createRun(input('review',{status:'review',siteId:null})),lease=s.claimRun({workerId:'worker'});assert.throws(()=>s.transition(r.id,{leaseToken:lease.leaseToken,state:'review'}),{code:'CONFLICT'});assert.throws(()=>s.transition(r.id,{leaseToken:lease.leaseToken,state:'not-a-state'}),{code:'VALIDATION'});
 s.finishBatch(r.id,batch(lease));s.finishBatch(r.id,batch(lease,1));const staged=s.transition(r.id,{leaseToken:lease.leaseToken,state:'running',stage:'apply',result:{receipt:'saved-8'}});assert.equal(staged.state,'running');assert.equal(staged.stage,'apply');assert.equal(staged.leaseUntil,lease.leaseUntil);
 const done=s.transition(r.id,{leaseToken:lease.leaseToken,state:'review'});assert.deepEqual(done.result,{receipt:'saved-8'});assert.equal(done.leaseUntil,null);assert.throws(()=>s.resumeRun(r.id,{expectedRevision:done.revision}),{code:'CONFLICT'});assert.throws(()=>s.transition(r.id,{leaseToken:lease.leaseToken,state:'completed'}),{code:'LEASE_CONFLICT'});
});

test('manual and imported HTML pass-through can complete with zero batches without a fabricated AI result',async t=>{
 const {store:s}=await fixture(t),r=s.createRun(input('manual',{batches:[],generation:{config:{contentMode:'html',importHtml:'<h1>Exact HTML</h1>'}}})),lease=s.claimRun({workerId:'worker'});
 const done=s.transition(r.id,{leaseToken:lease.leaseToken,state:'completed',stage:'publication',result:{jobId:'published-once'}});assert.equal(done.batchResults.length,0);assert.equal(done.nextBatchIndex,0);assert.equal(done.spec.generation.config.importHtml,'<h1>Exact HTML</h1>');
});

test('failed and uncertain runs retain evidence and never resume automatically',async t=>{
 const {store:s}=await fixture(t);
 for(const state of ['failed','uncertain']){const r=s.createRun(input(state)),lease=s.claimRun({workerId:'worker'});s.finishBatch(r.id,batch(lease));const done=s.transition(r.id,{leaseToken:lease.leaseToken,state,error:{code:'API_UNKNOWN',message:'Result needs review'},result:{requestId:'ai-batch-1'}});assert.equal(done.state,state);assert.equal(done.nextBatchIndex,1);assert.equal(done.batchResults.length,1);assert.equal(done.error.code,'API_UNKNOWN');assert.throws(()=>s.resumeRun(r.id,{expectedRevision:done.revision}),{code:'CONFLICT'});assert.throws(()=>s.pauseRun(r.id,{expectedRevision:done.revision}),{code:'CONFLICT'});}
 assert.equal(s.claimRun({workerId:'worker'}),null);assert.deepEqual(s.recoverExpiredRuns(),[]);
});

test('known credential fields and malformed specs/results are rejected before persistence',async t=>{
 const {store:s}=await fixture(t);
 for(const change of [{sourceRevision:0},{status:'delete'},{siteId:null},{batches:'not array'},{batches:[1]},{brief:{nested:{applicationPassword:'do-not-store'}}},{generation:{nested:[{api_key:'secret'}]}},{generation:{Authorization:'Bearer secret'}},{generation:{value:NaN}},{generation:{value:undefined}}])assert.throws(()=>s.createRun(input('invalid',change)),{code:'VALIDATION'});
 assert.throws(()=>s.createRun({...input(),extra:'unknown'}),{code:'VALIDATION'});assert.equal(s.listRuns().length,0);const r=s.createRun(input()),lease=s.claimRun({workerId:'worker'});assert.throws(()=>s.finishBatch(r.id,batch(lease,0,{result:{password:'private'}})),{code:'VALIDATION'});assert.equal(s.getRun(r.id).nextBatchIndex,0);assert.throws(()=>s.transition(r.id,{leaseToken:lease.leaseToken,state:'failed',error:{code:'PRIVATE',message:'safe',providerBody:'raw'}}),{code:'VALIDATION'});
});

test('bounded queue rejects a 101st unfinished run but keeps idempotent replay available',async t=>{
 const {store:s}=await fixture(t);for(let i=0;i<100;i++)s.createRun(input('job-'+i));assert.throws(()=>s.createRun(input('over-limit')),{code:'QUEUE_FULL'});assert.equal(s.createRun(input('job-0')).id,s.listRuns()[0].id);assert.equal(s.listRuns().length,100);
});

test('closed stores and unrelated SQLite files fail closed',async t=>{
 const {store:s,filename}=await fixture(t);s.close();assert.throws(()=>s.listRuns(),{code:'CLOSED'});const {createRunStore}=await import('../server/lifecycle/run-store.mjs');const alien=filename+'.alien',db=new DatabaseSync(alien);db.exec('CREATE TABLE unrelated(value TEXT);');db.prepare('INSERT INTO unrelated VALUES(?)').run('keep');db.close();assert.throws(()=>createRunStore({filename:alien}),{code:'VALIDATION'});const check=new DatabaseSync(alien);assert.equal(check.prepare('SELECT value FROM unrelated').get().value,'keep');check.close();
});


test('batch yield releases the lease and coordinator can fence by token without exposing it publicly',async t=>{
 const {store:s,advance}=await fixture(t),a=s.createRun(input('first',{launch:{expectedRevision:7,status:'publish'}})),b=s.createRun(input('second'));const lease=s.claimRun({workerId:'worker'});assert.equal(s.assertLease(a.id,lease.leaseToken).id,a.id);assert.equal(s.assertLease(a.id,lease.leaseToken).leaseToken,undefined);s.finishBatch(a.id,batch(lease));advance(1);
 const yielded=s.transition(a.id,{leaseToken:lease.leaseToken,state:'queued',stage:'generating'});assert.equal(yielded.cursor,1);assert.equal(yielded.leaseUntil,null);assert.throws(()=>s.assertLease(a.id,lease.leaseToken),{code:'LEASE_CONFLICT'});assert.equal(s.claimRun({workerId:'next'}).id,b.id);
});

test('opaque prepared generation snapshots up to 16 MiB and safe code-only errors are supported',async t=>{
 const {store:s}=await fixture(t),opaque='a'.repeat(9*1024*1024),r=s.createRun(input('large',{generation:{snapshot:opaque}}));assert.equal(s.getRun(r.id).spec.generation.snapshot.length,opaque.length);assert.throws(()=>s.createRun(input('oversize',{generation:{snapshot:'a'.repeat(16*1024*1024)}})),{code:'VALIDATION'});const lease=s.claimRun({workerId:'worker'});assert.equal(s.transition(r.id,{leaseToken:lease.leaseToken,state:'failed',error:{code:'not_configured'}}).error.code,'not_configured');
});
