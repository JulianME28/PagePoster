const test=require('node:test'),assert=require('node:assert/strict');
const sourceConfig={spreadsheetId:'fixture-sheet',range:'Sites!A1:C20',headerRows:1,columns:{url:'A',username:'B',password:'C'}};
const reply=(url,data,status=200,headers={})=>({url,status,headers,text:JSON.stringify(data)});
const sourceRows={values:[['URL','User','Password'],['https://safe.example','reader',' exact secret ']]};
const importRows={values:[['key','url','anchor'],['one','https://target.example','Exact anchor']]};
function timing(extra={}){let now=1700000000000;const waits=[];return {waits,options:{clock:()=>now,random:()=>0,sleep:async ms=>{waits.push(ms);now+=ms;},...extra}};}

test('donor source recovers from a Google 429 without returning provider text or changing credentials',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),time=timing();let calls=0;
 const source=createSiteSource({getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async(url,options)=>{
  assert.equal(options.method,'GET');assert.equal(options.headers.authorization,'Bearer private-token');calls++;
  return calls===1?reply(url,{error:'private-provider-body'},429,{'retry-after':'1'}):reply(url,sourceRows);
 }});
 const result=await source.readCandidates(sourceConfig);assert.equal(result.candidates[0].baseUrl,'https://safe.example/');assert.equal(result.candidates[0].password,' exact secret ');assert.deepEqual(time.waits,[1000]);assert.equal(calls,2);
});

test('Sheets import recovers from a Google 429 before creating its immutable preview',async()=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs'),time=timing();let calls=0;
 const importer=createProjectImporter({getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>++calls===1?reply(url,{error:'private-provider-body'},429,{'retry-after':'1'}):reply(url,importRows)});
 const result=await importer.preview({type:'ai',spreadsheetUrl:'fixture-sheet'});assert.deepEqual(result.issues,[]);assert.equal(result.items[0].key,'one');assert.deepEqual(time.waits,[1000]);assert.equal(calls,2);
});

test('exhausted Google rate limits have specific safe source and import errors with bounded attempts',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 for(const kind of ['source','import']){const time=timing();let calls=0;const options={getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{calls++;return reply(url,{error:'private-token exact secret'},429,{'retry-after':'1'});}};
  if(kind==='source')await assert.rejects(createSiteSource(options).readCandidates(sourceConfig),error=>error.code==='source_rate_limited'&&!/private-token|exact secret/.test(error.message));
  else{const result=await createProjectImporter(options).preview({type:'ai',spreadsheetUrl:'fixture-sheet'});assert.deepEqual(result.items,[]);assert.equal(result.issues[0].code,'GOOGLE_RATE_LIMITED');assert.doesNotMatch(result.issues[0].message,/private-token|exact secret/);}
  assert.equal(calls,4);assert.deepEqual(time.waits,[1000,1000,1000]);
 }
});

test('auth and missing-file responses never consume a retry in either Google reader',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 for(const status of [401,403,404])for(const kind of ['source','import']){const time=timing();let calls=0;const options={getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{calls++;return reply(url,{error:'secret'},status);}};
  if(kind==='source')await assert.rejects(createSiteSource(options).readCandidates(sourceConfig),error=>['source_auth_failed','source_access_denied','source_read_failed'].includes(error.code));
  else assert.equal((await createProjectImporter(options).preview({type:'ai',spreadsheetUrl:'fixture-sheet'})).issues[0].code,'GOOGLE_ACCESS_DENIED');
  assert.equal(calls,1);assert.deepEqual(time.waits,[]);
 }
});

test('cancelling before a Google read never obtains credentials or contacts Google',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{createProjectImporter}=await import('../server/lifecycle/project-import.mjs'),controller=new AbortController();controller.abort();
 const options={getAccessToken:()=>assert.fail('Cancelled reads must not obtain tokens'),transport:()=>assert.fail('Cancelled reads must not contact Google')};
 await assert.rejects(createSiteSource(options).readCandidates(sourceConfig,{signal:controller.signal}),{code:'source_read_aborted'});
 const result=await createProjectImporter(options).preview({type:'ai',spreadsheetUrl:'fixture-sheet'},{signal:controller.signal});assert.equal(result.issues[0].code,'GOOGLE_READ_ABORTED');
});

test('cancelling during injected backoff settles both readers promptly without issuing another GET',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 for(const kind of ['source','import']){const controller=new AbortController();let started,calls=0;const waiting=new Promise(resolve=>started=resolve),time=timing({sleep:async()=>{started();return new Promise(()=>{});}});
  const options={getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{calls++;return reply(url,{},429,{'retry-after':'1'});}};
  const pending=kind==='source'?createSiteSource(options).readCandidates(sourceConfig,{signal:controller.signal}):createProjectImporter(options).preview({type:'ai',spreadsheetUrl:'fixture-sheet'},{signal:controller.signal});
  await waiting;controller.abort();
  if(kind==='source')await assert.rejects(pending,{code:'source_read_aborted'});else assert.equal((await pending).issues[0].code,'GOOGLE_READ_ABORTED');
  assert.equal(calls,1);
 }
});

test('Retry-After dates are respected and oversized hints stop without an early retry',async()=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 for(const [header,expectedCalls,waits] of [['Tue, 14 Nov 2023 22:13:23 GMT',2,[3000]],['61',1,[]],['999999999999999999999999',1,[]]]){const time=timing();let calls=0;
  const importer=createProjectImporter({getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>++calls===1?reply(url,{},429,{'Retry-After':header}):reply(url,importRows)});
  const result=await importer.preview({type:'ai',spreadsheetUrl:'fixture-sheet'});assert.equal(calls,expectedCalls);assert.deepEqual(time.waits,waits);
  if(expectedCalls===1)assert.equal(result.issues[0].code,'GOOGLE_RATE_LIMITED');else assert.deepEqual(result.issues,[]);
 }
});

test('a rate limit on a later donor page rejects the complete scan instead of selecting a partial winner',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),time=timing();let secondPageCalls=0;
 const source=createSiteSource({getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{
  if(!url.includes('/values/'))return reply(url,{sheets:[{properties:{sheetId:0,title:'Sites',index:0,gridProperties:{rowCount:2010,columnCount:3}}}]});
  if(decodeURIComponent(url).includes('A1:C2000'))return reply(url,sourceRows);
  secondPageCalls++;return reply(url,{error:'secret'},429,{'retry-after':'1'});
 }});
 await assert.rejects(source.pickUnused({...sourceConfig,range:'Sites!A:C'}),{code:'source_rate_limited'});assert.equal(secondPageCalls,4);
});

test('malformed and redirected Google responses fail once without retrying or accepting an invalid status',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 for(const malformed of [url=>null,url=>({url,text:JSON.stringify(sourceRows)}),url=>({url,status:200,text:{values:[]}}),url=>reply('https://foreign.example',{},429),url=>({url,status:200,text:'not json'}),url=>reply(url,{values:'not an array'})])for(const kind of ['source','import']){
  let calls=0;const time=timing(),options={getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{calls++;return malformed(url);}};
  if(kind==='source')await assert.rejects(createSiteSource(options).readCandidates(sourceConfig));
  else{const result=await createProjectImporter(options).preview({type:'ai',spreadsheetUrl:'fixture-sheet'});assert.deepEqual(result.items,[]);assert.ok(result.issues.length);}
  assert.equal(calls,1);assert.deepEqual(time.waits,[]);
 }
});

test('cancelling before the transport microtask prevents a Google request from starting',async()=>{
 const {createGoogleRead}=await import('../server/lifecycle/google-read.mjs'),controller=new AbortController();let calls=0;
 const pending=createGoogleRead({transport:async url=>{calls++;return reply(url,sourceRows);}})('https://sheets.googleapis.com/v4/spreadsheets/fixture-sheet',{signal:controller.signal});
 controller.abort();await assert.rejects(pending,{code:'google_read_aborted'});assert.equal(calls,0);
});

test('aborting an active Google read settles even when the injected transport ignores abort',async()=>{
 const {createGoogleRead}=await import('../server/lifecycle/google-read.mjs'),controller=new AbortController();let started;
 const began=new Promise(resolve=>started=resolve),read=createGoogleRead({transport:async()=>{started();return new Promise(()=>{});}});
 const pending=read('https://sheets.googleapis.com/v4/spreadsheets/fixture-sheet',{signal:controller.signal});await began;controller.abort();await assert.rejects(pending,{code:'google_read_aborted'});
});

test('the default backoff releases its timer when the caller cancels',async()=>{
 const {createGoogleRead}=await import('../server/lifecycle/google-read.mjs'),controller=new AbortController();let calls=0;
 const read=createGoogleRead({transport:async url=>{calls++;setImmediate(()=>controller.abort());return reply(url,{},429,{'retry-after':'60'});}});
 await assert.rejects(read('https://sheets.googleapis.com/v4/spreadsheets/fixture-sheet',{signal:controller.signal}),{code:'google_read_aborted'});assert.equal(calls,1);
});

test('transient statuses and recognized network errors recover with bounded exponential backoff',async()=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 for(const first of [500,502,503,504,'network_timeout','network_failed','dns_failed','ECONNRESET']){const time=timing();let calls=0;
  const importer=createProjectImporter({getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{calls++;if(calls===1){if(typeof first==='string')throw Object.assign(Error('private network detail'),{code:first});return reply(url,{},first);}return reply(url,importRows);}});
  const result=await importer.preview({type:'ai',spreadsheetUrl:'fixture-sheet'});assert.deepEqual(result.issues,[]);assert.equal(result.items.length,1);assert.deepEqual(time.waits,[1000]);assert.equal(calls,2);
 }
 const time=timing({random:()=>0.5});let calls=0;
 const result=await createProjectImporter({getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{calls++;return reply(url,{},503);}}).preview({type:'ai',spreadsheetUrl:'fixture-sheet'});
 assert.equal(result.issues[0].code,'GOOGLE_READ_FAILED');assert.equal(calls,4);assert.deepEqual(time.waits,[1500,3000,6000]);
});

test('Retry-After never exceeds the remaining operation budget or retries before the allowed time',async()=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 for(const [hint,budget,callsExpected,waitsExpected] of [['1',1500,2,[1000]],['60',90000,2,[60000]]]){let calls=0;const time=timing({budgetMs:budget});
  const result=await createProjectImporter({getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{calls++;return calls===2&&hint==='60'?reply(url,importRows):reply(url,{},429,{'retry-after':hint});}}).preview({type:'ai',spreadsheetUrl:'fixture-sheet'});
  assert.equal(calls,callsExpected);assert.deepEqual(time.waits,waitsExpected);if(hint==='60')assert.deepEqual(result.issues,[]);else assert.equal(result.issues[0].code,'GOOGLE_RATE_LIMITED');
 }
});

test('Drive media retries preserve Drive IDs and a failed later media file returns no partial preview',async()=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 for(const failLater of [false,true]){const time=timing();let mediaCalls=0;
  const importer=createProjectImporter({getAccessToken:async()=> 'private-token',readRetry:time.options,transport:async url=>{
   const target=new URL(url);
   if(target.pathname.endsWith('/folder'))return reply(url,{id:'folder',name:'Folder',mimeType:'application/vnd.google-apps.folder'});
   if(target.pathname.endsWith('/files'))return reply(url,{files:[{id:'file_1',name:'same.html',mimeType:'text/html'},{id:'file_2',name:'same.html',mimeType:'text/html'}]});
   mediaCalls++;
   if(mediaCalls===1||failLater&&target.pathname.endsWith('/file_2'))return reply(url,{error:'private-token'},429,{'retry-after':'1'});
   return {url,status:200,headers:{'content-type':'text/html; charset=utf-8'},text:'<h1>Exact Drive content</h1>'};
  }});
  const result=await importer.preview({type:'html',driveUrl:'folder'});
  if(failLater){assert.deepEqual(result.items,[]);assert.equal(result.issues[0].code,'GOOGLE_RATE_LIMITED');assert.equal(mediaCalls,6);}
  else{assert.deepEqual(result.issues,[]);assert.deepEqual(result.items.map(item=>item.key),['file_1','file_2']);assert.equal(mediaCalls,3);}
 }
});

test('Google OAuth token POSTs never retry even on a rate-limit response',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{createProjectImporter}=await import('../server/lifecycle/project-import.mjs'),{generateKeyPairSync}=require('node:crypto');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),account={clientEmail:'reader@example.iam.gserviceaccount.com',privateKey:privateKey.export({type:'pkcs8',format:'pem'})};
 for(const kind of ['source','import']){const time=timing();let calls=0;const options={readRetry:time.options,transport:async(url,options)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.method,'POST');return reply(url,{},429,{'retry-after':'1'});}};
  if(kind==='source')await assert.rejects(createSiteSource(options).readCandidates({...sourceConfig,serviceAccount:account}),{code:'source_auth_failed'});
  else assert.equal((await createProjectImporter({...options,getAccount:()=>account}).preview({type:'ai',spreadsheetUrl:'fixture-sheet'})).issues[0].code,'GOOGLE_AUTH_FAILED');
  assert.equal(calls,1);assert.deepEqual(time.waits,[]);
 }
});

test('Google retries compose with real safe-transport DNS, socket and timeout error codes',async()=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs'),{createSafeTransport}=await import('../server/lifecycle/network.mjs'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
 for(const mode of ['dns','socket','timeout']){const time=timing();let lookups=0,sockets=0;
  const transport=createSafeTransport({timeoutMs:10,lookup:async()=>{lookups++;if(mode==='dns'&&lookups===1)throw Error('private DNS detail');return [{address:'93.184.216.34',family:4}];},request:(_url,_options,receive)=>{
   sockets++;const attempt=sockets,request=new EventEmitter();request.destroy=()=>{};
   request.end=()=>queueMicrotask(()=>{
    if(mode==='socket'&&attempt===1)return request.emit('error',Error('private socket detail'));
    if(mode==='timeout'&&attempt===1)return;
    const response=new PassThrough();response.statusCode=200;response.headers={};receive(response);response.end(JSON.stringify(importRows));
   });return request;
  }});
  const result=await createProjectImporter({getAccessToken:async()=> 'private-token',readRetry:time.options,transport}).preview({type:'ai',spreadsheetUrl:'fixture-sheet'});
  assert.deepEqual(result.issues,[]);assert.equal(result.items[0].key,'one');assert.deepEqual(time.waits,[1000]);assert.equal(lookups,2);assert.equal(sockets,mode==='dns'?1:2);
 }
});

test('unsafe destinations rejected by the network guard never retry',async()=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs'),{createSafeTransport}=await import('../server/lifecycle/network.mjs');
 const time=timing();let lookups=0;
 const transport=createSafeTransport({lookup:async()=>{lookups++;return [{address:'127.0.0.1',family:4}];},request:()=>assert.fail('Unsafe destination must never open a socket')});
 const result=await createProjectImporter({getAccessToken:async()=> 'private-token',readRetry:time.options,transport}).preview({type:'ai',spreadsheetUrl:'fixture-sheet'});
 assert.equal(result.issues[0].code,'GOOGLE_READ_FAILED');assert.equal(lookups,1);assert.deepEqual(time.waits,[]);
});
