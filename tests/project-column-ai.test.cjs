'use strict';
const test=require('node:test'),assert=require('node:assert/strict');

test('project mapping shares only sanitized labels, uses a stable receipt and rejects invented fields',async()=>{
 const {projectColumnContract:contract}=await import('../server/lifecycle/project-column-ai.mjs');
 const input=contract.validate({headers:['Source asset','Final slug','Website to use',''],hasHtml:true});
 assert.equal(input.requestId,contract.validate({headers:['Source asset','Final slug','Website to use',''],hasHtml:true}).requestId);
 const payload=contract.request(input,'fixture-model');
 assert.deepEqual(JSON.parse(payload.input),{headers:['Source asset','Final slug','Website to use',''],hasHtml:true});
 assert.equal(payload.store,false);
 const response=columns=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({columns})}]}]});
 assert.deepEqual(contract.parse(response(['file','slug','donor','']),input),{columns:['file','slug','donor','']});
 for(const columns of [['file','slug','donor','url'],['file','slug','slug',''],['file','invented-value','donor',''],['file']])
  assert.throws(()=>contract.parse(response(columns),input),{code:'AI_OUTPUT_INVALID'});
 assert.throws(()=>contract.validate({headers:['Password'],hasHtml:true}),{code:'VALIDATION'});
 assert.throws(()=>contract.validate({headers:['Source asset'],hasHtml:true,rows:[['private']]}),{code:'VALIDATION'});
});

test('the normalization API replays the column mapping through the durable budget',async t=>{
 const {createAIHandler}=await import('../server/ai.mjs');
 const {createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');
 const {projectColumnContract}=await import('../server/lifecycle/project-column-ai.mjs');
 const budget=createAIBudget({filename:':memory:'});
 t.after(()=>budget.close());
 let calls=0;
 const headers=['Source asset','Final slug','Website to use',''];
 const response={status:'completed',usage:{input_tokens:20,output_tokens:20},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({columns:['file','slug','donor','']})}]}]};
 const handler=createAIHandler({budget,contracts:{'/api/ai/project-columns':projectColumnContract},fetchImpl:async(_url,{body})=>{
  calls++;assert.deepEqual(JSON.parse(JSON.parse(body).input),{headers,hasHtml:true});
  return Response.json(response);
 }});
 const invoke=()=>handler(new Request('http://localhost/api/ai/project-columns',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({headers,hasHtml:true})}),{OPENAI_API_KEY:'fixture-key'});
 for(let index=0;index<2;index++){
  const result=await invoke();assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{columns:['file','slug','donor','']});
 }
 assert.equal(calls,1);
});
