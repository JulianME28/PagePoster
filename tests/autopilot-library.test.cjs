'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname, '../dist');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

async function workspace() {
  const errors = [];
  const pages = [
    {id:'ready', projectId:'p1', title:'Польский гид', fullUrl:'https://poland.example/?track=%2f', verification:{state:'ok'}},
    {id:'bad', projectId:'p1', title:'Обзор предложений', fullUrl:'https://review.example/', verification:{state:'problem'}},
    {id:'unknown', projectId:'p1', title:'Другой материал', fullUrl:'https://unknown.example/', verification:{state:'unknown'}}
  ];
  const runs = [
    {id:'done', pageId:'ready', state:'completed', stage:'checking', title:'Польский гид'},
    {id:'busy', state:'running', stage:'generating', title:'Новый материал'},
    {id:'waiting', state:'waiting_source', stage:'selecting', title:'Ожидает сайта'},
    {id:'review', projectId:'p1', state:'awaiting_review', stage:'selecting', hasHtml:true, reviewBeforePublish:true, title:'Ожидает просмотра'}
  ];
  const dom = new JSDOM(read('index.html'), {url:'http://localhost/', runScripts:'outside-only', pretendToBeVisual:true});
  const w = dom.window;
  w.TextEncoder = TextEncoder;
  w.HTMLDialogElement.prototype.showModal = function(){this.open=true;};
  w.HTMLDialogElement.prototype.close = function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.addEventListener('error', e => errors.push(e.message));
  w.fetch = async url => {
    const requestUrl = new URL(String(url), w.location.href);
    const route = requestUrl.pathname.replace('/api/lifecycle', '');
    let data;
    if(route==='/projects') data={projects:[{id:'p1',name:'Первый проект'},{id:'p2',name:'Второй проект'}]};
    else if(route==='/autopilot/status') data={aiConfigured:true,source:{configured:false}};
    else if(/^\/projects\/p[12]\/pages$/.test(route)) {
      assert.deepEqual([...requestUrl.searchParams], [['summary','1']], 'Page snapshots request the summary contract');
      data={pages:route.includes('/p1/')?pages:[]};
    }
    else if(route.endsWith('/autopilot')) data={runs:route.includes('/p1/')?runs:[]};
    else if(route.endsWith('/overview')) data={pages:[]};
    else if(route.endsWith('/jobs')) data={jobs:[]};
    else if(route==='/autopilot/waiting/html') data={html:'<h1>Preview</h1>'};
    else if(route==='/autopilot/review/html') data={html:'<h1>Saved review</h1>',reviewToken:'saved-review-token'};
    else throw Error('Unexpected fixture route: '+String(url));
    return {ok:true,json:async()=>data};
  };
  w.eval(read('generation-options.js'));
  w.eval(read('autopilot-ui.js'));
  for(let i=0;i<30 && !w.document.querySelector('.ap-page');i++) await tick();
  return {dom,w,document:w.document,errors};
}

test('workspace overview counts verified pages separately and filters exact titles or URLs', async()=>{
  const {dom,w,document:d,errors}=await workspace();
  try {
    assert.ok(d.querySelector('#ap-overview'), 'workspace exposes a useful overview');
    assert.deepEqual([...d.querySelectorAll('.ap-stat-value')].map(n=>n.textContent), ['3','1','1','3']);
    assert.equal(d.querySelector('#ap-setup').hidden,false);
    const search=d.querySelector('#ap-search');
    search.value='POLAND.EXAMPLE';search.dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.equal(d.querySelectorAll('.ap-page').length,1);
    assert.match(d.querySelector('.ap-page').textContent,/Польский гид/);
    assert.equal(d.querySelector('.ap-page a').getAttribute('href'),'https://poland.example/?track=%2f');
    search.value='';search.dispatchEvent(new w.Event('input',{bubbles:true}));
    const filter=d.querySelector('#ap-filter');filter.value='attention';filter.dispatchEvent(new w.Event('change'));
    assert.equal(d.querySelectorAll('.ap-page').length,2);
    assert.equal(d.querySelectorAll('.ap-run').length,1);
    assert.equal(d.querySelector('.ap-run[data-state="awaiting_review"]'),null,'Prepared content awaiting review is not a problem');
    filter.value='verified';filter.dispatchEvent(new w.Event('change'));
    assert.equal(d.querySelectorAll('.ap-page').length,1);
    assert.equal(d.querySelectorAll('.ap-run').length,0);
    search.value='no matching page';search.dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.match(d.querySelector('#ap-results').textContent,/Нічого не знайдено/);
    assert.deepEqual(errors,[]);
  } finally {dom.window.close();}
});

test('preview switches desktop/mobile without replacing the reviewed content', async()=>{
  const {dom,w,document:d}=await workspace();
  try {
    const control=[...d.querySelectorAll('[data-run-id="waiting"] button')].find(b=>b.textContent==='Попередній перегляд');
    control.click();await tick();
    const frame=d.querySelector('#ap-stage-frame'),before=frame.srcdoc;
    const mobile=d.querySelector('#ap-stage-mobile');
    assert.ok(mobile,'mobile preview control exists');
    mobile.click();
    assert.equal(mobile.getAttribute('aria-pressed'),'true');
    assert.ok(d.querySelector('#ap-stage-canvas').classList.contains('is-mobile'));
    assert.equal(frame.srcdoc,before);
    assert.equal(frame.getAttribute('sandbox'),'allow-scripts');
    d.querySelector('#ap-stage-desktop').click();
    assert.equal(mobile.getAttribute('aria-pressed'),'false');
    assert.ok(!d.querySelector('#ap-stage-canvas').classList.contains('is-mobile'));
  } finally {w.close();}
});

test('switching projects clears stale pages and a failed load offers a working retry', async()=>{
  const {dom,w,document:d}=await workspace();
  try{
    const normalFetch=w.fetch;
    w.fetch=async url=>{if(String(url).includes('/projects/p2/pages'))throw Error('Сеть недоступна');return normalFetch(url);};
    [...d.querySelectorAll('.ap-project-button')].find(node=>node.getAttribute('aria-label')==='Второй проект').click();
    assert.equal(d.querySelectorAll('.ap-page').length,0,'Previous project cards must not remain actionable');
    await tick();
    assert.match(d.querySelector('#ap-results').textContent,/Не вдалося завантажити сторінки/);
    w.fetch=normalFetch;
    [...d.querySelectorAll('#ap-results button')].find(node=>node.textContent==='Повторити завантаження').click();
    await tick();
    assert.equal(d.querySelectorAll('.ap-results-error').length,0);
    assert.equal(d.querySelector('#ap-title').textContent,'Второй проект');
    assert.match(d.querySelector('#ap-results').textContent,/Тут з’являться ваші сторінки/);
  }finally{dom.window.close();}
});

test('a stale failed load cannot replace a newer successful visit to the same project', async()=>{
  const {dom,w,document:d}=await workspace();
  try{
    const normalFetch=w.fetch;let rejectOld,hold=true,oldRequestStarted,activeReads=0,maxReads=0;
    const pageRequests=[];
    const started=new Promise(resolve=>{oldRequestStarted=resolve;});
    w.fetch=async url=>{
      const pathname=new URL(String(url),w.location.href).pathname;
      if(!/^\/api\/lifecycle\/projects\/p[12]\/pages$/.test(pathname))return normalFetch(url);
      pageRequests.push(pathname);activeReads++;maxReads=Math.max(maxReads,activeReads);
      try{
        if(pathname==='/api/lifecycle/projects/p1/pages'&&hold){hold=false;return await new Promise((resolve,reject)=>{rejectOld=reject;oldRequestStarted();});}
        return await normalFetch(url);
      }finally{activeReads--;}
    };
    const choose=name=>[...d.querySelectorAll('.ap-project-button')].find(node=>node.getAttribute('aria-label')===name).click();
    choose('Первый проект');await started;
    choose('Второй проект');choose('Первый проект');
    // The reader serializes refreshes: the old dispatched request must settle
    // before the coalesced refresh reads the newest project selection.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(d.querySelectorAll('.ap-page').length,0,'Stale cards stay cleared while the old read is pending');
    assert.equal(pageRequests.length,1,'The newest read waits for the in-flight request');
    rejectOld(Error('Старый запрос'));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(d.querySelectorAll('.ap-page').length,3,'Late failure from earlier visit must be ignored');
    assert.equal(d.querySelector('.ap-results-error'),null);
    assert.deepEqual(pageRequests,['/api/lifecycle/projects/p1/pages','/api/lifecycle/projects/p1/pages'],'Only the newest selection is read after the old request settles');
    assert.equal(maxReads,1,'Project page reads never overlap');
    assert.equal(activeReads,0);
  }finally{dom.window.close();}
});
