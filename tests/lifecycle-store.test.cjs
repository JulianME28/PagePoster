'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),loaded=import('../server/lifecycle/store.mjs');
const masterKey=randomBytes(32).toString('base64');
async function fixture(t){
 const {createStore}=await loaded,directory=fs.mkdtempSync(path.join(os.tmpdir(),'pp-store-')),filename=path.join(directory,'state.sqlite');
 let time=Date.parse('2026-10-14T10:00:00Z');const opened=[];
 const open=()=>{const s=createStore({filename,masterKey,clock:()=>time});opened.push(s);return s;};
 t.after(()=>{for(const s of opened)s.close();fs.rmSync(directory,{recursive:true,force:true});});
 return {store:open(),open,filename,advance:ms=>{time+=ms;}};
}
const project=(s,name='Example')=>s.createProject({name,description:'Description',language:'uk',country:'UA',tags:['pilot']});
const site=(s,p,x={})=>s.createSite(p,{name:'WordPress',baseUrl:'https://example.com/blog/',...x});
const page=(s,p,siteId,x={})=>s.createPage(p,{siteId,title:'Demo',fullUrl:'https://example.com/blog/page/?offer=A%2FB&x=1#part',...x});
const job=(s,p,siteId,idempotencyKey,x={})=>s.enqueueJob({projectId:p,siteId,type:'site_check',idempotencyKey,...x});
test('projects persist detached snapshots with optimistic revisions',async t=>{
 const {store:s,open,advance}=await fixture(t),p=project(s);assert.equal(p.revision,1);assert.equal(p.createdAt,'2026-10-14T10:00:00.000Z');
 p.tags.push('mutation');assert.deepEqual(s.getProject(p.id).tags,['pilot']);advance(1000);
 const next=s.updateProject(p.id,{name:'Renamed'},1);assert.equal(next.revision,2);assert.notEqual(next.updatedAt,p.updatedAt);
 assert.throws(()=>s.updateProject(p.id,{name:'Stale'},1),{code:'CONFLICT'});
 assert.equal(open().getProject(p.id).name,'Renamed');assert.equal(s.getProject('missing'),null);
});
test('credentials are encrypted on disk, internal only, replaceable and revocable',async t=>{
 const {store:s,filename}=await fixture(t),p=project(s),credentials={username:'secret-user-2842',applicationPassword:'secret-password-70131'},a=site(s,p.id,credentials);
 assert.equal(a.hasCredential,true);assert.deepEqual(s.getSiteCredentials(a.id),credentials);
 assert.doesNotMatch(JSON.stringify([a,s.listSites(p.id),s.getSite(a.id)]),/secret-user|secret-password|ciphertext|username|applicationPassword/);
 const raw=new DatabaseSync(filename);const rows=raw.prepare('SELECT * FROM site_credentials').all();raw.close();
 assert.doesNotMatch(JSON.stringify(rows),/secret-user|secret-password/);
 assert.equal(s.updateSite(a.id,{username:'new-user',applicationPassword:'new-pass'},1).revision,2);
 assert.deepEqual(s.getSiteCredentials(a.id),{username:'new-user',applicationPassword:'new-pass'});
 assert.throws(()=>s.updateSite(a.id,{username:'half'},2),{code:'VALIDATION'});
 assert.equal(s.updateSite(a.id,{username:'',applicationPassword:''},2).hasCredential,false);assert.equal(s.getSiteCredentials(a.id),null);
});
test('relationships and unsafe URLs are rejected',async t=>{
 const {store:s}=await fixture(t),a=project(s,'A'),b=project(s,'B'),c=site(s,a.id);
 assert.throws(()=>site(s,'missing'),{code:'NOT_FOUND'});assert.throws(()=>page(s,b.id,c.id),{code:'VALIDATION'});
 assert.throws(()=>site(s,a.id,{baseUrl:'javascript:alert(1)'}),{code:'VALIDATION'});
 assert.throws(()=>page(s,a.id,c.id,{fullUrl:'https://user:pass@example.com'}),{code:'VALIDATION'});
 assert.throws(()=>page(s,a.id,c.id,{expectedUrls:['data:text/html,hi']}),{code:'VALIDATION'});
 assert.throws(()=>s.updateProject(a.id,{id:b.id},1),{code:'VALIDATION'});assert.throws(()=>s.createProject({name:''}),{code:'VALIDATION'});
});
test('page versions retain immutable config and exact URLs across restart',async t=>{
 const {store:s,open}=await fixture(t),p=project(s),a=site(s,p.id),config={title:'Manual',cards:[{name:'Initial',url:'https://offer.example/?a=1&b=%2F'}]};
 const first=page(s,p.id,a.id,{config,expectedUrls:[config.cards[0].url],expectedMarker:'pp-landing',wpId:17,wpType:'page'});config.cards[0].name='Mutation';
 const next=s.updatePage(first.id,{title:'Changed',config:{title:'Changed'}},1);
 assert.equal(next.revision,2);assert.equal(next.versions.length,2);assert.equal(next.versions[0].snapshot.config.cards[0].name,'Initial');
 assert.equal(next.fullUrl,'https://example.com/blog/page/?offer=A%2FB&x=1#part');assert.deepEqual(next.expectedUrls,['https://offer.example/?a=1&b=%2F']);
 assert.throws(()=>s.updatePage(first.id,{title:'Stale'},1),{code:'CONFLICT'});assert.equal(open().getPage(first.id).versions.length,2);
});
test('checks/events persist separate states and site health fields',async t=>{
 const {store:s}=await fixture(t),p=project(s),a=site(s,p.id),b=page(s,p.id,a.id);
 const check=s.addCheck(b.id,{kind:'robots',state:'unknown',evidence:{reason:'Timeout'}});
 assert.equal(check.pageId,b.id);assert.equal(check.revision,1);assert.equal(s.listChecks(b.id)[0].state,'unknown');
 assert.throws(()=>s.addCheck(b.id,{kind:'robots',state:'successful'}),{code:'VALIDATION'});
 s.recordEvent({projectId:p.id,type:'page.created',entityId:b.id,message:'Page saved'});assert.equal(s.listEvents(p.id)[0].message,'Page saved');
 assert.equal(s.updateSite(a.id,{status:'ok',capabilities:{edit_pages:true},lastCheckedAt:check.createdAt},1).status,'ok');
});
test('idempotency returns existing operation and conflicts on changed request',async t=>{
 const {store:s}=await fixture(t),p=project(s),a=site(s,p.id),one=job(s,p.id,a.id,'same',{payload:{b:2,a:1}});
 assert.equal(job(s,p.id,a.id,'same',{payload:{a:1,b:2}}).id,one.id);
 assert.throws(()=>job(s,p.id,a.id,'same',{payload:{a:3}}),{code:'CONFLICT'});
 assert.throws(()=>job(s,p.id,a.id,'publish',{type:'publish'}),{code:'VALIDATION'});assert.equal(s.listJobs(p.id).length,1);
});
test('leases are durable and fenced with one running job/site across connections',async t=>{
 const {store:s,open}=await fixture(t),p=project(s),a=site(s,p.id),b=site(s,p.id,{name:'Other',baseUrl:'https://other.example/'});
 job(s,p.id,a.id,'a1');job(s,p.id,a.id,'a2');job(s,p.id,b.id,'b1');
 const one=s.claimJob({workerId:'A',leaseMs:1000}),other=open(),two=other.claimJob({workerId:'B',leaseMs:1000});
 assert.notEqual(one.siteId,two.siteId);assert.equal(other.claimJob({workerId:'B',leaseMs:1000}),null);assert.equal(one.attempt,1);assert.ok(one.leaseToken);
 assert.equal(s.listJobs(p.id)[0].leaseToken,undefined);assert.throws(()=>s.finishJob(one.id,'bad',{state:'completed'}),{code:'LEASE_CONFLICT'});
 s.finishJob(one.id,one.leaseToken,{state:'completed',result:{state:'ok'}});assert.equal(other.claimJob({workerId:'B',leaseMs:1000}).siteId,one.siteId);
});
test('expired reads retry three times maximum; stale completions cannot win',async t=>{
 const {store:s,advance}=await fixture(t),p=project(s),a=site(s,p.id);job(s,p.id,a.id,'retry');
 const one=s.claimJob({workerId:'one',leaseMs:10});advance(10);
 assert.throws(()=>s.finishJob(one.id,one.leaseToken,{state:'completed'}),{code:'LEASE_CONFLICT'});
 assert.equal(s.recoverExpiredJobs()[0].state,'queued');const two=s.claimJob({workerId:'two',leaseMs:10});assert.notEqual(two.leaseToken,one.leaseToken);
 assert.throws(()=>s.finishJob(one.id,one.leaseToken,{state:'completed'}),{code:'LEASE_CONFLICT'});advance(10);s.recoverExpiredJobs();
 assert.equal(s.claimJob({workerId:'three',leaseMs:10}).attempt,3);advance(10);assert.equal(s.recoverExpiredJobs()[0].state,'failed');
 assert.equal(s.claimJob({workerId:'four',leaseMs:10}),null);
});
test('expired future writes become uncertain and are never retried',async t=>{
 const {store:s,filename,advance}=await fixture(t),p=project(s),a=site(s,p.id),q=job(s,p.id,a.id,'future-write');
 const raw=new DatabaseSync(filename);raw.prepare("UPDATE jobs SET effect='write' WHERE id=?").run(q.id);raw.close();
 s.claimJob({workerId:'writer',leaseMs:10});advance(11);assert.equal(s.recoverExpiredJobs()[0].state,'uncertain');assert.equal(s.claimJob({workerId:'next',leaseMs:10}),null);
});
test('pause invalidates read lease; disabled or delayed jobs do not run',async t=>{
 const {store:s,advance}=await fixture(t),p=project(s),a=site(s,p.id),q=job(s,p.id,a.id,'pause'),r=s.claimJob({workerId:'one',leaseMs:100});
 assert.equal(s.pauseJob(q.id).state,'paused');assert.throws(()=>s.finishJob(q.id,r.leaseToken,{state:'completed'}),{code:'LEASE_CONFLICT'});
 job(s,p.id,a.id,'later',{runAfter:'2026-10-14T10:00:01.000Z'});assert.equal(s.claimJob({workerId:'one',leaseMs:100}),null);
 advance(1000);s.updateSite(a.id,{enabled:false},1);assert.equal(s.claimJob({workerId:'one',leaseMs:100}),null);
 s.updateSite(a.id,{enabled:true},2);assert.equal(s.claimJob({workerId:'one',leaseMs:100}).idempotencyKey,'later');
});
test('backup explicit projections omit secrets and arbitrary job/event data without changing stored config',async t=>{
 const {store:s}=await fixture(t),p=project(s),username='editor',password='sensitive-password-1881',a=site(s,p.id,{username,applicationPassword:password});
 const b=page(s,p.id,a.id,{config:{title:'Keep this',url:'https://offers.example/?editor_id=10&x=%2f#A',ordinary:'ordinary'}});
 s.recordEvent({projectId:p.id,type:'note',entityId:b.id,message:'secret '+password});s.addCheck(b.id,{kind:'access',state:'unknown',evidence:{authorization:password,details:'secret '+password}});
 job(s,p.id,a.id,'backup',{payload:{password,details:'secret '+password}});const running=s.claimJob({workerId:'one',leaseMs:100});
 s.finishJob(running.id,running.leaseToken,{state:'completed',result:{password},error:{password}});
 const backup=s.exportBackup();assert.doesNotMatch(JSON.stringify(backup),/sensitive-user-1881|sensitive-password-1881|ciphertext|applicationPassword|leaseToken/);
 assert.equal(backup.pages[0].config.title,'Keep this');assert.equal(backup.jobs[0].payload,undefined);assert.equal(backup.jobs[0].result,undefined);assert.equal(backup.events[0].message,undefined);
 assert.equal(backup.pages[0].config.url,'https://offers.example/?editor_id=10&x=%2f#A');
 assert.equal(backup.pageVersions[0].snapshot.config.url,backup.pages[0].config.url);
 assert.equal(s.getPage(b.id).config.title,'Keep this');
});

test('invalid credential containers return validation errors without partial writes',async t=>{
 const {store:s}=await fixture(t),p=project(s);
 for(const input of [null,undefined,[],42]) assert.throws(()=>s.createSite(p.id,input),{code:'VALIDATION'});
 assert.deepEqual(s.listSites(p.id),[]);
 const a=site(s,p.id);
 assert.throws(()=>s.updateSite(a.id,null,1),{code:'VALIDATION'});
 assert.equal(s.getSite(a.id).revision,1);
});
test('page checks derive their site and reject inconsistent identities',async t=>{
 const {store:s}=await fixture(t),p=project(s),a=site(s,p.id),b=site(s,p.id,{baseUrl:'https://other.example'}),saved=page(s,p.id,a.id);
 const q=s.enqueueJob({projectId:p.id,pageId:saved.id,type:'page_check',idempotencyKey:'page-read'});
 assert.equal(q.siteId,a.id);assert.equal(q.pageId,saved.id);assert.equal(q.effect,'read');
 assert.throws(()=>s.enqueueJob({projectId:p.id,pageId:saved.id,siteId:b.id,type:'page_check',idempotencyKey:'bad'}),{code:'VALIDATION'});
});
test('database and journal bytes contain no plaintext credential material',async t=>{
 const {store:s,filename}=await fixture(t),p=project(s),username='disk-private-user-456789',password='disk-private-password-7654321';
 site(s,p.id,{username,applicationPassword:password});
 for(const suffix of ['', '-wal', '-shm']){
  if(!fs.existsSync(filename+suffix))continue;
  const bytes=fs.readFileSync(filename+suffix);
  assert.equal(bytes.includes(Buffer.from(username)),false);
  assert.equal(bytes.includes(Buffer.from(password)),false);
 }
});


test('backup refuses actual passwords in authored content instead of rewriting an exact URL',async t=>{
 const {store:s}=await fixture(t),p=project(s),password='private-password-in-url-88191',a=site(s,p.id,{username:'editor',applicationPassword:password});
 const original='https://offer.example/?ref='+password+'&editor_id=10';
 const b=page(s,p.id,a.id,{config:{url:original}});
 assert.throws(()=>s.exportBackup(),error=>error.code==='BACKUP_SECRET'&&!error.message.includes(password));
 assert.equal(s.getPage(b.id).config.url,original);
 s.updatePage(b.id,{config:{url:'https://safe.example/?editor_id=10'}},1);
 assert.throws(()=>s.exportBackup(),{code:'BACKUP_SECRET'}); // Older snapshots must not leak either.
});
test('metadata preserves username substrings in exact destinations and write payload is untouched',async t=>{
 const {store:s}=await fixture(t),p=project(s),a=site(s,p.id,{username:'editor',applicationPassword:'private-pass-881919'}),b=page(s,p.id,a.id);
 const exact='https://offer.example/?editor_id=10&b=%2f#A';
 const event=s.recordEvent({projectId:p.id,type:'url',entityId:b.id,message:exact});
 assert.equal(event.message,exact);
 const queued=s.enqueueJob({projectId:p.id,pageId:b.id,type:'publish',idempotencyKey:'exact-write',payload:{config:{url:exact}}});
 assert.equal(queued.payload.config.url,exact);
});

test('backup refuses credential material used as authored JSON keys as well as values',async t=>{
 const{store:s}=await fixture(t),p=project(s),password='private-key-shaped-secret-91981',a=site(s,p.id,{username:'editor',applicationPassword:password});
 page(s,p.id,a.id,{config:{[password]:'An ordinary value'}});
 assert.throws(()=>s.exportBackup(),{code:'BACKUP_SECRET'});
});
