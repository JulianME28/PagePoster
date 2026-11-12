'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const phases=new Set(['main-entered','electron-ready','window-created','startup-loaded','backend-spawned','backend-ready','workspace-loaded','queue-response','failed']);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const integer=(value,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=0&&value<=max;
function createSupportMetadata({appRoot}={}){
 let build={state:'unavailable'},startup=null,runtime={electron:null};
 // There is one trusted build manifest location. Source/development has no build identity.
 try{
  if(path.basename(appRoot)==='app'&&path.basename(path.dirname(appRoot))==='resources'){
   const filename=path.resolve(appRoot,'../..','build-manifest.json');
   if(fs.statSync(filename).size<=5*1024*1024){
    const bytes=fs.readFileSync(filename),manifest=JSON.parse(bytes.toString('utf8'));
    if(manifest.format===1&&manifest.application==='PagePoster'&&manifest.algorithm==='sha256'&&Array.isArray(manifest.files)&&manifest.files.length>0){
     build={state:'available',manifestSha256:createHash('sha256').update(bytes).digest('hex')};
     const entry=manifest.files.find(file=>file?.path==='build-metadata.json');
     if(entry){
      const identityFile=path.join(path.dirname(filename),entry.path);
      if(fs.statSync(identityFile).size===entry.size&&entry.size<=32768){
       const identityBytes=fs.readFileSync(identityFile);
       if(createHash('sha256').update(identityBytes).digest('hex')===entry.sha256){
        const identity=JSON.parse(identityBytes.toString('utf8'));
        if(identity.format===1&&typeof identity.buildId==='string'&&/^[a-f0-9]{64}$/.test(identity.buildId))build.buildId=identity.buildId;
       }
      }
     }
    }
   }
  }
 }catch{}
 function get(){return {build:{...build},runtime:{...runtime},startup:startup?{format:1,startedAt:startup.startedAt,phases:{...startup.phases}}:null};}
 function update(value){
  if(!exact(value,['startup','runtime']))return false;
  let nextStartup=startup,nextRuntime=runtime;
  if(value.startup!==undefined){
   const snapshot=value.startup;
   if(!exact(snapshot,['format','startedAt','phases'])||snapshot.format!==1||!integer(snapshot.startedAt)||!object(snapshot.phases)||Object.keys(snapshot.phases).some(name=>!phases.has(name)||!integer(snapshot.phases[name],604800000)))return false;
   nextStartup={format:1,startedAt:snapshot.startedAt,phases:{...snapshot.phases}};
  }
  if(value.runtime!==undefined){
   if(!exact(value.runtime,['electron'])||typeof value.runtime.electron!=='string'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.runtime.electron))return false;
   nextRuntime={electron:value.runtime.electron};
  }
  startup=nextStartup;runtime=nextRuntime;return true;
 }
 return {get,update};
}
module.exports={createSupportMetadata};
