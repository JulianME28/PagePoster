const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const directory=path.resolve(__dirname,'../.desktop-build/diagnostics-fixture');
const create=options=>require('../desktop/startup-diagnostics.cjs').createStartupDiagnostics(options);

test('startup snapshot is detached, contains no filesystem destination, and does not flush',async()=>{
 let time=10000,writes=0;const diagnostics=create({now:()=>time,uptime:()=>1,mkdir:async()=>{},writeFile:async()=>writes++});
 diagnostics.setDirectory(directory);diagnostics.mark('main-entered');const first=diagnostics.snapshot();
 first.phases['main-entered']=999;first.phases.private='secret';time=10100;diagnostics.mark('backend-ready');
 assert.deepEqual(diagnostics.snapshot(),{format:1,startedAt:9000,phases:{'main-entered':1000,'backend-ready':1100}});assert.equal(writes,0);
});

test('startup timings use process birth and record each whitelisted phase once without private input',async()=>{
 let time=10000;const writes=[];
 const diagnostics=create({now:()=>time,uptime:()=>2,mkdir:async()=>{},writeFile:async(file,text)=>writes.push({file,text})});
 assert.equal(diagnostics.mark('main-entered'),true);time=10250;
 assert.equal(diagnostics.mark('electron-ready'),true);assert.equal(diagnostics.mark('main-entered'),false);
 for(const value of ['https://private.example/?token=secret','<html>private</html>','password=secret',null,{}])assert.equal(diagnostics.mark(value),false);
 diagnostics.setDirectory(directory);assert.equal(writes.length,0,'recording phases must not perform IO');await diagnostics.flush();
 assert.equal(writes[0].file,path.join(directory,'startup-diagnostics.json'));
 assert.deepEqual(JSON.parse(writes[0].text),{format:1,startedAt:8000,phases:{'main-entered':2000,'electron-ready':2250}});
});

test('concurrent flushes finish in order and preserve the latest complete snapshot',async()=>{
 let releaseFirst,time=20000;const writes=[],firstWrite=new Promise(resolve=>releaseFirst=resolve);
 const diagnostics=create({now:()=>time,uptime:()=>1,mkdir:async()=>{},writeFile:async(file,text)=>{writes.push(JSON.parse(text));if(writes.length===1)await firstWrite;}});
 diagnostics.setDirectory(directory);diagnostics.mark('main-entered');const first=diagnostics.flush();
 await new Promise(resolve=>setImmediate(resolve));time=20100;diagnostics.mark('backend-ready');const latest=diagnostics.flush();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(writes.length,1,'new writes must wait for the prior write');
 releaseFirst();await Promise.all([first,latest]);assert.deepEqual(writes.map(value=>value.phases),[{'main-entered':1000},{'main-entered':1000,'backend-ready':1100}]);
});

test('invalid destinations cause no writes and failed IO does not break a later flush',async()=>{
 let attempts=0;const writes=[];
 const diagnostics=create({now:()=>10000,uptime:()=>1,mkdir:async()=>{},writeFile:async(file,text)=>{if(++attempts===1)throw Error('Private filesystem failure');writes.push(JSON.parse(text));}});
 diagnostics.mark('failed');for(const value of [null,'relative/path','bad\0path'])assert.equal(diagnostics.setDirectory(value),false);
 await diagnostics.flush();assert.equal(attempts,0);assert.equal(diagnostics.setDirectory(directory),true);
 await assert.doesNotReject(diagnostics.flush());diagnostics.mark('workspace-loaded');await assert.doesNotReject(diagnostics.flush());
 assert.equal(attempts,2);assert.deepEqual(writes[0].phases,{'failed':1000,'workspace-loaded':1000});
});

test('diagnostic output stays bounded to the fixed phase vocabulary',async()=>{
 const writes=[],diagnostics=create({now:()=>10000,uptime:()=>1,mkdir:async()=>{},writeFile:async(file,text)=>writes.push(text)});
 const names=['main-entered','electron-ready','window-created','startup-loaded','backend-spawned','backend-ready','workspace-loaded','queue-response','failed'];
 for(const name of names)diagnostics.mark(name);for(let index=0;index<1000;index++)diagnostics.mark('untrusted-'+index);
 diagnostics.setDirectory(directory);await diagnostics.flush();const value=JSON.parse(writes[0]);
 assert.deepEqual(Object.keys(value),['format','startedAt','phases']);assert.deepEqual(Object.keys(value.phases),names);assert.ok(writes[0].length<1024);
});
