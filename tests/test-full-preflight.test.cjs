'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),{spawnSync}=require('node:child_process');
const script=path.resolve(__dirname,'../scripts/test-full.cjs');
const modulePath=require('./browser-runtime.cjs').playwrightPath;
const chrome=require('./browser-runtime.cjs').chromePath;
// The browser has its own 15s launch deadline; leave additional time for Node
// startup/module loading and browser shutdown under a full browser-test load.
function run(env){return spawnSync(process.execPath,[script,'--preflight-only'],{env:{...process.env,...env},encoding:'utf8',timeout:45000});}
test('strict test preflight fails clearly when its explicitly configured browser module is absent',()=>{const result=run({PAGEPOSTER_PLAYWRIGHT_MODULE:path.join(os.tmpdir(),'pageposter-intentionally-missing-playwright')});assert.equal(result.status,1);assert.match(result.stderr,/Playwright/i);assert.doesNotMatch(result.stdout,/ready|готов/i);});
test('strict test preflight fails instead of skipping when Chrome is unavailable',{skip:!fs.existsSync(modulePath)},()=>{const result=run({PAGEPOSTER_PLAYWRIGHT_MODULE:modulePath,PAGEPOSTER_CHROME:path.join(os.tmpdir(),'pageposter-intentionally-missing-chrome.exe')});assert.equal(result.status,1);assert.match(result.stderr,/Chrome|Chromium/i);});
test('strict preflight launches the configured browser before marking full checks available',{skip:!(fs.existsSync(modulePath)&&fs.existsSync(chrome))},()=>{const result=run({PAGEPOSTER_PLAYWRIGHT_MODULE:modulePath,PAGEPOSTER_CHROME:chrome});assert.equal(result.status,0,result.stderr);const report=JSON.parse(result.stdout.trim());assert.equal(report.ready,true);assert.ok(fs.existsSync(report.playwright));assert.ok(fs.existsSync(report.chrome));});

// Exercise the real CLI decision using actual Node TAP output; only the child
// process and browser launch are substituted so the full suite is never run here.
async function fullRunnerResult({platform='linux',cases=[],output}){
 const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),vm=require('node:vm');
 const tapEnv={...process.env};delete tapEnv.NODE_TEST_CONTEXT;
 const tap=output===undefined?spawnSync(process.execPath,['--test-reporter=tap','-e',"const test=require('node:test');for(const item of "+JSON.stringify(cases)+")test(item.name,{skip:item.skip},()=>{});"],{encoding:'utf8',env:tapEnv}).stdout:output;
 const stderr=[],stdout=[],child=new EventEmitter();child.stdout=new PassThrough();
 const fakeProcess={platform,argv:[process.execPath,script],execPath:process.execPath,env:{PAGEPOSTER_PLAYWRIGHT_MODULE:'fixture-playwright',PAGEPOSTER_CHROME:process.execPath},stdout:{write:data=>stdout.push(String(data))},exitCode:undefined};
 const playwright={chromium:{launch:async()=>({close:async()=>{}}),executablePath:()=>process.execPath}};
 const localRequire=name=>name==='fixture-playwright'?playwright:name==='node:child_process'?{spawn:()=>{queueMicrotask(()=>{for(let index=0;index<tap.length;index+=13)child.stdout.write(tap.slice(index,index+13));child.stdout.end();child.emit('close',0,null);});return child;}}:require(name);
 localRequire.resolve=name=>name==='fixture-playwright'?name:require.resolve(name);
 await vm.runInNewContext(fs.readFileSync(script,'utf8'),{require:localRequire,__dirname:path.dirname(script),process:fakeProcess,console:{log:()=>{},error:message=>stderr.push(String(message))}});
 return {status:fakeProcess.exitCode||0,stderr:stderr.join('\n'),stdout:stdout.join('')};
}
const windowsKeyTest='Windows key is protected, stable across reads and not regenerated after corruption';
for(const platform of ['linux','darwin'])test('strict full runner allows only the known Windows DPAPI exclusion on '+platform,async()=>{
 const result=await fullRunnerResult({platform,cases:[{name:windowsKeyTest,skip:true},{name:'browser verification runs',skip:false}]});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/# skipped 1/);
});

test('strict full runner rejects the Windows DPAPI exclusion on Windows',async()=>{
 const result=await fullRunnerResult({platform:'win32',cases:[{name:windowsKeyTest,skip:true}]});assert.equal(result.status,1);assert.match(result.stderr,/skip/i);
});

for(const skipped of [{name:'browser verification',skip:'Chrome unavailable'},{name:'Another Windows-only test',skip:true},{name:windowsKeyTest,skip:'Chrome unavailable'}])test('strict full runner rejects unexpected exclusion: '+skipped.name+' / '+skipped.skip,async()=>{
 const result=await fullRunnerResult({cases:[skipped]});assert.equal(result.status,1);assert.match(result.stderr,/skip/i);
});

test('known platform exclusion does not conceal a skipped browser test',async()=>{
 const result=await fullRunnerResult({cases:[{name:windowsKeyTest,skip:true},{name:'browser verification',skip:true}]});assert.equal(result.status,1);assert.match(result.stderr,/skip/i);
});

test('strict full runner rejects an unexplained skipped total without a trailing newline',async()=>{
 const result=await fullRunnerResult({output:'TAP version 13\nok 1 - browser verification\n1..1\n# tests 1\n# skipped 1'});assert.equal(result.status,1);assert.match(result.stderr,/skip/i);
});

test('strict full runner rejects an empty or missing TAP test count',async()=>{
 for(const output of ['TAP version 13\n1..0\n# tests 0\n# skipped 0\n','TAP version 13\n# skipped 0\n']){
  const result=await fullRunnerResult({output});assert.equal(result.status,1);assert.match(result.stderr,/test|empty|count/i);
 }
});

test('strict full runner rejects unfinished TODO tests and missing summary counters',async()=>{
 const todo=await fullRunnerResult({output:'TAP version 13\nok 1 - unfinished # TODO\n1..1\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 1\n'});assert.equal(todo.status,1);
 const missing=await fullRunnerResult({output:'TAP version 13\nok 1 - fixture\n1..1\n# tests 1\n# skipped 0\n'});assert.equal(missing.status,1);
});
