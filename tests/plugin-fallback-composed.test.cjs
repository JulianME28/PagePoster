const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {chromium}=require('./browser-runtime.cjs').playwright;
const executablePath=require('./browser-runtime.cjs').chromePath;
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');

test('real native fallback trashes a CSS-broken publication before the same approved page completes on a second donor',async t=>{
 const [{createLifecycleService},{createWordPressUI},{createWordPressClient},{createBrowserVerifier}]=await Promise.all([import('../server/lifecycle/service.mjs'),import('../server/lifecycle/wordpress-ui.mjs'),import('../server/lifecycle/wordpress.mjs'),import('../server/lifecycle/browser-check.mjs')]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-composed-fallback-'));
 const denied='https://plugin-denied.example/',good='https://plugin-ready.example/';
 const donors=[denied,good].map((baseUrl,index)=>({id:'fixture-donor-'+index,baseUrl,rowNumber:index+2,username:'fixture-admin',password:'fixture-password'}));
 const sites=new Map(donors.map((donor,index)=>[new URL(donor.baseUrl).origin,{postId:index?91:71,post:null,creates:0,publishes:0,trashes:0}]));
 const calls=[],events=[],selections=[],violations=[];let service,runId,approvedHtml,pageId;
 const doc=(text,status=200)=>({status,headers:{'content-type':'text/html; charset=utf-8'},text:'<!doctype html><meta charset="utf-8">'+text});
 const redirect=location=>({status:302,headers:{location},text:''});
 const menu='<ul id="adminmenu"><li id="menu-pages"><a href="/wp-admin/edit.php?post_type=page">Pages</a></li></ul>';
 const login='<form id="loginform" action="/wp-login.php" method="post"><input name="log"><input name="pwd" type="password"><input name="redirect_to" type="hidden" value="/wp-admin/"><input id="wp-submit" type="submit"></form>';
 const reject=message=>{violations.push(message);throw Error(message);};
 const editor=(origin,state)=>doc(menu+'<form id="post" action="post.php" method="post"><input id="title" name="post_title" value="'+esc(state.post.title)+'"><textarea id="content" name="content">'+esc(state.post.content)+'</textarea><input name="post_ID" value="'+state.postId+'"><input name="post_type" value="page"><input name="action" value="editpost"><input name="_wpnonce" value="fixture-save"><input id="original_post_status" value="'+state.post.status+'"><button id="publish" name="publish">Publish</button></form>'+(state.post.status==='publish'?'<a id="sample-permalink" href="'+origin+'/owned-page/">View</a>':''));
 function row(state){const post=state.post,id=state.postId;return '<tr id="post-'+id+'" class="iedit type-page status-'+post.status+'"><td><strong>'+esc(post.title)+'</strong><div class="hidden" id="inline_'+id+'"><div class="post_title">'+esc(post.title)+'</div><div class="_status">'+post.status+'</div></div><div class="row-actions">'+(post.status==='trash'?'<span class="untrash"><a href="post.php?post='+id+'&action=untrash&_wpnonce=fixture-restore">Restore</a></span><span class="delete"><a href="post.php?post='+id+'&action=delete&_wpnonce=fixture-permanent">Delete permanently</a></span>':'<span class="trash"><a href="post.php?post='+id+'&action=trash&_wpnonce=fixture-trash">Move to Trash</a></span>')+'</div></td></tr>';}
 const transport=async(address,init={})=>{
  const url=new URL(address),method=init.method||'GET',state=sites.get(url.origin);
  // Every remote callback terminates here; no native browser or client request
  // is forwarded to DNS, an HTTP server, a proxy or a non-fixture origin.
  if(!state)return reject('Non-fixture origin: '+url.origin);
  calls.push({url:address,method});if(!['GET','POST'].includes(method))return reject('Unexpected fixture method: '+method);
  if(/pageposter-bridge|application-passwords|pageposter\/v1|wp-json/.test(address))return reject('Native flow attempted an API or Bridge route');
  if(url.pathname==='/wp-login.php'){
   if(method==='GET')return doc(login);
   const fields=new URLSearchParams(init.body.toString());if(fields.get('log')!=='fixture-admin'||fields.get('pwd')!=='fixture-password')return reject('Unexpected fixture credentials');
   events.push('login:'+url.hostname);const target=fields.get('redirect_to');assert.equal(target,url.origin+'/wp-admin/plugins.php');
   return {status:302,headers:{location:target,'set-cookie':['wordpress_logged_in_fixture=ok; Path=/; Secure; HttpOnly']},text:''};
  }
  if(url.pathname==='/wp-admin/plugins.php'){
   assert.equal(method,'GET');if(url.origin===new URL(denied).origin){events.push('plugin-denied');return doc('<div class="wp-die-message">Sorry, you are not allowed to access this page.</div>',403);}
   return doc(menu+'<table class="plugins"><tbody id="the-list"><tr data-plugin="pageposter-clean-links/pageposter-clean-links.php" class="active"><td><div class="plugin-version-author-uri">Version 1.1.3 | PagePoster</div></td></tr></tbody></table>');
  }
  if(url.pathname==='/wp-admin/edit.php'){
   assert.equal(method,'GET');assert.equal(url.searchParams.get('post_type'),'page');
   const trash=url.searchParams.get('post_status')==='trash',shown=state.post&&(trash?state.post.status==='trash':state.post.status==='publish');
   if(trash&&shown)events.push('trash-confirmed:'+url.hostname);
   return doc(menu+'<h1>Pages <a class="page-title-action" href="post-new.php?post_type=page">Add New</a></h1><table class="wp-list-table"><tbody id="the-list">'+(shown?row(state):'<tr class="no-items"><td>No items</td></tr>')+'</tbody></table>');
  }
  if(url.pathname==='/wp-admin/post-new.php'){
   assert.equal(method,'GET');assert.equal(url.searchParams.get('post_type'),'page');assert.equal(state.creates,0,'Each donor may create only one owned draft');
   state.creates++;state.post={title:'',content:'',status:'auto-draft'};events.push('create:'+url.hostname);return editor(url.origin,state);
  }
  if(url.pathname==='/wp-admin/post.php'){
   if(method==='POST'){
    const fields=new URLSearchParams(init.body.toString());assert.equal(fields.get('post_ID'),String(state.postId));assert.equal(fields.get('action'),'editpost');assert.equal(fields.get('post_type'),'page');assert.ok(fields.has('publish'));assert.equal(fields.get('content'),approvedHtml);
    const durable=service.store.getRecord(runId);assert.equal(durable.nativePublication.phase,'dispatching');assert.equal(durable.nativePublication.postId,state.postId);assert.equal(durable.pageId,pageId);
    state.publishes++;state.post={title:fields.get('post_title'),content:fields.get('content'),status:'publish'};events.push('publish:'+url.hostname);return redirect('/wp-admin/post.php?post='+state.postId+'&action=edit');
   }
   assert.equal(url.searchParams.get('post'),String(state.postId));
   if(url.searchParams.get('action')==='trash'){
    assert.equal(url.origin,new URL(denied).origin);assert.equal(url.searchParams.get('_wpnonce'),'fixture-trash');assert.equal(state.trashes,0);assert.equal(state.post.status,'publish');assert.equal(state.post.content,approvedHtml);
    const durable=service.store.getRecord(runId),check=service.store.getJob(durable.checkJobId),visual=check.result.checks.find(value=>value.kind==='visual_layout');
    assert.equal(durable.nativeCleanup.phase,'dispatching');assert.equal(durable.nativeCleanup.postId,71);assert.equal(durable.nativeCleanup.pageId,pageId);assert.equal(visual.state,'problem');assert.deepEqual(visual.evidence.viewports.map(value=>[value.name,value.state]),[['desktop','problem']]);
    state.trashes++;state.post.status='trash';events.push('trash:'+url.hostname);return redirect('/wp-admin/edit.php?post_type=page&trashed=1&ids='+state.postId);
   }
   if(url.searchParams.get('action')!=='edit')return reject('Unexpected destructive core action');
   if(state.post.status==='trash')return doc('<div class="wp-die-message">This item is in the Trash.</div>');
   return editor(url.origin,state);
  }
  if(url.pathname==='/owned-page/'){
   assert.equal(method,'GET');assert.equal(state.post.status,'publish');
   const published=url.origin===new URL(denied).origin?state.post.content.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,''):state.post.content;
   if(url.origin===new URL(denied).origin)assert.notEqual(published,state.post.content,'First fixture must actually omit prepared CSS');
   return doc(published);
  }
  if(url.pathname==='/robots.txt')return {status:200,headers:{'content-type':'text/plain'},text:'User-agent: *\nAllow: /'};
  if(url.pathname==='/favicon.ico')return {status:404,headers:{'content-type':'text/plain'},text:''};
  return reject('Unexpected fixture route: '+url.pathname);
 };
 const source={readCandidates:async()=>({candidates:donors,issues:[]}),pickUnused:async(_config,options)=>{
  selections.push([...options.usedOrigins]);const next=donors.find(donor=>!options.usedOrigins.includes(new URL(donor.baseUrl).origin));
  if(next?.baseUrl===good){assert.equal(sites.get(new URL(denied).origin).post.status,'trash');assert.ok(events.includes('trash-confirmed:plugin-denied.example'));events.push('select:plugin-ready.example');}
  return next;
 }};
 const testChromium={launch:options=>{assert.equal(options.headless,true,'Composed fixtures must remain headless');return chromium.launch(options);}};
 const browser=createWordPressUI({chromium:testChromium,executablePath,headless:true,transport});
 service=await createLifecycleService({dataDir:dir,maxPages:1,masterKey:Buffer.alloc(32,64).toString('base64'),visibleBrowser:browser,autopilotOptions:{source,bootstrapFactory:()=>reject('Native flow attempted legacy bootstrap')},client:createWordPressClient({transport}),bridgeClient:{checkStatus:()=>reject('Native flow attempted Bridge status')},browserVerifier:createBrowserVerifier({chromium:testChromium,executablePath,transport,timeoutMs:30000})});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const reply=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));const result=await reply.json();assert.ok(reply.status<400,JSON.stringify(result));return result;};
 await q('/autopilot/browser-settings',{mode:'hidden'});
 await q('/autopilot/source',{spreadsheetId:'composedFixtureSheet123',range:'Sites!A1:C10',columns:{url:'A',username:'B',password:'C'},serviceAccount:{client_email:'reader@fixture.iam.gserviceaccount.com',private_key:'fixture'}});
 const project=service.store.createProject({name:'Composed plugin fallback fixture'});
 const input={source:'html',chromeMode:'overlay-only',html:'<style>body{margin:0}#pp-landing{box-sizing:border-box;width:100%;max-width:980px;margin:0 auto;padding:24px;background:#fff;color:#17202a;font-family:Arial,sans-serif;font-size:20px;line-height:1.5}#pp-landing h1{font-size:36px;line-height:1.2}#pp-landing h2{font-size:28px}#pp-landing p{margin:20px 0}</style><div id="pp-landing"><h1>Prepared fallback page</h1><p>This prepared page contains enough readable content to compare its typography and responsive layout on desktop.</p><h2>Required details</h2><p>These details must remain readable and fit the prepared content wrapper after native WordPress publication.</p></div>'};
 const preview=await q('/autopilot/preview',input),launched=await q('/projects/'+project.id+'/autopilot',{...input,idempotencyKey:crypto.randomUUID(),reviewToken:preview.reviewToken,reviewBeforePublish:true});runId=launched.run.id;
 await service.tick();let current=service.store.getRecord(runId);pageId=current.pageId;assert.ok(pageId);approvedHtml=(await q('/autopilot/'+runId+'/html')).html;assert.ok(approvedHtml.includes('<style'));
 const review=await q('/autopilot/'+runId+'/html');await q('/autopilot/'+runId+'/approve',{reviewToken:review.reviewToken});
 for(let tick=0;tick<18;tick++){await service.tick();current=service.store.getRecord(runId);if(['completed','needs_attention','uncertain'].includes(current.state))break;}
 assert.equal(current.state,'completed',JSON.stringify({run:{state:current.state,stage:current.stage,error:current.error,nativePublication:current.nativePublication,nativeCleanup:current.nativeCleanup},events,violations,calls}));assert.equal(current.pageId,pageId);assert.equal((await q('/autopilot/'+runId+'/html')).html,approvedHtml);
 assert.equal(service.store.getPage(pageId).fullUrl,good+'owned-page/');assert.equal(service.store.getPage(pageId).verification.state,'ok');
 assert.equal(current.destinationHistory.length,1);const history=current.destinationHistory[0];assert.equal(history.baseUrl,denied);assert.equal(history.nativePublication.postId,71);assert.equal(history.nativeCleanup.phase,'trashed');assert.equal(history.nativeCleanup.pageId,pageId);
 const firstCheck=service.store.getJob(history.checkJobId),visual=firstCheck.result.checks.find(value=>value.kind==='visual_layout');assert.equal(visual.state,'problem');assert.deepEqual(visual.evidence.viewports.map(value=>value.state),['problem']);
 assert.equal(service.store.getSite(history.siteId).plugins.cleanLinks.state,'unavailable');assert.equal(current.donorSkips[0].code,'NATIVE_VISUAL_REJECTED');assert.equal(current.donorSkips[0].baseUrl,denied);
 for(const [origin,state]of sites){assert.equal(state.creates,1);assert.equal(state.publishes,1);assert.equal(state.post.content,approvedHtml);assert.equal(state.post.status,origin===new URL(denied).origin?'trash':'publish');assert.equal(state.trashes,origin===new URL(denied).origin?1:0);}
 assert.equal(selections.length,2);assert.ok(selections[1].includes(new URL(denied).origin));assert.deepEqual(violations,[]);
 assert.ok(events.indexOf('plugin-denied')<events.indexOf('publish:plugin-denied.example'));assert.ok(events.indexOf('trash-confirmed:plugin-denied.example')<events.indexOf('select:plugin-ready.example'));assert.ok(events.indexOf('select:plugin-ready.example')<events.indexOf('publish:plugin-ready.example'));
 assert.equal(calls.some(call=>/action=(?:delete|untrash)|plugin-install\.php|update\.php/.test(call.url)),false);assert.equal(calls.filter(call=>new URL(call.url).searchParams.get('action')==='trash').length,1);
});
