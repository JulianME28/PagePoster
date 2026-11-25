'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('../dist/generator.js'),AI=require('../dist/ai-core.js');
const modules=Promise.all([import('../server/lifecycle/generation.mjs'),import('../server/ai.mjs'),import('../server/lifecycle/ai-budget.mjs')]);
const runId='4a0bf574-3f65-4d16-b54e-239d47a2fa1e';
const url='https://exact.example/(guide)?offer=1669&part=%2F#top';
function config(){const c=AI.createProject(G.DEFAULT_DATA,url,{cardCount:10});c.title='Manual title';c.sections[0].body='Manual [exact reference](https://manual.example/?x=%2F).';return c;}
function options(){return {mode:'selected',paths:['intro','sections.0.body'],brief:{topic:'Useful service comparisons',language:'Polish'},linkInsertions:[{id:'exact',fieldPath:'sections.0.body',url,anchor:'Exact [anchor] & punctuation',count:1}]};}
function provider(updates){return new Response(JSON.stringify({status:'completed',usage:{input_tokens:40,output_tokens:60},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({updates,notes:[]})}]}]}));}
function output(target){return target.currentValue+' Useful updated text. '+(target.allowedLinks||[]).map(p=>'[[PP_LINK:'+p.id+']]').join(' ');}
test('durable plan is JSON serializable, independent of WeakMaps, and preserves manual/exact link inputs',async()=>{
 const [mod,api,{createAIBudget}]=await modules,c=config(),before=JSON.stringify(c),spec=mod.prepareGeneration(c,options());assert.equal(JSON.stringify(c),before);assert.ok(Object.isFrozen(spec));assert.ok(Object.isFrozen(spec.config));assert.equal(spec.batches.length,1);
 const restored=JSON.parse(JSON.stringify(spec)),budget=createAIBudget({filename:':memory:'});let calls=0;const handler=api.createAIHandler({budget,fetchImpl:async(_url,settings)=>{calls++;const request=JSON.parse(settings.body),input=JSON.parse(request.input);return provider(input.targets.map(t=>({targetId:t.targetId,value:output(t)})));}});
 try{const result=await mod.executeBatch(restored,0,{handler,env:{OPENAI_API_KEY:'test-key'},runId});const repeated=await mod.executeBatch(restored,0,{handler,env:{OPENAI_API_KEY:'test-key'},runId});assert.deepEqual(result,repeated);assert.equal(calls,1);const finished=mod.finishGeneration(JSON.parse(JSON.stringify(spec)),[result]);assert.equal(finished.title,c.title);assert.equal(finished.cards.length+finished.moreCards.length,10);assert.equal(finished.cards[0].url,url);assert.equal(finished.aiLinkInsertions[0].anchor,'Exact [anchor] & punctuation');assert.match(finished.sections[0].body,/Manual \[exact reference\]/);assert.deepEqual(G.analyzeLinks(finished).urls.sort(),[url,'https://manual.example/?x=%2F'].sort());}finally{budget.close();}
});
test('batching respects target count and actual UTF-8 request size; finishes only once every batch is present',async()=>{
 const [mod]=await modules,c=config();c.sections=Array.from({length:12},(_,i)=>({_ppRowId:'row_'+i,title:'Manual title '+i,body:'漢'.repeat(48000),image:''}));const paths=c.sections.map((_,i)=>'sections.'+i+'.body');const spec=mod.prepareGeneration(c,{mode:'selected',paths,brief:{}});assert.equal(spec.batches.length,12);for(const batch of spec.batches){assert.ok(batch.targets.length<=16);assert.ok(Buffer.byteLength(JSON.stringify({requestId:'x'.repeat(100),brief:spec.brief,targets:batch.targets}))<=256*1024);}
 assert.throws(()=>mod.finishGeneration(spec,[]),e=>e.code==='GENERATION_INCOMPLETE');
});
test('ordinary empty replies are no-ops but required link insertions and hostile output block finalization',async()=>{
 const [mod]=await modules,c=config(),spec=mod.prepareGeneration(c,options()),body=spec.batches[0].targets;
 for(const value of ['', 'No required token.', '[[PP_LINK:unknown]]','[[PP_LINK:exact]] [invented](https://new.example/)']){
  const result={index:0,requestId:runId+'-0',updates:body.map(t=>({targetId:t.targetId,value:t.fieldPath==='intro'?'':value})),notes:[]};
  assert.throws(()=>mod.finishGeneration(spec,[result]));assert.equal(c.intro,'');
 }
 const plain=mod.prepareGeneration(c,{mode:'selected',paths:['intro'],brief:{}});const out=mod.finishGeneration(plain,[{index:0,requestId:runId+'-0',updates:plain.batches[0].targets.map(t=>({targetId:t.targetId,value:''})),notes:[]}]);assert.equal(out.intro,'');
});
test('tampered specs, field identities, missing/duplicate batches and changed provider contract fail before dispatch',async()=>{
 const [mod]=await modules,spec=mod.prepareGeneration(config(),options());let calls=0;
 for(const mutate of [s=>s.config.title='Edited',s=>s.batches[0].targets[0].field='brandUrl',s=>s.brief.topic='Changed',s=>s.model='different-model']){
  const bad=JSON.parse(JSON.stringify(spec));mutate(bad);await assert.rejects(()=>mod.executeBatch(bad,0,{handler:async()=>{calls++;},env:{},runId}),e=>e.code==='GENERATION_SPEC_CHANGED');
 }assert.equal(calls,0);
 const result={index:0,requestId:runId+'-0',updates:spec.batches[0].targets.map(t=>({targetId:t.targetId,value:output(t)})),notes:[]};
 assert.throws(()=>mod.finishGeneration(spec,[result,result]),e=>e.code==='GENERATION_INCOMPLETE');
});
test('AI timeout uncertainty retains same request identity and never retries with a fresh paid ID',async()=>{
 const [mod]=await modules,spec=mod.prepareGeneration(config(),options()),ids=[];
 const handler=async request=>{ids.push((await request.json()).requestId);return new Response(JSON.stringify({code:'AI_RESULT_UNCERTAIN',error:'private payload not forwarded'}),{status:502});};
 for(let i=0;i<2;i++)await assert.rejects(()=>mod.executeBatch(spec,0,{handler,env:{OPENAI_API_KEY:'test-key'},runId}),e=>e.code==='AI_RESULT_UNCERTAIN'&&e.uncertain===true&&!e.message.includes('private'));
 assert.deepEqual(ids,[runId+'-0',runId+'-0']);
});
test('manual and HTML bypass do not dispatch AI; selected HTML generation is rejected',async()=>{
 const [mod]=await modules,c=config();c.contentMode='html';c.importHtml='<main>Keep source exactly</main>';
 const spec=mod.prepareGeneration(c,{mode:'manual',brief:{}});assert.equal(spec.batches.length,0);assert.deepEqual(mod.finishGeneration(spec,[]),c);
 assert.throws(()=>mod.prepareGeneration(c,{mode:'selected',paths:['intro'],brief:{}}),e=>e.code==='GENERATION_HTML_UNSUPPORTED');
 await assert.rejects(()=>mod.executeBatch(spec,0,{handler:async()=>assert.fail('No dispatch'),env:{},runId}),e=>e.code==='GENERATION_INVALID_BATCH');
});

