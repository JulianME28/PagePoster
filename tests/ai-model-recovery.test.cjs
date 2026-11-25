const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
test('only a known unpaid rejection can resume with a new identity after a model change',async t=>{
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 for(const state of ['rejected','uncertain'])await t.test(state,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-ai-model-'));let retries=0;
  const service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,17).toString('base64'),ai:{env:{OPENAI_MODEL:'gpt-4.1-mini'},budget:{getRequest:()=>({state,model:'gpt-5.4-mini',retryable:state==='rejected'}),authorizeRetry:()=>{retries++}}},autopilotOptions:{planner:{generate:async()=>{throw Object.assign(Error('private'),{code:'AI_MODEL_UNAVAILABLE',diagnostics:{httpStatus:403,providerCode:'model_not_found',model:'gpt-5.4-mini',message:'secret'}})}}}});
  t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true})});
  const project=service.store.createProject({name:'Model retry'}),id=randomUUID();
  const q=async(route,body)=>{const r=await service.handle(new Request('http://localhost/api/lifecycle'+route,{method:'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:r.status,...await r.json()}};
  await q('/projects/'+project.id+'/autopilot',{idempotencyKey:id,links:[{url:'https://example.com/',anchor:'Casino guide'}],reviewBeforePublish:true});await service.tick();
  let r=service.store.getRecord(id);assert.equal(r.state,'failed');assert.equal(r.error.diagnostics.providerCode,'model_not_found');assert.doesNotMatch(JSON.stringify(r.error),/secret|private/);
  const before=r.requestId,result=await q('/autopilot/'+id+'/resume',{});r=service.store.getRecord(id);
  if(state==='rejected'){assert.equal(result.status,202);assert.notEqual(r.requestId,before);assert.equal(r.state,'queued');assert.equal(r.reviewBeforePublish,true);assert.equal(retries,0)}else{assert.notEqual(result.status,200);assert.equal(r.requestId,before);assert.equal(retries,0)}
 });
});


test('autopilot preserves safe output diagnostics and does not claim a failed page is saved',async t=>{
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-ai-output-'));
 const service=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,18).toString('base64'),autopilotOptions:{planner:{generate:async()=>{throw Object.assign(Error('private output'),{code:'AI_OUTPUT_INVALID',issues:[{code:'AI_TEXT_INVALID',fieldPath:'sections.2.body',detail:'private model text'},{code:'UNTRUSTED_SECRET',fieldPath:'apiKey'}]});}}}});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const project=service.store.createProject({name:'Output diagnostics'}),id=randomUUID();
 await service.handle(new Request('http://localhost/api/lifecycle/projects/'+project.id+'/autopilot',{method:'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:id,links:[{url:'https://example.com/',anchor:'Guide'}],reviewBeforePublish:true})}));await service.tick();
 const r=service.store.getRecord(id);assert.equal(r.state,'failed');assert.equal(r.pageId,null);assert.deepEqual(r.error.issues,[{code:'AI_TEXT_INVALID',fieldPath:'sections.2.body'}]);assert.match(r.error.message,/sections\.2\.body/);assert.doesNotMatch(JSON.stringify(r.error),/private|UNTRUSTED_SECRET|apiKey|Готові результати збережено/);
});
