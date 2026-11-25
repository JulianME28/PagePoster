'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath;
const chromePath=require('./browser-runtime.cjs').chromePath;
const options={timeout:45000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chromePath))};
const run=(id,projectId='p1')=>({id,projectId,source:'ai',state:'awaiting_review',stage:'selecting',hasHtml:true,reviewBeforePublish:true,title:'Материал '+id,updatedAt:'2026-10-15T12:00:00Z'});
async function workspace(t,config={}){
 const {chromium}=require(playwrightPath),root=path.resolve(__dirname,'../dist'),calls=[],errors=[];
 const fixture={runs:config.runs||[],approvalAttempts:0};
 const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1)||'autopilot.html',file=path.resolve(root,name);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--no-first-run']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 t.after(async()=>{await context.close();await browser.close();await new Promise(r=>server.close(r));assert.deepEqual(errors,[]);});
 if(config.pending)await context.addInitScript(body=>{if(window===window.top)sessionStorage.setItem('pageposter-autopilot-launch:p1:ai',JSON.stringify(body));},config.pending);
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return config.external?config.external(route):route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  const endpoint=url.pathname.replace('/api/lifecycle',''),method=req.method(),body=req.postDataJSON();calls.push({endpoint,method,body});let data;
  if(endpoint==='/projects')data={projects:[{id:'p1',name:'Первый'},{id:'p2',name:'Второй'}]};
  else if(endpoint==='/autopilot/status')data={aiConfigured:config.aiConfigured!==false,source:{configured:false},visibleBrowser:config.visibleBrowser===true};
  else if(/^\/autopilot\/[^/]+\/browser$/.test(endpoint)&&method==='POST')data={opened:true};
  else if(config.failApprovalSnapshot&&endpoint==='/projects/p1/pages'&&fixture.approvalAttempts){fixture.approvalSnapshotReads=(fixture.approvalSnapshotReads||0)+1;if(fixture.approvalSnapshotReads===1){fixture.snapshotFailed=true;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Снимок после подтверждения недоступен"}'});}fixture.runs.filter(r=>r.state==='queued').forEach(r=>r.state='waiting_source');data={pages:[]};}
  else if(/^\/projects\/p[12]\/jobs$/.test(endpoint))data={jobs:[]};
  else if(/^\/projects\/p[12]\/(?:pages|overview)$/.test(endpoint))data={pages:[],incidents:[]};
  else if(/^\/projects\/p[12]\/autopilot$/.test(endpoint)&&method==='GET')data={runs:fixture.runs.filter(r=>r.projectId===endpoint.split('/')[2])};
  else if(/^\/projects\/p[12]\/autopilot$/.test(endpoint)&&method==='POST'){
   const created=run('r'+(fixture.runs.length+1),endpoint.split('/')[2]);
   if(body.source==='html'){created.source='html';created.state='waiting_source';created.reviewBeforePublish=false;}
   fixture.runs.push(created);data={run:created};
  }
  else if(endpoint==='/autopilot/preview')data={html:'<!doctype html><html><body><h1>Подготовленный HTML</h1></body></html>',title:'Подготовленный HTML',warnings:['Удалён встроенный скрипт.'],reviewToken:'import-token-'+body.html};
  else if(/^\/autopilot\/[^/]+\/html$/.test(endpoint)){
   const id=endpoint.split('/')[2];if(config.holdPreview===id)await new Promise(resolve=>fixture.releasePreview=resolve);
   const current=fixture.runs.find(r=>r.id===id);data={html:config.previewHtml||'<!doctype html><html><body><h1>Материал '+id+'</h1><p>Сохранённый результат</p></body></html>',reviewToken:'token-'+id+(current?.destinationRevision?'-'+current.destinationRevision:''),title:'Материал '+id};
  }
  else if(/^\/autopilot\/[^/]+\/destination$/.test(endpoint)&&method==='POST'){
   if(config.failDestination)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'DESTINATION_UNAVAILABLE',error:'Сайт изменён в другой вкладке. Обновите список.'})});
   const current=fixture.runs.find(r=>r.id===endpoint.split('/')[2]);Object.assign(current,{destinationMode:'manual',selectedDomain:body.baseUrl,destinationRevision:(current.destinationRevision||0)+1,state:'awaiting_review',reviewBeforePublish:true});data={run:current};
  }
  else if(/^\/autopilot\/[^/]+\/delete$/.test(endpoint)&&method==='POST'){
   if(config.failDeletion)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'DELETE_UNAVAILABLE',error:'Запуск уже выполняется. Обновите список.'})});
   const id=endpoint.split('/')[2];fixture.runs=fixture.runs.filter(r=>r.id!==id);data={deleted:true,id};
  }
  else if(/^\/autopilot\/[^/]+\/approve$/.test(endpoint)){
   fixture.approvalAttempts++;
   if(config.failFirstApproval&&fixture.approvalAttempts===1)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Временная потеря ответа"}'});
   const current=fixture.runs.find(r=>r.id===endpoint.split('/')[2]);current.state=config.failApprovalSnapshot?'queued':'waiting_source';data={run:current};
  }
  else return route.fulfill({status:404,contentType:'application/json',body:'{"code":"NOT_FOUND"}'});
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/autopilot.html');await page.getByRole('heading',{name:'Первый',exact:true}).waitFor();
 return {page,calls,fixture,context};
}
async function prepareAI(page){
 await page.locator('[name=linkUrl]').fill('https://offer.example/?ref=%2F&tag=a&tag=b#x');await page.locator('[name=linkAnchor]').fill('  Точный анкор  ');
 await page.locator('#ap-launch').click();await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал r1',exact:true}).waitFor();
}
const launches=calls=>calls.filter(c=>/^\/projects\/[^/]+\/autopilot$/.test(c.endpoint)&&c.method==='POST');
const approvals=calls=>calls.filter(c=>c.endpoint.endsWith('/approve'));

test('preview clicks and keyboard open only saved destinations while sandbox stays isolated',options,async t=>{
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs'),G=require('../dist/generator.js');
 const sample=require('./fixtures/languages/en.json');
 const generated=c.parse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(sample.plan)}]}]},sample.input).config;
 const previewHtml=G.renderSnippet(generated),hits=[];
 const {page,context,calls}=await workspace(t,{runs:[run('r1')],previewHtml,external:route=>{hits.push(route.request().url());return route.fulfill({contentType:'text/html',body:'<h1>Intercepted destination</h1>'});}});
 const frame=page.frameLocator('#ap-stage-frame');await frame.locator('.pp-resource .pp-cta').waitFor();
 assert.equal(await page.locator('#ap-stage-frame').getAttribute('sandbox'),'allow-scripts');
 await frame.locator('#pp-landing').evaluate(()=>parent.postMessage({type:'pageposter-preview-navigate',url:'https://unlisted.example/'},'*'));
 await page.evaluate(()=>new Promise(r=>setTimeout(r,50)));assert.equal(context.pages().length,1);
 assert.equal(await frame.locator('.pp-hero .pp-cta').count(),0);
 const selectors=['.pp-resource .pp-cta','header .pp-brand','header .pp-nav a','footer .pp-brand','footer nav a'];
 async function clickPreview(control){
  const element=page.locator('#ap-stage-frame');await element.scrollIntoViewIfNeeded();
  // The scaled frame and its landing container have separate scroll positions.
  // Confirm both hit tests before dispatching one trusted pointer click.
  const deadline=Date.now()+4000;
  do {
   const point=await control.evaluate(async n=>{
    const root=n.closest('#pp-landing'),r=n.getBoundingClientRect(),box=root.getBoundingClientRect();
    root.scrollTo({top:root.scrollTop+r.y-box.y+r.height/2-root.clientHeight/2,behavior:'instant'});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const rect=n.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
    return n.contains(document.elementFromPoint(x,y))?{x,y,width:innerWidth,height:innerHeight}:null;
   });
   if(!point)continue;
   const target=await element.evaluate((node,point)=>{
    const box=node.getBoundingClientRect(),x=box.x+point.x*box.width/point.width,y=box.y+point.y*box.height/point.height;
    return document.elementFromPoint(x,y)===node?{x,y}:null;
   },point);
   if(target){await page.mouse.click(target.x,target.y);return;}
  }while(Date.now()<deadline);
  assert.fail('Preview control is not reachable by a trusted pointer click: '+control);
 }
 for(const selector of selectors){
  const controls=frame.locator(selector);
  for(let index=0;index<await controls.count();index++){
   const control=controls.nth(index);
   const [popup]=await Promise.all([context.waitForEvent('page',{timeout:7000}),clickPreview(control)])
    .catch(error=>{throw Error('Preview did not open for '+control,{cause:error});});
   await popup.waitForLoadState('domcontentloaded');assert.equal(popup.url(),sample.input.links[0].url);await popup.close();
  }
 }
 await page.locator('#ap-stage-mobile').click();await clickPreview(frame.locator('.pp-mobile-nav summary'));
 const mobileLink=frame.locator('.pp-mobile-nav a').first();await mobileLink.waitFor();
 const [popup]=await Promise.all([context.waitForEvent('page',{timeout:7000}),mobileLink.press('Enter')]);
 await popup.waitForLoadState('domcontentloaded');assert.equal(popup.url(),sample.input.links[0].url);await popup.close();
 const beforeBlocked=hits.length;await page.keyboard.press('a');
 await frame.locator('#pp-landing').evaluate(()=>parent.postMessage({type:'pageposter-preview-navigate',url:'https://unlisted.example/'},'*'));
 await page.evaluate(url=>window.postMessage({type:'pageposter-preview-navigate',url},'*'),sample.input.links[0].url);
 await page.evaluate(()=>new Promise(r=>setTimeout(r,50)));assert.equal(context.pages().length,1);assert.equal(hits.length,beforeBlocked);
 assert.ok(hits.length>=10);assert.ok(hits.every(url=>url.startsWith('https://offer50.example/')));assert.equal(approvals(calls).length,0);
 assert.equal(await page.locator('body').getAttribute('data-escaped'),null);
});

test('AI preparation shows real desktop and mobile viewports before explicit modal publication',options,async t=>{
 const {page,calls}=await workspace(t);await prepareAI(page);
 assert.equal(launches(calls).length,1);assert.equal(launches(calls)[0].body.reviewBeforePublish,true);assert.equal(approvals(calls).length,0);
 assert.equal(await page.locator('#ap-preview[open]').count(),0);
 assert.equal(await page.frameLocator('#ap-stage-frame').locator('body').evaluate(()=>innerWidth),1280);
 const html=await page.locator('#ap-stage-frame').getAttribute('srcdoc');
 await page.locator('#ap-stage-mobile').click();
 assert.equal(await page.frameLocator('#ap-stage-frame').locator('body').evaluate(()=>innerWidth),390);
 assert.equal(await page.locator('#ap-stage-frame').getAttribute('srcdoc'),html);
 await page.locator('#ap-stage-desktop').click();
 assert.equal(await page.frameLocator('#ap-stage-frame').locator('body').evaluate(()=>innerWidth),1280);
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),JSON.stringify(await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).slice(0,18).map(n=>({tag:n.tagName,id:n.id,cls:n.className,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width}))}))));
 await page.locator('#ap-stage-expand').click();await page.locator('#ap-preview[open]').waitFor();
 assert.equal(approvals(calls).length,0);await page.locator('#ap-preview-publish').click();
 await page.waitForFunction(()=>document.querySelector('.ap-run[data-state="waiting_source"]'));
 assert.deepEqual(approvals(calls).map(c=>({endpoint:c.endpoint,body:c.body})),[{endpoint:'/autopilot/r1/approve',body:{reviewToken:'token-r1'}}]);
});

test('delete confirmation cancels safely and accepted deletion clears preview and survives reload',options,async t=>{
 const {page,calls,fixture}=await workspace(t,{runs:[{...run('saved'),canDelete:true}]});
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал saved',exact:true}).waitFor();
 page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Видалити',exact:true}).click();
 assert.equal(fixture.runs.length,1);assert.equal(calls.filter(c=>c.endpoint.endsWith('/delete')).length,0);
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Видалити',exact:true}).click();
 await page.getByText('Сторінку видалено з PagePoster.',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-run-id="saved"]').count(),0);assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true);
 assert.ok(!(await page.locator('#ap-stage-frame').getAttribute('srcdoc')||'').includes('Материал saved'));
 await page.reload();await page.getByRole('heading',{name:'Первый',exact:true}).waitFor();
 assert.equal(await page.locator('[data-run-id="saved"]').count(),0);assert.equal(await page.getByRole('button',{name:'Видалити',exact:true}).count(),0);
 assert.equal(calls.filter(c=>c.endpoint.endsWith('/delete')).length,1);assert.equal(approvals(calls).length,0);
});

test('delete is unavailable for remote work and server rejection preserves the draft',options,async t=>{
 const {page,calls}=await workspace(t,{runs:[{...run('saved'),canDelete:true},{...run('remote'),state:'failed',stage:'publishing',canDelete:false}],failDeletion:true});
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал saved',exact:true}).waitFor();
 assert.equal(await page.locator('[data-run-id="remote"]').getByRole('button',{name:'Видалити',exact:true}).count(),0);
 page.once('dialog',dialog=>dialog.accept());await page.locator('[data-run-id="saved"]').getByRole('button',{name:'Видалити',exact:true}).click();
 await page.getByText('Запуск уже выполняется. Обновите список.',{exact:true}).waitFor();
 assert.equal(await page.locator('[data-run-id="saved"]').count(),1);assert.equal(await page.locator('#ap-stage-publish').isEnabled(),true);
 assert.equal(calls.filter(c=>c.endpoint.endsWith('/delete')).length,1);assert.equal(approvals(calls).length,0);
});

test('a late preview response cannot restore a deleted draft',options,async t=>{
 const {page,fixture}=await workspace(t,{runs:[{...run('saved'),canDelete:true}],holdPreview:'saved'});
 await page.getByRole('button',{name:'Видалити',exact:true}).waitFor();
 for(let i=0;i<100&&!fixture.releasePreview;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(typeof fixture.releasePreview,'function');
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Видалити',exact:true}).click();
 await page.getByText('Сторінку видалено з PagePoster.',{exact:true}).waitFor();fixture.releasePreview();
 await page.waitForTimeout(100);
 assert.equal(await page.locator('[data-run-id="saved"]').count(),0);assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true);
 assert.ok(!(await page.locator('#ap-stage-frame').getAttribute('srcdoc')||'').includes('Материал saved'));
});

test('manual site is saved only for the selected page, passwords are not persisted and publication needs a fresh click',options,async t=>{
 const {page,calls}=await workspace(t,{runs:[{...run('saved'),canSetDestination:true,destinationRevision:0}]});
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал saved',exact:true}).waitFor();
 await page.locator('#ap-stage-destination').click();await page.locator('#ap-destination-manual-tab').click();await page.getByLabel('Адреса WordPress',{exact:true}).fill('https://manual.example/');
 await page.getByLabel('Логін адміністратора',{exact:true}).fill('editor');await page.getByLabel('Пароль WordPress',{exact:true}).fill('manual-secret');
 await page.getByRole('button',{name:'Зберегти сайт',exact:true}).click();await page.locator('#ap-destination').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.getElementById('ap-stage-status').textContent.includes('https://manual.example/')&&!document.getElementById('ap-stage-publish').disabled);
 assert.equal(approvals(calls).length,0);assert.equal(launches(calls).length,0);
 assert.deepEqual(calls.find(c=>c.endpoint.endsWith('/destination')).body,{baseUrl:'https://manual.example/',username:'editor',password:'manual-secret',expectedRevision:0});
 assert.equal(await page.locator('[name=sitePassword]').inputValue(),'');assert.doesNotMatch(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}})),/manual-secret|editor/);
 await page.reload();await page.waitForFunction(()=>document.getElementById('ap-stage-status').textContent.includes('https://manual.example/')&&!document.getElementById('ap-stage-publish').disabled);
 await page.locator('#ap-stage-publish').click();await page.waitForFunction(()=>document.querySelector('.ap-run[data-state="waiting_source"]'));
 assert.equal(approvals(calls)[0].body.reviewToken,'token-saved-1');
});

test('manual site accepts a bare domain by click and Enter without native URL validation blocking submission',options,async t=>{
 const {page,calls}=await workspace(t,{runs:[{...run('saved'),canSetDestination:true,destinationRevision:0}]});
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал saved',exact:true}).waitFor();
 for(const [address,expected,enter] of [['donor-workspace.example','https://donor-workspace.example',false],['  www.manual.example/wp-admin/  ','https://www.manual.example/wp-admin/',true],['https://manual.example/','https://manual.example/',false]]){
  await page.locator('#ap-stage-destination').click();await page.locator('#ap-destination-manual-tab').click();await page.getByLabel('Адреса WordPress',{exact:true}).fill(address);
  await page.getByLabel('Логін адміністратора',{exact:true}).fill('editor');await page.getByLabel('Пароль WordPress',{exact:true}).fill('manual-secret');
  if(enter)await page.getByLabel('Пароль WordPress',{exact:true}).press('Enter');else await page.getByRole('button',{name:'Зберегти сайт',exact:true}).click();
  await page.locator('#ap-destination').waitFor({state:'hidden'});
  assert.equal(calls.filter(c=>c.endpoint.endsWith('/destination')).at(-1).body.baseUrl,expected);
  assert.equal(await page.locator('[name=sitePassword]').inputValue(),'');
  assert.equal(approvals(calls).length,0);assert.equal(launches(calls).length,0);
  await page.locator('#ap-stage-destination:not([disabled])').waitFor();
 }
});

test('manual site form fits mobile and server rejection keeps the page unpublished',options,async t=>{
 const {page,calls}=await workspace(t,{runs:[{...run('saved'),canSetDestination:true}],failDestination:true});
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал saved',exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.locator('#ap-stage-destination').click();await page.locator('#ap-destination-manual-tab').click();
 await page.getByLabel('Адреса WordPress',{exact:true}).fill('https://manual.example/');await page.getByLabel('Логін адміністратора',{exact:true}).fill('editor');await page.getByLabel('Пароль WordPress',{exact:true}).fill('manual-secret');
 assert.equal(await page.locator('#ap-destination').evaluate(d=>d.scrollWidth>d.clientWidth+1),false);
 await page.getByRole('button',{name:'Зберегти сайт',exact:true}).click();await page.getByText('Сайт изменён в другой вкладке. Обновите список.',{exact:true}).waitFor();
 assert.equal(await page.locator('[name=sitePassword]').inputValue(),'');assert.equal(approvals(calls).length,0);
 await page.getByRole('button',{name:'Закрити вибір сайту',exact:true}).click();
 // HTMLDialogElement queues the close event; form cleanup runs in that handler.
 await page.waitForFunction(()=>document.querySelector('[name=siteUrl]').value==='');
 assert.equal(await page.locator('[name=siteUrl]').inputValue(),'');
});

test('copy exports the exact prepared HTML from a failed run, stage and preview without publishing or generating',options,async t=>{
 const html='<style>#pp-landing{color:#123456}</style><div id="pp-landing"><h1>Ready HTML</h1><a href="https://offer.example/?x=%2f&amp;y=1">Visit casino</a></div>';
 const {page,calls}=await workspace(t,{aiConfigured:false,previewHtml:html,runs:[{...run('saved'),state:'failed',stage:'installing'}]});
 await page.evaluate(()=>{window.copiedHTML=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copiedHTML.push(text)}});});
 await page.locator('[data-run-id="saved"]').getByRole('button',{name:'Копіювати HTML',exact:true}).click();await page.waitForFunction(()=>window.copiedHTML.length===1);
 await page.locator('[data-run-id="saved"]').getByRole('button',{name:'Попередній перегляд',exact:true}).click();await page.locator('#ap-stage-copy:not([disabled])').waitFor();
 await page.locator('#ap-stage-copy').click();await page.waitForFunction(()=>window.copiedHTML.length===2);
 await page.locator('#ap-stage-expand').click();await page.locator('#ap-preview[open]').waitFor();await page.locator('#ap-copy-html').click();await page.waitForFunction(()=>window.copiedHTML.length===3);
 assert.deepEqual(await page.evaluate(()=>window.copiedHTML),[html,html,html]);assert.equal(approvals(calls).length,0);assert.equal(launches(calls).length,0);
});

test('clipboard rejection exposes read-only prepared HTML for manual Ctrl+C without executing it',options,async t=>{
 const html='<div id="pp-landing"><h1>Ready & exact</h1></div><script>parent.copyEscaped=true</script>';
 const {page,calls}=await workspace(t,{previewHtml:html,runs:[{...run('saved'),state:'failed',stage:'installing'}]});
 await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Denied');}}}));
 await page.locator('[data-run-id="saved"]').getByRole('button',{name:'Копіювати HTML',exact:true}).click();await page.locator('#ap-html-code[open]').waitFor();
 assert.equal(await page.locator('#ap-ready-html').inputValue(),html);assert.equal(await page.locator('#ap-ready-html').getAttribute('readonly'),'');
 assert.equal(await page.locator('#ap-ready-html').evaluate(n=>n.selectionEnd-n.selectionStart),html.length);assert.equal(await page.evaluate(()=>window.copyEscaped),undefined);
 await page.getByRole('button',{name:'Закрити код HTML',exact:true}).click();assert.equal(await page.locator('#ap-ready-html').inputValue(),'');assert.equal(approvals(calls).length,0);assert.equal(launches(calls).length,0);
});

test('a late copy response cannot copy a different project after navigation',options,async t=>{
 const {page,calls,fixture}=await workspace(t,{holdPreview:'saved',runs:[{...run('saved'),state:'failed',stage:'installing'}]});
 await page.evaluate(()=>{window.copiedHTML=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copiedHTML.push(text)}});});
 await page.locator('[data-run-id="saved"]').getByRole('button',{name:'Копіювати HTML',exact:true}).click();
 for(let i=0;i<100&&!fixture.releasePreview;i++)await new Promise(r=>setTimeout(r,10));assert.equal(typeof fixture.releasePreview,'function');
 await page.getByRole('button',{name:'Второй',exact:true}).click();fixture.releasePreview();await page.waitForTimeout(100);
 assert.deepEqual(await page.evaluate(()=>window.copiedHTML),[]);assert.equal(approvals(calls).length,0);assert.equal(launches(calls).length,0);
});

test('hidden browser mode does not promise a visible window or expose a focus action',options,async t=>{
 const {page}=await workspace(t,{runs:[{...run('saved'),browserWindow:true,browserMode:'hidden'}],visibleBrowser:true});await page.locator('#ap-stage-publish:not([disabled])').waitFor();assert.equal(await page.getByRole('button',{name:'Показати вікно WordPress',exact:true}).count(),0);assert.doesNotMatch(await page.locator('#ap-stage-status').textContent(),/відкриється окреме вікно/);assert.match(await page.locator('#ap-stage-status').textContent(),/прихованому режимі/);
});
test('visible WordPress mode explains the window and focus action never publishes or regenerates',options,async t=>{
 const {page,calls}=await workspace(t,{runs:[{...run('saved'),browserWindow:true}],visibleBrowser:true});
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал saved',exact:true}).waitFor();
 assert.match(await page.locator('#ap-stage-status').textContent(),/відкриється окреме вікно WordPress/);
 await page.getByRole('button',{name:'Показати вікно WordPress',exact:true}).click();
 assert.equal(calls.filter(c=>c.endpoint==='/autopilot/saved/browser').length,1);assert.equal(approvals(calls).length,0);assert.equal(launches(calls).length,0);
});

test('reload restores an awaiting review run without regenerating or approving it',options,async t=>{
 const {page,calls}=await workspace(t,{runs:[run('saved')]});
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал saved',exact:true}).waitFor();
 await page.reload();await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал saved',exact:true}).waitFor();
 assert.equal(launches(calls).length,0);assert.equal(approvals(calls).length,0);
 assert.ok(calls.filter(c=>c.endpoint==='/autopilot/saved/html').length>=2);
 assert.equal(await page.locator('#ap-stage-publish').isEnabled(),true);
});

test('a late preview cannot overwrite the selected project or approve another project run',options,async t=>{
 const {page,calls,fixture}=await workspace(t,{runs:[run('old'),run('current','p2')],holdPreview:'old'});
 await page.waitForFunction(()=>document.getElementById('ap-title').textContent==='Первый');
 for(let i=0;i<100&&!fixture.releasePreview;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(typeof fixture.releasePreview,'function','Initial saved run starts loading');
 await page.getByRole('button',{name:'Второй',exact:true}).click();
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал current',exact:true}).waitFor();
 fixture.releasePreview();await page.waitForTimeout(100);
 assert.equal(await page.frameLocator('#ap-stage-frame').getByRole('heading').textContent(),'Материал current');
 await page.locator('#ap-stage-publish').click();await page.waitForFunction(()=>document.querySelector('.ap-run[data-state="waiting_source"]'));
 assert.deepEqual(approvals(calls).map(c=>c.endpoint),['/autopilot/current/approve']);
});

test('HTML review works without OpenAI and changed source cannot reuse its visual approval',options,async t=>{
 const {page,calls}=await workspace(t,{aiConfigured:false});await page.getByLabel('Готовий HTML',{exact:true}).check();
 await page.locator('[name=customerHtml]').fill('<h1>First</h1><script>first()</script>');await page.locator('#ap-launch').click();
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Подготовленный HTML'}).waitFor();
 assert.equal(launches(calls).length,0);assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true);
 await page.locator('[name=acceptHtmlChanges]').check();assert.equal(await page.locator('#ap-stage-publish').isEnabled(),true);
 await page.locator('[name=customerHtml]').fill('<h1>Changed</h1><script>second()</script>');
 assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true);assert.equal(await page.locator('[name=acceptHtmlChanges]').isVisible(),false);
 await page.locator('#ap-launch').click();await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Подготовленный HTML'}).waitFor();await page.locator('[name=acceptHtmlChanges]').check();await page.locator('#ap-stage-publish').click();
 await page.waitForFunction(()=>document.querySelector('.ap-run[data-state="waiting_source"]'));
 assert.equal(launches(calls).length,1);const body=launches(calls)[0].body;
 assert.equal(body.html,'<h1>Changed</h1><script>second()</script>');assert.equal(body.reviewToken,'import-token-'+body.html);assert.equal(body.reviewBeforePublish,undefined);assert.equal(approvals(calls).length,0);assert.equal(calls.some(c=>c.endpoint.includes('/api/ai/')),false);
});

test('approval response failure retries the same saved run and token without another generation',options,async t=>{
 const {page,calls}=await workspace(t,{failFirstApproval:true});await prepareAI(page);await page.locator('#ap-stage-publish').click();
 await page.getByText('Временная потеря ответа',{exact:true}).waitFor();await page.locator('#ap-stage-publish').click();
 await page.waitForFunction(()=>document.querySelector('.ap-run[data-state="waiting_source"]'));
 assert.equal(launches(calls).length,1);assert.equal(approvals(calls).length,2);
 assert.deepEqual(approvals(calls)[1],approvals(calls)[0]);
});

test('an unresolved request from before review mode keeps its exact original launch identity',options,async t=>{
 const pending={idempotencyKey:'f40aac18-78b0-4c26-84f0-8e1ce9ee1528',links:[{url:'https://old.example/?ref=%2f',anchor:'  Original  '}]};
 const {page,calls}=await workspace(t,{pending});await page.locator('#ap-retry-launch').click();
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал r1',exact:true}).waitFor();
 assert.equal(launches(calls).length,1);assert.deepEqual(launches(calls)[0].body,pending);assert.equal(approvals(calls).length,0);
});


test('loading another run disables preview actions until the displayed review matches its publication token',options,async t=>{
 const {page,calls,fixture}=await workspace(t,{runs:[run('first'),run('second')],holdPreview:'second'});
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал first',exact:true}).waitFor();
 await page.locator('[data-run-id="second"]').getByRole('button',{name:'Переглянути й опублікувати',exact:true}).click();
 for(let i=0;i<100&&!fixture.releasePreview;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(typeof fixture.releasePreview,'function','The second saved preview request is in flight');
 assert.equal(await page.locator('#ap-stage-expand').isDisabled(),true,'An old preview must not open while a different run is loading');
 assert.equal(await page.locator('#ap-stage-publish').isDisabled(),true,'Publication is disabled while the displayed run is being replaced');
 assert.equal(await page.locator('#ap-preview-publish').isDisabled(),true,'The modal must not approve the prior displayed snapshot during a pending review change');
 assert.equal(approvals(calls).length,0);
 fixture.releasePreview();
 await page.frameLocator('#ap-stage-frame').getByRole('heading',{name:'Материал second',exact:true}).waitFor();
 await page.locator('#ap-stage-expand').click();await page.locator('#ap-preview[open]').waitFor();
 await page.frameLocator('#ap-preview-frame').getByRole('heading',{name:'Материал second',exact:true}).waitFor();
 await page.locator('#ap-preview-publish').click();await page.waitForFunction(()=>document.querySelector('[data-run-id="second"][data-state="waiting_source"]'));
 assert.deepEqual(approvals(calls).map(c=>({endpoint:c.endpoint,body:c.body})),[{endpoint:'/autopilot/second/approve',body:{reviewToken:'token-second'}}]);
});


test('accepted approval recovers a failed first snapshot and continues polling the saved queued run',options,async t=>{
 const {page,calls,fixture}=await workspace(t,{failApprovalSnapshot:true});
 await prepareAI(page);await page.locator('#ap-stage-publish').click();
 await page.waitForFunction(()=>document.querySelector('[data-run-id="r1"][data-state="waiting_source"]'),{},{timeout:12000});
 assert.equal(fixture.snapshotFailed,true,'The first post-approval page snapshot fails in this fixture');
 assert.ok(fixture.approvalSnapshotReads>=2,'A saved queued approval must keep polling after a failed snapshot');
 assert.equal(launches(calls).length,1);assert.equal(approvals(calls).length,1,'Recovery must not submit another publication request');
});
