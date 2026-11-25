const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const G=require('../dist/generator.js');
const links=[{url:'https://destination.example/?a=%2f&b=1#keep',anchor:'Точный анкор | [пример]'}];
const sourceConfig={spreadsheetId:'fixtureSheetId12345',range:'Sites!A1:D100',serviceAccount:{client_email:'test@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----fixture-----END PRIVATE KEY-----'},columns:{url:'A',username:'B',password:'C',enabled:'D'}};
async function fixture(t,options={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),{bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-autopilot-'));let generated=0,installed=0,writes=0,checkCalls=0;
 const planner={generate:async input=>{generated++;options.capture?.(input);if(options.delay)await options.delay();if(options.failAI)throw Object.assign(Error(),{code:'AI_RESULT_UNCERTAIN',uncertain:true});return {config:{...G.DEFAULT_DATA,title:'AI creates this title',brand:'AI guide',language:'ru',cards:input.links.map(l=>({name:l.anchor,url:l.url,logoUrl:l.url,button:'Открыть',bonus:'Описание ИИ',rating:''})),sections:[{title:'AI section',body:'AI article'}],moreCards:[],tiles:[],services:[],reviews:[],faq:[],navLinks:[],brandUrl:input.links[0].url,footerBrandUrl:input.links[0].url,colors:{background:'#F5F9FA',header:'#112233',card:'#123456',accent:'#ffcc55'}},topic:'AI topic',quality:{state:'passed',generatedTextFingerprint:crypto.createHash('sha256').update(input.requestId).digest('hex')}};}};
 const source={pickUnused:async(config,used)=>{assert.equal(config.serviceAccount.clientEmail,sourceConfig.serviceAccount.client_email);return options.noSites?null:{id:'sheet:row2',baseUrl:'https://fixture-wordpress.example/',username:'fixture-user',password:'fixture-admin-secret',rowNumber:2};}};
 const bootstrapFactory=({checkpoint})=>({ensureReady:async args=>{installed++;if(options.rejectLogin&&args.password==='wrong-password')throw Object.assign(Error(),{code:'bootstrap_auth_failed',state:'needs_attention',loginRejectedBeforeWrites:true});assert.equal(args.password,'fixture-admin-secret');await checkpoint({operationId:args.operationId,stage:'credential_created',credential:{username:'fixture-user',applicationPassword:'fixture-api-secret'}});if(options.bootstrapStop)throw Object.assign(Error(),{code:'bootstrap_two_factor',state:'needs_attention'});return {state:'ready',username:'fixture-user',applicationPassword:'fixture-api-secret'};}});
 const bridge={checkStatus:async()=>({ready:true,integrityVerified:true,integrity:{bridge:true,cleanLinks:true}}),getOperation:async({operationId})=>({state:'not_found',operationId}),submitOperation:async({operation})=>{writes++;if(options.failWriteOnce&&writes===1)throw Object.assign(Error(),{code:'authentication_failed'});return {state:'completed',postId:71,postType:'page',status:'publish',contentHash:bridgeContentHash(operation),url:'https://fixture-wordpress.example/new-page/'};}};
 const runtimeOptions={visibleBrowser:options.visibleBrowser,dataDir:dir,masterKey:Buffer.alloc(32,29).toString('base64'),bridgeClient:bridge,autopilotOptions:{planner,source,bootstrapFactory},browserVerifier:{verifyGenerated:async()=>{options.beforeVerify?.();return {layoutState:'ok',viewports:[]};},verifyPublished:async()=>({state:options.unknownCheck?'unknown':'ok',viewports:[],evidence:'fixture'})},client:{checkSite:async()=>({state:'ok',apiRoot:'https://fixture-wordpress.example/wp-json/',capabilities:{publishPages:true},plugins:{bridge:{compatible:true},cleanLinks:{compatible:true}}}),checkPage:async()=>{checkCalls++;return ['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'fixture'}));}}};
 let service=await createLifecycleService(runtimeOptions);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});const project=service.store.createProject({name:'Fixture project'});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost:4317/api/lifecycle'+route,{method:body?'POST':'GET',headers:{Origin:'http://localhost:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));return {status:response.status,...await response.json()};};
 return {get a(){return service;},q,project,dir,counters:()=>({generated,installed,writes,checkCalls}),restart:async()=>{await service.close();service=await createLifecycleService(runtimeOptions);},launch:async()=>q('/projects/'+project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links})};
}
test('saved errors from older builds use the current Ukrainian message without changing the record',async t=>{
 const f=await fixture(t),launch=await f.launch(),saved=f.a.store.getRecord(launch.run.id);
 const legacy={code:'BROWSER_TIMEOUT',message:'WordPress не завершил действие в отведённое время. Проверьте открытое окно.'};
 f.a.store.updateRecord(saved.id,{state:'needs_attention',error:legacy},saved.revision);
 const visible=f.a.autopilot.list(f.project.id).find(run=>run.id===saved.id);
 assert.equal(visible.error.code,'BROWSER_TIMEOUT');
 assert.equal(visible.error.message,'WordPress не завершив дію за відведений час. Перевірте відкрите вікно.');
 assert.deepEqual(f.a.store.getRecord(saved.id).error,legacy);
 assert.equal(f.counters().writes,0);
});

test('links-only launch saves generated HTML before missing source and continues after connecting',async t=>{const f=await fixture(t),launch=await f.launch();assert.equal(launch.status,202);await f.a.tick();await f.a.tick();let r=f.a.autopilot.list(f.project.id)[0];assert.equal(r.state,'waiting_source');assert.equal(f.counters().generated,1);assert.equal(f.counters().writes,0);const html=await f.q('/autopilot/'+r.id+'/html');assert.match(html.html,/AI creates this title/);assert.match(html.html,/%2f/);await f.restart();assert.equal(f.a.autopilot.list(f.project.id)[0].state,'waiting_source');assert.equal((await f.q('/autopilot/source',sourceConfig)).status,200);for(let i=0;i<8;i++)await f.a.tick();r=f.a.autopilot.list(f.project.id)[0];assert.equal(r.state,'completed');assert.equal(r.fullUrl,'https://fixture-wordpress.example/new-page/');assert.equal(f.counters().generated,1);assert.equal(f.counters().installed,1);assert.equal(f.counters().writes,1);assert.equal(f.counters().checkCalls,1);});
test('launch replay is exact and conflicting payload never creates another page',async t=>{const f=await fixture(t),id=crypto.randomUUID(),body={idempotencyKey:id,links};const a=await f.q('/projects/'+f.project.id+'/autopilot',body),b=await f.q('/projects/'+f.project.id+'/autopilot',body);assert.equal(a.run.id,b.run.id);assert.equal((await f.q('/projects/'+f.project.id+'/autopilot',{...body,links:[{...links[0],anchor:'changed'}]})).status,409);await f.a.tick();assert.equal(f.a.store.listPages(f.project.id).length,1);});

test('editorial launches allocate durable distinct variants across projects without consuming one on replay',async t=>{
 const captured=[],f=await fixture(t,{capture:input=>captured.push(input)});
 const body={idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true,editorial:{format:'article',topic:'casino',language:'en'}};
 const first=await f.q('/projects/'+f.project.id+'/autopilot',body);
 await f.q('/projects/'+f.project.id+'/autopilot',body);
 const other=f.a.store.createProject({name:'Second project'});
 const second=await f.q('/projects/'+other.id+'/autopilot',{...body,idempotencyKey:crypto.randomUUID()});
 assert.equal(f.a.store.getRecord(first.run.id).editorialVariant,0);
 assert.equal(f.a.store.getRecord(second.run.id).editorialVariant,1);
 await f.restart();await f.a.tick();await f.a.tick();
 assert.equal(captured.length,2);assert.match(captured[0].variation,/^editorial-v2:0:/);assert.match(captured[1].variation,/^editorial-v2:1:/);
 assert.equal(f.counters().writes,0);
});
test('uncertain paid generation cannot be silently retried',async t=>{const f=await fixture(t,{failAI:true});const {run}=await f.launch();await f.a.tick();assert.equal(f.a.autopilot.list(f.project.id)[0].state,'uncertain');assert.equal((await f.q('/autopilot/'+run.id+'/resume',{})).status,400);await f.a.tick();assert.equal(f.counters().generated,1);});

const manualSite={baseUrl:'https://fixture-wordpress.example/wp-admin/',username:'fixture-user',password:'fixture-admin-secret'};
test('stopped setup can change donor while retaining the same generated page and credential-free target history',async t=>{
 const f=await fixture(t,{bootstrapStop:true});await f.q('/autopilot/source',sourceConfig);const {run}=await f.launch();for(let i=0;i<3;i++)await f.a.tick();
 const stopped=f.a.autopilot.list(f.project.id)[0],before=await f.q('/autopilot/'+run.id+'/html'),page=f.a.store.getPage(stopped.pageId);
 assert.equal(stopped.canSetDestination,true);
 const changed=await f.q('/autopilot/'+run.id+'/destination',{...manualSite,baseUrl:'https://replacement.example/',expectedRevision:0});assert.equal(changed.status,200);assert.equal(changed.run.pageId,stopped.pageId);assert.equal(changed.run.stage,'selecting');assert.equal(changed.run.state,'awaiting_review');
 const raw=f.a.store.getRecord(run.id);for(const key of ['candidate','candidateCredential','alternateCredential','apiCredential','bootstrapStage','siteId','jobId','publicationApproval'])assert.equal(raw[key],null,key);
 assert.equal(raw.destinationHistory[0].baseUrl,'https://fixture-wordpress.example/');assert.doesNotMatch(JSON.stringify(raw.destinationHistory),/fixture-admin-secret|fixture-api-secret|Credential|password/);
 assert.deepEqual(f.a.store.getPage(stopped.pageId),page);assert.equal((await f.q('/autopilot/'+run.id+'/html')).html,before.html);assert.equal(f.counters().generated,1);
 assert.equal((await f.q('/autopilot/'+run.id+'/destination',{...manualSite,expectedRevision:0})).status,409);
 assert.equal((await f.q('/autopilot/'+run.id+'/approve',{reviewToken:before.reviewToken||'stale'})).status,400);
 await f.a.tick();assert.equal(f.counters().writes,0);
});
test('browser preference persists and approval prepares the selected isolated mode before returning',async t=>{
 const prepared=[],browser={...visibleFixture(),prepare:async(id,options)=>prepared.push({id,...options})},f=await fixture(t,{visibleBrowser:browser});
 assert.equal((await f.q('/autopilot/status')).browserMode,'visible');
 const body={idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true},visible=await f.q('/projects/'+f.project.id+'/autopilot',body);await f.a.tick();
 assert.equal((await f.q('/autopilot/browser-settings',{mode:'hidden'})).status,200);await f.restart();assert.equal((await f.q('/autopilot/status')).browserMode,'hidden');
 const hidden=await f.q('/projects/'+f.project.id+'/autopilot',{...body,idempotencyKey:crypto.randomUUID()});await f.a.tick();
 for(const [run,headless] of [[visible.run,false],[hidden.run,true]]){const preview=await f.q('/autopilot/'+run.id+'/html');const result=await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken});assert.equal(result.status,202);assert.equal(result.run.browserMode,headless?'hidden':'visible');assert.deepEqual(prepared.at(-1),{id:run.id,headless});assert.equal(result.run.browserWindow,true);}
 assert.equal((await f.q('/autopilot/'+hidden.run.id+'/browser',{})).status,400);
});
test('browser launch failure retains approval and resumes without another approval',async t=>{
 const browser={...visibleFixture(),prepare:async()=>{throw Object.assign(Error('launch failed'),{code:'BROWSER_UNAVAILABLE'});}},f=await fixture(t,{visibleBrowser:browser}),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();
 const preview=await f.q('/autopilot/'+run.id+'/html'),approved=await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken});assert.equal(approved.status,202);assert.equal(approved.run.state,'needs_attention');assert.equal(approved.run.error.code,'BROWSER_UNAVAILABLE');assert.ok(f.a.store.getRecord(run.id).publicationApproval);
 assert.equal((await f.q('/autopilot/'+run.id+'/resume',{})).status,202);assert.equal(f.counters().generated,1);
});
test('approval holds dispatch while opening the browser and duplicate approval does not reopen it',async t=>{
 let release,entered;const started=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);let openings=0;
 const browser={...visibleFixture(),prepare:async()=>{openings++;entered();await hold;}},f=await fixture(t,{visibleBrowser:browser}),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();await f.q('/autopilot/'+run.id+'/destination',manualSite);const preview=await f.q('/autopilot/'+run.id+'/html');
 const approving=f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken});await started;
 try{await f.a.tick();assert.equal(f.a.store.getRecord(run.id).stage,'selecting');assert.equal((await f.q('/autopilot/'+run.id+'/destination',manualSite)).status,409);assert.equal((await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken})).status,202);assert.equal(openings,1);}finally{release();await approving;}
});
test('interrupted browser preparation does not strand an approved run after its lease expires',async t=>{
 const f=await fixture(t),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();await f.q('/autopilot/'+run.id+'/destination',manualSite);const preview=await f.q('/autopilot/'+run.id+'/html');await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken});const saved=f.a.store.getRecord(run.id);
 f.a.store.updateRecord(run.id,{browserPreparing:true,browserPreparingUntil:'2000-01-01T00:00:00.000Z'},saved.revision);await f.restart();await f.a.autopilot.tick();assert.equal(f.a.store.getRecord(run.id).stage,'installing');assert.equal(f.a.store.getRecord(run.id).browserPreparing,false);
});
test('donor change blocks queued, leased and uncertain writes and retires only proven unattempted writes',async t=>{
 for(const outcome of ['queued','running','uncertain','failed','unattempted'])await t.test(outcome,async t=>{
  const f=await fixture(t);await f.q('/autopilot/source',sourceConfig);const {run}=await f.launch();for(let i=0;i<4;i++)await f.a.autopilot.tick();let raw=f.a.store.getRecord(run.id);const jobId=raw.jobId;assert.ok(jobId);
  let job=f.a.store.getJob(jobId);if(outcome!=='queued'){job=f.a.store.claimJob({workerId:'test',leaseMs:60000});if(outcome!=='running')f.a.store.finishJob(job.id,job.leaseToken,{state:outcome==='uncertain'?'uncertain':'failed',error:{code:'CONFLICT'},...(outcome==='unattempted'?{result:{writeNotAttempted:true}}:{})});}
  f.a.store.updateRecord(run.id,{state:'needs_attention',error:{code:'CONFLICT'}},raw.revision);
  const before=await f.q('/autopilot/'+run.id+'/html'),changed=await f.q('/autopilot/'+run.id+'/destination',{...manualSite,baseUrl:'https://next.example/'});
  assert.equal(changed.status,outcome==='unattempted'?200:409);
  if(outcome==='unattempted'){assert.equal(changed.run.pageId,raw.pageId);assert.equal((await f.q('/autopilot/'+run.id+'/html')).html,before.html);assert.equal(f.a.store.getPage(raw.pageId).siteId,null);assert.throws(()=>f.a.autopilot.beforeRemoteWrite({...job,attempt:1}),error=>error.code==='CONFLICT'&&error.writeNotAttempted===true);assert.equal(f.a.store.getJob(jobId).state,'failed');}
  else assert.ok(f.a.autopilot.list(f.project.id)[0].destinationBlockedReason);
  assert.equal(f.counters().writes,0);assert.equal(f.counters().generated,1);
 });
});
function visibleFixture(){const calls=[];let closed=false;const session={transport:async()=>assert.fail('Injected bootstrap fixture should not use network'),status:async()=>{},login:async()=>{calls.push('login');},publication:async()=>{calls.push('publication');},markAuthenticated:()=>calls.push('authenticated')};return {calls,setClosed:()=>closed=true,open:async()=>{if(closed)throw Object.assign(Error('BROWSER_CLOSED'),{code:'BROWSER_CLOSED',state:'needs_attention'});calls.push('open');return session;},assertOpen:()=>{if(closed)throw Object.assign(Error('BROWSER_CLOSED'),{code:'BROWSER_CLOSED'});},focus:async()=>{},error:async()=>{},done:async()=>calls.push('done'),result:async()=>calls.push('result'),reset:async()=>{closed=false;calls.push('reset');},close:async()=>{}};}
test('visible mode opens only after approval and retains encrypted login until publication completes',async t=>{
 const browser=visibleFixture(),f=await fixture(t,{visibleBrowser:browser}),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();await f.q('/autopilot/'+run.id+'/destination',manualSite);
 assert.equal(browser.calls.includes('open'),false);const preview=await f.q('/autopilot/'+run.id+'/html');await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken});
 await f.a.tick();await f.a.tick();let saved=f.a.store.getRecord(run.id);assert.equal(saved.stage,'publishing');assert.ok(saved.candidateCredential?.ciphertext);assert.doesNotMatch(JSON.stringify(saved),/fixture-admin-secret/);
 for(let i=0;i<7;i++)await f.a.tick();assert.equal(f.counters().writes,1);assert.equal(f.a.autopilot.list(f.project.id)[0].state,'completed');assert.equal(f.a.store.getRecord(run.id).candidateCredential,null);assert.ok(browser.calls.includes('publication'));assert.ok(browser.calls.includes('result'));assert.ok(browser.calls.includes('done'));
});
test('closing the visible window during layout checks prevents remote dispatch and resume publishes once',async t=>{
 const browser=visibleFixture();let closeOnce=true;const f=await fixture(t,{visibleBrowser:browser,beforeVerify:()=>{if(closeOnce){closeOnce=false;browser.setClosed();}}}),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();await f.q('/autopilot/'+run.id+'/destination',manualSite);const preview=await f.q('/autopilot/'+run.id+'/html');await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken});
 for(let i=0;i<5;i++)await f.a.tick();assert.equal(f.counters().writes,0);const saved=f.a.autopilot.list(f.project.id)[0];assert.equal(saved.state,'needs_attention');assert.equal(saved.error.code,'BROWSER_CLOSED');
 assert.equal((await f.q('/autopilot/'+run.id+'/resume',{})).status,202);for(let i=0;i<8;i++)await f.a.tick();assert.equal(f.counters().writes,1);assert.equal(f.a.autopilot.list(f.project.id)[0].state,'completed');assert.equal(f.counters().generated,1);
});
test('manual destination persists encrypted and publishes only after fresh review without Google',async t=>{
 const f=await fixture(t),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();
 const before=await f.q('/autopilot/'+run.id+'/html');
 const saved=await f.q('/autopilot/'+run.id+'/destination',manualSite);assert.equal(saved.status,200);assert.equal(saved.run.selectedDomain,'https://fixture-wordpress.example/');assert.equal(saved.run.state,'awaiting_review');
 assert.doesNotMatch(JSON.stringify(saved),/fixture-user|fixture-admin-secret|Credential/);
 assert.doesNotMatch(JSON.stringify(f.a.store.getRecord(run.id)),/fixture-admin-secret/);
 await f.restart();await f.a.tick();assert.equal(f.counters().installed,0);assert.equal(f.counters().writes,0);
 assert.equal((await f.q('/autopilot/'+run.id+'/approve',{reviewToken:before.reviewToken})).status,400);
 const preview=await f.q('/autopilot/'+run.id+'/html');assert.equal((await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken})).status,202);
 for(let i=0;i<8;i++)await f.a.tick();const completed=f.a.autopilot.list(f.project.id)[0];assert.equal(completed.state,'completed',JSON.stringify(completed.error));assert.equal(f.counters().writes,1);assert.equal(f.counters().generated,1);
 assert.equal((await f.q('/autopilot/'+run.id+'/destination',manualSite)).status,409);
});
test('manual destination permits correcting a rejected password without regeneration or automatic writes',async t=>{
 const f=await fixture(t,{rejectLogin:true}),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();
 await f.q('/autopilot/'+run.id+'/destination',{...manualSite,password:'wrong-password'});
 let preview=await f.q('/autopilot/'+run.id+'/html');await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken});await f.a.tick();await f.a.tick();
 const rejected=f.a.autopilot.list(f.project.id)[0];assert.equal(rejected.state,'awaiting_review');assert.equal(rejected.error.code,'bootstrap_auth_failed');assert.equal(rejected.canSetDestination,true);assert.equal(f.counters().writes,0);
 await f.q('/autopilot/'+run.id+'/destination',manualSite);await f.a.tick();assert.equal(f.counters().writes,0);
 preview=await f.q('/autopilot/'+run.id+'/html');await f.q('/autopilot/'+run.id+'/approve',{reviewToken:preview.reviewToken});for(let i=0;i<8;i++)await f.a.tick();assert.equal(f.a.autopilot.list(f.project.id)[0].state,'completed');assert.equal(f.counters().generated,1);
});

test('manual destination accepts bare domains and WordPress admin URLs without changing the prepared page',async t=>{
 const f=await fixture(t),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();
 const before=await f.q('/autopilot/'+run.id+'/html'),pageId=f.a.autopilot.list(f.project.id)[0].pageId;
 for(const [baseUrl,expected] of [
  ['donor-workspace.example','https://donor-workspace.example/'],
  ['  www.manual.example  ','https://www.manual.example/'],
  ['manual.example/wp-admin/','https://manual.example/'],
  ['manual.example/blog/wp-login.php','https://manual.example/blog/'],
  ['manual.example:8443/blog/wp-admin/index.php','https://manual.example:8443/blog/'],
  ['https://manual.example/blog/','https://manual.example/blog/']
 ]){
  const saved=await f.q('/autopilot/'+run.id+'/destination',{...manualSite,baseUrl});assert.equal(saved.status,200,baseUrl);assert.equal(saved.run.selectedDomain,expected);assert.equal(saved.run.pageId,pageId);assert.equal(saved.run.state,'awaiting_review');
  assert.doesNotMatch(JSON.stringify(saved),/fixture-user|fixture-admin-secret/);
 }
 assert.equal((await f.q('/autopilot/'+run.id+'/html')).html,before.html);
 await f.a.tick();assert.equal(f.counters().generated,1);assert.equal(f.counters().installed,0);assert.equal(f.counters().writes,0);
});

test('manual destination rejects unsafe URLs, missing credentials and stale edits',async t=>{
 const f=await fixture(t),{run}=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();
 for(const baseUrl of ['http://fixture-wordpress.example/','https://127.0.0.1/','https://user:secret@fixture-wordpress.example/','https://fixture-wordpress.example/?token=secret','','localhost','127.0.0.1','192.168.0.1','user:secret@fixture-wordpress.example','fixture-wordpress.example/?token=secret','fixture-wordpress.example/#fragment','javascript://fixture-wordpress.example','ftp://fixture-wordpress.example','https:fixture-wordpress.example','fixture wordpress.example'])assert.equal((await f.q('/autopilot/'+run.id+'/destination',{...manualSite,baseUrl})).status,400,baseUrl);
 assert.equal((await f.q('/autopilot/'+run.id+'/destination',{...manualSite,password:''})).status,400);
 const revision=f.a.autopilot.list(f.project.id)[0].destinationRevision;
 assert.equal((await f.q('/autopilot/'+run.id+'/destination',{...manualSite,expectedRevision:revision})).status,200);
 assert.equal((await f.q('/autopilot/'+run.id+'/destination',{...manualSite,expectedRevision:revision})).status,409);
 assert.equal(f.counters().installed,0);assert.equal(f.counters().writes,0);
});
test('manual destination recovers a waiting-source HTML page and remains deletable',async t=>{
 const f=await fixture(t),input={source:'html',html:'<h1>Manual destination</h1><p>Content</p>',chromeMode:'overlay-only'};
 const preview=await f.q('/autopilot/preview',input);const {run}=await f.q('/projects/'+f.project.id+'/autopilot',{...input,idempotencyKey:crypto.randomUUID(),reviewToken:preview.reviewToken});await f.a.tick();await f.a.tick();
 assert.equal(f.a.autopilot.list(f.project.id)[0].state,'waiting_source');
 const saved=await f.q('/autopilot/'+run.id+'/destination',manualSite);assert.equal(saved.status,200);assert.equal(saved.run.reviewBeforePublish,true);assert.equal(saved.run.canDelete,true);
 await f.a.tick();assert.equal(f.counters().installed,0);assert.equal(f.counters().generated,0);
 assert.equal((await f.q('/autopilot/'+run.id+'/delete',{})).deleted,true);assert.equal(f.a.store.getRecord(run.id).manualCredential,null);
});

test('delete cancels an accidental queued launch durably without generating or resurrecting its identity',async t=>{
 const f=await fixture(t),body={idempotencyKey:crypto.randomUUID(),links};
 const {run}=await f.q('/projects/'+f.project.id+'/autopilot',body);assert.equal(run.canDelete,true);
 for(let i=0;i<2;i++)assert.equal((await f.q('/autopilot/'+run.id+'/delete',{})).deleted,true);
 await f.restart();await f.a.tick();assert.equal(f.counters().generated,0);assert.equal(f.a.autopilot.list(f.project.id).length,0);
 assert.equal((await f.q('/projects/'+f.project.id+'/autopilot',body)).status,404);
 assert.equal((await f.q('/autopilot/'+run.id+'/resume',{})).status,404);
});

test('delete removes a failed launch and a reviewed local draft without touching other runs',async t=>{
 const f=await fixture(t,{failAI:true}),{run:failed}=await f.launch();await f.a.tick();
 assert.equal(f.a.autopilot.list(f.project.id)[0].canDelete,true);
 assert.equal((await f.q('/autopilot/'+failed.id+'/delete',{})).deleted,true);
 const g=await fixture(t),body={idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true};
 const {run}=await g.q('/projects/'+g.project.id+'/autopilot',body);await g.a.tick();
 const draft=g.a.autopilot.list(g.project.id)[0],snapshot=await g.q('/autopilot/'+run.id+'/html');
 const other=await g.launch();assert.equal((await g.q('/autopilot/'+run.id+'/delete',{})).deleted,true);
 assert.equal(g.a.store.getPage(draft.pageId),null);assert.equal(g.a.store.listPages(g.project.id).length,0);
 assert.equal((await g.q('/autopilot/'+run.id+'/html')).status,404);
 assert.equal((await g.q('/autopilot/'+run.id+'/approve',{reviewToken:snapshot.reviewToken})).status,404);
 assert.deepEqual(g.a.autopilot.list(g.project.id).map(r=>r.id),[other.run.id]);assert.equal(g.counters().writes,0);
 await g.restart();assert.equal(g.a.store.getPage(draft.pageId),null);
});

test('delete rejects a running lease and any launch already associated with remote work',async t=>{
 let release,entered;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
 const f=await fixture(t,{delay:async()=>{entered();await hold;}}),{run}=await f.launch();
 const task=f.a.autopilot.tick();await ready;
 try{assert.equal((await f.q('/autopilot/'+run.id+'/delete',{})).status,409);}finally{release();await task;}
 const current=f.a.store.getRecord(run.id);f.a.store.updateRecord(run.id,{stage:'publishing',state:'failed',jobId:'pending-write'},current.revision);
 assert.equal(f.a.autopilot.list(f.project.id)[0].canDelete,false);
 assert.equal((await f.q('/autopilot/'+run.id+'/delete',{})).status,409);assert.equal(f.counters().writes,0);
});
test('source and bootstrap passwords are encrypted and absent from public runs',async t=>{const f=await fixture(t,{bootstrapStop:true});await f.q('/autopilot/source',sourceConfig);await f.launch();for(let i=0;i<3;i++)await f.a.tick();const runs=await f.q('/projects/'+f.project.id+'/autopilot');assert.equal(runs.runs[0].state,'needs_attention');assert.doesNotMatch(JSON.stringify(runs),/fixture-admin-secret|fixture-api-secret|candidateCredential|apiCredential/);assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'autopilot-source.json'),'utf8'),/PRIVATE KEY|fixtureSheetId|client_email/);const raw=f.a.store.getRecord(runs.runs[0].id);assert.ok(raw.candidateCredential.ciphertext);assert.ok(raw.apiCredential.ciphertext);assert.equal(f.counters().writes,0);});
test('unknown public/browser check never marks publication as completed',async t=>{const f=await fixture(t,{unknownCheck:true});await f.q('/autopilot/source',sourceConfig);await f.launch();for(let i=0;i<8;i++)await f.a.tick();assert.equal(f.a.autopilot.list(f.project.id)[0].state,'needs_attention');assert.equal(f.counters().writes,1);});
test('there is no fallback to a manual site when table has no candidate',async t=>{const f=await fixture(t,{noSites:true});await f.q('/autopilot/source',sourceConfig);await f.launch();await f.a.tick();await f.a.tick();assert.equal(f.a.autopilot.list(f.project.id)[0].error.code,'SOURCE_EMPTY');assert.equal(f.counters().installed,0);assert.equal(f.counters().writes,0);});

test('persistent run lease prevents two runtime instances from paying or processing the same launch',async t=>{
 let release,entered;const entry=new Promise(r=>entered=r),hold=new Promise(r=>release=r);const f=await fixture(t,{delay:async()=>{entered();await hold;}});await f.launch();const first=f.a.autopilot.tick();await entry;
 const {createAutopilot}=await import('../server/lifecycle/autopilot.mjs');const second=await createAutopilot({store:f.a.store,dataDir:f.dir,masterKey:Buffer.alloc(32,29).toString('base64'),planner:{generate:async()=>{assert.fail('second runtime must not dispatch');}}});
 try{assert.equal(await second.tick(),null);assert.equal(f.counters().generated,1);}finally{release();await first;}
 assert.equal(f.a.store.listPages(f.project.id).length,1);
});
test('failed publication resumes through verified absent remote ledger using the same operation',async t=>{
 const f=await fixture(t,{failWriteOnce:true});await f.q('/autopilot/source',sourceConfig);const {run}=await f.launch();for(let i=0;i<6;i++)await f.a.tick();let saved=f.a.autopilot.list(f.project.id)[0];assert.equal(saved.state,'needs_attention');const jobId=saved.jobId;assert.equal(f.counters().writes,1);
 assert.equal((await f.q('/autopilot/'+run.id+'/resume',{})).status,202);for(let i=0;i<5;i++)await f.a.tick();saved=f.a.autopilot.list(f.project.id)[0];assert.equal(saved.state,'completed');assert.equal(saved.jobId,jobId);assert.equal(f.counters().writes,2);assert.equal(f.counters().generated,1);
});
test('full recovery re-encrypts sheet and bootstrap credentials and never restarts publication automatically',async t=>{
 const f=await fixture(t,{bootstrapStop:true});await f.q('/autopilot/source',sourceConfig);const {run}=await f.launch();for(let i=0;i<3;i++)await f.a.tick();
 const manual=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true});await f.a.tick();const assigned=await f.q('/autopilot/'+manual.run.id+'/destination',{...manualSite,baseUrl:'https://manual-backup.example/'});assert.equal(assigned.status,200,'Backup fixture needs a separate unreserved manual destination');
 const {createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');createAIBudget({filename:path.join(f.dir,'ai-budget.sqlite')}).close();
 const {exportFullBackup,restoreFullBackup}=await import('../server/lifecycle/full-recovery.mjs'),{createSecretBox}=await import('../server/lifecycle/secrets.mjs');const oldKey=Buffer.alloc(32,29).toString('base64'),newKey=Buffer.alloc(32,31).toString('base64'),passphrase='Fixture recovery password';const backup=await exportFullBackup({dataDir:f.dir,masterKey:oldKey,passphrase});const target=fs.mkdtempSync(path.join(os.tmpdir(),'pp-autopilot-recovered-'));t.after(()=>fs.rmSync(target,{recursive:true,force:true}));await restoreFullBackup({dataDir:target,masterKey:newKey,backup,passphrase});
 const {createStore}=await import('../server/lifecycle/store.mjs');const store=createStore({filename:path.join(target,'pageposter.sqlite'),masterKey:newKey});try{const restored=store.getRecord(run.id);assert.equal(createSecretBox(newKey).decrypt(run.id,restored.candidateCredential).applicationPassword,'fixture-admin-secret');assert.equal(createSecretBox(newKey).decrypt(run.id+':api',restored.apiCredential).applicationPassword,'fixture-api-secret');const restoredManual=store.getRecord(manual.run.id);assert.equal(restoredManual.state,'awaiting_review');assert.equal(createSecretBox(newKey).decrypt(manual.run.id+':manual',restoredManual.manualCredential).applicationPassword,'fixture-admin-secret');assert.equal(restored.leaseToken,null);const connection=JSON.parse(createSecretBox(newKey).decrypt('pageposter:source:v1',JSON.parse(fs.readFileSync(path.join(target,'autopilot-source.json'),'utf8'))).applicationPassword);assert.equal(connection.spreadsheetId,sourceConfig.spreadsheetId);}finally{store.close();}
});

const customerHtml='<!doctype html><html lang="pl"><head><title>Customer title</title><style>body{background:#effff5}.offer{display:grid;grid-template-columns:1fr 2fr}</style></head><body><header class="hero"><h1>Original heading</h1></header><main><h2 id="details">Original details</h2><p>Exact customer copy.</p><a href="https://destination.example/?a=%2f&amp;b=1#Keep">Original offer</a></main><footer>Original disclosure</footer></body></html>';
function htmlInput(extra={}){return {source:'html',html:customerHtml,baseUrl:'',brand:'Customer brand',brandUrl:'https://brand.example/?keep=%2f#x',chromeMode:'overlay-only',...extra};}
test('customer HTML preview requires no OpenAI and launch publishes preserved material after restart',async t=>{
 const f=await fixture(t),input=htmlInput();
 const preview=await f.q('/autopilot/preview',input);assert.equal(preview.status,200);assert.equal(preview.title,'Customer title');assert.ok(preview.reviewToken);assert.match(preview.html,/Original disclosure/);assert.equal(f.counters().generated,0);
 const body={...input,idempotencyKey:crypto.randomUUID(),reviewToken:preview.reviewToken};const launched=await f.q('/projects/'+f.project.id+'/autopilot',body);assert.equal(launched.status,202);assert.equal(launched.run.source,'html');assert.equal(launched.run.stage,'preparing');
 await f.a.tick();await f.a.tick();let run=f.a.autopilot.list(f.project.id)[0];assert.equal(run.state,'waiting_source');assert.equal(f.counters().generated,0);
 const doc=new (require('jsdom').JSDOM)((await f.q('/autopilot/'+run.id+'/html')).html).window.document;
 assert.equal(doc.querySelector('#pp-imported-content h1').textContent,'Original heading');assert.equal(doc.querySelector('#pp-imported-content footer').textContent,'Original disclosure');assert.equal(doc.querySelector('#pp-landing > .pp-header'),null);assert.equal(doc.querySelector('#pp-landing > .pp-footer'),null);
 assert.equal(doc.querySelector('#pp-imported-content a').getAttribute('href'),'https://destination.example/?a=%2f&b=1#Keep');
 await f.restart();await f.q('/autopilot/source',sourceConfig);for(let i=0;i<8;i++)await f.a.tick();run=f.a.autopilot.list(f.project.id)[0];assert.equal(run.state,'completed');assert.equal(f.counters().writes,1);assert.equal(f.counters().generated,0);assert.match(f.a.store.getPage(run.pageId).config.importHtml,/Exact customer copy\./);assert.match(f.a.store.getPage(run.pageId).config.importHtml,/grid-template-columns:1fr 2fr/);
 assert.equal((await f.q('/projects/'+f.project.id+'/autopilot',body)).run.id,run.id);
});
test('customer custom chrome adds brand links without replacing source landmarks',async t=>{
 const f=await fixture(t),input=htmlInput({chromeMode:'custom'}),preview=await f.q('/autopilot/preview',input);assert.equal(preview.status,200);
 const document=new (require('jsdom').JSDOM)(preview.html).window.document;
 for(const selector of ['#pp-landing > .pp-header','#pp-landing > .pp-footer']){const node=document.querySelector(selector);assert.ok(node);const brand=node.querySelector('.pp-brand');assert.equal(brand.getAttribute('href')||brand.getAttribute('data-pp-url'),input.brandUrl);}
 assert.equal(document.querySelector('#pp-imported-content .hero h1').textContent,'Original heading');assert.equal(document.querySelector('#pp-imported-content footer').textContent,'Original disclosure');
});
test('customer source cannot launch without review or reuse review after source or chrome changes',async t=>{
 const f=await fixture(t),input=htmlInput({html:customerHtml+'<script>alert(1)</script>'}),id=crypto.randomUUID(),route='/projects/'+f.project.id+'/autopilot';
 const unreviewed=await f.q(route,{...input,idempotencyKey:id});assert.equal(unreviewed.status,400);assert.equal(unreviewed.code,'HTML_REVIEW_REQUIRED');
 const preview=await f.q('/autopilot/preview',input);assert.equal(preview.status,200);assert.ok(preview.warnings.length);assert.doesNotMatch(preview.html,/alert\(1\)/);
 for(const change of [{html:input.html+'<p>Added</p>'},{chromeMode:'custom'},{brandUrl:'https://changed.example/'}]){const response=await f.q(route,{...input,...change,idempotencyKey:id,reviewToken:preview.reviewToken});assert.equal(response.status,400);assert.equal(response.code,'HTML_REVIEW_REQUIRED');}
 assert.equal(f.a.store.listPages(f.project.id).length,0);assert.equal(f.a.autopilot.list(f.project.id).length,0);assert.equal(f.counters().generated,0);
 const accepted=await f.q(route,{...input,idempotencyKey:id,reviewToken:preview.reviewToken});assert.equal(accepted.status,202);
 assert.equal((await f.q(route,{...input,idempotencyKey:id,reviewToken:preview.reviewToken,chromeMode:'custom'})).status,409);
});
test('AI overlay-only omits generated chrome while default old launch retains it',async t=>{
 const f=await fixture(t);const response=await f.q('/projects/'+f.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,chromeMode:'overlay-only'});assert.equal(response.status,202);await f.a.tick();const html=(await f.q('/autopilot/'+response.run.id+'/html')).html;const doc=new (require('jsdom').JSDOM)(html).window.document;assert.equal(doc.querySelector('#pp-landing > .pp-header'),null);assert.equal(doc.querySelector('#pp-landing > .pp-footer'),null);assert.equal(doc.querySelector('h1').textContent,'AI creates this title');
 const old=await f.launch();await f.a.tick();await f.a.tick();const withChrome=new (require('jsdom').JSDOM)((await f.q('/autopilot/'+old.run.id+'/html')).html).window.document;assert.ok(withChrome.querySelector('#pp-landing > .pp-header'));
});

test('approved customer output is rechecked after restart and before publication enqueue',async t=>{
 const {rendererWindow}=await import('../server/lifecycle/render.mjs'),api=rendererWindow.PagePoster;
 for(const scenario of [{stage:'preparing',kind:'html'},{stage:'publishing',kind:'title'},{stage:'publishing',kind:'expectedUrls'}])await t.test(scenario.stage+' rejects '+scenario.kind+' drift',async t=>{
  const f=await fixture(t),input=htmlInput(),preview=await f.q('/autopilot/preview',input);
  assert.equal(preview.status,200);
  const launched=await f.q('/projects/'+f.project.id+'/autopilot',{...input,idempotencyKey:crypto.randomUUID(),reviewToken:preview.reviewToken});
  assert.equal(launched.status,202);const id=launched.run.id;
  assert.doesNotMatch(JSON.stringify(launched.run),/customerConfig|importHtml|reviewToken|approvedHtmlHash|Exact customer copy/);
  if(scenario.stage==='publishing'){
   await f.q('/autopilot/source',sourceConfig);
   for(let i=0;i<3;i++)await f.a.tick();
   const before=f.a.store.getRecord(id);assert.equal(before.stage,'publishing');assert.equal(before.jobId,null);
  }
  await f.restart();
  const original={renderSnippet:api.renderSnippet,normalizeConfig:api.normalizeConfig,analyzeLinks:api.analyzeLinks};
  try{
   if(scenario.kind==='html')api.renderSnippet=config=>original.renderSnippet(config).replace('Exact customer copy.','Changed by importer update.');
   if(scenario.kind==='title')api.normalizeConfig=config=>({...original.normalizeConfig(config),title:'Changed publication title'});
   if(scenario.kind==='expectedUrls')api.analyzeLinks=config=>{const audit=original.analyzeLinks(config);return{...audit,urls:[...audit.urls,'https://new-audit-destination.example/']};};
   await f.a.tick();
  }finally{Object.assign(api,original);}
  const stopped=f.a.autopilot.list(f.project.id).find(run=>run.id===id);
  assert.equal(stopped.state,'failed');assert.equal(stopped.stage,scenario.stage);
  assert.equal(stopped.error.code,'HTML_REVIEW_REQUIRED');assert.equal(stopped.jobId,null);
  assert.equal(f.a.store.listJobs(f.project.id).filter(job=>job.effect==='write').length,0);
  assert.equal(f.counters().writes,0);assert.equal(f.counters().generated,0);
  assert.equal(f.a.store.listPages(f.project.id).length,scenario.stage==='preparing'?0:1);
  if(stopped.pageId)assert.equal(f.a.store.getPage(stopped.pageId).title,'Customer title');
 });
});

test('customer may intentionally reuse identical supplied HTML without AI duplicate-content rejection',async t=>{
 const f=await fixture(t),input=htmlInput(),preview=await f.q('/autopilot/preview',input);
 const first=await f.q('/projects/'+f.project.id+'/autopilot',{...input,idempotencyKey:crypto.randomUUID(),reviewToken:preview.reviewToken});
 const second=await f.q('/projects/'+f.project.id+'/autopilot',{...input,idempotencyKey:crypto.randomUUID(),reviewToken:preview.reviewToken});
 assert.equal(first.status,202);assert.equal(second.status,202);assert.notEqual(first.run.id,second.run.id);
 for(let i=0;i<4;i++)await f.a.tick();
 const runs=f.a.autopilot.list(f.project.id),pages=f.a.store.listPages(f.project.id);
 assert.equal(pages.length,2);assert.ok(runs.every(run=>run.state==='waiting_source'&&run.error.code==='SOURCE_NOT_CONFIGURED'));
 assert.equal(pages[0].config.importHtml,pages[1].config.importHtml);assert.equal(f.counters().generated,0);assert.equal(f.counters().writes,0);
});


test('customer preview approval rejects metadata drift before launch even when HTML stays identical',async t=>{
 const {rendererWindow}=await import('../server/lifecycle/render.mjs'),api=rendererWindow.PagePoster;
 for(const kind of ['title','expectedUrls'])await t.test(kind+' requires a fresh preview',async t=>{
  const f=await fixture(t),input=htmlInput(),route='/projects/'+f.project.id+'/autopilot',preview=await f.q('/autopilot/preview',input);
  assert.equal(preview.status,200);
  const original={normalizeConfig:api.normalizeConfig,analyzeLinks:api.analyzeLinks};
  try{
   if(kind==='title')api.normalizeConfig=config=>({...original.normalizeConfig(config),title:'Changed publication title'});
   else api.analyzeLinks=config=>{const audit=original.analyzeLinks(config);return{...audit,urls:[...audit.urls,'https://new-audit-destination.example/']};};
   const refreshed=await f.q('/autopilot/preview',input);
   assert.equal(refreshed.status,200);assert.equal(refreshed.html,preview.html,'this regression changes only derived metadata');
   const body={...input,idempotencyKey:crypto.randomUUID()};
   const stale=await f.q(route,{...body,reviewToken:preview.reviewToken});
   assert.equal(stale.status,400);assert.equal(stale.code,'HTML_REVIEW_REQUIRED');
   assert.equal(f.a.autopilot.list(f.project.id).length,0);assert.equal(f.a.store.listPages(f.project.id).length,0);
   assert.equal(f.a.store.listJobs(f.project.id).length,0);assert.equal(f.counters().writes,0);assert.equal(f.counters().generated,0);
   assert.notEqual(refreshed.reviewToken,preview.reviewToken);
   const accepted=await f.q(route,{...body,reviewToken:refreshed.reviewToken});
   assert.equal(accepted.status,202);assert.equal(accepted.run.stage,'preparing');
  }finally{Object.assign(api,original);}
 });
});

test('archived project queues release capacity while unarchiving preserves admission and execution limits',async t=>{
 const f=await fixture(t);
 for(let index=0;index<20;index++)assert.equal((await f.launch()).status,202);
 assert.equal((await f.launch()).code,'CAPACITY_EXCEEDED');
 const archived=f.a.store.updateProject(f.project.id,{archived:true},f.project.revision);
 const active=f.a.store.createProject({name:'Active project'}),route='/projects/'+active.id+'/autopilot',body={idempotencyKey:crypto.randomUUID(),links};
 const accepted=await f.q(route,body);assert.equal(accepted.status,202);
 await f.a.tick();
 assert.equal(f.counters().generated,1);assert.equal(f.a.store.listPages(active.id).length,1);assert.equal(f.a.store.listPages(f.project.id).length,0);
 f.a.store.updateProject(archived.id,{archived:false},archived.revision);
 assert.equal((await f.q(route,{...body,idempotencyKey:crypto.randomUUID()})).code,'CAPACITY_EXCEEDED');
 assert.equal((await f.q(route,body)).run.id,accepted.run.id,'an exact replay retains its run even while capacity is full');
 assert.equal(f.a.autopilot.list(active.id).length,1);
 await Promise.all([f.a.tick(),f.a.tick()]);
 assert.equal(f.counters().generated,2,'concurrent ticks still execute only one reactivated run');
 assert.equal(f.a.store.listPages(f.project.id).length,1);assert.equal(f.a.store.listPages(active.id).length,1);
 assert.equal(f.counters().installed,0);assert.equal(f.counters().writes,0);
});

test('editorial launch persists its brief across restart and fences changes under the same identity',async t=>{
 let captured;const f=await fixture(t,{capture:input=>{captured=input;}}),editorial={format:'discussion',topic:'custom',customTopic:'Poker decision quality',language:'es'},body={idempotencyKey:crypto.randomUUID(),links,editorial,reviewBeforePublish:true};
 const started=await f.q('/projects/'+f.project.id+'/autopilot',body);assert.equal(started.status,202);assert.deepEqual(started.run.editorial,editorial);
 await f.restart();await f.a.tick();assert.deepEqual(captured.editorial,editorial);assert.equal(f.counters().writes,0);
 assert.equal(f.a.autopilot.list(f.project.id)[0].state,'awaiting_review');
 assert.equal((await f.q('/projects/'+f.project.id+'/autopilot',body)).run.id,started.run.id);
 assert.equal((await f.q('/projects/'+f.project.id+'/autopilot',{...body,editorial:{...editorial,format:'faq'}})).status,409);
 assert.equal((await f.q('/projects/'+f.project.id+'/autopilot',{...body,idempotencyKey:crypto.randomUUID(),editorial:{...editorial,customTopic:' '}})).status,400);
 assert.equal(f.counters().generated,1);
});
