"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('jsdom');
const modulePath = require.resolve('../dist/generator.js').replace('generator.js','lifecycle-ui.js');
const delay = () => new Promise(resolve => setTimeout(resolve, 15));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function response(data,status=200){return {ok:status>=200&&status<300,status,json:async()=>data};}
function harness(overrides={}){
  assert.ok(fs.existsSync(modulePath),'Lifecycle UI module must exist');
  const api=require(modulePath);
  const dom=new JSDOM('<section id="mount"></section>',{url:'http://127.0.0.1:8787/',pretendToBeVisual:true});
  const root=dom.window.document.getElementById('mount');
  const calls=[],toasts=[],opened=[];
  const db={projects:[{id:'p1',name:'Проєкт один',revision:1}],pages:[],sites:[],jobs:[],events:[]};
  const fetchImpl=async(url,options={})=>{
    const method=options.method||'GET',payload=options.body?JSON.parse(options.body):undefined;
    calls.push({url,method,payload});
    const special=overrides.route&&await overrides.route(url,method,payload,db);
    if(special)return special;
    if(url.endsWith('/status'))return response({available:true,runtime:'local',credentialStorage:true,monitoring:{enabled:true,requiresRunningServer:true},publication:false});
    if(url.endsWith('/projects')&&method==='GET')return response({projects:db.projects});
    if(url.endsWith('/projects')&&method==='POST'){const project={...payload,id:'p2',revision:1};db.projects.push(project);return response({project},201);}
    if(/\/projects\/[^/]+\/pages$/.test(url)&&method==='GET')return response({pages:db.pages});
    if(/\/projects\/[^/]+\/pages$/.test(url)&&method==='POST'){const page={...payload,id:'pg1',revision:1,lifecycleState:'local'};db.pages.push(page);return response({page},201);}
    if(/\/pages\/pg1$/.test(url)&&method==='GET')return response({page:db.pages[0]});
    if(/\/pages\/pg1$/.test(url)&&method==='PATCH'){db.pages[0]={...db.pages[0],...payload,revision:2};return response({page:db.pages[0]});}
    if(/\/projects\/[^/]+\/sites$/.test(url)&&method==='GET')return response({sites:db.sites});
    if(/\/projects\/[^/]+\/sites$/.test(url)&&method==='POST'){const site={id:'s1',name:payload.name,baseUrl:payload.baseUrl,hasCredential:true,enabled:true,revision:1};db.sites.push(site);return response({site},201);}
    if(url.endsWith('/jobs'))return response({jobs:db.jobs});
    if(url.endsWith('/events'))return response({events:db.events});
    if(url.endsWith('/checks'))return response({checks:[]});
    if(url.endsWith('/overview'))return response({pages:db.pages.map(p=>({pageId:p.id,checks:[]})),runs:[]});
    if(url.endsWith('/check')){const job={id:'j1',state:'queued',type:'site_check'};db.jobs.push(job);return response({job},202);}
    return response({error:'Not found'},404);
  };
  const ui=api.create({element:root,...overrides.options,getEditorSnapshot:()=>({title:'Моя сторінка',config:{title:'Моя сторінка',keyword:'слово',sections:[],faq:[],cards:[{url:'https://offer.test/?offer=1&b=%2F'}]},html:'<main>Моя сторінка</main>',uniqueUrls:['https://offer.test/?offer=1&b=%2F']}),openEditorSnapshot:async config=>{opened.push(config);},toast:message=>toasts.push(message),fetchImpl});
  const click=async selector=>{const el=root.querySelector(selector);assert.ok(el,selector);el.click();await delay();};
  const submit=async selector=>{const el=root.querySelector(selector);assert.ok(el,selector);el.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await delay();};
  const input=(name,value)=>{const el=root.querySelector('[name="'+name+'"]');assert.ok(el,name);el.value=value;el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  return {dom,root,ui,db,calls,toasts,opened,click,submit,input,close(){ui.destroy();dom.window.close();}};
}

test('unavailable lifecycle honestly preserves the editor and creates no project form',async()=>{
  const h=harness({route:url=>url.endsWith('/status')?response({available:false,runtime:'offline'}):null});
  try{await h.ui.refresh();assert.match(h.root.textContent,/локальн.*сервер/i);assert.match(h.root.textContent,/редактор/i);assert.equal(h.root.querySelector('[data-lc-form="project"]'),null);assert.equal(h.calls.some(c=>c.url.endsWith('/projects')),false);}finally{h.close();}
});
test('project creation and saving editor snapshot preserve exact URLs',async()=>{
  const h=harness();try{await h.ui.refresh();h.input('projectName','Новий проєкт');await h.submit('[data-lc-form="project"]');assert.match(h.root.textContent,/Новий проєкт/);await h.click('[data-lc-action="save-new"]');const saved=h.calls.find(c=>c.method==='POST'&&c.url.endsWith('/pages'));assert.ok(saved);assert.equal(saved.payload.config.cards[0].url,'https://offer.test/?offer=1&b=%2F');assert.deepEqual(saved.payload.uniqueUrls,['https://offer.test/?offer=1&b=%2F']);assert.match(h.root.textContent,/Моя сторінка/);}finally{h.close();}
});
test('saved page opens in editor and explicit update uses expectedRevision',async()=>{
  const h=harness();h.db.pages.push({id:'pg1',title:'Збережена',revision:7,config:{title:'Старий текст'},fullUrl:'https://own.test/page/?a=1&b=%2F',lifecycleState:'saved'});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-action="open-page"]');assert.equal(h.opened[0].title,'Старий текст');await h.click('[data-lc-action="update-page"]');const update=h.calls.find(c=>c.method==='PATCH');assert.equal(update.payload.expectedRevision,7);assert.equal(update.payload.config.title,'Моя сторінка');assert.equal(h.root.querySelector('a.lc-url').getAttribute('href'),'https://own.test/page/?a=1&b=%2F');}finally{h.close();}
});
test('site credentials are never rendered or stored client side and clear after success',async()=>{
  const h=harness();try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-tab="sites"]');h.input('siteName','Мій WordPress');h.input('siteUrl','https://own.test/');h.input('siteUsername','admin');h.input('sitePassword','secret-app-password');await h.submit('[data-lc-form="site"]');const post=h.calls.find(c=>c.method==='POST'&&c.url.endsWith('/sites'));assert.equal(post.payload.applicationPassword,'secret-app-password');assert.equal(h.root.querySelector('[name="sitePassword"]').value,'');assert.doesNotMatch(h.root.textContent,/secret-app-password/);assert.equal(h.dom.window.localStorage.length,0);assert.equal(h.dom.window.sessionStorage.length,0);}finally{h.close();}
});
test('disabled credential storage explains why connection form is disabled',async()=>{
  const h=harness({route:url=>url.endsWith('/status')?response({available:true,runtime:'local',credentialStorage:false,monitoring:false}):null});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-tab="sites"]');assert.equal(h.root.querySelector('[data-lc-form="site"] fieldset').disabled,true);assert.match(h.root.textContent,/шифрування/i);}finally{h.close();}
});
test('a wrong-credentials job stays a visible site error without crashing or rendering markup',async()=>{
  const h=harness();h.db.jobs.push({id:'j1',state:'failed',type:'site_check',errorCode:'auth_failed',error:'Неправильні реквізити',siteId:'s1'});h.db.sites.push({id:'s1',name:'<img src=x onerror=alert(1)>',baseUrl:'https://own.test',enabled:true,revision:1});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-tab="jobs"]');assert.match(h.root.textContent,/Неправильні|доступ|реквізити/i);assert.match(h.root.textContent,/Помилка/);await h.click('[data-lc-tab="sites"]');assert.equal(h.root.querySelector('img'),null);assert.match(h.root.textContent,/<img/);}finally{h.close();}
});
test('late responses for an earlier project cannot replace the selected project',async()=>{
  const slow=deferred();const h=harness({route:(url,method)=>url==='/api/lifecycle/projects/p1/pages'&&method==='GET'?slow.promise:null});h.db.projects.push({id:'p2',name:'Другий',revision:1});
  try{await h.ui.refresh();h.root.querySelector('[data-lc-project="p1"]').click();await delay();await h.click('[data-lc-project="p2"]');slow.resolve(response({pages:[{id:'late',title:'Застаріла відповідь',revision:1}]}));await delay();assert.equal(h.root.querySelector('[data-lc-project="p2"]').getAttribute('aria-current'),'true');assert.doesNotMatch(h.root.textContent,/Застаріла відповідь/);}finally{h.close();}
});
test('all input controls have labels and no publication action is advertised',async()=>{
  const h=harness();try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');for(const tab of ['pages','sites']){await h.click('[data-lc-tab="'+tab+'"]');for(const el of h.root.querySelectorAll('input,select,textarea'))assert.ok(el.labels.length||el.getAttribute('aria-label'),'Missing label: '+el.name);}assert.equal([...h.root.querySelectorAll('button')].some(b=>/Опублікувати/.test(b.textContent)),false);assert.match(h.root.textContent,/сервер.*працює|працю.*сервер/i);}finally{h.close();}
});
test('destroy prevents pending responses from mutating the interface',async()=>{
  const slow=deferred();const h=harness({route:url=>url.endsWith('/status')?slow.promise:null});
  try{const pending=h.ui.refresh();const before=h.root.textContent;h.ui.destroy();slow.resolve(response({available:true,credentialStorage:true}));await pending;assert.equal(h.root.textContent,before);}finally{h.close();}
});

test('a revision conflict keeps existing page data and shows a useful error',async()=>{
  const h=harness({route:(url,method)=>url.endsWith('/pages/pg1')&&method==='PATCH'?response({code:'revision_conflict'},409):null});
  h.db.pages.push({id:'pg1',title:'Чинна версія',revision:3,config:{title:'Не змінювати'}});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-action="update-page"]');assert.match(h.root.textContent,/уже змінено/);assert.equal(h.db.pages[0].config.title,'Не змінювати');assert.equal(h.root.querySelector('[data-lc-action="update-page"]').disabled,false);}finally{h.close();}
});
test('checking a site only enqueues the server job and does not call WordPress from browser',async()=>{
  const h=harness();h.db.sites.push({id:'s1',name:'Мій сайт',baseUrl:'https://own.test/',enabled:true,revision:1});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-tab="sites"]');await h.click('[data-lc-action="check-site"]');assert.equal(h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/sites/s1/check')).length,1);assert.ok(h.calls.every(c=>c.url.startsWith('/api/lifecycle/')));await h.click('.lc-tabs [data-lc-tab="pages"]');await h.click('.lc-secondary-tools > summary');await h.click('.lc-secondary-tools [data-lc-tab="jobs"]');assert.match(h.root.textContent,/У черзі/);}finally{h.close();}
});
test('registered published page URL preserves query characters and is read-only registration',async()=>{
  const h=harness();h.db.sites.push({id:'s1',name:'Власний сайт',baseUrl:'https://own.test',enabled:true,revision:1});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');h.input('monitorTitle','Вже опублікована');h.input('monitorUrl','https://own.test/page/?x=%2F&a=1#part');h.input('monitorSite','s1');h.input('monitorWpId','123');await h.submit('[data-lc-form="monitor-page"]');const saved=h.calls.find(c=>c.method==='POST'&&c.url.endsWith('/pages'));assert.equal(saved.payload.fullUrl,'https://own.test/page/?x=%2F&a=1#part');assert.equal(saved.payload.wpId,123);assert.equal(saved.payload.config,undefined);assert.equal(h.root.querySelector('a.lc-url').getAttribute('href'),saved.payload.fullUrl);}finally{h.close();}
});
test('server-supplied dangerous URL stays plain text with no active link',async()=>{
  const h=harness();h.db.pages.push({id:'pg1',title:'<script>alert(1)</script>',revision:1,fullUrl:'javascript:alert(1)',lifecycleState:'saved'});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');assert.equal(h.root.querySelector('script'),null);assert.equal(h.root.querySelector('a.lc-url'),null);assert.match(h.root.textContent,/javascript:alert/);}finally{h.close();}
});

test('local draft metadata never claims a WordPress draft and URL-only pages cannot open empty config',async()=>{
  const h=harness();h.db.pages.push({id:'pg1',title:'Локальна копія',revision:1,config:{title:'Local'},lifecycleState:'draft'},{id:'pg2',title:'Лише URL',revision:1,config:{},fullUrl:'https://own.test/page/',lifecycleState:'draft'});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');assert.match(h.root.textContent,/Збережено у проєкті/);assert.match(h.root.textContent,/Під наглядом/);assert.doesNotMatch(h.root.textContent,/Чернетка WordPress/);assert.equal(h.root.querySelectorAll('[data-lc-action="open-page"]').length,1);}finally{h.close();}
});
test('real service site status and check evidence explain problems in Ukrainian',async()=>{
  const h=harness({route:url=>url.endsWith('/pages/pg1/checks')?response({checks:[{kind:'noindex',state:'problem',evidence:'meta robots: noindex',checkedAt:'2026-10-14T10:00:00Z'}]}):null});
  h.db.sites.push({id:'s1',name:'Сайт',baseUrl:'https://own.test',enabled:true,status:'problem',lastCheckedAt:'2026-10-14T10:00:00Z',revision:1});h.db.pages.push({id:'pg1',title:'Сторінка',fullUrl:'https://own.test/page/',config:{},revision:1});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-tab="sites"]');assert.match(h.root.textContent,/Доступ: Проблема/);await h.click('[data-lc-tab="pages"]');await h.click('[data-lc-action="page-checks"]');assert.match(h.root.textContent,/Індексація/);assert.match(h.root.textContent,/meta robots: noindex/);}finally{h.close();}
});

function publishHarness(route) {
  const h=harness({route:(url,method,payload,db)=>{
    if(url.endsWith('/status'))return response({available:true,runtime:'local',credentialStorage:true,monitoring:{enabled:true},publication:true});
    return route&&route(url,method,payload,db);
  }});
  h.db.pages.push({id:'pg1',title:'Saved page',revision:7,config:{title:'Saved page'},fullUrl:'https://own.test/page/'});
  h.db.sites.push({id:'s1',name:'Own site',baseUrl:'https://own.test/',enabled:true,status:'ok',hasCredential:true,revision:1});
  return h;
}
async function openProject(h){await h.ui.refresh();await h.click('[data-lc-project="p1"]');}
const places=[{id:'brand-header',label:'Бренд у хедері',role:'brand-header',url:'https://old.test/?x=%2F&b=1',anchor:'Original brand',anchorEditable:false},{id:'card-1:cta',label:'Кнопка першої картки',role:'offer-cta',url:'https://old.test/?x=%2F&b=1',anchor:'VIEW CASINO',anchorEditable:true,binding:'exact-source'}];
function replacementRoute(url,method,payload,db){
  if(url.endsWith('/placements'))return response({pageRevision:7,placements:places});
  if(url.endsWith('/proposals')&&method==='POST')return response({proposal:{id:'pr1',pageId:'pg1',revision:1,expectedPageRevision:7,state:'pending',diff:payload.changes.map(c=>({id:c.id,label:places.find(p=>p.id===c.id).label,before:{url:c.expectedUrl,anchor:c.expectedAnchor},after:{url:c.url,anchor:c.anchor||c.expectedAnchor}}))}},201);
  if(url.endsWith('/proposals/pr1/confirm')){const job={id:'jr',pageId:'pg1',proposalId:'pr1',type:'replace',state:'queued'};db.jobs.push(job);return response({job},202);}
}
test('publication launch sends the chosen site mode revision and stable key exactly once',async()=>{
  const h=publishHarness((url,method,payload,db)=>{if(url.endsWith('/publish')){const job={id:'jp',pageId:'pg1',siteId:payload.siteId,type:'publish',state:'queued',idempotencyKey:payload.idempotencyKey};db.jobs.push(job);return response({job},202);}});
  try{await openProject(h);await h.click('[data-lc-action="publish-page"]');h.input('publishSite','s1');h.input('publishMode','publish');await h.submit('[data-lc-form="publish"]');const calls=h.calls.filter(c=>c.url.endsWith('/publish'));assert.equal(calls.length,1);assert.deepEqual({...calls[0].payload,idempotencyKey:'key'},{siteId:'s1',mode:'publish',expectedRevision:7,idempotencyKey:'key'});assert.match(calls[0].payload.idempotencyKey,/^[a-f0-9-]{36}$/i);assert.match(h.root.textContent,/У черзі/);await h.ui.refresh();await h.click('[data-lc-action="publish-page"]');assert.equal(h.root.querySelector('[data-lc-form="publish"] button[type="submit"]'),null);assert.equal(h.calls.filter(c=>c.url.endsWith('/publish')).length,1);}finally{h.close();}
});
test('unknown publication response keeps launch key and blocks another write after refresh',async()=>{
  const h=publishHarness(url=>{if(url.endsWith('/publish'))throw new TypeError('Network disconnected');});
  try{await openProject(h);await h.click('[data-lc-action="publish-page"]');await h.submit('[data-lc-form="publish"]');assert.match(h.root.textContent,/невідом|Не підтверджено|звір/i);const key=h.calls.find(c=>c.url.endsWith('/publish')).payload.idempotencyKey;assert.ok(h.dom.window.sessionStorage.getItem('pageposter.lifecycle.launches.v1').includes(key));await h.ui.refresh();await h.click('[data-lc-action="publish-page"]');assert.equal(h.root.querySelector('[data-lc-form="publish"] button[type="submit"]'),null);assert.equal(h.calls.filter(c=>c.url.endsWith('/publish')).length,1);assert.ok(h.root.querySelector('[data-lc-action="refresh-launch"]'));}finally{h.close();}
});
test('replacement requires selecting exact occurrences then inspecting diff before explicit confirmation',async()=>{
  const h=publishHarness(replacementRoute);h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);await h.click('[data-lc-action="replace-links"]');assert.equal(h.root.querySelector('[data-lc-action="confirm-proposal"]'),null);const rows=h.root.querySelectorAll('[data-lc-placement]');assert.equal(rows.length,2);rows[1].querySelector('input[type="checkbox"]').click();rows[1].querySelector('[name="replacementUrl"]').value='https://final.test/?offer=3&x=%2F';rows[1].querySelector('[name="replacementAnchor"]').value='Точний анкор';await h.submit('[data-lc-form="replacement"]');const create=h.calls.find(c=>c.url.endsWith('/proposals'));assert.equal(create.payload.expectedRevision,7);assert.deepEqual(create.payload.changes,[{id:'card-1:cta',url:'https://final.test/?offer=3&x=%2F',anchor:'Точний анкор',expectedUrl:places[1].url,expectedAnchor:'VIEW CASINO',expectedBinding:'exact-source'}]);assert.match(h.root.textContent,/https:\/\/old.test\/\?x=%2F&b=1/);assert.match(h.root.textContent,/https:\/\/final.test\/\?offer=3&x=%2F/);assert.equal(h.calls.some(c=>c.url.endsWith('/confirm')),false);await h.click('[data-lc-action="confirm-proposal"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/confirm')).payload,{expectedRevision:1,confirmed:true});await h.click('[data-lc-tab="jobs"]');assert.match(h.root.textContent,/У черзі/);}finally{h.close();}
});
test('stale placements response cannot open replacement panel in another project',async()=>{
  const slow=deferred(),h=publishHarness(url=>url.endsWith('/placements')?slow.promise:null);h.db.projects.push({id:'p2',name:'Second',revision:1});h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);h.root.querySelector('[data-lc-action="replace-links"]').click();await delay();await h.click('[data-lc-project="p2"]');slow.resolve(response({pageRevision:7,placements:places}));await delay();assert.equal(h.root.querySelector('[data-lc-form="replacement"]'),null);}finally{h.close();}
});
test('revision conflict invalidates a reviewed proposal instead of allowing repeated confirm',async()=>{
  const h=publishHarness((url,method,payload,db)=>url.endsWith('/confirm')?response({code:'CONFLICT'},409):replacementRoute(url,method,payload,db));h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);await h.click('[data-lc-action="replace-links"]');const row=h.root.querySelector('[data-lc-placement]');row.querySelector('input[type="checkbox"]').click();row.querySelector('[name="replacementUrl"]').value='https://final.test/';await h.submit('[data-lc-form="replacement"]');await h.click('[data-lc-action="confirm-proposal"]');assert.match(h.root.textContent,/уже змінено|Конфлікт/);assert.equal(h.root.querySelector('[data-lc-action="confirm-proposal"]'),null);assert.equal(h.calls.filter(c=>c.url.endsWith('/confirm')).length,1);}finally{h.close();}
});
test('uncertain job reconciliation only requests read-only reconcile and never republishes',async()=>{
  const h=publishHarness((url,method,payload,db)=>{if(url.endsWith('/jobs/ju/reconcile')){db.jobs[0].state='completed';return response({job:db.jobs[0]});}});h.db.jobs.push({id:'ju',pageId:'pg1',type:'publish',state:'uncertain'});
  try{await openProject(h);await h.click('[data-lc-tab="jobs"]');assert.match(h.root.textContent,/звір/i);await h.click('[data-lc-action="reconcile-job"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/reconcile')).payload,{});assert.equal(h.calls.some(c=>c.url.endsWith('/publish')),false);assert.match(h.root.textContent,/Завершено/);}finally{h.close();}
});
test('Bridge installation is an explicit one-time WordPress step and workflow fields are accessible',async()=>{
  const h=publishHarness();h.dom.window.PagePosterDownloads={bridge:{base64:'UEs=',filename:'pageposter-bridge.zip',version:'1.0.0'},cleanLinks:{base64:'UEs=',filename:'pageposter-clean-links.zip',version:'1.1.1'}};
  try{await openProject(h);await h.click('[data-lc-tab="sites"]');assert.match(h.root.textContent,/PagePoster Bridge/);assert.match(h.root.textContent,/ZIP/);assert.ok(h.root.querySelector('[data-lc-action="download-bridge"]'));assert.ok(h.root.querySelector('[data-lc-action="download-clean-links"]'));await h.click('[data-lc-tab="pages"]');await h.click('[data-lc-action="publish-page"]');for(const control of h.root.querySelectorAll('input,select,textarea'))assert.ok(control.labels.length||control.getAttribute('aria-label'));}finally{h.close();}
});

test('unknown replacement survives panel close and blocks both a second proposal and publication',async()=>{
  const h=publishHarness((url,method,payload,db)=>{if(url.endsWith('/confirm'))throw new TypeError('lost response');return replacementRoute(url,method,payload,db);});h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);await h.click('[data-lc-action="replace-links"]');const row=h.root.querySelector('[data-lc-placement]');row.querySelector('input[type="checkbox"]').click();row.querySelector('[name="replacementUrl"]').value='https://final.test/';await h.submit('[data-lc-form="replacement"]');await h.click('[data-lc-action="confirm-proposal"]');await h.click('[data-lc-action="close-flow"]');await h.click('[data-lc-action="replace-links"]');assert.equal(h.root.querySelector('[data-lc-form="replacement"]'),null);await h.ui.refresh();await h.click('[data-lc-action="publish-page"]');assert.equal(h.root.querySelector('[data-lc-form="publish"]'),null);assert.equal(h.calls.filter(c=>c.url.endsWith('/confirm')).length,1);}finally{h.close();}
});
test('session launch metadata restores an uncertain write when the UI instance is recreated',async()=>{
  const h=publishHarness(url=>{if(url.endsWith('/publish'))throw new TypeError('disconnected');});let second;
  try{await openProject(h);await h.click('[data-lc-action="publish-page"]');await h.submit('[data-lc-form="publish"]');h.ui.destroy();second=require(modulePath).create({element:h.root,fetchImpl:async url=>{if(url.endsWith('/status'))return response({available:true,publication:true});if(url.endsWith('/projects'))return response({projects:h.db.projects});if(url.endsWith('/pages'))return response({pages:h.db.pages});if(url.endsWith('/sites'))return response({sites:h.db.sites});if(url.endsWith('/jobs'))return response({jobs:[]});return response({events:[]});}});await second.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-action="publish-page"]');assert.equal(h.root.querySelector('[data-lc-form="publish"]'),null);assert.match(h.root.textContent,/повторний запис заблокований/i);}finally{if(second)second.destroy();h.close();}
});
test('unchecked site cannot launch publication and no credentials are included in launch metadata',async()=>{
  const h=publishHarness();h.db.sites[0].status='unknown';
  try{await openProject(h);await h.click('[data-lc-action="publish-page"]');assert.equal(h.root.querySelector('[data-lc-form="publish"] button[type="submit"]').disabled,true);await h.submit('[data-lc-form="publish"]');assert.equal(h.calls.some(c=>c.url.endsWith('/publish')),false);assert.match(h.root.textContent,/перевірте доступ|Перевірте доступ/);}finally{h.close();}
});

test('queued task pause is explicit and running writes warn that the result may still complete',async()=>{
  const h=publishHarness((url,method,payload,db)=>{if(url.endsWith('/jobs/jp/pause')){db.jobs[0].state='uncertain';return response({job:db.jobs[0]});}});h.db.jobs.push({id:'jp',pageId:'pg1',type:'publish',effect:'write',state:'running'});
  try{await openProject(h);await h.click('[data-lc-tab="jobs"]');assert.match(h.root.textContent,/може завершитися/);await h.click('[data-lc-action="pause-job"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/pause')).payload,{});assert.match(h.root.textContent,/Потребує звірки/);assert.equal(h.calls.some(c=>c.url.endsWith('/publish')),false);}finally{h.close();}
});
test('a confirmed WordPress draft is distinguished from a local draft and cannot be created twice',async()=>{
  const h=publishHarness();h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'verified'};h.db.pages[0].lifecycleState='draft';
  try{await openProject(h);assert.match(h.root.textContent,/Чернетка WordPress/);assert.equal(h.root.querySelector('[data-lc-action="publish-page"]'),null);assert.ok(h.root.querySelector('[data-lc-action="replace-links"]'));}finally{h.close();}
});

test('refresh invalidates a reviewed proposal when saved page revision changed elsewhere',async()=>{
  const h=publishHarness(replacementRoute);h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);await h.click('[data-lc-action="replace-links"]');const row=h.root.querySelector('[data-lc-placement]');row.querySelector('input[type="checkbox"]').click();row.querySelector('[name="replacementUrl"]').value='https://final.test/';await h.submit('[data-lc-form="replacement"]');h.db.pages[0].revision=8;await h.ui.refresh();assert.equal(h.root.querySelector('[data-lc-action="confirm-proposal"]'),null);assert.match(h.root.textContent,/уже змінено|Старе підтвердження/);assert.equal(h.calls.some(c=>c.url.endsWith('/confirm')),false);}finally{h.close();}
});
test('accepted publication shows completion when server advances the page revision',async()=>{
  const h=publishHarness((url,method,payload,db)=>{if(url.endsWith('/publish')){const job={id:'jp',type:'publish',pageId:'pg1',idempotencyKey:payload.idempotencyKey,state:'completed'};db.jobs.push(job);db.pages[0].revision=9;db.pages[0].wpId=42;db.pages[0].remoteSnapshot={contentHash:'published'};db.pages[0].lifecycleState='published';return response({job},202);}});
  try{await openProject(h);await h.click('[data-lc-action="publish-page"]');await h.submit('[data-lc-form="publish"]');assert.match(h.root.querySelector('.lc-content .lc-workflow').textContent,/Завершено/);assert.doesNotMatch(h.root.querySelector('.lc-content .lc-workflow').textContent,/Старе підтвердження/);}finally{h.close();}
});

test('manual replay after refreshed unmatched publish uses the identical saved request and key',async()=>{
  let attempts=0;const h=publishHarness((url,method,payload,db)=>{if(url.endsWith('/publish')){if(++attempts===1)throw new TypeError('not delivered');const job={id:'jp',pageId:'pg1',type:'publish',idempotencyKey:payload.idempotencyKey,state:'queued'};db.jobs.push(job);return response({job},202);}});
  try{await openProject(h);await h.click('[data-lc-action="publish-page"]');h.input('publishMode','publish');await h.submit('[data-lc-form="publish"]');assert.equal(h.root.querySelector('[data-lc-action="retry-launch"]'),null);await h.click('[data-lc-action="refresh-launch"]');await h.click('[data-lc-action="retry-launch"]');const calls=h.calls.filter(c=>c.url.endsWith('/publish'));assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);assert.match(h.root.textContent,/У черзі/);}finally{h.close();}
});
test('manual replay first looks for an exact-key server job and never resubmits an accepted operation',async()=>{
  const h=publishHarness(url=>{if(url.endsWith('/publish'))throw new TypeError('lost');});
  try{await openProject(h);await h.click('[data-lc-action="publish-page"]');await h.submit('[data-lc-form="publish"]');await h.click('[data-lc-action="refresh-launch"]');assert.ok(h.root.querySelector('[data-lc-action="retry-launch"]'));const sent=h.calls.find(c=>c.url.endsWith('/publish'));h.db.jobs.push({id:'jp',pageId:'pg1',type:'publish',idempotencyKey:sent.payload.idempotencyKey,state:'running'});await h.click('[data-lc-action="retry-launch"]');assert.equal(h.calls.filter(c=>c.url.endsWith('/publish')).length,1);assert.match(h.root.textContent,/Виконується/);}finally{h.close();}
});
test('manual replay of an unmatched confirmation keeps proposal ID and proposal revision',async()=>{
  let attempts=0;const h=publishHarness((url,method,payload,db)=>{if(url.endsWith('/confirm')&&++attempts===1)throw new TypeError('lost');return replacementRoute(url,method,payload,db);});h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);await h.click('[data-lc-action="replace-links"]');const row=h.root.querySelector('[data-lc-placement]');row.querySelector('input[type="checkbox"]').click();row.querySelector('[name="replacementUrl"]').value='https://final.test/';await h.submit('[data-lc-form="replacement"]');await h.click('[data-lc-action="confirm-proposal"]');await h.click('[data-lc-action="refresh-launch"]');await h.click('[data-lc-action="retry-launch"]');const sent=h.calls.filter(c=>c.url.endsWith('/confirm'));assert.equal(sent.length,2);assert.equal(sent[0].url,sent[1].url);assert.deepEqual(sent[0].payload,sent[1].payload);assert.equal(sent[1].payload.expectedRevision,1);}finally{h.close();}
});
async function selectBackup(h,backup){const input=h.root.querySelector('[name="backupFile"]');assert.ok(input);Object.defineProperty(input,'files',{configurable:true,value:[new h.dom.window.File([JSON.stringify(backup)],'backup.json',{type:'application/json'})]});input.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await delay();}
const sampleBackup={kind:'pageposter-lifecycle-backup',schemaVersion:1,projects:[{id:'old',name:'Restored'}],sites:[{id:'s1',enabled:true}],pages:[{id:'old-page'}],pageVersions:[],checks:[],events:[],jobs:[{id:'prior-write',state:'running'}]};
test('backup restoration is reviewed before POST and retains no backup in browser storage',async()=>{
  const h=harness({route:(url,method,payload,db)=>{if(url.endsWith('/backup/restore')){db.projects.push({id:'restored',name:'Restored',revision:1});return response({restored:{projects:1,sites:1,pages:1}});}}});h.db.projects=[];
  try{await h.ui.refresh();await h.click('[data-lc-action="restore-backup"]');await selectBackup(h,sampleBackup);assert.match(h.root.textContent,/1 проєкт|Проєктів: 1/);assert.match(h.root.textContent,/вимкнен|Вимкнен/);assert.match(h.root.textContent,/не.*віднов|не.*запуск/i);assert.equal(h.calls.some(c=>c.url.endsWith('/backup/restore')),false);await h.click('[data-lc-action="confirm-restore"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/backup/restore')).payload,{backup:sampleBackup});assert.equal(h.dom.window.localStorage.length,0);assert.equal(h.dom.window.sessionStorage.length,0);assert.match(h.root.textContent,/Restored/);}finally{h.close();}
});
test('restore cannot replace existing projects and invalid JSON never becomes an approved import',async()=>{
  const h=harness();try{await h.ui.refresh();await h.click('[data-lc-action="restore-backup"]');assert.match(h.root.textContent,/порожн/i);assert.equal(h.root.querySelector('[name="backupFile"]').disabled,true);assert.equal(h.root.querySelector('[data-lc-action="confirm-restore"]'),null);h.db.projects=[];await h.ui.refresh();await h.click('[data-lc-action="restore-backup"]');await selectBackup(h,{kind:'not-pageposter',projects:[]});assert.equal(h.root.querySelector('[data-lc-action="confirm-restore"]'),null);assert.equal(h.calls.some(c=>c.url.endsWith('/backup/restore')),false);}finally{h.close();}
});

const rollbackVersions=[{id:'v2',revision:2,title:'Previous title',createdAt:'2026-10-14T12:00:00Z',status:'publish'}];
function rollbackRoute(url,method,payload,db){
  if(url.endsWith('/rollback-versions'))return response({pageRevision:7,versions:rollbackVersions});
  if(url.endsWith('/rollback-proposals'))return response({proposal:{id:'rollback-1',pageId:'pg1',revision:1,expectedPageRevision:7,state:'pending',kind:'rollback',diff:[{id:'revision',label:'Версія',before:{url:'',anchor:'7'},after:{url:'',anchor:'2'}},{id:'title',label:'Заголовок',before:{url:'',anchor:'Current'},after:{url:'',anchor:'Previous title'}},{id:'status',label:'Стан',before:{url:'',anchor:'publish'},after:{url:'',anchor:'publish'}},{id:'content',label:'HTML сторінки',before:{url:'',anchor:'<p>New</p>'},after:{url:'',anchor:'<script>alert(1)</script><p>Old exact content</p>'}}]}},201);
  if(url.endsWith('/proposals/rollback-1/confirm')){const job={id:'rollback-job',type:'replace',effect:'write',state:'queued',pageId:'pg1',idempotencyKey:'proposal:rollback-1'};db.jobs.push(job);return response({job},202);}
}
test('rollback selects a committed version and shows inert exact content before explicit confirmation',async()=>{
  const h=publishHarness(rollbackRoute);h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);await h.click('[data-lc-action="rollback-page"]');assert.match(h.root.textContent,/ручні зміни|вручну/);assert.equal(h.calls.some(c=>c.url.endsWith('/rollback-proposals')),false);h.input('rollbackVersion','v2');await h.submit('[data-lc-form="rollback"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/rollback-proposals')).payload,{expectedRevision:7,versionId:'v2'});assert.equal(h.root.querySelector('script'),null);assert.equal(h.root.querySelector('.lc-diffs pre').tagName,'PRE');assert.match(h.root.textContent,/<script>alert\(1\)<\/script>/);assert.match(h.root.textContent,/Текст \/ значення/);assert.equal(h.calls.some(c=>c.url.endsWith('/confirm')),false);const confirm=h.root.querySelector('[data-lc-action="confirm-proposal"]');assert.match(confirm.textContent,/відкат/i);await h.click('[data-lc-action="confirm-proposal"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/confirm')).payload,{expectedRevision:1,confirmed:true});assert.match(h.root.textContent,/У черзі/);}finally{h.close();}
});
test('rollback with no committed prior versions gives no prepare or confirm action',async()=>{
  const h=publishHarness(url=>url.endsWith('/rollback-versions')?response({pageRevision:7,versions:[]}):null);h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);await h.click('[data-lc-action="rollback-page"]');assert.match(h.root.textContent,/попередніх.*версій|Попередніх.*версій/);assert.equal(h.root.querySelector('[data-lc-form="rollback"]'),null);assert.equal(h.root.querySelector('[data-lc-action="confirm-proposal"]'),null);}finally{h.close();}
});
test('rollback source revision conflict never displays confirmation',async()=>{
  const h=publishHarness(url=>url.endsWith('/rollback-versions')?response({pageRevision:8,versions:rollbackVersions}):null);h.db.pages[0].wpId=42;h.db.pages[0].remoteSnapshot={contentHash:'saved'};
  try{await openProject(h);await h.click('[data-lc-action="rollback-page"]');assert.match(h.root.textContent,/уже змінено/);assert.equal(h.root.querySelector('[data-lc-action="confirm-proposal"]'),null);assert.equal(h.calls.some(c=>c.method==='POST'),false);}finally{h.close();}
});


test('project overview exposes progress and distinguishes missing checks from healthy pages',async()=>{
  const h=harness();h.db.pages.push({id:'pg1',title:'Нова',revision:1,config:{title:'Нова'},lifecycleState:'local'});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-tab="overview"]');assert.match(h.root.textContent,/Створити сторінку/);assert.match(h.root.textContent,/Сторінок у проєкті/);assert.match(h.root.textContent,/Підключити WordPress/);assert.match(h.root.textContent,/ще не перевірен/i);}finally{h.close();}
});
test('new page is created inside project without replacing editor and next step opens run form',async()=>{
  let prepared;
  const h=harness({options:{createPageSnapshot:async input=>{prepared=input;return {title:input.keyword,config:{title:input.keyword,cards:[{url:input.links}],sections:[],faq:[]},uniqueUrls:[input.links]};}}});
  try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-action="new-page"]');h.input('newKeyword','Моя тема');h.input('newLinks','https://offer.test/?x=%2F&a=1#part');h.input('newCardCount','10');await h.submit('[data-lc-form="new-page"]');assert.equal(prepared.cardCount,10);assert.equal(prepared.keyword,'Моя тема');const saved=h.calls.find(c=>c.method==='POST'&&c.url.endsWith('/pages'));assert.equal(saved.payload.config.cards[0].url,prepared.links);assert.equal(h.opened.length,0);assert.match(h.root.textContent,/Моя тема/);}finally{h.close();}
});
test('unavailable workspace gives exact launcher name and explicit local link',async()=>{
 const h=harness({route:url=>url.endsWith('/status')?response({available:false,runtime:'editor'}):null});
 try{await h.ui.refresh();assert.match(h.root.textContent,/Start-PagePoster.cmd/);assert.equal(h.root.querySelector('a[href="http://127.0.0.1:4317/?workspace=projects"]').textContent,'Відкрити локальний PagePoster');}finally{h.close();}
});


test('monitoring separates HTTP availability, indexing restriction and never checked appearance',async()=>{
 const h=harness({route:url=>url.endsWith('/overview')?response({pages:[{pageId:'pg1',checks:[{kind:'public',state:'ok',checkedAt:'2026-10-15T00:00:00Z'},{kind:'noindex',state:'problem',checkedAt:'2026-10-15T00:00:00Z'}]}],runs:[]}):null});h.db.pages.push({id:'pg1',title:'Published',fullUrl:'https://own.test/page/',revision:1});
 try{await h.ui.refresh();await h.click('[data-lc-project="p1"]');await h.click('[data-lc-tab="monitor"]');const rows=[...h.root.querySelectorAll('.lc-health-item')];assert.match(rows.find(r=>r.textContent.includes('Noindex')).textContent,/Проблема/);assert.match(rows.find(r=>r.textContent.includes('Відкриття')).textContent,/Гаразд/);assert.match(rows.find(r=>r.textContent.includes('Вигляд на сайті')).textContent,/Ще не перевірено/);}finally{h.close();}
});


test('workspace separates publication from verification and copies the exact full URL',async()=>{
  const h=harness({route:url=>url.endsWith('/overview')?response({pages:[{pageId:'pg1',checks:[],verification:{state:'pending',summary:'Awaiting browser'}}],runs:[]}):null});
  h.db.pages.push({id:'pg1',title:'Published',revision:1,fullUrl:'https://own.test/page/?a=%2F&x=2#part',lifecycleState:'published'});
  const copied=[];Object.defineProperty(h.dom.window.navigator,'clipboard',{value:{writeText:async value=>copied.push(value)}});
  try{await openProject(h);assert.match(h.root.textContent,/Опубліковано/);assert.match(h.root.textContent,/Очікує перевірки/);assert.equal(h.root.querySelector('.lc-card .lc-good'),null);await h.click('[data-lc-action="copy-url"]');assert.deepEqual(copied,[h.db.pages[0].fullUrl]);}finally{h.close();}
});
test('project settings save a revision-bound monitoring policy and archive without deleting pages',async()=>{
  const h=harness({route:(url,method,payload,db)=>url==='/api/lifecycle/projects/p1'&&method==='PATCH'?response({project:Object.assign(db.projects[0],payload,{revision:2})}):null});
  h.db.projects[0].responsible='Олена';
  try{await openProject(h);await h.click('[data-lc-tab="settings"]');h.input('settingsName','Оновлено');h.input('settingsResponsible','Ірина');h.input('settingsTags','тест, новий');h.input('pageIntervalMinutes','90');await h.submit('[data-lc-form="project-settings"]');const saved=h.calls.find(c=>c.method==='PATCH');assert.equal(saved.payload.expectedRevision,1);assert.equal(saved.payload.responsible,'Ірина');assert.deepEqual(saved.payload.tags,['тест','новий']);assert.equal(saved.payload.monitoringPolicy.pageIntervalMinutes,90);await h.click('[data-lc-action="archive-project"]');assert.equal(h.calls.filter(c=>c.method==='PATCH').at(-1).payload.archived,true);assert.equal(h.calls.filter(c=>c.method==='DELETE').length,0);}finally{h.close();}
});


test('multi-page batch sends selected exact placements and confirms the immutable server diff only once',async()=>{
  let prepared;
  const h=publishHarness((url,method,payload)=>{
    if(url.endsWith('/placements'))return response({pageRevision:7,placements:places});
    if(url.endsWith('/replacement-batches')&&method==='POST'){prepared={id:'b1',revision:1,confirmationHash:'exact-hash',state:'pending',items:payload.items.map(item=>({...item,title:item.pageId,diff:item.changes.map(c=>({id:c.id,before:{url:c.expectedUrl,anchor:c.expectedAnchor},after:{url:c.url,anchor:c.anchor||c.expectedAnchor}}))}))};return response({batch:prepared});}
    if(url.endsWith('/replacement-batches/b1/confirm'))return response({batch:{...prepared,state:'queued',revision:2}});
  });
  h.db.pages[0].wpId=22;h.db.pages[0].remoteSnapshot={hash:'old'};h.db.pages.push({...h.db.pages[0],id:'pg2',title:'Second',wpId:23});
  try{await openProject(h);await h.click('[data-lc-tab="replacements"]');for(const check of h.root.querySelectorAll('[data-batch-select]')){check.checked=true;check.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));}await h.click('[data-lc-action="load-batch"]');const rows=[...h.root.querySelectorAll('[data-batch-page]')].filter(r=>r.dataset.batchPlacement==='card-1:cta');for(const row of rows){row.querySelector('[name=batchSelected]').checked=true;row.querySelector('[name=batchUrl]').value='https://new.test/?x=%2F&x=1#fragment';}await h.submit('[data-lc-form="replacement-batch"]');assert.equal(h.calls.filter(c=>c.url.endsWith('/confirm')).length,0);const sent=h.calls.find(c=>c.url.endsWith('/replacement-batches')&&c.method==='POST');assert.equal(sent.payload.items.length,2);assert.ok(sent.payload.items.every(i=>i.changes.length===1&&i.changes[0].expectedBinding==='exact-source'));assert.match(h.root.textContent,/Було/);assert.match(h.root.textContent,/Буде/);await h.click('[data-lc-action="confirm-batch"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/replacement-batches/b1/confirm')).payload,{expectedRevision:1,confirmationHash:'exact-hash',confirmed:true});assert.equal(h.root.querySelector('[data-lc-action="confirm-batch"]'),null);}finally{h.close();}
});
test('shared site selection links the existing site without asking for credentials again',async()=>{
 const h=harness({route:(url,method,payload)=>url==='/api/lifecycle/sites'?response({sites:[{id:'global1',name:'Спільний сайт'}]}):url.endsWith('/sites/link')?response({site:{id:payload.siteId}}):null});
 try{await openProject(h);await h.click('[data-lc-tab="sites"]');await h.click('[data-lc-action="existing-sites"]');await h.click('[data-lc-action="link-site"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/sites/link')).payload,{siteId:'global1'});}finally{h.close();}
});


test('existing-page import reviews safe metadata then queues adoption without publishing',async()=>{
 const preview={id:'im1',revision:3,confirmationHash:'exact-import',title:'Існуюча сторінка',fullUrl:'https://own.test/existing/?a=%2F#part',wpId:55,wpType:'page',canAdopt:true,warnings:['Перевірте зовнішні стилі.'],summary:'Поточну версію прочитано.'};
 const h=publishHarness((url,method,payload)=>url.endsWith('/imports/preview')?response({preview}):url.endsWith('/imports/im1/confirm')?response({page:{id:'adopted'},job:{id:'adopt-job',state:'queued'}}):null);
 try{await openProject(h);h.input('importSite','s1');h.input('importWpId','55');await h.submit('[data-lc-form="import-preview"]');assert.match(h.root.textContent,/Існуюча сторінка/);assert.match(h.root.textContent,/Перевірте зовнішні стилі/);assert.equal(h.calls.some(c=>c.url.endsWith('/confirm')),false);await h.click('[data-lc-action="confirm-import"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/imports/im1/confirm')).payload,{expectedRevision:3,confirmationHash:'exact-import',confirmed:true});assert.equal(h.calls.some(c=>c.url.endsWith('/publish')),false);assert.match(h.root.textContent,/Прив’язку передано до черги/);assert.equal(h.root.querySelector('[data-lc-action="confirm-import"]'),null);}finally{h.close();}
});
test('changing import identity invalidates the reviewed confirmation and non-adoptable preview has no confirm',async()=>{
 let canAdopt=true;const h=publishHarness(url=>url.endsWith('/imports/preview')?response({preview:{id:'im1',revision:1,confirmationHash:'one',title:'One',wpId:55,wpType:'page',canAdopt}}):null);
 try{await openProject(h);h.input('importSite','s1');h.input('importWpId','55');await h.submit('[data-lc-form="import-preview"]');assert.ok(h.root.querySelector('[data-lc-action="confirm-import"]'));h.input('importWpId','56');assert.equal(h.root.querySelector('[data-lc-action="confirm-import"]'),null);canAdopt=false;await h.submit('[data-lc-form="import-preview"]');assert.equal(h.root.querySelector('[data-lc-action="confirm-import"]'),null);assert.match(h.root.textContent,/недоступна/);}finally{h.close();}
});
test('encrypted recovery inspection precedes confirmation and never persists the passphrase',async()=>{
 const h=harness({route:(url,method,payload)=>url==='/api/recovery/inspect'?response({summary:{projects:2,pages:3,sites:1,runs:1,jobs:1,files:5},canRestore:true}):url==='/api/recovery/restore'?response({restored:true,restartRequired:true}):null});h.db.projects.length=0;
 try{await h.ui.refresh();await h.click('[data-lc-action="recovery"]');const file={size:32,text:async()=>JSON.stringify({encrypted:'fixture'})};const input=h.root.querySelector('[name=recoveryFile]');Object.defineProperty(input,'files',{value:[file]});input.required=false;h.input('importPassphrase','test-passphrase-123');await h.submit('[data-lc-form="recovery-inspect"]');assert.equal(h.calls.some(c=>c.url==='/api/recovery/restore'),false);assert.equal(h.root.querySelector('[name=importPassphrase]').value,'');assert.equal(h.dom.window.sessionStorage.length,0);assert.equal(h.dom.window.localStorage.length,0);assert.doesNotMatch(h.root.textContent,/test-passphrase-123/);await h.click('[data-lc-action="confirm-recovery"]');const restore=h.calls.find(c=>c.url==='/api/recovery/restore');assert.equal(restore.payload.confirmed,true);assert.deepEqual(restore.payload.backup,{encrypted:'fixture'});assert.match(h.root.textContent,/перезапустіть сервер/);}finally{h.close();}
});


test('portable materials restore preview accepts the current schema 2 export with shared site links',async()=>{
 const h=harness();h.db.projects.length=0;try{await h.ui.refresh();await h.click('[data-lc-action="restore-backup"]');const backup={kind:'pageposter-lifecycle-backup',schemaVersion:2,projects:[],sites:[],pages:[],siteLinks:[]};const input=h.root.querySelector('[name=backupFile]');Object.defineProperty(input,'files',{value:[{size:100,text:async()=>JSON.stringify(backup)}]});input.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await delay();assert.ok(h.root.querySelector('[data-lc-action="confirm-restore"]'));assert.equal(h.calls.filter(c=>c.url.endsWith('/backup/restore')).length,0);}finally{h.close();}
});


test('uncertain remote writes offer same-request retry only after server authorization',async()=>{
 const h=publishHarness((url,method,payload,db)=>{if(url.endsWith('/jobs/jp/retry')){db.jobs[0]={...db.jobs[0],state:'queued',retryable:false};return response({job:db.jobs[0]});}});h.db.jobs.push({id:'jp',pageId:'pg1',type:'publish',effect:'write',state:'uncertain'});
 try{await openProject(h);await h.click('[data-lc-tab="jobs"]');assert.equal(h.root.querySelector('[data-lc-action="retry-job"]'),null);assert.ok(h.root.querySelector('[data-lc-action="reconcile-job"]'));h.db.jobs[0].retryable=true;await h.ui.refresh();assert.match(h.root.textContent,/не був зареєстрований/);await h.click('[data-lc-action="retry-job"]');assert.deepEqual(h.calls.find(c=>c.url.endsWith('/jobs/jp/retry')).payload,{});assert.equal(h.calls.filter(c=>c.url.endsWith('/jobs/jp/retry')).length,1);assert.match(h.root.textContent,/У черзі/);assert.equal(h.root.querySelector('[data-lc-action="retry-job"]'),null);}finally{h.close();}
});


test('encrypted recovery accepts archives above materials limit and blocks above 150 MiB',async()=>{
 const h=harness({route:url=>url==='/api/recovery/inspect'?response({summary:{projects:1},canRestore:true}):null});h.db.projects.length=0;try{await h.ui.refresh();await h.click('[data-lc-action="recovery"]');const input=h.root.querySelector('[name=recoveryFile]');input.required=false;Object.defineProperty(input,'files',{configurable:true,value:[{size:60*1024*1024,text:async()=>JSON.stringify({encrypted:'fixture'})}]});h.input('importPassphrase','test-passphrase-123');await h.submit('[data-lc-form="recovery-inspect"]');assert.equal(h.calls.filter(c=>c.url==='/api/recovery/inspect').length,1);Object.defineProperty(input,'files',{configurable:true,value:[{size:151*1024*1024,text:async()=>JSON.stringify({encrypted:'fixture'})}]});h.input('importPassphrase','test-passphrase-123');await h.submit('[data-lc-form="recovery-inspect"]');assert.equal(h.calls.filter(c=>c.url==='/api/recovery/inspect').length,1);assert.match(h.root.textContent,/150 МБ/);}finally{h.close();}
});
test('site setup displays verified plugin versions and actionable bootstrap status',async()=>{
 const h=harness();h.db.sites.push({id:'s1',name:'WP',baseUrl:'https://own.test',enabled:true,status:'setup_required',plugins:{bridge:{state:'active',version:'0.1.0',requiredVersion:'0.2.1',compatible:false},cleanLinks:{state:'active',version:'1.1.1',requiredVersion:'1.1.1',compatible:true}},bootstrap:{state:'update_required'}});try{await openProject(h);await h.click('[data-lc-tab="sites"]');assert.match(h.root.textContent,/Потрібне налаштування/);assert.match(h.root.textContent,/Bridge.*0.1.0.*0.2.1/);assert.match(h.root.textContent,/Clean Links.*1.1.1/);assert.match(h.root.textContent,/Оновіть/);assert.doesNotMatch(h.root.textContent,/setup_required|update_required/);}finally{h.close();}
});
