'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const core=require('../dist/ai-core.js');
const uiPath=require.resolve('../dist/run-ui.js');
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function fixture({route,config,sites,pageExtra}={}){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://127.0.0.1:4317/'});
 dom.window.PagePosterAI=core;
 const page={id:'page-1',projectId:'project-1',revision:7,keyword:'Порівняння',config:config||{title:'Manual title',intro:'',sections:[{title:'Section',body:''}],cards:[{name:'Offer',bonus:'',url:'https://offer.test/?x=%2F&y=1'}]},...pageExtra};
 const root=dom.window.document.getElementById('root'),calls=[],changes=[],runs=[];
 const options={element:root,page,sites:sites||[{id:'site-1',name:'Мій сайт',enabled:true,status:'ready',hasCredential:true}],request:async(path,method='GET',body)=>{
  const call={path,method,body:body===undefined?undefined:JSON.parse(JSON.stringify(body))};calls.push(call);
  if(route){const result=await route(call,runs);if(result!==undefined)return result;}
  if(method==='GET')return {runs:JSON.parse(JSON.stringify(runs))};
  if(path.endsWith('/pause')){runs[0].state='paused';return {run:runs[0]};}
  if(path.endsWith('/resume')){runs[0].state='queued';return {run:runs[0]};}
  const run={id:'run-1',pageId:page.id,idempotencyKey:body.idempotencyKey,state:'queued'};runs.push(run);return {run};
 },onChanged:(...args)=>changes.push(args)};
 const ui=require(uiPath).create(options);
 async function click(action){const button=root.querySelector('[data-run-action="'+action+'"]');assert.ok(button,action);button.click();await tick();}
 function value(name,value){const control=root.querySelector('[name="'+name+'"]');assert.ok(control,name);control.value=value;control.dispatchEvent(new dom.window.Event('change',{bubbles:true}));}
 async function submit(){root.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await tick();}
 return {dom,root,page,options,ui,calls,changes,runs,click,value,submit,close(){ui.destroy();dom.window.close();}};
}
test('safe grouped text fields default to empty values and never expose URLs, ratings, credentials or raw HTML',async()=>{
 const h=fixture({config:{title:'<img src=x onerror=alert(1)>',intro:'',author:'Keep author',date:'2026-10-15',cards:[{name:'Offer',bonus:'',rating:'4.9',url:'https://offer.test/'}],sections:[]}});try{
 await h.ui.refresh();assert.equal(h.root.querySelector('img'),null);assert.equal(h.root.querySelector('input[type=password]'),null);
 assert.equal(h.root.querySelector('[data-run-path="title"]').disabled,true);
 assert.equal(h.root.querySelector('[data-run-path="intro"]').checked,true);
 assert.equal(h.root.querySelector('[data-run-path="cards.0.url"]'),null);
 assert.equal(h.root.querySelector('[data-run-path="cards.0.rating"]'),null);
 for(const input of h.root.querySelectorAll('input,textarea,select'))assert.ok(input.labels.length||input.getAttribute('aria-label'));
 h.value('mode','selected');await h.click('select-none');h.root.querySelector('[data-run-path="title"]').click();await h.submit();
 const sent=h.calls.find(c=>c.method==='POST');assert.deepEqual(sent.body.paths,['title']);assert.equal(sent.body.expectedRevision,7);assert.equal(sent.body.status,'review');assert.equal(sent.body.brief.topic,'Порівняння');
 assert.equal(h.page.config.title,'<img src=x onerror=alert(1)>');assert.ok(h.changes.length);
 }finally{h.close();}
});
test('publish uses explicitly selected ready site and exact brief without sending the page config',async()=>{
 const h=fixture();try{await h.ui.refresh();h.value('status','publish');h.value('siteId','site-1');h.value('language','Polish');h.value('country','Poland');h.value('instructions','Keep exact terms.');await h.submit();
 const body=h.calls.find(c=>c.method==='POST').body;assert.equal(body.siteId,'site-1');assert.equal(body.status,'publish');assert.deepEqual(body.brief,{topic:'Порівняння',language:'Polish',country:'Poland',instructions:'Keep exact terms.'});assert.equal('config' in body,false);assert.match(h.root.textContent,/У черзі/);
 }finally{h.close();}
});
test('existing exact link insertions survive and new insertion selects only an eligible text field',async()=>{
 const original={id:'original',fieldPath:'sections.0.body',url:'https://exact.test/(a)?offer=1&x=%2F#top',anchor:'Exact [anchor] & текст',count:2};
 const h=fixture({config:{intro:'',sections:[{title:'Section',body:'[[PP_LINK:original]] [[PP_LINK:original]]'}],aiLinkInsertions:[original]}});try{
 await h.ui.refresh();assert.match(h.root.textContent,/Exact \[anchor\] & текст/);
 h.value('linkField','sections.0.body');h.value('linkUrl','https://other.test/?x=%2F&x=1');h.value('linkAnchor','Мій точний анкор');h.value('linkCount','1');await h.click('add-link');
 await h.submit();const body=h.calls.find(c=>c.method==='POST').body;assert.deepEqual(body.linkInsertions[0],original);assert.equal(body.linkInsertions[1].url,'https://other.test/?x=%2F&x=1');assert.equal(body.linkInsertions[1].anchor,'Мій точний анкор');assert.ok(body.paths.includes('sections.0.body'));assert.deepEqual(h.page.config.aiLinkInsertions,[original]);
 }finally{h.close();}
});
test('invalid destination is rejected without trimming or changing exact authored URL',async()=>{
 const h=fixture();try{await h.ui.refresh();h.value('linkField','sections.0.body');h.value('linkUrl',' https://exact.test/?a=1 ');h.value('linkAnchor','Link');await h.click('add-link');assert.match(h.root.querySelector('[role=alert]').textContent,/адрес|URL/i);assert.equal(h.root.querySelectorAll('[data-run-insertion]').length,0);assert.equal(h.calls.some(c=>c.method==='POST'),false);}finally{h.close();}
});
test('HTML can pass through with zero AI targets and no content transfer in the launch body',async()=>{
 const h=fixture({config:{contentMode:'html',importHtml:'<main>Keep everything</main>',title:'Do not generate'}});try{
 await h.ui.refresh();assert.equal(h.root.querySelector('[data-run-path]'),null);assert.match(h.root.textContent,/без ШІ/);h.value('status','draft');h.value('siteId','site-1');await h.submit();const body=h.calls.find(c=>c.method==='POST').body;assert.deepEqual(body.paths,[]);assert.equal(body.status,'draft');assert.equal(JSON.stringify(body).includes('<main>'),false);
 }finally{h.close();}
});
test('lost launch response locks edited submission and explicit retry reuses identical immutable request',async()=>{
 let posts=0;const h=fixture({route:call=>{if(call.method==='POST'&&call.path.endsWith('/runs')&&++posts===1)throw {code:'network_error'};}});try{
 await h.ui.refresh();h.value('instructions','Original brief');await h.submit();const first=h.calls.find(c=>c.method==='POST').body;
 assert.match(h.root.textContent,/невідом|не підтвердж/i);assert.equal(h.root.querySelector('[name=instructions]').disabled||h.root.querySelector('[name=instructions]').closest('fieldset').disabled,true);
 h.root.querySelector('[name=instructions]').value='Changed without permission';await h.submit();assert.equal(posts,1);await h.click('retry');const sent=h.calls.filter(c=>c.method==='POST');assert.equal(sent.length,2);assert.deepEqual(sent[1].body,first);assert.equal(sent[1].body.brief.instructions,'Original brief');
 }finally{h.close();}
});
test('retry discovers server acceptance after lost response and never duplicates POST',async()=>{
 const h=fixture({route:(call,runs)=>{if(call.method==='POST'){runs.push({id:'accepted',pageId:'page-1',idempotencyKey:call.body.idempotencyKey,state:'running'});throw {code:'network_error'};}}});try{
 await h.ui.refresh();await h.submit();await h.click('retry');assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.match(h.root.textContent,/Виконується/);assert.equal(h.root.querySelector('[data-run-action=retry]'),null);
 }finally{h.close();}
});
test('unknown launch survives destroy and recreation with the same saved key and body',async()=>{
 let posts=0;const h=fixture({route:call=>{if(call.method==='POST'&&++posts===1)throw {code:'network_error'};}});let second;try{
 await h.ui.refresh();await h.submit();const first=h.calls.find(c=>c.method==='POST').body;h.ui.destroy();second=require(uiPath).create(h.options);await second.refresh();assert.match(h.root.textContent,/невідом|не підтвердж/i);await h.click('retry');assert.deepEqual(h.calls.filter(c=>c.method==='POST')[1].body,first);
 }finally{second?.destroy();h.close();}
});
test('pause and resume are explicit and uncertain AI/write states have no resume button',async()=>{
 const h=fixture();try{h.runs.push({id:'r1',pageId:'page-1',state:'running'});await h.ui.refresh();await h.click('pause');assert.equal(h.calls.at(-2).path,'/runs/r1/pause');assert.match(h.root.textContent,/Призупинено/);await h.click('resume');assert.ok(h.calls.some(c=>c.path==='/runs/r1/resume'&&c.method==='POST'));h.runs[0].state='uncertain';await h.ui.refresh();assert.equal(h.root.querySelector('[data-run-action=resume]'),null);assert.match(h.root.textContent,/Потребує звірки/);
 }finally{h.close();}
});
test('disabled and unchecked sites cannot be used for publication but review needs no site',async()=>{
 const h=fixture({sites:[{id:'site-1',name:'Disabled',enabled:false,status:'ready'},{id:'site-2',name:'Unchecked',enabled:true,status:'unknown'}]});try{
 await h.ui.refresh();h.value('status','publish');h.value('siteId','site-1');await h.submit();assert.equal(h.calls.some(c=>c.method==='POST'),false);assert.match(h.root.textContent,/перевір|сайт/i);h.value('status','review');await h.submit();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
 }finally{h.close();}
});
test('destroyed pending GET cannot mutate replacement content or trigger callbacks',async()=>{
 const slow=deferred(),h=fixture({route:call=>call.method==='GET'?slow.promise:undefined});const promise=h.ui.refresh();h.ui.destroy();h.root.textContent='Another panel';slow.resolve({runs:[{id:'old',state:'completed'}]});await promise;assert.equal(h.root.textContent,'Another panel');assert.equal(h.changes.length,0);h.close();
});
test('definite revision conflict never silently creates a new launch key',async()=>{
 const h=fixture({route:call=>{if(call.method==='POST')throw {code:'CONFLICT',status:409};}});try{await h.ui.refresh();await h.submit();assert.match(h.root.textContent,/змінено|версі/i);await h.submit();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);}finally{h.close();}
});

test('manual mode preserves existing registry without passing insertions to the no-AI adapter',async()=>{
 const entry={id:'original',fieldPath:'sections.0.body',url:'https://exact.test/?x=%2F&b=1',anchor:'Exact',count:1};
 const h=fixture({config:{title:'Manual',sections:[{title:'Section',body:'[[PP_LINK:original]]'}],aiLinkInsertions:[entry]}});try{
 await h.ui.refresh();h.value('mode','manual');await h.submit();const body=h.calls.find(c=>c.method==='POST').body;assert.deepEqual(body.paths,[]);assert.deepEqual(body.linkInsertions,[]);assert.deepEqual(h.page.config.aiLinkInsertions,[entry]);
 }finally{h.close();}
});
test('new insertion cannot disappear when its target is later deselected',async()=>{
 const h=fixture();try{await h.ui.refresh();h.value('linkField','sections.0.body');h.value('linkUrl','https://exact.test/?b=%2F&a=1');h.value('linkAnchor','Exact');await h.click('add-link');h.root.querySelector('[data-run-path="sections.0.body"]').click();await h.submit();assert.equal(h.calls.some(c=>c.method==='POST'),false);assert.match(h.root.textContent,/поля.*посилань/);}finally{h.close();}
});
test('storage failure prevents first dispatch because its immutable identity cannot be retained',async()=>{
 const h=fixture();try{await h.ui.refresh();Object.defineProperty(h.dom.window.Storage.prototype,'setItem',{configurable:true,value(){throw Error('Quota exceeded');}});await h.submit();assert.equal(h.calls.some(c=>c.method==='POST'),false);assert.match(h.root.textContent,/зберегти.*ключ|сховище/i);}finally{h.close();}
});
test('older terminal marker does not block opening the newly saved page revision',async()=>{
 const h=fixture();let second;try{await h.ui.refresh();await h.submit();h.runs[0].state='review';await h.ui.refresh();h.ui.destroy();h.options.page={...h.page,revision:8};second=require(uiPath).create(h.options);await second.refresh();assert.equal(h.root.querySelector('[data-run-submit]').disabled,false);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);}finally{second?.destroy();h.close();}
});
test('fallback UUID still satisfies backend identity contract without crypto.randomUUID',async()=>{
 const h=fixture();try{Object.defineProperty(h.dom.window.crypto,'randomUUID',{configurable:true,value:undefined});await h.ui.refresh();await h.submit();assert.match(h.calls.find(c=>c.method==='POST').body.idempotencyKey,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);}finally{h.close();}
});

test('proved failed run releases the form for an explicitly corrected request with a fresh identity',async()=>{
 const h=fixture({route:(call,runs)=>{if(call.method==='POST'){const run={id:'failed-'+runs.length,idempotencyKey:call.body.idempotencyKey,state:'failed'};runs.push(run);return {run};}}});try{
 await h.ui.refresh();await h.submit();assert.equal(h.root.querySelector('[data-run-submit]').disabled,false);h.value('instructions','Corrected brief');await h.submit();const sent=h.calls.filter(c=>c.method==='POST');assert.equal(sent.length,2);assert.notEqual(sent[0].body.idempotencyKey,sent[1].body.idempotencyKey);assert.equal(sent[1].body.brief.instructions,'Corrected brief');
 }finally{h.close();}
});
test('late POST after destruction retains recoverable identity and never updates the replacement panel',async()=>{
 const slow=deferred(),h=fixture({route:call=>call.method==='POST'?slow.promise:undefined});let second;try{
 await h.ui.refresh();const submitting=h.submit();await tick();const first=h.calls.find(c=>c.method==='POST').body;h.ui.destroy();h.root.textContent='Other panel';slow.resolve({run:{id:'accepted',idempotencyKey:first.idempotencyKey,state:'queued'}});await submitting;assert.equal(h.root.textContent,'Other panel');assert.equal(h.changes.length,0);
 h.runs.push({id:'accepted',idempotencyKey:first.idempotencyKey,state:'queued'});second=require(uiPath).create(h.options);await second.refresh();assert.match(h.root.textContent,/У черзі/);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
 }finally{second?.destroy();h.close();}
});
test('polling failure is reported without an unhandled rejected promise or a duplicate launch',async()=>{
 const h=fixture({route:call=>{if(call.method==='GET')throw {code:'network_error'};}});try{
 await assert.rejects(h.ui.refresh());assert.match(h.root.querySelector('[role=alert]').textContent,/Не вдалося/);assert.equal(h.root.querySelector('[data-run-submit]').disabled,true);assert.equal(h.calls.some(c=>c.method==='POST'),false);
 }finally{h.close();}
});

test('actual connector ok status enables an authenticated site for automation',async()=>{const h=fixture({sites:[{id:'site-ok',name:'Checked',status:'ok',enabled:true,hasCredential:true}]});try{await h.ui.refresh();h.value('status','publish');h.value('siteId','site-ok');await h.submit();assert.equal(h.calls.find(c=>c.method==='POST').body.siteId,'site-ok');}finally{h.close();}});


test('failed runs resume only when the server explicitly marks the saved checkpoint retryable',async()=>{
 const h=fixture();try{h.runs.push({id:'retry1',pageId:'page-1',state:'failed',retryable:true,error:{code:'AI_RATE_LIMITED'}});await h.ui.refresh();assert.match(h.root.textContent,/Продовжити зі збереженої частини/);await h.click('resume');assert.equal(h.calls.filter(c=>c.path==='/runs/retry1/resume'&&c.method==='POST').length,1);h.runs[0]={...h.runs[0],state:'failed',retryable:false};await h.ui.refresh();assert.equal(h.root.querySelector('[data-run-action=resume]'),null);h.runs[0]={...h.runs[0],state:'uncertain',retryable:true};await h.ui.refresh();assert.equal(h.root.querySelector('[data-run-action=resume]'),null);}finally{h.close();}
});
