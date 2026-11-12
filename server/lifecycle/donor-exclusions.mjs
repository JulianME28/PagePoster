// Workspace policy only: these observations never authorize writes or release ownership.
import {createHash,createHmac} from 'node:crypto';

const KIND='donor_exclusion',FORMAT=1,MINUTE=60000,DAY=86400000;
const TRANSIENT=new Set(['dns_failed','network_failed','network_timeout','BROWSER_TIMEOUT','BROWSER_LOGIN_UNCONFIRMED','BROWSER_PAGE_UNAVAILABLE','NATIVE_NAVIGATION_UNAVAILABLE']);
const PLUGIN=new Set(['CLEAN_LINKS_FILESYSTEM_REQUIRED','CLEAN_LINKS_INSTALL_FORBIDDEN']);
const KNOWN=new Set([...TRANSIENT,...PLUGIN,'bootstrap_auth_failed','NATIVE_VISUAL_REJECTED','MANUAL_BAN','POLICY_REVIEW_REQUIRED']);
const TYPES=new Set(['transient','auth','plugin','visual','manual','security']);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Object.assign(Error(code==='CONFLICT'?'Donor policy changed. Refresh and retry.':code==='NOT_FOUND'?'Donor policy record not found.':'Invalid donor policy input.'),{code});};
const safeCode=code=>KNOWN.has(code)?code:'POLICY_REVIEW_REQUIRED';
const safeRunId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(value)?value:null;
const validTime=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value;
const time=value=>validTime(value)?Date.parse(value):NaN;
const iso=value=>Number.isFinite(value)&&Math.abs(value)<=8640000000000000?new Date(value).toISOString():null;
function originOf(value){
 if(typeof value!=='string'||value.length>4096||/[\r\n\0]/.test(value))fail('VALIDATION');
 let url;try{url=new URL(value);}catch{fail('VALIDATION');}
 if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)fail('VALIDATION');return url.origin;
}
function originsOf(value){
 const values=[value.origin??value.baseUrl,...(Array.isArray(value.origins)?value.origins:[]),...(Array.isArray(value.originAliases)?value.originAliases:[])];
 if(value.canonicalLogin?.baseUrl){values.push(value.canonicalLogin.baseUrl);if(value.canonicalLogin.requestedBaseUrl)values.push(value.canonicalLogin.requestedBaseUrl);}
 return [...new Set(values.filter(value=>value!==undefined&&value!==null).map(originOf))].sort();
}
function storedOrigins(record){try{return [...new Set((Array.isArray(record.origins)?record.origins:[record.origin]).map(originOf))].sort();}catch{return [];}}
function ordered(value){if(Array.isArray(value))return value.map(ordered);if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])]));return value;}
function sourceIdentity(value){
 if(!object(value)||typeof value.spreadsheetId!=='string'||!value.spreadsheetId||value.spreadsheetId.length>200)return null;
 const range=value.resolvedRange??value.range,columns=value.columns??value.mapping,reader=value.readerPrincipal;
 if(typeof range!=='string'||!range||range.length>1000||!object(columns)||!Object.keys(columns).length||!['service','user','browser'].includes(value.authMode)||typeof reader!=='string'||!reader||reader.length>1000||!Number.isSafeInteger(value.headerRows)||value.headerRows<0)return null;
 const mapping={};for(const name of Object.keys(columns).sort()){
  if(!['url','username','password','alternateUsername','alternatePassword','dr','traffic','geo','enabled'].includes(name))return null;
  if(typeof columns[name]!=='string'||! /^[A-Za-z]{1,3}$/.test(columns[name]))return null;mapping[name]=columns[name].toUpperCase();
 }
 const sheet=value.resolvedSheetId??value.sheetId??value.resolvedSheet??value.sheetName??null;
 if(sheet!==null&&typeof sheet!=='string'&&!Number.isSafeInteger(sheet))return null;
 return ordered({spreadsheetId:value.spreadsheetId,sheet,range,columns:mapping,headerRows:value.headerRows,authMode:value.authMode,readerPrincipal:reader});
}
function pair(value){
 if(!object(value)||typeof value.username!=='string'||!value.username||value.username.length>1000)return null;
 const password=value.applicationPassword??value.password;if(typeof password!=='string'||!password||password.length>4096)return null;
 return [value.username,password];
}
function activeAt(record,now){
 if(validTime(record.releasedAt))return false;if(!record.expiresAt)return true;
 const at=time(record.observedAt),expiry=time(record.expiresAt),ttl=record.type==='transient'?15*MINUTE:['auth','plugin','visual'].includes(record.type)?DAY:null;
 // Broken timestamps, rollback and tampered expiry never imply recovery.
 if(!Number.isFinite(now)||!Number.isFinite(at)||now<at||!Number.isFinite(expiry)||ttl===null||expiry!==at+ttl)return true;
 return now<expiry;
}
const scopeOf=record=>record.legacy?'домен із попередньої відмови':record.type==='auth'||record.type==='plugin'?'конкретне джерело й пара логін/пароль':record.type==='visual'?'конкретний матеріал і домен':record.type==='manual'?'домен у всіх проєктах':'домен';

export function createDonorExclusions({store,masterKey,clock=Date.now,allRuns=()=>[]}={}){
 const key=typeof masterKey==='string'?Buffer.from(masterKey,'base64'):null;
 if(!key||key.length!==32||key.toString('base64')!==masterKey)throw Object.assign(Error('Donor policy key unavailable.'),{code:'KEY_REQUIRED'});
 for(const name of ['atomic','createPolicyRecord','getPolicyRecord','listPolicyRecords','updatePolicyRecord'])if(typeof store?.[name]!=='function')fail('VALIDATION');
 const digest=(domain,value)=>createHmac('sha256',key).update(JSON.stringify(['pageposter-donor-policy',FORMAT,domain,ordered(value)])).digest('hex');
 const keyMarker=digest('key-marker','workspace');
 const sourceRef=value=>{const source=sourceIdentity(value);return source?digest('source',source):null;};
 const credentialRef=(origin,value)=>{const account=pair(value);return account?digest('credential',[origin,...account]):null;};
 const materialRef=value=>typeof value==='string'&&value.length>0&&value.length<=1000?digest('material',value):null;
 const retirementRef=row=>digest('auth-trial',[row.format,row.type,row.runId,storedOrigins(row),row.observedAt,row.expiresAt,row.sourceRef,row.credentialRefs,false]);
 function recordProblem(row){
  if(row.legacy)return null;
  if(row.format!==FORMAT||!TYPES.has(row.type))return 'Непідтримуваний формат обмеження. Перевірте донора перед повторним підбором.';
  const proofName={transient:'prePage',auth:'loginRejectedBeforeWrites',plugin:'cleanLinksRestricted',visual:'ownedTrashConfirmed'}[row.type];
  if(proofName&&row.proof?.[proofName]!==true)return 'Підстави обмеження неповні. Перевірте донора перед повторним підбором.';
  const ref=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  if(['auth','plugin'].includes(row.type)&&(!ref(row.sourceRef)||!object(row.credentialRefs)||!storedOrigins(row).every(origin=>ref(row.credentialRefs[origin]))))return 'Відомості про відхилені дані для входу неповні. Перевірте донора перед повторним підбором.';
  if(row.type==='visual'&&!ref(row.materialRef))return 'Відомості про відхилений матеріал неповні. Перевірте донора перед повторним підбором.';
  if(Object.hasOwn(row,'retired')&&typeof row.retired!=='boolean'||row.retired===false&&(row.type!=='auth'||row.retirementRef!==retirementRef(row)))return 'Відомості про завершення спроби неповні. Перевірте донора перед повторним підбором.';
  return null;
 }
 function privateRecords(){return store.listPolicyRecords(KIND);}
 function legacyRecords(records=privateRecords(),history=allRuns()||[],now=clock()){
  const storedIds=new Set(records.map(row=>row.id)),virtual=[];
  for(const run of history)for(const [index,skip] of (Array.isArray(run?.donorSkips)?run.donorSkips:[]).entries()){
   // Linked typed history has precise scope; treating it as old data would undo that scope.
   let origins;try{origins=originsOf(skip);}catch{continue;}if(!origins.length)continue;
   const linked=typeof skip?.policyId==='string'?records.find(row=>row.id===skip.policyId):null;
   if(linked&&linked.runId===safeRunId(run.id)&&linked.runId!==null&&linked.code===skip.code&&origins.every(origin=>storedOrigins(linked).includes(origin)))continue;
   const code=safeCode(skip.code),observedAt=validTime(skip.at)?skip.at:null,runId=safeRunId(run.id);
   const id='legacy:'+createHash('sha256').update(JSON.stringify(['donor-skip-v1',runId,index,origins,code,observedAt])).digest('hex');
   if(storedIds.has(id))continue;
   const validPast=Number.isFinite(now)&&Number.isFinite(time(observedAt))&&time(observedAt)<=now;
   const type=TRANSIENT.has(code)&&validPast?'transient':code==='bootstrap_auth_failed'?'auth':code==='NATIVE_VISUAL_REJECTED'?'visual':'security';
   virtual.push({id,kind:KIND,format:FORMAT,revision:0,type,code,origin:origins[0],origins,runId,observedAt,expiresAt:type==='transient'?iso(time(observedAt)+15*MINUTE):null,releasedAt:null,legacy:true});
  }
  return virtual;
 }
 function records(){const rows=privateRecords();return rows.concat(legacyRecords(rows));}
 function publicRecord(record,now=clock()){
  const type=TYPES.has(record.type)?record.type:'security',origins=storedOrigins(record),releasedAt=validTime(record.releasedAt)?record.releasedAt:null;
  const keyMismatch=['auth','plugin','visual'].includes(type)&&!record.legacy&&record.keyMarker!==keyMarker&&!releasedAt;
  const problem=recordProblem(record),requiresReview=!releasedAt&&(keyMismatch||!!problem),active=!releasedAt&&(requiresReview||activeAt(record,now)),reason=keyMismatch?'Ключ захисту змінився. Перевірте донора перед повторним підбором.':problem|| (type==='manual'?'Донор заборонений вручну.':type==='transient'?'Донор тимчасово недоступний.':type==='auth'?'Дані для входу відхилено.':type==='visual'?'Підготовлений матеріал не пройшов перевірку вигляду.':type==='plugin'?'Є обмеження Clean Links. Публікація без плагіна з перевіркою вигляду залишається доступною.':'Обмеження донора потребує перевірки.');
  return {id:record.id,revision:record.revision,origin:origins[0]||'',origins,type,code:safeCode(record.code),reason,observedAt:validTime(record.observedAt)?record.observedAt:null,expiresAt:!requiresReview&&validTime(record.expiresAt)?record.expiresAt:null,releasedAt,released:!!releasedAt,active,requiresReview,canRelease:active,legacy:record.legacy===true,scope:scopeOf(record),state:releasedAt?'released':active?type==='plugin'&&!requiresReview?'advisory':'active':'expired'};
 }
 function observe(input={}){
  if(!object(input))fail('VALIDATION');const origins=originsOf(input);if(!origins.length)fail('VALIDATION');
  if(input.retired!==undefined&&typeof input.retired!=='boolean')fail('VALIDATION');
  const now=clock(),observedAt=input.observedAt===undefined?iso(now):validTime(input.observedAt)?input.observedAt:null,validPast=Number.isFinite(now)&&Number.isFinite(time(observedAt))&&time(observedAt)<=now;
  const proof=object(input.proof)?input.proof:{},code=safeCode(input.code),source=sourceRef(input.sourceIdentity??input.source),account=pair(input.credentials),material=materialRef(input.materialHash);
  const untimedAuthTrial=input.observedAt===null&&input.retired===false;
  let type='security',ttl=null;
  if(validPast&&TRANSIENT.has(code)&&proof.prePage===true){type='transient';ttl=15*MINUTE;}
  else if((validPast||untimedAuthTrial)&&code==='bootstrap_auth_failed'&&proof.loginRejectedBeforeWrites===true&&source&&account){type='auth';ttl=untimedAuthTrial?null:DAY;}
  else if(validPast&&PLUGIN.has(code)&&proof.cleanLinksRestricted===true&&source&&account){type='plugin';ttl=DAY;}
  else if(validPast&&code==='NATIVE_VISUAL_REJECTED'&&proof.ownedTrashConfirmed===true&&material){type='visual';ttl=DAY;}
  if(input.retired===false&&type!=='auth')fail('VALIDATION');
  const patch={format:FORMAT,type,code,origin:origins[0],origins,runId:safeRunId(input.runId),observedAt,expiresAt:ttl===null?null:iso(time(observedAt)+ttl),releasedAt:null,retired:input.retired!==false,proof:{...(type==='transient'?{prePage:true}:type==='auth'?{loginRejectedBeforeWrites:true}:type==='plugin'?{cleanLinksRestricted:true}:type==='visual'?{ownedTrashConfirmed:true}:{})}};
  if(type==='auth'||type==='plugin')Object.assign(patch,{sourceRef:source,credentialRefs:Object.fromEntries(origins.map(origin=>[origin,credentialRef(origin,input.credentials)])),keyMarker});
  if(type==='visual')Object.assign(patch,{materialRef:material,keyMarker});
  if(patch.retired===false)patch.retirementRef=retirementRef(patch);
  return store.atomic(()=>publicRecord(store.createPolicyRecord(KIND,patch)));
 }
 function snapshot(){
  // Proposal/diagnostic callers may share one operation snapshot. Admission uses
  // evaluate(), which always creates a fresh snapshot under its current guard.
  const now=clock(),history=allRuns()||[],persisted=privateRecords(),rows=persisted.concat(legacyRecords(persisted,history,now)),byOrigin=new Map(),skippedByOrigin=new Map();
  for(const row of rows)for(const origin of storedOrigins(row)){if(!byOrigin.has(origin))byOrigin.set(origin,[]);byOrigin.get(origin).push(row);}
  for(const run of history){const id=safeRunId(run?.id);if(!id)continue;for(const skip of Array.isArray(run?.donorSkips)?run.donorSkips:[])try{for(const origin of originsOf(skip)){if(!skippedByOrigin.has(origin))skippedByOrigin.set(origin,new Set());skippedByOrigin.get(origin).add(id);}}catch{}}
  function evaluateOperation(context={}){
  const origins=originsOf(context);if(!origins.length)fail('VALIDATION');
  const matching=[...new Set(origins.flatMap(origin=>byOrigin.get(origin)||[]))],runId=safeRunId(context.runId),manual=context.mode==='manual',reasons=[],advisories=[],warnings=[];
  // Unmatched candidates need no secret-derived computation or storage reads.
  const source=matching.some(row=>['auth','plugin'].includes(row.type))?sourceRef(context.sourceIdentity??context.source):null,material=matching.some(row=>row.type==='visual')?materialRef(context.materialHash):null;
  const supplied=Array.isArray(context.credentials)?context.credentials:context.credentials?[context.credentials]:[],accounts=[];
  const seen=new Set();for(const value of supplied){const identity=pair(value);if(!identity)continue;const signature=JSON.stringify(identity);if(!seen.has(signature)){seen.add(signature);accounts.push(value);}}
  const suppressed=new Set();let global=false;
  const reason=(row,text,extra={})=>({id:row.id,type:TYPES.has(row.type)?row.type:'security',code:safeCode(row.code),origin:storedOrigins(row)[0]||'',scope:scopeOf(row),expiresAt:!recordProblem(row)&&(!['auth','plugin','visual'].includes(row.type)||row.legacy||row.keyMarker===keyMarker)&&validTime(row.expiresAt)?row.expiresAt:null,reason:text,...extra});
  // Even released or expired history stays a tried donor in this automatic run.
  if(!manual&&runId){
   const tried=matching.find(row=>row.runId===runId&&row.type!=='plugin'&&!(row.type==='auth'&&row.retired===false&&!row.legacy&&!recordProblem(row))),skipMatch=origins.some(origin=>skippedByOrigin.get(origin)?.has(runId));
   if(tried||skipMatch){global=true;reasons.push(tried?reason(tried,'Донора вже спробували в цьому запуску.',{type:'current_run',scope:'поточний запуск',expiresAt:null,currentRun:true}):{id:null,type:'current_run',code:'CURRENT_RUN_DONOR_SKIP',origin:origins[0],scope:'поточний запуск',expiresAt:null,reason:'Донора вже спробували в цьому запуску.',currentRun:true});}
  }
  for(const row of matching){
   if(validTime(row.releasedAt))continue;
   const scoped=['auth','plugin','visual'].includes(row.type)&&!row.legacy;
   if(scoped&&row.keyMarker!==keyMarker){global=true;reasons.push(reason(row,'Ключ захисту змінився. Перевірте донора перед повторним підбором.'));continue;}
   const problem=recordProblem(row);if(problem){global=true;reasons.push(reason(row,problem));continue;}
   if(!activeAt(row,now))continue;
   const type=TYPES.has(row.type)?row.type:'security';
   if(type==='auth'||type==='plugin'){
    if(!row.legacy){
     if(!row.sourceRef||!object(row.credentialRefs)||!Object.keys(row.credentialRefs).length){global=true;reasons.push(reason(row,'Підстави обмеження неповні. Перевірте донора перед повторним підбором.'));continue;}
     if(type==='auth'&&(!source||!accounts.length)){const item=reason(row,'Не вдалося визначити поточне джерело або дані для входу. Перевірте донора перед повторним підбором.');if(manual)warnings.push(item);else{global=true;reasons.push(item);}continue;}
     if(source!==row.sourceRef)continue;
     const failed=accounts.filter(account=>origins.some(origin=>row.credentialRefs[origin]===credentialRef(origin,account)));
     if(!failed.length)continue;
     const item=reason(row,type==='plugin'?'Є обмеження Clean Links. Публікація без плагіна з перевіркою вигляду залишається доступною.':'Цю пару логін/пароль відхилено.');
     if(type==='plugin'){advisories.push(item);continue;}if(manual){warnings.push(item);continue;}
     for(const account of failed)suppressed.add(account);reasons.push(item);continue;
    }
   }
   if(type==='visual'&&!row.legacy){if(!row.materialRef){global=true;reasons.push(reason(row,'Відомості про відхилений матеріал неповні. Перевірте донора перед повторним підбором.'));continue;}if(!material){const item=reason(row,'Не вдалося визначити поточний матеріал. Перевірте донора перед повторним підбором.');if(manual)warnings.push(item);else{global=true;reasons.push(item);}continue;}if(material!==row.materialRef)continue;}
   const item=reason(row,type==='manual'?'Донор заборонений вручну.':type==='transient'?'Донор тимчасово недоступний.':row.legacy?'Попередня відмова донора потребує перевірки.':'Обмеження донора потребує перевірки.');
   if(manual&&['transient','auth','visual'].includes(type)){warnings.push(item);continue;}
   if(type==='plugin'){advisories.push(item);continue;}global=true;reasons.push(item);
  }
  const allowedCredentials=global?[]:accounts.filter(account=>!suppressed.has(account)),blocked=global||accounts.length>0&&allowedCredentials.length===0;
  const expiries=reasons.map(row=>time(row.expiresAt)).filter(Number.isFinite),expiresAt=reasons.some(row=>!row.expiresAt)?null:expiries.length?iso(Math.max(...expiries)):null;
  return {allowed:!blocked,blocked,reason:reasons[0]?.reason||null,expiresAt,credentials:allowedCredentials,allowedCredentials,reasons,advisories,warnings};
  }
  return Object.freeze({evaluate:evaluateOperation,hasRestrictions:rows.length>0||skippedByOrigin.size>0,hasMaterialRestrictions:rows.some(row=>row.type==='visual')});
 }
 function evaluate(context={}){return snapshot().evaluate(context);}
 function listPublic(query={}){
  if(!object(query))fail('VALIDATION');const offset=query.offset===undefined?0:Number(query.offset),limit=query.limit===undefined?100:Number(query.limit);
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1000||query.search!==undefined&&(typeof query.search!=='string'||query.search.length>1000)||query.state!==undefined&&!['all','active','expired','released','advisory'].includes(query.state))fail('VALIDATION');
  const now=clock(),all=records().map(row=>publicRecord(row,now)),search=(query.search||'').toLowerCase(),filtered=all.filter(row=>(!query.state||query.state==='all'||row.state===query.state)&&(!search||[row.origin,...row.origins,row.code,row.type,row.scope].join(' ').toLowerCase().includes(search)));
  const counts={manual:0,transient:0,auth:0,visual:0,security:0,advisory:0,released:0,expired:0};for(const row of all){if(row.state==='released'||row.state==='expired'||row.state==='advisory')counts[row.state]++;else counts[row.type]=(counts[row.type]||0)+1;}
  const items=filtered.slice(offset,offset+limit);return {items,rows:items,total:filtered.length,offset,limit,counts};
 }
 function setManualBan({origin,expectedRevision}={}){
  const normalized=originOf(origin);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail('VALIDATION');
  return store.atomic(()=>{
   const previous=privateRecords().find(row=>row.type==='manual'&&storedOrigins(row).includes(normalized)),at=iso(clock());if(!at)fail('VALIDATION');
   if(previous){if(previous.revision!==expectedRevision)fail('CONFLICT');return publicRecord(store.updatePolicyRecord(previous.id,{releasedAt:null,events:[...(previous.events||[]),{action:'ban',at}]},expectedRevision));}
   if(expectedRevision!==0)fail('CONFLICT');return publicRecord(store.createPolicyRecord(KIND,{format:FORMAT,type:'manual',code:'MANUAL_BAN',origin:normalized,origins:[normalized],runId:null,observedAt:at,expiresAt:null,releasedAt:null,events:[{action:'ban',at}]}));
  });
 }
 function release({id,expectedRevision}={}){
  if(typeof id!=='string'||!id||id.length>200||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail('VALIDATION');
  return store.atomic(()=>{
   const stored=store.getPolicyRecord(id),row=stored||legacyRecords().find(row=>row.id===id);if(!row||row.kind!==KIND)fail('NOT_FOUND');if(row.revision!==expectedRevision)fail('CONFLICT');const at=iso(clock());if(!at)fail('VALIDATION');
   const patch={releasedAt:at,events:[...(row.events||[]),{action:'release',at}]};
   if(stored)return publicRecord(store.updatePolicyRecord(id,patch,expectedRevision));
   const {id:ignoredId,kind,revision,...observation}=row;return publicRecord(store.createPolicyRecord(KIND,{...observation,...patch},id));
  });
 }
 return Object.freeze({observe,evaluate,snapshot,listPublic,setManualBan,release});
}
