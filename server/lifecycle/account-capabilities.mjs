// Private local observations, never an authorization cache or a credential store.
import {createHmac} from 'node:crypto';
import {validatePublicUrl} from './network.mjs';

const KIND='account_capabilities',MAX_ACCOUNTS=8,MAX_EVENTS=32,DAY=86400000;
const phases=new Set(['login','plugin','editor','markup']);
const validTime=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
const isStale=(value,now)=>!Number.isFinite(now)||!validTime(value)||now-Date.parse(value)<0||now-Date.parse(value)>DAY;
const int=value=>Number.isSafeInteger(value)&&value>=0;
function safeScope(value){return value&&typeof value.runId==='string'&&/^[A-Za-z0-9:_-]{1,200}$/.test(value.runId)&&int(value.destinationRevision)&&int(value.publicationAttempt)?{runId:value.runId,destinationRevision:value.destinationRevision,publicationAttempt:value.publicationAttempt}:null;}
function safeFacts(phase,value,postId){
 const facts={};if(!value||typeof value!=='object'||Array.isArray(value))return facts;
 if(phase==='login'&&typeof value.login==='boolean')facts.login=value.login;
 if(phase==='plugin'){
  if(typeof value.pluginAccess==='boolean')facts.pluginAccess=value.pluginAccess;
  if(['active','unavailable'].includes(value.plugin))facts.plugin=value.plugin;
 }
 if(phase==='editor'&&['classic','block','available','unavailable'].includes(value.editor))facts.editor=value.editor;
 if(phase==='markup'&&Number.isSafeInteger(postId)&&postId>0&&typeof value.markup==='boolean')facts.markup=value.markup;
 return facts;
}
function safeAccount(value){
 if(!value||! /^[a-f0-9]{64}$/.test(value.ref||'')||![0,1].includes(value.accountIndex)||!validTime(value.firstSeenAt)||!validTime(value.lastSeenAt))return null;
 const events=[];
 for(const event of Array.isArray(value.events)?value.events.slice(-MAX_EVENTS):[]){
  const scope=safeScope(event?.scope);if(!scope||!phases.has(event.phase)||!validTime(event.at))continue;
  const facts=safeFacts(event.phase,event.facts,event.postId);if(!Object.keys(facts).length)continue;
  events.push({phase:event.phase,at:event.at,scope,facts,...(event.phase==='markup'?{postId:event.postId}:{})});
 }
 const facts={};
 for(const [name,fact] of Object.entries(value.facts||{})){
  const phase=name==='login'?'login':['plugin','pluginAccess'].includes(name)?'plugin':name==='editor'?'editor':name==='markup'?'markup':null,scope=safeScope(fact?.scope);
  if(!phase||!scope||!validTime(fact?.at)||!Object.hasOwn(safeFacts(phase,{[name]:fact.value},fact.postId),name))continue;
  facts[name]={value:fact.value,at:fact.at,scope,...(phase==='markup'?{postId:fact.postId}:{})};
 }
 for(const event of events)for(const [name,value] of Object.entries(event.facts))facts[name]={value,at:event.at,scope:event.scope,...(event.phase==='markup'?{postId:event.postId}:{})};
 return {ref:value.ref,accountIndex:value.accountIndex,firstSeenAt:value.firstSeenAt,lastSeenAt:value.lastSeenAt,events,facts};
}
function siteBase(value){const url=validatePublicUrl(value);if(url.search||url.hash)throw Object.assign(Error('Invalid capability site'),{code:'VALIDATION'});return url.href.endsWith('/')?url.href:url.href+'/';}

export function createAccountCapabilityHistory({store,masterKey,clock=Date.now}={}){
 const key=typeof masterKey==='string'?Buffer.from(masterKey,'base64'):null;
 if(!key||key.length!==32||key.toString('base64')!==masterKey)throw Object.assign(Error('Capability key unavailable'),{code:'KEY_REQUIRED'});
 const digest=value=>createHmac('sha256',key).update(JSON.stringify(value)).digest('hex');
 function binding(projectId,baseUrl){if(typeof projectId!=='string'||!projectId||projectId.length>200)throw Object.assign(Error('Invalid capability project'),{code:'VALIDATION'});const site=siteBase(baseUrl);return {site,id:'account-capabilities:'+digest(['site-v1',projectId,site])};}
 function observe({projectId,baseUrl,credentials,accountIndex,scope,phase,facts,postId}={}){
  const validScope=safeScope(scope),values=safeFacts(phase,facts,postId);
  if(!validScope||!phases.has(phase)||![0,1].includes(accountIndex)||!Object.keys(values).length)return null;
  if(!credentials||typeof credentials.username!=='string'||!credentials.username||credentials.username.length>1000||typeof credentials.applicationPassword!=='string'||!credentials.applicationPassword||credentials.applicationPassword.length>4096)return null;
  const {site,id}=binding(projectId,baseUrl),ref=digest(['account-v1',projectId,site,credentials.username,credentials.applicationPassword]),at=new Date(clock()).toISOString();
  return store.atomic(()=>{
   const previous=store.getRecord(id);if(previous&&(previous.kind!==KIND||previous.projectId!==projectId||previous.site!==site))throw Object.assign(Error('Capability binding changed'),{code:'CONFLICT'});
   let accounts=(previous?.accounts||[]).map(safeAccount).filter(Boolean),account=accounts.find(row=>row.ref===ref);
   if(!account){account={ref,accountIndex,firstSeenAt:at,lastSeenAt:at,events:[],facts:{}};accounts.push(account);}
   account.accountIndex=accountIndex;account.lastSeenAt=at;account.events.push({phase,at,scope:validScope,facts:values,...(phase==='markup'?{postId}:{})});account.events=account.events.slice(-MAX_EVENTS);
   for(const [name,value] of Object.entries(values))account.facts[name]={value,at,scope:validScope,...(phase==='markup'?{postId}:{})};
   const truncated=previous?.truncated===true||accounts.length>MAX_ACCOUNTS;
   if(accounts.length>MAX_ACCOUNTS)accounts=accounts.filter(row=>row!==account).slice(-(MAX_ACCOUNTS-1)).concat(account);
   const patch={format:1,site,accounts,truncated};if(previous)store.updateRecord(id,patch,previous.revision);else store.createRecord(projectId,KIND,patch,id);
   return {historyId:id,accountRef:ref};
  });
 }
 function view({projectId,baseUrl,accountRef,scope}={}){
  const {site,id}=binding(projectId,baseUrl),record=store.getRecord(id),current=safeScope(scope),now=clock();
  if(!record||record.kind!==KIND||record.projectId!==projectId||record.site!==site)return {rows:[],truncated:false};
  const rows=(Array.isArray(record.accounts)?record.accounts:[]).slice(-MAX_ACCOUNTS).map(safeAccount).filter(Boolean).map(account=>{
   const latest=account.events.at(-1),age=now-Date.parse(account.lastSeenAt);
   const sameScope=value=>!!current&&!!value&&['runId','destinationRevision','publicationAttempt'].every(name=>current[name]===value[name]);
   const facts=Object.fromEntries(Object.entries(account.facts).map(([name,fact])=>[name,{value:fact.value,at:fact.at,observedInThisRun:sameScope(fact.scope),stale:isStale(fact.at,now)}]));
   return {accountIndex:account.accountIndex,active:account.ref===accountRef,observedInThisRun:sameScope(latest?.scope),stale:age<0||age>DAY,firstSeenAt:account.firstSeenAt,lastSeenAt:account.lastSeenAt,facts};
  });
  return {rows,truncated:record.truncated===true};
 }
 return Object.freeze({observe,view});
}

export function safeAccountCapabilityView(value,{now=Date.now()}={}){
 if(!value||!Array.isArray(value.rows))return null;
 const rows=[];for(const row of value.rows.slice(0,MAX_ACCOUNTS)){
  if(!row||![0,1].includes(row.accountIndex)||!validTime(row.firstSeenAt)||!validTime(row.lastSeenAt))continue;
  const facts={};for(const [name,fact] of Object.entries(row.facts||{})){
   const valid=['login','pluginAccess','markup'].includes(name)?typeof fact?.value==='boolean':name==='plugin'?['active','unavailable'].includes(fact?.value):name==='editor'?['classic','block','available','unavailable'].includes(fact?.value):false;
   if(valid&&validTime(fact.at))facts[name]={value:fact.value,at:fact.at,observedInThisRun:fact.observedInThisRun===true,stale:fact.stale===true||isStale(fact.at,now)};
  }
  rows.push({accountIndex:row.accountIndex,active:row.active===true,observedInThisRun:row.observedInThisRun===true,stale:row.stale===true||isStale(row.lastSeenAt,now),firstSeenAt:row.firstSeenAt,lastSeenAt:row.lastSeenAt,facts});
 }
 return {rows,truncated:value.truncated===true||value.rows.length>MAX_ACCOUNTS};
}
