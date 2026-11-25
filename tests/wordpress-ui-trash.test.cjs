const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {chromium}=require('./browser-runtime.cjs').playwright;
const chrome=require('./browser-runtime.cjs').chromePath;
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');

// Only the transport boundary is replaced. The browser, DOM controls, routing,
// checkpoints and resume reconciliation all exercise the production session.
async function fixture(t,{post={},link='post.php?post=71&action=trash&_wpnonce=core-trash',lost=false,applyTrash=true,proof={},hoverActions=false,block=false,beforeSend,checkpoint,hook,assertDispatch,manualEditor=false}={}){
 const {createWordPressUI}=await import('../server/lifecycle/wordpress-ui.mjs');
 const saved={postId:71,phase:'published',url:'https://wp.example/owned-page/'},title='Owned page',html='<main>Exact <b>HTML</b> & text</main>';
 let current={id:71,title,content:html,status:'publish',url:saved.url,...post},trashes=0,guarded=0;
 const calls=[],checkpoints=[],events=[];
 const doc=text=>({status:200,headers:{'content-type':'text/html; charset=utf-8'},text:'<!doctype html><meta charset="utf-8">'+text});
 const menu='<ul id="adminmenu"><li id="menu-pages"><a href="/wp-admin/edit.php?post_type=page">Pages</a></li></ul>';
 function listRow(status){const id=proof.id??current.id,rowStatus=proof.status??status,inlineStatus=proof.inlineStatus??status,rowTitle=proof.title??current.title,restore=proof.restore??'post.php?post=71&action=untrash&_wpnonce=core-restore';return '<tr id="post-'+id+'" class="iedit type-page status-'+rowStatus+'"><td class="title"><a class="row-title">'+esc(rowTitle)+'</a><div class="hidden" id="inline_'+id+'"><div class="post_title">'+esc(rowTitle)+'</div><div class="_status">'+inlineStatus+'</div></div><div class="row-actions">'+(status==='trash'?'<span class="untrash"><a href="'+esc(restore)+'">Restore</a></span><span class="delete"><a href="post.php?post=71&action=delete&_wpnonce=permanent">Delete Permanently</a></span>':'<span class="trash"><a class="submitdelete" href="'+esc(link)+'">Move to Trash</a></span>')+'</div></td></tr>';}
 const transport=async(url,init={})=>{
  const u=new URL(url),method=init.method||'GET';calls.push({url,method});
  const intercepted=await hook?.(u,init,{current,doc,menu,listRow});if(intercepted)return intercepted;
  if(u.pathname==='/wp-login.php')return method==='POST'?{status:302,headers:{location:'/wp-admin/','set-cookie':['wordpress_logged_in_fixture=ok; Path=/; Secure; HttpOnly']},text:''}:doc('<form id="loginform" action="/wp-login.php" method="post"><input name="log"><input name="pwd" type="password"><input id="wp-submit" type="submit"></form>');
  if(u.pathname==='/wp-admin/')return doc(menu);
  if(u.pathname==='/wp-admin/edit.php'){
   assert.equal(u.searchParams.get('post_type'),'page');
   const trash=u.searchParams.get('post_status')==='trash';return doc(menu+(hoverActions?'<style>.row-actions{visibility:hidden}tr:hover .row-actions{visibility:visible}</style>':'')+'<table class="wp-list-table"><tbody id="the-list">'+(trash?(current.status==='trash'?listRow('trash'):'<tr class="no-items"><td>No items</td></tr>'):(current.status==='publish'?listRow('publish'):''))+'</tbody></table>');
  }
  if(u.pathname==='/wp-admin/post.php'){
   if(u.searchParams.get('action')==='trash'){
    events.push('transport');trashes++;assert.equal(method,'GET');assert.equal(u.searchParams.get('post'),'71');
    if(assertDispatch)assertDispatch();else{assert.equal(guarded,1);assert.equal(checkpoints.at(-1)?.phase,'dispatching');}
    if(applyTrash)current.status='trash';if(lost){lost=false;throw Error('lost trash response');}
    return {status:302,headers:{location:'/wp-admin/edit.php?post_type=page&trashed=1&ids=71'},text:''};
   }
   assert.equal(u.searchParams.get('action'),'edit');assert.equal(u.searchParams.get('post'),'71');
   if(current.status==='trash')return doc('<div class="wp-die-message">You cannot edit this item because it is in the Trash.</div>');
   if(block)return doc(menu+'<div id="editor"></div><script>const post='+JSON.stringify(current).replaceAll('<','\\u003c')+';window.wp={data:{select:()=>({getCurrentPostId:()=>post.id,getCurrentPost:()=>({id:post.id,type:"page",status:post.status,link:post.url}),getEditedPostAttribute:()=>post.title,getEditedPostContent:()=>post.content})}};</script>');
   return doc(menu+'<form id="post" method="post" action="/wp-admin/post.php"><input name="post_ID" value="'+current.id+'"><input name="post_type" value="'+esc(current.type||'page')+'"><input name="action" value="editpost"><input name="_wpnonce" value="fixture"><input id="title" name="post_title" value="'+esc(current.title)+'"><textarea name="content" id="content">'+esc(current.content)+'</textarea><input id="original_post_status" value="'+current.status+'"><button type="submit">Update</button></form><a id="sample-permalink" href="'+esc(current.url)+'">View</a>');
  }
  return {status:404,headers:{'content-type':'text/html'},text:'Not found'};
 };
 const manager=createWordPressUI({chromium,executablePath:chrome,headless:true,transport,manualEditor});t.after(()=>manager.close());
 const session=manualEditor?null:await manager.open('trash-run','https://wp.example/');if(session)await session.login({username:'admin',applicationPassword:'fixture-only'});
 const input={saved,title,html,checkpoint:async value=>{events.push(value.phase);await checkpoint?.(value);checkpoints.push(value);},beforeSend:()=>{events.push('beforeSend');beforeSend?.();guarded++;}};
 return {manager,session,input,calls,checkpoints,events,get trashes(){return trashes;},get current(){return current;}};
}

for(const block of [false,true])test('manual review logs into the exact '+(block?'block':'classic')+' editor without taking the publication browser',async t=>{
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 let context,updates=0;
 const f=await fixture(t,{block,manualEditor:true,hook:(url,init,{current})=>{
  if(url.pathname==='/wp-login.php'&&init.method==='POST'){
   const form=new URLSearchParams(init.body.toString());
   assert.equal(form.get('log'),'admin');assert.equal(form.get('pwd'),'fixture-only');
   assert.equal(form.get('redirect_to'),'https://wp.example/wp-admin/');
  }
  if(url.pathname==='/wp-admin/post.php'&&init.method==='GET')assert.match(init.headers.cookie,/wordpress_logged_in_fixture=ok/);
  if(init.method!=='POST'||!['/wp-admin/post.php','/wp-json/wp/v2/pages/71'].includes(url.pathname))return;
  updates++;
  current.title=block?JSON.parse(init.body.toString()).title:new URLSearchParams(init.body.toString()).get('post_title');
  return block?{status:200,headers:{'content-type':'application/json'},text:'{}'}:{status:302,headers:{location:'/wp-admin/post.php?post=71&action=edit&message=1'},text:''};
 }}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-desktop-open-editor-'));
 const reviewBrowser={...f.manager,open:async(id,base,options)=>{assert.equal(options.headless,false);return context=await f.manager.open(id,base,{...options,headless:true});}};
 const service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,92).toString('base64'),desktop:true,reviewBrowser,visibleBrowser:{open(){assert.fail('Used publication browser');},async close(){}}});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const {store}=service,{saved,title}=f.input,project=store.createProject({name:'Manual editor'});
 const site=store.createSite(project.id,{name:'WordPress fixture',baseUrl:'https://wp.example/'});
 store.updateSite(site.id,{bootstrap:{mode:'browser',state:'ready'},username:'admin',applicationPassword:'fixture-only'},site.revision);
 const page=store.createPage(project.id,{title,siteId:site.id,wpId:saved.postId,fullUrl:saved.url,lifecycleState:'published',remoteSnapshot:{status:'publish'}});
 const run=store.createRecord(project.id,'autopilot',{pageId:page.id,siteId:site.id,state:'completed',stage:'completed',candidate:{id:'fixture',baseUrl:site.baseUrl}});
 const openEditor=expectedPageRevision=>service.handle(new Request('http://localhost/api/lifecycle/project-queue/items/'+run.id+'/open-wordpress',{method:'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},body:JSON.stringify({expectedPageRevision})}));
 assert.equal((await openEditor(page.revision+1)).status,409);
 assert.equal(f.calls.length,0);
 const opened=await openEditor(page.revision);
 assert.equal(opened.status,200,JSON.stringify(await opened.json()));
 assert.equal(context.page.url(),'https://wp.example/wp-admin/post.php?post=71&action=edit');
 assert.equal((await openEditor(page.revision)).status,200);
 assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
 assert.equal(f.calls.filter(call=>new URL(call.url).pathname==='/wp-admin/post.php').length,1);
 if(block){
  const update=postId=>context.page.evaluate(async id=>{try{return (await fetch('/wp-json/wp/v2/pages/'+id,{method:'POST',headers:{'content-type':'application/json','x-http-method-override':'PUT'},body:JSON.stringify({title:'Manual update'})})).status;}catch{return 0;}},postId);
  assert.equal(await update(72),0);assert.equal(await update(71),200);
 }else{
  await context.page.locator('#title').fill('Manual update');
  await context.page.getByRole('button',{name:'Update'}).click();
  await context.page.waitForURL('**&message=1');
 }
 assert.equal(updates,1);assert.equal(f.current.title,'Manual update');assert.equal(store.getPage(page.id).revision,page.revision);
 assert.equal(f.calls.some(call=>/plugins?\.php|post-new\.php/.test(call.url)),false);
});

test('the desktop review route moves the owned page to the WordPress Trash in a real private browser',async t=>{
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 const f=await fixture(t,{assertDispatch:()=>assert.equal(store.getRecord('published-trash:'+page.id).phase,'dispatching')}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-desktop-trash-'));
 await f.manager.reset('trash-run');
 const service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,91).toString('base64'),desktop:true,visibleBrowser:f.manager});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const {store}=service,{saved,title,html}=f.input,project=store.createProject({name:'Manual review'});
 const site=store.createSite(project.id,{name:'WordPress fixture',baseUrl:'https://wp.example/'});
 store.updateSite(site.id,{bootstrap:{mode:'browser',state:'ready'},username:'admin',applicationPassword:'fixture-only'},site.revision);
 const page=store.createPage(project.id,{title,siteId:site.id,wpId:saved.postId,fullUrl:saved.url,lifecycleState:'published',remoteSnapshot:{mode:'browser',postType:'page',postId:saved.postId,title,url:saved.url,status:'publish',content:html,contentHash:createHash('sha256').update(JSON.stringify(['page',title,html,'publish'])).digest('hex')}});
 const run=store.createRecord(project.id,'autopilot',{pageId:page.id,siteId:site.id,state:'completed',stage:'completed',browserMode:'hidden',publicationMode:'native',candidate:{id:'fixture',baseUrl:site.baseUrl},nativePublication:saved});
 const decline=()=>service.handle(new Request('http://localhost/api/lifecycle/project-queue/items/'+run.id+'/published-review',{method:'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},body:JSON.stringify({decision:'declined',expectedPageRevision:page.revision})}));
 assert.equal((await (await decline()).json()).manualReview.state,'trash_queued');
 await service.tick({lane:'publication'});
 assert.equal((await (await decline()).json()).manualReview.state,'trashed');
 assert.equal(f.trashes,1);
 assert.equal(f.current.status,'trash');
 assert.equal(store.getPage(page.id).lifecycleState,'trashed');
 assert.equal(service.autopilot.publicationTurn.owner(),null);
 assert.equal(f.calls.some(call=>new URL(call.url).searchParams.get('action')==='delete'),false);
});

test('Trash keeps redirected static resources guarded without treating their targets as document navigation',async t=>{
 const resources='<script src="/wp-includes/js/trash-start.js?ver=1"></script><link rel="stylesheet" href="/wp-content/trash-start.css?ver=1">';
 const f=await fixture(t,{hook:(u,init,{current,doc,menu,listRow})=>{
  if(u.pathname==='/wp-admin/edit.php')return doc(resources+menu+'<table id="the-list">'+listRow(current.status)+'</table>');
  if(u.pathname==='/wp-includes/js/trash-start.js')return {status:302,headers:{location:'trash-final.js?ver=1'},text:''};
  if(u.pathname==='/wp-includes/js/trash-final.js')return {status:200,headers:{'content-type':'application/javascript'},text:'window.trashResourceReady=true;'};
  if(u.pathname==='/wp-content/trash-start.css')return {status:308,headers:{location:'trash-final.css?ver=1'},text:''};
  if(u.pathname==='/wp-content/trash-final.css')return {status:200,headers:{'content-type':'text/css'},text:'#the-list{color:rgb(12,34,56)}'};
 }});
 const result=await f.session.trashPublished(f.input);assert.equal(result.status,'trash');assert.equal(f.trashes,1);
 assert.equal(await f.session.page.evaluate(()=>window.trashResourceReady),true);
 assert.equal(await f.session.page.locator('#the-list').evaluate(node=>getComputedStyle(node).color),'rgb(12, 34, 56)');
 assert.ok(f.calls.every(c=>c.method==='GET'||new URL(c.url).pathname==='/wp-login.php'));
});

test('native trash checks the owned published page, checkpoints before its core action and confirms the exact Trash row',async t=>{
 const f=await fixture(t);const result=await f.session.trashPublished(f.input);
 assert.deepEqual(result,{postId:71,status:'trash'});assert.equal(f.trashes,1);
 assert.deepEqual(f.events,['dispatching','beforeSend','transport','trashed']);
 assert.deepEqual(f.checkpoints,[{postId:71,phase:'dispatching'},{postId:71,phase:'trashed'}]);
 assert.equal(f.calls.some(c=>new URL(c.url).searchParams.get('action')==='delete'),false);
 assert.equal(f.calls.some(c=>c.method!=='GET'&&!c.url.endsWith('/wp-login.php')),false);
});

test('owned Trash proof reads only the exact ID and cannot dispatch Trash, restore or delete',async t=>{
 const f=await fixture(t,{post:{status:'trash'}});const before=f.calls.length;
 const result=await f.session.inspectOwnedTrash(f.input);assert.deepEqual(result,{postId:71,status:'trash'});assert.equal(f.trashes,0);assert.deepEqual(f.checkpoints,[]);
 assert.ok(f.calls.slice(before).every(call=>call.method==='GET'&&!['trash','untrash','delete'].includes(new URL(call.url).searchParams.get('action'))));
 for(const proof of [{id:72},{title:'Other'},{status:'publish'},{restore:'post.php?post=72&action=untrash&_wpnonce=nonce'}]){const other=await fixture(t,{post:{status:'trash'},proof});assert.equal((await other.session.inspectOwnedTrash(other.input)).status,'unknown');assert.equal(other.trashes,0);}
});

test('read-only proof blocks page scripts from invoking WordPress mutation GETs',async t=>{
 const f=await fixture(t,{post:{status:'trash'},hook:(u,_init,{doc,menu,listRow})=>u.pathname==='/wp-admin/edit.php'?doc(menu+'<table>'+listRow('trash')+'</table><script>window.proofAttack=Promise.allSettled([fetch("/wp-admin/post-new.php?post_type=page"),fetch("/wp-admin/edit.php?post_type=page&delete_all=1"),fetch("/wp-admin/post.php?post=71&action=trash&_wpnonce=core-trash")]);</script>'):null});
 const result=await f.session.inspectOwnedTrash(f.input);await f.session.page.evaluate(()=>window.proofAttack);assert.equal(result.status,'trash');assert.ok(!f.calls.some(call=>new URL(call.url).pathname.endsWith('/post-new.php')||new URL(call.url).searchParams.has('delete_all')||new URL(call.url).searchParams.get('action')==='trash'));assert.equal(f.trashes,0);
});

for(const [name,post]of [['ID',{id:72}],['title',{title:'Another page'}],['HTML',{content:'Changed HTML'}],['published URL',{url:'https://wp.example/another-page/'}],['published status',{status:'draft'}]])test('native trash refuses a changed '+name+' before its core action',async t=>{
 const f=await fixture(t,{post});await assert.rejects(f.session.trashPublished(f.input));assert.equal(f.trashes,0);assert.deepEqual(f.checkpoints,[]);
});

for(const link of ['post.php?post=72&action=trash&_wpnonce=core-trash','post.php?post=71&action=delete&_wpnonce=core-trash','post.php?post=71&action=trash','post.php?post=71&action=trash&_wpnonce=core-trash&action2=delete','https://outside.example/wp-admin/post.php?post=71&action=trash&_wpnonce=core-trash'])test('native trash refuses an unsafe core trash control: '+link,async t=>{
 const f=await fixture(t,{link});await assert.rejects(f.session.trashPublished(f.input));assert.equal(f.trashes,0);assert.deepEqual(f.checkpoints,[]);assert.equal(f.calls.some(c=>new URL(c.url).hostname==='outside.example'),false);
});

test('a dispatching resume confirms the exact Trash row without opening its unavailable editor or trashing again',async t=>{
 const f=await fixture(t,{post:{status:'trash'}});const result=await f.session.trashPublished({...f.input,cleanup:{postId:71,phase:'dispatching'}});
 assert.deepEqual(result,{postId:71,status:'trash'});assert.equal(f.trashes,0);assert.equal(f.calls.some(c=>new URL(c.url).pathname==='/wp-admin/post.php'),false);assert.deepEqual(f.checkpoints,[{postId:71,phase:'trashed'}]);
});

test('a dispatching resume with no positive Trash proof stays uncertain and never reissues the action',async t=>{
 const f=await fixture(t);await assert.rejects(f.session.trashPublished({...f.input,cleanup:{postId:71,phase:'dispatching'}}),e=>e.code==='NATIVE_TRASH_UNCERTAIN'&&e.uncertain===true&&e.writeNotAttempted!==true);assert.equal(f.trashes,0);assert.deepEqual(f.checkpoints,[]);
});

test('a lost trash response resumes by reading positive core Trash evidence without a second action',async t=>{
 const f=await fixture(t,{lost:true});await assert.rejects(f.session.trashPublished(f.input),e=>e.uncertain===true);assert.equal(f.trashes,1);assert.equal(f.checkpoints.at(-1).phase,'dispatching');
 const result=await f.session.trashPublished({...f.input,cleanup:f.checkpoints.at(-1)});assert.deepEqual(result,{postId:71,status:'trash'});assert.equal(f.trashes,1);
});

for(const proof of [{id:72},{title:'Someone else'},{status:'publish'},{inlineStatus:'publish'},{restore:'post.php?post=72&action=untrash&_wpnonce=core-restore'},{restore:'post.php?post=71&action=untrash'}])test('a dispatching resume rejects incomplete or foreign Trash proof '+JSON.stringify(proof),async t=>{
 const f=await fixture(t,{post:{status:'trash'},proof});await assert.rejects(f.session.trashPublished({...f.input,cleanup:{postId:71,phase:'dispatching'}}),e=>e.code==='NATIVE_TRASH_UNCERTAIN'&&e.uncertain===true);assert.equal(f.trashes,0);
});

test('a success notice without the exact core Trash row does not confirm removal',async t=>{
 const f=await fixture(t,{applyTrash:false});await assert.rejects(f.session.trashPublished(f.input),e=>e.code==='NATIVE_TRASH_UNCERTAIN'&&e.uncertain===true);assert.equal(f.trashes,1);assert.equal(f.checkpoints.at(-1).phase,'dispatching');
});

test('a failed durable checkpoint prevents the trash request',async t=>{
 const f=await fixture(t,{checkpoint:async()=>{throw Error('disk unavailable');}});await assert.rejects(f.session.trashPublished(f.input),e=>e.writeNotAttempted===true);assert.equal(f.trashes,0);assert.equal(f.events.includes('beforeSend'),false);
});

test('a rejected beforeSend guard prevents the trash request',async t=>{
 const f=await fixture(t,{beforeSend:()=>{throw Object.assign(Error('stopped'),{code:'RUN_STOPPED'});}});await assert.rejects(f.session.trashPublished(f.input),e=>e.code==='RUN_STOPPED'&&e.writeNotAttempted===true);assert.equal(f.trashes,0);
});

test('native trash reveals the ordinary hover-only row action before clicking it',async t=>{
 const f=await fixture(t,{hoverActions:true});f.session.page.setDefaultTimeout(700);const result=await f.session.trashPublished(f.input);assert.deepEqual(result,{postId:71,status:'trash'});assert.equal(f.trashes,1);
});

test('native trash verifies a Gutenberg page and uses the same native Pages action',async t=>{
 const f=await fixture(t,{block:true});const result=await f.session.trashPublished(f.input);assert.deepEqual(result,{postId:71,status:'trash'});assert.equal(f.trashes,1);
});

test('trash reads block unrelated trash, permanent deletion, empty trash and auto-draft creation requests',async t=>{
 const f=await fixture(t,{hook:(url,init,{doc,menu,listRow})=>{
  if(url.pathname==='/wp-admin/edit.php'&&!url.searchParams.has('post_status'))return doc(menu+'<table><tbody>'+listRow('publish')+'</tbody></table><script>for(const path of ["/wp-admin/post.php?post=72&action=trash&_wpnonce=foreign","/wp-admin/post.php?post=71&action=delete&_wpnonce=permanent","/wp-admin/edit.php?post_type=page&delete_all=1&_wpnonce=empty","/wp-admin/post-new.php?post_type=page"])void fetch(path).catch(()=>{});</script>');
 }});
 const result=await f.session.trashPublished(f.input);assert.deepEqual(result,{postId:71,status:'trash'});assert.equal(f.trashes,1);assert.equal(f.calls.some(c=>/post-new|action=delete|post=72|delete_all/.test(c.url)),false);
});

test('a core trash link cannot be dispatched as an image or fetch during read reconciliation',async t=>{
 const f=await fixture(t,{hook:(url,init,{doc,menu})=>url.pathname==='/wp-admin/edit.php'&&url.searchParams.get('post_status')==='trash'?doc(menu+'<img src="/wp-admin/post.php?post=71&action=trash&_wpnonce=core-trash"><script>void fetch("/wp-admin/post.php?post=71&action=trash&_wpnonce=core-trash").catch(()=>{});</script>'):null});
 await assert.rejects(f.session.trashPublished({...f.input,cleanup:{phase:'dispatching'}}),e=>e.code==='NATIVE_TRASH_UNCERTAIN'&&e.uncertain===true);assert.equal(f.trashes,0);assert.equal(f.calls.some(c=>new URL(c.url).searchParams.get('action')==='trash'),false);
});

test('an exact-ID core Trash row on an HTTP error page is not positive confirmation',async t=>{
 const f=await fixture(t,{post:{status:'trash'},hook:(url,init,{doc,listRow})=>url.pathname==='/wp-admin/edit.php'?{...doc('<table><tbody>'+listRow('trash')+'</tbody></table>'),status:404}:null});
 await assert.rejects(f.session.trashPublished({...f.input,cleanup:{phase:'dispatching'}}),e=>e.code==='NATIVE_TRASH_UNCERTAIN'&&e.uncertain===true);assert.equal(f.trashes,0);
});

test('a manual CAPTCHA stops cleanup before any trash action and leaves its browser open',async t=>{
 const f=await fixture(t,{hook:(url,init,{doc})=>url.pathname==='/wp-admin/post.php'?doc('<div class="g-recaptcha" style="width:200px;height:80px">Manual challenge</div>'):null});
 await assert.rejects(f.session.trashPublished(f.input),e=>e.code==='BROWSER_CAPTCHA_REQUIRED');assert.equal(f.trashes,0);assert.equal(f.session.page.isClosed(),false);
});

test('the completed cleanup document cannot issue delayed empty-trash or auto-draft requests',async t=>{
 const f=await fixture(t,{hook:(url,init,{doc,menu,listRow,current})=>url.pathname==='/wp-admin/edit.php'&&url.searchParams.get('post_status')==='trash'&&current.status==='trash'?doc(menu+'<table><tbody>'+listRow('trash')+'</tbody></table><script>setTimeout(()=>{void fetch("/wp-admin/edit.php?post_type=page&delete_all=1&_wpnonce=delayed").catch(()=>{});void fetch("/wp-admin/post-new.php?post_type=page").catch(()=>{});},300);</script>'):null});
 assert.deepEqual(await f.session.trashPublished(f.input),{postId:71,status:'trash'});await new Promise(resolve=>setTimeout(resolve,600));assert.equal(f.calls.some(c=>/post-new|delete_all/.test(c.url)),false);
});

test('a failed read while reconciling dispatching cleanup cannot become permission to resend',async t=>{
 const f=await fixture(t,{hook:url=>{if(url.pathname==='/wp-admin/edit.php')throw Object.assign(Error('read unavailable'),{code:'network_timeout',requestNotStarted:true});}});
 await assert.rejects(f.session.trashPublished({...f.input,cleanup:{phase:'dispatching'}}),e=>e.code==='NATIVE_TRASH_UNCERTAIN'&&e.uncertain===true&&e.writeNotAttempted!==true);assert.equal(f.trashes,0);
});

test('reads exact unchanged published page after an interrupted Trash without dispatching',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.session.inspectOwnedPublished(f.input),{postId:71,status:'publish',url:f.input.saved.url});assert.equal(f.trashes,0);assert.deepEqual(f.checkpoints,[]);
});

test('changed content and an HTTP failure reading the editor cannot authorize a retry',async t=>{
 const changed=await fixture(t,{post:{content:'<main>Edited</main>'}});
 await assert.rejects(changed.session.inspectOwnedPublished(changed.input),{code:'NATIVE_CONTENT_CHANGED'});
 assert.equal(changed.trashes,0);
 const failed=await fixture(t,{hook:(url,init,{doc})=>url.pathname==='/wp-admin/post.php'?{...doc('<div>Unavailable</div>'),status:503}:null});
 await assert.rejects(failed.session.inspectOwnedPublished(failed.input));assert.equal(failed.trashes,0);
});
test('a page converted to a post after positive proof cannot receive the Trash action',async t=>{
 const f=await fixture(t);await f.session.inspectOwnedPublished(f.input);f.current.type='post';
 await assert.rejects(f.session.trashPublished(f.input));assert.equal(f.trashes,0);assert.deepEqual(f.checkpoints,[]);
});