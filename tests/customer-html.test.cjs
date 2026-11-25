
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{JSDOM}=require('jsdom');
const exact='https://offers.example/path?offer=17&token=%2f%2F#keep';
const source='<!doctype html><html lang="pl"><head><title>Przewodnik klienta</title><meta property="og:site_name" content="Marka klienta"><style>body{background:#f6feff;color:#123456}.cards{display:grid;grid-template-columns:1fr 2fr}header,footer{padding:12px}</style></head><body class="customer"><header id="source-top">Oryginalny nagłówek</header><main><h1>Oryginalny tytuł</h1><h2 id="guide">Poradnik</h2><p>Dokładny <strong>tekst klienta</strong>.</p><div class="cards"><div>A</div><div>B</div></div><table><tr><th>Metoda</th><td>Informacje</td></tr></table><a href="https://offers.example/path?offer=17&amp;token=%2f%2F#keep">Dokładny ankor</a><a href="https://offers.example/path?offer=17&amp;token=%2f%2F#keep">Drugi ankor</a><h2 id="faq">Pytania</h2><p>Odpowiedź.</p></main><footer id="source-bottom">Oryginalna stopka</footer></body></html>';
async function api(){return{...await import('../server/lifecycle/customer-html.mjs'),...await import('../server/lifecycle/render.mjs')};}
function parsed(html){return new JSDOM(html).window.document;}

test('overlay-only keeps exact customer source and static content without generated chrome',async()=>{
 const {prepareCustomerHtml,renderPage}=await api(),prepared=prepareCustomerHtml({html:source,chromeMode:'overlay-only'});
 assert.equal(prepared.config.importHtml,source);assert.equal(prepared.sourceBytes,Buffer.byteLength(source));assert.equal(prepared.sourceHash,createHash('sha256').update(source).digest('hex'));
 assert.equal(prepared.title,'Przewodnik klienta');assert.equal(prepared.brand,'Marka klienta');assert.equal(prepared.language,'pl');
 assert.equal(prepared.config.mode,'fullscreen');assert.equal(prepared.config.contentMode,'html');assert.equal(prepared.config.importChrome,'none');
 assert.equal(prepared.config.importReplaceHeader,false);assert.equal(prepared.config.importReplaceFooter,false);
 const rendered=renderPage(prepared.config),doc=parsed(rendered.html),body=doc.querySelector('#pp-imported-content');
 assert.equal(doc.querySelector('#pp-landing > .pp-header'),null);assert.equal(doc.querySelector('#pp-landing > .pp-footer'),null);
 assert.equal(body.querySelector('#source-top').textContent,'Oryginalny nagłówek');assert.equal(body.querySelector('#source-bottom').textContent,'Oryginalna stopka');
 assert.equal(body.querySelector('h1').textContent,'Oryginalny tytuł');assert.equal(body.querySelector('p').textContent,'Dokładny tekst klienta.');
 assert.deepEqual([...body.querySelectorAll('table th, table td')].map(n=>n.textContent),['Metoda','Informacje']);
 assert.match(rendered.html,/grid-template-columns:1fr 2fr/);assert.ok(body.querySelector('.ppi-body.customer'));
 assert.deepEqual(rendered.expectedUrls,[exact]);assert.equal([...doc.querySelectorAll('a[href]')].filter(a=>a.getAttribute('href')===exact).length,1);
 assert.doesNotMatch(doc.body.textContent,/NORTHSTAR|Illustrative demo|Your brand|demo page/);
});

test('custom mode adds separate header and footer with automatic title brand and valid source navigation',async()=>{
 const {prepareCustomerHtml,renderPage}=await api(),prepared=prepareCustomerHtml({html:source,chromeMode:'custom'}),doc=parsed(renderPage(prepared.config).html);
 const header=doc.querySelector('#pp-landing > .pp-header'),footer=doc.querySelector('#pp-landing > .pp-footer');
 assert.ok(header);assert.ok(footer);assert.equal(prepared.config.importChrome,'add');
 assert.equal(header.querySelector('.pp-brand-name').textContent,'Marka klienta');assert.equal(footer.querySelector('.pp-brand-name').textContent,'Marka klienta');
 for(const brand of [header.querySelector('.pp-brand'),footer.querySelector('.pp-brand')])assert.equal(brand.getAttribute('href')||brand.getAttribute('data-pp-url'),exact);
 for(const a of header.querySelectorAll('.pp-nav a'))assert.ok(doc.getElementById(a.getAttribute('href').slice(1)));
 assert.equal(header.querySelectorAll('.pp-nav a').length,2);
 assert.equal(doc.querySelector('#pp-imported-content #source-top').textContent,'Oryginalny nagłówek');
 assert.equal(doc.querySelector('#pp-imported-content #source-bottom').textContent,'Oryginalna stopka');
 assert.equal(prepared.config.importHtml,source);
});

test('explicit brand overrides affect only new chrome and keep exact outbound URL spelling',async()=>{
 const {prepareCustomerHtml,renderPage}=await api(),url='https://brand.example/go?x=%2f&y=1#Exact';
 const prepared=prepareCustomerHtml({html:source,chromeMode:'custom',brand:'My & Brand',brandUrl:url}),doc=parsed(renderPage(prepared.config).html);
 assert.equal(prepared.config.importHtml,source);assert.equal(prepared.config.brandUrl,url);assert.equal(prepared.config.footerBrandUrl,url);
 assert.equal(doc.querySelector('#pp-landing > .pp-header .pp-brand-name').textContent,'My & Brand');
 for(const element of doc.querySelectorAll('#pp-landing > .pp-header .pp-brand,#pp-landing > .pp-footer .pp-brand'))assert.equal(element.getAttribute('href')||element.getAttribute('data-pp-url'),url);
 assert.equal(doc.querySelector('#pp-imported-content a').textContent,'Dokładny ankor');
});

test('relative resources require review without a base and resolve only against explicit base',async()=>{
 const {prepareCustomerHtml,renderPage}=await api(),html='<h1>Imported</h1><img src="../img/picture.png"><a href="/go?ref=%2f">Offer</a>';
 const missing=prepareCustomerHtml({html,chromeMode:'overlay-only'});assert.equal(missing.requiresReview,true);assert.match(missing.warnings.join(' '),/базов|відносн/i);
 const prepared=prepareCustomerHtml({html,chromeMode:'overlay-only',baseUrl:'https://source.example/folder/page.html'}),doc=parsed(renderPage(prepared.config).html);
 assert.equal(prepared.config.importHtml,html);assert.equal(doc.querySelector('#pp-imported-content img').getAttribute('src'),'https://source.example/img/picture.png');
 assert.equal(doc.querySelector('#pp-imported-content a').getAttribute('href'),'https://source.example/go?ref=%2f');
 assert.equal(prepared.requiresReview,false);
});

test('safe static input is ready without inventing demo content or external destinations',async()=>{
 const {prepareCustomerHtml,renderPage}=await api(),prepared=prepareCustomerHtml({html:'<h1>Customer guide</h1><h2>Details</h2><p>Original paragraph</p>',chromeMode:'custom'});
 assert.equal(prepared.error,false);assert.equal(prepared.requiresReview,false);assert.equal(prepared.state,'ready');assert.deepEqual(prepared.warnings,[]);
 assert.equal(prepared.title,'Customer guide');assert.equal(prepared.brand,'Customer guide');
 assert.deepEqual(renderPage(prepared.config).expectedUrls,[]);
});

test('source scripts, handlers, external CSS and forms cannot silently become publishable',async()=>{
 const {prepareCustomerHtml,renderPage,rendererWindow}=await api();
 const html='<h1>Customer body</h1><script>globalThis.CUSTOMER_EXECUTED=true</script><link rel="stylesheet" href="https://source.example/app.css"><button onclick="alert(1)">Action</button><form><input name="email"></form>';
 const prepared=prepareCustomerHtml({html,chromeMode:'overlay-only'}),rendered=renderPage(prepared.config),doc=parsed(rendered.html);
 assert.equal(rendererWindow.CUSTOMER_EXECUTED,undefined);assert.equal(globalThis.CUSTOMER_EXECUTED,undefined);
 assert.equal(prepared.config.importHtml,html);assert.equal(prepared.requiresReview,true);assert.equal(prepared.state,'needs_review');
 assert.match(prepared.warnings.join(' '),/скрипт|JavaScript/i);assert.match(prepared.warnings.join(' '),/CSS/i);
 assert.equal(doc.querySelector('#pp-imported-content [onclick],#pp-imported-content form,#pp-imported-content input'),null);
 assert.doesNotMatch(rendered.html,/CUSTOMER_EXECUTED/);
});

test('silent importer layout and ID rewrites are surfaced for review',async()=>{
 const {prepareCustomerHtml}=await api();
 const layout=prepareCustomerHtml({html:'<style>.fixed{position:fixed;z-index:9}</style><h1>Original</h1><p class="fixed">Text</p>',chromeMode:'overlay-only'});
 assert.equal(layout.requiresReview,true);assert.match(layout.warnings.join(' '),/позиці|позици|fixed|sticky|z-index/i);
 const ids=prepareCustomerHtml({html:'<h1 id="pp-top">Heading</h1><p id="same">A</p><p id="same">B</p>',chromeMode:'custom'});
 assert.equal(ids.requiresReview,true);assert.match(ids.warnings.join(' '),/ID|ідентиф|идентиф/i);
});

test('fatal import and invalid inputs reject before any publication and preserve safe errors',async()=>{
 const {prepareCustomerHtml}=await api();
 for(const input of [{html:'',chromeMode:'custom'},{html:'<h1>Title</h1>',chromeMode:'typo'},{html:'<h1>Title</h1>',chromeMode:'custom',baseUrl:'javascript:alert(1)'},{html:'<h1>Title</h1>',chromeMode:'custom',brandUrl:'https://user:secret@example.com/'},{html:'<h1>Title</h1>',chromeMode:'custom',script:'ignore'}])assert.throws(()=>prepareCustomerHtml(input),{code:'CUSTOMER_HTML_INVALID'});
 assert.throws(()=>prepareCustomerHtml({html:'<script>run()</script>',chromeMode:'overlay-only'}),error=>error.code==='CUSTOMER_HTML_INVALID'&&error.warnings.length>0);
 assert.throws(()=>prepareCustomerHtml({html:'<h1>Title</h1>'+'я'.repeat(250000),chromeMode:'custom'}),{code:'CUSTOMER_HTML_TOO_LARGE'});
});

test('safe JSON-LD stays inert and supported data is not mistaken for executable scripts',async()=>{
 const {prepareCustomerHtml,renderPage}=await api(),html='<h1>Title</h1><p>Text</p><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","name":"Original"}</script>';
 const prepared=prepareCustomerHtml({html,chromeMode:'overlay-only'}),doc=parsed(renderPage(prepared.config).html);
 assert.equal(prepared.config.importHtml,html);assert.equal(prepared.requiresReview,false);
 assert.equal(JSON.parse(doc.querySelector('#pp-imported-content script[type="application/ld+json"]').textContent).name,'Original');
});

