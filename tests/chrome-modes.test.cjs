'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const generator=require('../dist/generator.js'),placements=require('../dist/link-placements.js');
const OFFER='https://offer.example/path?a=%2f&b=%2F#Part',BRAND='https://brand.example/?a=1&b=2';
const input={title:'Customer title',brand:'Customer brand',brandUrl:BRAND,footerBrandUrl:BRAND,footer:'Custom footer',cards:[{name:'Offer',url:OFFER,button:'Visit'}],sections:[{title:'Article',body:'Useful body'}],faq:[],navLinks:[{name:'Footer',url:'#pp-footer'}]};
function inspect(config,callback){const dom=new JSDOM(generator.renderSnippet(config));try{return callback(dom.window.document);}finally{dom.window.close();}}

test('builder chrome defaults to custom and the normalized selection survives repeat rendering',()=>{
 assert.equal(generator.normalizeConfig(input).chromeMode,'custom');
 assert.equal(generator.normalizeConfig({...input,chromeMode:'unexpected'}).chromeMode,'custom');
 const overlay=generator.normalizeConfig({...input,chromeMode:'overlay-only'});assert.equal(overlay.chromeMode,'overlay-only');assert.equal(generator.normalizeConfig(overlay).chromeMode,'overlay-only');
 inspect(input,d=>{assert.equal(d.querySelectorAll('#pp-landing > .pp-header').length,1);assert.equal(d.querySelectorAll('#pp-landing > .pp-footer').length,1);});
});

test('overlay-only retains the full-screen wrapper and exact visible links without generated header footer or footer navigation',()=>{
 const config={...input,chromeMode:'overlay-only'};
 inspect(config,d=>{assert.equal(d.querySelectorAll('#pp-landing').length,1);assert.equal(d.querySelectorAll('.pp-header,.pp-footer,.pp-mobile-nav').length,0);assert.equal(d.querySelector('[href="#pp-footer"]'),null);assert.equal(d.querySelector('h1').textContent,input.title);assert.ok(d.querySelector('script[data-pp-runtime]'));assert.ok([...d.querySelectorAll('a[href]')].some(a=>a.getAttribute('href')===OFFER));assert.ok(![...d.querySelectorAll('a[href],[data-pp-url]')].some(a=>(a.getAttribute('href')||a.getAttribute('data-pp-url'))===BRAND));assert.match(d.querySelector('style').textContent,/position:fixed/);});
 assert.deepEqual(generator.analyzeLinks(config).urls,[OFFER]);
});

test('overlay-only placement registry omits hidden brand and navigation destinations without materializing inherited brand URLs',()=>{
 const config=generator.normalizeConfig({...input,chromeMode:'overlay-only',brandUrl:'',footerBrandUrl:''});const prepared=placements.prepare(config);
 assert.equal(prepared.config.brandUrl,'');assert.equal(prepared.config.footerBrandUrl,'');
 assert.ok(!prepared.placements.some(p=>p.id==='brand-header'||p.id==='brand-footer'||p.path.startsWith('navLinks.')));
 assert.ok(prepared.placements.some(p=>p.role==='offer-cta'&&p.url===OFFER));
 const restored=placements.prepare({...prepared.config,chromeMode:'custom'});
 assert.equal(restored.config.brandUrl,OFFER);assert.equal(restored.placements.filter(p=>p.id==='brand-header'||p.id==='brand-footer').length,2);
});

test('HTML chrome continues to obey importChrome independently and preserves original header/footer',async()=>{
 const {renderPage,rendererWindow}=await import('../server/lifecycle/render.mjs');
 const html='<header>Source header</header><h1>Source title</h1><a href="'+OFFER.replaceAll('&','&amp;')+'">Visit</a><footer>Source footer</footer>';
 for(const chromeMode of ['custom','overlay-only'])for(const importChrome of ['none','add']){
  const config={...input,contentMode:'html',importHtml:html,importChrome,chromeMode};const rendered=renderPage(config);const dom=new JSDOM(rendered.html);
  try{assert.equal(dom.window.document.querySelectorAll('#pp-landing > .pp-header').length,importChrome==='add'?1:0);assert.equal(dom.window.document.querySelectorAll('#pp-landing > .pp-footer').length,importChrome==='add'?1:0);assert.equal(dom.window.document.querySelector('#pp-imported-content header').textContent,'Source header');assert.equal(dom.window.document.querySelector('#pp-imported-content footer').textContent,'Source footer');const list=placements.create({window:rendererWindow}).list(rendered.config);assert.equal(list.filter(p=>p.id==='brand-header'||p.id==='brand-footer').length,importChrome==='add'?2:0);}finally{dom.window.close();}
 }
});
