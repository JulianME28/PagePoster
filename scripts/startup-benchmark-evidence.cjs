'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function captureSourceIdentity(root){
 const names=[];
 function visit(relative){
  const directory=path.join(root,relative);if(!fs.existsSync(directory))return;
  for(const item of fs.readdirSync(directory,{withFileTypes:true})){
   const name=(relative+'/'+item.name).replaceAll('\\','/');
   if(item.isDirectory()&&item.name!=='node_modules')visit(name);
   else if(item.isFile()&&/\.(?:cjs|mjs|js|html|css)$/.test(item.name))names.push(name);
  }
 }
 for(const directory of ['desktop','server','dist'])visit(directory);
 for(const name of ['package.json','pnpm-lock.yaml','scripts/support-startup-benchmark.cjs','scripts/startup-benchmark-evidence.cjs'])if(fs.existsSync(path.join(root,name)))names.push(name);
 const files=Object.fromEntries(names.sort().map(name=>[name,hash(fs.readFileSync(path.join(root,name)))]));
 return {sha256:hash(JSON.stringify(files)),files};
}
function compareSources(before,after){
 const changedFiles=[...new Set([...Object.keys(before.files),...Object.keys(after.files)])].filter(name=>before.files[name]!==after.files[name]).sort();
 return {stable:changedFiles.length===0,changedFiles};
}
function phaseDifferences(phases={}){
 const difference=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)&&end>=start?end-start:null;
 const prerequisites=Number.isFinite(phases['backend-ready'])&&Number.isFinite(phases['startup-loaded'])?Math.max(phases['backend-ready'],phases['startup-loaded']):null;
 return {electronSetupMs:difference(phases['backend-spawned'],phases['electron-ready']),backendInitializationMs:difference(phases['backend-ready'],phases['backend-spawned']),startupRendererMs:difference(phases['startup-loaded'],phases['window-created']),workspaceAfterPrerequisitesMs:difference(phases['workspace-loaded'],prerequisites),queueAfterPrerequisitesMs:difference(phases['queue-response'],prerequisites)};
}
const percentile=(values,p)=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]:null;};
const distribution=values=>({p50:percentile(values,.5),p95:percentile(values,.95)});
function summarizeSamples(results){
 const summary={};
 for(const kind of new Set(results.map(value=>value.kind))){
  const attempts=results.filter(value=>value.kind===kind),group=attempts.filter(value=>value.status==='ready');
  const value={attempts:attempts.length,failed:attempts.length-group.length,n:group.length,wallMs:distribution(group.map(sample=>sample.wallMs)),milestones:{},phaseDifferences:{}};
  for(const phase of new Set(group.flatMap(sample=>Object.keys(sample.phases||{})))){const times=group.map(sample=>sample.phases?.[phase]).filter(Number.isFinite);value.milestones[phase]={n:times.length,...distribution(times)};}
  for(const name of Object.keys(phaseDifferences())){const times=group.map(sample=>phaseDifferences(sample.phases)[name]).filter(Number.isFinite);value.phaseDifferences[name]={n:times.length,...distribution(times)};}
  summary[kind]=value;
 }
 return summary;
}
function summarizeCpuProfile(profile){
 const nodes=new Map(profile.nodes.map(node=>[node.id,node])),counts=new Map();
 for(let index=0;index<profile.samples.length;index++){
  const node=nodes.get(profile.samples[index]);if(!node)continue;
  const frame={functionName:node.callFrame.functionName,source:node.callFrame.url},key=JSON.stringify(frame);
  const delta=profile.timeDeltas[index];if(Number.isFinite(delta)&&delta>=0)counts.set(key,(counts.get(key)||0)+delta);
 }
 return {elapsedMs:(profile.endTime-profile.startTime)/1000,interpretation:'Sampled elapsed time in top frames; synchronous blocking filesystem/SQLite calls may include waits. This is not measured CPU utilization.',frames:[...counts].sort((a,b)=>b[1]-a[1]).slice(0,40).map(([key,time])=>({...JSON.parse(key),sampledElapsedMs:Math.round(time/1000)}))};
}
module.exports={captureSourceIdentity,compareSources,phaseDifferences,summarizeSamples,summarizeCpuProfile};
