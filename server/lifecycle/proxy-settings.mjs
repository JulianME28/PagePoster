import {readFile,writeFile,rename,unlink,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {createSecretBox} from './secrets.mjs';
import {createProxyPool,proxyError} from './proxy-pool.mjs';
import {createProxySessionRouter} from './proxy-sessions.mjs';
import {createSafeTransport} from './network.mjs';
import {createProxyTransport as defaultProxyTransport} from './proxy-transport.mjs';
import {createProxyChecks} from './proxy-checks.mjs';

const ID='pageposter:proxies:v1';
export function parseProxyList(input){
 if(typeof input!=='string'||Buffer.byteLength(input)>100000)throw proxyError('PROXY_CONFIG_INVALID');
 const entries=[];
 for(const [index,raw]of input.split(/\r?\n/).entries()){
  const line=raw.trim();if(!line)continue;
  try{
   let value=line;
   if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)){
    if(!/^[^:\s]+:\d+(?::[^:]+:.+)?$/.test(value))throw proxyError('PROXY_CONFIG_INVALID');
    const [host,port,user,...password]=value.split(':');value='http://'+(user?encodeURIComponent(user)+':'+encodeURIComponent(password.join(':'))+'@':'')+host+':'+port;
   }
   const url=new URL(value),id='proxy-'+createHash('sha256').update(url.protocol+'//'+url.hostname+':'+(url.port||({http:'80',https:'443',socks5:'1080'})[url.protocol.slice(0,-1)])+'\0'+url.username).digest('hex').slice(0,24);
   const entry={id,url:value,label:'Проксі '+(entries.length+1)};createProxyPool({entries:[entry]});entries.push(entry);
  }catch{throw Object.assign(proxyError('PROXY_CONFIG_INVALID'),{line:index+1});}
 }
 createProxyPool({entries});return entries;
}

export async function createProxySettings({dataDir,masterKey,directTransport=createSafeTransport({allowWrites:true,maxBytes:5*1024*1024}),createProxyTransport=defaultProxyTransport,clock=Date.now}={}){
 const filename=path.join(dataDir,'proxy-settings.json'),box=masterKey?createSecretBox(masterKey):null;
 let config={version:1,revision:0,enabled:false,entries:[]},closed=false,work=Promise.resolve(),closePromise=null;
 try{
  if((await stat(filename)).size>300000)throw proxyError('PROXY_SETTINGS_UNAVAILABLE');
  if(!box)throw proxyError('PROXY_SETTINGS_UNAVAILABLE');
  const value=JSON.parse(box.decrypt(ID,JSON.parse(await readFile(filename,'utf8'))).applicationPassword);
  if(value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.enabled!=='boolean'||value.enabled&&!value.entries?.length)throw proxyError('PROXY_SETTINGS_UNAVAILABLE');
  createProxyPool({entries:value.entries});config=value;
 }catch(error){if(error.code!=='ENOENT')throw proxyError('PROXY_SETTINGS_UNAVAILABLE');}
 const generations=new Map(),sessions=new Map(),coordination={busy:new Set(),retryAt:new Map()};
 const checks=createProxyChecks({createProxyTransport,coordination,clock});
 const status=()=>({enabled:config.enabled,count:config.entries.length,revision:config.revision,storageAvailable:!!box,activeSessions:sessions.size});
 function save(body){const pending=work.then(async()=>{
  if(closed)throw proxyError('PROXY_ROUTER_CLOSED');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['enabled','list','clear','expectedRevision'].includes(k))||typeof body.enabled!=='boolean'||body.clear!==undefined&&typeof body.clear!=='boolean'||!Number.isSafeInteger(body.expectedRevision))throw proxyError('PROXY_CONFIG_INVALID');
  if(body.expectedRevision!==config.revision)throw proxyError('CONFLICT');if(!box)throw proxyError('KEY_REQUIRED');
  if(body.list!==undefined&&typeof body.list!=='string')throw proxyError('PROXY_CONFIG_INVALID');
  if(body.clear&&body.list?.trim())throw proxyError('PROXY_CONFIG_INVALID');
  const entries=body.clear?[]:body.list?.trim()?parseProxyList(body.list):config.entries;
  if(body.enabled&&!entries.length)throw proxyError('PROXY_LIST_EMPTY');
  const next={version:1,revision:config.revision+1,enabled:body.enabled,entries},plain=JSON.stringify(next);
  if(Buffer.byteLength(plain)>131072)throw proxyError('PROXY_CONFIG_INVALID');
  const temporary=filename+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(box.encrypt(ID,{username:'proxy-settings',applicationPassword:plain})),{mode:0o600,flag:'wx'});await rename(temporary,filename);}finally{await unlink(temporary).catch(()=>{});}
  await checks.clear();config=next;return status();
 });work=pending.catch(()=>{});return pending;}
 async function open(sessionId,{binding}={}){
  await work;if(closed)throw proxyError('PROXY_ROUTER_CLOSED');
  const existing=sessions.get(sessionId);if(existing)return existing.pending;
  if(binding&&(!['direct','proxy'].includes(binding.mode)||binding.mode==='proxy'&&typeof binding.proxyId!=='string'))throw proxyError('PROXY_CONFIG_INVALID');
  const enabled=binding?binding.mode==='proxy':config.enabled,proxyId=binding?.mode==='proxy'?binding.proxyId:undefined;
  if(proxyId&&!config.entries.some(e=>e.id===proxyId))throw proxyError('PROXY_PINNED_UNAVAILABLE');
  const generationKey=config.revision+':'+enabled;let generation=generations.get(generationKey);
  if(!generation){generation={refs:0,router:createProxySessionRouter({enabled,entries:config.entries,directTransport,createProxyTransport,clock,coordination})};generations.set(generationKey,generation);}
  generation.refs++;const record={pending:null};
  record.pending=(async()=>{
   try{
    const session=await generation.router.open(sessionId,{proxyId});let ending;
    return {route:session.route,transport:session.transport,close:()=>ending||(ending=(async()=>{await session.close();sessions.delete(sessionId);generation.refs--;if(generationKey!==config.revision+':'+config.enabled&&!generation.refs){await generation.router.close();generations.delete(generationKey);}})())};
   }catch(error){generation.refs--;sessions.delete(sessionId);throw error;}
  })();sessions.set(sessionId,record);return record.pending;
 }
 async function check(body){await work;if(closed)throw proxyError('PROXY_ROUTER_CLOSED');if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['expectedRevision','list'].includes(k))||!Number.isSafeInteger(body.expectedRevision)||body.list!==undefined&&typeof body.list!=='string')throw proxyError('PROXY_CONFIG_INVALID');if(body.expectedRevision!==config.revision)throw proxyError('CONFLICT');const draft=!!body.list?.trim();return checks.start(draft?parseProxyList(body.list):config.entries,{revision:config.revision,source:draft?'draft':'saved'});}
 function lastObservation(proxyId){
  const checked=checks.status();
  if(checked?.source!=='saved'||checked.revision!==config.revision)return null;
  const index=config.entries.findIndex(entry=>entry.id===proxyId),row=checked.rows[index];
  return row?.state==='ok'?{ip:row.ip,country:row.country,checkedAt:row.checkedAt}:null;
 }
 function close(){if(closePromise)return closePromise;closed=true;closePromise=(async()=>{await work;await checks.close();await Promise.allSettled([...sessions.values()].map(async record=>(await record.pending).close()));const results=await Promise.allSettled([...generations.values()].map(g=>g.router.close()));if(results.some(r=>r.status==='rejected'))throw proxyError('PROXY_CLOSE_FAILED');})();return closePromise;}
 return {status,save,open,close,check,checkStatus:checks.status,cancelCheck:checks.cancel,lastObservation};
}
