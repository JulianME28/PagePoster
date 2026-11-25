// Desktop OAuth owns a temporary loopback listener. Credentials remain server-side.
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createSecretBox} from './secrets.mjs';
import {createSafeTransport} from './network.mjs';
import {normalizeGoogleClient} from './google-client.cjs';

const IDENTITY='pageposter:google-oauth:v1';
const AUTH='https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN='https://oauth2.googleapis.com/token';
const USERINFO='https://openidconnect.googleapis.com/v1/userinfo';
const SCOPES=['https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/drive.readonly','openid','email'];
const MESSAGES={KEY_REQUIRED:'An encryption key is required to connect Google.',GOOGLE_CLIENT_REQUIRED:'Import a Google Desktop OAuth client first.',GOOGLE_CLIENT_INVALID:'A valid Google Desktop OAuth client JSON is required.',CONFLICT:'Google registration already exists or is being configured.',GOOGLE_AUTH_REQUIRED:'Connect your Google account to continue.',GOOGLE_AUTH_FAILED:'Google sign-in could not be completed. Try connecting again.',GOOGLE_AUTH_CANCELLED:'Google sign-in was cancelled.',GOOGLE_AUTH_TIMEOUT:'Google sign-in expired. Try connecting again.'};
const failure=code=>Object.assign(new Error(MESSAGES[code]),{code});
const fail=code=>{throw failure(code);};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const secret=(value,max=8192)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u0020\u007f]/.test(value);

function clientFrom(raw){
 const {client_id,client_secret}=normalizeGoogleClient(raw).installed;return {clientId:client_id,clientSecret:client_secret};
}
function scopesFrom(raw){
 if(typeof raw!=='string'||raw.length>4096)fail('GOOGLE_AUTH_FAILED');
 const scopes=[...new Set(raw.split(/\s+/).filter(Boolean).map(s=>s==='https://www.googleapis.com/auth/userinfo.email'?'email':s))];
 if(scopes.some(s=>!SCOPES.includes(s))||SCOPES.some(s=>!scopes.includes(s)))fail('GOOGLE_AUTH_FAILED');
 return scopes;
}
function tokenFrom(raw,previous,now){
 if(!object(raw)||!secret(raw.access_token)||raw.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(raw.expires_in)||raw.expires_in<=0||raw.expires_in>86400)fail('GOOGLE_AUTH_FAILED');
 const refreshToken=raw.refresh_token===undefined?previous?.refreshToken:raw.refresh_token;
 if(!secret(refreshToken))fail('GOOGLE_AUTH_FAILED');
 const scopes=raw.scope===undefined&&previous?previous.scopes:scopesFrom(raw.scope);
 return {accessToken:raw.access_token,refreshToken,expiresAt:now+raw.expires_in*1000,scopes,email:previous?.email||''};
}
function storedFrom(raw){
 if(!object(raw)||raw.version!==1)fail('GOOGLE_AUTH_FAILED');
 const client=clientFrom({installed:{client_id:raw.client?.clientId,client_secret:raw.client?.clientSecret}});
 let tokens=null;
 if(raw.tokens){
  const t=raw.tokens;
  if(!object(t)||!secret(t.accessToken)||!secret(t.refreshToken)||!Number.isFinite(t.expiresAt)||!Array.isArray(t.scopes)||typeof t.email!=='string'||!validEmail(t.email))fail('GOOGLE_AUTH_FAILED');
  tokens={accessToken:t.accessToken,refreshToken:t.refreshToken,expiresAt:t.expiresAt,scopes:scopesFrom(t.scopes.join(' ')),email:t.email};
 }
 return {client,tokens};
}
const validEmail=email=>typeof email==='string'&&email.length<=320&&/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/.test(email);
function respond(res,success,status=success?200:400){
 if(res.destroyed||res.writableEnded)return;
 res.writeHead(status,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',connection:'close'});
 res.end('<!doctype html><html><head><meta charset="utf-8"><title>PagePoster Google sign-in</title></head><body><p>'+(success?'Google account connected. You can close this window and return to PagePoster.':'Google sign-in did not complete. Return to PagePoster and try again.')+'</p></body></html>');
}

export async function createGoogleOAuth({dataDir,masterKey,defaultClient=null,transport=createSafeTransport({allowWrites:true,maxBytes:65536,maxRequestBytes:32768}),clock=Date.now,timeoutMs=5*60*1000}={}){
 let box=null,client=null,tokens=null,pending=null,startPromise=null,refreshPromise=null,revision=0,closed=false,closing=false,lastError=null,writes=Promise.resolve();
 let configuringRevision=0;
 const bundledClient=defaultClient===null?null:clientFrom(defaultClient);
 try{if(masterKey)box=createSecretBox(masterKey);}catch{/* Missing or malformed keys fail closed on credential operations. */}
 const file=join(dataDir,'google-oauth.json');
 const duration=Number.isInteger(timeoutMs)&&timeoutMs>0?Math.min(timeoutMs,10*60*1000):5*60*1000;
 const status=()=>({clientConfigured:!!client,connected:!!tokens,phase:pending?'waiting':lastError?'error':tokens?'connected':'idle',email:tokens?.email||'',...(bundledClient?{managedClient:true}:{}),...(lastError?{error:{code:lastError,message:MESSAGES[lastError]}}:{})});
 const keyRequired=()=>{if(!box)fail('KEY_REQUIRED');};
 const assertCurrent=version=>{if(closed||version!==revision)fail('GOOGLE_AUTH_REQUIRED');};
 const setError=code=>{lastError=code;};
 function stop(tx,force=false){
  if(!tx)return;tx.active=false;clearTimeout(tx.timer);tx.controller.abort();if(pending===tx)pending=null;
  if(tx.server){tx.server.close();if(force)tx.server.closeAllConnections();}
 }
 async function save(version,nextClient,nextTokens){
  keyRequired();
  const payload=JSON.stringify({version:1,client:nextClient,tokens:nextTokens});
  if(payload.length>32768)fail('GOOGLE_AUTH_FAILED');
  const envelope=box.encrypt(IDENTITY,{username:'google-oauth',applicationPassword:payload});
  const task=writes.catch(()=>{}).then(async()=>{
   assertCurrent(version);await mkdir(dataDir,{recursive:true,mode:0o700});
   const temporary=file+'.'+randomBytes(12).toString('hex')+'.tmp';let handle;
   try{
    handle=await open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(envelope),'utf8');await handle.sync();await handle.close();handle=null;
    assertCurrent(version);await rename(temporary,file);
   }finally{if(handle)await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
  });
  writes=task;return task;
 }
 async function request(url,options){
  // Only these fixed endpoints may receive secrets. Redirects are never followed.
  let response;
  try{response=await transport(url,{...options,followRedirects:false});}catch{fail('GOOGLE_AUTH_FAILED');}
  if(response?.url&&response.url!==url||response?.redirects?.length)fail('GOOGLE_AUTH_FAILED');
  const text=typeof response?.text==='string'?response.text:Buffer.isBuffer(response?.body)?response.body.toString('utf8'):'';
  if(text.length>65536)fail('GOOGLE_AUTH_FAILED');
  let body;try{body=JSON.parse(text);}catch{fail('GOOGLE_AUTH_FAILED');}
  if(!object(body))fail('GOOGLE_AUTH_FAILED');
  if(response.status<200||response.status>=300){if(url===TOKEN&&body.error==='invalid_grant')return {invalidGrant:true};fail('GOOGLE_AUTH_FAILED');}
  return body;
 }
 const exchange=(fields,signal)=>request(TOKEN,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},body:new URLSearchParams(fields).toString(),signal});
 try{
  const content=await readFile(file,'utf8');keyRequired();if(content.length>65536)throw 0;
  const stored=storedFrom(JSON.parse(box.decrypt(IDENTITY,JSON.parse(content)).applicationPassword));client=stored.client;tokens=stored.tokens;
 }catch(error){if(error?.code!=='ENOENT')setError(error?.code==='KEY_REQUIRED'?'KEY_REQUIRED':'GOOGLE_AUTH_FAILED');}
 // Existing grants keep their original client. A fresh installation receives
 // the application registration automatically, without a user JSON import.
 if(!client&&bundledClient)client=bundledClient;

 async function configure(raw,{expectedUnconfigured=false}={}){
  keyRequired();if(closed||closing)fail('GOOGLE_AUTH_FAILED');
  if(expectedUnconfigured&&(client||configuringRevision))fail('CONFLICT');
  const configured=clientFrom(raw),version=++revision;
  // Reserve the empty profile before the first await so a second setup
  // cannot enter while the first registration is still being saved.
  configuringRevision=version;
  stop(pending,true);tokens=null;client=null;lastError=null;refreshPromise=null;
  try{await save(version,configured,null);assertCurrent(version);client=configured;return status();}catch(error){if(version===revision)setError('GOOGLE_AUTH_FAILED');throw failure(error?.code==='GOOGLE_AUTH_REQUIRED'?'GOOGLE_AUTH_REQUIRED':'GOOGLE_AUTH_FAILED');}
  finally{if(configuringRevision===version)configuringRevision=0;}
 }
 async function onCallback(tx,req,res){
  try{
   if(!tx.active||pending!==tx||tx.revision!==revision||closed)return respond(res,false,409);
   let url;try{url=new URL(req.url,'http://'+tx.host);}catch{return respond(res,false);}
   if(req.method!=='GET'||req.headers.host!==tx.host||url.origin!=='http://'+tx.host||url.pathname!=='/oauth2/callback'||url.hash||req.url.length>8192)return respond(res,false);
   const params=url.searchParams;for(const key of params.keys())if(params.getAll(key).length!==1)return respond(res,false);
   const state=params.get('state')||'',expected=Buffer.from(tx.state),actual=Buffer.from(state);
   if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return respond(res,false);
   if(tx.handling)return respond(res,false,409);
   tx.handling=true;
   if(params.has('error')){setError(params.get('error')==='access_denied'?'GOOGLE_AUTH_CANCELLED':'GOOGLE_AUTH_FAILED');respond(res,false);stop(tx);return;}
   const code=params.get('code');if(!secret(code,4096)){setError('GOOGLE_AUTH_FAILED');respond(res,false);stop(tx);return;}
   const current=client;
   const raw=await exchange({client_id:current.clientId,client_secret:current.clientSecret,code,code_verifier:tx.verifier,grant_type:'authorization_code',redirect_uri:tx.redirectUri},tx.controller.signal);
   assertCurrent(tx.revision);if(!tx.active||pending!==tx)fail('GOOGLE_AUTH_REQUIRED');
   const next=tokenFrom(raw,null,clock());
   const profile=await request(USERINFO,{method:'GET',headers:{accept:'application/json',authorization:'Bearer '+next.accessToken},signal:tx.controller.signal});
   assertCurrent(tx.revision);if(!tx.active||pending!==tx)fail('GOOGLE_AUTH_REQUIRED');
   if(typeof profile.sub!=='string'||!profile.sub||profile.sub.length>255||!validEmail(profile.email)||profile.email_verified!==true)fail('GOOGLE_AUTH_FAILED');next.email=profile.email;
   await save(tx.revision,current,next);assertCurrent(tx.revision);if(!tx.active||pending!==tx)fail('GOOGLE_AUTH_REQUIRED');
   tokens=next;lastError=null;respond(res,true);stop(tx);
  }catch{if(tx.active&&pending===tx&&tx.revision===revision){setError('GOOGLE_AUTH_FAILED');respond(res,false);stop(tx);}else respond(res,false,409);}
 }
 async function begin(){
  keyRequired();if(closed||closing)fail('GOOGLE_AUTH_FAILED');if(!client)fail('GOOGLE_CLIENT_REQUIRED');
  if(pending?.result)return pending.result;
  // Reauthentication starts a new account transaction. A refresh begun for the
  // previous account must never overwrite the account selected in this flow.
  ++revision;refreshPromise=null;
  const tx={active:true,handling:false,revision,state:randomBytes(32).toString('base64url'),verifier:randomBytes(32).toString('base64url'),controller:new AbortController()};pending=tx;lastError=null;
  tx.server=createServer((req,res)=>{void onCallback(tx,req,res);});tx.server.maxHeadersCount=32;tx.server.headersTimeout=10000;tx.server.requestTimeout=15000;
  try{
   await new Promise((resolve,reject)=>{
    const cleanup=()=>{tx.controller.signal.removeEventListener('abort',abort);tx.server.removeListener('error',error);};
    const abort=()=>{cleanup();reject(failure('GOOGLE_AUTH_REQUIRED'));};
    const error=()=>{cleanup();reject(failure('GOOGLE_AUTH_FAILED'));};
    tx.controller.signal.addEventListener('abort',abort,{once:true});tx.server.once('error',error);
    tx.server.listen(0,'127.0.0.1',()=>{cleanup();resolve();});
   });
   assertCurrent(tx.revision);if(!tx.active||pending!==tx)fail('GOOGLE_AUTH_REQUIRED');
   tx.host='127.0.0.1:'+tx.server.address().port;tx.redirectUri='http://'+tx.host+'/oauth2/callback';
   const authorization=new URL(AUTH);authorization.search=new URLSearchParams({client_id:client.clientId,redirect_uri:tx.redirectUri,response_type:'code',scope:SCOPES.join(' '),state:tx.state,code_challenge:createHash('sha256').update(tx.verifier).digest('base64url'),code_challenge_method:'S256',access_type:'offline',prompt:'select_account consent'}).toString();
   const expiresAt=clock()+duration;tx.timer=setTimeout(()=>{if(pending===tx&&tx.active)void abandon('GOOGLE_AUTH_TIMEOUT').catch(()=>{});},duration);tx.timer.unref?.();
   tx.result={authorizationUrl:authorization.href,expiresAt,status:status()};return tx.result;
  }catch(error){stop(tx,true);if(tx.revision===revision&&!closed)setError('GOOGLE_AUTH_FAILED');throw failure(error?.code==='KEY_REQUIRED'?'KEY_REQUIRED':error?.code==='GOOGLE_AUTH_REQUIRED'?'GOOGLE_AUTH_REQUIRED':'GOOGLE_AUTH_FAILED');}
 }
 function start(){
  if(startPromise)return startPromise;
  const promise=begin();startPromise=promise;promise.finally(()=>{if(startPromise===promise)startPromise=null;}).catch(()=>{});return promise;
 }
 async function accessToken(){
  if(closed||closing||!tokens)fail('GOOGLE_AUTH_REQUIRED');
  if(tokens.expiresAt-clock()>30000)return tokens.accessToken;
  // Keep the old account available until sign-in succeeds, but do not let a
  // refresh for it participate in the pending account transaction.
  if(pending)fail('GOOGLE_AUTH_REQUIRED');
  if(refreshPromise)return refreshPromise;
  const version=revision,previous=tokens,current=client;
  const promise=(async()=>{
   try{
    const raw=await exchange({client_id:current.clientId,client_secret:current.clientSecret,refresh_token:previous.refreshToken,grant_type:'refresh_token'});
    assertCurrent(version);
    if(raw.invalidGrant){tokens=null;setError('GOOGLE_AUTH_REQUIRED');await save(version,current,null);fail('GOOGLE_AUTH_REQUIRED');}
    const next=tokenFrom(raw,previous,clock());await save(version,current,next);assertCurrent(version);tokens=next;lastError=null;return next.accessToken;
   }catch(error){
    if(version!==revision||closed)fail('GOOGLE_AUTH_REQUIRED');
    if(error?.code==='GOOGLE_AUTH_REQUIRED')throw failure('GOOGLE_AUTH_REQUIRED');
    setError('GOOGLE_AUTH_FAILED');throw failure('GOOGLE_AUTH_FAILED');
   }
  })();refreshPromise=promise;
  promise.finally(()=>{if(refreshPromise===promise)refreshPromise=null;}).catch(()=>{});return promise;
 }
 async function abandon(code){
  if(!pending)return status();
  // A callback may already be renaming its encrypted file. Serialize a snapshot
  // of the existing account after that write so cancellation cannot resurrect it.
  const version=++revision;stop(pending,true);setError(code);refreshPromise=null;
  if(client)try{await save(version,client,tokens);}catch{if(version===revision)setError('GOOGLE_AUTH_FAILED');throw failure('GOOGLE_AUTH_FAILED');}
  return status();
 }
 const cancel=()=>abandon('GOOGLE_AUTH_CANCELLED');
 async function disconnect(){
  const version=++revision;stop(pending,true);tokens=null;lastError=null;refreshPromise=null;
  if(client)try{await save(version,client,null);}catch{if(version===revision)setError(box?'GOOGLE_AUTH_FAILED':'KEY_REQUIRED');throw failure(box?'GOOGLE_AUTH_FAILED':'KEY_REQUIRED');}
  return status();
 }
 async function close(){if(closed||closing)return;closing=true;try{await abandon('GOOGLE_AUTH_CANCELLED');}finally{closed=true;++revision;stop(pending,true);await writes.catch(()=>{});}}
 return Object.freeze({status,configure,start,accessToken,cancel,disconnect,close});
}
