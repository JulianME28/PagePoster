const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const G=require('../dist/generator.js');
const links=[{url:'https://destination.example/?a=%2f&b=1#keep',anchor:'Точный анкор | [пример]'}];
const sourceConfig={spreadsheetId:'fixtureSheetId12345',range:'Sites!A1:D100',serviceAccount:{client_email:'test@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----fixture-----END PRIVATE KEY-----'},columns:{url:'A',username:'B',password:'C',enabled:'D'}};
async function fixture(t,options={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),{bridgeContentHash}=await import('../server/lifecycle/bridge-client.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-autopilot-'));let generated=0,installed=0,writes=0,checkCalls=0,sourceCalls=0;
 const planner={generate:async input=>{generated++;if(options.delay)await options.delay();if(options.failAI)throw Object.assign(Error(),{code:'AI_RESULT_UNCERTAIN',uncertain:true});return {config:{...G.DEFAULT_DATA,title:'AI creates this title',brand:'AI guide',language:'ru',cards:input.links.map(l=>({name:l.anchor,url:l.url,logoUrl:l.url,button:'Открыть',bonus:'Описание ИИ',rating:''})),sections:[{title:'AI section',body:'AI article'}],moreCards:[],tiles:[],services:[],reviews:[],faq:[],navLinks:[],brandUrl:input.links[0].url,footerBrandUrl:input.links[0].url,colors:{background:'#F5F9FA',header:'#112233',card:'#123456',accent:'#ffcc55'}},topic:'AI topic',quality:{state:'passed',generatedTextFingerprint:crypto.createHash('sha256').update(input.requestId).digest('hex')}};}};
 const source={pickUnused:async(config,used)=>{sourceCalls++;if(options.sourceDelay)await options.sourceDelay();assert.equal(config.serviceAccount.clientEmail,sourceConfig.serviceAccount.client_email);return options.noSites?null:{id:'sheet:row2',baseUrl:'https://fixture-wordpress.example/',username:'fixture-user',password:'fixture-admin-secret',rowNumber:2};}};
 const bootstrapFactory=({checkpoint})=>({ensureReady:async args=>{installed++;if(options.installDelay)await options.installDelay();assert.equal(args.password,'fixture-admin-secret');await checkpoint({operationId:args.operationId,stage:'credential_created',credential:{username:'fixture-user',applicationPassword:'fixture-api-secret'}});if(options.bootstrapStop)throw Object.assign(Error(),{code:'bootstrap_two_factor',state:'needs_attention'});return {state:'ready',username:'fixture-user',applicationPassword:'fixture-api-secret'};}});
 const bridge={checkStatus:async()=>({ready:true,integrityVerified:true,integrity:{bridge:true,cleanLinks:true}}),getOperation:async({operationId})=>({state:'not_found',operationId}),submitOperation:async({operation})=>{writes++;if(options.failWriteOnce&&writes===1)throw Object.assign(Error(),{code:'authentication_failed'});return {state:'completed',postId:71,postType:'page',status:'publish',contentHash:bridgeContentHash(operation),url:'https://fixture-wordpress.example/new-page/'};}};
 const runtimeOptions={dataDir:dir,masterKey:Buffer.alloc(32,29).toString('base64'),bridgeClient:bridge,autopilotOptions:{planner,source,bootstrapFactory},browserVerifier:{verifyGenerated:async()=>{if(options.verifierDelay)await options.verifierDelay();return {layoutState:'ok',viewports:[]};},verifyPublished:async()=>({state:options.unknownCheck?'unknown':'ok',viewports:[],evidence:'fixture'})},client:{checkSite:async()=>({state:'ok',apiRoot:'https://fixture-wordpress.example/wp-json/',capabilities:{publishPages:true},plugins:{bridge:{compatible:true},cleanLinks:{compatible:true}}}),checkPage:async()=>{checkCalls++;return ['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'fixture'}));}}};
 let service=await createLifecycleService(runtimeOptions);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});const project=service.store.createProject({name:'Fixture project'});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost:4317/api/lifecycle'+route,{method:body?'POST':'GET',headers:{Origin:'http://localhost:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));return {status:response.status,...await response.json()};};
 return {get a(){return service;},q,project,dir,counters:()=>({generated,installed,writes,checkCalls,sourceCalls}),restart:async()=>{await service.close();service=await createLifecycleService(runtimeOptions);},launch:async(extra={})=>q('/projects/'+project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),links,reviewBeforePublish:true,...extra})};
}

const runFor=(f,id)=>f.a.autopilot.list(f.project.id).find(run=>run.id===id);
const view=(f,id)=>f.q('/autopilot/'+id+'/html');
const approve=(f,id,reviewToken)=>f.q('/autopilot/'+id+'/approve',{reviewToken});
const advance=async(f,count=10)=>{for(let index=0;index<count;index++)await f.a.tick();};

test('review gate saves AI HTML but performs no source selection, bootstrap or write before approval',async t=>{
 const f=await fixture(t);await f.q('/autopilot/source',sourceConfig);
 const launch=await f.launch();assert.equal(launch.status,202);assert.equal(launch.run.reviewBeforePublish,true);const id=launch.run.id;
 await advance(f);const run=runFor(f,id);
 assert.equal(run.state,'awaiting_review');assert.equal(run.stage,'selecting');assert.equal(run.canApprove,true);assert.equal(run.hasHtml,true);
 assert.deepEqual(f.counters(),{generated:1,installed:0,writes:0,checkCalls:0,sourceCalls:0});
 assert.equal(f.a.store.listPages(f.project.id).length,1);assert.equal(f.a.store.listJobs(f.project.id).length,0);
 const preview=await view(f,id);assert.equal(preview.status,200);assert.match(preview.html,/AI creates this title/);assert.match(preview.reviewToken,/^[a-f0-9]{64}$/);
 const standalone=await f.a.handle(new Request('http://localhost:4317/api/lifecycle/autopilot/'+id+'/preview'));
 assert.match(standalone.headers.get('Content-Security-Policy'),/sandbox allow-scripts;/);
 assert.match(standalone.headers.get('Content-Security-Policy'),/font-src[^;]*data:/,'Standalone preview must load fonts embedded in the imported HTML package');
 assert.doesNotMatch(standalone.headers.get('Content-Security-Policy'),/allow-popups|allow-same-origin/);
 assert.match(await standalone.text(),/data-pp-preview-navigation/);
 assert.doesNotMatch(preview.html,/data-pp-preview-navigation/);
 assert.doesNotMatch(JSON.stringify(run),/reviewToken|publicationApproval|candidateCredential|approvedHtmlHash/);
});

test('approving the exact preview publishes the same run once and repeated approval is idempotent',async t=>{
 const f=await fixture(t);await f.q('/autopilot/source',sourceConfig);const launched=await f.launch();assert.equal(launched.status,202);const id=launched.run.id;
 await f.a.tick();const preview=await view(f,id),accepted=await approve(f,id,preview.reviewToken);
 assert.equal(accepted.status,202);assert.equal(accepted.run.id,id);assert.equal(accepted.run.state,'queued');assert.equal(accepted.run.canApprove,false);
 assert.equal((await approve(f,id,preview.reviewToken)).status,202);
 await advance(f);assert.equal(runFor(f,id).state,'completed');assert.equal((await approve(f,id,preview.reviewToken)).status,202);await advance(f,3);
 assert.deepEqual(f.counters(),{generated:1,installed:1,writes:1,checkCalls:1,sourceCalls:1});assert.equal(f.a.store.listPages(f.project.id).length,1);
});

test('approval rejects a missing or stale token after content and revision-only edits',async t=>{
 const f=await fixture(t),launched=await f.launch();assert.equal(launched.status,202);const id=launched.run.id;await f.a.tick();const initial=await view(f,id);
 for(const token of [undefined,'not-the-preview']){const rejected=await approve(f,id,token);assert.equal(rejected.status,400);assert.equal(rejected.code,'REVIEW_REQUIRED');}
 let page=f.a.store.getPage(runFor(f,id).pageId);f.a.store.updatePage(page.id,{config:{...page.config,title:'Changed after preview'}},page.revision);
 assert.equal((await approve(f,id,initial.reviewToken)).code,'REVIEW_REQUIRED');const revised=await view(f,id);assert.notEqual(revised.reviewToken,initial.reviewToken);
 page=f.a.store.getPage(page.id);f.a.store.updatePage(page.id,{keyword:'Revision-only edit'},page.revision);
 assert.equal((await approve(f,id,revised.reviewToken)).code,'REVIEW_REQUIRED');const current=await view(f,id);assert.equal(current.html,revised.html);assert.notEqual(current.reviewToken,revised.reviewToken);
 assert.equal((await approve(f,id,current.reviewToken)).status,202);assert.equal(f.counters().generated,1);assert.equal(f.counters().writes,0);
});

test('restart preserves pending review and ordinary resume or source configuration cannot approve it',async t=>{
 const f=await fixture(t),launched=await f.launch();assert.equal(launched.status,202);const id=launched.run.id;await f.a.tick();const preview=await view(f,id);await f.restart();
 assert.equal(runFor(f,id).state,'awaiting_review');assert.equal((await view(f,id)).reviewToken,preview.reviewToken);
 const resumed=await f.q('/autopilot/'+id+'/resume',{});assert.equal(resumed.code,'REVIEW_REQUIRED');
 await f.q('/autopilot/source',sourceConfig);await advance(f,4);assert.equal(runFor(f,id).state,'awaiting_review');assert.equal(f.counters().sourceCalls,0);
 assert.equal((await approve(f,id,preview.reviewToken)).status,202);await f.restart();await advance(f);assert.equal(runFor(f,id).state,'completed');assert.equal(f.counters().generated,1);assert.equal(f.counters().writes,1);
});

test('approved page waits for source and connection resumes only that approval',async t=>{
 const f=await fixture(t),launched=await f.launch();assert.equal(launched.status,202);const id=launched.run.id;await f.a.tick();const preview=await view(f,id);assert.equal((await approve(f,id,preview.reviewToken)).status,202);await f.a.tick();
 assert.equal(runFor(f,id).state,'waiting_source');await f.q('/autopilot/source',sourceConfig);await advance(f);assert.equal(runFor(f,id).state,'completed');assert.equal(f.counters().writes,1);
});

test('approval is checked again before selection, installation and publication after page drift',async t=>{
 for(const stage of ['selecting','installing','publishing'])await t.test(stage,async t=>{
  const f=await fixture(t);await f.q('/autopilot/source',sourceConfig);const launched=await f.launch();assert.equal(launched.status,202);const id=launched.run.id;await f.a.tick();const preview=await view(f,id);assert.equal((await approve(f,id,preview.reviewToken)).status,202);
  if(stage!=='selecting')await f.a.tick();if(stage==='publishing')await f.a.tick();assert.equal(runFor(f,id).stage,stage);await f.restart();
  const page=f.a.store.getPage(runFor(f,id).pageId);f.a.store.updatePage(page.id,{title:'Changed publication title'},page.revision);await f.a.tick();
  const stopped=runFor(f,id);assert.equal(stopped.state,'awaiting_review');assert.equal(stopped.error.code,'REVIEW_REQUIRED');assert.equal(stopped.jobId,null);assert.equal(stopped.canApprove,true);
  assert.equal((await approve(f,id,preview.reviewToken)).code,'REVIEW_REQUIRED');assert.equal((await f.q('/autopilot/'+id+'/resume',{})).code,'REVIEW_REQUIRED');
  assert.equal(f.counters().sourceCalls,stage==='selecting'?0:1);assert.equal(f.counters().installed,stage==='publishing'?1:0);assert.equal(f.counters().writes,0);
  const refreshed=await view(f,id);assert.equal((await approve(f,id,refreshed.reviewToken)).status,202);await advance(f);assert.equal(runFor(f,id).state,'completed');assert.equal(f.counters().generated,1);assert.equal(f.counters().writes,1);
 });
});

test('customer input proof does not replace the final prepared page approval',async t=>{
 const f=await fixture(t);await f.q('/autopilot/source',sourceConfig);const input={source:'html',html:'<h1>Customer heading</h1><p>Exact original copy</p>',chromeMode:'overlay-only'},preview=await f.q('/autopilot/preview',input);
 const launch=await f.q('/projects/'+f.project.id+'/autopilot',{...input,idempotencyKey:crypto.randomUUID(),reviewBeforePublish:true,reviewToken:preview.reviewToken});assert.equal(launch.status,202);const id=launch.run.id;
 await advance(f,4);assert.equal(runFor(f,id).state,'awaiting_review');assert.equal((await approve(f,id,preview.reviewToken)).code,'REVIEW_REQUIRED');assert.equal(f.counters().installed,0);assert.equal(f.counters().writes,0);
 const prepared=await view(f,id);assert.equal((await approve(f,id,prepared.reviewToken)).status,202);await advance(f);assert.equal(runFor(f,id).state,'completed');assert.equal(f.counters().generated,0);assert.equal(f.counters().writes,1);
});

test('new opt-in participates in launch identity while absent and false retain legacy replay',async t=>{
 const f=await fixture(t),route='/projects/'+f.project.id+'/autopilot',body={idempotencyKey:crypto.randomUUID(),links};
 const old=await f.q(route,body);assert.equal(old.status,202);assert.equal((await f.q(route,{...body,reviewBeforePublish:false})).run.id,old.run.id);
 assert.equal((await f.q(route,{...body,reviewBeforePublish:true})).code,'CONFLICT');
 const gated=await f.launch();assert.equal(gated.status,202);assert.equal((await f.q(route,{idempotencyKey:gated.run.id,links})).code,'CONFLICT');
 assert.equal((await f.launch({reviewBeforePublish:'true'})).code,'VALIDATION');await advance(f,4);assert.equal(runFor(f,old.run.id).state,'waiting_source');assert.equal(runFor(f,gated.run.id).state,'awaiting_review');
});

test('a token belongs only to its own prepared run',async t=>{
 const f=await fixture(t),first=await f.launch(),second=await f.launch();assert.equal(first.status,202);assert.equal(second.status,202);await advance(f,2);
 const a=await view(f,first.run.id),b=await view(f,second.run.id);assert.notEqual(a.reviewToken,b.reviewToken);assert.equal((await approve(f,second.run.id,a.reviewToken)).code,'REVIEW_REQUIRED');assert.equal(runFor(f,second.run.id).state,'awaiting_review');
});


test('publication verifies the same rendered snapshot that is enqueued',async t=>{
 const f=await fixture(t);await f.q('/autopilot/source',sourceConfig);const {run}=await f.launch();await f.a.tick();const preview=await view(f,run.id);await approve(f,run.id,preview.reviewToken);await advance(f,2);
 assert.equal(runFor(f,run.id).stage,'publishing');
 const {rendererWindow}=await import('../server/lifecycle/render.mjs'),api=rendererWindow.PagePoster,original=api.renderSnippet;let calls=0;
 try{api.renderSnippet=config=>{const html=original(config);return ++calls===2?html.replace('AI article','Unreviewed render'):html;};await f.a.autopilot.tick();}finally{api.renderSnippet=original;}
 assert.equal(runFor(f,run.id).state,'awaiting_review');assert.equal(runFor(f,run.id).jobId,null);assert.equal(f.a.store.listJobs(f.project.id).length,0);assert.equal(f.counters().writes,0);
});

test('in-flight selection cannot reserve a site or install after the approved page changes',async t=>{
 let enter,release;const entered=new Promise(resolve=>enter=resolve),hold=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{sourceDelay:async()=>{enter();await hold;}});await f.q('/autopilot/source',sourceConfig);const {run}=await f.launch();await f.a.tick();const preview=await view(f,run.id);await approve(f,run.id,preview.reviewToken);
 const pending=f.a.tick();await entered;
 try{assert.equal((await approve(f,run.id,preview.reviewToken)).status,202);const page=f.a.store.getPage(runFor(f,run.id).pageId);f.a.store.updatePage(page.id,{config:{...page.config,title:'Changed during selection'}},page.revision);const changed=await view(f,run.id);assert.equal((await approve(f,run.id,changed.reviewToken)).code,'CONFLICT');assert.equal((await f.q('/autopilot/'+run.id+'/resume',{})).code,'CONFLICT');}finally{release();await pending;}
 const saved=runFor(f,run.id);assert.equal(saved.state,'awaiting_review');assert.equal(saved.selectedDomain,'');assert.equal(f.counters().installed,0);assert.equal(f.counters().writes,0);
});

test('the write worker rejects page changes after approval and enqueue but before remote dispatch',async t=>{
 let enter,release;const entered=new Promise(resolve=>enter=resolve),hold=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{verifierDelay:async()=>{enter();await hold;}});await f.q('/autopilot/source',sourceConfig);const {run}=await f.launch();await f.a.tick();const preview=await view(f,run.id);await approve(f,run.id,preview.reviewToken);await advance(f,2);
 const pending=f.a.tick();await entered;try{const page=f.a.store.getPage(runFor(f,run.id).pageId);f.a.store.updatePage(page.id,{config:{...page.config,title:'Changed before remote dispatch'}},page.revision);}finally{release();await pending;}
 await f.a.tick();const saved=runFor(f,run.id),failed=f.a.store.listJobs(f.project.id).find(job=>job.type==='publish');assert.equal(saved.state,'awaiting_review');assert.equal(saved.jobId,null);assert.equal(failed.error.code,'CONFLICT');assert.equal(failed.result.writeNotAttempted,true);assert.equal((await approve(f,run.id,preview.reviewToken)).code,'REVIEW_REQUIRED');assert.equal(f.counters().writes,0);
});

test('full backup restore preserves pending review and pauses approved work until manual resume',async t=>{
 const f=await fixture(t);const pending=await f.launch(),approved=await f.launch();await advance(f,2);const preview=await view(f,approved.run.id);await approve(f,approved.run.id,preview.reviewToken);
 const {createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');createAIBudget({filename:path.join(f.dir,'ai-budget.sqlite')}).close();
 const {exportFullBackup,restoreFullBackup}=await import('../server/lifecycle/full-recovery.mjs'),{createStore}=await import('../server/lifecycle/store.mjs'),{createAutopilot}=await import('../server/lifecycle/autopilot.mjs');
 const key=Buffer.alloc(32,29).toString('base64'),newKey=Buffer.alloc(32,32).toString('base64'),passphrase='Fixture preview gate recovery';const backup=await exportFullBackup({dataDir:f.dir,masterKey:key,passphrase});
 const target=fs.mkdtempSync(path.join(os.tmpdir(),'pp-autopilot-preview-restored-'));t.after(()=>{assert.ok(path.resolve(target).startsWith(path.resolve(os.tmpdir())+path.sep+'pp-autopilot-preview-restored-'));fs.rmSync(target,{recursive:true,force:true});});await restoreFullBackup({dataDir:target,masterKey:newKey,backup,passphrase});
 const store=createStore({filename:path.join(target,'pageposter.sqlite'),masterKey:newKey});try{
  const autopilot=await createAutopilot({store,dataDir:target,masterKey:newKey,planner:{generate:async()=>assert.fail('restore must not generate again')},source:{pickUnused:async()=>assert.fail('restore must not select automatically')}});
  const find=id=>autopilot.list(f.project.id).find(run=>run.id===id);assert.equal(find(pending.run.id).state,'awaiting_review');assert.equal(find(pending.run.id).canApprove,true);assert.equal(find(approved.run.id).state,'paused');assert.equal(await autopilot.tick(),null);
  assert.equal(autopilot.approve(approved.run.id,{reviewToken:preview.reviewToken}).state,'paused','duplicate approval cannot bypass restoration pause');
  await assert.rejects(()=>autopilot.resume(pending.run.id),{code:'REVIEW_REQUIRED'});assert.equal((await autopilot.resume(approved.run.id)).state,'queued');await autopilot.tick();assert.equal(find(approved.run.id).state,'waiting_source');assert.equal(find(pending.run.id).state,'awaiting_review');
 }finally{store.close();}
});


test('replayed approval rejects a revision-only edit after enqueue and after publication',async t=>{
 for(const finished of [false,true])await t.test(finished?'completed':'queued',async t=>{
  const f=await fixture(t);await f.q('/autopilot/source',sourceConfig);const {run}=await f.launch();await f.a.tick();const preview=await view(f,run.id);await approve(f,run.id,preview.reviewToken);await advance(f,2);await f.a.autopilot.tick();if(finished)await advance(f);
  assert.equal((await approve(f,run.id,preview.reviewToken)).status,202);const page=f.a.store.getPage(runFor(f,run.id).pageId);f.a.store.updatePage(page.id,{keyword:'New revision after approval'},page.revision);
  assert.equal((await approve(f,run.id,preview.reviewToken)).code,'REVIEW_REQUIRED');assert.equal(f.counters().writes,finished?1:0);
 });
});
