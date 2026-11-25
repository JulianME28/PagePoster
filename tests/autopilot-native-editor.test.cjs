const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
async function faultPilot(f,reject){const {createAutopilot}=await import('../server/lifecycle/autopilot.mjs');let faults=0;const real=f.service.store,store={...real,updateRecord:(id,patch,...rest)=>{if(reject(patch)){faults++;throw Error('optional timing storage unavailable');}return real.updateRecord(id,patch,...rest);}};const pilot=await createAutopilot({store,dataDir:f.dir,masterKey:f.settings.masterKey,client:f.settings.client,visibleBrowser:f.browser,hasActivePage:f.service.automation.hasActivePage,...f.settings.autopilotOptions});return {faults:()=>faults,ticks:async(n=5)=>{for(let i=0;i<n;i++)await pilot.tick();}};}
test('manual timing persistence failure preserves challenge and successful resume without inventing a wait',async t=>{
 let challenge=true;const f=await fixture(t,{login:()=>{if(challenge)throw Object.assign(Error(),{code:'BROWSER_CAPTCHA_REQUIRED',state:'needs_attention'});}});await f.approve();const pilot=await faultPilot(f,patch=>Object.hasOwn(patch,'nativeManualWait'));await pilot.ticks(5);assert.ok(pilot.faults()>0);assert.equal(f.run().error.code,'BROWSER_CAPTCHA_REQUIRED');assert.equal(f.run().state,'needs_attention');assert.equal(f.run().browserWindow,true);assert.equal(f.run().publication.diagnostics.some(row=>row.phase==='manual_wait'),false);challenge=false;assert.equal((await f.q('/autopilot/'+f.runId+'/resume',{})).status,202);await f.ticks(8);assert.equal(f.run().state,'completed');assert.equal(f.stats().writes,1);
});
test('manual timing survives restart, remains open on rejected resume, and records wall wait only after validated resume',async t=>{
 let now=Date.now(),challenge=true;const f=await fixture(t,{clock:()=>now,login:()=>{if(challenge)throw Object.assign(Error('private challenge'),{code:'BROWSER_CAPTCHA_REQUIRED'});}});await f.approve();await f.ticks(5);let wait=f.run().publication.diagnostics.find(r=>r.phase==='manual_wait');assert.ok(wait);assert.equal(wait.endedAt,null);assert.equal(wait.manualWaitMs,null);assert.equal(wait.elapsedMs,null);const startedAt=wait.startedAt;await f.ticks(2);assert.equal(f.run().publication.diagnostics.find(r=>r.phase==='manual_wait').startedAt,startedAt);await f.restart();now+=3600000;
 const page=f.service.store.getPage(f.raw().pageId);f.service.store.updatePage(page.id,{title:page.title+' edited'},page.revision);const rejected=await f.q('/autopilot/'+f.runId+'/resume',{});assert.ok([400,409].includes(rejected.status));assert.equal(rejected.code,'REVIEW_REQUIRED');assert.equal(f.run().publication.diagnostics.find(r=>r.phase==='manual_wait').endedAt,null);
 const good=await fixture(t,{clock:()=>now,login:()=>{if(challenge)throw Object.assign(Error(),{code:'BROWSER_LOGIN_REQUIRED'});}});await good.approve();await good.ticks(5);await good.restart();now+=7200000;challenge=false;assert.equal((await good.q('/autopilot/'+good.runId+'/resume',{})).status,202);wait=good.run().publication.diagnostics.find(r=>r.phase==='manual_wait');assert.equal(wait.manualWaitMs,7200000);assert.equal(wait.timingScope,'manual_wait_wall');assert.equal(wait.manualWaitScope,'until_validated_resume_wall');assert.equal(wait.elapsedMs,null);await good.ticks(8);assert.equal(good.run().state,'completed');assert.equal(good.stats().writes,1);assert.doesNotMatch(JSON.stringify(wait),/private challenge|native-admin|password/);
});
test('native timing flushes bounded operation events and leaves fake network observations unknown',async t=>{
 const f=await fixture(t,{auto:true,beforeCreate:input=>{for(let i=0;i<256;i++)input.observe?.({kind:'network',networkMs:1,queueMs:2,httpStatus:201,method:'POST',requestClass:'publication'});input.observe?.({kind:'phase',phase:'create',state:'start',at:1000});input.observe?.({kind:'phase',phase:'create',state:'end',at:1010,elapsedMs:10,code:'OK'});}});await f.approve();const before=f.raw().revision;await f.ticks(8);assert.equal(f.run().state,'completed');const rows=f.run().publication.diagnostics;for(const phase of ['selection','browser','login','plugin','create','publish','check'])assert.ok(rows.some(r=>r.phase===phase),phase);
 const publish=rows.find(r=>r.phase==='publish');assert.equal(publish.requestCount,256);assert.equal(publish.httpStatus,201);assert.equal(publish.networkMs,256);assert.equal(publish.queueMs,512);assert.equal(publish.timingScope,'operation');assert.ok(f.raw().revision-before<150);assert.equal(rows.find(r=>r.phase==='plugin').networkMs,null);assert.equal(rows.find(r=>r.phase==='plugin').httpStatus,null);const check=rows.find(r=>r.phase==='check');assert.ok(check.elapsedMs>=0);assert.equal(check.timingScope,'worker_operation');assert.ok(check.workerQueueWaitMs>=0);assert.equal(check.workerQueueWaitScope,'job_created_to_claim_wall');assert.ok(check.jobLifetimeMs>=0);
});
test('native timing includes shared source selection before review and diagnostic storage failures cannot change publication',async t=>{
 const pre=await fixture(t,{auto:true,preselected:true});assert.ok(pre.raw().publicationDiagnostics?.some(row=>row.phase==='selection'&&row.timingScope==='operation'));
 const f=await fixture(t);await f.approve();const pilot=await faultPilot(f,patch=>!!patch.publicationDiagnostics);await pilot.ticks(5);assert.ok(pilot.faults()>0);await f.ticks(4);assert.equal(f.run().state,'completed');assert.equal(f.stats().writes,1);assert.equal(f.stats().creates,1);
});
test('public preview failure preserves the confirmed publication and only a failed public check needs attention',async t=>{
 let viewAttempts=0;const f=await fixture(t,{checkProblem:'public',publicView:async(service,id)=>{const run=service.store.getRecord(id),page=service.store.getPage(run.pageId);assert.equal(run.nativePublication.phase,'published');assert.equal(page.wpId,run.nativePublication.postId);assert.ok(page.fullUrl);viewAttempts++;throw Object.assign(Error('preview timeout'),{code:'network_timeout'});}});
 await f.approve();await f.ticks(7);const run=f.run(),page=f.service.store.getPage(run.pageId);assert.equal(run.state,'needs_attention');assert.equal(run.stage,'checking');assert.equal(run.error.code,'CHECK_FAILED');assert.equal(f.raw().nativePublication.phase,'published');assert.equal(page.wpId,f.raw().nativePublication.postId);assert.ok(page.fullUrl);assert.equal(f.stats().writes,1);assert.equal(f.stats().creates,1);assert.equal(viewAttempts,1);
});
test('unclassified native login errors show a safe actionable stage without leaking provider text',async t=>{
 for(const name of ['Error','TimeoutError']){
  const f=await fixture(t,{login:()=>{const error=Error('private-login private-password provider stack');error.name=name;throw error;}});
  await f.approve();await f.ticks(5);const run=f.run();assert.equal(run.state,'needs_attention');assert.equal(run.error.code,name==='TimeoutError'?'BROWSER_TIMEOUT':'BROWSER_ACTION_FAILED');assert.equal(run.error.stage,'installing');assert.doesNotMatch(JSON.stringify(run.error),/private-login|private-password|provider stack|AUTOPILOT_FAILED/);assert.equal(f.stats().creates,0);
 }
});
test('an unavailable native editor never instructs the user to install Bridge',async t=>{
 const f=await fixture(t,{plugins:()=>{throw Object.assign(Error(),{code:'BROWSER_EDITOR_UNAVAILABLE'});}});await f.approve();await f.ticks(5);assert.doesNotMatch(f.run().error.message,/Bridge/);assert.match(f.run().error.message,/редактор/);
});
test('code-less native errors preserve explicit uncertainty and published checkpoints',async t=>{
 const explicit=await fixture(t,{login:()=>{throw Object.assign(Error('private provider response'),{state:'uncertain'});}});await explicit.approve();await explicit.ticks(4);assert.equal(explicit.run().state,'uncertain');assert.equal(explicit.run().error.code,'NATIVE_RESULT_UNCERTAIN');assert.equal(explicit.stats().creates,0);
 const afterWrite=await fixture(t,{beforeSend:(service,id)=>{const run=service.store.getRecord(id);service.store.updateRecord(id,{nativePublication:{postId:80,phase:'published'}},run.revision);throw Error('private post-checkpoint response');}});await afterWrite.approve();await afterWrite.ticks(4);assert.equal(afterWrite.run().state,'uncertain');assert.equal(afterWrite.run().error.code,'NATIVE_NOT_PUBLISHED');assert.equal(afterWrite.raw().nativePublication.phase,'published');assert.equal(afterWrite.run().publication.lastEvidence.observation,'draft');assert.equal(afterWrite.stats().inspections,1);assert.equal(afterWrite.stats().creates,1);assert.equal(afterWrite.run().canDelete,false);
});
test('direct automatic publication may reuse a provably unused legacy archived reservation',async t=>{
 const f=await fixture(t,{auto:true}),old=f.service.store.createProject({name:'Closed legacy project'}),currentPage=f.service.store.getPage(f.raw().pageId),page=f.service.store.createPage(old.id,{title:'Local draft',config:currentPage.config});
 f.service.store.createRecord(old.id,'autopilot',{state:'paused',stage:'installing',pageId:page.id,candidate:{id:'old-reservation',baseUrl:origin},source:'html'},crypto.randomUUID());f.service.store.updateProject(old.id,{archived:true},old.revision);
 await f.approve();await f.ticks(8);assert.equal(f.selections[0].usedOrigins.includes(new URL(origin).origin),false);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});
const origin='https://native-wordpress.example/',secret='native-admin-password';
test('automatic admission respects a candidate-less manual reservation at the same root',async t=>{
 const sibling='https://manual.native-wordpress.example/',f=await fixture(t,{auto:true}),store=f.service.store;
 const owner=store.createRecord(f.project.id,'autopilot',{state:'awaiting_review',stage:'selecting',manualTarget:{baseUrl:sibling}},crypto.randomUUID());
 await f.approve();await f.ticks(8);
 assert.ok(f.selections[0].usedOrigins.includes(new URL(sibling).origin));
 assert.equal(f.run().error?.code,'SOURCE_RESERVED');
 assert.equal(f.stats().creates,0);assert.equal(f.stats().writes,0);
 assert.equal(store.getRecord(owner.id).manualTarget.baseUrl,sibling);
});

test('explicit manual admission respects an earlier automatic reservation at the same root',async t=>{
 const f=await fixture(t,{auto:true,preselected:true}),store=f.service.store;
 const base=new URL(f.raw().candidate.baseUrl),page=store.getPage(f.raw().pageId);
 const otherPage=store.createPage(f.project.id,{title:'Waiting manual choice',config:page.config});
 const other=store.createRecord(f.project.id,'autopilot',{state:'awaiting_review',stage:'selecting',pageId:otherPage.id},crypto.randomUUID());
 const result=await f.q('/autopilot/'+other.id+'/destination',{baseUrl:'https://manual.'+base.hostname+'/',username:'admin',password:secret});
 assert.equal(result.status,409);assert.equal(result.code,'SOURCE_RESERVED');
 assert.deepEqual(store.getRecord(other.id),other);
});
async function fixture(t,options={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-native-autopilot-'));let service,runId,creates=0,writes=0,inspections=0,trashes=0,remote=null,currentOrigin=origin,windowNumber=1,authenticatedAccount=null,sessionOpened=false;const logins=[],selections=[],browserActions=[],loginWindows=[];
 const forbidden=()=>assert.fail('Native publication must not use REST, Bridge or bootstrap');
 const session={get baseUrl(){return options.canonicalBaseUrl||(options.publishCanonicalBaseUrl&&service?.store.getRecord(runId)?.stage==='publishing'?options.publishCanonicalBaseUrl:currentOrigin);},get canonicalLogin(){return options.canonicalBaseUrl?{requestedBaseUrl:origin,baseUrl:options.canonicalBaseUrl,...(options.canonicalSteps?{steps:options.canonicalSteps}:{})}:null;},status:async()=>{},login:async auth=>{logins.push(auth.username);loginWindows.push(windowNumber);assert.equal(auth.applicationPassword,secret);if(!options.stickyLogin||!authenticatedAccount){await options.login?.(auth,currentOrigin);authenticatedAccount=auth.username;}},ensureCleanLinks:async()=>{await options.plugins?.(service,runId,currentOrigin,authenticatedAccount);},result:async()=>{},
  publishPage:async input=>{await options.beforeCreate?.(input);if(options.loseDraftIdentity){if(!input.saved){await input.checkpoint({postId:null,phase:'creating'});creates++;}throw Object.assign(Error('draft identity lost'),{code:'NATIVE_RESULT_UNCERTAIN',uncertain:true});}if(!input.saved){creates++;remote={postId:80,phase:'draft'};await input.checkpoint(remote);}else{assert.equal(input.saved.postId,80);}
   await options.beforeDispatch?.(service,runId);
   await input.checkpoint({postId:80,phase:'dispatching'});await options.beforeSend?.(service,runId);input.beforeSend();writes++;
   remote={postId:80,url:currentOrigin+'published/',title:input.title,content:input.html,status:'publish'};
   if(options.loseResponse&&writes===1){if(options.loseResponse==='raw')throw Error('private response details');throw Object.assign(Error('lost'),{code:'BROWSER_PUBLICATION_UNCERTAIN',uncertain:true});}
   await input.checkpoint({postId:80,phase:'published',url:remote.url});return {...remote,...(options.badContent?{content:'changed remotely'}:{})};},
  trashPublished:async input=>{await options.beforeTrash?.(service,runId,input);assert.equal(input.saved.postId,80);assert.equal(input.title,remote.title);assert.equal(input.html,remote.content);if(!['dispatching','trashed'].includes(input.cleanup?.phase)){await input.checkpoint({postId:80,phase:'dispatching'});input.beforeSend();trashes++;remote.status='trash';await options.afterTrash?.(service,runId,input);}if(remote.status!=='trash')throw Object.assign(Error('not confirmed'),{code:'NATIVE_TRASH_UNCERTAIN',uncertain:true});await input.checkpoint({postId:80,phase:'trashed'});return {postId:80,status:'trash'};},
  inspectPublished:async input=>{inspections++;assert.equal(input.saved.postId,80);await options.inspect?.(service,runId,input,inspections);if(!remote?.status)throw Object.assign(Error(),{code:'NATIVE_NOT_PUBLISHED'});return remote;},
  inspectOwnedTrash:async input=>{await options.inspectTrash?.(service,runId,input);return {postId:input.saved.postId,status:remote?.status==='trash'?'trash':'unknown'};}};
 const browser={nativeEditor:true,prepare:async()=>{},open:async(id,url)=>{await options.open?.(service,id,url);sessionOpened=true;currentOrigin=url;return session;},assertOpen:()=>{if(options.strictOpen&&!sessionOpened)throw Object.assign(Error('No session'),{code:'BROWSER_NOT_OPEN'});},reset:async id=>{assert.equal(id,runId);browserActions.push('reset');windowNumber++;authenticatedAccount=null;sessionOpened=false;},...(options.sameWindowSwitch?{switchAccount:async id=>{assert.equal(id,runId);browserActions.push('switch');authenticatedAccount=null;}}:{}),focus:async()=>{},error:async()=>{},done:async()=>{},result:async()=>{await options.publicView?.(service,runId);},close:async()=>{}};
 const candidate=index=>({id:'donor-'+index,baseUrl:index===1?origin:'https://replacement.example/',rowNumber:index+1,username:'admin',password:secret,...(options.alternate===false?{}:{alternateCredentials:{username:'backup',password:secret}})});
 const source={pickUnused:async(config,input)=>{selections.push(input);return options.pick?options.pick(input):candidate(options.preselected?2:selections.length);},readCandidates:async()=>({candidates:[candidate(1),candidate(2)],issues:[]})};
 const settings={dataDir:dir,maxPages:options.maxPages??1000,masterKey:Buffer.alloc(32,65).toString('base64'),visibleBrowser:browser,autopilotOptions:{bootstrapFactory:forbidden,...(options.clock?{clock:options.clock}:{}),...(options.auto?{source}: {})},client:{checkSite:forbidden,checkPage:async input=>{assert.equal(input.publicOnly,true);assert.equal(input.site.applicationPassword,undefined);await options.checkRead?.(service,runId,input);return ['public','content','noindex','robots','links'].map(kind=>({kind,state:options.checkProblem===kind?'problem':'ok',...(options.checkProblem===kind?{code:options.checkCode||'fixture_'+kind}:{}),evidence:'public fixture'}));}},bridgeClient:{checkStatus:forbidden},browserVerifier:{verifyPublished:async input=>{await options.beforeVisual?.(service,runId,input);const state=options.visualState?options.visualState(service.store.getRecord(runId),input):options.visualProblem?'problem':'ok';return {state,viewports:[],...(input.compareVisual?{visual:options.visualEvidence?.(state)||{state,code:'fixture_visual_'+state,viewports:['desktop'].map(name=>({name,state,code:'fixture_visual_'+state}))}}:{})};}}};
 service=await createLifecycleService(settings);const project=service.store.createProject({name:'Native editor'});
 const q=async(route,body)=>{const result=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:result.status,...await result.json()};};
 const input={source:'html',html:'<h1>Native title</h1><p>Exact native HTML.</p>',chromeMode:'overlay-only'},preview=await q('/autopilot/preview',input);
 const launched=await q('/projects/'+project.id+'/autopilot',{...input,idempotencyKey:crypto.randomUUID(),reviewToken:preview.reviewToken,reviewBeforePublish:true});runId=launched.run.id;
 await service.tick();
 if(options.auto){await service.autopilot.saveSource({spreadsheetId:'fixtureSheetId12345',range:'Sites!A1:O100',serviceAccount:{client_email:'reader@fixture.iam.gserviceaccount.com',private_key:'fixture'},columns:{url:'A',username:'K',password:'L'}});if(options.preselected){const run=service.store.getRecord(runId);service.store.updateRecord(runId,{queueItemId:'fixture-imported-row'},run.revision);await service.autopilot.selectPending();}}
 else await q('/autopilot/'+runId+'/destination',{baseUrl:origin,username:'admin',password:secret});
 const approve=async()=>{const current=await q('/autopilot/'+runId+'/html');return q('/autopilot/'+runId+'/approve',{reviewToken:current.reviewToken});};
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {get service(){return service;},settings,browser,dir,runId,project,q,approve,logins,selections,browserActions,loginWindows,cleanupStats:()=>({trashes}),stats:()=>({creates,writes,inspections}),raw:()=>service.store.getRecord(runId),run:()=>service.autopilot.list(project.id)[0],ticks:async(n=6)=>{for(let i=0;i<n;i++)await service.tick();},restart:async()=>{await service.close();service=await createLifecycleService(settings);}};
}
test('known plugin permission denial publishes without cleaner when both accounts lack its capability',async t=>{
 const f=await fixture(t,{auto:true,plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}}),html=(await f.q('/autopilot/'+f.runId+'/html')).html,pageId=f.raw().pageId;await f.approve();await f.ticks(10);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.raw().pageId,pageId);assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);assert.equal(f.selections.length,1);assert.equal(f.run().skippedSites.length,0);assert.equal(f.run().pluginFallback.code,'CLEAN_LINKS_INSTALL_FORBIDDEN');assert.doesNotMatch(JSON.stringify(f.run()),/native-admin-password|ciphertext/);
});
test('unavailable automatic donor login is replaced before creating a page and preserves the approved HTML',async t=>{
 for(const phase of ['open','login'])await t.test(phase,async t=>{
  const unavailable=()=>{throw Object.assign(Error('Unavailable login'),{code:'BROWSER_PAGE_UNAVAILABLE',state:'needs_attention'});};
  const f=await fixture(t,{auto:true,preselected:true,strictOpen:true,...(phase==='open'?{open:(s,id,url)=>{if(url===origin)unavailable();}}:{login:(auth,url)=>{if(url===origin)unavailable();}})}),html=(await f.q('/autopilot/'+f.runId+'/html')).html,pageId=f.raw().pageId;
  await f.approve();await f.ticks(12);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.raw().pageId,pageId);assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);assert.equal(f.run().skippedSites.length,1);assert.equal(f.run().skippedSites[0].code,'BROWSER_PAGE_UNAVAILABLE');assert.equal(f.run().selectedDomain,'https://replacement.example/');assert.equal(f.selections.length,0);
 });
});

test('manual, CAPTCHA, uncertain and checkpointed login failures are never automatically replaced',async t=>{
 for(const mode of ['manual','captcha','login_required','browser_closed','browser_missing','uncertain','checkpoint','snapshot'])await t.test(mode,async t=>{
  const codes={captcha:'BROWSER_CAPTCHA_REQUIRED',login_required:'BROWSER_LOGIN_REQUIRED',browser_closed:'BROWSER_CLOSED',browser_missing:'BROWSER_UNAVAILABLE'};
  const f=await fixture(t,{auto:mode!=='manual',open:(s,id)=>{if(['checkpoint','snapshot'].includes(mode)){const r=s.store.getRecord(id);s.store.updateRecord(id,mode==='checkpoint'?{nativePublication:{phase:'creating',postId:null}}:{nativeSnapshot:{materialHash:'previous-publication'}},r.revision);}throw Object.assign(Error('Stopped login'),{code:codes[mode]||'BROWSER_PAGE_UNAVAILABLE',state:'needs_attention',...(mode==='uncertain'?{uncertain:true}:{})});}});
  await f.approve();await f.ticks(8);assert.equal(f.run().skippedSites.length,0);assert.equal(f.selections.length,mode==='manual'?0:1);assert.equal(f.stats().creates,0);assert.equal(f.stats().writes,0);
 });
});

test('only known site availability failures during pre-page login may replace automatic donors',async t=>{
 for(const code of ['BROWSER_TIMEOUT','BROWSER_ORIGIN_BLOCKED','dns_failed','network_failed','network_timeout','unsafe_address','unsafe_url','invalid_redirect','cross_origin_redirect','too_many_redirects'])await t.test(code,async t=>{
  const f=await fixture(t,{auto:true,open:(s,id,url)=>{if(url===origin)throw Object.assign(Error('Site unavailable'),{code});}});await f.approve();await f.ticks(12);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.run().skippedSites.length,1);assert.equal(f.run().skippedSites[0].code,code);assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
 });
});

test('page unavailable during plugin or publication work cannot masquerade as an unavailable login',async t=>{
 for(const phase of ['plugins','publish'])await t.test(phase,async t=>{
  const fail=()=>{throw Object.assign(Error('Unavailable after login'),{code:'BROWSER_PAGE_UNAVAILABLE'});},f=await fixture(t,{auto:true,...(phase==='plugins'?{plugins:fail}:{beforeCreate:fail})});await f.approve();await f.ticks(8);assert.equal(f.run().skippedSites.length,0);assert.equal(f.selections.length,1);assert.equal(f.stats().writes,phase==='plugins'?1:0);
 });
});

test('a proven unsent page creation timeout replaces only an automatic donor',async t=>{
 for(const auto of [true,false])await t.test(auto?'automatic':'manual',async t=>{
  let first=true;
  const f=await fixture(t,{auto,beforeCreate:()=>{if(first){first=false;throw Object.assign(Error('Editor did not open'),{code:'BROWSER_TIMEOUT',writeNotAttempted:true,state:'needs_attention'});}}});
  const pageId=f.raw().pageId,html=(await f.q('/autopilot/'+f.runId+'/html')).html;
  await f.approve();await f.ticks(12);
  assert.equal(f.run().state,auto?'completed':'needs_attention',JSON.stringify(f.run()));
  assert.equal(f.run().skippedSites.length,auto?1:0);
  if(auto){assert.equal(f.run().skippedSites[0].code,'BROWSER_TIMEOUT');assert.equal(f.run().selectedDomain,'https://replacement.example/');}
  assert.equal(f.raw().pageId,pageId);
  assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);
  assert.equal(f.stats().creates,auto?1:0);assert.equal(f.stats().writes,auto?1:0);
 });
});

test('a timeout after the draft was identified never replaces the donor',async t=>{
 const f=await fixture(t,{auto:true,beforeDispatch:()=>{throw Object.assign(Error('Editor timeout'),{code:'BROWSER_TIMEOUT',writeNotAttempted:true,state:'needs_attention'});}});
 await f.approve();await f.ticks(8);
 assert.equal(f.run().state,'needs_attention');assert.equal(f.run().skippedSites.length,0);
 assert.equal(f.selections.length,1);assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,0);
});
test('missing Add New on an automatic donor preserves the approved page and publishes on the replacement',async t=>{
 let attempts=0;
 const f=await fixture(t,{auto:true,beforeCreate:()=>{if(++attempts===1)throw Object.assign(Error('No Add New control'),{code:'NATIVE_NAVIGATION_UNAVAILABLE',writeNotAttempted:true});}});
 const pageId=f.raw().pageId,html=(await f.q('/autopilot/'+f.runId+'/html')).html;
 await f.approve();await f.ticks(12);
 assert.equal(f.run().state,'completed');assert.equal(f.run().selectedDomain,'https://replacement.example/');
 assert.equal(f.run().skippedSites[0].code,'NATIVE_NAVIGATION_UNAVAILABLE');
 assert.equal(f.raw().pageId,pageId);assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);
 assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:0});
 const policy=f.service.store.listPolicyRecords('donor_exclusion').find(row=>row.code==='NATIVE_NAVIGATION_UNAVAILABLE');
 assert.equal(policy?.type,'transient');
});

test('experimental AMP is opt-in, invalidates old approval, and requires its plugin before the one publication',async t=>{
 const f=await fixture(t,{plugins:()=>({ampSupport:true})});
 const original=f.browser.open;f.browser.open=async(...args)=>{const session=await original(...args);session.ensureCleanLinks=async()=>({ampSupport:true});return session;};
 const initial=await f.q('/autopilot/'+f.runId+'/html');assert.doesNotMatch(initial.html,/data-pp-amp=/);
 const mode=await f.q('/projects/'+f.project.id+'/amp-mode',{enabled:true});assert.equal(mode.status,200);
 assert.ok([400,409].includes((await f.q('/autopilot/'+f.runId+'/approve',{reviewToken:initial.reviewToken})).status));
 const prepared=await f.q('/autopilot/'+f.runId+'/html');assert.match(prepared.html,/data-pp-amp=/);
 await f.restart();assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,prepared.html);
 await f.approve();await f.ticks(8);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.raw().ampMode,true);
 assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:0});
 const published=f.raw(),page=f.service.store.getPage(published.pageId);
 assert.equal((await f.q('/projects/'+f.project.id+'/amp-mode',{enabled:false})).status,200);
 assert.deepEqual(f.raw(),published);
 assert.deepEqual(f.service.store.getPage(published.pageId),page);
 assert.equal(f.service.store.getRecord('amp-mode:'+f.project.id).enabled,false);
});

test('AMP cannot silently publish without head support and disabling local mode restores the original HTML',async t=>{
 const f=await fixture(t);const initial=await f.q('/autopilot/'+f.runId+'/html');
 assert.equal((await f.q('/projects/'+f.project.id+'/amp-mode',{enabled:true})).status,200);
 assert.equal((await f.q('/projects/'+f.project.id+'/amp-mode',{enabled:false})).status,200);
 assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,initial.html);
 await f.q('/projects/'+f.project.id+'/amp-mode',{enabled:true});await f.approve();await f.ticks(6);
 assert.equal(f.run().error.code,'AMP_PLUGIN_REQUIRED');assert.equal(f.stats().creates,0);assert.equal(f.stats().writes,0);
 assert.equal((await f.q('/projects/'+f.project.id+'/amp-mode',{enabled:false})).status,200);
 assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,initial.html);await f.approve();await f.ticks(8);assert.equal(f.run().state,'completed');assert.equal(f.stats().writes,1);
});

test('a broken optional AMP validator cannot prevent ordinary projects or disabling AMP from loading',async t=>{
 const f=await fixture(t),{createAutopilot}=await import('../server/lifecycle/autopilot.mjs');
 f.service.store.createRecord(f.project.id,'amp_project_mode',{enabled:true},'amp-mode:'+f.project.id);let attempts=0;
 const pilot=await createAutopilot({store:f.service.store,dataDir:f.dir,masterKey:f.settings.masterKey,client:f.settings.client,visibleBrowser:f.browser,ampValidatorInit:async()=>{attempts++;throw Error('Missing optional validator');},...f.settings.autopilotOptions});
 assert.equal(attempts,1);assert.equal(pilot.list(f.project.id).length,1);
 const response=await pilot.handle(new Request('http://localhost/api/lifecycle/projects/'+f.project.id+'/amp-mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})}),'/projects/'+f.project.id+'/amp-mode',request=>request.json());
 assert.equal(response.status,200);
});

test('AMP readiness is based on anonymous response checks and is invalidated by a later content revision',async t=>{
 const f=await fixture(t),{renderAmpDocument}=await import('../server/lifecycle/amp-mode.mjs');let prepared,reads=0;
 const original=f.browser.open;f.browser.open=async(...args)=>{const session=await original(...args);session.ensureCleanLinks=async()=>({ampSupport:true});session.networkTransport=async(url,options)=>{
  reads++;assert.equal(options.method,'GET');assert.equal(options.headers.cookie,undefined);const canonical=origin+'published/',alternate=canonical+'?pageposter_amp=1',payload=JSON.parse(Buffer.from(/data-pp-amp="([^"]+)"/.exec(prepared.html)[1],'base64').toString('utf8'));
  return {status:200,text:url===alternate?renderAmpDocument(payload,canonical):'<!doctype html><head><link rel="canonical" href="'+canonical+'"><link rel="amphtml" href="'+alternate+'"></head><body>'+prepared.html};
 };return session;};
 await f.q('/projects/'+f.project.id+'/amp-mode',{enabled:true});prepared=await f.q('/autopilot/'+f.runId+'/html');await f.approve();await f.ticks(8);
 assert.equal(f.run().state,'completed');assert.equal(f.raw().ampStatus.state,'ready');assert.equal(reads,2);assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
 const page=f.service.store.getPage(f.raw().pageId);f.service.store.updatePage(page.id,{remoteSnapshot:{...page.remoteSnapshot,contentHash:'f'.repeat(64)}},page.revision);
 const queue=await f.q('/project-queue');assert.equal(queue.projects.find(project=>project.projectId===f.project.id).items[0].amp.state,'unknown');
});

test('experimental AMP and its exact payload survive automatic donor replacement without a second page',async t=>{
 let attempts=0;const f=await fixture(t,{auto:true,beforeCreate:()=>{if(++attempts===1)throw Object.assign(Error('Missing Add New'),{code:'NATIVE_NAVIGATION_UNAVAILABLE',writeNotAttempted:true});}});
 const open=f.browser.open;f.browser.open=async(...args)=>{const session=await open(...args);session.ensureCleanLinks=async()=>({ampSupport:true});return session;};
 assert.equal((await f.q('/projects/'+f.project.id+'/amp-mode',{enabled:true})).status,200);const html=(await f.q('/autopilot/'+f.runId+'/html')).html;
 await f.approve();await f.ticks(14);assert.equal(f.run().state,'completed');assert.equal(f.raw().ampMode,true);assert.equal(f.run().skippedSites.length,1);assert.equal(f.run().selectedDomain,'https://replacement.example/');assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});
test('a legacy failure during the create phase can retry when no creation checkpoint exists',async t=>{
 let attempts=0;
 const f=await fixture(t,{auto:true,beforeCreate:input=>{
  if(++attempts===1){
   input.observe({kind:'phase',phase:'create',state:'start',at:Date.now()});
   input.observe({kind:'phase',phase:'create',state:'end',at:Date.now(),code:'BROWSER_TIMEOUT',checkpoint:null});
   throw Object.assign(Error('Previously failed before Add New'),{code:'BROWSER_TIMEOUT'});
  }
  if(attempts===2)throw Object.assign(Error('No Add New control'),{code:'NATIVE_NAVIGATION_UNAVAILABLE',writeNotAttempted:true});
 }});
 await f.approve();await f.ticks(8);
 const view=async()=>(await f.q('/project-queue')).projects.find(project=>project.projectId===f.project.id).items.find(item=>item.runId===f.runId);
 assert.equal((await view()).canRetry,true);
 assert.equal((await f.q('/project-queue/items/'+(await view()).id+'/retry',{})).status,200);
 await f.ticks(12);
 assert.equal(f.run().selectedDomain,'https://replacement.example/');
 assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:0});
});

test('unavailable login replacement stops after ten donors without creating any page',async t=>{
 let number=0;const f=await fixture(t,{auto:true,pick:()=>({id:'missing-'+(++number),baseUrl:'https://missing-'+number+'.example/',rowNumber:number+1,username:'admin',password:secret}),open:()=>{throw Object.assign(Error('Missing login'),{code:'BROWSER_PAGE_UNAVAILABLE'});}});
 await f.approve();await f.ticks(24);assert.equal(f.run().error.code,'SOURCE_REPLACEMENTS_EXHAUSTED');assert.equal(f.run().skippedSites.length,10);assert.equal(f.selections.length,10);assert.equal(f.stats().creates,0);assert.equal(f.stats().writes,0);
});
test('an exhausted login document retry preserves the HTTP status in donor history',async t=>{
 const f=await fixture(t,{auto:true,open:(_service,_id,url)=>{
  if(url===origin)throw Object.assign(Error('Private server error'),{code:'BROWSER_PAGE_UNAVAILABLE',httpStatus:500});
 }});
 await f.approve();await f.ticks(12);
 const [skipped]=f.run().skippedSites;
 assert.equal(skipped.code,'BROWSER_PAGE_UNAVAILABLE');
 assert.equal(skipped.httpStatus,500);
 assert.doesNotMatch(JSON.stringify(skipped),/Private server error/);
});
test('manual and automatic donor plugin failures use visual fallback without replacing a working publication',async t=>{
 for(const auto of [false,true]){const f=await fixture(t,{auto,plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',...(auto?{}:{beforePageCreation:true})});}});await f.approve();await f.ticks(8);assert.equal(f.stats().creates,1);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.selections.length,auto?1:0);assert.equal(f.cleanupStats().trashes,0);}
});
test('replacement cannot approve content edited while plugin permissions were being checked',async t=>{
 const f=await fixture(t,{auto:true,plugins:(s,id)=>{const run=s.store.getRecord(id),page=s.store.getPage(run.pageId);s.store.updatePage(page.id,{title:'Changed while checking permissions'},page.revision);throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}});await f.approve();await f.ticks(8);assert.equal(f.run().state,'awaiting_review');assert.equal(f.run().error.code,'REVIEW_REQUIRED');assert.equal(f.stats().creates,0);assert.equal(f.selections.length,1);assert.equal(f.run().skippedSites.length,0);
});
test('preselected batch optional plugin state survives restart with the same content approval and page',async t=>{
 const f=await fixture(t,{auto:true,preselected:true,plugins:(s,id,url)=>{if(url===origin)throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}}),pageId=f.raw().pageId;
 assert.equal(f.raw().candidate.baseUrl,origin);await f.approve();const initial=f.raw().publicationApproval.materialHash;await f.ticks(2);assert.equal(f.raw().stage,'publishing');assert.equal(f.run().skippedSites.length,0);assert.ok(f.raw().nativePluginFallback);await f.restart();
 // Restart pauses uncompleted work; explicit continuation keeps the saved approval.
 if(f.run().state==='paused')await f.q('/autopilot/'+f.runId+'/resume',{});await f.ticks(10);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.raw().pageId,pageId);assert.equal(f.raw().publicationApproval.materialHash,initial);assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});
test('a rejected origin returned again by the source is fenced instead of looping or publishing',async t=>{
 const f=await fixture(t,{auto:true,pick:()=>({id:'same-site',baseUrl:origin,rowNumber:2,username:'admin',password:secret}),login:()=>{throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});}});await f.approve();await f.ticks(10);assert.equal(f.run().error.code,'SOURCE_RESERVED');assert.equal(f.run().skippedSites.length,1);assert.equal(f.stats().creates,0);
});
test('automatic donor replacement stops after ten confirmed broken publications',async t=>{
 let number=0;const f=await fixture(t,{auto:true,alternate:false,pick:()=>({id:'broken-'+(++number),baseUrl:'https://broken-'+number+'.example/',rowNumber:number+1,username:'admin',password:secret}),plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});},visualState:()=> 'problem'});await f.approve();await f.ticks(55);assert.equal(f.run().error.code,'SOURCE_REPLACEMENTS_EXHAUSTED');assert.equal(f.run().state,'needs_attention');assert.equal(f.run().skippedSites.length,10);assert.equal(f.selections.length,10);assert.equal(f.stats().creates,10);assert.equal(f.cleanupStats().trashes,10);assert.equal(f.service.store.getPage(f.raw().pageId).wpId,null);
});
test('native login tries only the supplied alternate after definite rejection',async t=>{
 const f=await fixture(t,{auto:true,login:auth=>{if(auth.username==='admin')throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});}});await f.approve();await f.ticks(10);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(f.logins,['admin','backup','backup']);assert.equal(f.selections.length,1);
});
test('a proven www login updates the destination and approval before installing or publishing',async t=>{
 for(const auto of [false,true]){const canonical='https://www.native-wordpress.example/',f=await fixture(t,{auto,preselected:auto,canonicalBaseUrl:canonical}),html=(await f.q('/autopilot/'+f.runId+'/html')).html;await f.approve();await f.ticks(10);
  assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.raw().candidate.baseUrl,canonical);assert.equal(f.service.store.getSite(f.raw().siteId).baseUrl,canonical);assert.equal(f.raw().publicationApproval.replacementPolicy,'canonical-login');assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);assert.equal(f.stats().writes,1);assert.equal(f.stats().creates,1);
 }
});
test('browser canonical metadata cannot authorize a different site',async t=>{
 const f=await fixture(t,{canonicalBaseUrl:'https://unrelated.example/'});await f.approve();await f.ticks(6);assert.equal(f.run().error?.code,'BROWSER_ORIGIN_BLOCKED');assert.equal(f.stats().creates,0);
});

test('a server-proven child installation updates the destination and approval before plugin work',async t=>{
 const alias='https://www.native-wordpress.example/',canonical=alias+'wp/',steps=[{kind:'redirect',from:origin+'wp-login.php',to:alias+'wp-login.php'},{kind:'redirect',from:alias+'wp-login.php',to:canonical+'wp-login.php'}];
 for(const auto of [false,true]){
  const f=await fixture(t,{auto,preselected:auto,canonicalBaseUrl:canonical,canonicalSteps:steps,plugins:(service,id)=>{const run=service.store.getRecord(id);assert.equal(run.candidate.baseUrl,canonical);assert.equal(run.publicationApproval.replacementPolicy,'canonical-login');assert.deepEqual(run.canonicalLogin.steps,steps);}}),html=(await f.q('/autopilot/'+f.runId+'/html')).html;
  await f.approve();await f.ticks(10);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.service.store.getSite(f.raw().siteId).baseUrl,canonical);assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);assert.equal(f.stats().writes,1);
 }
 const unproved=await fixture(t,{canonicalBaseUrl:canonical});await unproved.approve();await unproved.ticks(6);assert.equal(unproved.run().error?.code,'BROWSER_ORIGIN_BLOCKED');assert.equal(unproved.stats().creates,0);
});
test('publishing rejects a newly changed browser origin before creating any draft',async t=>{
 const f=await fixture(t,{publishCanonicalBaseUrl:'https://www.native-wordpress.example/'});await f.approve();await f.ticks(7);assert.equal(f.run().error?.code,'BROWSER_ORIGIN_BLOCKED');assert.equal(f.stats().creates,0);assert.equal(f.stats().writes,0);
});
test('manual selection respects active known aliases while preserving completed-site reuse',async t=>{
 for(const completed of [false,true]){const canonical='https://www.native-wordpress.example/',f=await fixture(t,completed?{canonicalBaseUrl:canonical}:{}),page=f.service.store.getPage(f.raw().pageId),other=f.service.store.createPage(f.project.id,{title:'Other reservation',config:page.config});
  f.service.store.createRecord(f.project.id,'autopilot',{state:completed?'completed':'paused',stage:completed?'completed':'installing',pageId:other.id,candidate:{id:'other-canonical',baseUrl:canonical},canonicalLogin:{requestedBaseUrl:origin,baseUrl:canonical},browserWindow:!completed},crypto.randomUUID());
  await f.approve();await f.ticks(8);if(completed){assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.stats().writes,1);}else{assert.equal(f.run().error?.code,'SOURCE_RESERVED');assert.equal(f.stats().creates,0);}
 }
});
test('unknown Add New outcome is durable and cannot create another draft after restart',async t=>{
 const f=await fixture(t,{loseDraftIdentity:true});await f.approve();await f.ticks();assert.equal(f.run().state,'uncertain');assert.deepEqual(f.raw().nativePublication,{postId:null,phase:'creating'});assert.equal(f.stats().creates,1);assert.equal(f.run().canSetDestination,false);
 await f.restart();await f.q('/autopilot/'+f.runId+'/resume',{});await f.ticks();assert.equal(f.run().state,'uncertain');assert.equal(f.stats().creates,1);assert.equal(f.stats().inspections,0);assert.equal(f.stats().writes,0);
});

test('a new creation proven not started clears its own durable checkpoint and resumes normally',async t=>{
 let denied=true;const f=await fixture(t,{beforeCreate:async input=>{await input.checkpoint({postId:null,phase:'creating'});if(denied){await input.checkpoint({postId:null,phase:'not_started',requestNotStarted:true});throw Object.assign(Error('DNS rejected before request'),{code:'unsafe_address',requestNotStarted:true,writeNotAttempted:true});}}});
 await f.approve();await f.ticks();assert.equal(f.raw().nativePublication,null);assert.notEqual(f.run().state,'uncertain');assert.equal(f.run().error.code,'unsafe_address');assert.equal(f.stats().creates,0);
 const queue=await f.q('/project-queue'),item=queue.projects.find(project=>project.projectId===f.project.id).items.find(item=>item.runId===f.runId);assert.equal(item.canRetry,true);
 denied=false;assert.equal((await f.q('/project-queue/items/'+item.id+'/retry',{})).status,200);await f.ticks();assert.equal(f.run().state,'completed');assert.equal(f.raw().nativeCreationNotStarted,false);assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:0});
});

test('a saved draft without a dispatch checkpoint can resume after reconciliation without a second page',async t=>{
 let stopped=true;
 const f=await fixture(t,{beforeDispatch:()=>{if(stopped)throw Object.assign(Error(),{code:'NATIVE_RESULT_UNCERTAIN',state:'needs_attention',writeNotAttempted:true});}});
 await f.approve();await f.ticks();
 const view=async()=>{const queue=await f.q('/project-queue');return queue.projects.find(project=>project.projectId===f.project.id).items.find(item=>item.runId===f.runId);};
 assert.deepEqual(f.raw().nativePublication,{postId:80,phase:'draft'});
 assert.equal((await view()).canRetry,true);
 const before=await f.q('/autopilot/'+f.runId+'/reconciliation');
 const result=await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:before.run.revision});
 assert.equal(result.observation,'draft');const item=await view();assert.equal(item.canRetry,true);
 stopped=false;
 assert.equal((await f.q('/project-queue/items/'+item.id+'/retry',{})).status,200);
 await f.ticks();assert.equal(f.run().state,'completed');
 assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});

test('publishing retry capability excludes unknown checkpoints, remote work and active fences',async t=>{
 const f=await fixture(t,{beforeCreate:async input=>{await input.checkpoint({postId:null,phase:'creating'});await input.checkpoint({postId:null,phase:'not_started',requestNotStarted:true});throw Object.assign(Error('not sent'),{code:'unsafe_address',requestNotStarted:true,writeNotAttempted:true});}});await f.approve();await f.ticks();
 const view=async()=>{const queue=await f.q('/project-queue');return queue.projects.find(project=>project.projectId===f.project.id).items.find(item=>item.runId===f.runId);};assert.equal((await view()).canRetry,true);
 const baseline=f.raw();for(const patch of [{nativeCreationNotStarted:false},{nativePublication:{postId:null,phase:'creating'}},{nativePublication:{postId:80,phase:'draft'}},{nativePublication:{postId:80,phase:'dispatching'}},{state:'uncertain'},{jobId:'legacy-job'},{leaseToken:'active',leaseUntil:new Date(Date.now()+60000).toISOString()},{browserPreparing:true,browserPreparingUntil:new Date(Date.now()+60000).toISOString()},{publicationMode:'legacy'}]){const current=f.raw();f.service.store.updateRecord(f.runId,{nativeCreationNotStarted:true,nativePublication:null,state:baseline.state,jobId:null,leaseToken:null,leaseUntil:null,browserPreparing:false,browserPreparingUntil:null,publicationMode:'native',...patch},current.revision);assert.equal((await view()).canRetry,false,JSON.stringify(patch));}
 const current=f.raw();f.service.store.updateRecord(f.runId,{publicationMode:'native'},current.revision);const page=f.service.store.getPage(current.pageId);f.service.store.updatePage(page.id,{wpId:80,fullUrl:origin+'published/'},page.revision);assert.equal((await view()).canRetry,false);
});

test('a timeout opening WordPress for a saved draft still permits publication of that draft',async t=>{
 let stopped=true,offline=false;
 const timeout=()=>Object.assign(Error('fixture timeout'),{code:'network_timeout'});
 const f=await fixture(t,{beforeDispatch:()=>{if(stopped)throw timeout();},open:()=>{if(offline)throw timeout();}});
 await f.approve();await f.ticks();
 const getItem=async()=>{const queue=await f.q('/project-queue');return queue.projects.find(project=>project.projectId===f.project.id).items.find(item=>item.runId===f.runId);};
 assert.equal((await getItem()).canRetry,true);
 // Older clients could ask for a read-only reconciliation here. Its failure
 // must not turn an unsent draft into an ambiguous publication.
 offline=true;
 const saved=await f.q('/autopilot/'+f.runId+'/reconciliation');
 const checked=await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:saved.run.revision});
 assert.equal(checked.observation,'unknown');assert.equal(f.raw().state,'uncertain');
 const item=await getItem();assert.equal(item.publication.checkpoint,'draft');assert.equal(item.publication.canReconcile,false);assert.equal(item.canRetry,true);
 assert.equal(f.stats().writes,0);
 stopped=false;offline=false;
 assert.equal((await f.q('/project-queue/items/'+item.id+'/retry',{})).status,200);
 await f.ticks();assert.equal(f.run().state,'completed');assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});

test('a rollback checkpoint cannot clear a historical unknown creation on resume',async t=>{
 let rollback=false;const f=await fixture(t,{loseDraftIdentity:true,beforeCreate:async input=>{if(rollback)await input.checkpoint({postId:null,phase:'not_started',requestNotStarted:true});}});await f.approve();await f.ticks();assert.equal(f.run().state,'uncertain');
 rollback=true;assert.equal((await f.q('/autopilot/'+f.runId+'/resume',{})).status,202);await f.ticks();assert.deepEqual(f.raw().nativePublication,{postId:null,phase:'creating'});assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,0);
});
test('a rejected primary keeps the same login window for the supplied alternate',async t=>{
 const f=await fixture(t,{auto:true,preselected:true,sameWindowSwitch:true,login:auth=>{if(auth.username==='admin')throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});}});await f.approve();await f.ticks(1);
 assert.equal(f.raw().candidateCredentialIndex,1);assert.equal(f.raw().browserWindow,true);assert.equal(f.run().state,'queued');assert.equal(f.raw().stage,'installing');assert.deepEqual(f.browserActions,[]);
 await f.ticks(8);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(f.logins,['admin','backup','backup']);assert.deepEqual(f.loginWindows,[1,1,1]);assert.deepEqual(f.browserActions,[]);assert.equal(f.stats().writes,1);
});
test('permission fallback isolates the alternate account in the same login window',async t=>{
 const accounts=[],f=await fixture(t,{auto:true,preselected:true,sameWindowSwitch:true,stickyLogin:true,plugins:(s,id,url,account)=>{accounts.push(account);if(account==='admin')throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}});await f.approve();await f.ticks(1);
 assert.equal(f.raw().candidateCredentialIndex,1);assert.equal(f.raw().browserWindow,true);assert.equal(f.run().state,'queued');assert.deepEqual(f.browserActions,['switch']);
 await f.ticks(8);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(accounts,['admin','backup']);assert.deepEqual(f.loginWindows,[1,1,1]);assert.deepEqual(f.browserActions,['switch']);assert.equal(f.run().skippedSites.length,0);assert.equal(f.stats().writes,1);
});
test('both rejected credential pairs replace the donor and publish the same approved HTML once',async t=>{
 const f=await fixture(t,{auto:true,login:(auth,url)=>{if(url===origin)throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});}}),pageId=f.raw().pageId,html=(await f.q('/autopilot/'+f.runId+'/html')).html;
 await f.approve();await f.ticks(12);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(f.logins,['admin','backup','admin','admin']);assert.deepEqual(f.loginWindows,[1,1,2,2]);assert.deepEqual(f.browserActions,['reset']);assert.equal(f.selections.length,2);assert.equal(f.run().skippedSites[0].code,'bootstrap_auth_failed');assert.equal(f.raw().pageId,pageId);assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);assert.equal(f.stats().writes,1);assert.equal(f.stats().creates,1);
});
test('manual challenge during plugin work resumes before optional plugin fallback',async t=>{
 let corrected=false;const accounts=[],f=await fixture(t,{auto:true,preselected:true,sameWindowSwitch:true,stickyLogin:true,plugins:(_s,_id,url,account)=>{accounts.push(account);if(!corrected)throw Object.assign(Error(),{code:'BROWSER_CAPTCHA_REQUIRED',state:'needs_attention'});throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}});const pageId=f.raw().pageId;await f.approve();await f.ticks(1);assert.equal(f.run().state,'needs_attention');assert.equal(f.run().error.code,'BROWSER_CAPTCHA_REQUIRED');assert.equal(f.stats().creates,0);corrected=true;assert.equal((await f.q('/autopilot/'+f.runId+'/resume',{})).status,202);await f.ticks(12);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(accounts,['admin','admin','backup']);assert.equal(f.raw().pageId,pageId);assert.equal(f.run().skippedSites.length,0);assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});
test('legacy browser adapters isolate a low-permission login before trying the alternate',async t=>{
 const accounts=[],f=await fixture(t,{auto:true,stickyLogin:true,plugins:(s,id,url,account)=>{accounts.push(account);if(account==='admin')throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}});await f.approve();await f.ticks(10);
 assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(f.logins,['admin','backup','backup']);assert.deepEqual(accounts,['admin','backup']);assert.deepEqual(f.browserActions,['reset']);assert.deepEqual(f.loginWindows,[1,2,2]);assert.equal(f.selections.length,1);assert.equal(f.run().skippedSites.length,0);assert.equal(f.stats().creates,1);
});
test('a usable account without plugin rights is retained when the other supplied account fails',async t=>{
 for(const primary of ['auth','permission']){const f=await fixture(t,{auto:true,login:(auth,url)=>{if(url===origin&&auth.username===(primary==='auth'?'admin':'backup'))throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});},plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}});await f.approve();await f.ticks(12);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(f.logins,primary==='auth'?['admin','backup','backup']:['admin','backup','admin','admin']);assert.equal(f.selections.length,1);assert.equal(f.run().skippedSites.length,0);assert.equal(f.stats().writes,1);}
});
test('one rejected credential pair with no alternate skips immediately without inventing another login',async t=>{
 const f=await fixture(t,{auto:true,alternate:false,login:(auth,url)=>{if(url===origin)throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});}});await f.approve();await f.ticks(10);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(f.logins,['admin','admin','admin']);assert.equal(f.selections.length,2);
});
test('uncertain login failures never try another account or change the donor',async t=>{
 const f=await fixture(t,{auto:true,login:()=>{throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true,uncertain:true});}});await f.approve();await f.ticks(8);assert.equal(f.run().state,'uncertain');assert.deepEqual(f.logins,['admin']);assert.equal(f.selections.length,1);assert.equal(f.stats().creates,0);
});
test('alternate credential pending after a permission denial survives restart without retrying the primary',async t=>{
 const f=await fixture(t,{auto:true,preselected:true,plugins:(s,id)=>{if(s.store.getRecord(id).candidateCredentialIndex===0)throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}});await f.approve();await f.ticks(1);assert.equal(f.raw().candidateCredentialIndex,1);assert.equal(f.raw().browserWindow,false);await f.restart();if(f.run().state==='paused')await f.q('/autopilot/'+f.runId+'/resume',{});await f.ticks(8);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(f.logins,['admin','backup','backup']);assert.equal(f.selections.length,0);assert.equal(f.run().skippedSites.length,0);
});
test('changed approved content blocks credential fallback after a rejected login',async t=>{
 const f=await fixture(t,{auto:true,login:()=>{const raw=f.raw(),page=f.service.store.getPage(raw.pageId);f.service.store.updatePage(page.id,{title:'Unapproved change during login'},page.revision);throw Object.assign(Error(),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});}});await f.approve();await f.ticks(8);assert.equal(f.run().state,'awaiting_review');assert.equal(f.run().error.code,'REVIEW_REQUIRED');assert.deepEqual(f.logins,['admin']);assert.equal(f.selections.length,1);assert.equal(f.run().skippedSites.length,0);assert.equal(f.stats().creates,0);
});
test('noindex, robots and visual problems remain published attention states without creating another page',async t=>{
 for(const issue of ['noindex','robots','visual']){const f=await fixture(t,{checkProblem:issue,visualProblem:issue==='visual'});await f.approve();await f.ticks(10);assert.equal(f.run().state,'needs_attention',issue);assert.equal(f.run().error.code,'CHECK_FAILED');assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);assert.equal(f.raw().stage,'checking');assert.equal(f.run().canSetDestination,false);}
});

test('a verified publication with a robots ban can explicitly release the queue without another write',async t=>{
 const f=await fixture(t,{checkProblem:'robots',checkCode:'crawl_disallowed'});
 await f.approve();await f.ticks();
 const current=async()=>{const queue=await f.q('/project-queue');return queue.projects.find(project=>project.projectId===f.project.id).items.find(item=>item.runId===f.runId);};
 const before=await current(),endpoint='/project-queue/items/'+before.id+'/continue-crawl-blocked';
 assert.equal(before.publication.state,'crawl_blocked');
 assert.equal(before.publication.canReconcile,false);
 assert.equal(before.canContinueQueue,true);
 assert.equal(f.service.autopilot.publicationTurn.owner().id,f.runId);
 assert.equal((await f.q(endpoint,{expectedRevision:before.publication.revision-1})).status,409);
 assert.equal((await f.q(endpoint,{expectedRevision:before.publication.revision})).status,200);
 const after=await current();
 assert.equal(after.publication.state,'crawl_blocked');
 assert.equal(after.verification.state,'problem');
 assert.equal(after.canContinueQueue,false);
 assert.equal(after.fullUrl,before.fullUrl);
 assert.equal(f.service.autopilot.publicationTurn.owner(),null);
 await f.restart();await f.ticks();
 assert.equal(f.service.autopilot.publicationTurn.owner(),null);
 assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);assert.equal(f.cleanupStats().trashes,0);
});
test('rechecking a confirmed publication refreshes the public result without opening the editor',async t=>{
 let reads=0;
 const options={checkProblem:'noindex',checkCode:'noindex_detected',checkRead:()=>{reads++;}};
 const f=await fixture(t,options);
 await f.approve();await f.ticks(8);
 assert.equal(f.run().state,'needs_attention');
 const oldJobId=f.raw().checkJobId,oldLogins=f.logins.length,expectedRevision=f.raw().revision;
 options.checkProblem=undefined;
 const endpoint='/autopilot/'+f.runId+'/reconcile';
 const result=await f.q(endpoint,{expectedRevision});
 assert.equal(result.status,200);assert.equal(result.observation,'published');
 assert.notEqual(f.raw().checkJobId,oldJobId);
 assert.equal((await f.q(endpoint,{expectedRevision})).status,409);
 await f.ticks(8);
 assert.equal(f.run().state,'completed');assert.equal(reads,2);
 assert.equal(f.logins.length,oldLogins);assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:0});
 assert.equal(f.service.autopilot.publicationTurn.owner(),null);
});

test('a manual public recheck cannot trash an already published fallback page',async t=>{
 let visual='ok';
 const f=await fixture(t,{plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_NOT_INSTALLED'});},checkProblem:'robots',checkCode:'crawl_disallowed',visualState:()=>visual});
 await f.approve();await f.ticks(8);
 assert.equal(f.run().state,'needs_attention');
 visual='problem';
 const result=await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:f.raw().revision});
 assert.equal(result.status,200);await f.ticks(8);
 assert.equal(f.run().state,'needs_attention');assert.equal(f.raw().nativePublication.phase,'published');
 assert.equal(f.cleanupStats().trashes,0);assert.equal(f.stats().writes,1);
});

for(const expired of [false,true])test('automatic replacement '+(expired?'refreshes an expired donor catalog':'reuses the fresh donor catalog')+' after the first site fails',async t=>{
 let now=Date.now();
 const f=await fixture(t,{auto:true,preselected:true,clock:()=>now,open:(_service,_id,url)=>{
  if(url===origin)throw Object.assign(Error('fixture timeout'),{code:'network_timeout'});
 }});
 assert.equal(f.raw().candidate.baseUrl,origin);
 await f.approve();if(expired)now+=61000;await f.ticks(12);
 assert.equal(f.run().state,'completed');assert.equal(f.run().selectedDomain,'https://replacement.example/');
 assert.equal(f.selections.length,expired?1:0);assert.equal(f.stats().writes,1);
});
test('native editor publishes the approved HTML without Bridge or application passwords and supports public checks',async t=>{
 const f=await fixture(t);await f.ticks(2);assert.equal(f.stats().writes,0);await f.approve();await f.ticks();assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.stats().writes,1);assert.equal(f.stats().creates,1);
 const page=f.service.store.getPage(f.raw().pageId),site=f.service.store.getSite(page.siteId);assert.equal(page.wpId,80);assert.equal(page.fullUrl,origin+'published/');assert.equal(site.hasCredential,false);assert.equal(f.raw().candidateCredential,null);assert.doesNotMatch(JSON.stringify(f.run()),/native-admin-password|nativePublication|ciphertext/);
 await f.q('/projects/'+f.project.id+'/check-pages',{});await f.ticks(3);assert.equal(f.service.store.getPage(page.id).verification.state,'ok');assert.equal(f.stats().writes,1);
});
test('lost native publish response reconciles the saved post ID after restart without creating or sending again',async t=>{
 let offline=true;const f=await fixture(t,{loseResponse:true,inspect:()=>{if(offline)throw Object.assign(Error(),{code:'network_timeout'});}});await f.approve();await f.ticks();assert.equal(f.run().state,'uncertain');assert.equal(f.raw().nativePublication.postId,80);assert.equal(f.raw().nativePublication.phase,'dispatching');assert.equal((await f.q('/autopilot/'+f.runId+'/destination',{baseUrl:'https://other.example/',username:'admin',password:secret})).status,409);
 offline=false;
 await f.restart();const summary=await f.q('/autopilot/'+f.runId+'/reconciliation');assert.equal(summary.status,200);const observed=await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:summary.run.revision});assert.equal(observed.status,200);assert.equal(observed.observation,'published');await f.ticks();assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:4});
});

test('lost native response automatically retries only exact-ID reads then checks the one publication',async t=>{
 const f=await fixture(t,{loseResponse:true,inspect:(_s,_id,_input,count)=>{if(count===1)throw Object.assign(Error('private-query nonce password'),{code:'network_timeout',httpStatus:503});}});await f.approve();await f.ticks(8);assert.equal(f.run().state,'completed');assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:2});assert.equal(f.run().publication.state,'published');assert.equal(f.run().publication.recovery.attempt,2);assert.ok(f.run().publication.diagnostics.some(d=>d.phase==='reconcile'&&d.code==='network_timeout'&&d.httpStatus===503));assert.doesNotMatch(JSON.stringify(f.run().publication),/private-query|nonce|password/);
});

test('a code-less lost response after dispatch automatically inspects its saved identity',async t=>{
 const f=await fixture(t,{loseResponse:'raw'});await f.approve();await f.ticks(7);assert.equal(f.run().state,'completed');assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:1});assert.doesNotMatch(JSON.stringify(f.run().publication),/private response/);assert.ok(f.run().publication.diagnostics.some(value=>value.phase==='publish'&&value.code==='NATIVE_RESULT_UNCERTAIN'));
});

test('native reconciliation is read-only, rejects stale revision and serializes concurrent checks',async t=>{
 let release,entered;const started=new Promise(r=>entered=r);const f=await fixture(t,{loseResponse:true,inspect:async(_s,_id,_input,count)=>{if(count<=3)throw Object.assign(Error(),{code:'network_timeout'});entered();await new Promise(r=>release=r);}});await f.approve();await f.ticks();const summary=await f.q('/autopilot/'+f.runId+'/reconciliation');assert.equal(summary.publication.canReconcile,true);assert.equal((await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:summary.run.revision-1})).status,409);
 const first=f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:summary.run.revision});await started;assert.equal((await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:summary.run.revision})).status,409);release();const result=await first;assert.equal(result.observation,'published');assert.equal(result.publication.state,'published_checking');assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:4});assert.equal(f.cleanupStats().trashes,0);
});

test('unknown creation read action never invents identity or creates again',async t=>{
 const f=await fixture(t,{loseDraftIdentity:true});await f.approve();await f.ticks();const summary=await f.q('/autopilot/'+f.runId+'/reconciliation');const result=await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:summary.run.revision});assert.equal(result.observation,'missing_identity');assert.equal(result.publication.postId,null);assert.equal(result.publication.state,'verification_unknown');assert.deepEqual(f.stats(),{creates:1,writes:0,inspections:0});
});

test('temporary public check read failure retries automatically with durable backoff on the same published page',async t=>{
 let checks=0,now=Date.now();const f=await fixture(t,{clock:()=>now,checkRead:()=>{checks++;if(checks===1)throw Object.assign(Error('secret provider'),{code:'network_timeout'});}});await f.approve();await f.ticks(6);assert.equal(f.run().state,'checking');assert.equal(f.run().publication.recovery.state,'waiting');assert.equal(checks,1);await f.restart();now+=1000;await f.ticks(6);assert.equal(f.run().state,'completed');assert.equal(checks,2);assert.deepEqual(f.stats(),{creates:1,writes:1,inspections:0});assert.ok(f.run().publication.diagnostics.some(d=>d.phase==='check'&&d.code==='network_timeout'));
});

test('public read recovery exhausts three observations, remains published and does not loop after restart',async t=>{
 let checks=0,now=Date.now();const f=await fixture(t,{clock:()=>now,checkRead:()=>{checks++;throw Object.assign(Error('private'),{code:'network_timeout'});}});await f.approve();await f.ticks(6);for(let i=0;i<3;i++){now+=1000;await f.ticks(4);}assert.equal(checks,3);assert.equal(f.run().state,'needs_attention');assert.equal(f.run().publication.state,'verification_unknown');assert.equal(f.run().publication.recovery.state,'exhausted');await f.restart();now+=1000;await f.ticks(5);assert.equal(checks,3);assert.equal(f.stats().writes,1);assert.equal(f.cleanupStats().trashes,0);
});

test('native read reconciliation fences destination or approval changes while awaiting proof',async t=>{
 for(const change of ['destination','content']){let offline=true;const f=await fixture(t,{loseResponse:true,inspect:(service,id)=>{if(offline)throw Object.assign(Error(),{code:'network_timeout'});const run=service.store.getRecord(id);if(change==='destination')service.store.updateRecord(id,{destinationRevision:(run.destinationRevision||0)+1},run.revision);else{const page=service.store.getPage(run.pageId);service.store.updatePage(page.id,{title:'Changed'},page.revision);}}});await f.approve();await f.ticks();offline=false;const current=await f.q('/autopilot/'+f.runId+'/reconciliation'),result=await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:current.run.revision});assert.equal(result.status,409,JSON.stringify(result));assert.equal(f.service.store.getPage(f.raw().pageId).wpId,null);assert.equal(f.stats().writes,1);}
});

test('a read-confirmed draft cannot authorize a second Publish after dispatch',async t=>{
 let draft=false;const f=await fixture(t,{loseResponse:true,inspect:()=>{throw Object.assign(Error(),{code:draft?'NATIVE_NOT_PUBLISHED':'network_timeout'});}});await f.approve();await f.ticks();draft=true;const before=await f.q('/autopilot/'+f.runId+'/reconciliation'),observed=await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:before.run.revision});assert.equal(observed.observation,'draft');assert.equal(observed.publication.state,'verification_unknown');assert.equal(observed.publication.postId,80);assert.equal(f.stats().writes,1);assert.equal(f.stats().creates,1);const continued=await f.q('/autopilot/'+f.runId+'/resume',{});assert.equal(continued.status,202);await f.ticks();assert.deepEqual(f.raw().nativePublication,{postId:80,phase:'dispatching'});assert.equal(f.raw().state,'uncertain');assert.equal(f.stats().writes,1);assert.equal(f.stats().creates,1);
});

test('saved dispatch without prior recovery never falls through a draft read into Publish',async t=>{
 let stopped=false;const f=await fixture(t,{beforeSend:()=>{if(!stopped){stopped=true;throw Object.assign(Error(),{code:'BROWSER_CLOSED'});}}});await f.approve();await f.ticks();assert.equal(f.raw().nativePublication.phase,'dispatching');assert.equal(f.raw().publicationRecovery??null,null);assert.equal(f.stats().writes,0);await f.q('/autopilot/'+f.runId+'/resume',{});await f.ticks();assert.equal(f.stats().writes,0);assert.equal(f.stats().creates,1);assert.equal(f.run().state,'uncertain');assert.equal(f.raw().nativePublication.phase,'dispatching');
});
test('native final send fences a changed page revision',async t=>{
 const f=await fixture(t,{beforeDispatch:(s,id)=>{const run=s.store.getRecord(id),page=s.store.getPage(run.pageId);s.store.updatePage(page.id,{title:'Unapproved title'},page.revision);}});await f.approve();await f.ticks();assert.equal(f.stats().writes,0);assert.notEqual(f.run().state,'completed');assert.equal(f.run().error.code,'REVIEW_REQUIRED');
});
test('project pause before send defers publication and resume uses the same draft exactly once',async t=>{
 let pause=true;const f=await fixture(t,{beforeSend:async(s,id)=>{if(pause){pause=false;const run=s.store.getRecord(id);await f.q('/projects/'+run.projectId+'/queue',{action:'pause'});}}});await f.approve();await f.ticks(8);assert.equal(f.stats().writes,0);assert.equal(f.stats().creates,1);assert.equal(f.raw().nativePublication.phase,'dispatching');
 await f.q('/projects/'+f.project.id+'/queue',{action:'resume'});await f.ticks(8);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});
test('native response with changed content never marks the page published',async t=>{
 const f=await fixture(t,{badContent:true});await f.approve();await f.ticks();assert.notEqual(f.run().state,'completed');assert.equal(f.service.store.getPage(f.raw().pageId).fullUrl,'');assert.equal(f.run().canSetDestination,false);
});
test('resume migrates a stopped pre-publication bootstrap failure preserving the prepared page',async t=>{
 const f=await fixture(t);await f.approve();await f.ticks(1);const raw=f.raw(),pageId=raw.pageId,html=(await f.q('/autopilot/'+f.runId+'/html')).html;
 f.service.store.updateRecord(raw.id,{state:'needs_attention',stage:'installing',bootstrapStage:'installing_plugins',error:{code:'bootstrap_plugin_missing'}},raw.revision);
 assert.equal((await f.q('/autopilot/'+f.runId+'/resume',{})).status,202);await f.ticks();assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.raw().pageId,pageId);assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);assert.equal(f.stats().writes,1);
});
test('native final send fences a lease stolen after dispatch checkpoint',async t=>{
 const f=await fixture(t,{beforeSend:(s,id)=>{const run=s.store.getRecord(id);s.store.updateRecord(id,{leaseToken:'another-worker',leaseUntil:new Date(Date.now()+180000).toISOString()},run.revision);}});await f.approve();await f.ticks();assert.equal(f.stats().writes,0);assert.equal(f.stats().creates,1);assert.equal(f.raw().nativePublication.phase,'dispatching');assert.equal(f.run().canSetDestination,false);
});
test('a confirmed native draft permits destination correction and clears its saved ID',async t=>{
 const f=await fixture(t,{beforeDispatch:()=>{throw Object.assign(Error(),{code:'BROWSER_CLOSED'});}});await f.approve();await f.ticks();assert.equal(f.raw().nativePublication.phase,'draft');assert.equal(f.run().canSetDestination,true);
 assert.equal((await f.q('/autopilot/'+f.runId+'/destination',{baseUrl:'https://new-native.example/',username:'admin',password:secret})).status,200);assert.equal(f.raw().nativePublication,null);assert.equal(f.raw().nativeSnapshot,null);assert.equal(f.run().state,'awaiting_review');assert.equal(f.stats().writes,0);
});
test('resuming a native draft keeps its ID and requires a fresh approval after local edits',async t=>{
 let stop=true;const f=await fixture(t,{beforeDispatch:()=>{if(stop){stop=false;throw Object.assign(Error(),{code:'BROWSER_CLOSED'});}}});await f.approve();await f.ticks();const page=f.service.store.getPage(f.raw().pageId);f.service.store.updatePage(page.id,{keyword:'Updated local note'},page.revision);
 assert.equal((await f.q('/autopilot/'+f.runId+'/resume',{})).status,400);assert.equal(f.run().state,'awaiting_review');await f.approve();await f.ticks();assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});
test('native migration refuses a legacy publication job that might have dispatched',async t=>{
 const f=await fixture(t);await f.approve();await f.ticks(1);const raw=f.raw();f.service.store.updateRecord(raw.id,{stage:'installing',state:'needs_attention',jobId:'legacy-dispatched-job'},raw.revision);
 assert.ok((await f.q('/autopilot/'+f.runId+'/resume',{})).status>=400);await f.ticks();assert.equal(f.stats().creates,0);assert.equal(f.stats().writes,0);
});
test('public-only native monitoring never probes REST and still detects stale text',async()=>{
 const {createWordPressClient}=await import('../server/lifecycle/wordpress.mjs');
 const expected='<div id="pp-landing"><h1>Fresh native content</h1></div>',requests=[];
 const client=createWordPressClient({transport:async(url,init)=>{requests.push(url);assert.equal(init?.headers?.Authorization,undefined);assert.ok(url===origin+'published/'||url===origin+'robots.txt');return {status:200,url,headers:{'content-type':'text/html'},text:url.endsWith('robots.txt')?'User-agent: *\nDisallow:':expected.replace('Fresh native','Stale cached')};}});
 const checks=await client.checkPage({publicOnly:true,site:{baseUrl:origin},page:{wpId:80,wpType:'page',fullUrl:origin+'published/',expectedUrls:[],expectedMarker:'pp-landing',remoteSnapshot:{mode:'browser',content:expected}}});
 assert.equal(checks.find(c=>c.kind==='content').state,'problem');for(const kind of ['wp_access','wp_content','wp_status'])assert.equal(checks.find(c=>c.kind===kind).state,'not_applicable');assert.equal(requests.length,2);
});
test('native publication respects published pages and queued legacy publication reservations',async t=>{
 for(const mode of ['published','queued'])await t.test(mode,async t=>{const f=await fixture(t,{maxPages:1}),s=f.service.store,site=s.createSite(f.project.id,{name:'Other site',baseUrl:'https://other.example/'}),page=s.createPage(f.project.id,{title:'Existing page',siteId:site.id,...(mode==='published'?{wpId:81}:{})});
  if(mode==='queued')s.enqueueJob({projectId:f.project.id,siteId:site.id,pageId:page.id,type:'publish',payload:{},idempotencyKey:crypto.randomUUID(),runAfter:new Date(Date.now()+600000).toISOString()});
  await f.approve();await f.ticks();assert.equal(f.run().error?.code,'CAPACITY_EXCEEDED');assert.equal(f.stats().creates,0);assert.equal(f.stats().writes,0);
 });
});
test('native draft reservation survives restart and blocks legacy admission without double-counting its own page',async t=>{
 let stop=true;const f=await fixture(t,{maxPages:1,beforeDispatch:()=>{if(stop){stop=false;throw Object.assign(Error(),{code:'BROWSER_CLOSED'});}}});await f.approve();await f.ticks();await f.restart();const s=f.service.store,site=s.getSite(f.raw().siteId),page=s.createPage(f.project.id,{title:'Other queued page',siteId:site.id});
 assert.throws(()=>s.enqueueJob({projectId:f.project.id,siteId:site.id,pageId:page.id,type:'publish',payload:{},idempotencyKey:crypto.randomUUID(),maxPages:1}),{code:'CAPACITY_EXCEEDED'});
 assert.throws(()=>s.createCampaign(f.project.id,{idempotencyKey:crypto.randomUUID(),requestHash:'a'.repeat(64),name:'Over capacity campaign',status:'publish',maxPages:1,entries:[{page:{title:'Campaign page',siteId:site.id},launch:{status:'publish'},generation:{}}]}),{code:'CAPACITY_EXCEEDED'});
 assert.equal((await f.q('/autopilot/'+f.runId+'/resume',{})).status,202);await f.ticks();assert.equal(f.run().state,'completed');assert.equal(f.stats().creates,1);assert.equal(f.stats().writes,1);
});
test('native service blocks dispatch of a legacy autopilot publication job',async t=>{
 const f=await fixture(t),s=f.service.store;const raw=f.raw(),site=s.createSite(f.project.id,{name:'Old site',baseUrl:origin});s.updatePage(raw.pageId,{siteId:site.id},s.getPage(raw.pageId).revision);
 const job=s.enqueueJob({projectId:f.project.id,siteId:site.id,pageId:raw.pageId,type:'publish',payload:{},idempotencyKey:crypto.randomUUID()});s.updateRecord(raw.id,{jobId:job.id,siteId:site.id,stage:'publishing',state:'needs_attention'},raw.revision);
 assert.throws(()=>f.service.autopilot.beforeRemoteWrite({...job,attempt:1}),error=>error.code==='NATIVE_LEGACY_PUBLICATION'&&error.writeNotAttempted===true);
 await f.service.tick();assert.equal(s.getJob(job.id).error.code,'NATIVE_LEGACY_PUBLICATION');assert.equal(s.getJob(job.id).result.writeNotAttempted,true);
});

// Optional-plugin publication policy: only conclusive layout failure may clean up.
test('desktop-only fallback keeps a visually correct publication without a mobile result',async t=>{
 const f=await fixture(t,{auto:true,alternate:false,plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});}});await f.approve();await f.ticks(9);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.stats().writes,1);assert.equal(f.cleanupStats().trashes,0);assert.equal(f.selections.length,1);assert.equal(f.raw().candidateCredential,null);assert.equal(f.service.store.getSite(f.raw().siteId).plugins.cleanLinks.state,'unavailable');
});
test('desktop-only broken publication is trashed before a new donor publishes the same approved page',async t=>{
 const f=await fixture(t,{auto:true,preselected:true,alternate:false,maxPages:1,plugins:(s,id,url)=>{if(url===origin)throw Object.assign(Error(),{code:'CLEAN_LINKS_NOT_INSTALLED'});},visualState:r=>r.candidate.baseUrl===origin?'problem':'ok'}),id=f.raw().pageId,html=(await f.q('/autopilot/'+f.runId+'/html')).html;await f.approve();await f.ticks(15);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.raw().pageId,id);assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,html);assert.equal(f.stats().writes,2);assert.equal(f.cleanupStats().trashes,1);assert.equal(f.selections.length,0);assert.equal(f.raw().destinationHistory[0].nativeCleanup.phase,'trashed');assert.equal(f.service.store.getPage(id).fullUrl,'https://replacement.example/published/');assert.equal(f.raw().publicationApproval.pageRevision,f.raw().nativeSnapshot.pageRevision);
});
test('unknown or incomplete fallback visual evidence never trashes or changes donor',async t=>{
 for(const missing of [false,true]){const f=await fixture(t,{auto:true,alternate:false,plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_NOT_INSTALLED'});},visualState:()=>missing?'problem':'unknown',...(missing?{visualEvidence:()=>({state:'problem',code:'fixture',viewports:[{name:'mobile',state:'problem',code:'fixture'}]})}:{})});await f.approve();await f.ticks(9);assert.equal(f.run().state,'needs_attention',JSON.stringify(f.run()));assert.equal(f.run().error.code,'NATIVE_VISUAL_UNCONFIRMED');assert.equal(f.cleanupStats().trashes,0);assert.equal(f.selections.length,1);assert.ok(f.service.store.getPage(f.raw().pageId).wpId);}
});
test('ambiguous trash dispatch resumes by confirming the same page before donor replacement',async t=>{
 let lost=true,offline=true;const f=await fixture(t,{auto:true,alternate:false,plugins:(s,id,url)=>{if(url===origin)throw Object.assign(Error(),{code:'CLEAN_LINKS_NOT_INSTALLED'});},visualState:r=>r.candidate.baseUrl===origin?'problem':'ok',inspectTrash:()=>{if(offline)throw Object.assign(Error(),{code:'network_timeout'});},afterTrash:()=>{if(lost){lost=false;throw Object.assign(Error(),{code:'NATIVE_TRASH_UNCERTAIN',uncertain:true});}}});await f.approve();await f.ticks(10);assert.equal(f.run().state,'uncertain');assert.equal(f.raw().nativeCleanup.phase,'dispatching');assert.equal(f.cleanupStats().trashes,1);assert.equal(f.selections.length,1);const checkId=f.raw().checkJobId;await f.restart();offline=false;const current=await f.q('/autopilot/'+f.runId+'/reconciliation'),observed=await f.q('/autopilot/'+f.runId+'/reconcile',{expectedRevision:current.run.revision});assert.equal(observed.observation,'trashed');assert.equal(f.selections.length,1);assert.equal(f.cleanupStats().trashes,1);assert.equal((await f.q('/autopilot/'+f.runId+'/resume',{})).status,202);assert.equal(f.raw().checkJobId,checkId);await f.ticks(12);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.cleanupStats().trashes,1);assert.equal(f.stats().writes,2);
});

test('unknown Trash response automatically proves the owned row without replaying Trash',async t=>{
 let lost=true,proofs=0;const f=await fixture(t,{auto:true,alternate:false,plugins:(_s,_id,url)=>{if(url===origin)throw Object.assign(Error(),{code:'CLEAN_LINKS_NOT_INSTALLED'});},visualState:r=>r.candidate.baseUrl===origin?'problem':'ok',inspectTrash:()=>{proofs++;},afterTrash:()=>{if(lost){lost=false;throw Object.assign(Error(),{code:'NATIVE_TRASH_UNCERTAIN',uncertain:true});}}});await f.approve();await f.ticks(12);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.cleanupStats().trashes,1);assert.equal(proofs,1);assert.equal(f.stats().writes,2);assert.equal(f.selections.length,2);
});

test('installation-local raw timeout or missing package uses optional plugin fallback',async t=>{
 for(const kind of ['timeout','package']){const f=await fixture(t,{plugins:()=>{const e=Error('private path and details');if(kind==='timeout')e.name='TimeoutError';else e.code='ENOENT';throw e;}});await f.approve();await f.ticks(8);assert.equal(f.run().state,'completed',JSON.stringify(f.run()));assert.equal(f.stats().writes,1);assert.doesNotMatch(JSON.stringify(f.run()),/private path and details/);}
});
test('stale successful visual evidence cannot be replaced with a later monitoring aggregate',async t=>{
 const f=await fixture(t,{plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_NOT_INSTALLED'});}});await f.approve();await f.ticks(3);assert.equal(f.raw().stage,'checking');const page=f.service.store.getPage(f.raw().pageId),changed=f.service.store.updatePage(page.id,{title:'Changed after exact visual check'},page.revision);f.service.store.observeChecks(page.id,[{kind:'monitor',state:'ok'}],changed.revision);await f.ticks(2);assert.equal(f.run().state,'needs_attention');assert.equal(f.run().error.code,'NATIVE_VISUAL_UNCONFIRMED');assert.equal(f.cleanupStats().trashes,0);assert.ok(f.raw().candidateCredential);
});
test('broken manual-donor page is cleaned and retains its destination for explicit review',async t=>{
 const f=await fixture(t,{plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_NOT_INSTALLED'});},visualState:()=> 'problem'});await f.approve();const target=f.raw().manualTarget;await f.ticks(8);assert.equal(f.run().state,'needs_attention',JSON.stringify(f.run()));assert.equal(f.run().error.code,'NATIVE_VISUAL_REJECTED');assert.deepEqual(f.raw().manualTarget,target);assert.equal(f.raw().candidate.baseUrl,target.baseUrl);assert.equal(f.raw().publicationApproval,null);assert.equal(f.cleanupStats().trashes,1);assert.equal(f.service.store.getPage(f.raw().pageId).wpId,null);assert.equal(f.raw().nativePublication,null);assert.equal(f.run().canSetDestination,true);
});
test('project pause before cleanup prevents trash and donor change',async t=>{
 const f=await fixture(t,{auto:true,alternate:false,plugins:()=>{throw Object.assign(Error(),{code:'CLEAN_LINKS_NOT_INSTALLED'});},visualState:()=> 'problem',beforeTrash:async()=>{await f.q('/projects/'+f.project.id+'/queue',{action:'pause'});}});await f.approve();await f.ticks(8);assert.equal(f.run().state,'paused',JSON.stringify(f.run()));assert.equal(f.cleanupStats().trashes,0);assert.equal(f.selections.length,1);assert.equal(f.raw().nativeCleanup.phase,'prepared');
});
