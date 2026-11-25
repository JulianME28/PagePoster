'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const G = require('../dist/generator.js');
const AI = require('../dist/ai-core.js');
const copy = value => JSON.parse(JSON.stringify(value));
const config = () => G.normalizeConfig(copy(G.DEFAULT_DATA));
const updatesFor = (plan, fn = target => 'Generated: ' + target.field) => plan.targets.map(target => ({ targetId: target.targetId, value: fn(target) }));
const groupFor = (data, pathName) => AI.listGroups(data).find(group => group.paths.includes(pathName));

test('AI schema exposes only editable text fields with generator limits in Node and browser', () => {
  const sandbox = { URL, WeakMap, Map, Set };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/ai-core.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.PagePosterAI.makePlan, 'function');
  assert.equal(AI.fieldLimit('sections.body'), 50000);
  assert.equal(AI.fieldLimit('cards.features'), 4000);
  for (const field of ['author', 'date', 'rating', 'cards.rating', 'cards.url', 'brandUrl', 'brandImage', 'sections.image', 'preset', 'colors', 'mode', '__proto__', 'constructor']) assert.equal(AI.fieldLimit(field), null, field);
  assert.ok(Object.isFrozen(AI.FIELD_LIMITS));
  const data = config(), groups = AI.listGroups(data);
  assert.ok(groups.length > 30);
  assert.equal(new Set(groups.map(group => group.id)).size, groups.length);
  const cardGroup = groupFor(data, 'cards.0.bonus');
  const first = data.cards[0];
  data.cards.reverse();
  assert.equal(groupFor(data, 'cards.4.bonus').id, cardGroup.id);
  assert.equal(data.cards[4], first);
  assert.ok(groups.every(group => group.fields.every(field => AI.fieldLimit(field.field) === field.maxLength)));
});

test('plans select exact groups and field paths, and empty mode skips manual content', () => {
  const data = config(); data.title = ''; data.intro = 'Written manually';
  const group = groupFor(data, 'title');
  const empty = AI.makePlan(data, { groupIds: [group.id], mode: 'empty' });
  assert.deepEqual(empty.targets.map(target => target.field), ['title']);
  const selected = AI.makePlan(data, { groupIds: [group.id], paths: ['intro'], mode: 'selected' });
  assert.deepEqual(selected.targets.map(target => target.field), ['intro']);
  assert.equal(selected.targets[0].currentValue, 'Written manually');
  assert.equal(AI.makePlan(data, { groupIds: [], mode: 'selected' }).targets.length, 0);
  assert.throws(() => AI.makePlan(data, { groupIds: ['missing'], mode: 'selected' }), /груп/i);
  assert.throws(() => AI.makePlan(data, { mode: 'anything' }), /режим/i);
  assert.throws(() => AI.makePlan(data, { paths: ['brandUrl'] }), /пол/i);
  const serialized = JSON.parse(JSON.stringify(selected));
  assert.deepEqual(Object.keys(serialized.targets[0]).sort(), ['allowedLinks', 'context', 'currentValue', 'field', 'fieldPath', 'label', 'maxLength', 'targetId']);
  assert.equal(typeof serialized.targets[0].context.groupId, 'string');
  assert.ok(!JSON.stringify(serialized).includes('NOVA PLAY'));
});

test('AI updates reject unknown, duplicate, missing, non-string, oversized or extra fields before mutation', () => {
  const data = config();
  const plan = AI.makePlan(data, { groupIds: [groupFor(data, 'title').id], mode: 'selected' });
  const valid = updatesFor(plan), before = copy(data);
  const badSets = [
    [...valid, { targetId: 'unknown', value: 'bad' }],
    valid.map((item, index) => index ? { ...item, targetId: valid[0].targetId } : item),
    valid.slice(1),
    valid.map((item, index) => index ? item : { ...item, value: 42 }),
    valid.map((item, index) => index ? item : { ...item, value: 'x'.repeat(plan.targets[0].maxLength + 1) }),
    valid.map((item, index) => index ? item : { ...item, url: 'https://evil.test/' }),
    { updates: valid }
  ];
  for (const updates of badSets) {
    assert.throws(() => AI.apply(plan, data, updates));
    assert.deepEqual(data, before);
  }
  assert.deepEqual(AI.validateUpdates(plan, valid), valid);
  assert.throws(() => AI.apply(JSON.parse(JSON.stringify(plan)), data, valid), /план/i);
});

test('merge keeps manual edits, survives reordering and skips deleted or replaced row objects', () => {
  const data = config();
  const original = data.cards[0], second = data.cards[1], third = data.cards[2]; original.note='';
  const groups = [0, 1, 2].map(index => groupFor(data, 'cards.' + index + '.button').id);
  const plan = AI.makePlan(data, { groupIds: groups, paths: ['cards.0.button', 'cards.0.note', 'cards.1.button', 'cards.2.button'], mode: 'selected' });
  original.note = 'Manual new note';
  data.cards.reverse();
  data.cards.splice(data.cards.indexOf(second), 1);
  data.cards[data.cards.indexOf(third)] = { ...third };
  const result = AI.apply(plan, data, updatesFor(plan, () => 'AI text'));
  assert.equal(original.note, 'Manual new note');
  assert.equal(original.button, 'AI text');
  assert.equal(second.button, 'VIEW OFFER');
  assert.equal(result.applied, 1);
  assert.equal(result.conflicts, 3);
  assert.equal(result.patches[0].path, 'cards.3.button');
  assert.equal(result.patches[0].after, 'AI text');
});

test('empty mode rechecks emptiness, blank output never clears, and replacement configs cannot receive stale plans', () => {
  const data = config(); data.title = ' '; data.intro = '';
  const plan = AI.makePlan(data, { groupIds: [groupFor(data, 'title').id], mode: 'empty' });
  data.title = 'Manual title while waiting';
  const result = AI.apply(plan, data, updatesFor(plan, () => '   '));
  assert.equal(data.title, 'Manual title while waiting');
  assert.equal(data.intro, '');
  assert.equal(result.applied, 0);
  assert.equal(result.emptySkipped, 1);
  assert.equal(result.conflicts, 1);
  const replacement = copy(data), freshPlan = AI.makePlan(data, { paths: ['title'], mode: 'selected' });
  const stale = AI.apply(freshPlan, replacement, updatesFor(freshPlan));
  assert.equal(stale.conflicts, 1);
  assert.equal(replacement.title, data.title);
  const same = AI.makePlan(data, { paths: ['title'], mode: 'selected' });
  assert.equal(AI.apply(same, data, updatesFor(same, target => target.currentValue)).unchanged, 1);
});

test('public target tampering cannot grant writes to protected values or relax length bounds', () => {
  const data = config(), plan = AI.makePlan(data, { paths: ['title'], mode: 'selected' });
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.targets[0]));
  assert.throws(() => { plan.targets[0].field = 'brandUrl'; }, TypeError);
  assert.throws(() => { plan.targets[0].maxLength = 100000; }, TypeError);
  const originalUrl = data.brandUrl;
  AI.apply(plan, data, updatesFor(plan, () => '<script>literal text</script>'));
  assert.equal(data.title, '<script>literal text</script>');
  assert.equal(data.brandUrl, originalUrl);
  assert.ok(!G.renderSnippet(data).includes('<script>literal text</script>'));
});

test('new project preserves design while clearing demo text, images, ratings, authors, and menu URLs', () => {
  const existing = config(); existing.preset = 'rose'; existing.mode = 'inline'; existing.showToc = false; existing.chromeMode = 'overlay-only';
  existing.colors.accent = '#123456';
  const before = copy(existing);
  const url = 'https://Example.COM/path?ref=one%20two&campaign=A#offer';
  const project = AI.createProject(existing, 'My Brand | ' + url + '\nhttps://second.example/sale');
  assert.deepEqual(existing, before);
  assert.equal(project.preset, 'rose'); assert.equal(project.mode, 'inline'); assert.equal(project.showToc, false); assert.equal(project.chromeMode, 'overlay-only');
  assert.deepEqual(project.colors, existing.colors); assert.notEqual(project.colors, existing.colors);
  assert.equal(project.cards.length, 2); assert.equal(project.moreCards.length, 0);
  assert.equal(project.cards[0].name, 'My Brand'); assert.equal(project.cards[0].url, url);
  assert.equal(project.cards[1].name, 'second.example');
  assert.equal(project.brandUrl, ''); assert.equal(project.author, ''); assert.equal(project.date, '');
  assert.equal(project.title, ''); assert.equal(project.brand, ''); assert.equal(project.footer, '');
  assert.equal(project.sections.length, 8); assert.equal(project.faq.length, 5);
  assert.equal(project.tiles.length, 4); assert.equal(project.services.length, 4); assert.equal(project.reviews.length, 2);
  assert.deepEqual(project.navLinks, []);
  for (const row of project.cards.concat(project.moreCards)) assert.equal(row.rating, '');
  for (const collection of ['cards', 'moreCards', 'sections', 'tiles', 'services', 'reviews']) for (const row of project[collection]) assert.equal(row.image, '');
  assert.equal(project.sections[0].body, ''); assert.equal(project.reviews[0].body, '');
  assert.ok(!JSON.stringify(project).includes('NORTHSTAR')); assert.ok(!JSON.stringify(project).includes('NOVA PLAY'));
  assert.deepEqual(G.normalizeConfig(project), project);
});

test('project creation validates all link lines, preserves tracking strings and maps every accepted destination', () => {
  for (const text of ['', 'javascript:alert(1)', 'Brand | /relative', 'https://valid.test/\nnot-a-url', 'https://white space.test/', 'https://u:p@example.test/', Array.from({length: 21}, (_, i) => 'https://site' + i + '.test/').join('\n')]) assert.throws(() => AI.createProject(config(), text), /посилан|URL|адрес|20|ряд/i, text);
  const links = Array.from({length: 20}, (_, i) => 'https://site' + i + '.test/?a=1&b=2#x');
  const project = AI.createProject(config(), links.join('\n'));
  assert.equal(project.cards.length, 5); assert.equal(project.moreCards.length, 15);
  assert.equal(project.reviews.length, 8);
  assert.ok(project.tiles.concat(project.services).every(row => row.url === ''));
  const destinations = new Set(project.cards.concat(project.moreCards).map(row => row.url));
  assert.ok(links.every(url => destinations.has(url)));
});


test('AI application cannot expand exported URLs or silently remove manual links', () => {
  const data=AI.createProject(G.DEFAULT_DATA,'Offer | https://example.com/?offer=1669');
  data.sections[0].body='Manual [reference](https://reference.example/(guide)?a=%2F&b=2#info).';
  const before=copy(data), expected=['https://example.com/?offer=1669','https://reference.example/(guide)?a=%2F&b=2#info'];
  const plan=AI.makePlan(data,{mode:'selected',paths:['intro','sections.0.body']});
  for (const body of [
    'Read [more](https://unprovided.example/extra).',
    '![more](https://unprovided.example/(extra)?x=1&y=2)',
    'New text without the manual reference.',
    'Manual [reference](https://reference.example/(guide)?a=%2F&b=3#info).'
  ]) {
    assert.throws(()=>AI.apply(plan,data,updatesFor(plan,target=>target.field==='intro'?'An otherwise valid introduction.':body)),/посилан/i);
    assert.deepEqual(data,before,'validation must finish before any field mutates');
    assert.deepEqual(G.analyzeLinks(data).urls,expected);
  }
  const accepted='Updated [reference](https://reference.example/(guide)?a=%2F&b=2#info), with [options] (where available).';
  AI.apply(plan,data,updatesFor(plan,target=>target.field==='intro'?'A new introduction.':accepted));
  assert.equal(data.sections[0].body,accepted);
  assert.deepEqual(G.analyzeLinks(data).urls,expected);
  const blank=AI.makePlan(data,{mode:'selected',paths:['sections.0.body']});
  AI.apply(blank,data,updatesFor(blank,()=>''));
  assert.equal(data.sections[0].body,accepted);
});


test('AI link guards follow exported Markdown semantics without banning ordinary punctuation', async () => {
  const api=await import('../server/ai.mjs');
  const cases=[
    ['**[bold](https://unprovided.example/a)**',true],
    ['[**label**](http://unprovided.example/(a)?x=1&y=%2F#top)',true],
    ['\\[escaped label](HTTPS://unprovided.example/a)',true],
    ['[Entity query](https://unprovided.example/?x=1&amp;y=2)',true],
    ['## [Heading](https://unprovided.example/a)\n\n- [List](https://unprovided.example/b)',true],
    ['[unclosed](broken(\n\n[Real](https://unprovided.example/a)',true],
    ['[relative](//unprovided.example/a)',false],
    ['[encoded scheme](https&#58;//unprovided.example/a)',false],
    ['[spaces](https://unprovided.example/a b)',false],
    ['[unsafe](javascript:alert(1))',false],
    ['<a href="https://unprovided.example/a">literal HTML</a>',false],
    ['Plain https://unprovided.example/a, [options] (where available), **bold**.',false]
  ];
  for (const [body,createsLink] of cases) {
    const data=AI.createProject(G.DEFAULT_DATA,'Offer | https://example.com/?offer=1669');
    const plan=AI.makePlan(data,{paths:['sections.0.body']});
    const updates=updatesFor(plan,()=>body);
    const rendered=copy(data);rendered.sections[0].body=body;
    assert.equal(G.analyzeLinks(rendered).uniqueCount>1,createsLink,'rendered fixture: '+body);
    const input=api.validateInput({requestId:'markdown-parity',brief:{},targets:plan.targets});
    const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({updates,notes:[]})}]}]};
    if(createsLink || /https?:\/\//i.test(body)) {
      assert.throws(()=>AI.apply(plan,data,updates),/посилан/i,body);
      assert.throws(()=>api.parseModelResponse(response,input),/посилан/i,body);
    } else {
      AI.apply(plan,data,updates);
      assert.deepEqual(api.parseModelResponse(response,input).updates,updates);
    }
    assert.deepEqual(G.analyzeLinks(data).urls,['https://example.com/?offer=1669']);
  }
});

test('new AI project includes normalized independent link defaults and preserves finite font/design values',()=>{
  const existing=config();existing.fontFamily='Trebuchet MS';existing.designVariant={version:1,seed:'manual-seed',sequence:4,paletteId:'palette-3'};existing.footerBrandUrl='https://old-footer.test/';existing.cards[0].logoUrl='https://old-logo.test/';const next=AI.createProject(existing,'Name | https://exact.test/?offer=1&x=%2F');
  assert.equal(next.cards[0].logoUrl,'');assert.equal(next.footerBrandUrl,'');assert.equal(next.fontFamily,'Trebuchet MS');assert.deepEqual(next.designVariant,existing.designVariant);assert.notEqual(next.designVariant,existing.designVariant);assert.deepEqual(G.normalizeConfig(next),next);assert.equal(AI.createProject({...existing,fontFamily:'unsafe;font:bad'},'https://one.test/').fontFamily,'Arial');
});


test('new AI projects normalize chrome defaults without accepting unknown modes',()=>{
  for(const chromeMode of [undefined,'custom','unexpected',null]){const next=AI.createProject({...config(),chromeMode},'https://exact.example/?x=%2f&y=%2F');assert.equal(next.chromeMode,'custom');assert.deepEqual(G.normalizeConfig(next),next);}
});
