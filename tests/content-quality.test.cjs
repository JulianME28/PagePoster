'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../dist/generator.js'),AI=require('../dist/ai-core.js');
const modules=Promise.all([import('../server/ai.mjs'),import('../server/lifecycle/generation.mjs')]);
function config(){const c=AI.createProject(G.DEFAULT_DATA,'Alpha | https://alpha.example/?offer=10%2F#tail');c.cards[0].bonus='10 EUR';c.language='pl';return c;}
function envelope(updates){return {status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({updates,notes:[]})}]}]};}
function results(spec,value){return spec.batches.map(batch=>({index:batch.index,requestId:'quality-'+batch.index,updates:batch.targets.map(target=>({targetId:target.targetId,value})),notes:[]}));}
test('invented offer numbers and licence in an ordinary article block stop generation before config changes',async()=>{
 const [api,gen]=await modules,c=config(),before=JSON.stringify(c),spec=gen.prepareGeneration(c,{mode:'selected',paths:['sections.0.body']});
 const generated=results(spec,'Alpha is licensed in Malta and offers a 500 EUR bonus with 99% payouts.');
 assert.throws(()=>gen.finishGeneration(spec,generated),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');assert.equal(JSON.stringify(c),before);
 const input=api.validateInput({requestId:'manual-facts',brief:spec.brief,targets:spec.batches[0].targets});
 assert.throws(()=>api.parseModelResponse(envelope(generated[0].updates),input),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED'&&e.issues.some(i=>i.code==='UNSUPPORTED_OFFER_CLAIM'));
});
test('generic guidance and exact supplied bonus remain usable while wrong offer association is blocked',async()=>{
 const [,gen]=await modules,c=config(),spec=gen.prepareGeneration(c,{mode:'selected',paths:['sections.0.body']});
 const copy='Alpha has a bonus of 10 EUR. Read the current terms and check the licence before registering. Compare payment conditions and support channels.';
 const completed=gen.finishGeneration(spec,results(spec,copy));assert.equal(completed.cards[0].bonus,'10 EUR');assert.equal(completed.sections[0].body,copy);
 assert.throws(()=>gen.finishGeneration(spec,results(spec,'Alpha has 10 EUR payouts.')),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');
 const multiple=config();multiple.moreCards=[{name:'Beta',bonus:'25 EUR',url:'https://beta.example/'}];const second=gen.prepareGeneration(multiple,{mode:'selected',paths:['sections.0.body']});
 assert.throws(()=>gen.finishGeneration(second,results(second,'Beta has a bonus of 10 EUR.')),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');
});
test('non-numeric unsupported claims require review and an instruction cannot conceal a claim',async()=>{
 const [,gen]=await modules,spec=gen.prepareGeneration(config(),{mode:'selected',paths:['sections.0.body']});
 for(const copy of ['Alpha is licensed in Malta.','Alpha guarantees instant withdrawals.','Check the licence: Alpha is licensed in Malta.','Alpha accepts Visa and Mastercard.','We tested Alpha and verified its payouts.'])assert.throws(()=>gen.finishGeneration(spec,results(spec,copy)),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED',copy);
});
test('fact references resolve verbatim; selected existing offer facts cannot be rewritten',async()=>{
 const [api,gen]=await modules,c=config(),spec=gen.prepareGeneration(c,{mode:'selected',paths:['sections.0.body']}),fact=spec.brief.facts.find(x=>x.fieldPath==='cards.0.bonus');
 const input=api.validateInput({requestId:'facts',brief:spec.brief,targets:spec.batches[0].targets});
 const out=api.parseModelResponse(envelope([{targetId:input.targets[0].targetId,value:'Alpha bonus: [[PP_FACT:'+fact.id+']].'}]),input);assert.equal(out.updates[0].value,'Alpha bonus: 10 EUR.');
 assert.throws(()=>api.parseModelResponse(envelope([{targetId:input.targets[0].targetId,value:'[[PP_FACT:made-up]]'}]),input),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');
 const selected=gen.prepareGeneration(c,{mode:'selected',paths:['cards.0.bonus']});assert.throws(()=>gen.finishGeneration(selected,results(selected,'A welcome bonus of 10 EUR')),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');
});
test('generated fingerprint ignores design, request IDs and unchanged manual copy',async()=>{
 const [,gen]=await modules,c=config();c.title='Manual repeating title';const a=gen.prepareGeneration(c,{mode:'selected',paths:['title','sections.0.body']}),r=results(a,'Useful original guidance.');r[0].updates[0].value=c.title;
 const first=gen.inspectGenerationQuality(a,r);assert.equal(first.state,'passed');assert.match(first.generatedTextFingerprint,/^[0-9a-f]{64}$/);assert.equal(first.generatedFields.length,1);
 const d=config();d.preset='rose';d.colors.accent='#aabbcc';d.title='Different manual title';const b=gen.prepareGeneration(d,{mode:'selected',paths:['sections.0.body']});
 assert.equal(gen.inspectGenerationQuality(b,results(b,'Useful original guidance.')).generatedTextFingerprint,first.generatedTextFingerprint);assert.notEqual(gen.inspectGenerationQuality(b,results(b,'Different original guidance.')).generatedTextFingerprint,first.generatedTextFingerprint);
 assert.equal(gen.inspectGenerationQuality(gen.prepareGeneration(c,{mode:'manual'}),[]).generatedTextFingerprint,null);
});
test('oversize builder URLs remain exact and reject rendering without losing tracking suffix',()=>{
 const long='https://example.com/?track='+'x'.repeat(4000)+'&offer=1669#tail';
 for(const apply of [c=>c.cards[0].url=long,c=>c.cards[0].logoUrl=long,c=>c.promoUrl=long,c=>c.brandUrl=long,c=>c.sections[0].image=long,c=>c.navLinks=[{name:'Manual',url:long}],c=>c.importBaseUrl=long]){const c=config();apply(c);assert.ok(JSON.stringify(G.normalizeConfig(c)).includes(long));assert.ok(G.validateConfig(c).some(w=>/4000/.test(w)));assert.throws(()=>G.renderDocument(c),e=>e.code==='URL_TOO_LONG');}
 const exact='https://example.com/(offer)?id=%2f&sig=a%2Bb#Case',c=config();c.cards[0].url=exact;assert.equal(G.normalizeConfig(c).cards[0].url,exact);assert.ok(G.renderDocument(c).includes('id=%2f&amp;sig=a%2Bb#Case'));
});
test('builder language persists through generation and renders document and fragment language',async()=>{
 const [,gen]=await modules,c=config(),spec=gen.prepareGeneration(c,{mode:'selected',paths:['sections.0.body'],brief:{language:'Polish'}}),out=gen.finishGeneration(spec,results(spec,'Neutral comparison guidance.'));assert.equal(out.language,'pl');assert.equal(G.normalizeConfig(out).language,'pl');assert.match(G.renderDocument(out),/<html lang="pl">/);assert.match(G.renderSnippet(out),/id="pp-landing"[^>]*lang="pl"/);
 const english=gen.prepareGeneration(c,{mode:'selected',paths:['intro'],brief:{language:'English'}});assert.equal(gen.finishGeneration(english,results(english,'Useful guidance.')).language,'en');
});
test('provider errors carry safe specific codes through lifecycle',async()=>{
 const [api,gen]=await modules,spec=gen.prepareGeneration(config(),{mode:'selected',paths:['intro']});
 for(const [status,code] of [[400,'AI_REQUEST_INVALID'],[401,'AI_AUTH_FAILED'],[403,'AI_ACCESS_DENIED'],[404,'AI_MODEL_UNAVAILABLE'],[429,'AI_RATE_LIMITED'],[503,'AI_PROVIDER_UNAVAILABLE']]){const handler=api.createAIHandler({fetchImpl:async()=>new Response(JSON.stringify({error:{message:'private-provider-detail'}}),{status})});await assert.rejects(()=>gen.executeBatch(spec,0,{handler,env:{OPENAI_API_KEY:'test-key'},runId:'errors'}),e=>e.code===code&&!e.message.includes('private-provider-detail'));}
});
test('multiple supplied facts cannot be swapped across brands or financial categories',async()=>{
 const [,gen]=await modules,c=config();c.cards[0].payout='99%';c.moreCards=[{name:'Beta',bonus:'25 EUR',url:'https://beta.example/'}];const spec=gen.prepareGeneration(c,{mode:'selected',paths:['sections.0.body']});
 for(const copy of ['Alpha has a 99% bonus and 10 EUR payouts.','Beta has a 10 EUR bonus while Alpha has a 25 EUR bonus.'])assert.throws(()=>gen.finishGeneration(spec,results(spec,copy)),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');
});
test('browser application protects nonempty offer facts while allowing a blank no-op',()=>{
 const c=config(),plan=AI.makePlan(c,{mode:'selected',paths:['cards.0.bonus']});assert.throws(()=>AI.apply(plan,c,[{targetId:plan.targets[0].targetId,value:'Changed offer'}]),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');assert.equal(c.cards[0].bonus,'10 EUR');assert.equal(AI.apply(plan,c,[{targetId:plan.targets[0].targetId,value:' '}]).emptySkipped,1);
});
test('new numerical claims in offer fields need evidence even without a category word',async()=>{
 const [,gen]=await modules,c=config();c.cards[0].payout='';const spec=gen.prepareGeneration(c,{mode:'selected',paths:['cards.0.payout']});assert.throws(()=>gen.finishGeneration(spec,results(spec,'10 EUR')),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');
});
test('other specific offer claims without supplied evidence also require review',async()=>{
 const [,gen]=await modules,spec=gen.prepareGeneration(config(),{mode:'selected',paths:['sections.0.body']});
 for(const copy of ['Alpha was founded in 2010.','Alpha is headquartered in Malta.','Alpha supports 20 languages.','Alpha is a secure operator.'])assert.throws(()=>gen.finishGeneration(spec,results(spec,copy)),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');
});
test('oversize URL cannot enter an AI plan before a paid request',async()=>{
 const [,gen]=await modules,c=config();c.cards[0].url='https://example.com/?x='+'a'.repeat(4000)+'&offer=last';
 assert.throws(()=>AI.makePlan(c,{mode:'selected',paths:['intro']}),e=>e.code==='URL_TOO_LONG');assert.throws(()=>gen.prepareGeneration(c,{mode:'selected',paths:['intro']}),e=>e.code==='URL_TOO_LONG');
});


test('whole-word subjects and rating categories do not flag parameters or demonstrating',async()=>{
 const {inspectContentQuality}=await import('../server/content-quality.mjs');
 const input={brief:{facts:[{id:'name',fieldPath:'cards.0.name',subject:'param',value:'param'}]},targets:[{targetId:'text',field:'sections.body',fieldPath:'sections.0.body',currentValue:''}]};
 for(const value of ['Parameters are typically strings received from a form.','Are there sample scripts demonstrating this approach?'])assert.equal(inspectContentQuality(input,[{targetId:'text',value}]).state,'passed',value);
 assert.equal(inspectContentQuality(input,[{targetId:'text',value:'param is a secure operator.'}]).state,'review_required');
});
test('questions and instructions to inspect a property are not positive offer claims',async()=>{
 const {inspectContentQuality}=await import('../server/content-quality.mjs');
 const input={brief:{facts:[]},targets:[{targetId:'text',field:'cards.bonus',fieldPath:'cards.0.bonus',currentValue:''}]};
 const value="Read the destination page carefully to understand how the parameter is employed. Compare its usage instructions with your needs.";
 assert.equal(inspectContentQuality(input,[{targetId:'text',value}]).state,'passed');
 for(const value of ['Read the details: Alpha is licensed in Malta.','Read the instructions. Alpha offers a free plan.','Read the guide to understand how it works and Alpha offers a free plan.'])assert.equal(inspectContentQuality(input,[{targetId:'text',value}]).state,'review_required');
});
