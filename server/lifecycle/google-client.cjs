'use strict';
const fs=require('node:fs');
const invalid=()=>Object.assign(Error('A valid Google Desktop app registration is required.'),{code:'GOOGLE_CLIENT_INVALID'});
function normalizeGoogleClient(raw){
 try{
  if(typeof raw==='string'){if(raw.length>32768)throw 0;raw=JSON.parse(raw);}
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.web||!raw.installed||typeof raw.installed!=='object'||Array.isArray(raw.installed))throw 0;
  const {client_id,client_secret}=raw.installed;
  if(typeof client_id!=='string'||client_id.length>256||!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(client_id))throw 0;
  if(typeof client_secret!=='string'||!client_secret.length||client_secret.length>4096||/[\u0000-\u0020\u007f]/.test(client_secret))throw 0;
  // Desktop apps are public OAuth clients. Only their registration is bundled;
  // never copy owner emails, private user tokens or arbitrary downloaded fields.
  return {installed:{client_id,client_secret}};
 }catch{throw invalid();}
}
function loadGoogleClient(file){
 let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw invalid();}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32768)throw invalid();
 try{return normalizeGoogleClient(fs.readFileSync(file,'utf8'));}catch{throw invalid();}
}
module.exports={normalizeGoogleClient,loadGoogleClient};
