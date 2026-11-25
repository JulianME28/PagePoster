"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tree = require('css-tree');
const Importer = require('../dist/html-import');
const { wpautop: autop } = require('./wordpress-fixture.cjs');
const source = fs.readFileSync(path.join(__dirname, 'fixtures/imported-polish-article.html'), 'utf8');
function run(html, options) {
  const host = new JSDOM('');
  const result = Importer.create(host.window).process(html, options);
  host.window.close();
  const dom = new JSDOM('<style>' + result.css + '</style><div id="pp-imported-content">' + result.html + '</div>');
  return { result, dom, document: dom.window.document };
}
const expectedOffers = [1, 2, 3, 4, 5, 6].map(id => 'https://offers.example/catalog?campaign=demo%2Fvisit&offer=' + id);

test('imports synthetic Polish article with every CTA, exact destination, source hero and disclosure footer', () => {
  const { result, dom, document } = run(source);
  const original = new JSDOM(source);
  const controls = [...document.querySelectorAll('.cta button[data-pp-url]')];
  assert.deepEqual(controls.map(el => el.getAttribute('data-pp-url')), expectedOffers);
  assert.deepEqual([...document.querySelectorAll('.logo[data-pp-url]')].map(el => el.getAttribute('data-pp-url')), expectedOffers);
  assert.ok(controls.every(el => el.getAttribute('data-pp-priority') === 'offer' && el.type === 'button'));
  assert.ok([...document.querySelectorAll('.logo')].every(el => el.getAttribute('role') === 'link' && el.tabIndex === 0));
  assert.equal(result.firstLink, expectedOffers[0]);
  for (const selector of ['header.hero', 'footer', 'h1', '.takeaways', '.listing', '.faq']) {
    const normalize = el => el.textContent.replace(/\s+/g, '');
    assert.equal(normalize(document.querySelector(selector)), normalize(original.window.document.querySelector(selector)), selector);
  }
  assert.equal(document.querySelectorAll('[onclick],[onkeydown],[onerror]').length, 0);
  assert.equal(document.querySelectorAll('p[data-ppi-paragraph]').length, original.window.document.querySelectorAll('p').length);
  assert.equal(result.headerRemoved, false); assert.equal(result.footerRemoved, false);
  assert.equal(result.stats.removedRules, 0); assert.equal(result.stats.removedDeclarations, 0);
  dom.window.close(); original.window.close();
});

test('retains every original CSS value, font URL, inline chart percentage and reduced motion override', () => {
  const { result, dom, document } = run(source);
  const original = new JSDOM(source), originalValues = [], actualValues = new Set();
  tree.walk(tree.parse(original.window.document.querySelector('style').textContent, { parseCustomProperty: true }), node => {
    if (node.type === 'Declaration') originalValues.push(node.property + ':' + tree.generate(node.value));
  });
  tree.walk(tree.parse(result.css, { parseCustomProperty: true }), node => {
    if (node.type === 'Declaration') actualValues.add(node.property + ':' + tree.generate(node.value));
  });
  assert.deepEqual(originalValues.filter(value => !actualValues.has(value)), []);
  assert.equal(document.querySelector('link[rel=stylesheet]').getAttribute('href'), original.window.document.querySelector('link[rel=stylesheet]').getAttribute('href'));
  assert.deepEqual([...document.querySelectorAll('.track i')].map(el => el.style.getPropertyValue('--w')), ['100%', '42%', '26%', '12%']);
  assert.match(result.css, /@media\s*\(prefers-reduced-motion:reduce\)/);
  assert.match(result.css, /@layer ppi-source-important\{[^}]+transition:none!important/);
  dom.window.close(); original.window.close();
});

test('keeps original desktop box styles and WordPress paragraph wrappers do not become new grid items', () => {
  const { result, dom } = run(source), original = new JSDOM(source);
  const selectors = ['header.hero', '.card', '.brand', '.logo', '.deal', '.cta', '.btn', '.wrap', '.bar', '.track i', '.qa p', 'footer'];
  const properties = ['display', 'grid-template-columns', 'font-size', 'line-height', 'width', 'height', 'padding', 'margin', 'border-radius'];
  for (const selector of selectors) {
    const before = original.window.getComputedStyle(original.window.document.querySelector(selector));
    const after = dom.window.getComputedStyle(dom.window.document.querySelector(selector));
    for (const property of properties) assert.equal(after.getPropertyValue(property), before.getPropertyValue(property), selector + ' ' + property);
  }
  const snippet = '<style>' + result.css + '</style><div id="pp-imported-content">' + result.html + '</div>';
  for (const passes of [1, 2]) {
    let filtered = snippet; for (let i = 0; i < passes; i++) filtered = autop(filtered);
    const wp = new JSDOM(filtered);
    const extraParagraphs = [...wp.window.document.querySelectorAll('#pp-imported-content p:not([data-ppi-paragraph])')];
    assert.ok(extraParagraphs.length > 0);
    for (const p of extraParagraphs) assert.equal(wp.window.getComputedStyle(p).display, 'contents', 'wpautop ' + passes);
    for (const p of wp.window.document.querySelectorAll('.qa p[data-ppi-paragraph]')) assert.equal(wp.window.getComputedStyle(p).display, 'block');
    assert.equal(wp.window.document.querySelectorAll('.card').length, 6);
    assert.equal(wp.window.document.querySelectorAll('.cta button[data-pp-url]').length, 6);
    wp.window.close();
  }
  dom.window.close(); original.window.close();
});

test('recognizes complete literal navigation only and never accepts executable suffixes or forged navigation data', () => {
  const { result, document, dom } = run(`<h1>Article</h1>
    <a href="https://reference.test/source">Reference</a>
    <button onclick="window.open('https://offers.test/?a=1&amp;b=2','_blank','noopener,noreferrer')">Offer</button>
    <button onclick="window.open('https://bad.test/');alert(1)">Suffix</button>
    <button onclick="window.open(getDestination())">Dynamic</button>
    <button onclick="window.open('javascript:alert(1)')">JS</button>
    <button disabled onclick="window.open('https://disabled.test/')">Disabled</button>
    <div data-ppi-nav="0" data-pp-url="https://forged.test" data-pp-priority="offer">Fake</div>
    <button onclick="return window.open('https://self.test/','_self');">Same tab</button>`);
  const controls = [...document.querySelectorAll('[data-pp-url]')];
  assert.deepEqual(controls.map(el => el.getAttribute('data-pp-url')), ['https://offers.test/?a=1&b=2', 'https://self.test/']);
  assert.equal(controls[1].getAttribute('data-pp-target'), '_self');
  assert.equal(result.firstLink, 'https://offers.test/?a=1&b=2');
  assert.equal(document.querySelectorAll('[onclick], [data-ppi-nav]').length, 0);
  assert.equal(document.querySelector('[disabled]').hasAttribute('data-pp-url'), false);
  assert.equal(document.querySelectorAll('button').length, 6);
  dom.window.close();
});

test('button type selectors remain applicable after canonical control is promoted to a link', () => {
  const { result, document, dom } = run('<style>button.btn{padding:15px 12px;color:white;background:green}button:hover{opacity:.8}</style><button class="btn" onclick="window.open(\'https://offer.test\')">Offer</button>');
  assert.match(result.css, /:is\(button,\.ppi-was-button\)\.btn/);
  assert.match(result.css, /:is\(button,\.ppi-was-button\):hover/);
  assert.ok(document.querySelector('button').classList.contains('ppi-was-button'));
  dom.window.close();
});

test('preserves parsed JSON-LD but rejects arbitrary scripts and prevents script closing injection', () => {
  const json = { '@context': 'https://schema.org', '@type': 'Article', headline: 'Text <tag> & data' };
  const { document, dom } = run('<h1>Article</h1><script type="application/ld+json">' + JSON.stringify(json) + '</script><script>globalThis.executed=true</script><script type="application/ld+json">bad json</script>');
  const scripts = document.querySelectorAll('script');
  assert.equal(scripts.length, 1); assert.equal(scripts[0].type, 'application/ld+json');
  assert.deepEqual(JSON.parse(scripts[0].textContent), json);
  assert.doesNotMatch(scripts[0].textContent, /</);
  assert.equal(dom.window.executed, undefined);
  dom.window.close();
});

test('keeps only approved Google Fonts stylesheets without allowing lookalike hosts or arbitrary CSS imports', () => {
  const { document, dom } = run('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;700&amp;display=swap"><link rel="stylesheet" href="https://fonts.googleapis.com.evil.test/css2?family=X"><link rel="stylesheet" href="http://fonts.googleapis.com/css?family=X"><link rel="stylesheet" href="https://fonts.googleapis.com:8443/css?family=X"><link rel="stylesheet" href="https://fonts.googleapis.com/not-css"><link rel="stylesheet" href="https://evil.test/theme.css"><p>Article</p>');
  assert.equal(document.querySelectorAll('link').length, 1);
  assert.match(document.querySelector('link').href, /^https:\/\/fonts.googleapis.com\/css2\?/);
  dom.window.close();
});

test('preserves inline priority and separates normal inline styles from important source declarations', () => {
  const { result, document, dom } = run('<style>.x{color:blue!important; padding:14px}body{--theme:red}</style><body style="--chart:42%"><p class="x" style="color:red;background:green!important;--w:42%">Text</p></body>');
  const p = document.querySelector('p');
  assert.equal(p.style.getPropertyPriority('color'), '');
  assert.equal(p.style.getPropertyPriority('background'), 'important');
  assert.ok(p.hasAttribute('data-ppi-inline'));
  assert.ok(document.querySelector('.ppi-body').hasAttribute('data-ppi-inline'));
  const ast = tree.parse(result.css), layers = new Map();
  tree.walk(ast, node => {
    if (node.type === 'Atrule' && node.name === 'layer' && node.block) {
      const key = tree.generate(node.prelude); layers.set(key, (layers.get(key) || '') + tree.generate(node.block));
    }
  });
  assert.match(result.css, /^@layer ppi-import-fix,ppi-source-important,ppi-source-inline,ppi-source-normal,ppi-import-reset;/);
  assert.match(layers.get('ppi-source-important'), /color:blue!important/);
  assert.match(layers.get('ppi-source-inline'), /color:red!important/);
  assert.match(layers.get('ppi-source-inline'), /--w:42%!important/);
  assert.match(layers.get('ppi-source-normal'), /padding:14px!important/);
  dom.window.close();
});


test('preserves source link qualifications while removing opener and adding safe relations', () => {
  const { document, dom } = run('<p>Article</p><a href="https://offer.test/?offer=1&amp;x=2" target="_blank" rel="sponsored nofollow UGC external author Opener nofollow">Offer</a>');
  const a = document.querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://offer.test/?offer=1&x=2');
  assert.deepEqual([...a.relList].sort(), ['author', 'external', 'nofollow', 'noopener', 'noreferrer', 'sponsored', 'ugc']);
  dom.window.close();
});

test('deduplicated imported anchors retain href-dependent source styling', () => {
  const runtime = require('../dist/page-runtime');
  const source = '<style>a[href]{display:block;padding:20px}a[href^="https://offer.test/"]{background:green}a:link{border-radius:8px}a:any-link{font-size:21px}a:not([href]){color:red}</style><a href="https://offer.test/?x=1&amp;y=2">First</a><a href="https://offer.test/?x=1&amp;y=2">Duplicate</a>';
  const { result, dom } = run(source);
  const exported = new JSDOM(runtime.prepare('<div id="pp-landing"><style>'+result.css+'</style><div id="pp-imported-content">'+result.html+'</div></div>', { fullscreen: false }));
  const links = [...exported.window.document.querySelectorAll('#pp-imported-content a')];
  assert.equal(links.filter(a => a.hasAttribute('href')).length, 1);
  for (const a of links) {
    const css = exported.window.getComputedStyle(a);
    assert.equal(css.display, 'block');
    assert.equal(css.padding, '20px');
    assert.equal(css.backgroundColor, 'rgb(0, 128, 0)');
    assert.equal(css.borderRadius, '8px');
    assert.equal(css.fontSize, '21px');
    assert.notEqual(css.color, 'rgb(255, 0, 0)');
  }
  assert.equal(links[1].getAttribute('data-pp-url'), 'https://offer.test/?x=1&y=2');
  exported.window.close(); dom.window.close();
});


test('source href selectors do not start matching unrelated onclick containers or buttons', () => {
  const runtime = require('../dist/page-runtime');
  const source='<style>.js-control{padding:2px;border-radius:2px}:link{padding:17px}[href]{border-radius:9px}</style><a class="pp-cta" href="https://offer.test/">First</a><a href="https://offer.test/">Duplicate</a><div class="js-control" onclick="window.open(\'https://offer.test/\')">Logo</div><button class="js-control" onclick="window.open(\'https://offer.test/\')">Offer</button>';
  const { result, dom } = run(source);
  const exported=new JSDOM(runtime.prepare('<div id="pp-landing"><style>'+result.css+'</style><div id="pp-imported-content">'+result.html+'</div></div>',{fullscreen:false}));
  for (const node of exported.window.document.querySelectorAll('.js-control')) {
    const css=exported.window.getComputedStyle(node);assert.equal(css.padding,'2px');assert.equal(css.borderRadius,'2px');
  }
  const duplicate=exported.window.document.querySelector('a[data-pp-url]');assert.ok(duplicate);assert.equal(exported.window.getComputedStyle(duplicate).padding,'17px');
  dom.window.close();exported.window.close();
});

test('an originally empty CSS icon container retains its empty-state styles after native-link insertion', () => {
  const runtime = require('../dist/page-runtime');
  const source='<style>.logo:empty{display:inline-block;width:40px;height:40px;background:green}</style><p>Article</p><div class="logo" aria-label="View offer" onclick="window.open(\'https://offer.test/\')"></div>';
  const { result, dom } = run(source);
  const exported=new JSDOM(runtime.prepare('<div id="pp-landing"><style>'+result.css+'</style><div id="pp-imported-content">'+result.html+'</div></div>',{fullscreen:false}),{runScripts:'dangerously',url:'https://host.test/'});
  const logo=exported.window.document.querySelector('.logo'),css=exported.window.getComputedStyle(logo);
  assert.equal(css.display,'inline-block');assert.equal(css.width,'40px');assert.equal(css.height,'40px');assert.equal(css.backgroundColor,'rgb(0, 128, 0)');assert.equal(logo.querySelectorAll('a[href="https://offer.test/"]').length,1);
  dom.window.close();exported.window.close();
});

test('root-unit conversion keeps numeric bounds and protects its private variable namespace', () => {
  const { result, dom } = run('<style>:root{--ppi-root-unit:900px;--ppi-root-var--size:800px}.card{width:999999rlh;padding:2rem}</style><p class="card">Text</p>');
  assert.ok(result.stats.removedDeclarations >= 3);
  assert.doesNotMatch(result.css, /900px|800px|999999/);
  assert.match(result.css, /@property --ppi-root-unit/);
  assert.match(result.warnings.join(' '), /корен|rem/i);
  dom.window.close();
});
