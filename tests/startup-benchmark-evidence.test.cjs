'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const evidence=require('../scripts/startup-benchmark-evidence.cjs');

test('source identity detects an added renderer asset and changed backend without reading profile secrets',t=>{
 assert.equal(typeof evidence.captureSourceIdentity,'function','capture runtime source identities before and after measurements');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-benchmark-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const dir of ['desktop','server','dist'])fs.mkdirSync(path.join(root,dir));
 fs.writeFileSync(path.join(root,'desktop/main.cjs'),'main');fs.writeFileSync(path.join(root,'server/local.cjs'),'server');fs.writeFileSync(path.join(root,'dist/index.html'),'index');
 fs.writeFileSync(path.join(root,'desktop/google-client.json'),'fixture-private-registration');fs.writeFileSync(path.join(root,'.env'),'fixture-private-env');
 const before=evidence.captureSourceIdentity(root);
 assert.deepEqual(Object.keys(before.files),['desktop/main.cjs','dist/index.html','server/local.cjs']);
 fs.writeFileSync(path.join(root,'server/local.cjs'),'changed');fs.writeFileSync(path.join(root,'dist/extra.js'),'added');
 const after=evidence.captureSourceIdentity(root);
 assert.notEqual(before.sha256,after.sha256);
 assert.deepEqual(evidence.compareSources(before,after),{stable:false,changedFiles:['dist/extra.js','server/local.cjs']});
 assert.deepEqual(evidence.compareSources(after,after),{stable:true,changedFiles:[]});
 assert.doesNotMatch(JSON.stringify(after),/fixture-private/);
});

test('phase differences account for overlapping backend and startup renderer and keep unknowns null',()=>{
 assert.equal(typeof evidence.phaseDifferences,'function','derive observed startup phase differences');
 assert.deepEqual(evidence.phaseDifferences({'electron-ready':100,'window-created':130,'backend-spawned':150,'startup-loaded':600,'backend-ready':400,'workspace-loaded':900,'queue-response':850}),{
  electronSetupMs:50,backendInitializationMs:250,startupRendererMs:470,workspaceAfterPrerequisitesMs:300,queueAfterPrerequisitesMs:250
 });
 assert.deepEqual(evidence.phaseDifferences({'backend-ready':300,'backend-spawned':400}),{electronSetupMs:null,backendInitializationMs:null,startupRendererMs:null,workspaceAfterPrerequisitesMs:null,queueAfterPrerequisitesMs:null});
});

test('summary retains outliers and failures and does not manufacture percentiles for missing phases',()=>{
 assert.equal(typeof evidence.summarizeSamples,'function','report all successful and failed attempts');
 const result=evidence.summarizeSamples([{kind:'fresh',status:'ready',wallMs:100,phases:{'backend-ready':70}},{kind:'fresh',status:'ready',wallMs:26000,phases:{}},{kind:'fresh',status:'failed',errorCode:'STARTUP_READINESS_TIMEOUT'}]);
 assert.equal(result.fresh.attempts,3);assert.equal(result.fresh.failed,1);assert.equal(result.fresh.n,2);
 assert.deepEqual(result.fresh.wallMs,{p50:100,p95:26000});assert.deepEqual(result.fresh.milestones['backend-ready'],{n:1,p50:70,p95:70});
 assert.deepEqual(evidence.summarizeSamples([{kind:'fresh',status:'failed'}]).fresh.wallMs,{p50:null,p95:null});
});

test('CPU profile summary reports sampled elapsed time instead of claiming synchronous waits are CPU work',()=>{
 assert.equal(typeof evidence.summarizeCpuProfile,'function','attribute sampled startup stalls to source frames');
 const result=evidence.summarizeCpuProfile({startTime:0,endTime:6000,nodes:[{id:1,callFrame:{functionName:'createRunStore',url:'file:///fixture/run-store.mjs'}},{id:2,callFrame:{functionName:'compileSourceTextModule',url:'node:internal/modules/esm/utils'}}],samples:[1,2,1],timeDeltas:[1000,2000,3000]});
 assert.equal(result.elapsedMs,6);assert.deepEqual(result.frames,[{functionName:'createRunStore',source:'file:///fixture/run-store.mjs',sampledElapsedMs:4},{functionName:'compileSourceTextModule',source:'node:internal/modules/esm/utils',sampledElapsedMs:2}]);
 assert.match(result.interpretation,/blocking/);
});
