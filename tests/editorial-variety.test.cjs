const test=require('node:test'),assert=require('node:assert/strict'),{JSDOM}=require('jsdom');
const G=require('../dist/generator.js');
test('new editorial assignments have distinct focuses and colors with stable replay',async()=>{
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs');
 const fixture=require('./fixtures/languages/en.json'),focuses=new Set(),colors=new Set();
 for(let i=0;i<24;i++){
  const input={...fixture.input,variation:'editorial-v2:'+i+':test'};
  const request=c.request(input),brief=JSON.parse(request.input).editorial;
  focuses.add(brief.focus);assert.ok(brief.writingApproach);assert.deepEqual(c.request(input),request);
  const {config}=c.parse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(fixture.plan)}]}]},input);
  assert.equal(config.editorialVariant,i);assert.equal(G.normalizeConfig(config).editorialVariant,i);
  const html=G.renderSnippet(config),doc=new JSDOM(html).window.document;
  const color=/--pp-accent:([^;!]+)/.exec(html)[1];colors.add(color);
  assert.equal(G.renderSnippet(JSON.parse(JSON.stringify(config))),html);
  assert.equal(doc.querySelectorAll('.pp-hero .pp-cta,.pp-prose a').length,0);
  assert.equal(doc.querySelectorAll('a[href^="https:"]').length,2);
 }
 assert.equal(focuses.size,24);assert.equal(colors.size,24);
});
test('custom topic and selected language stay intact while assignments vary',async()=>{
 const {editorialData}=await import('../server/lifecycle/editorial-brief.mjs');
 const topic={format:'article',topic:'custom',customTopic:'Coffee roasting',language:'pl'};
 const a=editorialData(topic,'editorial-v2:0:test'),b=editorialData(topic,'editorial-v2:1:test');
 assert.equal(a.subject,topic.customTopic);assert.equal(a.language,'pl');assert.notEqual(a.focus,b.focus);
 assert.ok(!Object.hasOwn(editorialData(topic,'old-run-id'),'writingApproach'));
 assert.ok(!Object.hasOwn(G.normalizeConfig({...G.DEFAULT_DATA,editorialVariant:'1;bad'}),'editorialVariant'));
});

test('changing only a title or palette cannot disguise repeated article copy',async()=>{
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs');
 const f=require('./fixtures/languages/en.json');
 function parse(plan,sequence){return c.parse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(plan)}]}]},{...f.input,variation:'editorial-v2:'+sequence+':test'});}
 const first=parse(f.plan,0),changed=structuredClone(f.plan);changed.title='A different title for the same article';
 assert.equal(parse(changed,1).quality.generatedTextFingerprint,first.quality.generatedTextFingerprint);
 changed.sections[0].body+='\n\nThis explanation considers another hypothetical situation in which the available information changes before a decision.';
 assert.notEqual(parse(changed,2).quality.generatedTextFingerprint,first.quality.generatedTextFingerprint);
});

test('an opaque label repeated by the model is not exposed in a casino card',()=>{
 for(const name of ['casinotest1','label[1]','test+value']){
  const config={...G.DEFAULT_DATA,editorialFormat:'article',cards:[{name,url:'https://offer50.example/',bonus:'Visit '+name+' to read the published details.',button:'Visit casino'}],moreCards:[]};
  const doc=new JSDOM(G.renderSnippet(config)).window.document;
  assert.equal(doc.querySelector('.pp-resource-copy').textContent,'Visit offer50.example to read the published details.');
  assert.equal(doc.querySelector('.pp-resource .pp-cta').getAttribute('href'),'https://offer50.example/');
 }
});
