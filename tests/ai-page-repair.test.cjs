const test=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./fixtures/ai-stability/casino-descriptive.json');
const envelope=value=>({status:'completed',usage:{input_tokens:500,output_tokens:600},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
async function setup(t,repair,editorial){
 const {pagePlannerContracts,createAIPagePlanner}=await import('../server/lifecycle/ai-page-planner.mjs');
 const {createAIHandler}=await import('../server/ai.mjs');const {createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');
 const budget=createAIBudget({filename:':memory:'});t.after(()=>budget.close());const calls=[];
 const plan=structuredClone(fixture.plan);if(editorial)plan.sections.forEach(section=>{while(section.body.length<700)section.body+=' '+section.body;});plan.offers[0].description='This casino offers a 500 EUR bonus with guaranteed withdrawals.';
 const handler=createAIHandler({budget,contracts:pagePlannerContracts,fetchImpl:async(url,options)=>{
  const req=JSON.parse(options.body);calls.push(req);
  if(calls.length===1)return new Response(JSON.stringify(envelope(plan)));
  if(repair==='network')throw new Error('disconnected');
  const fields=JSON.parse(req.input).fields;
  const updates=Object.fromEntries(Object.keys(fields).map(key=>[key,repair==='invalid'?'This casino offers a 900 EUR bonus with guaranteed payouts.':'Read the destination page and compare its published terms before deciding.']));
  return new Response(JSON.stringify(envelope({updates})));
 }});
 return {calls,budget,planner:createAIPagePlanner({handler,env:{OPENAI_API_KEY:'fixture'}}),input:{...fixture.input,requestId:'repair-test',...(editorial?{editorial}:{})}};
}
test('one targeted repair is charged, validated and replayed without extra requests',async t=>{
 const {planner,input,calls,budget}=await setup(t);
 const result=await planner.generate(input);assert.equal(result.quality.state,'passed');assert.equal(result.requestId,input.requestId);assert.equal(calls.length,2);
 assert.deepEqual(Object.keys(JSON.parse(calls[1].input).fields),['offers.0.description']);
 assert.deepEqual(result.config.aiLinkInsertions.map(({url,anchor})=>({url,anchor})),input.links);
 assert.ok(result.repair.requestId);assert.equal(budget.status().counts.completed,2);
 const used=budget.status().spentTokens;assert.deepEqual(await planner.generate(input),result);assert.equal(calls.length,2);assert.equal(budget.status().spentTokens,used);
});
test('a failed repair cannot trigger a third paid request on resume',async t=>{
 const {planner,input,calls,budget}=await setup(t,'invalid');
 await assert.rejects(planner.generate(input),e=>e.code==='CONTENT_FACT_REVIEW_REQUIRED');assert.equal(calls.length,2);
 await assert.rejects(planner.generate(input),e=>e.code==='AI_REQUEST_REJECTED');assert.equal(calls.length,2);assert.equal(budget.status().counts.rejected,1);
});
test('uncertain repair remains reserved and is never silently retried',async t=>{
 const {planner,input,calls,budget}=await setup(t,'network');
 for(let i=0;i<2;i++)await assert.rejects(planner.generate(input),e=>e.code==='AI_RESULT_UNCERTAIN');
 assert.equal(calls.length,2);assert.equal(budget.status().counts.uncertain,1);assert.ok(budget.status().reservedUSD>0);
});

test('repair cannot change links, structure or fields outside the selected set',async()=>{
 const {pagePlannerContracts}=await import('../server/lifecycle/ai-page-planner.mjs');
 const plan=structuredClone(fixture.plan);plan.offers[0].description='This casino offers a 500 EUR bonus with guaranteed withdrawals.';
 const input={...fixture.input,requestId:'repair-validation',variation:'',plan},contract=pagePlannerContracts['/api/ai/page-repair'];
 for(const updates of [{'offers.0.description':'Visit https://evil.example/ for details.'},{'offers.0.description':'Read the destination page and compare all available terms.','brandUrl':'https://evil.example/'},{'offers.0.description':'<script>alert(1)</script>'}])assert.throws(()=>contract.parse(envelope({updates}),input),e=>e.code==='AI_OUTPUT_INVALID');
 const result=contract.parse(envelope({updates:{'offers.0.description':'Read the destination page and compare all published terms before deciding.'}}),input);
 assert.deepEqual(result.config.sections.map(s=>s.title),plan.sections.map(s=>s.title));assert.equal(result.config.title,plan.title);assert.deepEqual(result.config.colors,plan.design.colors);
});
test('repair of an article also reviews its separate anchor sentence fragments',async()=>{
 const {pagePlannerContracts}=await import('../server/lifecycle/ai-page-planner.mjs');
 const plan=structuredClone(fixture.plan);plan.linkSentences.link_0.after=' offers a 500 EUR bonus with guaranteed withdrawals.';
 const input={...fixture.input,requestId:'repair-sentence',variation:'',plan},req=pagePlannerContracts['/api/ai/page-repair'].request(input);
 assert.deepEqual(Object.keys(JSON.parse(req.input).fields),['linkSentences.link_0.after','linkSentences.link_0.before','sections.0.body']);
});

test('text format errors are repaired as data without returning an unsafe config',async()=>{
 const {pagePlannerContracts,pagePlannerContract}=await import('../server/lifecycle/ai-page-planner.mjs');
 const plan=structuredClone(fixture.plan);plan.sections[0].body+=' Example: https://example.com/?param=value';
 const input={...fixture.input,requestId:'text-repair',variation:''},pending=pagePlannerContracts['/api/ai/page'].parse(envelope(plan),input);
 assert.equal(pending.quality.state,'review_required');assert.equal(pending.config,undefined);
 assert.equal(pending.quality.issues[0].code,'AI_TEXT_INVALID');assert.throws(()=>pagePlannerContract.parse(envelope(plan),input));
 const repair={...input,plan},contract=pagePlannerContracts['/api/ai/page-repair'];const keys=Object.keys(JSON.parse(contract.request(repair).input).fields);
 const updates=Object.fromEntries(keys.map(key=>[key,key==='sections.0.body'?fixture.plan.sections[0].body:'']));
 const final=contract.parse(envelope({updates}),repair);assert.equal(final.quality.state,'passed');assert.equal(final.config.title,plan.title);
});

test('recorded real repair removes a technical example URL and keeps exact anchors',async()=>{
 const {pagePlannerContracts}=await import('../server/lifecycle/ai-page-planner.mjs');
 const sample=require('./fixtures/ai-repair-response.json');
 const result=pagePlannerContracts['/api/ai/page-repair'].parse(envelope(sample.output),sample.input);
 assert.equal(result.quality.state,'passed');assert.deepEqual(result.config.aiLinkInsertions.map(({url,anchor})=>({url,anchor})),sample.input.links);
 assert.doesNotMatch(result.config.sections[0].body,/https?:\/\//);
});

test('targeted repair preserves explicit custom topic and format through the budget replay',async t=>{
 const editorial={format:'discussion',topic:'custom',customTopic:'The role of chance in poker',language:'en'}, {planner,input,calls}=await setup(t,undefined,editorial);
 const result=await planner.generate(input);assert.equal(result.config.editorialFormat,'discussion');assert.equal(result.quality.state,'passed');assert.equal(calls.length,2);
 assert.equal(JSON.parse(calls[1].input).editorial.language,'en');assert.equal(JSON.parse(calls[1].input).editorial.subject,editorial.customTopic);assert.equal(JSON.parse(calls[1].input).editorial.format,'discussion');
 assert.deepEqual(await planner.generate(input),result);assert.equal(calls.length,2);
 await assert.rejects(planner.generate({...input,editorial:{...editorial,format:'guide'}}),e=>e.code==='REQUEST_CONFLICT');assert.equal(calls.length,2);
});
