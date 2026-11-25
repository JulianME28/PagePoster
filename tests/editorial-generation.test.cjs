const test=require('node:test'),assert=require('node:assert/strict');
const input={requestId:'editorial-test',links:[{url:'https://example.org/go?keep=%2F',anchor:'opaque123'}],editorial:{format:'guide',topic:'casino',customTopic:''}};
test('supported explicit languages drive generation and reject unsupported or mismatched language',async()=>{
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs');
 const fixture=require('./fixtures/editorial/article-casino.json');
 for(const [language,name] of Object.entries({en:'English',es:'Spanish',pl:'Polish',de:'German',fr:'French'})){
  const selected={...input,editorial:{...input.editorial,language}},r=c.request(selected);
  assert.equal(c.validate(selected).editorial.language,language);
  assert.equal(JSON.parse(r.input).editorial.language,language);
  assert.match(r.instructions,new RegExp('complete '+name+' editorial page'));
  assert.deepEqual(r.text.format.schema.properties.language.enum,[language]);
 }
 for(const language of ['xx','EN','',null,42])assert.throws(()=>c.validate({...input,editorial:{...input.editorial,language}}),e=>e.code==='VALIDATION');
 const request={...fixture.input,editorial:{...fixture.input.editorial,language:'es'}};
 const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(fixture.plan)}]}]};
 assert.throws(()=>c.parse(response,request),e=>e.issues?.some(i=>i.code==='AI_LANGUAGE_INVALID'));
 assert.equal(Object.hasOwn(c.validate(input).editorial,'language'),false,'Old paid requests keep their original identity');
});
test('editorial navigation labels use the selected language',()=>{
 const G=require('../dist/generator.js');
 for(const [language,menu,contents] of [['es','Menú','Índice'],['de','Menü','Inhaltsverzeichnis'],['pl','Menu','Spis treści'],['fr','Menu','Sommaire']]){
  const html=G.renderSnippet({...G.DEFAULT_DATA,editorialFormat:'article',language,showToc:true});
  assert.ok(html.includes('<summary>'+menu+'</summary>'));assert.ok(html.includes('aria-label="'+contents+'"'));
 }
});
test('explicit topic drives the editorial brief independently of opaque anchors',async()=>{
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs');
 const normalized=c.validate(input),r=c.request(normalized),brief=JSON.parse(r.input);
 assert.deepEqual(normalized.editorial,input.editorial);
 assert.equal(brief.editorial.subject,'Online casinos');assert.equal(brief.editorial.language,'en');
 assert.match(r.instructions,/numbered steps/i);assert.doesNotMatch(r.instructions,/Infer a coherent topic/);
 assert.match(r.instructions,/worked example/i);assert.match(r.instructions,/not instructions/i);
 assert.equal(brief.links[0].anchor,'opaque123');
});
test('editorial choices validate before a paid request, custom topics remain data',async()=>{
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs');
 for(const editorial of [{format:'x',topic:'casino',customTopic:''},{format:'article',topic:'custom',customTopic:' '},{format:'article',topic:'slots',customTopic:'',rogue:1},{format:'article',topic:'custom',customTopic:'a'.repeat(501)}])
  assert.throws(()=>c.validate({...input,editorial}),e=>e.code==='VALIDATION');
 const custom={format:'discussion',topic:'custom',customTopic:'Poker tournament pacing'};
 const r=c.request({...input,editorial:custom});
 assert.equal(JSON.parse(r.input).editorial.subject,custom.customTopic);
 assert.ok(!r.instructions.includes(custom.customTopic));
 assert.ok(!Object.hasOwn(c.validate({requestId:input.requestId,links:input.links}),'editorial'));
});
test('six formats have different editorial direction and render layouts without losing links',async()=>{
 const {pagePlannerContract:c}=await import('../server/lifecycle/ai-page-planner.mjs'),G=require('../dist/generator.js');
 const instructions=new Set();
 for(const format of ['article','guide','comparison','discussion','blog_post','faq']){
  instructions.add(c.request({...input,editorial:{...input.editorial,format}}).instructions);
  const config={...G.DEFAULT_DATA,editorialFormat:format,sections:[{title:'First detail',body:'Unique narrative text'},{title:'Second detail',body:'Another detail'}],cards:[{name:'opaque123',url:input.links[0].url,button:'VISIT CASINO'}],faq:[{question:'A real question?',answer:'An answer.'}],tableText:'Choice | Meaning\nA | Example',showToc:true};
  assert.equal(G.normalizeConfig(config).editorialFormat,format);
  const html=G.renderSnippet(config);
  assert.match(html,new RegExp('pp-format-'+format));assert.match(html,/Unique narrative text/);
  assert.match(html,/keep=%2F/);
  if(format==='faq')assert.ok(html.indexOf('id="pp-faq"')<html.indexOf('id="pp-article"'));
  else if(format!=='blog_post')assert.ok(html.indexOf('id="pp-offers"')<html.indexOf('id="pp-article"'),'Readers see the destination cards before the long article');
  else assert.ok(html.indexOf('id="pp-article"')<html.indexOf('id="pp-offers"'));
 }
 assert.equal(instructions.size,6);
});

test('the main entry and standalone studio expose the same editorial controls',()=>{
 const fs=require('node:fs'),path=require('node:path');assert.equal(fs.readFileSync(path.join(__dirname,'../dist/index.html'),'utf8').trim(),fs.readFileSync(path.join(__dirname,'../dist/autopilot.html'),'utf8').trim());
});
test('editorial review distinguishes illustrative game mechanics from unverified operator offers',async()=>{
 const {inspectContentQuality:inspect}=await import('../server/content-quality.mjs');
 const check=(text,editorial=true,fieldPath='sections.0.body')=>inspect({brief:{facts:[],claimSubjects:['casinotest1'],editorial},targets:[{targetId:'copy',field:fieldPath,fieldPath,currentValue:''}]},[{targetId:'copy',value:text}]).state;
 assert.equal(check('For example, in a slot with 5 reels and 25 fixed paylines, matching symbols must follow a line to count towards a payout.'),'passed');
 assert.equal(check("Alternatively, in an 'Over 2.5 Goals' market, the bet concerns whether the combined goals scored by both teams exceed 2.5."),'passed');
 for(const text of ['For example, casinotest1 offers a payout after 5 minutes.','For example, this casino offers 25 free spins.','For example, a casino guarantees a 95% winning chance.','For example, casinotest1 offers a game with 25 paylines.'])
  assert.equal(check(text),'review_required',text);
 assert.equal(check('For example, 25 paylines improve the payout.',true,'cards.0.bonus'),'review_required');
 assert.equal(check('For example, in a slot with 5 reels and 25 fixed paylines, matching symbols must follow a line to count towards a payout.',false),'review_required');
});
