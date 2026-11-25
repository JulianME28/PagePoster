'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
test('Electron main forwards the latest startup failure snapshot over its private child channel',async()=>{
 const vm=require('node:vm'),{EventEmitter}=require('node:events'),child=new EventEmitter(),messages=[];
 Object.assign(child,{connected:true,stdout:{resume(){}},stderr:{resume(){}},send:message=>messages.push(message)});
 const electron={app:{setName(){},setAppUserModelId(){},commandLine:{appendSwitch(name,value){assert.equal(name,'lang');assert.equal(value,'uk');}},requestSingleInstanceLock:()=>false,quit(){}}};
 const window={isDestroyed:()=>false,isMinimized:()=>false,show(){},focus(){},loadURL:async()=>{},webContents:{getURL:()=>'',send(){}}};
 const context={require:name=>name==='electron'?electron:name==='node:child_process'?{fork:()=>child}:name==='node:fs'?{existsSync:()=>true}:name==='./google-tab.cjs'?{createChromeTabOpener:()=>()=>{}}:name.startsWith('./')?require(path.resolve(__dirname,'../desktop',name)):require(name),__dirname:path.resolve(__dirname,'../desktop'),process:{env:{},versions:{electron:'45.0.0'}},Buffer,setTimeout:()=>1,clearTimeout(){}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../desktop/main.cjs'),'utf8')+'\nglobalThis.mainTest={startBackend,failStartup,configure:()=>{paths={nodePath:"C:/fixture/node.exe",dataDir:"C:/fixture/data",keyDir:"C:/fixture/keys"};window=globalThis.fixtureWindow;}};',context);
 context.fixtureWindow=window;context.mainTest.configure();context.mainTest.startBackend();await context.mainTest.failStartup('Safe startup failure');
 const metadata=messages.filter(message=>message.type==='support-metadata').at(-1).metadata;
 assert.ok(Number.isInteger(metadata.startup.phases.failed));assert.equal(metadata.runtime.electron,'45.0.0');assert.doesNotMatch(JSON.stringify(metadata),/fixture|C:|Safe startup failure/);
});
test('desktop metadata derives identity from the fixed packaged manifest and snapshots only trusted vocabulary',()=>{
 const {createSupportMetadata}=require('../desktop/support-metadata.cjs');const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-support-build-'));
 try{
  const appRoot=path.join(root,'resources','app');fs.mkdirSync(appRoot,{recursive:true});
  const bytes=JSON.stringify({format:1,application:'PagePoster',algorithm:'sha256',files:[{path:'resources/app/desktop/main.cjs',sha256:'ab'.repeat(32)}],title:'PRIVATE'});fs.writeFileSync(path.join(root,'build-manifest.json'),bytes);
  const metadata=createSupportMetadata({appRoot});assert.deepEqual(metadata.get().build,{state:'available',manifestSha256:createHash('sha256').update(bytes).digest('hex')});
  assert.equal(metadata.update({startup:{format:1,startedAt:1000,phases:{'main-entered':100,'queue-response':500}},runtime:{electron:'45.0.0'}}),true);
  const first=metadata.get();first.startup.phases['queue-response']=999;assert.equal(metadata.get().startup.phases['queue-response'],500);
  for(const value of [{path:'C:/private'},{startup:{format:1,startedAt:1000,phases:{private:'SECRET'}}},{runtime:{electron:'https://private.example'}},{build:{manifestSha256:'cd'.repeat(32)}}])assert.equal(metadata.update(value),false);
  assert.equal(metadata.get().build.manifestSha256,createHash('sha256').update(bytes).digest('hex'));assert.doesNotMatch(JSON.stringify(metadata.get()),/PRIVATE|private|SECRET|resources/);
  assert.deepEqual(createSupportMetadata({appRoot:root}).get().build,{state:'unavailable'});
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('desktop support reports the build ID only when the manifest covers its bytes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-support-id-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const appRoot=path.join(root,'resources','app');
 fs.mkdirSync(appRoot,{recursive:true});
 const buildId='aa'.repeat(32),identity=JSON.stringify({format:1,buildId,private:'never export'});
 const identityFile=path.join(root,'build-metadata.json');
 fs.writeFileSync(identityFile,identity);
 fs.writeFileSync(path.join(root,'build-manifest.json'),JSON.stringify({format:1,application:'PagePoster',algorithm:'sha256',
  files:[{path:'build-metadata.json',size:Buffer.byteLength(identity),sha256:createHash('sha256').update(identity).digest('hex')}]}));
 const read=()=>require('../desktop/support-metadata.cjs').createSupportMetadata({appRoot}).get().build;
 assert.equal(read().buildId,buildId);
 assert.doesNotMatch(JSON.stringify(read()),/private|never export/);
 fs.writeFileSync(identityFile,identity.replace(buildId,'bb'.repeat(32)));
 assert.equal(read().buildId,undefined);
});
test('backend accepts support snapshots only over parent IPC and HTTP caller cannot supply a path',async t=>{
 const {fork}=require('node:child_process'),{once}=require('node:events');const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-support-ipc-')),token='a8'.repeat(32);
 const child=fork(path.resolve(__dirname,'../desktop/backend.cjs'),[],{env:{...process.env,PAGEPOSTER_ACCESS_TOKEN:token,PAGEPOSTER_MASTER_KEY:Buffer.alloc(32,77).toString('base64'),PAGEPOSTER_DESKTOP_CONFIG:JSON.stringify({appRoot:path.resolve(__dirname,'..'),dataDir:path.join(root,'data'),keyDir:path.join(root,'keys'),legacyEnvFile:null,port:0})},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 t.after(async()=>{if(child.exitCode===null){child.send({type:'shutdown'});await once(child,'exit');}fs.rmSync(root,{recursive:true,force:true});});
 const [ready]=await once(child,'message',{signal:AbortSignal.timeout(15000)});assert.equal(ready.type,'ready');
 child.send({type:'support-metadata',metadata:{startup:{format:1,startedAt:1000,phases:{'queue-response':321}},runtime:{electron:'45.0.0'}}});
 const base='http://127.0.0.1:'+ready.port,headers={Authorization:'Basic '+Buffer.from('pageposter:'+token).toString('base64'),Origin:base,'Content-Type':'application/json','X-PagePoster-Request':'1'};
 let report;
 for(let i=0;i<20;i++){const response=await fetch(base+'/api/lifecycle/support/export',{method:'POST',headers,body:'{}'});assert.equal(response.status,200);report=await response.json();if(report.startup)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(report.startup.phases['queue-response'],321);assert.equal(report.runtime.electron,'45.0.0');assert.equal(report.build.state,'unavailable');
 const rejected=await fetch(base+'/api/lifecycle/support/export',{method:'POST',headers,body:JSON.stringify({path:path.join(root,'private')})});assert.equal(rejected.status,400);
});
