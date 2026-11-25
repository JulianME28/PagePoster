'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const AI=require('../dist/ai-core.js');
const G=require('../dist/generator.js');
const api=import('../server/ai.mjs');
const urls=['https://one.example/?offer=1&exact=%2F','https://two.example/(guide)?offer=2'];
const entries=[{id:'link_a',fieldPath:'sections.0.body',url:urls[0],anchor:'Exact [first] & label',count:1},{id:'link_b',fieldPath:'sections.1.body',url:urls[1],anchor:'Точний другий анкор',count:1}];
function data(){return AI.createProject(G.DEFAULT_DATA,urls.join('\n'),{cardCount:10});}
function planFor(value){return AI.makePlan(value,{mode:'selected',paths:entries.map(x=>x.fieldPath),linkInsertions:entries});}
function updates(plan){return plan.targets.map((target,index)=>({targetId:target.targetId,value:'Useful original text [[PP_LINK:'+entries[index].id+']] with **details**.'}));}
function envelope(result){return {status:'completed',usage:{input_tokens:20,output_tokens:30},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({updates:result,notes:[]})}]}]};}
function request(body){return new Request('http://127.0.0.1:4317/api/ai/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
test('two exact URLs can create ten cards and explicit token placements survive a validated apply',async()=>{
 const value=data();assert.equal(value.cards.length+value.moreCards.length,10);assert.deepEqual([...new Set([...value.cards,...value.moreCards].map(x=>x.url))],urls);
 const plan=planFor(value);assert.equal(plan.targets[0].fieldPath,'sections.0.body');assert.deepEqual(plan.targets[0].allowedLinks,[{id:'link_a',url:urls[0],anchor:entries[0].anchor,count:1}]);
 assert.equal(value.aiLinkInsertions,undefined);const update=updates(plan);const module=await api;const input=module.validateInput({requestId:'tokens',brief:{},targets:plan.targets});
 assert.equal(module.parseModelResponse(envelope(update),input).updates.length,2);assert.equal(AI.apply(plan,value,update).applied,2);assert.deepEqual(value.aiLinkInsertions,entries);
 const followup=AI.makePlan(value,{mode:'selected',paths:['sections.0.body']});assert.equal(followup.targets[0].allowedLinks[0].anchor,entries[0].anchor);
});
test('wrong-field, missing, duplicate, invented tokens and raw URLs are rejected by server and client before mutation',async()=>{
 const module=await api;
 for(const bad of ['Text [[PP_LINK:link_b]]','Text without token','[[PP_LINK:link_a]] [[PP_LINK:link_a]]','[[PP_LINK:invented]]','[[PP_LINK:link_a]] https://invented.example/','[[PP_LINK:link_a]] [click](https://invented.example/)','[[PP_LINK:link_a','[[PP_LINK:link_a]] [[PP_LINK:bad!]]']){
  const value=data(),before=JSON.stringify(value),plan=planFor(value),update=updates(plan);update[0].value=bad;
  const input=module.validateInput({requestId:'tokens',brief:{},targets:plan.targets});assert.throws(()=>module.parseModelResponse(envelope(update),input));assert.throws(()=>AI.apply(plan,value,update));assert.equal(JSON.stringify(value),before);
 }
});
test('manual anchors and occurrences are immutable; blank is a no-op; moved rows and changed link metadata are stale',()=>{
 const value=data();value.sections[0].body='Manual [exact anchor](https://manual.example/(x)?a=%2F).';const plan=planFor(value),update=updates(plan);
 update[0].value='[changed anchor](https://manual.example/(x)?a=%2F). [[PP_LINK:link_a]]';assert.throws(()=>AI.apply(plan,value,update));
 update[0].value=' ';assert.throws(()=>AI.apply(plan,value,update));assert.equal(value.aiLinkInsertions,undefined);
 const ordinary=AI.makePlan(value,{mode:'selected',paths:['sections.0.body']});AI.apply(ordinary,value,[{targetId:ordinary.targets[0].targetId,value:' '}]);assert.equal(value.sections[0].body,'Manual [exact anchor](https://manual.example/(x)?a=%2F).');
 const moved=data(),movePlan=planFor(moved);moved.sections.reverse();assert.equal(AI.apply(movePlan,moved,updates(movePlan)).conflicts,2);assert.equal(moved.aiLinkInsertions,undefined);
 const changed=data(),old=planFor(changed);changed.aiLinkInsertions=[{...entries[0],url:'https://manual-change.example/'}];assert.equal(AI.apply(old,changed,updates(old)).conflicts,2);
});
test('request contract validates exact body field placement and bounded IDs, counts, safe URLs',async()=>{
 const module=await api,value=data(),plan=planFor(value),original={requestId:'tokens',brief:{},targets:plan.targets};
 for(const patch of [{fieldPath:'title'},{allowedLinks:[{...plan.targets[0].allowedLinks?.[0],id:'bad space'}]},{allowedLinks:[{id:'a',url:'javascript:alert(1)',anchor:'A',count:1}]},{allowedLinks:[{id:'a',url:urls[0],anchor:'A',count:11}]}]){
  const input=JSON.parse(JSON.stringify(original));Object.assign(input.targets[0],patch);assert.throws(()=>module.validateInput(input));
 }
});
test('budget reserves exact provider body, replays completed responses, blocks same-ID redispatch and retains unknown costs',async()=>{
 const module=await api,{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');const budget=createAIBudget({filename:':memory:'});let calls=0;const value=data(),plan=planFor(value),body={requestId:'budget-good',brief:{},targets:plan.targets};
 const handler=module.createAIHandler({budget,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(envelope(updates(plan))));}});
 try{
  assert.equal((await handler(request(body),{OPENAI_API_KEY:'test-key'})).status,200);assert.equal((await handler(request(body),{OPENAI_API_KEY:'test-key'})).status,200);assert.equal(calls,1);assert.equal(budget.status().counts.completed,1);assert.equal(budget.status().reservedUSD,0);
  const conflict={...body,brief:{topic:'changed'}};assert.equal((await handler(request(conflict),{OPENAI_API_KEY:'test-key'})).status,409);assert.equal(calls,1);
  const uncertain=module.createAIHandler({budget,fetchImpl:async()=>{calls++;throw new Error('Unknown connection outcome');}});body.requestId='budget-unknown';let response=await uncertain(request(body),{OPENAI_API_KEY:'test-key'});assert.equal((await response.json()).code,'AI_RESULT_UNCERTAIN');assert.equal(budget.status().counts.uncertain,1);assert.ok(budget.status().reservedUSD>0);await uncertain(request(body),{OPENAI_API_KEY:'test-key'});assert.equal(calls,2);
 }finally{budget.close();}
});
test('definite provider rejection releases reservation; billed invalid output records usage; missing usage stays uncertain',async()=>{
 const module=await api,{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs'),value=data(),plan=planFor(value);
 for(const [status,payload,state] of [[401,{},'rejected'],[503,{},'uncertain'],[200,{...envelope(updates(plan)),output:[]},'rejected'],[200,{...envelope(updates(plan)),usage:undefined},'uncertain']]){
  const budget=createAIBudget({filename:':memory:'});try{const handler=module.createAIHandler({budget,fetchImpl:async()=>new Response(JSON.stringify(payload),{status})});await handler(request({requestId:'budget-case',brief:{},targets:plan.targets}),{OPENAI_API_KEY:'test-key'});assert.equal(budget.status().counts[state],1);}finally{budget.close();}
 }
});

const {JSDOM}=require('jsdom');
const UI=require('../dist/ai-ui.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function uiHarness({response}={}){
 const dom=new JSDOM('<div id="ai"></div>',{url:'http://127.0.0.1:4317'}),element=dom.window.document.getElementById('ai');let config=data(),revision=0;const calls=[];
 const controller=UI.create({element,core:AI,protocol:'http:',getData:()=>config,getRevision:()=>revision,replaceData:value=>{config=value;revision++;},toast:()=>{},fetch:async(url,options={})=>{
  calls.push({url,options});if(url.endsWith('/status'))return {ok:true,json:async()=>({configured:true,budget:{limits:{usd:10},spentUSD:1.25,reservedUSD:.5,remainingUSD:8.25,counts:{uncertain:0}}})};
  const body=JSON.parse(options.body);if(response)return response(body);
  return {ok:true,json:async()=>({requestId:body.requestId,updates:body.targets.map(t=>({targetId:t.targetId,value:'Useful copy '+t.allowedLinks.map(l=>'[[PP_LINK:'+l.id+']]').join(' ') })),notes:[]})};
 }});
 controller.refresh();
 return {dom,element,calls,controller,get data(){return config;},input(name,value){const node=element.querySelector('[data-ai-input="'+name+'"]');assert.ok(node,'Missing '+name);node.value=value;node.dispatchEvent(new dom.window.Event('input',{bubbles:true}));},click(action){const node=element.querySelector('[data-ai-action="'+action+'"]');assert.ok(node,'Missing action '+action);node.click();}};
}
test('AI UI inserts exact field-scoped anchor through preview/apply and displays real budget status',async()=>{
 const h=uiHarness();try{await tick();assert.match(h.element.textContent,/1[.,]25/);h.input('linkField','sections.0.body');h.input('linkUrl',urls[0]);h.input('linkAnchor','My exact [anchor] & text');h.click('add-link');assert.equal(h.data.aiLinkInsertions,undefined);
 h.click('generate');await tick();assert.equal(h.calls.filter(x=>x.url.endsWith('/generate')).length,1);assert.match(h.element.textContent,/My exact \[anchor\] & text/);h.click('apply');assert.equal(h.data.aiLinkInsertions[0].anchor,'My exact [anchor] & text');assert.equal(h.data.aiLinkInsertions[0].url,urls[0]);assert.match(h.data.sections[0].body,/\[\[PP_LINK:/);
 }finally{h.dom.window.close();}
});
test('AI UI stops uncertain batches, keeps non-secret request identity and never automatically retries',async()=>{
 const h=uiHarness({response:body=>({ok:false,json:async()=>({requestId:body.requestId,code:'AI_RESULT_UNCERTAIN',error:'Результат або витрати невідомі; повтор автоматично не виконується.'})})});
 try{await tick();h.click('all');h.click('generate');await tick();await tick();assert.equal(h.calls.filter(x=>x.url.endsWith('/generate')).length,1);assert.match(h.element.textContent,/повтор автоматично не виконується/);const saved=JSON.parse(h.dom.window.sessionStorage.getItem('pageposter-ai-pending-v1'));assert.match(saved.requestId,/^[a-zA-Z0-9_-]+$/);assert.equal(saved.state,'uncertain');assert.deepEqual(Object.keys(saved).sort(),['requestId','state']);assert.equal(h.data.intro,'');}finally{h.dom.window.close();}
});
test('AI UI can stage ten cards from two URLs without changing existing draft until Apply',async()=>{
 const h=uiHarness();try{await tick();const workflow=h.element.querySelector('[data-ai-input="workflow"][value="new"]');workflow.checked=true;workflow.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));h.input('links',urls.join('\n'));h.input('cardCount','10');h.click('prepare');assert.match(h.element.textContent,/10 пропозицій/);h.click('none');const field=h.element.querySelector('[data-ai-path="intro"]');field.checked=true;field.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));h.click('generate');await tick();h.click('apply');assert.equal(h.data.cards.length+h.data.moreCards.length,10);assert.deepEqual([...new Set([...h.data.cards,...h.data.moreCards].map(x=>x.url))],urls);}finally{h.dom.window.close();}
});
