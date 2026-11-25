'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const key=Buffer.alloc(32,93).toString('base64');
const secrets=['catalog-primary-user','catalog-primary-password','catalog-alternate-user','catalog-alternate-password','catalog-source-private-key','catalog-provider-private-response'];
const config={authMode:'user',spreadsheetId:'fixtureCatalog12345',range:'Sites!A1:H100',columns:{url:'A',username:'B',password:'C',alternateUsername:'D',alternatePassword:'E',dr:'F',traffic:'G',geo:'H'}};
const candidate=(id,baseUrl,metrics={dr:60,traffic:12000,geo:['PL']})=>({id,baseUrl,rowNumber:2,username:secrets[0],password:secrets[1],alternateCredentials:{username:secrets[2],password:secrets[3]},metrics});
const rows=[candidate('alpha','https://alpha.example/'),candidate('alpha-duplicate','https://alpha.example/blog/'),candidate('beta','https://beta.example/'),candidate('low','https://low.example/',{dr:10,traffic:20,geo:['UA']})];
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function assertPrivate(value){const text=typeof value==='string'?value:JSON.stringify(value);for(const secret of secrets)assert.ok(!text.includes(secret),'Credential or provider detail escaped its private boundary');}
async function fixture(t,options={}){
 const {createStore}=await import('../server/lifecycle/store.mjs'),{createAutopilot}=await import('../server/lifecycle/autopilot.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-donor-catalog-'));let store=createStore({filename:path.join(dir,'pageposter.sqlite'),masterKey:key});const project=store.createProject({name:'Synthetic donor catalogue',...(options.criteria?{siteSelection:options.criteria}:{})});
 let now=Date.parse('2026-11-03T12:00:00Z'),account={connected:true,email:'first@fixture.example',phase:'connected'},autopilot,readCount=0;
 const activePages=new Set(),controller=new AbortController(),forbidden=()=>assert.fail('Catalogue fixture must not contact Google, WordPress or paid APIs');
 const runtime={store,dataDir:dir,masterKey:key,clock:()=>now,sourceSignal:controller.signal,googleAuth:{status:()=>account,accessToken:forbidden},hasActivePage:id=>activePages.has(id),source:{readCandidates:async(c,input)=>{readCount++;assert.equal(c.spreadsheetId,config.spreadsheetId);assert.deepEqual(input.criteria,{minDr:null,minTraffic:null,geo:''});assert.deepEqual(input.usedOrigins,[]);assert.deepEqual(input.usedRowIds,[]);assert.equal(input.preserveOrigins,true);return options.read?options.read(c,input):{candidates:structuredClone(rows),issues:[]};},pickUnused:forbidden},client:{checkSite:forbidden,checkPage:forbidden},bridge:{checkStatus:forbidden},bootstrapFactory:forbidden};
 autopilot=await createAutopilot(runtime);await autopilot.saveSource(config);
 async function q(route,body){const response=await autopilot.handle(new Request('http://localhost'+route,{method:body===undefined?'GET':'POST'}),route.split('?')[0],async()=>body);assert.ok(response);const text=await response.text();assertPrivate(text);return {status:response.status,...JSON.parse(text)};}
 async function launch(){const input={source:'html',html:'<h1>Exact catalogue fixture</h1><p>Approved local material.</p>',chromeMode:'overlay-only'},preview=await q('/autopilot/preview',input),run=autopilot.launch(project.id,{...input,idempotencyKey:randomUUID(),reviewToken:preview.reviewToken,reviewBeforePublish:true});await autopilot.tick({lane:'generation'});assert.equal(store.getRecord(run.id).state,'awaiting_review');return run.id;}
 t.after(()=>{controller.abort();store.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'pp-donor-catalog-'));fs.rmSync(dir,{recursive:true,force:true});});
 const runId=await launch();
 return {get store(){return store;},project,dir,runId,q,launch,activePages,controller,get a(){return autopilot;},get reads(){return readCount;},setAccount:patch=>{account={...account,...patch};},advance:ms=>{now+=ms;},raw:(id=runId)=>store.getRecord(id),patch:(patch,id=runId)=>{const run=store.getRecord(id);return store.updateRecord(id,patch,run.revision);},list:(query='',id=runId)=>q('/autopilot/'+id+'/donors'+query),choose:(catalog,id='alpha',run=runId)=>q('/autopilot/'+run+'/donor',{token:catalog.token,candidateId:id,expectedRevision:catalog.destinationRevision}),restart:async()=>{store.close();store=createStore({filename:path.join(dir,'pageposter.sqlite'),masterKey:key});runtime.store=store;autopilot=await createAutopilot(runtime);}};
}

test('catalogue search and pagination expose one origin and bind choices to the returned page',async t=>{
 const f=await fixture(t),first=await f.list('?offset=0&limit=1');assert.equal(first.status,200);assert.equal(first.total,3);assert.deepEqual(first.candidates.map(c=>c.id),['alpha']);
 const second=await f.list('?offset=1&limit=1');assert.equal(second.total,3);assert.deepEqual(second.candidates.map(c=>c.id),['beta']);
 assert.equal((await f.choose(first,'beta')).code,'DONOR_SELECTION_EXPIRED');assert.equal((await f.choose(second,'alpha')).code,'DONOR_SELECTION_EXPIRED');assert.equal(f.raw().candidate,undefined);
 const search=await f.list('?search=%20BETA.EXAMPLE%20');assert.deepEqual(search.candidates.map(c=>c.id),['beta']);assert.equal(search.total,1);assert.equal((await f.list('?search='+secrets[0])).total,0);assert.equal(f.reads,1);
 assert.deepEqual(Object.keys(search.candidates[0]).sort(),['available','baseUrl','current','dr','geo','id','matchesCriteria','reason','traffic','warning'].sort());
});

test('catalogue rejects malformed pagination and unknown query controls before reading a source',async t=>{
 const f=await fixture(t);for(const query of ['?offset=-1','?offset=1.5','?offset=100001','?limit=0','?limit=101','?all=yes','?password=x','?search=%00']){const result=await f.list(query);assert.equal(result.status,400,query);assert.equal(result.code,'VALIDATION',query);}assert.equal(f.reads,0);
});

test('show all ranks manual reserves while keeping weak choices explicit',async t=>{
 const base=[candidate('other','https://other.example/',{dr:99,traffic:500,geo:['BR']}),candidate('weak','https://weak.example/',{dr:10,traffic:500,geo:['GB']}),candidate('locale','https://locale.example/',{dr:70,traffic:500,geo:['NZ']}),candidate('exact','https://exact.example/',{dr:60,traffic:500,geo:['GB']})];
 const f=await fixture(t,{criteria:{geo:'GB',minDr:30,minTraffic:100},read:async()=>({candidates:base})});
 const strict=await f.list(),all=await f.list('?all=1');
 assert.deepEqual(strict.candidates.map(c=>c.id),['exact']);
 assert.deepEqual(all.candidates.map(c=>[c.id,c.recommendation.group,c.recommendation.reserveRank]),[
  ['exact','exact',null],['locale','locale',1],['other','other',2],['weak','exact',null],
 ]);
 assert.ok(all.candidates[1].warning.includes('вручну'));
 assert.equal(f.raw().candidate,undefined);
 assert.equal((await f.choose(strict,'locale')).code,'DONOR_SELECTION_EXPIRED');
 assert.equal((await f.choose(all,'locale')).status,200);
});

test('manual catalogue cannot claim a sibling root already associated with another run',async t=>{
 const base=[candidate('original','https://one.reserve.co.uk/'),candidate('sibling','https://two.reserve.co.uk/')];
 const f=await fixture(t,{read:async()=>({candidates:base})}),other=await f.launch();
 const first=await f.list(),stale=await f.list('?all=1',other);
 assert.equal((await f.choose(first,'original')).status,200);
 assert.equal((await f.choose(stale,'sibling',other)).code,'SOURCE_RESERVED');
 const fresh=await f.list('?all=1',other);
 assert.equal(fresh.candidates.find(c=>c.id==='sibling').available,false);
});

test('show all search treats the current root as occupied by the current assignment',async t=>{
 const base=[candidate('original','https://one.reserve.co.uk/'),candidate('sibling','https://two.reserve.co.uk/'),candidate('other','https://distinct.example/')];
 const f=await fixture(t,{read:async()=>({candidates:base})});
 assert.equal((await f.choose(await f.list(),'original')).status,200);
 const filtered=await f.list('?all=1&search=two.reserve');
 assert.equal(filtered.candidates[0].recommendation.primary,false);
 assert.equal(filtered.candidates[0].recommendation.reserveRank,null);
});

test('explicit destination rejects another run’s root before changing its revision or credential',async t=>{
 const f=await fixture(t),other=await f.launch();
 const set=(id,host)=>f.q('/autopilot/'+id+'/destination',{baseUrl:'https://'+host+'/',username:secrets[0],password:secrets[1],expectedRevision:f.raw(id).destinationRevision||0});
 assert.equal((await set(f.runId,'blog.reserve.co.uk')).status,200);
 const before=f.raw(other),blocked=await set(other,'wp.reserve.co.uk');
 assert.equal(blocked.status,409);
 assert.equal(blocked.code,'SOURCE_RESERVED');
 assert.deepEqual(f.raw(other),before);
 assert.equal((await set(f.runId,'blog.reserve.co.uk')).status,200);
});

test('deleting an unpublished manual destination frees its root in the catalogue and explicit form',async t=>{
 const f=await fixture(t,{read:async()=>({candidates:[candidate('alpha','https://wp.reserve.co.uk/')]})}),other=await f.launch();
 const set=(id,host)=>f.q('/autopilot/'+id+'/destination',{baseUrl:'https://'+host+'/',username:secrets[0],password:secrets[1],expectedRevision:f.raw(id).destinationRevision||0});
 assert.equal((await set(f.runId,'blog.reserve.co.uk')).status,200);
 assert.equal((await f.q('/autopilot/'+f.runId+'/delete',{})).status,200);
 assert.equal((await f.list('?all=1',other)).candidates[0].available,true);
 // Legacy records may retain the manual URL without a deletion timestamp.
 f.patch({state:'deleted',deletedAt:null,manualTarget:{baseUrl:'https://blog.reserve.co.uk/'}});
 assert.equal((await f.list('?all=1',other)).candidates[0].available,true);
 assert.equal((await set(other,'wp.reserve.co.uk')).status,200);
});

test('criteria mismatches need an explicit all=1 catalogue choice and retain the original criteria',async t=>{
 const criteria={minDr:50,minTraffic:1000,geo:'PL'},f=await fixture(t,{criteria}),normal=await f.list(),zero=await f.list('?all=0');assert.deepEqual(normal.candidates.map(c=>c.id),['alpha','beta']);assert.equal(zero.total,2);assert.equal((await f.choose(normal,'low')).code,'DONOR_SELECTION_EXPIRED');
 const all=await f.list('?all=1'),low=all.candidates.find(c=>c.id==='low');assert.equal(all.total,3);assert.equal(low.matchesCriteria,false);assert.ok(low.warning);const selected=await f.choose(all,'low');assert.equal(selected.status,200);assert.equal(selected.run.selectedDomain,'https://low.example/');assert.equal(selected.run.donorPinned,true);assert.deepEqual(f.raw().siteSelection,criteria);
});

test('catalogue cache expires after one minute while a returned choice lasts five minutes and is single-use',async t=>{
 const f=await fixture(t),first=await f.list();f.advance(59999);await f.list();assert.equal(f.reads,1);f.advance(1);await f.list();assert.equal(f.reads,2);f.advance(239999);assert.equal((await f.choose(first)).status,200);assert.equal((await f.choose(first)).code,'DONOR_SELECTION_EXPIRED');
});

test('choice expires at the five-minute boundary and cannot survive a runtime restart',async t=>{
 const f=await fixture(t),catalog=await f.list();f.advance(300000);const expired=await f.choose(catalog);assert.equal(expired.status,409);assert.equal(expired.code,'DONOR_SELECTION_EXPIRED');assert.equal(f.raw().candidate,undefined);const fresh=await f.list();await f.restart();assert.equal((await f.choose(fresh)).code,'DONOR_SELECTION_EXPIRED');
});

test('source, account and epoch changes during a source read refuse stale catalogue results',{timeout:30000},async t=>{
 for(const change of ['source','account','epoch','aborted'])await t.test(change,async t=>{const started=deferred(),release=deferred(),f=await fixture(t,{read:async()=>{started.resolve();await release.promise;return {candidates:structuredClone(rows),issues:[]};}}),pending=f.list();await started.promise;
  if(change==='source')await f.a.saveSource({...config,range:'Sites!A1:H200'});if(change==='account')f.setAccount({email:'second@fixture.example'});if(change==='epoch')f.a.invalidateSelection();if(change==='aborted')f.controller.abort();release.resolve();const result=await pending;assert.equal(result.status,409);assert.equal(result.code,'CONFLICT');assert.equal(f.raw().candidate,undefined);
 });
});

test('source, account, epoch and connection changes invalidate an already returned token',async t=>{
 for(const change of ['source','account','epoch','waiting','disconnected'])await t.test(change,async t=>{const f=await fixture(t),catalog=await f.list();if(change==='source')await f.a.saveSource({...config,range:'Sites!A1:H200'});if(change==='account')f.setAccount({email:'second@fixture.example'});if(change==='epoch')f.a.invalidateSelection();if(change==='waiting')f.setAccount({phase:'waiting'});if(change==='disconnected')f.setAccount({connected:false});const result=await f.choose(catalog);assert.equal(result.status,409);assert.equal(result.code,'DONOR_SELECTION_EXPIRED');assert.equal(f.raw().candidate,undefined);});
});

test('destination, page and criteria changes during a source read cannot issue a usable stale choice',{timeout:30000},async t=>{
 for(const change of ['destination','page','criteria'])await t.test(change,async t=>{const started=deferred(),release=deferred(),f=await fixture(t,{read:async()=>{started.resolve();await release.promise;return {candidates:structuredClone(rows),issues:[]};}}),pending=f.list();await started.promise;
  if(change==='destination')f.patch({destinationRevision:1});if(change==='criteria')f.patch({siteSelection:{minDr:90,minTraffic:null,geo:''}});if(change==='page'){const page=f.store.getPage(f.raw().pageId);f.store.updatePage(page.id,{title:'Locally edited during catalogue read'},page.revision);}release.resolve();const result=await pending;assert.equal(result.status,409);assert.equal(result.code,'CONFLICT');assert.equal(f.raw().candidate,undefined);
 });
});

test('destination, page, criteria and active work are rechecked at choice admission',async t=>{
 for(const change of ['destination','page','criteria','active'])await t.test(change,async t=>{const f=await fixture(t),catalog=await f.list();if(change==='destination')f.patch({destinationRevision:1});if(change==='criteria')f.patch({siteSelection:{minDr:90,minTraffic:null,geo:''}});if(change==='page'){const page=f.store.getPage(f.raw().pageId);f.store.updatePage(page.id,{title:'Locally edited after catalogue read'},page.revision);}if(change==='active')f.activePages.add(f.raw().pageId);const result=await f.choose(catalog);assert.equal(result.status,409);assert.equal(result.code,'CONFLICT');assert.equal(f.raw().candidate,undefined);});
});

test('a choice token belongs to one run and concurrent claims admit only one origin owner',async t=>{
 const f=await fixture(t),other=await f.launch(),first=await f.list(),second=await f.list('',other);assert.equal((await f.choose(first,'alpha',other)).code,'DONOR_SELECTION_EXPIRED');
 const results=await Promise.all([f.choose(first),f.choose(second,'alpha',other)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(results.find(r=>r.status===409).code,'SOURCE_RESERVED');assert.equal([f.raw(),f.raw(other)].filter(r=>r.candidate?.baseUrl==='https://alpha.example/').length,1);
 const remaining=f.raw().candidate?other:f.runId,refresh=await f.list('',remaining),occupied=refresh.candidates.find(c=>c.id==='alpha');assert.equal(occupied.available,false);assert.ok(occupied.reason);assert.equal((await f.choose(refresh,'alpha',remaining)).code,'SOURCE_RESERVED');
});

test('already dispatched or active pages return a blocked catalogue without reading a source',async t=>{
 for(const state of ['uncertain','dispatching','active'])await t.test(state,async t=>{const f=await fixture(t);if(state==='uncertain')f.patch({state:'uncertain'});if(state==='dispatching')f.patch({nativePublication:{postId:71,phase:'dispatching'}});if(state==='active')f.activePages.add(f.raw().pageId);const result=await f.list();assert.equal(result.status,200);assert.equal(result.token,null);assert.equal(result.run.canSetDestination,false);assert.equal(result.total,0);assert.deepEqual(result.candidates,[]);assert.equal(f.reads,0);});
});

test('catalogue and source errors keep credentials private and selected credentials persist encrypted with the pin',async t=>{
 const f=await fixture(t),catalog=await f.list(),chosen=await f.choose(catalog);assert.equal(chosen.status,200);assert.equal(chosen.run.donorPinned,true);assert.equal(chosen.run.destinationRevision,1);assert.equal(chosen.run.state,'awaiting_review');assert.equal(f.raw().publicationApproval,null);assertPrivate(f.raw());
 assert.ok(f.raw().candidateCredential);assert.ok(f.raw().alternateCredential);await f.restart();assert.equal(f.raw().donorPinned,true);assert.equal(f.a.list(f.project.id)[0].selectedDomain,'https://alpha.example/');assertPrivate(f.store.exportBackup());assertPrivate(fs.readFileSync(path.join(f.dir,'autopilot-source.json'),'utf8'));
 const failed=await fixture(t,{read:async()=>{throw Object.assign(Error(secrets[5]+' '+secrets[1]),{code:'source_read_failed'});}}),result=await failed.list();assert.equal(result.status,400);assert.equal(result.code,'source_read_failed');assert.ok(result.error);assertPrivate(result);
});

test('historical rejection is a visible warning that a manual catalogue pin can override',async t=>{
 const f=await fixture(t);f.patch({donorSkips:[{id:'alpha',baseUrl:'https://alpha.example/',code:'bootstrap_auth_failed',at:'2026-11-02T00:00:00Z'}]});const catalog=await f.list(),row=catalog.candidates.find(c=>c.id==='alpha');assert.equal(row.available,true);assert.ok(row.warning);assert.equal((await f.choose(catalog)).status,200);assert.equal(f.raw().donorPinned,true);
});

test('untrusted source error codes cannot copy credential text into the catalogue response',async t=>{
 const f=await fixture(t,{read:async()=>{throw Object.assign(Error(secrets[5]),{code:secrets[1]});}}),result=await f.list();assert.equal(result.status,400);assert.equal(result.code,'AUTOPILOT_FAILED');assertPrivate(result);
});

async function nativeFixture(t,{unavailable=false,visualProblem=false,manual=false}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-donor-pin-'));
 let service,currentBase='https://alpha.example/',remote=null,creates=0,publishes=0,trashes=0,selections=0,logins=0;
 const forbidden=()=>assert.fail('Synthetic pinned donor must not use remote API, Bridge or bootstrap');
 const session={get baseUrl(){return currentBase;},status:async()=>{},result:async()=>{},login:async auth=>{logins++;assert.equal(auth.username,secrets[0]);assert.equal(auth.applicationPassword,secrets[1]);},ensureCleanLinks:async()=>{if(visualProblem&&currentBase==='https://alpha.example/')throw Object.assign(Error('Unavailable optional plugin'),{code:'CLEAN_LINKS_NOT_INSTALLED'});},
  publishPage:async input=>{if(!input.saved){creates++;await input.checkpoint({postId:80,phase:'draft'});}await input.checkpoint({postId:80,phase:'dispatching'});input.beforeSend();publishes++;remote={postId:80,url:currentBase+'published/',title:input.title,content:input.html,status:'publish'};await input.checkpoint({postId:80,phase:'published',url:remote.url});return remote;},
  trashPublished:async input=>{assert.equal(input.saved.postId,80);assert.equal(input.html,remote.content);assert.equal(input.title,remote.title);await input.checkpoint({postId:80,phase:'dispatching'});input.beforeSend();trashes++;remote.status='trash';await input.checkpoint({postId:80,phase:'trashed'});return {postId:80,status:'trash'};},inspectPublished:async()=>remote,inspectOwnedTrash:async()=>({postId:80,status:remote?.status==='trash'?'trash':'unknown'})};
 const browser={nativeEditor:true,prepare:async()=>{},open:async(_id,base)=>{if(unavailable)throw Object.assign(Error('Synthetic unavailable pinned login'),{code:'BROWSER_PAGE_UNAVAILABLE'});currentBase=base;return session;},assertOpen:()=>{},reset:async()=>{},focus:async()=>{},error:async()=>{},done:async()=>{},result:async()=>{},close:async()=>{}};
 const settings={dataDir:dir,masterKey:key,visibleBrowser:browser,autopilotOptions:{source:{readCandidates:async()=>({candidates:[structuredClone(rows[0]),structuredClone(rows[2])],issues:[]}),pickUnused:async()=>{selections++;return structuredClone(rows[2]);}},bootstrapFactory:forbidden},client:{checkSite:forbidden,checkPage:async input=>{assert.equal(input.publicOnly,true);assert.equal(input.site.applicationPassword,undefined);return ['public','content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'Synthetic local fixture'}));}},bridgeClient:{checkStatus:forbidden},browserVerifier:{verifyPublished:async input=>{const state=visualProblem&&currentBase==='https://alpha.example/'?'problem':'ok';return {state,viewports:[],...(input.compareVisual?{visual:{state,code:'fixture_visual_'+state,viewports:[{name:'desktop',state,code:'fixture_visual_'+state}]}}:{})};}}};
 service=await createLifecycleService(settings);t.after(async()=>{await service.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'pp-donor-pin-'));fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));assert.ok(response);const text=await response.text();assertPrivate(text);return {status:response.status,...JSON.parse(text)};};
 const project=service.store.createProject({name:'Synthetic pinned native page'}),input={source:'html',html:'<h1>Pinned material</h1><p>Exact local HTML.</p>',chromeMode:'overlay-only'},preview=await q('/autopilot/preview',input),launch=await q('/projects/'+project.id+'/autopilot',{...input,idempotencyKey:randomUUID(),reviewToken:preview.reviewToken,reviewBeforePublish:true}),runId=launch.run.id;
 await service.tick();await service.autopilot.saveSource({...config,authMode:'service',serviceAccount:{client_email:'reader@fixture.example',private_key:secrets[4]}});
 if(manual){const destination=await q('/autopilot/'+runId+'/destination',{baseUrl:'https://alpha.example/',username:secrets[0],password:secrets[1],expectedRevision:0});assert.equal(destination.status,200);assert.equal(destination.run.destinationMode,'manual');assert.equal(destination.run.selectedDomain,'https://alpha.example/');}
 else{const catalog=await q('/autopilot/'+runId+'/donors'),choice=await q('/autopilot/'+runId+'/donor',{token:catalog.token,candidateId:'alpha',expectedRevision:catalog.destinationRevision});assert.equal(choice.status,200);assert.equal(choice.run.donorPinned,true);}
 const html=await q('/autopilot/'+runId+'/html'),approval=await q('/autopilot/'+runId+'/approve',{reviewToken:html.reviewToken});assert.equal(approval.status,202);
 return {get service(){return service;},runId,project,q,html:html.html,initialReviewToken:html.reviewToken,raw:()=>service.store.getRecord(runId),run:()=>service.autopilot.list(project.id)[0],stats:()=>({creates,publishes,trashes,selections,logins}),ticks:async count=>{for(let i=0;i<count;i++)await service.tick();},restart:async()=>{await service.close();service=await createLifecycleService(settings);}};
}

test('a manually pinned donor refuses automatic replacement after proven pre-page unavailability',async t=>{
 const f=await nativeFixture(t,{unavailable:true}),pageId=f.raw().pageId;await f.ticks(8);assert.equal(f.run().error.code,'BROWSER_PAGE_UNAVAILABLE');assert.equal(f.raw().donorPinned,true);assert.equal(f.raw().candidate.baseUrl,'https://alpha.example/');assert.equal(f.raw().pageId,pageId);assert.equal(f.run().skippedSites.length,0);assert.deepEqual(f.stats(),{creates:0,publishes:0,trashes:0,selections:0,logins:0});assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,f.html);
});

test('confirmed visual cleanup preserves a manual pin and refuses an automatic donor replacement',async t=>{
 const f=await nativeFixture(t,{visualProblem:true}),pageId=f.raw().pageId;await f.ticks(14);assert.equal(f.stats().trashes,1,'Only the exact broken fixture page is cleaned up: '+JSON.stringify(f.run()));assert.equal(f.stats().publishes,1,'A pin must never authorize publishing on a second donor');assert.equal(f.stats().selections,0,'A pin must never authorize an automatic source selection');assert.equal(f.raw().donorPinned,true);assert.equal(f.raw().candidate.baseUrl,'https://alpha.example/');assert.equal(f.raw().pageId,pageId);assert.equal(f.run().state,'needs_attention');assert.equal(f.run().error.code,'NATIVE_VISUAL_REJECTED');assert.equal(f.service.store.getPage(pageId).wpId,null);assert.equal((await f.q('/autopilot/'+f.runId+'/html')).html,f.html);
});

test('a manual destination survives confirmed visual cleanup and restart until an explicit destination change',async t=>{
 const f=await nativeFixture(t,{manual:true,visualProblem:true}),pageId=f.raw().pageId;await f.ticks(14);
 assert.equal(f.stats().trashes,1);assert.equal(f.stats().publishes,1,'A manual destination must never authorize publishing on a second donor');assert.equal(f.stats().selections,0);assert.equal(f.raw().manualTarget.baseUrl,'https://alpha.example/');assert.equal(f.raw().candidate.baseUrl,'https://alpha.example/');assert.ok(f.raw().candidateCredential);assert.equal(f.raw().publicationApproval,null);assert.equal(f.raw().pageId,pageId);assert.equal(f.run().state,'needs_attention');assert.equal(f.run().error.code,'NATIVE_VISUAL_REJECTED');assert.equal(f.service.store.getPage(pageId).wpId,null);assertPrivate(f.raw());
 await f.restart();assert.equal(f.raw().manualTarget.baseUrl,'https://alpha.example/');assert.ok(f.raw().candidateCredential);assert.equal(f.raw().publicationApproval,null);assert.equal(f.raw().pageId,pageId);await f.ticks(4);assert.equal(f.stats().publishes,1);assert.equal(f.stats().selections,0);
 const afterCleanup=await f.q('/autopilot/'+f.runId+'/html');assert.equal(afterCleanup.html,f.html);assert.notEqual(afterCleanup.reviewToken,f.initialReviewToken);assert.equal(f.raw().publicationApproval,null);
 await f.q('/autopilot/'+f.runId+'/resume',{});await f.ticks(4);assert.equal(f.stats().publishes,1,'Resume without a fresh approval must not repeat a write');assert.equal(f.raw().publicationApproval,null);const stale=await f.q('/autopilot/'+f.runId+'/approve',{reviewToken:f.initialReviewToken});assert.ok(stale.status>=400,'The original approval cannot authorize a retry after cleanup');assert.equal(f.raw().publicationApproval,null);assert.equal(f.stats().selections,0);
 const destination=await f.q('/autopilot/'+f.runId+'/destination',{baseUrl:'https://beta.example/',username:secrets[0],password:secrets[1],expectedRevision:f.raw().destinationRevision});assert.equal(destination.status,200);assert.equal(destination.run.selectedDomain,'https://beta.example/');assert.equal(f.raw().pageId,pageId);const changed=await f.q('/autopilot/'+f.runId+'/html');assert.equal(changed.html,f.html);assert.equal((await f.q('/autopilot/'+f.runId+'/approve',{reviewToken:changed.reviewToken})).status,202);await f.ticks(8);assert.equal(f.stats().publishes,2);assert.equal(f.stats().selections,0);assert.equal(f.raw().pageId,pageId);assert.equal(f.run().state,'completed');assert.equal(f.run().fullUrl,'https://beta.example/published/');
});
