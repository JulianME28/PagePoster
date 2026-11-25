const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm,readFile,writeFile,mkdir,symlink}=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');

const SHEET='https://docs.google.com/spreadsheets/d/browser_fixture_123/edit#gid=0';
const config={spreadsheetId:'browser_fixture_123',spreadsheetUrl:SHEET,sheetId:0,range:'B:F',headerRows:1,columns:{url:'B',username:'C',password:'D',dr:'E',traffic:'F'},authMode:'browser'};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<30;i++){if(check())return;await turn();}assert.ok(check(),'Reader did not reach the expected state');}
function response(body='A,B\n1,2',{status=200,headers={'content-type':'text/csv; charset=utf-8'},url}={}){return {status:()=>status,headers:()=>headers,url:()=>url,body:async()=>Buffer.from(body),dispose:async()=>{}};}
async function fixture(t,{reply,href=SHEET,clock,open}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'pageposter-google-browser-'));
 const requests=[],launches=[];let pageUrl=href,closed=false,cookiesCleared=false;
 const page={url:()=>pageUrl,isClosed:()=>closed};
 const browser=Object.assign(new EventEmitter(),{isConnected:()=>!closed});
 const context={request:{get:async(url,options)=>{requests.push({url,options});return typeof reply==='function'?reply(url,options):reply||response();}},pages:()=>[page],browser:()=>browser,clearCookies:async()=>{cookiesCleared=true;}};
 const launch=async options=>{launches.push(options);await mkdir(options.profileDir,{recursive:true});await open?.(options);return {browser,context,page,close:async()=>{closed=true;}};};
 const {createGoogleBrowser}=await import('../server/lifecycle/google-browser.mjs');
 const reader=await createGoogleBrowser({dataDir:root,launch,...(clock?{clock}:{})});
 t.after(async()=>{await reader.close();await rm(root,{recursive:true,force:true});});
 return {reader,requests,launches,root,setPageUrl:value=>pageUrl=value,isClosed:()=>closed,cookiesCleared:()=>cookiesCleared,context,browser};
}

test('Google browser stays idle until connect and exposes only safe account metadata',async t=>{
 const f=await fixture(t);
 assert.deepEqual(f.reader.status(),{connected:false,phase:'idle',email:'',clientConfigured:true,method:'browser'});
 assert.equal(f.launches.length,0);
 await assert.rejects(f.reader.readSheet(config),{code:'GOOGLE_BROWSER_REQUIRED'});
});

test('connect opens an isolated persistent profile and returns while manual Google login is pending',async t=>{
 const f=await fixture(t,{href:'https://accounts.google.com/v3/signin/identifier'});
 const result=await f.reader.connect(SHEET);
 assert.equal(result.phase,'waiting');assert.equal(result.connected,false);
 assert.equal(f.launches[0].profileDir,path.join(f.root,'google-browser-profile'));
 assert.equal(f.launches[0].spreadsheetUrl,SHEET);
 assert.equal(f.requests.length,0);
 await assert.rejects(f.reader.readSheet(config),{code:'GOOGLE_BROWSER_AUTH_REQUIRED'});
 assert.equal(f.requests.length,0);
});

test('connect requires an explicit tab and rejects non-Google or non-HTTPS targets before opening Chrome',async t=>{
 const f=await fixture(t);
 for(const url of ['https://docs.google.com/spreadsheets/d/browser_fixture_123/edit','https://docs.google.com/spreadsheets/d/browser_fixture_123/edit#gid=-1'])await assert.rejects(f.reader.connect(url),{code:'GOOGLE_SHEET_TAB_REQUIRED'});
 for(const url of ['https://evil.example/spreadsheets/d/browser_fixture_123/edit#gid=0','http://docs.google.com/spreadsheets/d/browser_fixture_123/edit#gid=0','https://docs.google.com.evil.example/spreadsheets/d/browser_fixture_123/edit#gid=0','https://user:secret@docs.google.com/spreadsheets/d/browser_fixture_123/edit#gid=0'])await assert.rejects(f.reader.connect(url),{code:'GOOGLE_BROWSER_READ_FAILED'});
 assert.equal(f.launches.length,0);
});

test('CSV download preserves quoted credentials, BOM, escaped quotes, CRLF, commas and multiline cells',async t=>{
 const csv='\ufeffUnused,URL,User,Password,DR,Traffic\r\nignore,https://one.example/,alice," exact, ""secret"" ","35,5","1,234"\r\nignore,https://two.example/,bob,"line1\r\nline2",99,"2\u202f345"\r\n';
 const f=await fixture(t,{reply:response(csv)});await f.reader.connect(SHEET);
 const result=await f.reader.readSheet(config);
 assert.deepEqual(result.values,[['URL','User','Password','DR','Traffic'],['https://one.example/','alice',' exact, "secret" ',35.5,1234],['https://two.example/','bob','line1\r\nline2','99',2345]]);
 assert.equal(f.requests[0].url,'https://docs.google.com/spreadsheets/d/browser_fixture_123/export?format=csv&gid=0');
 assert.equal(f.requests[0].options.maxRedirects,0);
 assert.equal(f.reader.status().phase,'connected');
 assert.doesNotMatch(JSON.stringify(f.reader.status()),/secret|alice|line1/);
});

test('range slicing includes row one for B:O and applies explicit B3:O5 offsets',async t=>{
 const f=await fixture(t,{reply:response('A1,B1,C1\nA2,B2,C2\nA3,B3,C3\nA4,B4,C4\nA5,B5,C5\nA6,B6,C6')});await f.reader.connect(SHEET);
 assert.deepEqual((await f.reader.readSheet({...config,range:'B:O'})).values,[['B1','C1'],['B2','C2'],['B3','C3'],['B4','C4'],['B5','C5'],['B6','C6']]);
 assert.deepEqual((await f.reader.readSheet({...config,range:"'Sites table'!B3:O5"})).values,[['B3','C3'],['B4','C4'],['B5','C5']]);
});

test('readSheet uses the selected nonzero gid and rejects conflicting tab and spreadsheet references',async t=>{
 const url='https://docs.google.com/spreadsheets/d/browser_fixture_123/edit#gid=37';
 const f=await fixture(t,{href:url});await f.reader.connect(url);
 await f.reader.readSheet({...config,spreadsheetUrl:url,sheetId:37});
 assert.equal(f.requests[0].url,'https://docs.google.com/spreadsheets/d/browser_fixture_123/export?format=csv&gid=37');
 await assert.rejects(f.reader.readSheet({...config,spreadsheetUrl:url,sheetId:0}),{code:'GOOGLE_BROWSER_READ_FAILED'});
 await assert.rejects(f.reader.readSheet({...config,spreadsheetId:'another_sheet'}),{code:'GOOGLE_BROWSER_READ_FAILED'});
});

test('concurrent workers share one export and reuse the bounded cache until it expires',async t=>{
 let now=1000,resolve;
 const f=await fixture(t,{clock:()=>now,reply:()=>new Promise(done=>resolve=()=>done(response('A,B\n1,2')))});
 await f.reader.connect(SHEET);await until(()=>f.requests.length===1);
 const a=f.reader.readSheet(config),b=f.reader.readSheet(config);resolve();
 assert.deepEqual(await a,await b);assert.equal(f.requests.length,1);
 await f.reader.readSheet(config);assert.equal(f.requests.length,1);
 now+=31000;const c=f.reader.readSheet(config);await until(()=>f.requests.length===2);resolve();await c;
 assert.equal(f.requests.length,2);
});

test('HTML login responses and Google sign-in redirects stay pending without parsing credentials as CSV',async t=>{
 for(const reply of [response('<!doctype html><html><input name="password" value="private-fixture"></html>',{headers:{'content-type':'text/html'}}),response('',{status:302,headers:{location:'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fdocs.google.com'}})]){
  const f=await fixture(t,{reply});await f.reader.connect(SHEET);
  await assert.rejects(f.reader.readSheet(config),{code:'GOOGLE_BROWSER_AUTH_REQUIRED'});
  assert.equal(f.reader.status().phase,'waiting');assert.equal(f.reader.status().connected,false);
  assert.doesNotMatch(JSON.stringify(f.reader.status()),/private-fixture|password|ServiceLogin/);
  assert.equal(f.requests.length,1);
 }
});

test('missing permission yields a safe access error without including provider HTML',async t=>{
 const f=await fixture(t,{reply:response('private-password provider detail',{status:403,headers:{'content-type':'text/html'}})});await f.reader.connect(SHEET);
 await assert.rejects(f.reader.readSheet(config),error=>error.code==='GOOGLE_BROWSER_ACCESS_DENIED'&&!error.message.includes('private-password'));
 assert.equal(f.reader.status().phase,'error');assert.equal(f.reader.status().error.code,'GOOGLE_BROWSER_ACCESS_DENIED');
 assert.doesNotMatch(JSON.stringify(f.reader.status()),/private-password|provider detail/);
});

test('CSV redirects follow only HTTPS Google export hosts and never request private or foreign addresses',async t=>{
 for(const location of ['http://127.0.0.1/','https://127.0.0.1/','https://evil.example/','https://docs.google.com.evil.example/','https://user:secret@docs.google.com/','https://docs.google.com:8443/','https://evil.googleusercontent.com/']){
  const f=await fixture(t,{reply:response('',{status:302,headers:{location}})});await f.reader.connect(SHEET);
  await assert.rejects(f.reader.readSheet(config),{code:'GOOGLE_BROWSER_READ_FAILED'});assert.equal(f.requests.length,1);
 }
 const next='https://doc-12-ab-sheets.googleusercontent.com/export/fixture';
 const f=await fixture(t,{reply:url=>url===next?response('A,B\n1,2',{url:next}):response('',{status:302,headers:{location:next}})});await f.reader.connect(SHEET);
 assert.deepEqual((await f.reader.readSheet({...config,range:'A:B'})).values,[['A','B'],['1','2']]);assert.equal(f.requests.length,2);
});

test('CSV redirect chains stop after five redirects',async t=>{
 const f=await fixture(t,{reply:(url)=>response('',{status:302,headers:{location:'https://docs.google.com/redirect/'+(Number(url.split('/').at(-1))||0)+1}})});await f.reader.connect(SHEET);
 await assert.rejects(f.reader.readSheet(config),{code:'GOOGLE_BROWSER_READ_FAILED'});assert.equal(f.requests.length,6);
});

test('oversize CSV is rejected by declared size before body allocation and by actual size before parsing',async t=>{
 const declared=response('tiny',{headers:{'content-type':'text/csv','content-length':String(26*1024*1024)}});declared.body=async()=>{assert.fail('Oversize body must not be read');};
 for(const reply of [declared,response('a'.repeat(25*1024*1024+1))]){
  const f=await fixture(t,{reply});await f.reader.connect(SHEET);
  await assert.rejects(f.reader.readSheet(config),{code:'GOOGLE_BROWSER_LIMIT'});
 }
});

test('exports over 100000 rows fail closed even when a small source range was requested',async t=>{
 const f=await fixture(t,{reply:response(Array.from({length:100001},()=>',,').join('\n'))});await f.reader.connect(SHEET);
 await assert.rejects(f.reader.readSheet({...config,range:'B1:F10'}),{code:'GOOGLE_BROWSER_LIMIT'});
});

test('malformed CSV and invalid UTF-8 fail without leaking cell text',async t=>{
 for(const body of ['A,B\n"private-secret','A,B\n"private-secret"garbage','A,B\nprivate"secret',Buffer.from([0xff,0xfe,0x61])]){
  const f=await fixture(t,{reply:response(body)});await f.reader.connect(SHEET);
  await assert.rejects(f.reader.readSheet(config),error=>error.code==='GOOGLE_BROWSER_READ_FAILED'&&!error.message.includes('private-secret'));
 }
});

test('metric normalization touches only configured numeric columns and retains ambiguous strings',async t=>{
 const csv='url,user,password,dr,traffic\nhttps://one.example/,"1,234","45,5","45,5","1.234"\nhttps://two.example/,"1 234","1,234",100,"1,23"\nhttps://three.example/,u,exact,"100,1","1,234.50"';
 const f=await fixture(t,{reply:response(csv)});await f.reader.connect(SHEET);
 const result=await f.reader.readSheet({...config,range:'A:E',columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E'}});
 assert.deepEqual(result.values,[['url','user','password','dr','traffic'],['https://one.example/','1,234','45,5',45.5,1234],['https://two.example/','1 234','1,234','100','1,23'],['https://three.example/','u','exact','100,1','1,234.50']]);
});

test('close terminates the owned browser while retaining its isolated profile login files',async t=>{
 const f=await fixture(t);await f.reader.connect(SHEET);const marker=path.join(f.launches[0].profileDir,'login-marker');await writeFile(marker,'native-profile');
 await f.reader.close();assert.equal(f.isClosed(),true);assert.equal(f.cookiesCleared(),false);assert.equal(await readFile(marker,'utf8'),'native-profile');
 assert.equal(f.reader.status().connected,false);assert.equal(f.reader.status().phase,'idle');
 await assert.rejects(f.reader.readSheet(config),{code:'GOOGLE_BROWSER_REQUIRED'});
});

test('disconnect clears only the owned context cookies and closes its browser',async t=>{
 const f=await fixture(t);await f.reader.connect(SHEET);const marker=path.join(f.launches[0].profileDir,'login-marker');await writeFile(marker,'native-profile');
 const disconnected=await f.reader.disconnect();assert.equal(disconnected.connected,false);assert.equal(disconnected.phase,'idle');assert.equal(f.cookiesCleared(),true);assert.equal(f.isClosed(),true);assert.equal(await readFile(marker,'utf8'),'native-profile');
 assert.deepEqual(f.reader.status(),{connected:false,phase:'idle',email:'',clientConfigured:true,method:'browser'});
});

test('closing during an export invalidates the pending read and does not restore connected status',async t=>{
 let resolve;
 const f=await fixture(t,{reply:()=>new Promise(done=>resolve=()=>done(response('A,B\n1,2')))});await f.reader.connect(SHEET);await until(()=>f.requests.length===1);
 const pending=f.reader.readSheet(config);await f.reader.close();resolve();await assert.rejects(pending,{code:'GOOGLE_BROWSER_REQUIRED'});
 assert.equal(f.reader.status().phase,'idle');
});

test('manual Chrome closure is reflected safely in synchronous status',async t=>{
 const f=await fixture(t);await f.reader.connect(SHEET);await until(()=>f.reader.status().connected);
 f.browser.isConnected=()=>false;
 assert.equal(f.reader.status().connected,false);assert.equal(f.reader.status().error.code,'GOOGLE_BROWSER_UNAVAILABLE');
});

test('the native adapter launches visible isolated Chrome and attaches only to its loopback debugging port',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pageposter-google-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const profileDir=path.join(root,'google-browser-profile'),calls=[],commands=[];
 let child,connected=true;
 const page={url:()=>SHEET},context={pages:()=>[page]};
 const browser={contexts:()=>[context],isConnected:()=>connected,newBrowserCDPSession:async()=>({send:async command=>{commands.push(command);child.exitCode=0;child.emit('exit',0);connected=false;}}),close:async()=>{connected=false;}};
 const {createGoogleChromeLauncher}=await import('../server/lifecycle/google-browser.mjs');
 assert.equal(typeof createGoogleChromeLauncher,'function');
 const launch=createGoogleChromeLauncher({executablePath:process.execPath,chromium:{connectOverCDP:async(endpoint)=>{calls.push(endpoint);return browser;}},spawnProcess:(file,args,options)=>{
  calls.push({file,args,options});child=Object.assign(new EventEmitter(),{exitCode:null,killed:false,kill(){this.killed=true;this.exitCode=1;this.emit('exit',1);}});
  void writeFile(path.join(profileDir,'DevToolsActivePort'),'19222\n/devtools/browser/fixture-123\n');return child;
 }});
 const session=await launch({profileDir,spreadsheetUrl:SHEET});
 assert.equal(session.context,context);assert.equal(session.page,page);
 assert.deepEqual(calls[0],{file:process.execPath,args:['--user-data-dir='+profileDir,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--new-window',SHEET],options:{stdio:'ignore',windowsHide:false,shell:false}});
 assert.equal(calls[1],'http://127.0.0.1:19222');
 await session.close();assert.deepEqual(commands,['Browser.close']);assert.equal(child.killed,false);
 assert.equal(await readFile(path.join(profileDir,'DevToolsActivePort'),'utf8'),'19222\n/devtools/browser/fixture-123\n');
});

test('native Chrome startup failure is safe and terminates only the spawned process',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pageposter-google-native-fail-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let child;
 const {createGoogleChromeLauncher}=await import('../server/lifecycle/google-browser.mjs');assert.equal(typeof createGoogleChromeLauncher,'function');
 const launch=createGoogleChromeLauncher({executablePath:process.execPath,chromium:{connectOverCDP:async()=>assert.fail('No CDP without a valid owned port')},startupTimeout:20,spawnProcess:()=>{child=Object.assign(new EventEmitter(),{exitCode:null,killed:false,kill(){this.killed=true;this.exitCode=1;this.emit('exit',1);}});return child;}});
 await assert.rejects(launch({profileDir:path.join(root,'google-browser-profile'),spreadsheetUrl:SHEET}),error=>error.code==='GOOGLE_BROWSER_UNAVAILABLE'&&!error.message.includes(root));
 assert.equal(child.killed,true);
});

test('the native adapter rejects junctions instead of using another browser profile',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pageposter-google-native-link-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const normalProfile=path.join(root,'normal-profile');await mkdir(normalProfile);await writeFile(path.join(normalProfile,'must-stay'),'personal');
 const profileDir=path.join(root,'google-browser-profile');await symlink(normalProfile,profileDir,process.platform==='win32'?'junction':'dir');
 const {createGoogleChromeLauncher}=await import('../server/lifecycle/google-browser.mjs');assert.equal(typeof createGoogleChromeLauncher,'function');
 const launch=createGoogleChromeLauncher({executablePath:process.execPath,chromium:{},spawnProcess:()=>assert.fail('Must not start Chrome against an aliased profile')});
 await assert.rejects(launch({profileDir,spreadsheetUrl:SHEET}),{code:'GOOGLE_BROWSER_UNAVAILABLE'});
 assert.equal(await readFile(path.join(normalProfile,'must-stay'),'utf8'),'personal');
});

test('repeated connect clicks share one native browser launch',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=await fixture(t,{open:()=>gate});
 const first=f.reader.connect(SHEET);await until(()=>f.launches.length===1);
 const second=f.reader.connect(SHEET);await turn();release();await Promise.all([first,second]);
 assert.equal(f.launches.length,1);
});

test('closing during Chrome startup closes the returned owned session and preserves idle status',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),f=await fixture(t,{open:()=>gate});
 const opening=f.reader.connect(SHEET);await until(()=>f.launches.length===1);const closing=f.reader.close();release();await closing;
 assert.equal((await opening).phase,'idle');assert.equal(f.isClosed(),true);assert.equal(f.requests.length,0);
});

test('manual login can return to the same document without a gid fragment while export still uses the selected tab',async t=>{
 const f=await fixture(t,{href:'https://accounts.google.com/v3/signin/identifier'});await f.reader.connect(SHEET);
 f.setPageUrl('https://docs.google.com/spreadsheets/d/browser_fixture_123/edit');
 assert.deepEqual((await f.reader.readSheet({...config,range:'A:B'})).values,[['A','B'],['1','2']]);
 assert.equal(f.requests[0].url,'https://docs.google.com/spreadsheets/d/browser_fixture_123/export?format=csv&gid=0');
});

test('close aborts the browser request context so in-flight exports cannot delay app shutdown',async t=>{
 let rejectRequest,disposed=false;
 const f=await fixture(t,{reply:()=>new Promise((resolve,reject)=>rejectRequest=reject)});
 f.context.request.dispose=async()=>{disposed=true;rejectRequest(Error('private provider abort'));};
 await f.reader.connect(SHEET);await until(()=>f.requests.length===1);const pending=f.reader.readSheet(config);
 await f.reader.close();assert.equal(disposed,true);await assert.rejects(pending,{code:'GOOGLE_BROWSER_REQUIRED'});
});

test('disconnect cookie-clear failures are sanitized and the owned Chrome session is still closed',async t=>{
 const f=await fixture(t);await f.reader.connect(SHEET);f.context.clearCookies=async()=>{throw Error('private-cookie-fixture');};
 await assert.rejects(f.reader.disconnect(),error=>error.code==='GOOGLE_BROWSER_UNAVAILABLE'&&!error.message.includes('private-cookie-fixture'));
 assert.equal(f.isClosed(),true);assert.equal(f.reader.status().connected,false);
 assert.doesNotMatch(JSON.stringify(f.reader.status()),/private-cookie-fixture/);
});

test('browser references share the strict full-link guard and strip supported sharing parameters',async t=>{
 const f=await fixture(t);
 for(const url of ['https://docs.google.com/spreadsheets/x/../d/browser_fixture_123/edit#gid=0','https://docs.google.com/spreadsheets/d/browser_fixture_123/edit?redirect=https://evil.example/#gid=0','https://docs.google.com:443/spreadsheets/d/browser_fixture_123/edit#gid=0'])await assert.rejects(f.reader.connect(url),{code:'GOOGLE_BROWSER_READ_FAILED'});
 for(const query of ['usp=sharing','usp=drive_link','authuser=0','usp=sharing&authuser=99']){
  const result=await f.reader.connect('https://docs.google.com/spreadsheets/d/browser_fixture_123/edit?'+query+'#gid=0');
  assert.equal(result.spreadsheetUrl,SHEET);
 }
 assert.equal(f.launches[0].spreadsheetUrl,SHEET);assert.equal(f.launches.length,1);
});
