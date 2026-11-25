'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('./browser-runtime.cjs').playwright;
const executablePath=require('./browser-runtime.cjs').chromePath;
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const json=value=>JSON.stringify(value).replaceAll('<','\\u003c');

// Removing the project approval boundary, global publication ownership, native
// editor write guard, exact-content verification, or session retirement must
// fail this test. Only the external HTTPS/site-source boundaries are synthetic.
test('20 Classic/Gutenberg browser publications recover a lost response, transient public read and orderly midpoint restart while another project stays unapproved',{timeout:180000},async t=>{
 const [{createLifecycleService},{createWordPressUI},{createWordPressClient},{createBrowserVerifier}]=await Promise.all([
  import('../server/lifecycle/service.mjs'),import('../server/lifecycle/wordpress-ui.mjs'),import('../server/lifecycle/wordpress.mjs'),import('../server/lifecycle/browser-check.mjs')
 ]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-publication20-')),states=['active','inactive','missing','denied'];
 const sites=Array.from({length:24},(_,index)=>({index,origin:'https://publication20-'+index+'.example',plugin:states[index%4],installed:index%4<2,active:index%4===0,block:index%2===1,post:null,creates:0,publishes:0,uploads:0,activations:0,publicReads:0,privateReads:0,editorReads:0,logins:[]}));
 const byOrigin=new Map(sites.map(site=>[site.origin,site])),requests=[],browserErrors=[],sessions=new Set(),approved=new Map(),opened=new Set();
 const slowAsset='https://challenges.cloudflare.com/turnstile/v0/publication20-notice.svg';
 let service,inFlight=0,maxInFlight=0,maxUnfinished=0,maxLivePrivateSessions=0,delayedAssets=0,abortedAssets=0,finishedAssets=0,launches=0;
 let lostResponses=0,lostResponsePostId=null,lostResponseInspections=0,publicFaults=0,restarts=0;
 const started=performance.now();
 const html=(text,status=200)=>({status,headers:{'content-type':'text/html; charset=utf-8'},text:'<!doctype html><meta charset="utf-8">'+text});
 const redirect=url=>({status:302,headers:{location:url},text:''});
 const adminMenu='<ul id="adminmenu"><li id="menu-pages"><a href="edit.php?post_type=page">Pages</a></li><li id="menu-plugins"><a href="plugins.php">Plugins</a></li></ul>';
 const loginForm='<form id="loginform" action="/wp-login.php" method="post"><input name="log"><input name="pwd" type="password"><input type="submit"></form>';
 const owner=()=>{
  const value=service.autopilot.publicationTurn.owner();assert.ok(value,'Every native admin request keeps the global publication owner');
  assert.equal(service.store.getRecord('publication-turn:global').releasedAt,null);return value;
 };
 const unfinished=()=>{
  const runs=service.store.listProjects().flatMap(project=>service.store.listRecords(project.id,'autopilot'));
  const current=runs.filter(run=>run.nativePublication&&!['completed','deleted'].includes(run.state));
  maxUnfinished=Math.max(maxUnfinished,current.length);assert.ok(current.length<=1,'At most one native page remains unfinished globally');
 };
 function editor(site){
  const p=site.post;
  if(site.block)return html(adminMenu+'<div id="editor"><h1 contenteditable="true" class="editor-post-title__input">'+escape(p.title)+'</h1><textarea hidden class="editor-post-text-editor">'+escape(p.content)+'</textarea><button class="editor-post-publish-button">Publish</button></div>'+
   '<script>let p='+json(p)+';const title=document.querySelector(".editor-post-title__input"),content=document.querySelector("textarea");window.wp={editPost:{initializeEditor(){}},data:{select:()=>({getCurrentPostId:()=>p.postId,getCurrentPost:()=>({status:p.status,link:p.url}),getEditedPostAttribute:()=>title.textContent,getEditedPostContent:()=>content.value})}};document.addEventListener("keydown",e=>{if(e.ctrlKey&&e.altKey&&e.shiftKey){e.preventDefault();content.hidden=false;}});document.querySelector("button").onclick=async()=>{p=await(await fetch("/wp-json/wp/v2/pages/"+p.postId,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:title.textContent,content:content.value,status:"publish"})})).json();};</script>'+
   '<script id="wp-edit-post-js-after">wp.editPost.initializeEditor("editor","page",'+p.postId+',{});</script>');
  return html(adminMenu+'<form id="post" action="post.php" method="post"><input name="post_title" id="title" value="'+escape(p.title)+'"><textarea id="content" name="content">'+escape(p.content)+'</textarea><input name="post_ID" value="'+p.postId+'"><input name="post_type" value="page"><input name="action" value="editpost"><input id="original_post_status" value="'+p.status+'"><button id="publish" name="publish">Publish</button></form>'+(p.status==='publish'?'<a id="sample-permalink" href="'+p.url+'">View</a>':''));
 }
 const transport=async(address,init={})=>{
  const u=new URL(address),method=init.method||'GET';assert.equal(u.protocol,'https:');
  assert.doesNotMatch(address,/pageposter-bridge|application-passwords|pageposter\/v1/);
  if(address===slowAsset){
   assert.equal(method,'GET');delayedAssets++;
   // A synthetic third-party notice image remains pending after the usable
   // plugin DOM. Navigation must not require its load event to complete.
   return new Promise((resolve,reject)=>{
    const finish=()=>{init.signal?.removeEventListener('abort',abort);finishedAssets++;resolve({status:200,headers:{'content-type':'image/svg+xml'},text:'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'});};
    const timer=setTimeout(finish,2000),abort=()=>{clearTimeout(timer);abortedAssets++;reject(Object.assign(Error('Synthetic notice cancelled'),{code:'BROWSER_REQUEST_CANCELLED'}));};
    if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true});
   });
  }
  const site=byOrigin.get(u.origin);assert.ok(site,'All requests stay within the explicitly injected synthetic origins');
  requests.push({index:site.index,path:u.pathname,method});
  if(u.pathname.startsWith('/wp-admin/')||u.pathname==='/wp-login.php')assert.equal(new URL(owner().candidate.baseUrl).origin,site.origin,'Native requests retain their exact donor owner');
  if(u.pathname==='/wp-login.php'){
   if(method==='GET')return html(loginForm);
   assert.equal(method,'POST');const fields=new URLSearchParams(init.body.toString());site.logins.push(fields.get('log'));
   assert.equal(fields.get('redirect_to'),site.origin+'/wp-admin/plugins.php');
   if(fields.get('pwd')!=='fixture-password')return html('<div id="login_error">Incorrect password</div>'+loginForm);
   return {status:302,headers:{location:fields.get('redirect_to'),'set-cookie':['wordpress_logged_in_fixture='+fields.get('log')+'; Path=/; Secure; HttpOnly']},text:''};
  }
  if(u.pathname.startsWith('/wp-admin/')||u.pathname.startsWith('/wp-json/'))assert.match(init.headers?.cookie||'',/wordpress_logged_in_fixture=/);
  if(u.pathname==='/wp-admin/plugins.php'){
   if(site.plugin==='denied')return html('<div class="wp-die-message">Sorry, you are not allowed to access this page.</div>',500);
   if(u.searchParams.get('action')==='activate'){assert.equal(site.installed,true);assert.equal(site.active,false);site.activations++;site.active=true;return redirect('/wp-admin/plugins.php');}
   return html(adminMenu+'<table class="wp-list-table widefat plugins"><tbody id="the-list">'+(site.installed?'<tr data-plugin="pageposter-clean-links/pageposter-clean-links.php" class="'+(site.active?'active':'inactive')+'"><td><div class="plugin-version-author-uri">Version 1.1.3 | PagePoster</div><a href="plugins.php?action=activate&plugin=pageposter-clean-links%2Fpageposter-clean-links.php&_wpnonce=fixture">Activate</a></td></tr>':'<tr class="no-items"><td>No plugins found.</td></tr>')+'</tbody></table><div class="tablenav bottom"></div>'+(site.index===1?'<img alt="" width="1" height="1" src="'+slowAsset+'">':''));
  }
  if(u.pathname==='/wp-admin/plugin-install.php'){
   assert.equal(site.plugin,'missing');return html(adminMenu+'<form action="update.php?action=upload-plugin" method="post" enctype="multipart/form-data"><input name="_wpnonce" value="fixture"><input type="file" name="pluginzip"><input type="submit"></form>');
  }
  if(u.pathname==='/wp-admin/update.php'){
   assert.equal(method,'POST');assert.equal(site.installed,false);assert.match(init.body.toString('latin1'),/pageposter-clean-links-1\.1\.3.zip/);site.uploads++;site.installed=true;return html(adminMenu+'Installed');
  }
  if(u.pathname==='/wp-admin/edit.php'){
   assert.equal(u.searchParams.get('post_type'),'page');assert.equal(site.active,site.plugin!=='denied');return html(adminMenu+'<a class="page-title-action" href="post-new.php?post_type=page">Add New</a>');
  }
  if(u.pathname==='/wp-admin/post-new.php'){
   const run=owner();assert.ok(approved.has(run.id),'An unapproved project cannot create a native draft');assert.equal(site.creates,0,'Each donor receives exactly one native create');
   assert.equal(u.searchParams.get('post_type'),'page');site.creates++;
   site.post={postId:1001+site.index,title:'',content:'',status:'auto-draft',url:site.origin+'/batch-page/'};return editor(site);
  }
  if(u.pathname==='/wp-admin/post.php'||u.pathname==='/wp-json/wp/v2/pages/'+site.post?.postId){
   if(method==='GET'){assert.equal(Number(u.searchParams.get('post')),site.post.postId);site.editorReads++;if(site.index===5&&lostResponses)lostResponseInspections++;return editor(site);}
   assert.equal(method,'POST');const run=owner();assert.equal(run.nativePublication?.phase,'dispatching');
   const wanted=approved.get(run.id);assert.ok(wanted);assert.equal(site.publishes,0,'The browser must never send the same publication twice');
   const fields=site.block?JSON.parse(init.body.toString()):Object.fromEntries(new URLSearchParams(init.body.toString()));
   assert.equal(site.block?fields.status:'publish','publish');assert.equal(site.block?fields.title:fields.post_title,wanted.title);
   // Gutenberg's native Custom HTML wrapper is editor structure. The supplied
   // approved HTML must survive byte-for-byte inside that exact single wrapper.
   assert.equal(fields.content,site.block?'<!-- wp:html -->\n'+wanted.html+'\n<!-- /wp:html -->':wanted.html);
   inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);unfinished();
   try{
    await new Promise(resolve=>setTimeout(resolve,5));site.publishes++;site.post={...site.post,title:wanted.title,content:fields.content,status:'publish'};
    if(site.index===5&&!lostResponses){
     lostResponses++;lostResponsePostId=site.post.postId;
     // WordPress committed the exact Gutenberg payload; only its response is
     // lost. Recovery must inspect this known ID without another native write.
     throw Object.assign(Error('Synthetic response lost after committed Publish'),{code:'network_timeout'});
    }
    return site.block?{status:200,headers:{'content-type':'application/json'},text:JSON.stringify(site.post)}:redirect('/wp-admin/post.php?post='+site.post.postId+'&action=edit');
   }finally{inFlight--;}
  }
  if(u.pathname==='/batch-page/'){
   assert.equal(new URL(owner().candidate.baseUrl).origin,site.origin,'The global turn is retained throughout real public verification');
   assert.equal(method,'GET');assert.equal(site.post?.status,'publish');assert.equal(init.headers?.authorization,undefined);
   if(init.headers?.cookie){assert.match(init.headers.cookie,/wordpress_logged_in_fixture=/);site.privateReads++;}
   else{
    site.publicReads++;
    if(site.index===12&&!publicFaults){publicFaults++;throw Object.assign(Error('Synthetic transient anonymous GET outage'),{code:'network_timeout'});}
   }
   return {...html('<style>body{min-height:100vh}</style>'+site.post.content),url:address};
  }
  if(u.pathname==='/robots.txt'){assert.equal(new URL(owner().candidate.baseUrl).origin,site.origin);return {status:200,headers:{'content-type':'text/plain'},text:'User-agent: *\nAllow: /\n'};}
  throw Error('Forbidden synthetic request '+method+' '+u.pathname);
 };
 const testChromium={launch:async options=>{
  assert.equal(options.headless,true,'Only isolated headless Chrome is allowed');assert.ok(options.args.includes('--host-resolver-rules=MAP * ~NOTFOUND'),'External DNS must remain disabled');launches++;
  return chromium.launch(options);
 }};
 const createBrowser=()=>{
  const browser=createWordPressUI({chromium:testChromium,executablePath,headless:true,transport}),open=browser.open;
  browser.open=async(...args)=>{
   try{
    assert.equal(owner().id,args[0]);const session=await open(...args);sessions.add(session);opened.add(args[0]);
    const live=[...sessions].filter(value=>!value.page.isClosed()).length;maxLivePrivateSessions=Math.max(maxLivePrivateSessions,live);assert.equal(live,1,'Only one private publication session may stay open');return session;
   }catch(error){browserErrors.push({runId:args[0],method:'open',code:error.code||error.name});throw error;}
  };
  return browser;
 };
 const donors=sites.map(site=>({id:'fixture-row-'+site.index,baseUrl:site.origin+'/',rowNumber:site.index+2,username:'admin',password:site.index===0?'wrong-fixture':'fixture-password',...(site.index===0?{alternateCredentials:{username:'backup-admin',password:'fixture-password'}}:{}),metrics:{dr:70-site.index,traffic:2000,geo:['PL']}}));
 const source={readCandidates:async()=>({candidates:donors,issues:[]}),pickUnused:async(config,options)=>donors.find(candidate=>!options.usedOrigins.includes(new URL(candidate.baseUrl).origin))};
 const forbidden=()=>assert.fail('This synthetic batch cannot call Google, AI, Bridge or legacy publication APIs');
 const boot=async()=>{service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,109).toString('base64'),visibleBrowser:createBrowser(),autopilotOptions:{source,planner:{generate:forbidden},bootstrapFactory:forbidden},client:createWordPressClient({transport}),bridgeClient:{checkStatus:forbidden,submitOperation:forbidden,getOperation:forbidden},browserVerifier:createBrowserVerifier({chromium:testChromium,executablePath,transport,timeoutMs:20000})});};
 await boot();
 t.after(async()=>{await service.close();assert.ok(path.resolve(dir).startsWith(path.join(path.resolve(os.tmpdir()),'pp-publication20-')));fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{
  const response=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const result=await response.json();assert.ok(response.status<400,JSON.stringify({route,status:response.status,result}));return result;
 };
 const project=async id=>(await q('/project-queue')).projects.find(value=>value.projectId===id);
 const add=async(name,count)=>q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name,type:'html',items:Array.from({length:count},(_,index)=>({key:name+'-'+index,source:'html',title:'Batch page '+index,html:'<style>h1{font-size:32px}p{max-width:600px}</style><h1>Batch page '+index+'</h1><p>Exact supplied text '+index+' — café &amp; original.</p><pre data-original="'+index+'">  Keep  spaces\n&amp; &lt;tag&gt;</pre>',language:'en',geo:'PL',siteSelection:{minDr:20,minTraffic:100,geo:'PL'}}))});
 const prepare=async rounds=>{
  for(let index=0;index<rounds;index++){service.projectQueue.feed();await Promise.all([service.autopilot.tick({lane:'generation',slot:0}),service.autopilot.tick({lane:'generation',slot:1})]);await service.autopilot.selectPending();}
 };
 await q('/autopilot/browser-settings',{mode:'hidden'});
 await q('/autopilot/source',{spreadsheetId:'synthetic-publication20',range:'Sites!A1:F100',columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'},serviceAccount:{client_email:'reader@fixture.iam.gserviceaccount.com',private_key:'fixture'}});
 const first=await add('Approved twenty',20);await prepare(11);let view=await project(first.project.id);
 assert.equal(view.items.length,20);assert.equal(view.publicationPlan.count,20);assert.equal(new Set(view.items.map(item=>item.selectedSite.baseUrl)).size,20);assert.equal(requests.length,0);
 for(const item of view.items){const snapshot=await q('/autopilot/'+item.runId+'/html');approved.set(item.runId,{html:snapshot.html,title:service.store.getPage(item.pageId).title});}
 const second=await add('Unapproved separate project',3);await prepare(3);const unapproved=await project(second.project.id);
 assert.equal(unapproved.publicationPlan.count,3);assert.ok(unapproved.items.every(item=>item.state==='awaiting_review'));assert.equal(requests.length,0);
 const untouched=unapproved.items.map(item=>({run:service.store.getRecord(item.runId),page:service.store.getPage(item.pageId)}));
 const admitted=await q('/projects/'+first.project.id+'/queue/start',{planToken:view.publicationPlan.token});assert.equal(admitted.queued,20);
 for(let tick=0;tick<160;tick++){
  await service.tick({lane:'publication'});unfinished();view=await project(first.project.id);
  const blocked=view.items.find(item=>['failed','needs_attention','uncertain'].includes(item.state));
  const blockedJob=blocked&&service.store.getJob(service.store.getRecord(blocked.runId).checkJobId);
  assert.ok(!blocked,JSON.stringify({blocked:blocked&&{key:blocked.key,state:blocked.state,stage:blocked.stage,error:blocked.error,pluginFallback:blocked.pluginFallback},checks:blockedJob?.result?.checks?.map(check=>({kind:check.kind,state:check.state,code:check.code||check.evidence?.code||null})),creates:sites.reduce((n,s)=>n+s.creates,0),publishes:sites.reduce((n,s)=>n+s.publishes,0),lostResponses,lostResponseInspections,publicFaults,restarts,browserErrors}));
  if(!restarts&&view.items.filter(item=>item.state==='completed').length===10&&service.autopilot.publicationTurn.owner()===null){
   const before={creates:sites.reduce((n,site)=>n+site.creates,0),publishes:sites.reduce((n,site)=>n+site.publishes,0)};
   const continuing=view.items.filter(item=>item.state!=='completed').map(item=>({run:service.store.getRecord(item.runId),page:service.store.getPage(item.pageId)}));assert.equal(continuing.length,10);
   await service.close();assert.ok([...sessions].every(session=>session.page.isClosed()));await boot();restarts++;
   assert.deepEqual({creates:sites.reduce((n,site)=>n+site.creates,0),publishes:sites.reduce((n,site)=>n+site.publishes,0)},before,'Restart cannot create or write a native page');
   // A quiesced restart preserves idle admitted work. Continue the exact same
   // persisted approvals and prepared pages, without approving another project.
   assert.deepEqual(continuing.map(value=>({run:service.store.getRecord(value.run.id),page:service.store.getPage(value.page.id)})),continuing);
  }
  const recovery=service.autopilot.publicationTurn.owner()?.publicationRecovery;
  if(recovery?.state==='waiting'&&Date.parse(recovery.retryAt)>Date.now())await new Promise(resolve=>setTimeout(resolve,Math.min(200,Date.parse(recovery.retryAt)-Date.now())));
  if(view.items.every(item=>item.state==='completed')&&service.autopilot.publicationTurn.owner()===null)break;
 }
 const final=await q('/project-queue');view=final.projects.find(value=>value.projectId===first.project.id);
 assert.equal(view.counts.completed,20,JSON.stringify(view.items.map(item=>({key:item.key,state:item.state,stage:item.stage,error:item.error}))));
 assert.ok(view.items.every(item=>item.state==='completed'));assert.equal(final.publication.owner,null);
 assert.equal(maxInFlight,1);assert.equal(maxUnfinished,1);assert.equal(maxLivePrivateSessions,1);assert.equal(opened.size,20);
 const usedSites=new Set();
 for(const item of view.items){
  const wanted=approved.get(item.runId),page=service.store.getPage(item.pageId),site=byOrigin.get(new URL(item.selectedSite.baseUrl).origin);usedSites.add(site);
  assert.equal(site.creates,1);assert.equal(site.publishes,1);assert.equal(site.post.title,wanted.title);assert.equal(page.title,wanted.title);assert.equal(site.post.content,site.block?'<!-- wp:html -->\n'+wanted.html+'\n<!-- /wp:html -->':wanted.html);
  assert.equal(requests.filter(request=>request.index===site.index&&request.path==='/wp-admin/post-new.php').length,1,'Even a rejected duplicate create attempt must fail the batch');
  assert.equal(requests.filter(request=>request.index===site.index&&request.method==='POST'&&(request.path==='/wp-admin/post.php'||request.path.startsWith('/wp-json/wp/v2/pages/'))).length,1,'Response recovery cannot attempt another native write');
  assert.equal((await q('/autopilot/'+item.runId+'/html')).html,wanted.html);assert.equal(page.remoteSnapshot.content,wanted.html);assert.equal(page.wpId,site.post.postId);assert.equal(page.fullUrl,site.post.url);assert.equal(page.lifecycleState,'published');assert.equal(page.verification.state,'ok');assert.equal(item.skippedSites.length,0);
  assert.ok(site.editorReads>=1);assert.ok(site.privateReads>=1,'Every published result is also opened by the real private session');assert.ok(site.publicReads>=2,'Every completed page gets anonymous public content and real browser verification');
  assert.equal(site.uploads,site.plugin==='missing'?1:0);assert.equal(site.activations,['missing','inactive'].includes(site.plugin)?1:0);
  const storedSite=service.store.getSite(page.siteId);assert.equal(storedSite.plugins.cleanLinks.state,site.plugin==='denied'?'unavailable':'active');
  assert.equal(service.store.getRecord(item.runId).nativePluginFallback?.code||null,site.plugin==='denied'?'CLEAN_LINKS_INSTALL_FORBIDDEN':null);
 }
 assert.equal(usedSites.size,20);assert.equal([...usedSites].filter(site=>site.block).length,10);for(const state of states)assert.equal([...usedSites].filter(site=>site.plugin===state).length,5);
 assert.equal(sites.reduce((n,site)=>n+site.creates,0),20);assert.equal(sites.reduce((n,site)=>n+site.publishes,0),20);assert.equal(sites.reduce((n,site)=>n+site.uploads,0),5);assert.equal(sites.reduce((n,site)=>n+site.activations,0),10);
 assert.deepEqual(sites[0].logins,['admin','backup-admin']);assert.ok(delayedAssets>0,'The browser must actually encounter the synthetic delayed third-party notice');
 assert.equal(lostResponses,1);assert.equal(lostResponsePostId,sites[5].post.postId);assert.ok(lostResponseInspections>=1,'A lost native result must recover through an actual read-only editor inspection');assert.equal(sites[5].creates,1);assert.equal(sites[5].publishes,1);
 assert.equal(publicFaults,1);assert.equal(restarts,1);
 const recovered=view.items.find(item=>new URL(item.selectedSite.baseUrl).origin===sites[12].origin),recoveryJobs=service.store.listJobs(first.project.id).filter(job=>job.type==='page_check'&&job.pageId===recovered.pageId);
 assert.equal(recoveryJobs.length,2,'One transient public read must cause exactly one safe-read check retry');assert.equal(recoveryJobs.filter(job=>job.result?.verification?.state==='unknown'&&job.result?.checks?.some(check=>check.kind==='public'&&check.state==='unknown')).length,1);assert.equal(recoveryJobs.filter(job=>job.result?.verification?.state==='ok').length,1);assert.ok(sites[12].publicReads>=4);assert.equal(sites[12].creates,1);assert.equal(sites[12].publishes,1);
 const unapprovedFinal=final.projects.find(value=>value.projectId===second.project.id);
 assert.deepEqual(unapprovedFinal.items.map(item=>({run:service.store.getRecord(item.runId),page:service.store.getPage(item.pageId)})),untouched);
 assert.ok(unapprovedFinal.items.every(item=>item.state==='awaiting_review'&&!item.wpId&&!item.fullUrl));
 const unused=sites.filter(site=>!usedSites.has(site));assert.ok(unused.every(site=>site.creates===0&&site.publishes===0&&site.logins.length===0));
 assert.doesNotMatch(JSON.stringify(final),/fixture-password|wrong-fixture|backup-admin|candidateCredential|ciphertext/);
 // Drain already-completed work again: admission and browser retirement must
 // not produce another draft, native write, or verification job.
 const writesBefore=sites.reduce((n,site)=>n+site.publishes,0),readsBefore=sites.reduce((n,site)=>n+site.publicReads,0);
 for(let index=0;index<3;index++)await service.tick({lane:'publication'});
 assert.equal(sites.reduce((n,site)=>n+site.publishes,0),writesBefore);assert.equal(sites.reduce((n,site)=>n+site.publicReads,0),readsBefore);
 t.diagnostic(JSON.stringify({pages:20,classic:10,gutenberg:10,pluginStates:states,creates:20,publishes:20,verified:20,maxInFlight,maxUnfinished,maxLivePrivateSessions,unapprovedUntouched:3,uploads:5,activations:10,lostResponses,lostResponseInspections,publicFaults,publicCheckAttempts:recoveryJobs.length,restarts,delayedAssets,abortedAssets,finishedAssets,launches,elapsedMs:Math.round(performance.now()-started)}));
});
