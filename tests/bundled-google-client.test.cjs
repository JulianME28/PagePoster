'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const CLIENT={installed:{client_id:'123-pageposter.apps.googleusercontent.com',client_secret:'public-desktop-client-value',project_id:'pageposter-project',redirect_uris:['http://localhost']}};
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-bundled-client-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('bundled client loader keeps only Desktop app registration fields and never user tokens',t=>{
 const {loadGoogleClient}=require('../server/lifecycle/google-client.cjs'),root=temporary(t),file=path.join(root,'google-client.json');
 assert.equal(loadGoogleClient(file),null);fs.writeFileSync(file,JSON.stringify({...CLIENT,access_token:'must-not-bundle',refresh_token:'must-not-bundle',email:'owner@example.com'}));
 assert.deepEqual(loadGoogleClient(file),{installed:{client_id:CLIENT.installed.client_id,client_secret:CLIENT.installed.client_secret}});
});
test('client loader rejects web clients and malformed files with bounded errors',t=>{
 const {loadGoogleClient}=require('../server/lifecycle/google-client.cjs'),root=temporary(t),file=path.join(root,'google-client.json');
 for(const data of ['{broken',JSON.stringify({web:CLIENT.installed}),JSON.stringify({installed:{client_id:'bad',client_secret:'bad'}}),' '.repeat(32769)]){fs.writeFileSync(file,data);assert.throws(()=>loadGoogleClient(file),error=>error.code==='GOOGLE_CLIENT_INVALID'&&!error.message.includes(root));}
});
test('desktop backend automatically loads its fixed bundled app registration',t=>{
 const root=temporary(t),appRoot=path.join(root,'app');fs.mkdirSync(path.join(appRoot,'desktop'),{recursive:true});fs.writeFileSync(path.join(appRoot,'desktop/google-client.json'),JSON.stringify(CLIENT));
 const {createBackendOptions}=require('../desktop/backend.cjs'),options=createBackendOptions({appRoot,dataDir:path.join(root,'data'),keyDir:path.join(root,'keys')},{PAGEPOSTER_ACCESS_TOKEN:'ab'.repeat(32)});
 assert.equal(options.lifecycle.googleClient.installed.client_id,CLIENT.installed.client_id);assert.equal('access_token' in options.lifecycle.googleClient,false);
});

test('one-time developer configuration stores only the app client, atomically',t=>{
 const {configureGoogleClient}=require('../scripts/configure-google-client.cjs'),root=temporary(t),file=path.join(root,'download.json');fs.writeFileSync(file,JSON.stringify({...CLIENT,refresh_token:'not-for-the-app-bundle'}));
 assert.deepEqual(configureGoogleClient({file,sourceRoot:root}),{configured:true});const saved=path.join(root,'desktop/google-client.json'),before=fs.readFileSync(saved,'utf8');assert.doesNotMatch(before,/refresh_token|not-for-the-app-bundle|pageposter-project/);
 fs.writeFileSync(file,'{broken');assert.throws(()=>configureGoogleClient({file,sourceRoot:root}),{code:'GOOGLE_CLIENT_INVALID'});assert.equal(fs.readFileSync(saved,'utf8'),before);assert.deepEqual(fs.readdirSync(path.join(root,'desktop')),['google-client.json']);
});

test('real desktop backend starts authorization from its bundle without a client import',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-managed-google-'));let session;t.after(async()=>{await session?.shutdown();fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.join(root,'desktop'));fs.writeFileSync(path.join(root,'desktop/google-client.json'),JSON.stringify(CLIENT));
 const token='ab'.repeat(32),{startDesktopBackend}=require('../desktop/backend.cjs');session=await startDesktopBackend({config:{appRoot:root,dataDir:path.join(root,'data'),keyDir:path.join(root,'keys')},env:{PAGEPOSTER_ACCESS_TOKEN:token,PAGEPOSTER_MASTER_KEY:Buffer.alloc(32,61).toString('base64')},attachProcessHandlers:false});
 const origin='http://127.0.0.1:'+session.port,headers={Authorization:'Basic '+Buffer.from('pageposter:'+token).toString('base64'),Origin:origin,'X-PagePoster-Request':'1','Content-Type':'application/json'};
 const account=await(await fetch(origin+'/api/lifecycle/google/account',{headers})).json();assert.equal(account.account.clientConfigured,true);assert.equal(account.account.managedClient,true);assert.equal(account.account.connected,false);assert.doesNotMatch(JSON.stringify(account),/public-desktop-client-value/);
 const start=await(await fetch(origin+'/api/lifecycle/google/connect',{method:'POST',headers,body:'{}'})).json();assert.equal(new URL(start.authorizationUrl).searchParams.get('client_id'),CLIENT.installed.client_id);assert.equal(start.status.connected,false);
});

test('a clean desktop accepts a local registration and restores it after restart',async t=>{
 const root=temporary(t),dataDir=path.join(root,'data'),token='ab'.repeat(32);
 const {startDesktopBackend}=require('../desktop/backend.cjs');
 const options={config:{appRoot:root,dataDir,keyDir:path.join(root,'keys')},env:{PAGEPOSTER_ACCESS_TOKEN:token,PAGEPOSTER_MASTER_KEY:Buffer.alloc(32,61).toString('base64')},attachProcessHandlers:false};
 let session=await startDesktopBackend(options);
 try{
  const request=async(route,body,status=200)=>{
   const origin='http://127.0.0.1:'+session.port,headers={Authorization:'Basic '+Buffer.from('pageposter:'+token).toString('base64'),Origin:origin,'X-PagePoster-Request':'1','Content-Type':'application/json'};
   const response=await fetch(origin+'/api/lifecycle/google/'+route,{method:body===undefined?'GET':'POST',headers,body:JSON.stringify(body)});
   assert.equal(response.status,status);
   return response.json();
  };
  assert.equal((await request('account')).account.clientConfigured,false);
  const configured=(await request('client',{client:CLIENT,expectedUnconfigured:true})).account;
  assert.deepEqual(configured,{clientConfigured:true,connected:false,phase:'idle',email:''});
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir,'google-oauth.json'),'utf8'),/public-desktop-client-value|googleusercontent/);
  await session.shutdown();
  session=await startDesktopBackend(options);
  assert.deepEqual((await request('account')).account,configured);
  const replacement={installed:{...CLIENT.installed,client_id:'456-new.apps.googleusercontent.com'}};
  assert.equal((await request('client',{client:replacement,expectedUnconfigured:true},409)).code,'CONFLICT');
  const start=await request('connect',{});
  assert.equal(new URL(start.authorizationUrl).searchParams.get('client_id'),CLIENT.installed.client_id);
 }finally{await session.shutdown();}
});
