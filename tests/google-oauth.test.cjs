'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,readFile,rm,readdir}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const http=require('node:http');
const client={installed:{client_id:'123-fixture.apps.googleusercontent.com',client_secret:'fixture-client-secret',auth_uri:'https://evil.example/authorize',token_uri:'https://evil.example/token',redirect_uris:['http://localhost']}};
const scopes='https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly openid email';
const json=(body,status=200)=>({status,headers:{'content-type':'application/json'},text:JSON.stringify(body)});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function callback(start,{state,code='fixture-code',query='',path,method='GET',host}={}){
 const auth=new URL(start.authorizationUrl),url=new URL(auth.searchParams.get('redirect_uri'));
 url.pathname=path||url.pathname;url.search='';url.searchParams.set('state',state===undefined?auth.searchParams.get('state'):state);if(code!==null)url.searchParams.set('code',code);url.search+=query;
 return new Promise((resolve,reject)=>{const req=http.request(url,{method,headers:host?{host}:{}},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();});
}
async function fixture(t,{transport,clock,timeoutMs,defaultClient}={}){
 const dir=await mkdtemp(join(tmpdir(),'pageposter-oauth-')),key=randomBytes(32).toString('base64'),calls=[];
 const wire=transport||(async(url,options)=>{calls.push({url,options});if(url==='https://oauth2.googleapis.com/token')return json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:scopes});if(url==='https://openidconnect.googleapis.com/v1/userinfo')return json({sub:'fixture-sub',email:'reader@example.com',email_verified:true});assert.fail('Unexpected endpoint '+url);});
 const {createGoogleOAuth}=await import('../server/lifecycle/google-oauth.mjs');
 const oauth=await createGoogleOAuth({dataDir:dir,masterKey:key,transport:wire,clock,timeoutMs,defaultClient});
 t.after(async()=>{await oauth.close();await rm(dir,{recursive:true,force:true});});
 return {oauth,dir,key,calls,wire,createGoogleOAuth};
}
async function connect(oauth){await oauth.configure(client);const start=await oauth.start();assert.equal((await callback(start)).status,200);assert.equal(oauth.status().connected,true);return start;}

test('conditional setup preserves the active Google registration and grant',async t=>{
 const {oauth,dir,key,wire,createGoogleOAuth}=await fixture(t);
 await connect(oauth);
 const before=oauth.status(),secretFile=join(dir,'google-oauth.json'),saved=await readFile(secretFile);
 const replacement={installed:{...client.installed,client_id:'456-new.apps.googleusercontent.com'}};
 await assert.rejects(oauth.configure(replacement,{expectedUnconfigured:true}),{code:'CONFLICT'});
 assert.deepEqual(oauth.status(),before);
 assert.equal(await oauth.accessToken(),'private-access');
 assert.deepEqual(await readFile(secretFile),saved);
 await oauth.close();
 const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key,transport:wire});t.after(()=>restarted.close());
 assert.equal(await restarted.accessToken(),'private-access');
 assert.equal(new URL((await restarted.start()).authorizationUrl).searchParams.get('client_id'),client.installed.client_id);
});

test('concurrent conditional setup can reserve an empty Google profile only once',async t=>{
 const {oauth}=await fixture(t);
 const replacement={installed:{...client.installed,client_id:'456-new.apps.googleusercontent.com'}};
 const [first,second]=await Promise.allSettled([
  oauth.configure(client,{expectedUnconfigured:true}),
  oauth.configure(replacement,{expectedUnconfigured:true}),
 ]);
 assert.equal(second.status,'rejected');
 assert.equal(second.reason.code,'CONFLICT');
 assert.equal(first.value.clientConfigured,true);
 assert.equal(new URL((await oauth.start()).authorizationUrl).searchParams.get('client_id'),client.installed.client_id);
});

test('bundled Desktop registration permits first sign-in without importing JSON and survives restart',async t=>{
 const {oauth,dir,key,wire,createGoogleOAuth}=await fixture(t,{defaultClient:client});
 assert.equal(oauth.status().clientConfigured,true);assert.equal(oauth.status().managedClient,true);assert.equal(oauth.status().connected,false);
 const start=await oauth.start();assert.equal(new URL(start.authorizationUrl).searchParams.get('client_id'),client.installed.client_id);assert.equal((await callback(start)).status,200);await oauth.close();
 const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key,transport:wire,defaultClient:client});t.after(()=>restarted.close());assert.equal(restarted.status().connected,true);assert.equal(restarted.status().managedClient,true);assert.equal(await restarted.accessToken(),'private-access');
 assert.doesNotMatch(JSON.stringify(restarted.status()),/client-secret|private-access|private-refresh/);
});

test('adding a bundled registration preserves an already connected account',async t=>{
 const {oauth,dir,key,wire,createGoogleOAuth}=await fixture(t);await connect(oauth);await oauth.close();
 const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key,transport:wire,defaultClient:{installed:{...client.installed,client_id:'456-built-in.apps.googleusercontent.com'}}});t.after(()=>restarted.close());assert.equal(restarted.status().connected,true);assert.equal(await restarted.accessToken(),'private-access');
});

test('requires a desktop OAuth client and encryption key before opening sign-in',async t=>{
 const {oauth,createGoogleOAuth,dir}=await fixture(t);
 assert.deepEqual(oauth.status(),{clientConfigured:false,connected:false,phase:'idle',email:''});
 await assert.rejects(oauth.start(),{code:'GOOGLE_CLIENT_REQUIRED'});
 for(const bad of [{web:client.installed},{installed:{...client.installed,client_id:'fake.example'}},{installed:{...client.installed,client_secret:''}},'{broken'])await assert.rejects(oauth.configure(bad),{code:'GOOGLE_CLIENT_INVALID'});
 const locked=await createGoogleOAuth({dataDir:dir,transport:async()=>assert.fail('Network must stay idle')});t.after(()=>locked.close());
 await assert.rejects(locked.configure(client),{code:'KEY_REQUIRED'});
});

test('uses PKCE, ephemeral loopback, pinned Google endpoints and only read-only grants',async t=>{
 const {oauth,calls}=await fixture(t);await oauth.configure(JSON.stringify(client));const start=await oauth.start(),auth=new URL(start.authorizationUrl),redirect=new URL(auth.searchParams.get('redirect_uri'));
 assert.equal(auth.origin+auth.pathname,'https://accounts.google.com/o/oauth2/v2/auth');assert.equal(redirect.hostname,'127.0.0.1');assert.notEqual(redirect.port,'');assert.equal(redirect.pathname,'/oauth2/callback');
 assert.equal(auth.searchParams.get('response_type'),'code');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('access_type'),'offline');assert.equal(auth.searchParams.get('prompt'),'select_account consent');assert.equal(auth.searchParams.get('scope'),scopes);
 assert.match(auth.searchParams.get('state'),/^[A-Za-z0-9_-]{43,}$/);assert.deepEqual(await oauth.start(),start);
 const result=await callback(start);assert.equal(result.status,200);assert.match(result.headers['content-security-policy'],/default-src 'none'/);assert.doesNotMatch(result.body,/fixture-code|private-|reader@example/);
 assert.equal(oauth.status().email,'reader@example.com');assert.equal(await oauth.accessToken(),'private-access');assert.equal(calls.length,2);
 const exchange=new URLSearchParams(calls[0].options.body);assert.equal(exchange.get('code'),'fixture-code');assert.equal(exchange.get('redirect_uri'),redirect.href);assert.equal(createHash('sha256').update(exchange.get('code_verifier')).digest('base64url'),auth.searchParams.get('code_challenge'));
 for(const call of calls)assert.equal(call.options.followRedirects,false);assert.equal(calls[1].options.headers.authorization,'Bearer private-access');assert.doesNotMatch(JSON.stringify(oauth.status()),/private-|fixture-code|fixture-client-secret/);
});

test('authenticates encrypted credentials after restart and disconnect retains the client',async t=>{
 const {oauth,dir,key,wire,createGoogleOAuth}=await fixture(t);await connect(oauth);await oauth.close();
 const stored=await readFile(join(dir,'google-oauth.json'),'utf8');assert.doesNotMatch(stored,/private-|reader@example|fixture-client-secret|client_id/);assert.deepEqual(await readdir(dir),['google-oauth.json']);
 const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key,transport:wire});t.after(()=>restarted.close());assert.equal(restarted.status().email,'reader@example.com');assert.equal(await restarted.accessToken(),'private-access');
 await restarted.disconnect();assert.deepEqual(restarted.status(),{clientConfigured:true,connected:false,phase:'idle',email:''});await assert.rejects(restarted.accessToken(),{code:'GOOGLE_AUTH_REQUIRED'});
 const again=await createGoogleOAuth({dataDir:dir,masterKey:key,transport:wire});t.after(()=>again.close());assert.equal(again.status().clientConfigured,true);assert.equal(again.status().connected,false);
 const wrong=await createGoogleOAuth({dataDir:dir,masterKey:randomBytes(32).toString('base64'),transport:wire});t.after(()=>wrong.close());assert.equal(wrong.status().connected,false);assert.equal(wrong.status().error.code,'GOOGLE_AUTH_FAILED');
});

test('wrong state, wrong host, wrong path, duplicate keys and POST cannot consume sign-in',async t=>{
 const {oauth,calls}=await fixture(t);await oauth.configure(client);const start=await oauth.start();
 for(const opts of [{state:'wrong'},{host:'evil.example'},{path:'/wrong'},{query:'&state=duplicate'},{query:'&code=duplicate'},{method:'POST'}]){assert.notEqual((await callback(start,opts)).status,200);assert.equal(oauth.status().phase,'waiting');}
 assert.equal(calls.length,0);assert.equal((await callback(start)).status,200);assert.equal(calls.length,2);
 await assert.rejects(callback(start));assert.equal(calls.length,2);
});

test('denial, cancellation and timeout are safe and close their listeners',async t=>{
 const {oauth}=await fixture(t,{timeoutMs:40});await oauth.configure(client);let start=await oauth.start();
 const denied=await callback(start,{code:null,query:'&error=access_denied&error_description=private-provider-error'});assert.notEqual(denied.status,200);assert.equal(oauth.status().error.code,'GOOGLE_AUTH_CANCELLED');assert.doesNotMatch(JSON.stringify(oauth.status())+denied.body,/private-provider-error/);
 start=await oauth.start();await oauth.cancel();assert.equal(oauth.status().error.code,'GOOGLE_AUTH_CANCELLED');await assert.rejects(callback(start));
 await oauth.start();await new Promise(r=>setTimeout(r,80));assert.equal(oauth.status().error.code,'GOOGLE_AUTH_TIMEOUT');
});

test('rejects missing, write-capable or incomplete grants and unverified email',async t=>{
 for(const grant of [undefined,scopes+' https://www.googleapis.com/auth/drive',scopes.replace('https://www.googleapis.com/auth/drive.readonly ','')]){
  const {oauth}=await fixture(t,{transport:async url=>url.endsWith('/token')?json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:grant}):json({sub:'id',email:'reader@example.com',email_verified:true})});await oauth.configure(client);assert.notEqual((await callback(await oauth.start())).status,200);assert.equal(oauth.status().connected,false);assert.equal(oauth.status().error.code,'GOOGLE_AUTH_FAILED');
 }
 const {oauth}=await fixture(t,{transport:async url=>url.endsWith('/token')?json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:scopes}):json({sub:'id',email:'reader@example.com',email_verified:false})});await oauth.configure(client);assert.notEqual((await callback(await oauth.start())).status,200);assert.equal(oauth.status().connected,false);
});

test('configure and disconnect invalidate callbacks already exchanging a code',async t=>{
 for(const action of ['configure','disconnect']){
  const gate=deferred(),entered=deferred();const {oauth,dir,key,createGoogleOAuth}=await fixture(t,{transport:async()=>{entered.resolve();await gate.promise;return json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:scopes});}});await oauth.configure(client);const pending=callback(await oauth.start()).catch(()=>null);await entered.promise;
  if(action==='configure')await oauth.configure({installed:{...client.installed,client_id:'456-new.apps.googleusercontent.com'}});else await oauth.disconnect();gate.resolve();await pending;assert.equal(oauth.status().connected,false);
  const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key});t.after(()=>restarted.close());assert.equal(restarted.status().connected,false);
 }
});

test('coalesces refresh, retains credentials on transient failure, and clears invalid grant',async t=>{
 let now=100000,mode='login',refreshes=0;const gate=deferred();
 const {oauth,dir,key,createGoogleOAuth}=await fixture(t,{clock:()=>now,transport:async(url,options)=>{
  if(url.endsWith('/userinfo'))return json({sub:'id',email:'reader@example.com',email_verified:true});
  const fields=new URLSearchParams(options.body);if(fields.get('grant_type')==='authorization_code')return json({access_token:'private-access',refresh_token:'private-refresh',expires_in:60,token_type:'Bearer',scope:scopes});
  refreshes++;assert.equal(fields.get('refresh_token'),'private-refresh');if(mode==='transient')return json({error:'temporarily_unavailable',error_description:'private-body'},503);if(mode==='invalid')return json({error:'invalid_grant',error_description:'private-body'},400);await gate.promise;return json({access_token:'private-refreshed',expires_in:3600,token_type:'Bearer'});
 }});await connect(oauth);now+=61000;mode='refresh';const tokens=[oauth.accessToken(),oauth.accessToken(),oauth.accessToken()];gate.resolve();assert.deepEqual(await Promise.all(tokens),['private-refreshed','private-refreshed','private-refreshed']);assert.equal(refreshes,1);
 now+=3601000;mode='transient';await assert.rejects(oauth.accessToken(),e=>e.code==='GOOGLE_AUTH_FAILED'&&!/private-body/.test(e.message));assert.equal(oauth.status().connected,true);
 mode='invalid';await assert.rejects(oauth.accessToken(),{code:'GOOGLE_AUTH_REQUIRED'});assert.equal(oauth.status().connected,false);const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key});t.after(()=>restarted.close());assert.equal(restarted.status().connected,false);
});

test('disconnect invalidates in-flight refresh before it can restore credentials',async t=>{
 let now=1000;const gate=deferred(),entered=deferred();const {oauth,dir,key,createGoogleOAuth}=await fixture(t,{clock:()=>now,transport:async(url,options)=>{
  if(url.endsWith('/userinfo'))return json({sub:'id',email:'reader@example.com',email_verified:true});if(new URLSearchParams(options.body).get('grant_type')==='authorization_code')return json({access_token:'private-access',refresh_token:'private-refresh',expires_in:60,token_type:'Bearer',scope:scopes});entered.resolve();await gate.promise;return json({access_token:'private-late',expires_in:3600,token_type:'Bearer'});
 }});await connect(oauth);now+=61000;const pending=oauth.accessToken();const observed=pending.catch(e=>e);await entered.promise;await oauth.disconnect();gate.resolve();assert.equal((await observed).code,'GOOGLE_AUTH_REQUIRED');assert.equal(oauth.status().connected,false);const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key});t.after(()=>restarted.close());assert.equal(restarted.status().connected,false);
});

test('cancel stops only the pending sign-in and preserves the connected account',async t=>{
 const gate=deferred(),entered=deferred();let exchanges=0;
 const {oauth,dir,key,wire,createGoogleOAuth}=await fixture(t,{transport:async url=>{
  if(url.endsWith('/userinfo'))return json({sub:'id',email:'reader@example.com',email_verified:true});
  if(++exchanges>1){entered.resolve();await gate.promise;}
  return json({access_token:exchanges===1?'private-access':'private-replacement',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:scopes});
 }});await connect(oauth);const pending=callback(await oauth.start()).catch(()=>null);await entered.promise;await oauth.cancel();gate.resolve();await pending;
 assert.equal(oauth.status().connected,true);assert.equal(await oauth.accessToken(),'private-access');
 const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key,transport:wire});t.after(()=>restarted.close());assert.equal(await restarted.accessToken(),'private-access');
});

test('rejects redirected token responses and never leaks provider errors',async t=>{
 for(const reply of [json({error:'private-provider-body'},400),{...json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:scopes}),url:'https://evil.example/token'},json({access_token:'private-access\r\nInjected: secret',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:scopes}),json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:scopes},302)]){
  const {oauth}=await fixture(t,{transport:async()=>reply});await oauth.configure(client);const response=await callback(await oauth.start());assert.notEqual(response.status,200);assert.equal(oauth.status().connected,false);assert.equal(oauth.status().error.code,'GOOGLE_AUTH_FAILED');assert.doesNotMatch(JSON.stringify(oauth.status())+response.body,/private-|Injected|evil\.example/);
 }
});

test('persists Google canonical email scope and refresh token rotation without widening access',async t=>{
 let now=1000,refreshes=0;
 const {oauth}=await fixture(t,{clock:()=>now,transport:async(url,options)=>{
  if(url.endsWith('/userinfo'))return json({sub:'id',email:'reader@example.com',email_verified:true});
  const params=new URLSearchParams(options.body);if(params.get('grant_type')==='authorization_code')return json({access_token:'private-access',refresh_token:'private-refresh',expires_in:60,token_type:'Bearer',scope:scopes.replace('openid email','openid https://www.googleapis.com/auth/userinfo.email')});
  ++refreshes;if(refreshes===1){assert.equal(params.get('refresh_token'),'private-refresh');return json({access_token:'private-next',refresh_token:'private-rotated',expires_in:60,token_type:'Bearer',scope:scopes});}
  assert.equal(params.get('refresh_token'),'private-rotated');return json({access_token:'private-next',expires_in:60,token_type:'Bearer',scope:scopes+' https://www.googleapis.com/auth/spreadsheets'});
 }});await connect(oauth);now+=61000;assert.equal(await oauth.accessToken(),'private-next');now+=61000;await assert.rejects(oauth.accessToken(),{code:'GOOGLE_AUTH_FAILED'});assert.equal(oauth.status().connected,true);
});

test('immediate close or client replacement cannot leave a startup callback listener alive',async t=>{
 for(const action of ['close','configure']){
  const {oauth}=await fixture(t);await oauth.configure(client);const starting=oauth.start();const outcome=starting.catch(e=>e);if(action==='close')await oauth.close();else await oauth.configure(client);assert.equal((await outcome).code,'GOOGLE_AUTH_REQUIRED');assert.equal(oauth.status().connected,false);
 }
});

test('cancel and close while callback persistence begins cannot restore a cancelled account after restart',async t=>{
 for(const action of ['cancel','close']){
  let oauth;const cancellation=deferred();
  const fixtureResult=await fixture(t,{transport:async url=>{
   if(url.endsWith('/userinfo')){setImmediate(()=>{oauth[action]().then(cancellation.resolve);});return json({sub:'id',email:'reader@example.com',email_verified:true});}
   return json({access_token:'private-cancelled',refresh_token:'private-refresh',expires_in:3600,token_type:'Bearer',scope:scopes});
  }});oauth=fixtureResult.oauth;await oauth.configure(client);const response=callback(await oauth.start()).catch(()=>null);await cancellation.promise;await response;await new Promise(r=>setTimeout(r,30));assert.equal(oauth.status().connected,false);
  const restarted=await fixtureResult.createGoogleOAuth({dataDir:fixtureResult.dir,masterKey:fixtureResult.key});t.after(()=>restarted.close());assert.equal(restarted.status().connected,false);
 }
});

test('large bounded OAuth credentials remain encrypted and authenticated across restart',async t=>{
 const access='access-'+ 'a'.repeat(6000),refresh='refresh-'+ 'b'.repeat(6000);
 const {oauth,dir,key,createGoogleOAuth}=await fixture(t,{transport:async url=>url.endsWith('/userinfo')?json({sub:'id',email:'reader@example.com',email_verified:true}):json({access_token:access,refresh_token:refresh,expires_in:3600,token_type:'Bearer',scope:scopes})});
 await connect(oauth);await oauth.close();const stored=await readFile(join(dir,'google-oauth.json'),'utf8');assert.doesNotMatch(stored,/aaaaaa|bbbbbb|fixture-client-secret/);
 const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key});t.after(()=>restarted.close());assert.equal(await restarted.accessToken(),access);
});

test('a refresh from the previous account cannot overwrite a newly connected account',async t=>{
 for(const timing of ['before-sign-in','during-sign-in']){
 let now=1000;const gate=deferred(),entered=deferred();
 const {oauth,dir,key,createGoogleOAuth}=await fixture(t,{clock:()=>now,transport:async(url,options)=>{
  if(url.endsWith('/userinfo'))return json({sub:options.headers.authorization==='Bearer private-B'?'account-B':'account-A',email:options.headers.authorization==='Bearer private-B'?'b@example.com':'a@example.com',email_verified:true});
  const fields=new URLSearchParams(options.body);
  if(fields.get('grant_type')==='authorization_code')return fields.get('code')==='account-b-code'?json({access_token:'private-B',refresh_token:'private-B-refresh',expires_in:3600,token_type:'Bearer',scope:scopes}):json({access_token:'private-A',refresh_token:'private-A-refresh',expires_in:60,token_type:'Bearer',scope:scopes});
  assert.equal(fields.get('refresh_token'),'private-A-refresh');entered.resolve();await gate.promise;return json({access_token:'private-A-late',expires_in:3600,token_type:'Bearer'});
 }});
 await connect(oauth);assert.equal(oauth.status().email,'a@example.com');now+=61000;
 let start;if(timing==='during-sign-in')start=await oauth.start();
 const refresh=oauth.accessToken().catch(error=>error);if(timing==='before-sign-in'){await entered.promise;start=await oauth.start();}
 assert.equal((await callback(start,{code:'account-b-code'})).status,200);assert.equal(oauth.status().email,'b@example.com');
 gate.resolve();const outcome=await refresh;assert.equal(outcome.code,'GOOGLE_AUTH_REQUIRED');assert.equal(oauth.status().email,'b@example.com');assert.equal(await oauth.accessToken(),'private-B');
 const restarted=await createGoogleOAuth({dataDir:dir,masterKey:key,clock:()=>now});t.after(()=>restarted.close());assert.equal(restarted.status().email,'b@example.com');assert.equal(await restarted.accessToken(),'private-B');
 }
});
