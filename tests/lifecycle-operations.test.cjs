const test=require('node:test'),assert=require('node:assert/strict');
async function fixture(t){const {createStore}=await import('../server/lifecycle/store.mjs');const s=createStore({filename:':memory:',masterKey:Buffer.alloc(32,20).toString('base64')});t.after(()=>s.close());const p=s.createProject({name:'P'}),site=s.createSite(p.id,{name:'Site',baseUrl:'https://example.com'}),page=s.createPage(p.id,{title:'Page',siteId:site.id});return{s,p,site,page};}
test('pending replacement has no runnable job and confirmation is revision checked',async t=>{const {s,p,page}=await fixture(t);const proposal=s.createProposal(page.id,{expectedPageRevision:page.revision,diff:[{before:'old',after:'new'}],nextConfig:{title:'new'},expectedContentHash:'oldhash'});assert.equal(s.claimJob({workerId:'w',leaseMs:1000}),null);assert.throws(()=>s.confirmProposal(proposal.id,99),{code:'CONFLICT'});const confirmed=s.confirmProposal(proposal.id,proposal.revision);assert.equal(confirmed.state,'confirmed');assert.deepEqual(s.confirmProposal(proposal.id,proposal.revision),confirmed);assert.equal(s.listJobs(p.id).length,0);});
test('manual local update invalidates a pending proposal',async t=>{const {s,page}=await fixture(t);const proposal=s.createProposal(page.id,{expectedPageRevision:page.revision,diff:[],nextConfig:{title:'new'},expectedContentHash:'hash'});s.updatePage(page.id,{title:'Manual'},page.revision);assert.throws(()=>s.confirmProposal(proposal.id,proposal.revision),{code:'CONFLICT'});});
test('publication operation is idempotent and unresolved remote write cannot be silently repeated',async t=>{const {s,p,site,page}=await fixture(t);const args={projectId:p.id,siteId:site.id,pageId:page.id,type:'publish',payload:{config:{url:'https://example.com/?b=2&a=1#x'}},idempotencyKey:'launch-1'};const job=s.enqueueJob(args);assert.equal(s.enqueueJob(args).id,job.id);const claimed=s.claimJob({workerId:'w',leaseMs:1000});assert.equal(claimed.effect,'write');s.finishJob(job.id,claimed.leaseToken,{state:'uncertain',error:{code:'pp_bridge_uncertain'}});assert.equal(s.claimJob({workerId:'w',leaseMs:1000}),null);assert.equal(s.getJob(job.id).state,'uncertain');s.completeRemoteWrite(job.id,{expectedPageRevision:page.revision,patch:{wpId:17},result:{postId:17}});assert.equal(s.getJob(job.id).state,'completed');});

const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
async function diskFixture(t){
 const {createStore}=await import('../server/lifecycle/store.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-complete-')),filename=path.join(dir,'state.sqlite'),stores=[];
 let time=Date.parse('2026-10-14T10:00:00Z');
 const open=()=>{const s=createStore({filename,clock:()=>time});stores.push(s);return s;};
 t.after(()=>{stores.forEach(s=>s.close());fs.rmSync(dir,{recursive:true,force:true});});
 const s=open(),p=s.createProject({name:'P'}),site=s.createSite(p.id,{name:'S',baseUrl:'https://example.com'}),page=s.createPage(p.id,{siteId:site.id,title:'Page'});
 const enqueue=(pageId=page.id,key='write',extra={})=>s.enqueueJob({projectId:p.id,pageId,type:'publish',idempotencyKey:key,payload:{operation:{kind:'create'}},...extra});
 return {s,p,site,page,filename,open,enqueue,advance:ms=>time+=ms};
}
test('remote completion commits once across two connections and stale replay cannot add a version',async t=>{
 const {s,p,page,open,enqueue}=await diskFixture(t),job=enqueue(),claimed=s.claimJob({workerId:'a',leaseMs:1000}),second=open();
 const input={leaseToken:claimed.leaseToken,expectedPageRevision:1,patch:{wpId:41,fullUrl:'https://example.com/?editor_id=10&a=%2F#top',config:{title:'Accepted'}},result:{postId:41}};
 const completed=s.completeRemoteWrite(job.id,input);
 assert.equal(completed.state,'completed');assert.deepEqual(second.completeRemoteWrite(job.id,{...input,patch:{title:'Must not change'}}),completed);
 assert.equal(second.getPage(page.id).revision,2);assert.equal(second.getPage(page.id).versions.length,2);assert.equal(second.getPage(page.id).config.title,'Accepted');
 assert.equal(second.listEvents(p.id).filter(e=>e.type==='remote_write.completed').length,1);
});
test('remote completion fences live lease, page revision and site relationship',async t=>{
 const {s,p,page,site,enqueue,advance}=await diskFixture(t),job=enqueue(),claimed=s.claimJob({workerId:'a',leaseMs:20});
 const input={leaseToken:claimed.leaseToken,expectedPageRevision:1,patch:{wpId:41},result:{}};
 assert.throws(()=>s.completeRemoteWrite(job.id,{...input,leaseToken:'old'}),{code:'LEASE_CONFLICT'});
 assert.throws(()=>s.completeRemoteWrite(job.id,{...input,expectedPageRevision:2}),{code:'CONFLICT'});
 assert.throws(()=>s.completeRemoteWrite(job.id,{...input,patch:{siteId:null,wpId:41}}),{code:'CONFLICT'});
 const other=s.createSite(p.id,{name:'Other',baseUrl:'https://other.example'});
 s.updatePage(page.id,{siteId:other.id},1);
 assert.throws(()=>s.completeRemoteWrite(job.id,{...input,expectedPageRevision:2}),{code:'CONFLICT'});
 s.updatePage(page.id,{siteId:site.id},2);advance(20);
 assert.throws(()=>s.completeRemoteWrite(job.id,{...input,expectedPageRevision:3}),{code:'LEASE_CONFLICT'});
 assert.equal(s.getJob(job.id).state,'running');assert.equal(s.getPage(page.id).wpId,null);
 s.recoverExpiredJobs();
 assert.throws(()=>s.completeRemoteWrite(job.id,{...input,expectedPageRevision:3}),{code:'LEASE_CONFLICT'});
 assert.equal(s.completeRemoteWrite(job.id,{expectedPageRevision:3,patch:{wpId:41},result:{postId:41}}).state,'completed');
});
test('failure after page and snapshot writes rolls back the page, job and event together',async t=>{
 const {s,p,page,filename,enqueue}=await diskFixture(t),job=enqueue(),claimed=s.claimJob({workerId:'a',leaseMs:1000});
 const raw=new DatabaseSync(filename);
 raw.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'fixture event failure'); END");
 const input={leaseToken:claimed.leaseToken,expectedPageRevision:1,patch:{wpId:41},result:{postId:41}};
 assert.throws(()=>s.completeRemoteWrite(job.id,input),/fixture event failure/);
 assert.equal(s.getPage(page.id).revision,1);assert.equal(s.getPage(page.id).versions.length,1);assert.equal(s.getPage(page.id).wpId,null);
 assert.equal(s.getJob(job.id).state,'running');assert.equal(s.getJob(job.id).result,null);assert.equal(s.listEvents(p.id).length,0);
 raw.exec('DROP TRIGGER fail_event');raw.close();
 assert.equal(s.completeRemoteWrite(job.id,input).state,'completed');
});
test('generic finish/reconcile cannot complete a write without its page commit',async t=>{
 const {s,enqueue}=await diskFixture(t),job=enqueue(),claimed=s.claimJob({workerId:'a',leaseMs:1000});
 assert.throws(()=>s.finishJob(job.id,claimed.leaseToken,{state:'completed',result:{postId:1}}),{code:'VALIDATION'});
 s.finishJob(job.id,claimed.leaseToken,{state:'uncertain'});
 assert.throws(()=>s.reconcileJob(job.id,{state:'completed',result:{postId:1}}),{code:'VALIDATION'});
 assert.equal(s.reconcileJob(job.id,{state:'failed',error:{code:'CONFLICT'}}).state,'failed');
});
test('capacity reservation counts distinct published and pending pages atomically across connections',async t=>{
 const {s,p,site,page,open,enqueue}=await diskFixture(t),other=open();
 s.createPage(p.id,{siteId:site.id,title:'Published',wpId:10});
 const queued=enqueue(page.id,'one',{maxPages:2});
 assert.equal(enqueue(page.id,'one',{maxPages:2}).id,queued.id);
 enqueue(page.id,'same-page',{maxPages:2}); // One page consumes one slot, not one slot per operation.
 const next=s.createPage(p.id,{siteId:site.id,title:'Next'});
 assert.throws(()=>other.enqueueJob({projectId:p.id,pageId:next.id,type:'publish',idempotencyKey:'overflow',maxPages:2}),{code:'CAPACITY_EXCEEDED'});
 s.pauseJob(queued.id);
 assert.throws(()=>enqueue(next.id,'paused-reserves',{maxPages:2}),{code:'CAPACITY_EXCEEDED'});
 const claimed=s.claimJob({workerId:'a',leaseMs:1000});
 s.finishJob(claimed.id,claimed.leaseToken,{state:'uncertain'});
 assert.throws(()=>enqueue(next.id,'uncertain-reserves',{maxPages:2}),{code:'CAPACITY_EXCEEDED'});
 assert.equal(s.listJobs(p.id).length,2);
 const another=s.createProject({name:'Independent'}),aSite=s.createSite(another.id,{name:'S',baseUrl:'https://other.example'}),aPage=s.createPage(another.id,{siteId:aSite.id,title:'P'});
 assert.ok(s.enqueueJob({projectId:another.id,pageId:aPage.id,type:'publish',idempotencyKey:'other-project',maxPages:1}).id);
});
test('invalid page limits and site-less writes cannot create jobs',async t=>{
 const {s,p,page,enqueue}=await diskFixture(t);
 for(const maxPages of [0,-1,1.5,'2'])assert.throws(()=>enqueue(page.id,'limit-'+maxPages,{maxPages}),{code:'VALIDATION'});
 const loose=s.createPage(p.id,{title:'No site'});
 assert.throws(()=>enqueue(loose.id,'no-site'),{code:'VALIDATION'});
 assert.equal(s.listJobs(p.id).length,0);
});

test('resume keeps the operation ID and cannot replay an uncertain in-flight write',async t=>{
 const {s,p,site,page}=await fixture(t);const job=s.enqueueJob({projectId:p.id,siteId:site.id,pageId:page.id,type:'publish',payload:{},idempotencyKey:'pause-fixture'});
 s.pauseJob(job.id);assert.equal(s.claimJob({workerId:'w',leaseMs:1000}),null);assert.equal(s.resumeJob(job.id).id,job.id);const claimed=s.claimJob({workerId:'w',leaseMs:1000});assert.equal(claimed.id,job.id);s.pauseJob(job.id);assert.throws(()=>s.resumeJob(job.id),{code:'CONFLICT'});assert.equal(s.getJob(job.id).state,'uncertain');
});
