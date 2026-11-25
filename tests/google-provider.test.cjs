'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const config={spreadsheetId:'workSheet',range:"'ДЛЯ ПІДБОРУ'!B1:O4",columns:{url:'B',username:'K',password:'L',alternateUsername:'N',alternatePassword:'O',dr:'D',traffic:'E',geo:'F'},headerRows:1,authMode:'user'};
test('normal Google account reads mapped donor cells with a private bearer token and no service key',async()=>{
 const {createSiteSource,validateSiteSourceConfig}=await import('../server/lifecycle/site-source.mjs');let tokens=0,calls=[];
 assert.equal(validateSiteSourceConfig(config,{allowMissingAccount:true}).authMode,'user');assert.throws(()=>validateSiteSourceConfig({...config,authMode:'cookie'},{allowMissingAccount:true}));
 const source=createSiteSource({getAccessToken:async()=>{tokens++;return 'fixture-private-token';},transport:async(url,options)=>{calls.push({url,options});return {status:200,url,text:JSON.stringify({values:[['domain','','DR','traffic','geo'],['fixture.example','',44,1200,'(pl, 100)','','','','','worker','site-secret']]})};}});
 const result=await source.readCandidates(config,{criteria:{minDr:30,minTraffic:500,geo:'PL'}});assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].baseUrl,'https://fixture.example/');assert.equal(result.candidates[0].username,'worker');assert.equal(tokens,1);assert.equal(calls.length,1);assert.match(calls[0].url,/^https:\/\/sheets.googleapis.com\/v4\/spreadsheets\/workSheet\/values\//);assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.headers.authorization,'Bearer fixture-private-token');
});
test('Google imports reuse the work account and safe reconnect errors without creating JWTs',async()=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');const calls=[];
 const importer=createProjectImporter({getAccessToken:async()=> 'private-import-token',getAccount:()=>{throw Error('Service account must not be used');},transport:async(url,options)=>{calls.push({url,options});return {status:200,url,text:JSON.stringify({values:[['url','anchor','language','geo'],['https://example.com/','Exact','pl','PL']]})};}});
 const result=await importer.preview({type:'ai',spreadsheetUrl:'workSheet',range:"'ДЛЯ ПІДБОРУ'!A1:D3"});assert.deepEqual(result.issues,[]);assert.equal(result.items[0].geo,'PL');assert.equal(calls.length,1);assert.equal(calls[0].options.headers.authorization,'Bearer private-import-token');assert.doesNotMatch(JSON.stringify(result),/private-import-token/);
 const denied=createProjectImporter({getAccessToken:async()=>{throw Object.assign(Error('secret provider payload'),{code:'GOOGLE_AUTH_REQUIRED'});}});const error=await denied.preview({type:'ai',spreadsheetUrl:'workSheet',range:'A1:D3'});assert.equal(error.issues[0].code,'GOOGLE_AUTH_REQUIRED');assert.doesNotMatch(JSON.stringify(error),/secret provider payload/);
});
test('a work account without Sheet permission reports 403 without provider text',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),source=createSiteSource({getAccessToken:async()=> 'private-token',transport:async url=>({status:403,url,text:'private-provider-payload'})});
 await assert.rejects(source.readCandidates(config),error=>error.code==='source_access_denied'&&!/private/.test(error.message));
});

test('Google work account can supply import access before a donor sheet is configured',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-google-no-donor-')),{createLifecycleService}=await import('../server/lifecycle/service.mjs');let reads=0;
 const googleAuth={status:()=>({clientConfigured:true,connected:true,phase:'connected',email:'work@example.com'}),accessToken:async()=>{reads++;return 'private-import-token';},close:async()=>{}};
 const s=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,64).toString('base64'),googleAuth});t.after(async()=>{await s.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal(s.autopilot.status().authMode,'user');assert.equal(await s.autopilot.googleAccessToken(),'private-import-token');assert.equal(reads,1);assert.equal(s.autopilot.status().configured,false);
});
test('normal Google provider can be saved, checked and switched back to a service account',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-google-provider-')),{createLifecycleService}=await import('../server/lifecycle/service.mjs');let connected=false,closed=false,reads=0;
 const safe=()=>({clientConfigured:true,connected,phase:connected?'connected':'idle',email:connected?'work@example.com':''});
 const googleAuth={status:safe,configure:async()=>safe(),start:async()=>({authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture',expiresAt:Date.now()+300000,status:safe()}),cancel:async()=>safe(),disconnect:async()=>{connected=false;return safe();},close:async()=>{closed=true;},accessToken:async()=>{if(!connected)throw Object.assign(Error('private'),{code:'GOOGLE_AUTH_REQUIRED'});return 'private';}};
 const s=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,63).toString('base64'),googleAuth,autopilotOptions:{source:{readCandidates:async value=>{reads++;assert.equal(value.authMode,'user');return {candidates:[],issues:[]};}}}});
 t.after(async()=>{await s.close();fs.rmSync(dir,{recursive:true,force:true});assert.equal(closed,true);});
 const q=async(route,body,headers={})=>{const response=await s.handle(new Request('http://localhost/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost','X-PagePoster-Request':'1','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
 assert.equal((await q('/google/account')).account.connected,false);assert.equal((await q('/autopilot/source',config)).source.configured,false);assert.equal((await q('/autopilot/source/check',{})).code,'SOURCE_NOT_CONFIGURED');assert.equal(reads,0);
 connected=true;const status=await q('/autopilot/status');assert.equal(status.source.configured,true);assert.equal(status.source.authMode,'user');assert.equal(status.source.accountEmail,'work@example.com');assert.equal((await q('/autopilot/source/check',{})).candidateCount,0);assert.equal(reads,1);assert.equal(await s.autopilot.googleAccessToken(),'private');
 assert.equal((await q('/google/client',{client:{installed:{client_id:'fixture'}}})).status,200);assert.equal((await q('/google/client',{client:{},extra:true})).status,400);assert.equal((await q('/google/connect',{})).status.connected,true);assert.equal((await q('/google/cancel',{})).status,200);assert.equal((await q('/google/disconnect',{})).account.connected,false);assert.equal(s.autopilot.status().configured,false);
 const service=await q('/autopilot/source',{...config,authMode:'service',serviceAccount:{client_email:'service@example.com',private_key:'fixture'}});assert.equal(service.source.configured,true);assert.equal(service.source.authMode,'service');assert.equal(await s.autopilot.googleAccessToken(),null);assert.equal((await q('/google/connect',{}, {Origin:'https://evil.example'})).status,403);
});
