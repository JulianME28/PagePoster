// Retries are confined to Google API GETs. Token exchanges and all writes use
// their original transport directly and are never replayed here.
const RETRY_STATUS=new Set([429,500,502,503,504]);
const RETRY_ERROR=new Set(['network_timeout','network_failed','dns_failed','ECONNRESET','ETIMEDOUT','EAI_AGAIN','ECONNREFUSED']);
const bounded=(value,fallback,min,max)=>Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
class GoogleReadError extends Error{constructor(code){super(code==='google_read_aborted'?'Google read cancelled.':code==='google_read_rate_limited'?'Google read rate limit exhausted.':'Google read failed.');this.code=code;}}
const fail=code=>{throw new GoogleReadError(code);};
function wait(ms,{signal}={}){
 return new Promise((resolve,reject)=>{
  let timer;const done=error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
  const abort=()=>done(new GoogleReadError('google_read_aborted'));
  if(signal?.aborted)return abort();
  signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>done(),ms);
 });
}
// Even injected transports/waits that ignore their signal must settle promptly
// for their caller. Always observe late settlement and remove the listener.
function abortable(operation,signal){
 return new Promise((resolve,reject)=>{
  const abort=()=>finish(new GoogleReadError('google_read_aborted'));
  const finish=(error,value)=>{signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  if(signal.aborted)return abort();
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{if(signal.aborted)fail('google_read_aborted');return operation();}).then(value=>finish(null,value),finish);
 });
}
function retryAfter(headers,now){
 const value=typeof headers?.get==='function'?headers.get('retry-after'):Object.entries(headers||{}).find(([key])=>key.toLowerCase()==='retry-after')?.[1];
 if(typeof value!=='string'||!value.trim())return null;
 const text=value.trim();
 if(/^\d+(?:\.\d+)?$/.test(text))return Number(text)*1000;
 // Avoid Date.parse's permissive interpretation of arbitrary numeric strings.
 if(!/^[a-z]{3},\s\d{1,2}\s[a-z]{3}\s\d{4}\s\d{2}:\d{2}:\d{2}\sGMT$/i.test(text))return null;
 const date=Date.parse(text);return Number.isFinite(date)?Math.max(0,date-now):null;
}
export function createGoogleRead({transport,clock=Date.now,sleep=wait,random=Math.random,maxAttempts=4,budgetMs=90000,maxDelayMs=60000,baseDelayMs=1000}={}){
 // The deadline covers one GET and all its attempts, including active I/O and
 // waits. A paginated scan can make several independently bounded GETs.
 const attempts=Math.floor(bounded(maxAttempts,4,1,4)),budget=bounded(budgetMs,90000,1,90000),delayCap=bounded(maxDelayMs,60000,0,60000),base=bounded(baseDelayMs,1000,1,60000);
 return async function googleRead(url,options={}){
  let target;try{target=new URL(url);}catch{fail('google_read_failed');}
  if(target.protocol!=='https:'||!['sheets.googleapis.com','www.googleapis.com'].includes(target.hostname)||target.username||target.password||target.port||target.hash||options.method&&options.method!=='GET'||options.body!==undefined)fail('google_read_failed');
  if(options.signal?.aborted)fail('google_read_aborted');
  const started=clock(),controller=new AbortController(),cancel=()=>controller.abort();let expired=false,lastRateLimit=false,waited=0;
  const timer=setTimeout(()=>{expired=true;controller.abort();},budget);
  options.signal?.addEventListener('abort',cancel,{once:true});
  const remaining=()=>budget-Math.max(0,clock()-started,waited);
  const exhausted=()=>fail(lastRateLimit?'google_read_rate_limited':'google_read_failed');
  try{
   for(let attempt=0;attempt<attempts;attempt++){
    if(options.signal?.aborted)fail('google_read_aborted');
    if(expired||remaining()<=0)exhausted();
    let response,error;
    try{response=await abortable(()=>transport(url,{...options,method:'GET',followRedirects:false,signal:controller.signal}),controller.signal);}
    catch(caught){if(options.signal?.aborted)fail('google_read_aborted');if(expired)exhausted();error=caught;}
    if(!error){
     // A malformed or redirected response must never trigger another request.
     if(!response||!Number.isInteger(response.status)||response.status<100||response.status>599||typeof response.text!=='string'||response.url&&response.url!==url)fail('google_read_failed');
     if(!RETRY_STATUS.has(response.status))return response;
     lastRateLimit=response.status===429;
    }else if(!RETRY_ERROR.has(error?.code))throw error;
    if(attempt+1===attempts)exhausted();
    const hint=error?null:retryAfter(response.headers,clock()),jitter=bounded(random(),0.5,0,1);
    const delay=hint??Math.min(delayCap,base*2**attempt*(1+jitter));
    // Never shorten a server's valid hint to fit the configured bounds.
    if(!Number.isFinite(delay)||delay>delayCap||delay>=remaining())exhausted();
    if(delay>0){await abortable(()=>sleep(delay,{signal:controller.signal}),controller.signal);waited+=delay;}
   }
   exhausted();
  }catch(error){if(options.signal?.aborted)fail('google_read_aborted');if(expired)exhausted();throw error;}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);}
 };
}
