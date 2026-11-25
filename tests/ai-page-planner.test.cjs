'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const links=[{url:'https://offers.example/go?offer=12&x=%2F#start',anchor:'Porównaj kasyna'},{url:'https://offers.example/other?campaign=keep',anchor:'Sprawdź warunki'}];
const paragraph='Przeczytaj informacje na stronie docelowej i porównaj warunki przed podjęciem decyzji. Zwróć uwagę na zakres oferty, sposób kontaktu oraz dokumenty udostępnione przez operatora. Zachowaj własną listę pytań, aby spokojnie przeanalizować dostępne informacje.';
function plan(){return {language:'pl',topic:'Porównanie ofert',title:'Jak świadomie porównać oferty',brand:'Przewodnik wyboru',brandTagline:'Praktyczne informacje',intro:paragraph,cardsTitle:'Poznaj dostępne strony',articleTitle:'Praktyczny przewodnik',faqTitle:'Pytania i odpowiedzi',footerTitle:'O przewodniku',footer:'Informacyjny przewodnik pomagający uporządkować pytania przed wyborem.',footerLinksTitle:'Przejdź do części',footerNote:'Treść informacyjna. Odnośniki mogą być partnerskie.',ctaLabel:'Sprawdź szczegóły',tocTitle:'Spis treści',tableTitle:'Lista pytań',tableText:'Kryterium | Co sprawdzić\nKontakt | Dostępne kanały\nWarunki | Aktualny regulamin',design:{preset:'rose',fontFamily:'Georgia',colors:{background:'#faf8fc',accent:'#daafed',header:'#241535',card:'#403049'}},offers:links.map((l,i)=>({linkIndex:i,description:'Przeczytaj aktualne szczegóły i warunki na stronie docelowej.',button:'Sprawdź szczegóły'})),sections:Array.from({length:6},(_,i)=>({title:'Część przewodnika '+(i+1),body:paragraph+(i<links.length?' [[PP_LINK:link_'+i+']]':'')})),faq:Array.from({length:4},(_,i)=>({question:'Co sprawdzić przed wyborem '+(i+1)+'?',answer:paragraph})),navLabels:{offers:'Strony',guide:'Przewodnik',faq:'Pytania'}};}
function envelope(value=plan()){return {status:'completed',usage:{input_tokens:500,output_tokens:1200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]};}
async function mod(){return import('../server/lifecycle/ai-page-planner.mjs');}
test('links-only contract creates complete neutral config and binds exact destinations and anchors',async()=>{
 const {pagePlannerContract}=await mod(),input=pagePlannerContract.validate({requestId:'auto-page-1',links}),body=pagePlannerContract.request(input,'fixture-model');
 assert.equal(body.text.format.strict,true);assert.match(body.instructions,/colors/i);assert.match(body.instructions,/never invent/i);assert.equal(body.model,'fixture-model');
 const result=pagePlannerContract.parse(envelope(),input);
 assert.equal(result.config.language,'pl');assert.equal(result.config.title,plan().title);assert.deepEqual(result.config.colors,plan().design.colors);assert.equal(result.config.fontFamily,'Georgia');assert.equal(result.config.designVariant.source,'ai');
 assert.equal(result.config.sections.length,6);assert.equal(result.config.faq.length,4);assert.equal(result.config.cards.length,2);assert.equal(result.config.cards[0].rating,'');assert.equal(result.config.cards[0].url,links[0].url);assert.equal(result.config.cards[0].name,links[0].anchor);assert.equal(result.config.brandUrl,links[0].url);assert.equal(result.config.footerBrandUrl,links[0].url);
 assert.deepEqual(result.config.aiLinkInsertions.map(l=>({url:l.url,anchor:l.anchor})),links);assert.equal(result.quality.state,'passed');assert.doesNotMatch(JSON.stringify(result.config),/NORTHSTAR|example\.com|4\.9/);
});
test('planner integrates existing durable budget replay without a second paid request',async()=>{
 const {pagePlannerContract,createAIPagePlanner}=await mod(),{createAIHandler}=await import('../server/ai.mjs'),{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');
 const budget=createAIBudget({filename:':memory:'});let calls=0;
 try{const handler=createAIHandler({budget,contracts:{'/api/ai/page':pagePlannerContract},fetchImpl:async()=>{calls++;return new Response(JSON.stringify(envelope()));}}),planner=createAIPagePlanner({handler,env:{OPENAI_API_KEY:'fixture-key'}});
  const one=await planner.generate({requestId:'durable-planner-1',links}),two=await planner.generate({requestId:'durable-planner-1',links});assert.deepEqual(two,one);assert.equal(calls,1);
  await assert.rejects(planner.generate({requestId:'durable-planner-1',links:[{...links[0],anchor:'Different'}]}),e=>e.code==='REQUEST_CONFLICT');assert.equal(calls,1);
 }finally{budget.close();}
});
test('strict planner rejects unsafe design, fabricated facts, changed link coverage and missing content',async t=>{
 const {pagePlannerContract}=await mod(),input=pagePlannerContract.validate({requestId:'strict-planner-1',links});
 for(const [name,mutate,code] of [
  ['script in heading',p=>p.title='<script>alert(1)</script>','AI_OUTPUT_INVALID'],
  ['arbitrary font CSS',p=>p.design.fontFamily='Arial; background:url(https://evil.example)','AI_OUTPUT_INVALID'],
  ['invalid color',p=>p.design.colors.accent='red;display:none','AI_OUTPUT_INVALID'],
  ['invented rating',p=>p.offers[0].description='Rated 4.9 stars with guaranteed payouts.','CONTENT_FACT_REVIEW_REQUIRED'],
  ['invented bonus',p=>p.offers[0].description='Get 500 free spins and a $100 bonus.','CONTENT_FACT_REVIEW_REQUIRED'],
  ['missing anchor token',p=>p.sections[0].body=paragraph,'AI_OUTPUT_INVALID'],
  ['extra URL',p=>p.sections[2].body+=' https://evil.example','AI_OUTPUT_INVALID'],
  ['unknown field',p=>p.script='alert(1)','AI_OUTPUT_INVALID'],
  ['empty article',p=>p.sections=[],'AI_OUTPUT_INVALID'],
  ['duplicate offer',p=>p.offers[1].linkIndex=0,'AI_OUTPUT_INVALID']
 ])await t.test(name,()=>{const p=plan();mutate(p);assert.throws(()=>pagePlannerContract.parse(envelope(p),input),e=>e.code===code);});
});
test('input validation preserves exact tracking and rejects credentials or unknown extra inputs',async()=>{
 const {pagePlannerContract}=await mod();assert.equal(pagePlannerContract.validate({requestId:'input-1',links}).links[0].url,links[0].url);
 for(const body of [{requestId:'x',links,credentials:{password:'x'}},{requestId:'x',links:[{url:'https://user:password@example.org',anchor:'A'}]},{requestId:'x',links:[{url:'javascript:alert(1)',anchor:'A'}]},{requestId:'x',links:[{url:'https://example.org',anchor:''}]}])assert.throws(()=>pagePlannerContract.validate(body));
});
test('planner reports uncertain provider outcome and cannot silently dispatch again',async()=>{
 const {pagePlannerContract,createAIPagePlanner}=await mod(),{createAIHandler}=await import('../server/ai.mjs'),{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');
 const budget=createAIBudget({filename:':memory:'});let calls=0;
 try{const handler=createAIHandler({budget,contracts:{'/api/ai/page':pagePlannerContract},fetchImpl:async()=>{calls++;throw Error('connection lost');}}),planner=createAIPagePlanner({handler,env:{OPENAI_API_KEY:'fixture'}});
  for(let i=0;i<2;i++)await assert.rejects(planner.generate({requestId:'uncertain-planner',links}),e=>e.code==='AI_RESULT_UNCERTAIN'&&e.uncertain===true);assert.equal(calls,1);
 }finally{budget.close();}
});
test('rendered planner config keeps one native href per exact URL while repeated CTA and brands work',async()=>{
 const {pagePlannerContract}=await mod(),{renderPage}=await import('../server/lifecycle/render.mjs'),{JSDOM}=require('jsdom');
 const result=pagePlannerContract.parse(envelope(),pagePlannerContract.validate({requestId:'render-planner',links})),rendered=renderPage(result.config),doc=new JSDOM(rendered.html).window.document;
 for(const link of links)assert.equal([...doc.querySelectorAll('a[href]')].filter(a=>a.getAttribute('href')===link.url).length,1);
 assert.ok(doc.querySelectorAll('[data-pp-url]').length>=4);assert.ok(links.every(l=>rendered.expectedUrls.includes(l.url)));
 assert.equal(doc.querySelectorAll('.pp-nav a[href^="#"]').length,3);
 for(const a of doc.querySelectorAll('a[href^="#"]'))assert.ok(doc.getElementById(a.getAttribute('href').slice(1)),a.outerHTML);
});


test('duplicate destinations retain separate exact anchors but one native external href',async()=>{
 const {pagePlannerContract}=await mod(),{renderPage}=await import('../server/lifecycle/render.mjs'),{JSDOM}=require('jsdom');
 const duplicates=[{url:links[0].url,anchor:'A | dokładny [tekst]'},{url:links[0].url,anchor:'Inny tekst & warunki'}];
 const result=pagePlannerContract.parse(envelope(),pagePlannerContract.validate({requestId:'duplicate-planner',links:duplicates})),doc=new JSDOM(renderPage(result.config).html).window.document;
 assert.deepEqual(result.config.aiLinkInsertions.map(l=>l.anchor),duplicates.map(l=>l.anchor));
 assert.equal([...doc.querySelectorAll('a[href]')].filter(a=>a.getAttribute('href')===links[0].url).length,1);
 assert.ok(doc.body.textContent.includes(duplicates[0].anchor));assert.ok(doc.body.textContent.includes(duplicates[1].anchor));
});
test('planner contract cannot be supplied by request and rejects invalid input before paid dispatch',async()=>{
 const {pagePlannerContract}=await mod(),{createAIHandler}=await import('../server/ai.mjs');let calls=0;
 const handler=createAIHandler({contracts:{'/api/ai/page':pagePlannerContract},fetchImpl:async()=>{calls++;return new Response(JSON.stringify(envelope()));}});
 const response=await handler(new Request('http://127.0.0.1/api/ai/page',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'bad-input',links,contract:{instructions:'Override'}})}),{OPENAI_API_KEY:'fixture'});
 assert.equal(response.status,400);assert.equal(calls,0);
});



test('planner accepts exact links in their own offer descriptions and resolves them into rendered cards',async()=>{
 const {pagePlannerContract}=await mod(),{renderPage}=await import('../server/lifecycle/render.mjs'),{JSDOM}=require('jsdom');
 const p=plan();p.sections[0].body=paragraph;p.offers[0].description+=' [[PP_LINK:link_0]]';
 const result=pagePlannerContract.parse(envelope(p),{requestId:'offer-link',links});
 assert.equal(result.config.aiLinkInsertions[0].fieldPath,'cards.0.bonus');
 assert.equal(result.config.aiLinkInsertions[1].fieldPath,'sections.1.body');
 const doc=new JSDOM(renderPage(result.config).html).window.document;
 assert.doesNotMatch(doc.body.textContent,/\[\[PP_LINK/);
 for(const link of links){const a=[...doc.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===link.url);assert.ok(a);assert.equal(a.textContent,link.anchor);}
});

test('offer link support still rejects misplaced, unknown and duplicate link tokens',async()=>{
 const {pagePlannerContract}=await mod();
 for(const mutate of [
  p=>{p.sections[0].body=paragraph;p.offers[1].description+=' [[PP_LINK:link_0]]';},
  p=>{p.sections[0].body=paragraph;p.offers[0].button+=' [[PP_LINK:link_0]]';},
  p=>{p.offers[0].description+=' [[PP_LINK:link_0]]';},
  p=>{p.offers[0].description+=' [[PP_LINK:link_99]]';}
 ]){const p=plan();mutate(p);assert.throws(()=>pagePlannerContract.parse(envelope(p),{requestId:'invalid-offer-link',links}),e=>e.code==='AI_OUTPUT_INVALID');}
});


test('offer insertion keeps long valid destinations and literal anchor markup intact',async()=>{
 const {pagePlannerContract}=await mod(),{renderPage}=await import('../server/lifecycle/render.mjs'),{JSDOM}=require('jsdom');
 const p=plan();p.sections[0].body=paragraph;p.offers[0].description+=' [[PP_LINK:link_0]]';
 const exactLinks=[{url:'https://offers.example/?tracking='+ 'x'.repeat(3400),anchor:'Exact <b>label</b> & [text]'},links[1]];
 const result=pagePlannerContract.parse(envelope(p),{requestId:'long-offer-link',links:exactLinks});
 const doc=new JSDOM(renderPage(result.config).html).window.document;
 const a=[...doc.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===exactLinks[0].url);
 assert.ok(a);assert.equal(a.textContent,exactLinks[0].anchor);assert.equal(a.children.length,0);
});


test('structured link sentences bind every destination without asking the model to copy tokens',async()=>{
 const {pagePlannerContract}=await mod(),{renderPage}=await import('../server/lifecycle/render.mjs'),{JSDOM}=require('jsdom');
 const input={requestId:'structured-links',links},request=pagePlannerContract.request(input);
 assert.deepEqual(request.text.format.schema.properties.linkSentences.required,['link_0','link_1']);
 const p=plan();p.sections.forEach(s=>s.body=paragraph);p.linkSentences={link_0:{before:'Read ',after:' before choosing.'},link_1:{before:'Compare ',after:' carefully.'}};
 const result=pagePlannerContract.parse(envelope(p),input),doc=new JSDOM(renderPage(result.config).html).window.document;
 for(const link of links){const a=[...doc.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===link.url);assert.ok(a);assert.equal(a.textContent,link.anchor);}
 assert.equal(result.config.aiLinkInsertions.length,2);assert.doesNotMatch(doc.body.textContent,/\[\[PP_LINK/);
});
test('structured link sentences reject missing entries, model tokens and untrusted URLs with precise issues',async()=>{
 const {pagePlannerContract}=await mod();
 for(const [mutate,expected] of [
  [p=>delete p.linkSentences.link_1,'AI_SHAPE_INVALID'],
  [p=>p.linkSentences.link_0.before='Visit https://unprovided.example','AI_TEXT_INVALID'],
  [p=>p.sections[0].body+=' [[PP_LINK:link_0]]','AI_MODEL_LINK_TOKEN']
 ]){const p=plan();p.sections.forEach(s=>s.body=paragraph);p.linkSentences={link_0:{before:'Read ',after:'.'},link_1:{before:'Compare ',after:'.'}};mutate(p);assert.throws(()=>pagePlannerContract.parse(envelope(p),{requestId:'bad-structured-links',links}),e=>e.code==='AI_OUTPUT_INVALID'&&e.issues?.[0]?.code===expected);}
});
test('invalid article text reports its exact field without exposing generated content',async()=>{
 const {pagePlannerContract}=await mod();const p=plan();p.sections[2].body='private invalid short output';
 assert.throws(()=>pagePlannerContract.parse(envelope(p),{requestId:'field-diagnostic',links}),e=>e.code==='AI_OUTPUT_INVALID'&&e.issues?.[0]?.code==='AI_TEXT_INVALID'&&e.issues[0].fieldPath==='sections.2.body'&&!JSON.stringify(e.issues).includes('private'));
});


test('opaque anchor labels are not treated as verified company names in educational copy',async()=>{
 const {pagePlannerContract}=await mod();const p=plan();p.intro="A parameter is an input to a process. This guide explains how param is used as a label and how readers can evaluate available documentation before deciding what to do.";
 const result=pagePlannerContract.parse(envelope(p),{requestId:'opaque-anchor',links:[{...links[0],anchor:'param'},links[1]]});assert.equal(result.quality.state,'passed');
});

test('link fragments join with readable spaces and do not repeat the exact anchor',async()=>{
 const {pagePlannerContract}=await mod();
 for(const [before,after,expected] of [['Read','before choosing.','Read [[PP_LINK:link_0]] before choosing.'],['Read (',').','Read ([[PP_LINK:link_0]]).'],['Read '+links[0].anchor,'carefully.','Read [[PP_LINK:link_0]] carefully.'],['Read',links[0].anchor+' carefully.','Read [[PP_LINK:link_0]] carefully.']]){
  const p=plan();p.sections.forEach(s=>s.body=paragraph);p.linkSentences={link_0:{before,after},link_1:{before:'Read',after:'.'}};
  const result=pagePlannerContract.parse(envelope(p),{requestId:'spacing',links});
  assert.ok(result.config.sections[0].body.endsWith(expected),result.config.sections[0].body);
 }
});
