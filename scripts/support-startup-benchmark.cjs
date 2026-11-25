'use strict';
// Isolated source Electron only: no production EXE, profile, .env, or queue is opened.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{once}=require('node:events');
const root=path.resolve(__dirname,'..');
// Optional frozen runtime snapshot for controlled A/B; dependencies and Electron
// still come from the repository's existing local test runtime.
const sourceRoot=path.resolve(process.argv[4]||root);
const {captureSourceIdentity,compareSources,phaseDifferences,summarizeSamples}=require('./startup-benchmark-evidence.cjs');
const { _electron:electron }=require(path.join(root,'.desktop-build/production/node_modules/playwright-core'));
const output=path.resolve(process.argv[2]||path.join(os.tmpdir(),'pageposter-startup-benchmark-'+crypto.randomUUID()));
const samples=Number(process.argv[3]||3);
if(!Number.isSafeInteger(samples)||samples<1||samples>20)throw Error('Sample count must be 1..20');
if(output===root||output===path.dirname(root)||!output.includes('benchmark'))throw Error('Use a dedicated benchmark evidence directory');
fs.mkdirSync(output,{recursive:true});
const executablePath=path.join(root,'.desktop-build/runtime/node_modules/electron/dist/electron.exe');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const results=[],sourceBefore=captureSourceIdentity(sourceRoot),createdAt=new Date().toISOString();
function saveReport(state){
 const sourceAfter=captureSourceIdentity(sourceRoot);
 const report={format:2,createdAt,state,method:'Source Electron; fresh process each sample; alternating new profile then reused profile. OS caches are not cleared. Nearest-rank percentiles; all outliers and failed attempts retained. Phase differences are observed milestone gaps, not isolated CPU/network timings. Compare runs only with matched runtime source identities and profile definitions.',runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},sourceIdentity:{before:sourceBefore,after:sourceAfter,...compareSources(sourceBefore,sourceAfter)},network:'Electron session request allowlist: file/data/devtools and loopback HTTP/WS only; isolated empty workspace; no remote actions scheduled',summary:summarizeSamples(results),results};
 fs.writeFileSync(path.join(output,'startup-baseline.json'),JSON.stringify(report,null,2)+'\n');return report;
}
saveReport('running');
async function launch(profile,kind,index){
 fs.mkdirSync(profile,{recursive:true});
 const wrapper=path.join(profile,'offline-main.cjs'),deniedFile=path.join(profile,'network-count.json');
 fs.writeFileSync(wrapper,"'use strict';\nconst {app}=require('electron'),fs=require('node:fs');let denied=0;app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-component-update');app.on('session-created',session=>session.webRequest.onBeforeRequest((details,callback)=>{let allowed=false;try{const u=new URL(details.url);allowed=['file:','data:','devtools:'].includes(u.protocol)||['http:','ws:'].includes(u.protocol)&&['127.0.0.1','localhost','[::1]'].includes(u.hostname);}catch{}if(!allowed)denied++;callback({cancel:!allowed});}));app.on('will-quit',()=>fs.writeFileSync("+JSON.stringify(deniedFile)+",JSON.stringify({denied})));require("+JSON.stringify(path.join(sourceRoot,'desktop/main.cjs'))+");\n");
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(OPENAI_|GOOGLE_|PAGEPOSTER_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/.test(key))delete env[key];
 Object.assign(env,{PAGEPOSTER_DESKTOP_TEST_ROOT:profile,PAGEPOSTER_NODE_PATH:process.execPath,PAGEPOSTER_MASTER_KEY:crypto.randomBytes(32).toString('base64')});
 // Keep the same isolated workspace key across the warm pair.
 const keyFile=path.join(profile,'fixture-key');if(fs.existsSync(keyFile))env.PAGEPOSTER_MASTER_KEY=fs.readFileSync(keyFile,'utf8');else fs.writeFileSync(keyFile,env.PAGEPOSTER_MASTER_KEY);
 const diagnosticsFile=path.join(profile,'profile','startup-diagnostics.json');
 if(fs.existsSync(diagnosticsFile))fs.unlinkSync(diagnosticsFile);
 const begin=performance.now();let app;
 try{
  app=await electron.launch({executablePath,args:[wrapper],env,timeout:30000});
  const window=await app.firstWindow();
  let snapshot;
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){try{snapshot=JSON.parse(fs.readFileSync(diagnosticsFile,'utf8'));if(snapshot.phases['queue-response']!==undefined&&snapshot.phases['workspace-loaded']!==undefined)break;}catch{}await sleep(100);}
  if(snapshot?.phases?.['queue-response']===undefined||snapshot?.phases?.['workspace-loaded']===undefined)throw Error('Isolated queue and workspace readiness were not observed');
  const wallMs=Math.round(performance.now()-begin);
  const renderer=await window.evaluate(()=>{
   const resources=performance.getEntriesByType('resource'),assets=resources.filter(entry=>['script','css','link'].includes(entry.initiatorType));
   const navigation=performance.getEntriesByType('navigation')[0];
   return {resourceCount:resources.length,assetCount:assets.length,assetDurationTotalMs:Math.round(assets.reduce((sum,entry)=>sum+entry.duration,0)),lastAssetResponseEndMs:Math.round(Math.max(0,...assets.map(entry=>entry.responseEnd))),domContentLoadedMs:navigation?Math.round(navigation.domContentLoadedEventEnd):null,loadEventEndMs:navigation?Math.round(navigation.loadEventEnd):null};
  });
  const electronVersion=await app.evaluate(()=>process.versions.electron);
  const child=app.process(),exited=once(child,'exit');
  await app.evaluate(({app})=>app.quit()).catch(()=>{});
  await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('Graceful isolated exit timed out')),15000).unref())]);
  const network=JSON.parse(fs.readFileSync(deniedFile,'utf8'));
  results.push({kind,index,status:'ready',wallMs,phases:snapshot.phases,phaseDifferences:phaseDifferences(snapshot.phases),renderer,electronVersion,externalRequestsDenied:network.denied});saveReport('running');
 }catch(error){results.push({kind,index,status:'failed',wallMs:Math.round(performance.now()-begin),errorCode:'STARTUP_ATTEMPT_FAILED'});saveReport('failed');throw error;}
 finally{await app?.close().catch(()=>{});}
}
(async()=>{
 for(let index=0;index<samples;index++){
  const profile=path.join(output,'profile-'+index+'-'+crypto.randomUUID());
  await launch(profile,'process-cold-fresh-profile',index);await launch(profile,'process-cold-warm-profile',index);
 }
 const report=saveReport('complete');console.log(JSON.stringify({output:path.join(output,'startup-baseline.json'),sourceStable:report.sourceIdentity.stable,summary:report.summary}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
