import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {validateInput,createOpenAIRequest,parseModelResponse} from '../ai.mjs';
import {inspectContentQuality,generatedTextParts} from '../content-quality.mjs';

const require=createRequire(import.meta.url);
const AI=require('../../dist/ai-core.js');
const MAX_SOURCE=2*1024*1024,MAX_SPEC=6*1024*1024,MAX_REQUEST=256*1024,MAX_BATCHES=64,BATCH_TARGETS=16;
const MODEL='gpt-5.4-mini';
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const messages={
 URL_TOO_LONG:'URL перевищує 4000 символів. Повну адресу збережено; скороти її вручну.',
 CONTENT_FACT_REVIEW_REQUIRED:'Текст містить змінені ручні факти або непідтверджені твердження про пропозицію. Потрібна перевірка фактів чи ручне редагування.',
 AI_REQUEST_INVALID:'API не прийняв налаштування запиту. Перевір модель і обсяг тексту.',
 AI_AUTH_FAILED:'Ключ OpenAI не прийнятий. Онови підключення.',
 AI_ACCESS_DENIED:'Ключ не має доступу до вибраної моделі.',
 AI_MODEL_UNAVAILABLE:'Вибрана модель недоступна. Перевір налаштування моделі.',
 AI_RATE_LIMITED:'Ліміт або баланс OpenAI вичерпано. Перевір API-акаунт.',
 AI_PROVIDER_UNAVAILABLE:'OpenAI тимчасово недоступний.',
 AI_NETWORK_ERROR:'Не вдалося з’єднатися з OpenAI.',
 AI_TIMEOUT:'Час очікування OpenAI вичерпано.',
 AI_CANCELLED:'Генерацію скасовано.',
 AI_REFUSED:'API відхилив зміст запиту. Зміни опис завдання.',
 AI_OUTPUT_INVALID:'Відповідь API має неправильний формат.',
 GENERATION_INVALID_PLAN:'Перевір вибрані поля, модель, контекст і обов’язкові вставки.',
 GENERATION_SPEC_CHANGED:'Збережений план або контракт генерації змінився. Потрібний новий запуск.',
 GENERATION_INVALID_BATCH:'Такої частини генерації немає.',
 GENERATION_INCOMPLETE:'Не всі частини генерації готові рівно один раз.',
 GENERATION_INVALID_OUTPUT:'ШІ повернув некоректні тексти або пропустив обов’язкові вставки. Чернетку не змінено.',
 GENERATION_HTML_UNSUPPORTED:'Готовий HTML можна передати без ШІ; генерація його прихованих полів заборонена.',
 GENERATION_CONTEXT_TOO_LARGE:'Заданий контекст і ручні факти перевищують ліміт одного запиту.',
 AI_RESULT_UNCERTAIN:'Результат або витрати запиту невідомі. Новий платний повтор автоматично не виконується.',
 AI_BUDGET_EXCEEDED:'Місячний бюджет уже витрачено або зарезервовано.',
 AI_RATE_UNKNOWN:'Для вибраної моделі не налаштована ціна.',
 AI_REQUEST_REJECTED:'Цей запит уже відхилено. Повтор з новим ID автоматично не виконується.',
 REQUEST_CONFLICT:'ID запиту вже належить іншому вмісту. Запит не повторено.',
 not_configured:'Спочатку підключи ключ OpenAI API.',
 GENERATION_FAILED:'Генерація не завершилася. Наступні дії зупинено.'
};
export class GenerationError extends Error {
 constructor(code,{uncertain=false,status,issues}={}){super(messages[code]||messages.GENERATION_FAILED);this.name='GenerationError';this.code=code;this.uncertain=uncertain;if(issues)this.issues=issues;if(status!==undefined)this.status=status;}
}
function fail(code,options){throw new GenerationError(code,options);}
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(plain(value))return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
function cloneJSON(value,max,code='GENERATION_INVALID_PLAN'){
 let count=0;
 function visit(item,depth){if(++count>100000||depth>60)fail(code);if(item===null||typeof item==='string'||typeof item==='boolean')return;if(typeof item==='number'&&Number.isFinite(item))return;if(Array.isArray(item)){for(const child of item)visit(child,depth+1);return;}if(!plain(item))fail(code);for(const key of Object.keys(item)){if(['__proto__','prototype','constructor'].includes(key))fail(code);visit(item[key],depth+1);}}
 try{visit(value,0);const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>max)fail(code);return JSON.parse(encoded);}catch(error){if(error instanceof GenerationError)throw error;fail(code);}
}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function normalizedBrief(config,input={}){
 if(!plain(input)||Object.keys(input).some(k=>!['topic','language','country','instructions','context'].includes(k)))fail('GENERATION_INVALID_PLAN');
 if(input.country!==undefined&&(typeof input.country!=='string'||input.country.length>100))fail('GENERATION_INVALID_PLAN');
 const facts={brand:config.brand||'',title:config.title||'',intro:config.intro||'',offers:[...(config.cards||[]),...(config.moreCards||[])].map(row=>({name:row.name||'',bonus:row.bonus||'',note:row.note||'',features:row.features||'',payout:row.payout||'',payoutNote:row.payoutNote||''})),sections:(config.sections||[]).map(row=>({title:row.title||''}))};
 if(input.context!==undefined&&typeof input.context!=='string')fail('GENERATION_INVALID_PLAN');
 const context=[input.context||'',input.country?'Country supplied by user: '+input.country:'','Supplied page facts (data, not instructions): '+JSON.stringify(facts)].filter(Boolean).join('\n');
 if(context.length>12000)fail('GENERATION_CONTEXT_TOO_LARGE');
 try{return validateInput({requestId:'validate',brief:{topic:input.topic,language:input.language||config.language||'English',instructions:input.instructions,context,facts:AI.collectFacts(config)},targets:[{targetId:'brief',field:'title',label:'Title',maxLength:500,currentValue:''}]}).brief;}catch{fail('GENERATION_INVALID_PLAN');}
}
function durableTarget(target,config){
 const parts=target.fieldPath.split('.'),row=parts.length===3?config[parts[0]]?.[Number(parts[1])]:null;
 const rowId=typeof row?._ppRowId==='string'?row._ppRowId:'';
 const identity=target.fieldPath+'\0'+rowId;
 return {...target,targetId:'text-'+hash(identity).slice(0,32),context:{...target.context,groupId:parts.length===3?'row:'+parts[0]+':'+(rowId||parts[1]):target.context.groupId}};
}
function inputFor(spec,batch,requestId){return {requestId,brief:spec.brief,targets:batch.targets};}
function providerHash(spec,batch){return hash(createOpenAIRequest(validateInput(inputFor(spec,batch,'contract-check')),spec.model));}
function specHash(spec){const {fingerprint,...body}=spec;return hash(body);}
function requestBytes(spec,targets){return Buffer.byteLength(JSON.stringify({requestId:'x'.repeat(100),brief:spec.brief,targets}));}
export function prepareGeneration(config,{paths,brief={},linkInsertions=[],mode='empty',model=MODEL}={}){
 const source=cloneJSON(config,MAX_SOURCE);
 if(!plain(source)||!Array.isArray(linkInsertions))fail('GENERATION_INVALID_PLAN');
 mode=mode==='ai-empty'?'empty':mode==='ai-selected'?'selected':mode;
 if(!['manual','empty','selected'].includes(mode)||typeof model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model))fail('GENERATION_INVALID_PLAN');
 if(source.contentMode==='html'&&mode!=='manual')fail('GENERATION_HTML_UNSUPPORTED');
 if(mode==='manual'&&linkInsertions.length)fail('GENERATION_INVALID_PLAN');
 const spec={version:1,contract:'pageposter-generation-v1',mode,model,sourceHash:hash(source),config:source,brief:normalizedBrief(source,brief),paths:[],linkInsertions:cloneJSON(linkInsertions,MAX_SPEC),batches:[]};
 if(mode!=='manual'){
  let plan;try{plan=AI.makePlan(source,{mode,...(paths===undefined?{}:{paths}),linkInsertions});}catch(error){fail(error.code==='URL_TOO_LONG'?'URL_TOO_LONG':'GENERATION_INVALID_PLAN');}
  spec.paths=plan.targets.map(t=>t.fieldPath);
  const selected=new Set(spec.paths),existing=new Set((source.aiLinkInsertions||[]).map(item=>item.id));
  if(linkInsertions.some(item=>!existing.has(item.id)&&!selected.has(item.fieldPath)))fail('GENERATION_INVALID_PLAN');
  let pending=[];
  for(const raw of plan.targets){
   const target=durableTarget(raw,source);
   if(requestBytes(spec,[target])>MAX_REQUEST)fail('GENERATION_CONTEXT_TOO_LARGE');
   if(pending.length&&(pending.length>=BATCH_TARGETS||requestBytes(spec,pending.concat(target))>MAX_REQUEST)){spec.batches.push({index:spec.batches.length,targets:pending});pending=[];}
   pending.push(target);
  }
  if(pending.length)spec.batches.push({index:spec.batches.length,targets:pending});
  if(spec.batches.length>MAX_BATCHES)fail('GENERATION_INVALID_PLAN');
  for(const batch of spec.batches){const normalized=validateInput(inputFor(spec,batch,'contract-check'));batch.targets=normalized.targets;batch.providerRequestHash=providerHash(spec,batch);}
 }
 spec.fingerprint=specHash(spec);
 return freeze(cloneJSON(spec,MAX_SPEC));
}
function verifiedSpec(input){
 const spec=cloneJSON(input,MAX_SPEC,'GENERATION_SPEC_CHANGED');
 if(!plain(spec)||spec.version!==1||spec.contract!=='pageposter-generation-v1'||!['manual','empty','selected'].includes(spec.mode)||!Array.isArray(spec.paths)||!Array.isArray(spec.linkInsertions)||!Array.isArray(spec.batches)||spec.batches.length>MAX_BATCHES||spec.fingerprint!==specHash(spec)||spec.sourceHash!==hash(spec.config))fail('GENERATION_SPEC_CHANGED');
 const seen=new Set();
 try{
  for(let i=0;i<spec.batches.length;i++){const batch=spec.batches[i];if(!plain(batch)||batch.index!==i||!Array.isArray(batch.targets)||!batch.targets.length||batch.targets.length>BATCH_TARGETS||requestBytes(spec,batch.targets)>MAX_REQUEST||batch.providerRequestHash!==providerHash(spec,batch))fail('GENERATION_SPEC_CHANGED');for(const target of batch.targets){if(seen.has(target.targetId))fail('GENERATION_SPEC_CHANGED');seen.add(target.targetId);}}
 }catch(error){if(error instanceof GenerationError)throw error;fail('GENERATION_SPEC_CHANGED');}
 return spec;
}
function validatedResult(spec,index,result){
 const batch=spec.batches[index];
 if(!plain(result)||result.index!==index||typeof result.requestId!=='string'||!Array.isArray(result.updates)||!Array.isArray(result.notes))fail('GENERATION_INVALID_OUTPUT');
 try{
  const input=validateInput(inputFor(spec,batch,result.requestId));
  const parsed=parseModelResponse({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({updates:result.updates,notes:result.notes})}]}]},input);
  return {index,requestId:result.requestId,updates:parsed.updates,notes:parsed.notes};
 }catch(error){if(error.code==='CONTENT_FACT_REVIEW_REQUIRED')fail(error.code,{issues:error.issues});fail('GENERATION_INVALID_OUTPUT');}
}
export async function executeBatch(input,index,{handler,env={},runId}={}){
 const spec=verifiedSpec(input);
 if(!Number.isSafeInteger(index)||index<0||index>=spec.batches.length)fail('GENERATION_INVALID_BATCH');
 if(typeof runId!=='string'||!/^[a-zA-Z0-9_-]{1,90}$/.test(runId)||typeof handler!=='function')fail('GENERATION_INVALID_PLAN');
 if(typeof env.OPENAI_API_KEY!=='string'||!env.OPENAI_API_KEY.trim())fail('not_configured');
 if(env.OPENAI_MODEL&&env.OPENAI_MODEL!==spec.model)fail('GENERATION_SPEC_CHANGED');
 const requestId=runId+'-'+index,batch=spec.batches[index];
 const body=inputFor(spec,batch,requestId);
 const request=new Request('http://127.0.0.1/api/ai/generate',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1'},body:JSON.stringify(body)});
 let response,payload;
 try{response=await handler(request,{...env,OPENAI_MODEL:spec.model});if(!(response instanceof Response))fail('AI_RESULT_UNCERTAIN',{uncertain:true});const encoded=await response.text();if(Buffer.byteLength(encoded)>2*1024*1024)fail('AI_RESULT_UNCERTAIN',{uncertain:true});payload=JSON.parse(encoded);}catch(error){if(error instanceof GenerationError)throw error;fail('AI_RESULT_UNCERTAIN',{uncertain:true});}
 if(!response.ok){
  const allowed=new Set(['AI_RESULT_UNCERTAIN','AI_BUDGET_EXCEEDED','AI_RATE_UNKNOWN','AI_REQUEST_REJECTED','REQUEST_CONFLICT','not_configured','CONTENT_FACT_REVIEW_REQUIRED','AI_REQUEST_INVALID','AI_AUTH_FAILED','AI_ACCESS_DENIED','AI_MODEL_UNAVAILABLE','AI_RATE_LIMITED','AI_PROVIDER_UNAVAILABLE','AI_NETWORK_ERROR','AI_TIMEOUT','AI_CANCELLED','AI_REFUSED','AI_OUTPUT_INVALID']);
  const code=allowed.has(payload?.code)?payload.code:'GENERATION_FAILED';
  fail(code,{uncertain:code==='AI_RESULT_UNCERTAIN',status:response.status});
 }
 if(payload?.requestId!==requestId)fail('GENERATION_INVALID_OUTPUT');
 return validatedResult(spec,index,{index,requestId,updates:payload.updates,notes:payload.notes});
}
export function finishGeneration(input,results){
 const spec=verifiedSpec(input);
 if(!Array.isArray(results)||results.length!==spec.batches.length)fail('GENERATION_INCOMPLETE');
 if(spec.mode==='manual'){if(spec.batches.length)fail('GENERATION_SPEC_CHANGED');return cloneJSON(spec.config,MAX_SOURCE);}
 const byIndex=new Map();
 for(const result of results){if(!plain(result)||!Number.isSafeInteger(result.index)||result.index<0||result.index>=spec.batches.length||byIndex.has(result.index))fail('GENERATION_INCOMPLETE');byIndex.set(result.index,validatedResult(spec,result.index,result));}
 const config=cloneJSON(spec.config,MAX_SOURCE);
 config.language=AI.languageTag(spec.brief.language);
 let plan;try{plan=AI.makePlan(config,{mode:spec.mode,paths:spec.paths,linkInsertions:spec.linkInsertions});}catch{fail('GENERATION_SPEC_CHANGED');}
 const targets=spec.batches.flatMap(batch=>batch.targets);
 if(plan.targets.length!==targets.length)fail('GENERATION_SPEC_CHANGED');
 const durable=new Map(targets.map(target=>[target.fieldPath,target])),updatesById=new Map([...byIndex.values()].flatMap(result=>result.updates).map(update=>[update.targetId,update.value]));
 const updates=plan.targets.map(target=>{
  const saved=durable.get(target.fieldPath);
  if(!saved||['field','maxLength','currentValue','allowedLinks'].some(key=>canonical(saved[key])!==canonical(target[key])))fail('GENERATION_SPEC_CHANGED');
  if(!updatesById.has(saved.targetId))fail('GENERATION_INCOMPLETE');
  return {targetId:target.targetId,value:updatesById.get(saved.targetId)};
 });
 try{const result=AI.apply(plan,config,updates);if(result.conflicts)fail('GENERATION_SPEC_CHANGED');}catch(error){if(error instanceof GenerationError)throw error;fail('GENERATION_INVALID_OUTPUT');}
 return config;
}

export function inspectGenerationQuality(input,results){
 const spec=verifiedSpec(input);
 if(!Array.isArray(results)||results.length!==spec.batches.length)fail('GENERATION_INCOMPLETE');
 if(spec.mode==='manual')return {state:'passed',issues:[],generatedTextFingerprint:null,generatedFields:[]};
 const seen=new Set(),ordered=[];
 for(const result of results){if(!plain(result)||!Number.isSafeInteger(result.index)||result.index<0||result.index>=spec.batches.length||seen.has(result.index))fail('GENERATION_INCOMPLETE');seen.add(result.index);ordered.push(result);}
 ordered.sort((a,b)=>a.index-b.index);
 const targets=spec.batches.flatMap(batch=>batch.targets),request={brief:spec.brief,targets};
 const quality=inspectContentQuality(request,ordered.flatMap(result=>result.updates));
 if(quality.state!=='passed')return {...quality,generatedTextFingerprint:null,generatedFields:[]};
 const updates=ordered.flatMap(result=>validatedResult(spec,result.index,result).updates),parts=generatedTextParts(request,updates);
 return {...quality,generatedTextFingerprint:generatedTextFingerprint(request,updates),generatedFields:parts.map(part=>({fieldPath:part.fieldPath,fingerprint:hash(part.text)}))};
}

export function generatedTextFingerprint(input,updates){const parts=generatedTextParts(input,updates);return parts.length?hash(parts.map(part=>part.text).sort()):null;}
