'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');

test('desktop queue automatically replaces rejected and uncreatable donors, publishes twenty pages once, and survives restart without further clicks',async t=>{
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-desktop-donor-continuation-'));
 const donors=Array.from({length:28},(_,index)=>({id:'donor-'+index,baseUrl:'https://desktop-donor-'+index+'.example/',rowNumber:index+2,username:'primary',password:'fixture-password',alternateCredentials:{username:'backup',password:'fixture-password'},metrics:{dr:50,traffic:200,geo:['PL']}}));
 const actions=[],sessions=new Map(),published=new Map(),approved=new Map(),attempts=new Map();let service,lostReply=false,restarts=0;
 const forbidden=()=>assert.fail('This local queue test must not call Google, OpenAI, Bridge, or public verification');
 const owner=id=>assert.equal(service.autopilot.publicationTurn.owner()?.id,id,'Only the current page may operate on a donor');
 const browser={nativeEditor:true,prepare:async()=>{},assertOpen:id=>assert.ok(sessions.has(id)),error:async()=>{},done:async()=>{},result:forbidden,close:async()=>{sessions.clear();},reset:async id=>{sessions.delete(id);},open:async(id,baseUrl)=>{
  owner(id);assert.ok([...sessions.keys()].every(key=>key===id),'The next page cannot start before the current session closes');
  if(sessions.has(id)){assert.equal(sessions.get(id).baseUrl,baseUrl);return sessions.get(id);}
  const session={baseUrl,status:async()=>{},login:async auth=>{actions.push({kind:'login',id,baseUrl,username:auth.username});if(baseUrl===donors[0].baseUrl)throw Object.assign(Error('Rejected fixture credentials'),{code:'bootstrap_auth_failed',loginRejectedBeforeWrites:true});},ensureCleanLinks:async()=>{if(baseUrl===donors[2].baseUrl)throw Object.assign(Error('Optional plugin unavailable'),{code:'CLEAN_LINKS_INSTALL_FORBIDDEN',beforePageCreation:true});},publishPage:async input=>{
   owner(id);actions.push({kind:'editor',id,baseUrl});
   if(baseUrl===donors[1].baseUrl)throw Object.assign(Error('No Add New permission'),{code:'NATIVE_NAVIGATION_UNAVAILABLE',writeNotAttempted:true});
   assert.equal(input.saved,null);assert.equal(published.has(baseUrl),false,'A donor cannot receive a second page');
   const wanted=approved.get(id);assert.equal(input.title,wanted.title);assert.equal(input.html,wanted.html);
   const postId=1000+published.size;await input.checkpoint({postId:null,phase:'creating'});await input.checkpoint({postId,phase:'draft'});
   actions.push({kind:'create',id,baseUrl});await input.checkpoint({postId,phase:'dispatching'});input.beforeSend();
   const result={postId,url:baseUrl+'published/',title:input.title,content:input.html,status:'publish'};published.set(baseUrl,result);actions.push({kind:'publish',id,baseUrl});
   if(!lostReply&&baseUrl===donors[23].baseUrl){lostReply=true;throw Object.assign(Error('Response lost after committed publication'),{code:'BROWSER_PUBLICATION_UNCERTAIN',uncertain:true});}
   await input.checkpoint({postId,phase:'published',url:result.url});return result;
  },inspectPublished:async input=>{owner(id);const result=published.get(baseUrl);assert.equal(input.saved.postId,result.postId);actions.push({kind:'inspect',id,baseUrl});return result;}};
  sessions.set(id,session);return session;
 }};
 const source={readCandidates:async()=>({candidates:donors,issues:[]}),pickUnused:async(_config,input)=>{const donor=donors.find(value=>!input.usedOrigins.includes(new URL(value.baseUrl).origin));if(donor)attempts.set(donor.id,(attempts.get(donor.id)||0)+1);return donor;}};
 const settings={desktop:true,dataDir:dir,masterKey:Buffer.alloc(32,115).toString('base64'),visibleBrowser:browser,autopilotOptions:{source,bootstrapFactory:forbidden,planner:{generate:forbidden}},client:{checkPage:forbidden,checkSite:forbidden},bridgeClient:{checkStatus:forbidden},browserVerifier:{verifyPublished:forbidden}};
 service=await createLifecycleService(settings);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));const result=await response.json();assert.ok(response.status<400,JSON.stringify({route,result}));return result;};
 const add=(name,count)=>q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name,type:'html',items:Array.from({length:count},(_,index)=>({key:name+'-'+index,source:'html',title:name+' '+index,html:'<h1>'+name+' '+index+'</h1><p>Exact prepared HTML.</p>',language:'pl',geo:'PL',siteSelection:{minDr:20,minTraffic:50,geo:'PL'}}))});
 const view=async id=>(await q('/project-queue')).projects.find(value=>value.projectId===id);
 const prepare=async rounds=>{for(let i=0;i<rounds;i++){service.projectQueue.feed();await service.autopilot.tick({lane:'generation'});await service.autopilot.selectPending();}};
 await q('/autopilot/source',{spreadsheetId:'local-donor-continuation',range:'Sites!A1:F100',columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'},serviceAccount:{client_email:'reader@fixture.example',private_key:'fixture'}});
 const first=await add('Approved batch',20);await prepare(21);let batch=await view(first.project.id);assert.equal(batch.publicationPlan.count,20);
 for(const item of batch.items){const html=await q('/autopilot/'+item.runId+'/html');approved.set(item.runId,{pageId:item.pageId,html:html.html,title:item.title});}
 const other=await add('Not approved',3);await prepare(4);const untouched=(await view(other.project.id)).items.map(item=>({run:service.store.getRecord(item.runId),page:service.store.getPage(item.pageId)}));
 assert.equal(actions.length,0);assert.equal((await q('/projects/'+first.project.id+'/queue/start',{planToken:batch.publicationPlan.token})).queued,20);
 // After this single Start, only worker ticks and read-only queue requests are
 // permitted. No resume, retry, donor selection, or approval click is supplied.
 for(let tick=0;tick<180;tick++){
  await service.tick({lane:'publication'});batch=await view(first.project.id);
  assert.ok(batch.items.every(item=>!['failed','needs_attention','uncertain','awaiting_review','paused'].includes(item.state)),JSON.stringify(batch.items.map(item=>({key:item.key,state:item.state,error:item.error}))));
  assert.equal(service.store.listJobs(first.project.id).filter(job=>job.type==='page_check').length,0);
  if(!restarts&&batch.counts.completed===10&&service.autopilot.publicationTurn.owner()===null){
   const remaining=batch.items.filter(item=>item.state!=='completed').map(item=>service.store.getRecord(item.runId));
   await service.close();service=await createLifecycleService(settings);restarts++;
   assert.deepEqual(remaining.map(run=>service.store.getRecord(run.id)),remaining,'Idle restart retains the admitted pages and approvals');
  }
  if(batch.items.every(item=>item.state==='completed')&&service.autopilot.publicationTurn.owner()===null)break;
 }
 assert.equal(batch.counts.completed,20);assert.equal(restarts,1);assert.equal(lostReply,true);
 assert.equal(actions.filter(action=>action.kind==='create').length,20);assert.equal(actions.filter(action=>action.kind==='publish').length,20);
 assert.ok(actions.some(action=>action.kind==='inspect'&&action.baseUrl===donors[23].baseUrl));
 assert.deepEqual(actions.filter(action=>action.kind==='login'&&action.baseUrl===donors[0].baseUrl).map(action=>action.username),['primary','backup']);
 assert.ok(actions.some(action=>action.kind==='editor'&&action.baseUrl===donors[1].baseUrl));
 assert.ok(!actions.some(action=>['create','publish'].includes(action.kind)&&[donors[0].baseUrl,donors[1].baseUrl].includes(action.baseUrl)));
 assert.equal(batch.items.flatMap(item=>item.skippedSites).length,2);
 for(const item of batch.items){const wanted=approved.get(item.runId),page=service.store.getPage(item.pageId);assert.equal(item.pageId,wanted.pageId);assert.equal(item.manualReview.state,'pending');assert.equal(page.remoteSnapshot.content,wanted.html);assert.equal(actions.filter(action=>action.id===item.runId&&action.kind==='create').length,1);assert.equal(actions.filter(action=>action.id===item.runId&&action.kind==='publish').length,1);}
 assert.ok([...attempts.values()].every(count=>count===1),'Rejected or reserved donors are never selected again');
 assert.deepEqual((await view(other.project.id)).items.map(item=>({run:service.store.getRecord(item.runId),page:service.store.getPage(item.pageId)})),untouched);
 const before=actions.length;for(let i=0;i<5;i++)await service.tick({lane:'publication'});assert.equal(actions.length,before,'Draining the finished queue cannot create or publish again');
 t.diagnostic(JSON.stringify({pages:20,skipped:2,creates:20,publishes:20,restarts,readOnlyResponseRecovery:true,additionalClicks:0}));
});
