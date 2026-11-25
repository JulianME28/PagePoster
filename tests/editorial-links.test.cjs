const test=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const G=require('../dist/generator.js');
async function example(){
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs');
 const {input,plan}=require('./fixtures/editorial/article-casino.json');
 return c.parse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]},input).config;
}

test('all generated formats keep visit actions in cards, never in the introduction',async()=>{
 const config=await example();
 for(const editorialFormat of ['article','guide','comparison','discussion','blog_post','faq']){
  const doc=new JSDOM(G.renderSnippet({...config,editorialFormat})).window.document;
  assert.equal(doc.querySelectorAll('.pp-hero a,.pp-hero [data-pp-url],.pp-hero .pp-action').length,0,editorialFormat);
  assert.equal(doc.querySelectorAll('.pp-resource .pp-cta').length,config.cards.length,editorialFormat);
 }
});
test('editorial output has a native casino CTA and one shared chrome link, with no prose links',async()=>{
 const config=await example(),doc=new JSDOM(G.renderSnippet(config)).window.document;
 const external=[...doc.querySelectorAll('a[href^="https:"]')];
 assert.equal(external.length,2);
 assert.ok(external.some(a=>a.matches('.pp-resource .pp-cta')));
 assert.equal(external.filter(a=>a.closest('header,footer')).length,1);
 assert.equal(doc.querySelectorAll('.pp-prose a,.pp-resource-copy a').length,0);
 assert.doesNotMatch(doc.body.textContent,/casinotest\d|\[\[PP_/);
 for(const a of doc.querySelectorAll('header a,footer a'))assert.equal(a.getAttribute('href')||a.getAttribute('data-pp-url'),config.brandUrl);
});
test('multiple destinations keep one native card link each plus a single shared chrome destination',async()=>{
 const config=await example();config.cards[1].url='https://second.example/path?x=%2f';
 const doc=new JSDOM(G.renderSnippet(config)).window.document;
 const urls=[...doc.querySelectorAll('a[href^="https:"]')].map(a=>a.getAttribute('href'));
 assert.equal(urls.filter(u=>u===config.cards[0].url).length,2);
 assert.equal(urls.filter(u=>u===config.cards[1].url).length,1);
 config.chromeMode='overlay-only';
 const overlay=new JSDOM(G.renderSnippet(config)).window.document;
 assert.equal(overlay.querySelectorAll('header,footer').length,0);
 assert.equal(overlay.querySelectorAll('a[href^="https:"]').length,2);
});
