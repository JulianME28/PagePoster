'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const G=require('../dist/generator.js');

test('25 pages across HTML and AI projects retain one publication owner through CAPTCHA, exact cleanup and restart reconciliation',{timeout:120000},async t=>{
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),{createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-bc-25-')),remote=new Map(),activeRemote=new Map(),sessions=new Map(),approved=new Map(),generated=[];
 let service,captchaHeld=true,captchaRunId=null,lostRunId=null,readsOffline=true,creates=0,writes=0,inspections=0,trashes=0,sourceReads=0,inFlight=0,maxInFlight=0,maxUnfinished=0,checks=0;
 const opened=[],prepared=[],resumed=[],finished=[],cleanupProofs=[];
 const forbidden=()=>assert.fail('This fixture must not use REST/Bridge/bootstrap or a real provider');
 const owner=id=>{const turn=service.store.getRecord('publication-turn:global');assert.equal(turn?.runId,id,'every browser operation must retain the exact global publication owner');assert.equal(turn.releasedAt,null);};
 const unfinished=()=>{
  const runs=service.store.listProjects().flatMap(project=>service.store.listRecords(project.id,'autopilot'));
  const current=runs.filter(run=>run.nativePublication&&!['completed','deleted'].includes(run.state));maxUnfinished=Math.max(maxUnfinished,current.length);
  assert.ok(current.length<=1,'only one page may remain published/checking/uncertain/cleaning globally');
 };
 const browser={nativeEditor:true,prepare:async id=>{owner(id);prepared.push(id);},resume:async id=>{owner(id);resumed.push(id);return true;},assertOpen:id=>owner(id),reset:async id=>{owner(id);sessions.delete(id);},error:async()=>{},result:async()=>{},done:async id=>{owner(id);assert.equal(service.store.getRecord(id).state,'completed');finished.push(id);},close:async()=>sessions.clear(),open:async(id,base)=>{
  owner(id);opened.push(id);captchaRunId??=id;
  if(!sessions.has(id))sessions.set(id,{
   status:async()=>{},login:async()=>{owner(id);if(id===captchaRunId&&captchaHeld)throw Object.assign(Error('Fixture challenge'),{code:'BROWSER_CAPTCHA_REQUIRED',state:'needs_attention'});},
   ensureCleanLinks:async()=>{owner(id);const run=service.store.getRecord(id);if(id===captchaRunId&&!run.donorSkips?.length)throw Object.assign(Error('Fixture optional plugin unavailable'),{code:'CLEAN_LINKS_NOT_INSTALLED',beforePageCreation:true});},
   publishPage:async input=>{
    owner(id);inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
    try{
     assert.equal(input.html,approved.get(id),'every publication/replacement uses the exact approved HTML');
     let page=activeRemote.get(id);
     if(!input.saved){assert.ok(!page||page.status==='trash','unknown responses must never create another page');creates++;page={postId:1000+creates,title:input.title,content:input.html,status:'draft',url:new URL('page-'+creates+'/',base).href,owner:id};remote.set(page.postId,page);activeRemote.set(id,page);await input.checkpoint({postId:page.postId,phase:'draft'});}else assert.equal(input.saved.postId,page.postId);
     await input.checkpoint({postId:page.postId,phase:'dispatching'});input.beforeSend();assert.equal(page.status,'draft','a known sent publication must never be sent twice');page.status='publish';writes++;
     if(!lostRunId&&writes===7){lostRunId=id;throw Object.assign(Error('Fixture lost publish response'),{code:'NATIVE_RESULT_UNCERTAIN',uncertain:true});}
     await input.checkpoint({postId:page.postId,phase:'published',url:page.url});return {...page};
    }finally{inFlight--;}
   },
   inspectPublished:async input=>{owner(id);inspections++;const page=activeRemote.get(id);assert.equal(input.saved.postId,page.postId);assert.equal(input.html,page.content);assert.equal(input.title,page.title);if(id===lostRunId&&readsOffline)throw Object.assign(Error('Fixture temporary read outage'),{code:'network_timeout'});return {...page};},
   trashPublished:async input=>{owner(id);const page=activeRemote.get(id);assert.equal(id,captchaRunId);assert.equal(page.owner,id);assert.equal(input.saved.postId,page.postId);assert.equal(input.html,page.content);assert.equal(input.title,page.title);assert.equal(page.status,'publish');assert.equal(service.store.getRecord(id).nativeCleanup.postId,page.postId);await input.checkpoint({postId:page.postId,phase:'dispatching'});input.beforeSend();trashes++;page.status='trash';await input.checkpoint({postId:page.postId,phase:'trashed'});cleanupProofs.push(page.postId);return {postId:page.postId,status:'trash'};},
   inspectOwnedTrash:async input=>{owner(id);const page=remote.get(input.saved.postId);assert.equal(page.owner,id);return {postId:page.postId,status:page.status==='trash'?'trash':'unknown'};}
  });return sessions.get(id);
 }};
 const regions=[['pl','PL'],['es','ES'],['de','DE'],['fr','FR'],['en','GB']];
 const sheet=[['url','user','password','dr','traffic','geo'],...Array.from({length:80},(_,i)=>['fixture-donor-'+i+'.example','fixture-user','fixture-password',55,2000,regions[i%regions.length][1]])];
 const source=createSiteSource({readSheet:async()=>{sourceReads++;return {values:sheet};}});
 const settings={dataDir:dir,masterKey:Buffer.alloc(32,81).toString('base64'),visibleBrowser:browser,autopilotOptions:{source,bootstrapFactory:forbidden,planner:{generate:async input=>{
  generated.push(input);return {config:{...G.DEFAULT_DATA,title:'Generated '+input.requestId,brand:'Fixture guide',brandUrl:input.links[0].url,footerBrandUrl:input.links[0].url,cards:input.links.map(link=>({name:link.anchor,url:link.url,logoUrl:link.url,button:'Visit',bonus:'Fixture resource',rating:''})),sections:[{title:'Article',body:'Unique fixture article '+input.requestId}],moreCards:[],tiles:[],services:[],reviews:[],faq:[],navLinks:[]},quality:{state:'passed',generatedTextFingerprint:crypto.createHash('sha256').update(input.requestId).digest('hex')}};
 }}},client:{checkSite:forbidden,checkPage:async input=>{checks++;assert.equal(input.publicOnly,true);assert.equal(input.site.applicationPassword,undefined);return ['public','content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'Isolated public fixture'}));}},bridgeClient:{checkStatus:forbidden},browserVerifier:{verifyPublished:async input=>{
  const run=service.store.listRecords(input.page.projectId,'autopilot').find(run=>run.pageId===input.page.id);owner(run.id);const broken=run.id===captchaRunId&&!run.donorSkips?.length,state=broken?'problem':'ok';
  return {state,viewports:[],...(input.compareVisual?{visual:{state,code:'fixture_visual_'+state,viewports:[{name:'desktop',state,code:'fixture_visual_'+state}]}}:{})};
 }}};
 service=await createLifecycleService(settings);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
 const add=async(type,count)=>{const result=await q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:type==='html'?'Approved customer HTML':'Independent AI preparation',type,items:Array.from({length:count},(_,i)=>{const [language,geo]=regions[i%regions.length];return {key:type+'-'+i,source:type,title:type+' fixture '+i,language,geo,siteSelection:{geo,minDr:20,minTraffic:50},...(type==='html'?{html:'<!doctype html><html lang="'+language+'"><head><title>Original '+i+'</title></head><body><h1>Original '+i+'</h1><p>Exact customer content '+i+'.</p></body></html>'}:{links:[{url:'https://fixture-target.example/?row='+i+'#Exact',anchor:'Fixture '+i}],editorial:{format:'article',topic:'casino',language}})};})});assert.equal(result.status,201,JSON.stringify(result));return result.project.id;};
 const project=async id=>(await q('/project-queue')).projects.find(project=>project.projectId===id);
 const prepare=async count=>{for(let i=0;i<count;i++){service.projectQueue.feed();await Promise.all([service.autopilot.tick({lane:'generation',slot:0}),service.autopilot.tick({lane:'generation',slot:1})]);await service.autopilot.selectPending();unfinished();}};
 const approveProject=async id=>{const view=await project(id);for(const item of view.items){const preview=await q('/autopilot/'+item.runId+'/html');assert.equal(preview.status,200);approved.set(item.runId,preview.html);}const result=await q('/projects/'+id+'/queue/start',{planToken:view.publicationPlan.token});assert.equal(result.status,202,JSON.stringify(result));return result;};
 const tick=async()=>{await service.tick({lane:'publication'});unfinished();};
 assert.equal((await q('/autopilot/source',{spreadsheetId:'fixture-bc-25',range:'Sites!A1:F100',serviceAccount:{client_email:'fixture@example.com',private_key:'fixture'},columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'}})).status,200);
 const first=await add('html',13);await prepare(8);const firstReady=await project(first);assert.equal(firstReady.publicationPlan.count,13);assert.equal(new Set(firstReady.items.map(item=>item.selectedSite.baseUrl)).size,13);assert.equal((await approveProject(first)).queued,13);
 for(let i=0;i<8;i++)await tick();assert.ok(captchaRunId);assert.equal(service.store.getRecord(captchaRunId).error.code,'BROWSER_CAPTCHA_REQUIRED');assert.equal(writes,0);assert.equal(creates,0);assert.deepEqual([...new Set(opened)],[captchaRunId]);
 const second=await add('ai',12);await prepare(8);assert.equal(generated.length,12,'AI preparation must continue while the first publication waits for CAPTCHA');const secondReady=await project(second);assert.equal(secondReady.publicationPlan.count,12);assert.ok(secondReady.items.every(item=>item.state==='awaiting_review'));assert.equal((await approveProject(second)).queued,12);
 for(let i=0;i<6;i++)await tick();assert.equal((await q('/project-queue')).publication.owner.runId,captchaRunId);assert.deepEqual([...new Set(opened)],[captchaRunId]);assert.equal(writes,0);assert.equal(generated.length,12);
 const expectedRegions=Array.from({length:12},(_,i)=>regions[i%regions.length]);assert.deepEqual(secondReady.items.map(item=>[item.language,item.geo]),expectedRegions);assert.deepEqual(generated.map(input=>input.editorial.language).sort(),expectedRegions.map(value=>value[0]).sort());
 captchaHeld=false;assert.equal((await q('/autopilot/'+captchaRunId+'/resume',{})).status,202);assert.equal(resumed.at(-1),captchaRunId);
 for(let i=0;i<120&&!lostRunId;i++)await tick();
 const captchaRun=service.store.getRecord(captchaRunId);
 assert.ok(lostRunId,'fixture must reach the lost known-ID response: '+JSON.stringify({creates,writes,trashes,state:captchaRun.state,stage:captchaRun.stage,code:captchaRun.error?.code,cleanupPhase:captchaRun.nativeCleanup?.phase,skips:captchaRun.donorSkips?.length}));
 assert.equal(trashes,1);assert.equal(cleanupProofs.length,1);assert.equal(remote.get(cleanupProofs[0]).status,'trash');
 const lost=service.store.getRecord(lostRunId);assert.equal(lost.state,'uncertain');assert.equal(lost.nativePublication.phase,'dispatching');assert.equal(inspections,3);const savedPostId=lost.nativePublication.postId,beforeRestart={creates,writes};
 const awaitingOthers=(await q('/project-queue')).projects.flatMap(project=>project.items).filter(item=>item.runId!==lostRunId&&item.state!=='completed');assert.ok(awaitingOthers.length>0);await tick();assert.deepEqual({creates,writes},beforeRestart);assert.equal((await q('/project-queue')).publication.owner.runId,lostRunId);
 await service.close();service=await createLifecycleService(settings);readsOffline=false;assert.equal((await q('/project-queue')).publication.owner.runId,lostRunId);assert.deepEqual({creates,writes},beforeRestart);
 const summary=await q('/autopilot/'+lostRunId+'/reconciliation');assert.equal(summary.status,200);assert.equal(summary.publication.postId,savedPostId);assert.equal((await q('/autopilot/'+lostRunId+'/reconcile',{expectedRevision:summary.run.revision-1})).status,409);
 const reconciled=await q('/autopilot/'+lostRunId+'/reconcile',{expectedRevision:summary.run.revision});assert.equal(reconciled.status,200,JSON.stringify(reconciled));assert.equal(reconciled.observation,'published');assert.equal(reconciled.publication.postId,savedPostId);assert.deepEqual({creates,writes},beforeRestart);assert.equal(inspections,4);
 // Restart deliberately pauses the other admitted work; explicit existing continuation preserves approval.
 for(const projectId of [first,second])for(const run of service.store.listRecords(projectId,'autopilot'))if(run.state==='paused')assert.equal((await q('/autopilot/'+run.id+'/resume',{})).status,202);
 for(let i=0;i<200;i++){const queue=await q('/project-queue');if(queue.publication.owner===null&&queue.projects.every(project=>project.items.every(item=>item.state==='completed')))break;await tick();}
 const final=await q('/project-queue');assert.deepEqual(final.projects.map(project=>project.counts.completed).sort((a,b)=>a-b),[12,13]);assert.equal(final.publication.owner,null);assert.equal(creates,26,'25 final pages plus one conclusively rejected owned page');assert.equal(writes,26);assert.equal(remote.size,26);assert.equal([...remote.values()].filter(page=>page.status==='publish').length,25);assert.equal(trashes,1);assert.equal(maxInFlight,1);assert.equal(maxUnfinished,1);assert.equal(new Set(finished).size,25);assert.equal(generated.length,12);
 assert.equal(service.store.getRecord(captchaRunId).donorSkips.length,1);assert.equal(service.store.getRecord(captchaRunId).donorSkips[0].code,'NATIVE_VISUAL_REJECTED');assert.equal(service.store.getRecord(lostRunId).nativePublication.postId,savedPostId);
 for(const view of final.projects)for(const item of view.items){assert.equal((await q('/autopilot/'+item.runId+'/html')).html,approved.get(item.runId));assert.equal(service.store.getPage(service.store.getRecord(item.runId).pageId).verification.state,'ok');}
 assert.doesNotMatch(JSON.stringify(final),/fixture-password|candidateCredential|ciphertext/);assert.ok(sourceReads<=3);
 t.diagnostic(JSON.stringify({projects:2,pages:25,languages:5,geos:5,aiGeneratedDuringCaptcha:generated.length,creates,writes,exactOwnedTrash:trashes,reconciliationReads:inspections,maxInFlight,maxUnfinished,verifiedFinalPages:25,sourceReads,publicChecks:checks,preparedSessions:prepared.length}));
});
