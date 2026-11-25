const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const KEY=Buffer.alloc(32,7).toString('base64');
async function setup(t,extra={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-service-'));const {createLifecycleService}=await import('../server/lifecycle/service.mjs');const app=await createLifecycleService({dataDir:dir,masterKey:KEY,browserVerifier:{verifyPublished:async()=>({state:'unknown',scope:'public-snapshot',viewports:[]})},client:{checkSite:async()=>({state:'ok',capabilities:{edit:true},checks:[]}),checkPage:async()=>[{kind:'public',state:'ok',evidence:'HTTP 200'}]},...extra});t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});const req=async(route,body,method=body?'POST':'GET',headers={})=>{const response=await app.handle(new Request('http://127.0.0.1:4317/api/lifecycle'+route,{method,headers:{Origin:'http://127.0.0.1:4317','Content-Type':'application/json','X-PagePoster-Request':'1',...headers},...(body?{body:JSON.stringify(body)}:{})}));return{status:response.status,body:await response.json()};};return{app,req,dir};}
test('project/page survives reopening and revision conflict keeps prior data',async t=>{const {app,req,dir}=await setup(t);const p=(await req('/projects',{name:'Проєкт',language:'pl'})).body.project;assert.ok(p.id);const page=(await req('/projects/'+p.id+'/pages',{title:'Точна сторінка',config:{title:'Точна сторінка',cards:[],sections:[],faq:[]}})).body.page;const saved=await req('/pages/'+page.id,{title:'Нова',expectedRevision:page.revision},'PATCH');assert.equal(saved.status,200);assert.equal((await req('/pages/'+page.id,{title:'Стара',expectedRevision:page.revision},'PATCH')).status,409);await app.close();const {createLifecycleService}=await import('../server/lifecycle/service.mjs');const reopened=await createLifecycleService({dataDir:dir,masterKey:KEY});assert.equal(reopened.store.getPage(page.id).title,'Нова');await reopened.close();});
test('cross-origin, missing custom header and unknown fields cannot mutate',async t=>{const {req}=await setup(t);assert.equal((await req('/projects',{name:'A'},'POST',{Origin:'https://evil.example'})).status,403);assert.equal((await req('/projects',{name:'A'},'POST',{'X-PagePoster-Request':''})).status,403);assert.equal((await req('/projects',{name:'A',ownerId:'other'})).status,400);assert.equal((await req('/projects')).body.projects.length,0);});
test('credentials never appear in responses/backups and bad site stays isolated',async t=>{const {app,req}=await setup(t,{client:{checkSite:async s=>{if(s.baseUrl.includes('bad'))throw Error('secret-pass-secret');return {state:'ok',capabilities:{edit:true}};}}});const p=(await req('/projects',{name:'P'})).body.project;for(const host of ['bad.example','good.example']){const site=(await req('/projects/'+p.id+'/sites',{baseUrl:'https://'+host,name:host,username:'private-user',applicationPassword:'secret-pass-secret'})).body.site;assert.ok(site.hasCredential);assert.ok(!JSON.stringify(site).includes('secret-pass-secret'));await req('/sites/'+site.id+'/check',{});}
await app.tick({schedule:false});await app.tick({schedule:false});const jobs=(await req('/projects/'+p.id+'/jobs')).body.jobs;assert.equal(jobs.filter(j=>j.state==='failed').length,1);assert.equal(jobs.filter(j=>j.state==='completed').length,1);const backup=JSON.stringify((await req('/backup')).body);assert.ok(!backup.includes('secret-pass-secret'));assert.ok(!JSON.stringify(jobs).includes('secret-pass-secret'));});
test('requested checks run in the worker once, without creating a recurring schedule',async t=>{let calls=0;const {app,req}=await setup(t,{client:{checkSite:async()=>({state:'ok'}),checkPage:async()=>{calls++;return[{kind:'public',state:'ok',evidence:'200'}];}}});const p=(await req('/projects',{name:'Monitor'})).body.project;const site=(await req('/projects/'+p.id+'/sites',{name:'Site',baseUrl:'https://example.com'})).body.site;const page=(await req('/projects/'+p.id+'/pages',{title:'Imported',siteId:site.id,fullUrl:'https://example.com/post/',wpId:17})).body.page;await app.tick();assert.equal(calls,0);await req('/pages/'+page.id+'/check',{});await app.tick();await app.tick();assert.equal(calls,1);assert.equal((await req('/pages/'+page.id+'/checks')).body.checks.filter(c=>c.kind==='public').length,1);});
test('restored read-only page registration rejects another site origin',async t=>{const {req}=await setup(t);const p=(await req('/projects',{name:'P'})).body.project;const site=(await req('/projects/'+p.id+'/sites',{name:'Site',baseUrl:'https://example.com'})).body.site;assert.equal((await req('/projects/'+p.id+'/pages',{title:'Wrong',siteId:site.id,fullUrl:'https://elsewhere.example/x'})).status,400);});

test('metadata editing works without encryption but credential storage is refused',async t=>{const {req}=await setup(t,{masterKey:null});const p=(await req('/projects',{name:'No key'})).body.project;assert.ok(p.id);const result=await req('/projects/'+p.id+'/sites',{name:'WP',baseUrl:'https://example.com',username:'user',applicationPassword:'pass'});assert.equal(result.status,400);assert.equal(result.body.code,'KEY_REQUIRED');assert.equal((await req('/projects/'+p.id+'/sites')).body.sites.length,0);});


test('project overview exposes latest check per kind and includes pages without checks',async t=>{
 const {app,req}=await setup(t);const p=(await req('/projects',{name:'Overview'})).body.project;
 const page=(await req('/projects/'+p.id+'/pages',{title:'New'})).body.page;
 let result=await req('/projects/'+p.id+'/overview');assert.equal(result.status,200);assert.equal(result.body.pages[0].pageId,page.id);assert.deepEqual(result.body.pages[0].checks,[]);
 app.store.addCheck(page.id,{kind:'noindex',state:'problem',evidence:'old'});app.store.addCheck(page.id,{kind:'noindex',state:'ok',evidence:'new'});app.store.addCheck(page.id,{kind:'public',state:'unknown',evidence:'timeout'});
 result=await req('/projects/'+p.id+'/overview');assert.equal(result.body.pages[0].checks.length,2);assert.equal(result.body.pages[0].checks.find(c=>c.kind==='noindex').state,'ok');assert.ok(result.body.pages[0].checks.every(c=>!('evidence' in c)));assert.deepEqual(result.body.runs,[]);
 assert.equal((await req('/projects/does-not-exist/overview')).status,404);
});

test('site readiness requires fresh Bridge package checksums beyond plugin version strings',async t=>{
 let verified=false,calls=0;const plugins=()=>({bridge:{state:'active',version:'0.2.1',compatible:true},cleanLinks:{state:'active',version:'1.1.1',compatible:true}});
 const {app,req}=await setup(t,{client:{checkSite:async()=>({state:'ok',apiRoot:'https://example.com/wp-json/',plugins:plugins()})},bridgeClient:{checkStatus:async()=>{calls++;return {ready:verified,integrityVerified:verified,integrity:{bridge:verified,cleanLinks:verified},cleanLinksActive:true};}}});
 const p=(await req('/projects',{name:'Integrity'})).body.project,site=(await req('/projects/'+p.id+'/sites',{name:'WP',baseUrl:'https://example.com',username:'user',applicationPassword:'fixture-pass'})).body.site;
 await req('/sites/'+site.id+'/check',{});await app.tick({schedule:false});let actual=app.store.getSite(site.id);assert.equal(calls,1);assert.equal(actual.status,'setup_required');assert.equal(actual.plugins.bridge.integrityVerified,false);assert.equal(actual.plugins.bridge.compatible,false);assert.equal(actual.bootstrap.state,'checksum_required');
 verified=true;await req('/sites/'+site.id+'/check',{});await app.tick({schedule:false});actual=app.store.getSite(site.id);assert.equal(actual.status,'ok');assert.equal(actual.plugins.bridge.integrityVerified,true);assert.equal(actual.bootstrap.state,'ready');
});

test('explicit check-all revalidates restored sites before checking pages and never republishes them',async t=>{
 for(const integrityValid of [true,false])await t.test(integrityValid?'verified Bridge restores monitoring':'unverified Bridge leaves monitoring disabled',async t=>{
  const calls=[];let writes=0;
  const {app,req}=await setup(t,{
   client:{
    checkSite:async input=>{calls.push('site');assert.equal(input.applicationPassword,'restored-fixture-password');return{state:'ok',apiRoot:'https://restored.example/wp-json/',capabilities:{publishPages:true},plugins:{bridge:{state:'active',version:'0.1.0',compatible:true},cleanLinks:{state:'active',version:'1.1.1',compatible:true}}};},
    checkPage:async()=>{calls.push('page');return ['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'fixture'}));}
   },
   bridgeClient:{
    checkStatus:async()=>{calls.push('integrity');return{ready:true,integrityVerified:integrityValid,integrity:{bridge:integrityValid,cleanLinks:integrityValid},cleanLinksActive:true};},
    submitOperation:async()=>{writes++;throw Error('Monitoring must never publish or replace content.');}
   },
   browserVerifier:{verifyPublished:async()=>{calls.push('browser');return{state:'ok',viewports:[],evidence:{scope:'fixture'}};}}
  });
  const project=(await req('/projects',{name:'Restored completed project'})).body.project;
  const site=(await req('/projects/'+project.id+'/sites',{name:'Restored WP',baseUrl:'https://restored.example/',username:'restored-user',applicationPassword:'restored-fixture-password'})).body.site;
  const page=(await req('/projects/'+project.id+'/pages',{title:'Already published',siteId:site.id,fullUrl:'https://restored.example/existing-page/',wpId:71})).body.page;
  app.store.updateSite(site.id,{enabled:false,bootstrap:{state:'verification_required',restored:true}},site.revision);
  app.store.createRecord(project.id,'autopilot',{state:'completed',stage:'completed',pageId:page.id,siteId:site.id,links:[],error:null});
  await app.tick();assert.deepEqual(calls,[],'Restored connections wait for the explicit check action.');
  const queued=await req('/check-pages',{});
  assert.equal(queued.status,202);assert.equal(queued.body.skipped,0);
  assert.deepEqual(queued.body.jobs.map(job=>job.type),['site_check','page_check']);
  assert.ok(queued.body.jobs.every(job=>job.effect==='read'));
  await app.tick();
  assert.deepEqual(calls,['site','integrity'],'Access and package checks must finish before the page request.');
  let current=app.store.getSite(site.id);
  assert.equal(current.enabled,integrityValid);
  assert.equal(current.plugins.bridge.integrityVerified,integrityValid);
  assert.equal(current.bootstrap.state,integrityValid?'ready':'checksum_required');
  assert.equal(current.bootstrap.restored===true,!integrityValid);
  await app.tick();await app.tick();
  const jobs=app.store.listJobs(project.id);
  assert.equal(jobs.find(job=>job.type==='site_check').state,'completed');
  assert.equal(jobs.find(job=>job.type==='page_check').state,integrityValid?'completed':'queued');
  assert.deepEqual(calls,integrityValid?['site','integrity','page','browser']:['site','integrity']);
  if(integrityValid)assert.equal(app.store.getPage(page.id).verification.state,'ok');
  assert.equal(app.store.getPage(page.id).wpId,71);
  assert.equal(app.store.getPage(page.id).fullUrl,'https://restored.example/existing-page/');
  assert.equal(writes,0);assert.ok(jobs.every(job=>job.effect==='read'));
  assert.equal(app.store.listRecords(project.id,'autopilot')[0].state,'completed');
 });
});


test('restored-site claim exception admits only access reads and never page reads or writes',async t=>{
 const {app}=await setup(t),s=app.store;
 const project=s.createProject({name:'Restore queue gate'});
 const site=s.createSite(project.id,{name:'Restored',baseUrl:'https://restored.example/',username:'user',applicationPassword:'fixture'});
 const page=s.createPage(project.id,{title:'Existing',siteId:site.id,wpId:19,fullUrl:'https://restored.example/existing/'});
 s.updateSite(site.id,{enabled:false,bootstrap:{restored:true}},site.revision);
 const write=s.enqueueJob({projectId:project.id,siteId:site.id,pageId:page.id,type:'publish',idempotencyKey:'restored-write',payload:{}});
 const pageRead=s.enqueueJob({projectId:project.id,siteId:site.id,pageId:page.id,type:'page_check',idempotencyKey:'restored-page-read'});
 const access=s.enqueueJob({projectId:project.id,siteId:site.id,type:'site_check',idempotencyKey:'restored-access-read'});
 const claimed=s.claimJob({workerId:'fixture-worker',leaseMs:10000});
 assert.equal(claimed.id,access.id);assert.equal(claimed.effect,'read');
 s.finishJob(claimed.id,claimed.leaseToken,{state:'completed'});
 assert.equal(s.claimJob({workerId:'fixture-worker',leaseMs:10000}),null);
 assert.equal(s.getJob(write.id).state,'queued');assert.equal(s.getJob(pageRead.id).state,'queued');
 const ordinary=s.createSite(project.id,{name:'Manually disabled',baseUrl:'https://disabled.example/'});
 s.updateSite(ordinary.id,{enabled:false},ordinary.revision);
 const ordinaryRead=s.enqueueJob({projectId:project.id,siteId:ordinary.id,type:'site_check',idempotencyKey:'ordinary-disabled'});
 assert.equal(s.claimJob({workerId:'fixture-worker',leaseMs:10000}),null);
 assert.equal(s.getJob(ordinaryRead.id).state,'queued');
});
test('source draft and per-project site selection work through the strict HTTP contract without network reads',async t=>{
 let reads=0;const {req,app}=await setup(t,{autopilotOptions:{source:{readCandidates:async()=>{reads++;return {candidates:[],issues:[]};},pickUnused:async()=>{reads++;return null;}}}});
 const made=await req('/projects',{name:'Criteria',description:'Keep',siteSelection:{minDr:20,minTraffic:500,geo:'pl,ua'}});assert.equal(made.status,201);const project=made.body.project;assert.deepEqual(project.siteSelection,{minDr:20,minTraffic:500,geo:'PL,UA'});
 const saved=await req('/projects/'+project.id,{expectedRevision:project.revision,siteSelection:{minDr:30,minTraffic:null,geo:''}},'PATCH');assert.equal(saved.status,200);assert.equal(saved.body.project.description,'Keep');assert.equal((await req('/projects/'+project.id,{expectedRevision:saved.body.project.revision,siteSelection:{unknown:true}},'PATCH')).status,400);
 const draft=await req('/autopilot/source',{spreadsheetId:'fixtureSheetId12345',range:"'ДЛЯ ПІДБОРУ'!B:O",headerRows:1,columns:{url:'B',username:'K',password:'L',alternateUsername:'N',alternatePassword:'O',dr:'D',traffic:'E',geo:'F'}});assert.equal(draft.status,200);assert.equal(draft.body.source.configured,false);assert.equal(draft.body.source.range,"'ДЛЯ ПІДБОРУ'!B:O");assert.equal((await req('/autopilot/source/check',{projectId:project.id})).status,400);assert.equal(reads,0);assert.equal(app.store.listRecords(project.id,'autopilot').length,0);
});
test('source check and selecting runs expose actionable bounded-source errors without private diagnostics',async t=>{
 const cases=[['source_limit_exceeded',/100\s?000/],['source_auth_failed',/Google/],['source_read_failed',/таблиц|таблицю|таблиці/],['source_validation',/колон|стовп|діапаз|диапаз/]];
 for(const [code,expected] of cases){
  const fail=async()=>{throw Object.assign(Error('private fixture diagnostic'),{code});};const {req,app}=await setup(t,{autopilotOptions:{source:{readCandidates:fail,pickUnused:fail}}});const project=(await req('/projects',{name:'Source errors'})).body.project;await req('/autopilot/source',{spreadsheetId:'fixtureSheet123456',range:'A1:C100',columns:{url:'A',username:'B',password:'C'},serviceAccount:{clientEmail:'test@fixture.example',privateKey:'fixture-key'}});
  const result=await req('/autopilot/source/check',{projectId:project.id});assert.equal(result.status,400);assert.equal(result.body.code,code);assert.match(result.body.error,expected);assert.doesNotMatch(result.body.error,/private fixture diagnostic/);
  const input={source:'html',html:'<html><head><title>Fixture</title></head><body><h1>Fixture</h1></body></html>'},preview=(await req('/autopilot/preview',input)).body,run=(await req('/projects/'+project.id+'/autopilot',{...input,idempotencyKey:require('node:crypto').randomUUID(),reviewToken:preview.reviewToken})).body.run;await app.tick();await app.tick();const saved=app.autopilot.list(project.id).find(x=>x.id===run.id);assert.equal(saved.error.code,code);assert.match(saved.error.message,expected);assert.doesNotMatch(saved.error.message,/private fixture diagnostic/);
 }
});
