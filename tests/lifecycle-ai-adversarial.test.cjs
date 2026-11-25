"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const AI=require('../dist/ai-core.js');
const G=require('../dist/generator.js');
const Registry=require('../dist/link-placements.js');
const apiModule=import('../server/ai.mjs');
const budgetModule=import('../server/lifecycle/ai-budget.mjs');
const exactUrl='https://partner.example/a)b(?offer=12&x=%2F#KEEP';
const exactAnchor='Порівняй [A] & <B> "C" **D**';
const entry={id:'review_link',fieldPath:'sections.0.body',url:exactUrl,anchor:exactAnchor,count:1};
function setup(body=''){
 const config=AI.createProject(G.DEFAULT_DATA,exactUrl,{cardCount:3});config.sections[0].body=body;config.sections[0].title='Manual section';
 return {config,plan:AI.makePlan(config,{mode:'selected',paths:['sections.0.body'],linkInsertions:[entry]})};
}
function update(plan,value){return [{targetId:plan.targets[0].targetId,value}];}
function responseBody(updates,usage={input_tokens:20,output_tokens:30}){return {status:'completed',usage,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({updates,notes:[]})}]}]};}
function request(body){return new Request('http://127.0.0.1:4317/api/ai/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
async function validate(plan,updates){const api=await apiModule;return api.parseModelResponse(responseBody(updates),api.validateInput({requestId:'adversarial-check',brief:{},targets:plan.targets}));}

test('exact special-character anchors survive API -> apply -> normalize -> renderer with a single preferred article href',async()=>{
 const {config,plan}=setup(),updates=update(plan,'Read **[[PP_LINK:review_link]]** with care.');await validate(plan,updates);assert.equal(AI.apply(plan,config,updates).applied,1);
 config.brandUrl=exactUrl;config.footerBrandUrl=exactUrl;const normalized=G.normalizeConfig(JSON.parse(JSON.stringify(config)));
 assert.deepEqual(normalized.aiLinkInsertions,[entry]);const dom=new JSDOM(G.renderSnippet(normalized));
 try{
  const all=Array.from(dom.window.document.querySelectorAll('a[href]')).filter(a=>/^https?:/.test(a.getAttribute('href')));assert.equal(all.length,1);assert.equal(all[0].getAttribute('href'),exactUrl);assert.equal(all[0].textContent,exactAnchor);assert.equal(all[0].getAttribute('data-pp-priority'),'article');
  const controls=Array.from(dom.window.document.querySelectorAll('[data-pp-url]')).filter(n=>n.getAttribute('data-pp-url')===exactUrl);assert.ok(controls.length>=5);assert.equal(G.analyzeLinks(normalized).links.find(l=>l.url===exactUrl).nativeCount,1);assert.equal(dom.window.document.querySelector('b'),null);
 }finally{dom.window.close();}
});

test('arbitrary HTTP URLs and misplaced tokens are rejected atomically on both server and client',async()=>{
 for(const value of ['[[PP_LINK:review_link]] https://unexpected.example/x?y=%2F','[[PP_LINK:review_link]] [Other](HTTPS://unexpected.example/)','[[PP_LINK:review_link]] <a href="https://unexpected.example/">Other</a>','[[PP_LINK:review_link]] [[PP_LINK:unknown]]']){
  const {config,plan}=setup(),before=JSON.stringify(config),updates=update(plan,value);await assert.rejects(()=>validate(plan,updates));assert.throws(()=>AI.apply(plan,config,updates));assert.equal(JSON.stringify(config),before);
 }
});

test('late response preserves independently edited manual fields, exact destinations and insertion metadata',()=>{
 const {config,plan}=setup();config.sections[0].body='Edited manually while waiting';config.cards[0].url='https://manual.example/?changed=%2f&keep=1';config.title='Manual title';const before=JSON.stringify(config);
 const result=AI.apply(plan,config,update(plan,'[[PP_LINK:review_link]] generated body'));assert.equal(result.conflicts,1);assert.equal(result.applied,0);assert.equal(JSON.stringify(config),before);
 const clone=JSON.parse(JSON.stringify(config));assert.equal(AI.apply(plan,clone,update(plan,'[[PP_LINK:review_link]] generated body')).conflicts,1);
});

test('valid token before an existing manual Markdown link is accepted and preserves both links',async()=>{
 const manual='[Keep exact](https://manual.example/?keep=%2F&b=2)',{config,plan}=setup('Read '+manual+'.');const updates=update(plan,'First [[PP_LINK:review_link]], then '+manual+'.');
 await validate(plan,updates);assert.equal(AI.apply(plan,config,updates).applied,1);assert.doesNotThrow(()=>G.renderSnippet(config));const dom=new JSDOM(G.renderSnippet(config));
 try{const links=Array.from(dom.window.document.querySelectorAll('a[href]'));assert.ok(links.some(a=>a.getAttribute('href')===exactUrl&&a.textContent===exactAnchor));assert.ok(links.some(a=>a.getAttribute('href')==='https://manual.example/?keep=%2F&b=2'&&a.textContent==='Keep exact'));}finally{dom.window.close();}
});

test('ordinary bracketed prose before a valid token cannot break generation or publication rendering',async()=>{
 const {config,plan}=setup(),updates=update(plan,'Read [important note] before [[PP_LINK:review_link]].');await validate(plan,updates);assert.equal(AI.apply(plan,config,updates).applied,1);assert.doesNotThrow(()=>Registry.list(config));assert.doesNotThrow(()=>G.renderSnippet(config));
});

test('overlapping identical budget requests dispatch and charge once, then replay the exact validated response',async()=>{
 const api=await apiModule,{createAIBudget}=await budgetModule,budget=createAIBudget({filename:':memory:'});const {plan}=setup(),updates=update(plan,'[[PP_LINK:review_link]] generated body'),body={requestId:'same-request',brief:{},targets:plan.targets};let calls=0,release,entered;
 const started=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});const handler=api.createAIHandler({budget,fetchImpl:async()=>{calls++;entered();await gate;return new Response(JSON.stringify(responseBody(updates)));}});
 try{
  const first=handler(request(body),{OPENAI_API_KEY:'test-only'});await started;const overlapping=await handler(request(body),{OPENAI_API_KEY:'test-only'});assert.equal(overlapping.status,409);assert.equal((await overlapping.json()).code,'AI_RESULT_UNCERTAIN');assert.equal(calls,1);
  release();const accepted=await first;assert.equal(accepted.status,200);const expected=await accepted.json();const status=budget.status();const replay=await handler(request(body),{OPENAI_API_KEY:'test-only'});assert.deepEqual(await replay.json(),expected);assert.equal(calls,1);assert.deepEqual(budget.status(),status);assert.equal(status.counts.completed,1);assert.equal(status.reservedUSD,0);assert.equal(status.spentTokens,50);
 }finally{release();budget.close();}
});

test('invalid output with measured usage is charged once but never cached as usable model copy',async()=>{
 const api=await apiModule,{createAIBudget}=await budgetModule,budget=createAIBudget({filename:':memory:'}),{plan}=setup();let calls=0;
 const handler=api.createAIHandler({budget,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(responseBody(update(plan,'[[PP_LINK:review_link]] https://rogue.example/'))));}}),body={requestId:'billed-invalid',brief:{},targets:plan.targets};
 try{const first=await handler(request(body),{OPENAI_API_KEY:'test-only'});assert.equal(first.status,502);const status=budget.status();assert.equal(status.counts.rejected,1);assert.equal(status.spentTokens,50);assert.equal(status.reservedUSD,0);const retry=await handler(request(body),{OPENAI_API_KEY:'test-only'});assert.equal(retry.status,409);assert.equal((await retry.json()).code,'AI_REQUEST_REJECTED');assert.equal(calls,1);assert.deepEqual(budget.status(),status);}finally{budget.close();}
});

test('malformed JSON, missing usage and network uncertainty keep held budget and cannot redispatch the same identity',async()=>{
 const api=await apiModule,{createAIBudget}=await budgetModule;
 for(const behavior of ['json','usage','network']){
  const budget=createAIBudget({filename:':memory:'}),{plan}=setup(),body={requestId:'unknown-'+behavior,brief:{},targets:plan.targets};let calls=0;
  const handler=api.createAIHandler({budget,fetchImpl:async()=>{calls++;if(behavior==='network')throw Error('Provider transport outcome unknown');if(behavior==='json')return new Response('{broken');return new Response(JSON.stringify(responseBody(update(plan,'[[PP_LINK:review_link]] generated body'),null)));}});
  try{const first=await handler(request(body),{OPENAI_API_KEY:'test-only'});assert.equal((await first.json()).code,'AI_RESULT_UNCERTAIN');assert.equal(budget.status().counts.uncertain,1);const held=budget.status().reservedUSD;assert.ok(held>0);const retry=await handler(request(body),{OPENAI_API_KEY:'test-only'});assert.equal((await retry.json()).code,'AI_RESULT_UNCERTAIN');assert.equal(calls,1);assert.equal(budget.status().reservedUSD,held);}finally{budget.close();}
 }
});


test('blank AI output cannot silently discard a required exact link insertion',async()=>{
 const {config,plan}=setup(),before=JSON.stringify(config),updates=update(plan,'   ');await assert.rejects(()=>validate(plan,updates));assert.throws(()=>AI.apply(plan,config,updates));assert.equal(JSON.stringify(config),before);
 const ordinary=AI.makePlan(config,{mode:'selected',paths:['intro']});assert.equal(AI.apply(ordinary,config,update(ordinary,'   ')).emptySkipped,1);
});

test('ordinary bracketed prose is not part of the later manual link anchor during validation and edits',async()=>{const manual='[Keep [this] exact](https://manual.example/?k=%2F)',{config,plan}=setup('Read [important note] and '+manual+'.'),updates=update(plan,'Updated [ordinary note] then '+manual+' and [[PP_LINK:review_link]].');await validate(plan,updates);AI.apply(plan,config,updates);const prepared=Registry.prepare(config).config,link=Registry.list(prepared).find(p=>p.source==='markdown');assert.equal(link.anchor,'Keep [this] exact');const next=Registry.apply(prepared,Registry.propose(prepared,[{id:link.id,url:'https://replacement.example/',anchor:link.anchor,expectedUrl:link.url,expectedAnchor:link.anchor,expectedBinding:link.binding}]));assert.match(next.sections[0].body,/Updated \[ordinary note\] then/);assert.doesNotThrow(()=>G.renderSnippet(next));});
