const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
test('110 approved pages reconcile an exhausted known-ID read after restart while a second project stays unapproved', {timeout:120000},async t=>{
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),{createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-batch-recovery-')),remote=new Map(),sessions=new Map();let service,created=0,published=0,inspected=0,reads=0,lost=false,reconciliationOffline=true,inFlight=0,maxInFlight=0;
 const forbidden=()=>assert.fail('The batch must use the native editor, never REST/Bridge/AI');
 const browser={nativeEditor:true,assertOpen:()=>{},reset:async id=>sessions.delete(id),close:async()=>sessions.clear(),error:async()=>{},done:async()=>{},result:async()=>{},open:async(id,base)=>{
  if(!sessions.has(id))sessions.set(id,{status:async()=>{},login:async()=>{},ensureCleanLinks:async()=>{},
   inspectPublished:async({saved,title,html})=>{inspected++;const page=remote.get(id);assert.equal(page.postId,saved.postId);assert.equal(page.content,html);assert.equal(page.title,title);if(lost&&page.postId===11&&reconciliationOffline)throw Object.assign(Error('Fixture temporary read outage'),{code:'network_timeout'});return {...page};},
   publishPage:async({saved,title,html,checkpoint,beforeSend})=>{
    inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);try{
     let page=remote.get(id);if(!saved){assert.equal(page,undefined,'A resumed run must never create a second remote page');created++;page={postId:created,title,content:html,status:'draft',url:new URL('page-'+created+'/',base).href};remote.set(id,page);await checkpoint({postId:page.postId,phase:'draft'});}else assert.equal(saved.postId,page.postId);
     await checkpoint({postId:page.postId,phase:'dispatching'});beforeSend();page.status='publish';published++;
     if(!lost&&published===11){lost=true;throw Object.assign(Error('Lost remote response'),{code:'NATIVE_RESULT_UNCERTAIN',uncertain:true});}
     await checkpoint({postId:page.postId,phase:'published',url:page.url});return {...page};
    }finally{inFlight--;}
   }});return sessions.get(id);
 }};
 const sheet=[['url','user','password','dr','traffic','geo'],...Array.from({length:132},(_,i)=>['batch-'+i+'.example','fixture-user','fixture-secret',50,1000,i%2?'HU':'PL'])];
 const source=createSiteSource({readSheet:async()=>{reads++;return {values:sheet};}}),settings={dataDir:dir,masterKey:Buffer.alloc(32,71).toString('base64'),visibleBrowser:browser,autopilotOptions:{source},client:{checkSite:forbidden,checkPage:async input=>{assert.equal(input.publicOnly,true);return ['public','content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'isolated public fixture'}));}},bridgeClient:{checkStatus:forbidden},browserVerifier:{verifyPublished:async()=>({state:'ok',viewports:[]})}};
 service=await createLifecycleService(settings);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
 const add=async(name,count)=>q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name,type:'html',items:Array.from({length:count},(_,i)=>({key:name+'-'+i,source:'html',title:name+' '+i,html:'<h1>'+name+' '+i+'</h1><p>Exact approved original content '+i+'.</p>',language:i%2?'hu':'pl',geo:i%2?'HU':'PL',siteSelection:{geo:i%2?'HU':'PL',minDr:20,minTraffic:50}}))});
 const project=async id=>(await q('/project-queue')).projects.find(p=>p.projectId===id);
 const prepare=async count=>{for(let i=0;i<count;i++){service.projectQueue.feed();await Promise.all([service.autopilot.tick({lane:'generation',slot:0}),service.autopilot.tick({lane:'generation',slot:1})]);await service.autopilot.selectPending();}};
 await q('/autopilot/source',{spreadsheetId:'batch',range:'Sites!A1:F200',serviceAccount:{client_email:'fixture@example.com',private_key:'fixture'},columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'}});
 const first=await add('First project',110);assert.equal(first.status,201);await prepare(56);let view=await project(first.project.id);assert.equal(view.publicationPlan.count,110);assert.equal(new Set(view.items.map(i=>i.selectedSite.baseUrl)).size,110);assert.equal(created,0);
 assert.equal((await q('/projects/'+first.project.id+'/queue/start',{planToken:view.publicationPlan.token})).queued,110);
 for(let i=0;i<9;i++)await service.tick({lane:'publication'});
 const second=await add('Second project',12);assert.equal(second.status,201);await prepare(7);assert.equal((await project(second.project.id)).publicationPlan.count,12);
 for(let i=0;i<150&&!lost;i++)await service.tick({lane:'publication'});assert.equal(lost,true);assert.equal(created,11);
 const interrupted=service.store.listRecords(first.project.id,'autopilot').find(r=>r.state==='uncertain');assert.ok(interrupted);assert.equal(interrupted.nativePublication.phase,'dispatching');assert.equal(interrupted.nativePublication.postId,11);assert.equal(inspected,3,'automatic recovery must exhaust exactly three safe reads before restart');
 const approvedHtml=new Map(service.store.listPages(first.project.id).map(p=>[p.id,JSON.stringify(p.config)]));
 await service.close();service=await createLifecycleService(settings);reconciliationOffline=false;assert.equal(created,11);assert.equal(published,11);assert.equal((await project(second.project.id)).items.every(i=>i.state==='awaiting_review'),true);
 const reconciliation=await q('/autopilot/'+interrupted.id+'/reconciliation');assert.equal(reconciliation.status,200);assert.equal(reconciliation.publication.postId,11);
 const observed=await q('/autopilot/'+interrupted.id+'/reconcile',{expectedRevision:reconciliation.run.revision});assert.equal(observed.status,200,JSON.stringify(observed));assert.equal(observed.observation,'published');assert.equal(observed.publication.postId,11);assert.equal(created,11);assert.equal(published,11);assert.equal(inspected,4,'explicit reconciliation reads the same remote page after restart');
 for(const run of service.store.listRecords(first.project.id,'autopilot'))if(run.state==='paused'){const resumed=await q('/autopilot/'+run.id+'/resume',{});assert.equal(resumed.status,202,JSON.stringify(resumed));}
 for(let i=0;i<500;i++){if(service.store.listRecords(first.project.id,'autopilot').every(r=>r.state==='completed'))break;await service.tick({lane:'publication'});}
 const final=await project(first.project.id);assert.equal(final.counts.completed,110,JSON.stringify(final.items.filter(i=>i.state!=='completed').map(i=>({state:i.state,error:i.error}))));assert.ok(final.items.every(i=>i.state==='completed'));assert.equal(created,110);assert.equal(published,110);assert.equal(inspected,4);assert.equal(maxInFlight,1);assert.equal(new Set([...remote.values()].map(p=>p.url)).size,110);
 for(const page of service.store.listPages(first.project.id))assert.equal(JSON.stringify(page.config),approvedHtml.get(page.id));
 assert.equal((await project(second.project.id)).items.every(i=>i.state==='awaiting_review'),true);assert.doesNotMatch(JSON.stringify(final),/fixture-secret|ciphertext|candidateCredential/);assert.ok(reads<5,'Preparation must share the full source snapshot');
});
