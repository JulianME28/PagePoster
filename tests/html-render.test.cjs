"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { wpautop } = require('./wordpress-fixture.cjs');
const dist = path.join(__dirname, '../dist');
const core = require('../dist/generator.js');
function runtime(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://editor.example/' });
  for (const name of ['purify.min.js', 'csstree.js', 'html-import.js', 'page-runtime.js', 'generator.js']) dom.window.eval(fs.readFileSync(path.join(dist, name), 'utf8'));
  t.after(() => dom.window.close());
  return { window: dom.window, api: dom.window.PagePoster };
}
function config(html, extra = {}) {
  return { version: 1, contentMode: 'html', importHtml: html, importBaseUrl: 'https://source.example/guides/page.html', importReplaceHeader: false, importReplaceFooter: false,
    title: 'Builder title must not leak', intro: 'Builder introduction must not leak', brand: 'Imported Guide', brandTagline: '', brandUrl: '', footer: 'Generated footer copy', footerTitle: 'About this guide', footerNote: '',
    cards: [{ name: 'DEMO CARD MUST NOT LEAK', url: 'https://demo.invalid/offer' }], sections: [{ title: 'DEMO ARTICLE MUST NOT LEAK', body: 'Demo article body' }], faq: [{ question: 'DEMO FAQ MUST NOT LEAK', answer: 'Demo answer' }], ...extra };
}
function parse(window, html) { return new window.DOMParser().parseFromString(html, 'text/html'); }
function generatedHeader(doc) { return doc.querySelector('#pp-landing > .pp-header'); }
function generatedFooter(doc) { return doc.querySelector('#pp-landing > .pp-footer'); }
function imported(doc) { return doc.querySelector('#pp-imported-content'); }
const sample = '<!doctype html><html lang="en"><head><title>Original document title</title><style>body{background:#eef4f1;color:#123456}.cards{display:grid;grid-template-columns:1fr 1fr}.cards article{padding:12px}h2{font-size:28px}</style></head><body class="original-page"><main><h1>Original page heading</h1><p>Original lead paragraph.</p><div class="cards"><article><h2 id="first">First section</h2><p>First complete paragraph.</p><img src="../images/photo.jpg" alt="Original photograph"></article><article><h2>Second section</h2><p>Second complete paragraph.</p></article></div><table><caption>Original comparison</caption><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody><tr><td>One</td><td>Two</td></tr></tbody></table><a href="https://offer.example/path?aff=keep&amp;x=2">View original offer</a></main></body></html>';

test('legacy normalization remains builder mode and JSON preserves additive imported settings', () => {
  const old = core.normalizeConfig({ title: 'Legacy title', cards: [], sections: [], faq: [] });
  assert.equal(old.version, 1);
  assert.equal(old.contentMode, 'builder');
  assert.equal(old.importHtml, '');
  assert.equal(old.importBaseUrl, '');
  assert.equal(old.importReplaceHeader, false);
  assert.equal(old.importReplaceFooter, false);
  const original = config(sample, { importReplaceHeader: true });
  const restored = core.normalizeConfig(JSON.parse(JSON.stringify(core.normalizeConfig(original))));
  assert.equal(restored.contentMode, 'html');
  assert.equal(restored.importHtml, sample);
  assert.equal(restored.importBaseUrl, original.importBaseUrl);
  assert.equal(restored.importReplaceHeader, true);
  assert.equal(restored.importReplaceFooter, false);
  assert.equal(restored.cards[0].name, original.cards[0].name, 'Switching mode must preserve the builder draft');
  assert.equal(core.normalizeConfig({ ...original, importReplaceFooter: 'true' }).importReplaceFooter, false);
});

test('imported rendering preserves document content, assets, table and language without demo body', t => {
  const { window, api } = runtime(t);
  const value = config(sample);
  const snippet = api.renderSnippet(value);
  const doc = parse(window, snippet), body = imported(doc);
  assert.ok(body);
  assert.equal(body.querySelector('h1').textContent, 'Original page heading');
  assert.ok(body.querySelector('.ppi-body.original-page'), 'Original body classes must remain available to imported CSS');
  assert.equal(body.querySelectorAll('.cards > article').length, 2);
  assert.equal(body.querySelector('img').getAttribute('src'), 'https://source.example/images/photo.jpg');
  assert.equal(body.querySelector('img').getAttribute('alt'), 'Original photograph');
  assert.equal(body.querySelector('table caption').textContent, 'Original comparison');
  assert.deepEqual([...body.querySelectorAll('tbody td')].map(n => n.textContent), ['One', 'Two']);
  assert.equal(doc.querySelector('#pp-landing').getAttribute('lang'), 'en');
  for (const text of ['DEMO CARD MUST NOT LEAK', 'DEMO ARTICLE MUST NOT LEAK', 'DEMO FAQ MUST NOT LEAK', 'Builder title must not leak', 'Builder introduction must not leak']) assert.ok(!doc.body.textContent.includes(text));
  assert.ok(generatedHeader(doc));
  assert.ok(generatedFooter(doc));
  const full = parse(window, api.renderDocument(value));
  assert.equal(full.title, 'Original document title');
});

test('existing page header/footer are preserved while explicit replacement affects only page landmarks', t => {
  const { window, api } = runtime(t);
  const html = '<div class="site"><header><p>Original site header</p></header><main><article><header><h1>Article header remains</h1></header><p>Article text</p><footer>Article footer remains</footer></article></main><footer><p>Original site footer</p></footer></div>';
  const value = config(html);
  const source = api.analyzeHTML(value);
  assert.equal(source.hasHeader, true);
  assert.equal(source.hasFooter, true);
  let doc = parse(window, api.renderSnippet(value));
  assert.ok(generatedHeader(doc));
  assert.ok(generatedFooter(doc));
  assert.ok(imported(doc).textContent.includes('Original site header'));
  assert.ok(imported(doc).textContent.includes('Original site footer'));
  doc = parse(window, api.renderSnippet({ ...value, importReplaceHeader: true, importReplaceFooter: true }));
  assert.ok(generatedHeader(doc));
  assert.ok(generatedFooter(doc));
  assert.ok(!imported(doc).textContent.includes('Original site header'));
  assert.ok(!imported(doc).textContent.includes('Original site footer'));
  assert.ok(imported(doc).textContent.includes('Article header remains'));
  assert.ok(imported(doc).textContent.includes('Article footer remains'));
});

test('article and section headers/footers do not prevent missing site chrome from being added', t => {
  const { window, api } = runtime(t);
  const value = config('<main><article><header><h1>Article only</h1></header><p>Text</p><footer>Article credit</footer></article><section><header><h2>Section heading</h2></header><footer>Section credit</footer></section></main>');
  const result = api.analyzeHTML(value);
  assert.equal(result.hasHeader, false);
  assert.equal(result.hasFooter, false);
  const doc = parse(window, api.renderSnippet(value));
  assert.ok(generatedHeader(doc));
  assert.ok(generatedFooter(doc));
  assert.ok(imported(doc).textContent.includes('Article credit'));
  assert.ok(imported(doc).textContent.includes('Section credit'));
});

test('ambiguous page landmarks survive replacement rather than deleting multiple regions', t => {
  const { window, api } = runtime(t);
  const value = config('<header>Header alpha</header><header>Header beta</header><main><h1>Content survives</h1></main><footer>Footer alpha</footer><footer>Footer beta</footer>', { importReplaceHeader: true, importReplaceFooter: true });
  const result = api.analyzeHTML(value);
  const doc = parse(window, api.renderSnippet(value));
  for (const text of ['Header alpha', 'Header beta', 'Footer alpha', 'Footer beta']) assert.ok(imported(doc).textContent.includes(text), text);
  assert.ok(generatedHeader(doc));
  assert.ok(generatedFooter(doc));
  assert.ok(result.warnings.length > 0, 'Ambiguous replacement must be explained');
});

test('generated brand links use explicit or imported destinations and never demo card URLs', t => {
  const { window, api } = runtime(t);
  const html = '<h1>My imported page</h1><a href="#section">Internal</a><h2 id="section">Details</h2><a href="https://first.example/offer?aff=abc&amp;x=1">First offer</a><a href="https://second.example/">Second offer</a>';
  for (const [extra, expected] of [[{}, 'https://first.example/offer?aff=abc&x=1'], [{ brandUrl: 'https://brand.example/custom' }, 'https://brand.example/custom'], [{ brandUrl: 'javascript:alert(1)' }, '#pp-top']]) {
    const doc = parse(window, api.renderSnippet(config(html, extra)));
    const links = [...doc.querySelectorAll('#pp-landing > .pp-header .pp-brand, #pp-landing > .pp-footer .pp-brand')];
    assert.equal(links.length, 2);
    for (const link of links) assert.equal(link.getAttribute('href') || link.getAttribute('data-pp-url'), expected);
  }
  const doc = parse(window, api.renderSnippet(config('<h1>No outgoing link</h1>')));
  assert.equal(generatedHeader(doc).querySelector('.pp-brand').getAttribute('href'), '#pp-top');
  assert.ok(!doc.documentElement.outerHTML.includes('https://demo.invalid/offer'));
});

test('generated navigation resolves actual imported headings and rejects absent synthetic footer anchors', t => {
  const { window, api } = runtime(t);
  let doc = parse(window, api.renderSnippet(config(sample)));
  const navLinks = [...generatedHeader(doc).querySelectorAll('.pp-nav a')];
  assert.ok(navLinks.length >= 2);
  for (const link of navLinks) {
    const destination = doc.getElementById(link.getAttribute('href').slice(1));
    assert.ok(destination, link.outerHTML);
    assert.match(destination.tagName, /^H[1-6]$/);
    assert.equal(destination.textContent.trim(), link.textContent.trim());
  }
  const value = config('<h1>Body heading</h1><footer>Existing footer</footer>', { navLinks: [{ name: 'Absent synthetic footer', url: '#pp-footer' }, { name: 'Top', url: '#pp-top' }] });
  doc = parse(window, api.renderSnippet(value));
  assert.ok(generatedFooter(doc));
  assert.ok(generatedHeader(doc).textContent.includes('Absent synthetic footer'));
  assert.equal(generatedHeader(doc).querySelector('.pp-nav a').getAttribute('href'), '#pp-footer');
  assert.equal(api.validateConfig(value).length, 0);
});

test('imported stylesheet selectors match only imported content and chrome rules do not leak inward', t => {
  const { window, api } = runtime(t);
  const value = config('<style>body{color:purple}header,footer{padding:17px}.box:is(.a,.b){display:grid}@media(min-width:1px){h2{color:green}}</style><h1>Content</h1><article><header>Article header</header></article><div class="box a"><h2>Section</h2></div><div class="pp-header-inner">A source class collision</div>');
  const result = api.analyzeHTML(value);
  const doc = parse(window, api.renderSnippet(value));
  const ast = window.csstree.parse(result.css);
  let matches = 0;
  window.csstree.walk(ast, { visit: 'Rule', enter(node) {
    if (!node.prelude || node.prelude.type !== 'SelectorList') return;
    const selector = window.csstree.generate(node.prelude);
    for (const element of doc.querySelectorAll(selector)) { matches++; assert.ok(element.closest('#pp-imported-content'), selector + ' leaked onto generated chrome'); }
  } });
  assert.ok(matches > 0, 'Source CSS must still match its content');
  const chromeAST = window.csstree.parse(doc.querySelector('style').textContent);
  window.csstree.walk(chromeAST, { visit: 'Rule', enter(node) {
    if (!node.prelude || node.prelude.type !== 'SelectorList') return;
    const selector = window.csstree.generate(node.prelude);
    if (!selector.includes('.pp-header-inner')) return;
    for (const element of doc.querySelectorAll(selector)) assert.ok(!element.closest('#pp-imported-content'), 'Generated header layout leaked into source class');
  } });
});

test('root HTML and body IDs still resolve anchors and source CSS after wrapper conversion', t => {
  const { window, api } = runtime(t);
  const html = '<!doctype html><html id="source-root"><head><style>html#source-root body#source-body{color:purple}body#source-body h1{font-size:39px}</style></head><body id="source-body"><h1>Root attributes matter</h1><a href="#source-body">Body anchor</a></body></html>';
  const value = config(html), result = api.analyzeHTML(value);
  const doc = parse(window, api.renderSnippet(value));
  assert.ok(imported(doc).querySelector('#source-root'), 'Original html ID must be mapped to its wrapper');
  assert.ok(imported(doc).querySelector('#source-body'), 'Original body ID must be mapped to its wrapper');
  assert.equal(imported(doc).querySelector('a').getAttribute('href'), '#source-body');
  let bodyMatched = false, headingMatched = false;
  window.csstree.walk(window.csstree.parse(result.css), { visit: 'Rule', enter(node) {
    if (!node.prelude || node.prelude.type !== 'SelectorList') return;
    for (const match of doc.querySelectorAll(window.csstree.generate(node.prelude))) {
      if (match.id === 'source-body') bodyMatched = true;
      if (match.tagName === 'H1') headingMatched = true;
    }
  } });
  assert.equal(bodyMatched, true);
  assert.equal(headingMatched, true);
});

test('rendered documents and snippets contain no executable imported markup', t => {
  const { window, api } = runtime(t);
  const html = '<title>Safe imported title</title><script>window.importedRan=true</script><h1 onclick="alert(1)">Safe content</h1><img src="https://assets.example/a.png" onerror="alert(1)"><a href="javascript:alert(1)">Unsafe link label</a><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="https://bad.example/"></object><form action="https://bad.example/"><input name="secret"><p>Form description</p></form><style>body{color:red}h1::after{content:"&lt;/style&gt;"}</style>';
  const value = config(html);
  for (const output of [api.renderSnippet(value), api.renderDocument(value)]) {
    const doc = parse(window, output);
    assert.equal(doc.querySelectorAll('script:not([data-pp-runtime]),iframe,object,embed,form,input').length, 0);
    for (const node of doc.querySelectorAll('*')) for (const attribute of node.attributes) {
      assert.ok(!/^on/i.test(attribute.name), node.outerHTML);
      if (['href', 'src', 'action', 'formaction'].includes(attribute.name)) assert.ok(!/^\s*(?:javascript|vbscript|data):/i.test(attribute.value));
    }
    assert.ok(imported(doc).textContent.includes('Safe content'));
    assert.equal(window.importedRan, undefined);
  }
});

test('WordPress paragraph filtering preserves imported grid items and balanced meaningful content', t => {
  const { window, api } = runtime(t);
  const output = api.renderSnippet(config(sample));
  const before = parse(window, output), after = parse(window, wpautop(output));
  const signature = doc => [...imported(doc).querySelector('.cards').children].map(n => n.tagName + ':' + n.className);
  assert.deepEqual(signature(after), signature(before));
  // wpautop may add valid paragraphs around standalone images/links. Check structural
  // damage and original paragraph content rather than requiring the same p count.
  for (const selector of ['h1', 'h2', 'img', 'table', 'tr', 'td', 'a']) assert.equal(imported(after).querySelectorAll(selector).length, imported(before).querySelectorAll(selector).length, selector + ' count changed after wpautop');
  for (const paragraph of imported(before).querySelectorAll('p')) assert.ok([...imported(after).querySelectorAll('p')].some(p => p.textContent === paragraph.textContent));
  const stack = [], voidTags = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'area', 'col', 'wbr']);
  const closesParagraph = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table', 'ul']);
  for (const match of wpautop(output).matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const tag = match[2].toLowerCase();
    if (!match[1] && closesParagraph.has(tag) && stack.at(-1) === 'p') stack.pop();
    if (voidTags.has(tag)) continue;
    // HTML permits a p end tag to be omitted before a block boundary or at the
    // end of its parent. wpautop uses this for standalone image paragraphs.
    if (match[1]) {
      if (tag !== 'p' && stack.at(-1) === 'p' && stack.at(-2) === tag && !['a', 'audio', 'del', 'ins', 'map', 'noscript', 'video'].includes(tag)) stack.pop();
      assert.equal(stack.pop(), tag, 'Unbalanced closing ' + tag + ' after WordPress formatting');
    } else stack.push(tag);
  }
  assert.deepEqual(stack, []);
  assert.equal(imported(after).querySelectorAll('p:empty').length, 0);
  const headerChildren = doc => [...generatedHeader(doc).querySelector('.pp-header-inner').children].map(n => n.tagName + ':' + n.className);
  assert.deepEqual(headerChildren(after), headerChildren(before));
});

test('analysis memoization reuses exact source/options and never exposes mutable cached metadata', t => {
  const { window, api } = runtime(t);
  const processor = window.PagePosterHTML;
  let calls = 0;
  window.PagePosterHTML = { process(...args) { calls++; return processor.process(...args); } };
  const value = config(sample);
  const first = api.analyzeHTML(value);
  first.headings[0].text = 'Mutated outside cache'; first.warnings.push('External mutation');
  const second = api.analyzeHTML(value);
  assert.equal(calls, 1);
  assert.notEqual(second.headings[0].text, 'Mutated outside cache');
  assert.ok(!second.warnings.includes('External mutation'));
  api.analyzeHTML({ ...value, brand: 'Different chrome text' });
  assert.equal(calls, 1);
  api.analyzeHTML({ ...value, importBaseUrl: 'https://another.example/' });
  assert.equal(calls, 2);
  api.analyzeHTML({ ...value, importReplaceHeader: true });
  assert.equal(calls, 3);
  api.analyzeHTML({ ...value, importHtml: sample + '<p>Added content</p>' });
  assert.equal(calls, 4);
});


test('original-only mode retains the source hero and disclosures even after switching from replacement mode', t => {
  const {window,api}=runtime(t);
  const value=config('<header><h1>Original hero</h1></header><main><p>Original article</p></main><footer>Original disclosures</footer>',{importChrome:'none',importReplaceHeader:true,importReplaceFooter:true});
  const doc=parse(window,api.renderSnippet(value));
  assert.equal(generatedHeader(doc),null);assert.equal(generatedFooter(doc),null);
  assert.ok(imported(doc).textContent.includes('Original hero'));assert.ok(imported(doc).textContent.includes('Original disclosures'));
  assert.equal(doc.querySelector('#pp-landing').getAttribute('data-pp-fullscreen'),'true');
  assert.equal(core.normalizeConfig(JSON.parse(JSON.stringify(value))).importChrome,'none');
});

test('imported native links are counted once and original full destinations survive duplicate brands', t => {
  const {window,api}=runtime(t);
  const value=config('<h1>Source</h1><a href="https://offer.example/go?offer=1&amp;token=Exact%2F">View</a><a href="https://offer.example/go?offer=1&amp;token=Exact%2F">Again</a><a href="https://offer.example/go?offer=2">Other</a>');
  const output=api.renderSnippet(value),doc=parse(window,output),summary=api.analyzeLinks(value);
  assert.equal(doc.querySelectorAll('a[href^="https:"]').length,2);
  assert.equal(summary.uniqueCount,2);assert.equal(summary.totalControls,5);assert.equal(summary.duplicateControls,3);
  assert.equal(summary.urls[0],'https://offer.example/go?offer=1&token=Exact%2F');
  assert.ok(summary.links.every(item=>item.nativeCount===1));
});


test('synthetic Polish article exports both variants with six exact native offer URLs', t => {
  const {window,api}=runtime(t);
  const html=fs.readFileSync(path.join(__dirname,'fixtures/imported-polish-article.html'),'utf8');
  const expected=['1','2','3','4','5','6'].map(id=>'https://offers.example/catalog?campaign=demo%2Fvisit&offer='+id);
  for(const importChrome of ['add','none']) {
    const value=config(html,{importChrome,brandUrl:'',importBaseUrl:''}), output=api.renderSnippet(value);
    for(const render of [output,wpautop(output),wpautop(wpautop(output))]) {
      const doc=parse(window,render),source=imported(doc);
      assert.equal(!!generatedHeader(doc),importChrome==='add');assert.equal(!!generatedFooter(doc),importChrome==='add');
      assert.ok(source.querySelector('header.hero h1'));assert.ok(source.querySelector('footer'));
      const offers=[...source.querySelectorAll('a.btn[href]')];
      assert.deepEqual(offers.map(node=>node.getAttribute('href')),expected);
      assert.equal(source.querySelectorAll('.card').length,6);
      assert.ok(source.querySelector('link[href^="https://fonts.googleapis.com/css2"]'));
      assert.ok(offers.every(node=>node.textContent==='VIEW OFFER'));
      assert.equal(source.querySelectorAll('[onclick],[onkeydown]').length,0);
      assert.equal(doc.querySelectorAll('a[href^="https://offers.example/"]').length,6);
    }
    const summary=api.analyzeLinks(value);
    assert.deepEqual(Array.from(summary.urls),expected);
    assert.ok(summary.links.every(link=>link.nativeCount===1));
  }
});


test('imported menus skip H1, prefer section headings and keep long labels compact', t => {
  const {window,api}=runtime(t);
  const title='A long original article title that must not become a menu item';
  const headings=['An exceptionally long heading about comparing payment methods and payout times','Second important section with a heading that continues for quite a while','Third useful section with a detailed heading that takes more space','Fourth section'];
  const html='<h1>'+title+'</h1><h3>A subsection before the main sections</h3>'+headings.map(text=>'<h2>'+text+'</h2>').join('');
  const doc=parse(window,api.renderSnippet(config(html))),links=[...generatedHeader(doc).querySelectorAll('.pp-nav a')];
  assert.equal(links.length,3);
  assert.ok(!generatedHeader(doc).textContent.includes(title));
  links.forEach((link,i)=>{
    const destination=doc.getElementById(link.getAttribute('href').slice(1));
    assert.equal(destination.tagName,'H2');assert.equal(destination.textContent,headings[i]);
    assert.ok(Array.from(link.textContent).length<=32);assert.match(link.textContent,/…$/);
    assert.equal(link.getAttribute('aria-label'),headings[i]);assert.equal(link.getAttribute('title'),headings[i]);
  });
  const css=doc.querySelector('style').textContent;
  assert.match(css,/@media\s*\(max-width:850px\)/);
  assert.match(css,/\.pp-brand-wrap\{[^}]*flex-shrink:0!important/);
  assert.match(css,/\.pp-nav\{[^}]*min-width:0!important/);
  assert.match(css,/\.pp-nav a\{[^}]*text-overflow:ellipsis!important/);
});

test('imported pages with only H1 get no automatic menu; H3 sections remain a useful fallback', t => {
 const {window,api}=runtime(t);
 const titleOnly=parse(window,api.renderSnippet(config('<h1>Just the page title</h1>')));
 assert.equal(generatedHeader(titleOnly).querySelector('.pp-nav'),null);
 const subsections=parse(window,api.renderSnippet(config('<h1>Title</h1><h3>First subsection</h3><h3>Second subsection</h3>')));
 assert.deepEqual([...generatedHeader(subsections).querySelectorAll('.pp-nav a')].map(n=>n.textContent),['First subsection','Second subsection']);
});
