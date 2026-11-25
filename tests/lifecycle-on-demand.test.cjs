const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const KEY=Buffer.alloc(32,27).toString('base64');
async function fixture(t,extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-on-demand-'));let now=Date.parse('2026-10-15T12:00:00Z');const calls=[];
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 const app=await createLifecycleService({dataDir:dir,masterKey:KEY,clock:()=>now,client:{checkSite:async({baseUrl})=>{calls.push(['site',baseUrl]);return {state:'ok'};},checkPage:async({page})=>{calls.push(['page',page.id]);return ['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:{fixture:true}}));}},browserVerifier:{verifyPublished:async()=>({state:'ok',scope:'public-snapshot',viewports:[]})},...extra});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 async function q(route,body,headers={}){const r=await app.handle(new Request('http://127.0.0.1:4317/api/lifecycle'+route,{method:body?'POST':'GET',headers:{Origin:'http://127.0.0.1:4317','Content-Type':'application/json','X-PagePoster-Request':'1',...headers},...(body?{body:JSON.stringify(body)}:{})}));return {status:r.status,...await r.json()};}
 function project(name='Project',options={}){return app.store.createProject({name,...options});}
 function site(p,host='example.com'){return app.store.createSite(p.id,{name:host,baseUrl:'https://'+host,username:'fixture',applicationPassword:'fixture-private'});}
 function page(p,s,title='Page'){return app.store.createPage(p.id,{title,siteId:s.id,fullUrl:s.baseUrl+'/'+encodeURIComponent(title),wpId:10});}
 return {app,q,project,site,page,calls,advance:ms=>now+=ms};
}
test('ordinary worker ticks never start monitoring, even after due intervals or old failure schedules',async t=>{
 const f=await fixture(t),p=f.project(),s=f.site(p),page=f.page(p,s);f.app.store.createRecord(p.id,'monitor-schedule',{entityId:page.id,type:'page_check',nextDue:0,failures:2},'schedule:page_check:'+page.id);
 for(let i=0;i<3;i++){await f.app.tick();f.advance(30*86400000);}
 assert.equal(f.app.store.listJobs(p.id).length,0);assert.equal(f.calls.length,0);
 const status=await f.q('/status');assert.equal(status.monitoring.mode,'on-demand');assert.equal(status.monitoring.scheduled,false);
});
test('project action checks its pages and access once, ignoring saved interval or disabled schedule policy',async t=>{
 const f=await fixture(t),p=f.project('Chosen',{monitoringPolicy:{enabled:false}}),other=f.project('Other'),s=f.site(p),a=f.page(p,s,'A'),b=f.page(p,s,'B');f.app.store.attachSite(other.id,s.id);f.page(other,s,'Not chosen');f.app.store.createPage(p.id,{title:'Not published'});
 const result=await f.q('/projects/'+p.id+'/check-pages',{});assert.equal(result.status,202);assert.equal(result.mode,'on-demand');assert.deepEqual(result.projectIds,[p.id]);assert.equal(result.queued,3);assert.equal(result.reused,0);assert.equal(result.skipped,1);assert.equal(result.jobs.filter(j=>j.type==='site_check').length,1);assert.deepEqual(result.pages.filter(p=>p.jobId).map(p=>p.pageId).sort(),[a.id,b.id].sort());assert.equal(f.calls.length,0);
 for(let i=0;i<4;i++)await f.app.tick();assert.equal(f.calls.filter(c=>c[0]==='page').length,2);assert.equal(f.app.store.listJobs(other.id).length,0);assert.equal(f.app.store.getPage(a.id).verification.state,'ok');
 f.advance(40*86400000);await f.app.tick();assert.equal(f.calls.length,3,'A finished requested check must not start periodic monitoring');
});
test('global action keeps archived paused checks paused and reuses a new active-owned shared-site check',async t=>{
 const f=await fixture(t),a=f.project('A'),b=f.project('B'),archived=f.project('Archived'),s=f.site(archived);f.app.store.attachSite(a.id,s.id);f.app.store.attachSite(b.id,s.id);const pa=f.page(a,s,'A'),pb=f.page(b,s,'B');f.page(archived,s,'Archive');f.app.store.updateProject(archived.id,{archived:true},archived.revision);
 const active=f.app.store.enqueueJob({projectId:archived.id,siteId:s.id,type:'site_check',idempotencyKey:'active-shared'});f.app.store.pauseJob(active.id);
 const first=await f.q('/check-pages',{});assert.equal(first.status,202);assert.deepEqual(first.projectIds.sort(),[a.id,b.id].sort());assert.equal(first.queued,3);assert.equal(first.reused,0);assert.equal(first.failed,0);assert.equal(first.jobs.length,3);const shared=first.jobs.find(j=>j.type==='site_check');assert.notEqual(shared.id,active.id);assert.equal(shared.projectId,a.id);assert.equal(f.app.store.getJob(active.id).state,'paused');
 const again=await f.q('/check-pages',{});assert.equal(again.queued,0);assert.equal(again.reused,3);assert.equal(again.jobs.length,3);
 const single=await f.q('/pages/'+pa.id+'/check',{});assert.equal(single.job.id,again.jobs.find(j=>j.pageId===pa.id).id);
 const chosen=await f.q('/projects/'+b.id+'/check-pages',{});assert.equal(chosen.queued,0);assert.equal(chosen.reused,2);assert.equal(chosen.pages[0].pageId,pb.id);assert.equal(chosen.jobs.find(j=>j.type==='site_check').id,shared.id);
 for(let i=0;i<4;i++)await f.app.tick();assert.equal(f.calls.filter(c=>c[0]==='site').length,1);assert.deepEqual(f.calls.filter(c=>c[0]==='page').map(c=>c[1]).sort(),[pa.id,pb.id].sort());assert.equal(f.app.store.getJob(shared.id).state,'completed');assert.equal(f.app.store.getJob(active.id).state,'paused');assert.equal(f.app.store.getPage(pa.id).verification.state,'ok');assert.equal(f.app.store.getPage(pb.id).verification.state,'ok');
});
test('one failed page remains unknown while another page completes and no automatic retry is scheduled',async t=>{
 const checked=[];const f=await fixture(t,{client:{checkSite:async()=>({state:'ok'}),checkPage:async({page})=>{checked.push(page.id);if(page.title==='Bad')throw Object.assign(Error('private failure'),{code:'network_error'});return ['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:kind==='noindex'?'problem':'ok',evidence:{source:kind==='noindex'?'meta':'fixture'}}));}}});
 const p=f.project(),s=f.site(p),bad=f.page(p,s,'Bad'),good=f.page(p,s,'Good');const result=await f.q('/projects/'+p.id+'/check-pages',{});assert.equal(result.queued,3);
 for(let i=0;i<4;i++)await f.app.tick();const jobs=f.app.store.listJobs(p.id);assert.equal(jobs.filter(j=>j.state==='failed').length,1);assert.equal(jobs.filter(j=>j.state==='completed').length,2);assert.equal(f.app.store.getPage(bad.id).verification.state,'unknown');assert.equal(f.app.store.getPage(good.id).verification.state,'problem');assert.equal(f.app.store.listChecks(good.id).find(c=>c.kind==='noindex').state,'problem');
 f.advance(40*86400000);await f.app.tick();assert.equal(checked.length,2);assert.equal(f.app.store.listJobs(p.id).length,3);
});
test('batch checks require same-origin explicit request and unknown project or fields cannot enqueue',async t=>{
 const f=await fixture(t),p=f.project(),s=f.site(p);f.page(p,s);assert.equal((await f.q('/check-pages',{}, {Origin:'https://elsewhere.example'})).status,403);assert.equal((await f.q('/check-pages',{automatic:true})).status,400);assert.equal((await f.q('/projects/missing/check-pages',{})).status,404);assert.equal(f.app.store.listJobs(p.id).length,0);
});

test('legacy scheduled checks are paused on restart and do not swallow a new explicit request',async t=>{
 const f=await fixture(t),p=f.project(),s=f.site(p),page=f.page(p,s);
 const old=f.app.store.enqueueJob({projectId:p.id,siteId:s.id,pageId:page.id,type:'page_check',idempotencyKey:'monitor:page_check:'+page.id+':0'});
 await f.app.tick();assert.equal(f.calls.length,0);assert.equal(f.app.store.getJob(old.id).state,'paused');
 const result=await f.q('/projects/'+p.id+'/check-pages',{});assert.equal(result.queued,2);assert.equal(result.reused,0);assert.notEqual(result.pages[0].jobId,old.id);
 await f.app.tick();await f.app.tick();assert.equal(f.calls.filter(c=>c[0]==='page').length,1);assert.equal(f.app.store.getJob(old.id).state,'paused');
});

test('an explicit check resumes paused requested read work instead of leaving a restored page stuck',async t=>{
 const f=await fixture(t),p=f.project(),s=f.site(p),page=f.page(p,s),job=f.app.store.enqueueJob({projectId:p.id,siteId:s.id,pageId:page.id,type:'page_check',idempotencyKey:'requested-before-recovery'});f.app.store.pauseJob(job.id);
 const result=await f.q('/pages/'+page.id+'/check',{});assert.equal(result.job.id,job.id);assert.equal(result.job.state,'queued');await f.app.tick();assert.equal(f.calls.filter(c=>c[0]==='page').length,1);
});
test('a restored disabled site is checked before its pages, while ordinary disabled sites stay skipped',async t=>{
 const f=await fixture(t),p=f.project(),restored=f.site(p,'restored.example'),disabled=f.site(p,'disabled.example'),page=f.page(p,restored),other=f.page(p,disabled);
 f.app.store.updateSite(restored.id,{enabled:false,bootstrap:{restored:true}},restored.revision);f.app.store.updateSite(disabled.id,{enabled:false},disabled.revision);
 const result=await f.q('/projects/'+p.id+'/check-pages',{});assert.equal(result.queued,2);assert.equal(result.skipped,1);assert.deepEqual(result.jobs.map(job=>job.type),['site_check','page_check']);assert.equal(result.jobs[1].pageId,page.id);assert.equal(result.pages.find(entry=>entry.pageId===other.id).reason,'site_disabled');assert.equal(f.app.store.getSite(restored.id).enabled,false);assert.equal(f.calls.length,0,'Click only queues; successful worker verification is required before enabling a restored site');
});

test('already accepted queued checks from an archived shared-site owner remain reusable',async t=>{
 const f=await fixture(t),owner=f.project('Archived owner'),active=f.project('Active'),s=f.site(owner);f.app.store.attachSite(active.id,s.id);const page=f.page(active,s);const accepted=f.app.store.enqueueJob({projectId:owner.id,siteId:s.id,type:'site_check',idempotencyKey:'already-accepted'});f.app.store.updateProject(owner.id,{archived:true},owner.revision);
 const result=await f.q('/projects/'+active.id+'/check-pages',{});assert.equal(result.failed,0);assert.equal(result.queued,1);assert.equal(result.reused,1);assert.equal(result.jobs.find(j=>j.type==='site_check').id,accepted.id);await f.app.tick();await f.app.tick();assert.equal(f.calls.filter(c=>c[0]==='site').length,1);assert.equal(f.app.store.getJob(accepted.id).state,'completed');assert.equal(f.app.store.getPage(page.id).verification.state,'ok');
});
