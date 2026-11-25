'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const modulePath = path.join(__dirname, '../dist/campaign-ui.js');
const core = require('../dist/ai-core.js');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(extra = {}) {
  assert.ok(fs.existsSync(modulePath), 'Campaign screen must exist');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4317/' });
  dom.window.PagePosterAI = core;
  const root = dom.window.document.getElementById('root');
  const config = extra.config || { contentMode: 'builder', brand: 'Manual brand', brandUrl: 'https://brand.test/?x=%2f', footerBrandUrl: 'https://footer.test/?q=a+b', title: 'Manual title', intro: '', cards: [{ name: 'Exact offer', image: 'https://img.test/a.png', bonus: 'Verified bonus', rating: '4.7', url: 'https://offer.test/?x=%2F&x=1#top', logoUrl: 'https://logo.test/?x=%2F' }], sections: [{ title: 'Manual section', body: '' }] };
  const calls = [], campaigns = [], changes = [], snapshots = [], opened = [];
  const options = { element: root, project: { id: 'project-1', name: 'Project', language: 'Українська', country: 'Україна' }, sites: extra.sites || [{ id: 'site-1', name: 'Ready', enabled: true, status: 'ok', hasCredential: true }],
    getEditorSnapshot: () => config,
    createPageSnapshot: input => { snapshots.push(input); return { config, title: 'Prepared', uniqueUrls: 1 }; },
    fetchImpl: async () => ({ ok: true, json: async () => ({ configured: extra.configured !== false }) }),
    request: async (url, method = 'GET', body) => {
      const call = { url, method, body: body === undefined ? undefined : structuredClone(body) }; calls.push(call);
      if (extra.route) { const result = await extra.route(call, campaigns); if (result !== undefined) return result; }
      if (method === 'GET') return { campaigns: structuredClone(campaigns) };
      if (/\/(pause|resume)$/.test(url)) { campaigns[0].state = url.endsWith('/pause') ? 'paused' : 'queued'; return { campaign: structuredClone(campaigns[0]) }; }
      const campaign = { id: 'campaign-' + (campaigns.length + 1), projectId: 'project-1', idempotencyKey: body.idempotencyKey, name: body.name, state: 'queued', status: body.status, items: [{ pageId: 'page-1', siteId: body.siteIds[0] || null, topic: body.topics[0], state: 'queued', stage: 'queued', fullUrl: '', errorCode: null }], counts: { total: body.topics.length * (body.siteIds.length || 1), queued: 1 } };
      campaigns.push(campaign); return { campaign: structuredClone(campaign) };
    }, onChanged: value => changes.push(value), openEditor: panel => opened.push(panel), openPage: id => opened.push(id) };
  const ui = require(modulePath).create(options);
  function value(name, value) { const control = root.querySelector('[name="' + name + '"]'); assert.ok(control, name); control.value = value; control.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }
  async function click(action) { const node = root.querySelector('[data-campaign-action="' + action + '"]'); assert.ok(node, action); node.click(); await tick(); }
  async function prepare() { value('topics', 'Тема один\nТема два'); value('source', 'editor'); await click('prepare'); }
  async function submit() { root.querySelector('[data-campaign-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await tick(); }
  return { dom, root, config, options, ui, calls, campaigns, changes, snapshots, opened, value, click, prepare, submit, close() { ui.destroy(); dom.window.close(); } };
}

test('preparation is local and manual facts and exact addresses survive a review launch without sites', async () => {
  const h = fixture(); try {
    await h.ui.refresh(); await h.prepare(); assert.equal(h.calls.filter(c => c.method === 'POST').length, 0);
    h.value('mode', 'manual'); h.value('instructions', 'Keep my words.'); await h.submit();
    const sent = h.calls.find(c => c.method === 'POST');
    assert.equal(sent.url, '/projects/project-1/campaigns'); assert.deepEqual(sent.body.config, h.config);
    assert.deepEqual(sent.body.siteIds, []); assert.deepEqual(sent.body.topics, ['Тема один', 'Тема два']);
    assert.equal(sent.body.mode, 'manual'); assert.equal(sent.body.status, 'review');
    assert.deepEqual(sent.body.brief, { language: 'Українська', country: 'Україна', instructions: 'Keep my words.' });
    assert.deepEqual(Object.keys(sent.body).sort(), ['idempotencyKey','name','topics','siteIds','status','config','mode','paths','brief','linkInsertions','varyDesign'].sort());
    assert.match(sent.body.idempotencyKey, /^[a-f0-9-]{36}$/); assert.ok(h.changes.length);
  } finally { h.close(); }
});
test('new preparation passes exact inputs and edits a copy of offer facts', async () => {
  const h = fixture(); try {
    await h.ui.refresh(); h.value('topics', 'First\nSecond'); h.value('links', 'Exact | https://offer.test/?x=%2F&x=1'); h.value('cardCount', '10'); await h.click('prepare');
    assert.deepEqual(h.snapshots[0], { keyword: 'First', links: 'Exact | https://offer.test/?x=%2F&x=1', cardCount: 10 });
    h.value('fact:cards.0.bonus', 'Updated verified bonus'); await h.submit();
    assert.equal(h.calls.find(c => c.method === 'POST').body.config.cards[0].bonus, 'Updated verified bonus');
    assert.equal(h.config.cards[0].bonus, 'Verified bonus');
    assert.equal(h.root.querySelector('[data-campaign-path="cards.0.bonus"]'), null);
    assert.equal(h.root.querySelector('[data-campaign-path="cards.0.name"]'), null);
  } finally { h.close(); }
});
test('one launch locks further submissions and shows topic by site total', async () => {
  const wait = deferred(); const h = fixture({ route: call => call.method === 'POST' ? wait.promise : undefined }); try {
    await h.ui.refresh(); await h.prepare(); h.value('status', 'publish'); h.root.querySelector('[data-campaign-site="site-1"]').click();
    assert.match(h.root.querySelector('[data-campaign-summary]').textContent, /2.*1.*2/);
    h.root.querySelector('[data-campaign-action="launch"]').click(); await h.submit();
    assert.equal(h.calls.filter(c => c.method === 'POST').length, 1); assert.equal(h.root.querySelector('[data-campaign-action="launch"]').disabled, true);
    wait.resolve({ campaign: { id: 'accepted', projectId: 'project-1', idempotencyKey: h.calls.find(c => c.method === 'POST').body.idempotencyKey, state: 'queued', items: [] } }); await tick();
  } finally { h.close(); }
});
test('unready, disabled and credential-free sites cannot be submitted; page limit is 20', async () => {
  const h = fixture({ sites: [{ id: 'bad', name: 'Bad', status: 'pending', hasCredential: true }, { id: 'off', name: 'Off', enabled: false, status: 'ready', hasCredential: true }, { id: 'no-key', name: 'No key', status: 'ok' }, { id: 'good', name: 'Good', status: 'ready', enabled: true, hasCredential: true }] }); try {
    await h.ui.refresh(); await h.prepare(); h.value('status', 'publish');
    for (const id of ['bad','off','no-key']) assert.equal(h.root.querySelector('[data-campaign-site="' + id + '"]').disabled, true);
    await h.submit(); assert.equal(h.calls.some(c => c.method === 'POST'), false);
    h.root.querySelector('[data-campaign-site="good"]').click(); h.value('topics', Array.from({length:21}, (_,i) => 'Topic '+i).join('\n')); await h.submit();
    assert.equal(h.calls.some(c => c.method === 'POST'), false); assert.match(h.root.textContent, /20/);
  } finally { h.close(); }
});
test('unknown outcome rehydrates without POST and explicit retry reuses immutable body', async () => {
  let posts = 0; const h = fixture({ route: call => { if (call.method === 'POST' && ++posts === 1) throw {code:'network_error'}; } }); let second;
  try {
    await h.ui.refresh(); await h.prepare(); h.value('instructions','Original'); await h.submit(); const first = h.calls.find(c => c.method === 'POST').body;
    h.ui.destroy(); second = require(modulePath).create(h.options); await second.refresh(); assert.equal(posts,1);
    assert.equal(h.root.querySelector('[data-campaign-action="launch"]').disabled,true); h.root.querySelector('[name="instructions"]').value='Tampered'; await h.click('retry');
    const sent=h.calls.filter(c=>c.method==='POST'); assert.equal(sent.length,2); assert.deepEqual(sent[1].body,first);
  } finally { second?.destroy(); h.close(); }
});
test('reconciliation finds accepted campaign and never repeats POST', async () => {
  const h=fixture({route:(call,campaigns)=>{if(call.method==='POST'){campaigns.push({id:'accepted',projectId:'project-1',idempotencyKey:call.body.idempotencyKey,state:'running',items:[]});throw {code:'network_error'};}}}); try {
    await h.ui.refresh(); await h.prepare(); await h.submit(); await h.click('retry');
    assert.equal(h.calls.filter(c=>c.method==='POST').length,1); assert.match(h.root.textContent,/Виконується/);
  } finally {h.close();}
});
test('known rejection allows corrected request with fresh identity',async()=>{
  let posts=0;const h=fixture({route:call=>{if(call.method==='POST'&&++posts===1)throw {status:422,code:'VALIDATION'};}});try{
    await h.ui.refresh();await h.prepare();await h.submit();assert.equal(h.root.querySelector('[data-campaign-action="launch"]').disabled,false);
    h.value('instructions','Corrected');await h.submit();const sent=h.calls.filter(c=>c.method==='POST');assert.equal(sent.length,2);assert.notEqual(sent[0].body.idempotencyKey,sent[1].body.idempotencyKey);
  }finally{h.close();}
});
test('exact anchors preserve encoded URLs in eligible text fields',async()=>{
  const h=fixture();try{
    await h.ui.refresh();await h.prepare();h.value('linkField','sections.0.body');h.value('linkUrl','https://exact.test/(a)?x=%2F&x=1#top');h.value('linkAnchor','Exact [anchor] & текст');h.value('linkCount','2');await h.click('add-link');await h.submit();
    const body=h.calls.find(c=>c.method==='POST').body;assert.equal(body.linkInsertions.length,1);assert.equal(body.linkInsertions[0].url,'https://exact.test/(a)?x=%2F&x=1#top');assert.equal(body.linkInsertions[0].anchor,'Exact [anchor] & текст');assert.equal(body.linkInsertions[0].count,2);assert.ok(body.paths.includes('sections.0.body'));assert.equal(body.config.title,'Manual title');
  }finally{h.close();}
});
test('HTML is preserved with AI and design variation disabled',async()=>{
  const config={contentMode:'html',importHtml:'<main><a href="https://exact.test/?x=%2F">Exact</a></main>',title:'Manual'};const h=fixture({config});try{
    await h.ui.refresh();await h.prepare();assert.equal(h.root.querySelector('[name="varyDesign"]').disabled,true);await h.submit();
    const body=h.calls.find(c=>c.method==='POST').body;assert.deepEqual(body.config,config);assert.equal(body.mode,'manual');assert.equal(body.varyDesign,false);assert.deepEqual(body.paths,[]);
  }finally{h.close();}
});
test('missing key offers settings while manual mode works without a key',async()=>{
  const h=fixture({configured:false});try{
    await h.ui.refresh();await h.prepare();await h.submit();assert.equal(h.calls.some(c=>c.method==='POST'),false);await h.click('connect');assert.deepEqual(h.opened,['ai']);h.value('mode','manual');await h.submit();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.root.querySelector('input[type="password"]'),null);
  }finally{h.close();}
});
test('controls have accessible labels and authored text is not interpreted as HTML',async()=>{
  const h=fixture();try{
    await h.ui.refresh();await h.prepare();h.value('fact:cards.0.name','<img src=x onerror=alert(1)>');h.value('mode','selected');
    for(const input of h.root.querySelectorAll('input,textarea,select'))assert.ok(input.labels.length||input.getAttribute('aria-label'),input.outerHTML);assert.equal(h.root.querySelector('img'),null);
  }finally{h.close();}
});
test('late response cannot touch a replacement screen or notify after destroy',async()=>{
  const slow=deferred();const h=fixture({route:call=>call.method==='POST'?slow.promise:undefined});try{
    await h.ui.refresh();await h.prepare();await h.submit();const sent=h.calls.find(c=>c.method==='POST').body;h.ui.destroy();h.root.textContent='Other project';slow.resolve({campaign:{id:'late',projectId:'project-1',idempotencyKey:sent.idempotencyKey,state:'queued',items:[]}});await tick();assert.equal(h.root.textContent,'Other project');assert.equal(h.changes.length,0);
  }finally{h.close();}
});
test('pause and resume show result URLs and preserve entered topics',async()=>{
  const h=fixture();try{
    await h.ui.refresh();await h.prepare();await h.submit();h.campaigns[0].items[0]={pageId:'page-1',topic:'Тема один',siteId:'site-1',state:'published',stage:'published',fullUrl:'https://site.test/exact/?x=%2F',errorCode:null};await h.ui.refresh();assert.equal(h.root.querySelector('a[href="https://site.test/exact/?x=%2F"]').textContent,'https://site.test/exact/?x=%2F');await h.click('open-page');assert.deepEqual(h.opened,['page-1']);await h.click('pause');assert.match(h.root.textContent,/Призупинено/);await h.click('resume');assert.ok(h.calls.some(c=>c.url==='/campaigns/campaign-1/pause'));assert.ok(h.calls.some(c=>c.url==='/campaigns/campaign-1/resume'));assert.equal(h.root.querySelector('[name="topics"]').value,'Тема один\nТема два');
  }finally{h.close();}
});
test('storage failure prevents dispatch before recovery identity is persisted',async()=>{
  const h=fixture();try{
    await h.ui.refresh();await h.prepare();Object.defineProperty(h.dom.window.Storage.prototype,'setItem',{configurable:true,value(){throw Error('Full');}});await h.submit();assert.equal(h.calls.some(c=>c.method==='POST'),false);assert.match(h.root.textContent,/сховищ|ключ/);
  }finally{h.close();}
});


test('unfinished form survives editor navigation with prepared edits and selected fields',async()=>{
  const h=fixture();let second;try{
    await h.ui.refresh();await h.prepare();h.value('instructions','Retain this brief');h.value('fact:cards.0.bonus','Checked edit');h.value('mode','selected');h.root.querySelector('[data-campaign-path="title"]').click();h.root.querySelector('[data-campaign-site="site-1"]').click();h.ui.destroy();second=require(modulePath).create(h.options);await second.refresh();
    assert.equal(h.root.querySelector('[name="instructions"]').value,'Retain this brief');assert.equal(h.root.querySelector('[name="fact:cards.0.bonus"]').value,'Checked edit');assert.equal(h.root.querySelector('[data-campaign-path="title"]').checked,true);assert.equal(h.root.querySelector('[data-campaign-site="site-1"]').checked,true);assert.equal(h.calls.some(c=>c.method==='POST'),false);await h.submit();assert.equal(h.calls.find(c=>c.method==='POST').body.config.cards[0].bonus,'Checked edit');
  }finally{second?.destroy();h.close();}
});
test('editing source inputs requires fresh preparation before launch',async()=>{
  const h=fixture();try{
    await h.ui.refresh();h.value('topics','Topic');h.value('links','A | https://one.test/');await h.click('prepare');h.value('links','B | https://two.test/');await h.submit();assert.equal(h.calls.some(c=>c.method==='POST'),false);assert.equal(h.root.querySelector('[data-campaign-action="launch"]').disabled,true);await h.click('prepare');await h.submit();assert.equal(h.snapshots[1].links,'B | https://two.test/');assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  }finally{h.close();}
});
test('manual mode retains existing link registry only inside unchanged config',async()=>{
  const registry=[{id:'keep',fieldPath:'sections.0.body',url:'https://keep.test/?x=%2F',anchor:'Keep',count:1}];const h=fixture({config:{title:'Title',cards:[],sections:[{title:'S',body:'[[PP_LINK:keep]]'}],faq:[],aiLinkInsertions:registry}});try{
    await h.ui.refresh();await h.prepare();h.value('mode','manual');await h.submit();const body=h.calls.find(c=>c.method==='POST').body;assert.deepEqual(body.linkInsertions,[]);assert.deepEqual(body.config.aiLinkInsertions,registry);assert.equal(body.config.sections[0].body,'[[PP_LINK:keep]]');
  }finally{h.close();}
});
test('new preparation rejects unsupported card count above 20 without invoking creation',async()=>{
  const h=fixture();try{await h.ui.refresh();h.value('topics','Topic');h.value('cardCount','21');await h.click('prepare');assert.equal(h.snapshots.length,0);assert.match(h.root.textContent,/20/);}finally{h.close();}
});
test('server generation and publication stages display meaningful Ukrainian text',async()=>{
  const h=fixture();try{
    h.campaigns.push({id:'c',projectId:'project-1',state:'running',items:[{topic:'One',stage:'generation',state:'running'},{topic:'Two',stage:'publication',state:'running'},{topic:'Three',stage:'saved',state:'published'}]});await h.ui.refresh();assert.match(h.root.textContent,/Створення текстів/);assert.match(h.root.textContent,/Запис у WordPress/);assert.match(h.root.textContent,/Збережено/);
  }finally{h.close();}
});


test('an older list response cannot erase a newly accepted campaign',async()=>{
  const stale=deferred();let gets=0;const h=fixture({route:call=>call.method==='GET'&&++gets===2?stale.promise:undefined});try{
    await h.ui.refresh();await h.prepare();const reading=h.ui.refresh();await h.submit();stale.resolve({campaigns:[]});await reading;assert.match(h.root.textContent,/У черзі/);assert.equal(h.root.querySelector('[data-campaign-action="refresh"]').disabled,false);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  }finally{h.close();}
});


function manualClock(win) {
  let next = 0; const tasks = new Map();
  win.setTimeout = (callback, delay) => { const id = ++next; tasks.set(id, { callback, delay }); return id; };
  win.clearTimeout = id => tasks.delete(id);
  return {
    tasks,
    fire() { assert.equal(tasks.size, 1, 'Only one poll should be scheduled'); const [id, job] = tasks.entries().next().value; tasks.delete(id); job.callback(); return job.delay; },
    delay() { assert.equal(tasks.size, 1, 'Active campaign should keep a scheduled poll'); return tasks.values().next().value.delay; }
  };
}
test('visible campaigns poll beyond 60 checks with capped backoff and reset only on real progress', async () => {
  const h = fixture(); const clock = manualClock(h.dom.window); try {
    Object.defineProperty(h.dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
    const campaign = { id: 'long', projectId: 'project-1', state: 'running', updatedAt: 'initial', counts: { total: 20, running: 1, queued: 19 }, items: [{ pageId: 'p1', state: 'running', stage: 'generation' }] };
    h.campaigns.push(campaign); await h.ui.refresh(); assert.equal(clock.delay(), 5000);
    for (let i = 0; i < 65; i++) {
      campaign.updatedAt = String(i); clock.fire(); await tick();
      assert.equal(clock.delay(), i === 0 ? 10000 : 30000);
    }
    assert.equal(h.calls.filter(c => c.method === 'GET').length, 66);
    campaign.items[0].stage = 'publication'; clock.fire(); await tick(); assert.equal(clock.delay(), 5000);
    campaign.state = 'completed'; campaign.counts = { total: 20, published: 20 }; campaign.items[0].state = 'published'; campaign.items[0].stage = 'saved';
    clock.fire(); await tick(); assert.equal(clock.tasks.size, 0);
  } finally { h.close(); }
});
test('polling suspends while hidden, resumes when visible and coalesces outstanding reads', async () => {
  const slow = deferred(); let gets = 0;
  const h = fixture({ route: call => call.method === 'GET' && ++gets === 2 ? slow.promise : undefined }); const clock = manualClock(h.dom.window); try {
    const doc = h.dom.window.document;
    Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' });
    h.campaigns.push({ id: 'long', projectId: 'project-1', state: 'running', items: [] });
    await h.ui.refresh(); assert.equal(clock.delay(), 5000);
    Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'hidden' }); doc.dispatchEvent(new h.dom.window.Event('visibilitychange')); assert.equal(clock.tasks.size, 0);
    Object.defineProperty(doc, 'visibilityState', { configurable: true, value: 'visible' }); doc.dispatchEvent(new h.dom.window.Event('visibilitychange')); assert.equal(clock.delay(), 5000);
    clock.fire(); await tick(); const repeat = h.ui.refresh(); await tick(); assert.equal(gets, 2); assert.equal(clock.tasks.size, 0);
    slow.resolve({ campaigns: structuredClone(h.campaigns) }); await repeat; await tick(); assert.equal(clock.delay(), 10000);
    h.ui.destroy(); assert.equal(clock.tasks.size, 0); doc.dispatchEvent(new h.dom.window.Event('visibilitychange')); assert.equal(clock.tasks.size, 0);
  } finally { h.close(); }
});
test('saved result rows identify published, draft and review outcomes separately', async () => {
  const h = fixture(); try {
    h.campaigns.push({ id: 'done', projectId: 'project-1', state: 'completed', items: [{ topic: 'Published', stage: 'saved', state: 'published' }, { topic: 'Draft', stage: 'saved', state: 'draft' }, { topic: 'Review', stage: 'saved', state: 'review' }] });
    await h.ui.refresh(); const rows = [...h.root.querySelectorAll('.pp-campaign-item')];
    assert.match(rows[0].textContent, /Опубліковано/); assert.match(rows[1].textContent, /Чернетка WordPress/); assert.match(rows[2].textContent, /Готово до перегляду/);
  } finally { h.close(); }
});



test('campaign navigation exposes one compact step and focuses its content for keyboard users',async()=>{
 const h=fixture();try{await h.ui.refresh();assert.equal(h.root.querySelector('[data-campaign-step=source]').hidden,false);await h.prepare();assert.equal(h.root.querySelector('[data-campaign-step=source]').hidden,true);assert.equal(h.root.querySelector('[data-campaign-step=content]').hidden,false);await h.click('step-launch');assert.equal(h.root.querySelector('[data-campaign-step=launch]').hidden,false);assert.equal(h.dom.window.document.activeElement,h.root.querySelector('[data-campaign-step=launch]'));assert.equal(h.root.querySelector('[data-campaign-step=content]').hidden,true);}finally{h.close();}
});
