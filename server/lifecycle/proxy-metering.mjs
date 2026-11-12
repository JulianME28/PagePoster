const EVENT='proxy_usage_event',ATTEMPT='proxy_usage_attempt';
const scopes=['browser','verification'];
const counters=['bytesSent','bytesReceived','requests','connections'];
const fail=code=>{throw Object.assign(Error(code),{code});};
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value);
const empty=()=>({bytesSent:0,bytesReceived:0,requests:0,connections:0});
const emptyScopes=()=>({browser:empty(),verification:empty()});
function add(left,right){
 return Object.fromEntries(counters.map(key=>{
  const value=left[key]+right[key];
  if(!Number.isSafeInteger(value)||value<0)fail('VALIDATION');
  return [key,value];
 }));
}

export function createProxyMetering(store){
 let incomplete=false;
 function recordProxyUsage({eventId,attemptId,runId=null,projectId,scope,bytesSent,bytesReceived,requests,connections}={}){
  const counts={bytesSent,bytesReceived,requests,connections};
  if(![eventId,attemptId,projectId].every(id)||(runId!==null&&!id(runId))||!scopes.includes(scope)||
     counters.some(key=>!Number.isSafeInteger(counts[key])||counts[key]<0))fail('VALIDATION');
  const eventKey='proxy-usage-event:'+eventId,attemptKey='proxy-usage-attempt:'+attemptId;
  const event={attemptId,runId,scope,counts};
  return store.atomic(()=>{
   const previous=store.getRecord(eventKey);
   if(previous){
    if(previous.kind!==EVENT||previous.projectId!==projectId||previous.attemptId!==attemptId||previous.runId!==runId||
       previous.scope!==scope||counters.some(key=>previous.counts?.[key]!==counts[key]))fail('CONFLICT');
    return false;
   }
   const attempt=store.getRecord(attemptKey);
   if(attempt&&(attempt.kind!==ATTEMPT||attempt.projectId!==projectId||attempt.runId!==runId))fail('CONFLICT');
   const byScope=attempt?.byScope||emptyScopes();
   const next={...byScope,[scope]:add(byScope[scope],counts)};
   store.createRecord(projectId,EVENT,event,eventKey);
   if(attempt)store.updateRecord(attemptKey,{byScope:next},attempt.revision);
   else store.createRecord(projectId,ATTEMPT,{attemptId,runId,byScope:next},attemptKey);
   return true;
  });
 }
 function proxyUsageSummary({projectId,runId}={}){
  if(!id(projectId)||runId!==undefined&&!id(runId))fail('VALIDATION');
  const byScope=emptyScopes();
  const attempts=store.listRecords(projectId,ATTEMPT).filter(row=>runId===undefined||row.runId===runId).map(row=>{
   const counts=emptyScopes();
   for(const scope of scopes){counts[scope]=add(counts[scope],row.byScope[scope]);byScope[scope]=add(byScope[scope],counts[scope]);}
   return {attemptId:row.attemptId,runId:row.runId,total:add(counts.browser,counts.verification)};
  });
  return {unit:'http-body-bytes',total:add(byScope.browser,byScope.verification),byScope,attempts,providerBilledBytes:null,cost:null,incomplete};
 }
 function observer(binding){return event=>{try{recordProxyUsage({...event,...binding});}catch{incomplete=true;}};}
 return {recordProxyUsage,proxyUsageSummary,observer};
}
