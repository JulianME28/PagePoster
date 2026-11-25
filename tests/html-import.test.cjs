'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const csstree = require('css-tree');
const Importer = require('../dist/html-import.js');
function fixture(source, options) { const window = new JSDOM('').window; const result = Importer.create(window).process(source, options); const document = new JSDOM('<div id="pp-imported-content">' + result.html + '</div>').window.document; window.close(); return { result, document }; }

test('preserves static article semantics, metadata and safe inline formatting', () => {
  const { result, document } = fixture('<!doctype html><html lang="uk" class="dark"><head><title>Original &amp; clear</title><style>html.dark body.blue > article {color:#123456} h2,p {line-height:1.7}</style></head><body class="blue"><article><h1>Original title</h1><h2>Details</h2><p style="font-weight:700;color:teal">A <strong>useful</strong> article.</p><table><tr><th>A</th><td>B</td></tr></table><img alt="Photo" src="https://images.example/p.jpg"><a href="https://example.test/offer?a=1&amp;b=2">Go</a></article></body></html>');
  assert.equal(result.title, 'Original & clear'); assert.equal(result.lang, 'uk');
  assert.equal(result.headings.length, 2); assert.ok(result.headings.every(h => h.id)); assert.deepEqual(result.headings.map(h => h.level), [1, 2]);
  assert.equal(result.firstLink, 'https://example.test/offer?a=1&b=2');
  assert.equal(result.stats.images, 1); assert.equal(result.stats.links, 1);
  assert.ok(document.querySelector('table th')); assert.equal(document.querySelector('strong').textContent, 'useful');
  assert.match(document.querySelector('p').getAttribute('style'), /font-weight:700/);
  assert.ok(document.querySelector('.ppi-html.dark .ppi-body.blue'));
  assert.match(result.css, /#pp-imported-content :is\(div:where\(\.ppi-html\)\)\.dark :is\(div:where\(\.ppi-body\)\)\.blue>article/);
});

test('removes executable, embedded, form and navigation-changing HTML without running it', () => {
  const { result, document } = fixture('<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test"><link rel="stylesheet" href="https://evil.test/a.css"><script>globalThis.pwned=1</script><iframe srcdoc="<script>x</script>"></iframe><object data="x"></object><embed src="x"><form action="https://evil.test"><input autofocus name="x"><button>Submit</button></form><svg><a href="javascript:alert(1)">SVG</a></svg><math><mtext>x</mtext></math><p onclick="alert(1)">Keep</p><img src="javascript:alert(1)" onerror="alert(2)"><a href="javascript:alert(3)">Bad</a><a href="https://good.test" target="_blank" ping="https://track.test">Good</a>');
  assert.equal(document.querySelectorAll('script,iframe,object,embed,form,input,button,svg,math,base,meta,link').length, 0);
  assert.equal(document.querySelectorAll('[onclick],[onerror],[srcdoc],[ping],[autofocus]').length, 0);
  assert.equal(document.querySelector('img').hasAttribute('src'), false);
  assert.equal(document.querySelector('a').hasAttribute('href'), false);
  assert.match(document.querySelector('a[href]').rel, /noopener/);
  assert.match(result.warnings.join(' '), /скрипт|JavaScript/i); assert.match(result.warnings.join(' '), /зовнішн|CSS/i);
  assert.equal(globalThis.pwned, undefined);
});

test('resolves relative URLs only against explicit HTTP(S) base and keeps hashes local', () => {
  const source = '<base href="https://ignored.test"><h2 id="a">A</h2><a href="../offer?q=x%20y#go">Offer</a><a href="#a">Section</a><img src="/img/a.png" srcset="one.png 1x, two.png 2x"><p style="background-image:url(../bg.jpg)">P</p>';
  const missing = fixture(source);
  assert.equal(missing.document.querySelector('a').hasAttribute('href'), false);
  assert.equal(missing.document.querySelector('img').hasAttribute('src'), false);
  assert.match(missing.result.warnings.join(' '), /відносн|базов/i);
  const resolved = fixture(source, { baseUrl: 'https://source.test/path/page.html' });
  assert.equal(resolved.document.querySelector('a').getAttribute('href'), 'https://source.test/offer?q=x%20y#go');
  assert.equal(resolved.document.querySelector('img').getAttribute('src'), 'https://source.test/img/a.png');
  assert.match(resolved.document.querySelector('img').getAttribute('srcset'), /https:\/\/source.test\/path\/one.png 1x/);
  assert.equal(resolved.document.querySelectorAll('a')[1].getAttribute('href'), '#a');
  assert.match(resolved.document.querySelector('p').getAttribute('style'), /https:\/\/source.test\/bg.jpg/);
  assert.throws(() => fixture('<p>x</p>', { baseUrl: 'javascript:alert(1)' }), /базов|HTTP/i);
});

test('renames reserved and duplicate IDs and updates hash, ARIA and CSS references consistently', () => {
  const { result, document } = fixture('<style>#pp-top, [id="pp-top"], a[href="#pp-top"]{color:blue}</style><h1 id="pp-top">Title</h1><p id="ordinary">P</p><p id="ordinary">Duplicate</p><a href="#pp-top" aria-labelledby="pp-top ordinary" aria-describedby="ordinary">Jump</a><h2>Other</h2>');
  const titleId = document.querySelector('h1').id;
  assert.ok(titleId && !titleId.startsWith('pp-'));
  assert.equal(document.querySelector('a').getAttribute('href'), '#' + titleId);
  assert.equal(document.querySelector('a').getAttribute('aria-labelledby'), titleId + ' ordinary');
  assert.ok(!result.css.includes('#pp-top')); assert.ok(result.css.includes('#' + titleId));
  const ids = result.ids; assert.equal(new Set(ids).size, ids.length); assert.ok(ids.includes('ordinary'));
  assert.equal(result.headings[0].id, titleId);
});

test('keeps landmarks by default and replaces only single page-level native or explicit landmarks', () => {
  const source = '<header><h1>Page header</h1></header><main><article><header>Article header</header><p>Body</p><footer>Article footer</footer></article></main><footer>Page footer</footer>';
  const kept = fixture(source); assert.equal(kept.result.hasHeader, true); assert.equal(kept.result.hasFooter, true); assert.equal(kept.document.querySelectorAll('header').length, 2);
  const replaced = fixture(source, { replaceHeader: true, replaceFooter: true });
  assert.equal(replaced.document.querySelectorAll('header').length, 1); assert.equal(replaced.document.querySelector('header').textContent, 'Article header');
  assert.equal(replaced.document.querySelector('footer').textContent, 'Article footer'); assert.equal(replaced.result.hasHeader, true);
  const roles = fixture('<div role="banner">Top</div><p>Article text</p><div role="contentinfo">Bottom</div>', { replaceHeader: true, replaceFooter: true });
  assert.equal(roles.document.querySelectorAll('[role]').length, 0);
  const ambiguous = fixture('<header>One</header><header>Two</header>', { replaceHeader: true });
  assert.equal(ambiguous.document.querySelectorAll('header').length, 2); assert.match(ambiguous.result.warnings.join(' '), /неоднознач|кілька/i);
  const nested = fixture('<section><div role="banner">Nested</div></section><nav><footer>Nested</footer></nav>'); assert.equal(nested.result.hasHeader, false); assert.equal(nested.result.hasFooter, false);
});

test('scopes complex CSS selectors through AST including pseudo functions and media queries', () => {
  const { result } = fixture('<style>html,body,:root{margin:0}.card:is(.wide,#pp-offers)>a:hover, :not(.hidden) h2{color:red}@media(max-width:650px){body .grid{display:block}}@supports(display:grid){.grid{display:grid}}</style><div class="grid card"><h2>Text</h2></div>');
  const ast = csstree.parse(result.css); let checked = 0;
  csstree.walk(ast, { visit: 'Rule', enter(node) { const selectors = node.prelude.children.toArray(); for (const selector of selectors) { assert.equal(selector.children.head.data.type, 'IdSelector'); assert.equal(selector.children.head.data.name, 'pp-imported-content'); checked++; } } });
  assert.ok(checked >= 7); assert.match(result.css, /@media/); assert.match(result.css, /@supports/);
});

test('drops dangerous and unsupported CSS, contains overlays and cannot break out of a style element', () => {
  const { result, document } = fixture('<style>@import "https://evil.test/a.css";@font-face{font-family:x;src:url(https://evil.test/x.woff)}@keyframes move{to{left:0}}body{position:fixed;z-index:999999;--evil:red;behavior:url(evil.htc);-moz-binding:url(x);background:url(javascript:alert(1));color:red}.x{position:sticky;animation:move 1s;color:var(--evil)}</style><p class="x" style="position:fixed;z-index:999999;color:green">Safe</p><p style="content:&quot;&lt;/style&gt;&lt;script&gt;bad&lt;/script&gt;&quot;">Literal</p>');
  assert.doesNotMatch(result.css, /@import|@font-face|@keyframes|javascript:|behavior|binding|position:fixed|position:sticky|z-index:999999|animation:/i);
  assert.match(result.css, /position:relative/); assert.match(result.css, /contain:layout paint/);
  assert.doesNotMatch(result.css, /<\/style/i); assert.match(document.querySelector('p').getAttribute('style'), /position:relative/);
  assert.ok(result.stats.removedRules >= 3); assert.ok(result.stats.removedDeclarations >= 4); assert.match(result.warnings.join(' '), /CSS|стил/i);
});

test('enforces input, node and stylesheet rule bounds with clear errors', () => {
  assert.throws(() => fixture('x'.repeat(500001)), /500|розмір/i);
  assert.throws(() => fixture('<i>x</i>'.repeat(10001)), /вузл|елемент|складн/i);
  assert.throws(() => fixture('<style>' + '.x{color:red}'.repeat(2001) + '</style>'), /правил|CSS|складн/i);
  assert.throws(() => fixture(null), /HTML|ряд/i);
});

test('browser UMD uses provided libraries and importing twice is deterministic', () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  dom.window.eval(fs.readFileSync(require.resolve('dompurify/dist/purify.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(path.dirname(require.resolve('css-tree/package.json')), 'dist/csstree.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../dist/html-import.js'), 'utf8'));
  const source = '<h1 id="pp-top">Hello</h1><style>h1{color:red}</style>';
  const first = dom.window.PagePosterHTML.process(source), second = dom.window.PagePosterHTML.process(source);
  assert.equal(first.html, second.html); assert.equal(first.css, second.css); assert.equal(first.headings[0].id, second.headings[0].id);
  dom.window.close();
});


test('preserves safe scoped CSS variables while rejecting variable-controlled overlays and unsafe values', () => {
  const {result,document}=fixture('<style>:root{--Brand:#164832;--space:clamp(10px,2vw,30px);--unsafe:url(javascript:alert(1));--overlay:fixed}.card{color:var(--Brand);padding:var(--space);position:var(--overlay);z-index:var(--level);height:var(--screen)}</style><p class="card" style="--inline:#cba;color:var(--inline)">Keep</p>');
  assert.match(result.css,/--Brand:#164832/);assert.match(result.css,/color:var\(--Brand\)/);assert.match(result.css,/padding:var\(--space\)/);
  assert.doesNotMatch(result.css,/--unsafe|position:var|z-index:var|height:var/);
  assert.match(document.querySelector('p').getAttribute('style'),/color:var\(--inline\)/);
});


test('normalizes main for WordPress and removes only structural indentation whitespace', () => {
  const {result,document}=fixture('<style>main > article{display:block}</style><main id="article-root">\n  <article>\n<h1>Heading</h1>\n<p><strong>One</strong> <em>two</em></p>\n<pre>line one\n  line two</pre>\n</article>\n</main>');
  assert.equal(document.querySelectorAll('main').length,0);assert.ok(document.querySelector('.ppi-main[role="main"]#article-root'));
  assert.match(result.css,/#pp-imported-content :is\(div:where\(\.ppi-main\)\)>article/);
  assert.equal(document.querySelector('p').textContent,'One two');assert.equal(document.querySelector('pre').textContent,'line one\n  line two');
  assert.doesNotMatch(result.html,/\n|&#10;\s*<article|<\/h1>&#10;/);
});


test('root IDs remain listed for generated navigation and root inline styles stay sanitized', () => {
  const {result,document}=fixture('<html id="pp-original" dir="rtl" style="color:purple;position:fixed"><body id="body-root" style="background:#eee"><h1>Heading</h1><a href="#pp-original">Top</a></body></html>');
  const html=document.querySelector('.ppi-html'), body=document.querySelector('.ppi-body');
  assert.ok(result.ids.includes(html.id));assert.ok(result.ids.includes(body.id));assert.equal(html.dir,'rtl');
  assert.match(html.getAttribute('style'),/color:purple/);assert.match(html.getAttribute('style'),/position:relative/);
  assert.match(body.getAttribute('style'),/background:#eee/);assert.equal(document.querySelector('a').getAttribute('href'),'#'+html.id);
});
