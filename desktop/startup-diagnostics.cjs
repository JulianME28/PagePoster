'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const allowed=new Set(['main-entered','electron-ready','window-created','startup-loaded','backend-spawned','backend-ready','workspace-loaded','queue-response','failed']);

function createStartupDiagnostics({now=Date.now,uptime=()=>process.uptime(),writeFile=fs.writeFile,mkdir=fs.mkdir}={}){
 const startedAt=Math.round(now()-uptime()*1000),phases=Object.create(null);
 let directory=null,pending=Promise.resolve();
 function mark(name){
  if(!allowed.has(name)||Object.hasOwn(phases,name))return false;
  phases[name]=Math.max(0,Math.round(now()-startedAt));return true;
 }
 function setDirectory(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0'))return false;
  directory=value;return true;
 }
 function flush(){
  if(!directory)return pending;
  const targetDirectory=directory,filename=path.join(directory,'startup-diagnostics.json');
  const snapshot=JSON.stringify({format:1,startedAt,phases})+'\n';
  pending=pending.then(async()=>{
   await mkdir(targetDirectory,{recursive:true});await writeFile(filename,snapshot,'utf8');
  }).catch(()=>{});
  return pending;
 }
 function snapshot(){return {format:1,startedAt,phases:{...phases}};}
 return {mark,setDirectory,flush,snapshot};
}
module.exports={createStartupDiagnostics};
