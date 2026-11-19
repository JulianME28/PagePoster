import {DatabaseSync,backup as sqliteBackup} from 'node:sqlite';
import {randomBytes,createCipheriv,createDecipheriv,scrypt as scryptCallback,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {createGzip,createGunzip,gunzip} from 'node:zlib';
import {mkdtemp,readFile,writeFile,readdir,mkdir,rm,rename,lstat} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';
import {createSecretBox} from './secrets.mjs';
import {rekeySiteCredential} from './browser-credential-envelope.mjs';
import {normalizeSiteCriteria} from './site-source.mjs';
const scrypt=promisify(scryptCallback),unzip=promisify(gunzip);
// v2 streams raw files through gzip before base64/JSON/encryption. The public
// archive remains JSON, so its encoded form is bounded independently of raw data.
// Temporary disk holds the SQLite snapshots, one gzip file and encrypted payload;
// memory holds the bounded encoded archive, never every raw file or raw base64.
export const FULL_BACKUP_LIMITS=Object.freeze({rawBytes:512*1024*1024,archiveBytes:150*1024*1024,payloadBytes:112*1024*1024,secretFileBytes:1024*1024,files:20000});
const LEGACY_MAX=100*1024*1024,AAD=version=>Buffer.from('PagePoster full recovery v'+version);
const DBS=['pageposter.sqlite','generation-runs.sqlite','ai-budget.sqlite'];
const SETTINGS=['openai-key.json','autopilot-source.json','google-oauth.json','proxy-settings.json','autopilot-browser-settings.json'];
const TABLES={
 'pageposter.sqlite':['projects','sites','project_site_links','site_credentials','pages','page_versions','checks','events','jobs','proposals','generation_receipts','generation_fingerprints','campaigns','workspace_records','workspace_policy_records'],
 'generation-runs.sqlite':['generation_runs','generation_batches'],
 'ai-budget.sqlite':['ai_requests']
};
const fail=code=>{throw Object.assign(Error(code),{code});};
function password(p){if(typeof p!=='string'||p.length<12||p.length>1024)fail('BACKUP_PASSWORD_INVALID');}
function allowed(name){return DBS.includes(name)||SETTINGS.includes(name)||/^screenshots\/[a-f0-9-]{36}\/pageposter-[a-f0-9-]+-(?:desktop|mobile)\.png$/.test(name);}
const fileLimit=name=>name.endsWith('.json')?FULL_BACKUP_LIMITS.secretFileBytes:FULL_BACKUP_LIMITS.rawBytes;
async function readOptional(file){try{return await readFile(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function statOptional(file){try{return await lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function byteGuard(limit,code,hash){let size=0;const stream=new Transform({transform(bytes,encoding,done){size+=bytes.length;if(size>limit)return done(Object.assign(Error(code),{code}));hash?.update(bytes);done(null,bytes);}});return {stream,size:()=>size};}
function base64(value,max){if(typeof value!=='string'||value.length>max||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value)||value.length&&Buffer.from(value.slice(-4),'base64').toString('base64')!==value.slice(-4))fail('BACKUP_INVALID');return value;}
function checkDB(filename,name){const db=new DatabaseSync(filename);try{db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON;');if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)fail('BACKUP_INVALID');
 const version=db.prepare('PRAGMA user_version').get().user_version;if(version<1||version>(name==='pageposter.sqlite'?6:2))fail('BACKUP_INVALID');
 const entries=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();for(const row of entries){if(row.type==='table'&&(!TABLES[name].includes(row.name)||/VIRTUAL\s+TABLE/i.test(row.sql)))fail('BACKUP_INVALID');if(['trigger','view'].includes(row.type))fail('BACKUP_INVALID');}
 if(name==='pageposter.sqlite')for(const row of db.prepare('SELECT data FROM projects').all()){try{const criteria=JSON.parse(row.data).siteSelection;if(criteria===null)fail('BACKUP_INVALID');normalizeSiteCriteria(criteria);}catch{fail('BACKUP_INVALID');}}
 const count=table=>entries.some(e=>e.type==='table'&&e.name===table)?db.prepare('SELECT count(*) AS n FROM '+table).get().n:0;
 return {projects:count('projects'),sites:count('sites'),pages:count('pages'),runs:count('generation_runs'),jobs:count('jobs')};
 }catch{fail('BACKUP_INVALID');}finally{db.close();}}
export async function canRestoreFullBackup(dataDir){for(const name of DBS){const file=path.join(dataDir,name);if(!await statOptional(file))continue;const db=new DatabaseSync(file,{readOnly:true});try{for(const table of TABLES[name])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&db.prepare('SELECT count(*) AS n FROM '+table).get().n)return false;}finally{db.close();}}return true;}
export async function exportFullBackup({dataDir,masterKey,passphrase}){
 password(passphrase);createSecretBox(masterKey);const staging=await mkdtemp(path.join(os.tmpdir(),'pageposter-full-backup-')),files=[];let total=0,key;
 const add=async(name,source)=>{const stat=await statOptional(source);if(!stat)return;if(!stat.isFile()||stat.isSymbolicLink())fail('BACKUP_INVALID');total+=stat.size;if(stat.size>fileLimit(name)||total>FULL_BACKUP_LIMITS.rawBytes||files.length>=FULL_BACKUP_LIMITS.files)fail('BACKUP_TOO_LARGE');files.push({name,source,size:stat.size});};
 try{
  for(const name of DBS){
   const source=path.join(dataDir,name),stat=await statOptional(source);if(!stat)continue;if(!stat.isFile()||stat.isSymbolicLink())fail('BACKUP_INVALID');if(total+stat.size>FULL_BACKUP_LIMITS.rawBytes)fail('BACKUP_TOO_LARGE');
   const db=new DatabaseSync(source,{readOnly:true});try{const size=db.prepare('PRAGMA page_count').get().page_count*db.prepare('PRAGMA page_size').get().page_size;if(total+size>FULL_BACKUP_LIMITS.rawBytes)fail('BACKUP_TOO_LARGE');await sqliteBackup(db,path.join(staging,name));}finally{db.close();}checkDB(path.join(staging,name),name);await add(name,path.join(staging,name));
  }
  if(!DBS.every(name=>files.some(file=>file.name===name)))fail('BACKUP_INVALID');
  for(const name of SETTINGS)await add(name,path.join(dataDir,name));
  try{for(const entry of await readdir(path.join(dataDir,'screenshots'),{withFileTypes:true})){if(!entry.isDirectory()||!/^[a-f0-9-]{36}$/.test(entry.name))continue;for(const f of await readdir(path.join(dataDir,'screenshots',entry.name),{withFileTypes:true})){const name='screenshots/'+entry.name+'/'+f.name;if(f.isFile()&&allowed(name))await add(name,path.join(dataDir,name));}}}catch(e){if(e.code!=='ENOENT')throw e;}
  const createdAt=new Date().toISOString(),salt=randomBytes(16),iv=randomBytes(12);key=await scrypt(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(AAD(2));
  async function* jsonChunks(){
   yield JSON.stringify({version:2,createdAt,masterKey}).slice(0,-1)+',"files":[';
   for(let i=0;i<files.length;i++){
    const file=files[i],compressed=path.join(staging,'compressed.gz'),hash=createHash('sha256'),raw=byteGuard(file.size,'BACKUP_TOO_LARGE',hash),encoded=byteGuard(FULL_BACKUP_LIMITS.payloadBytes,'BACKUP_TOO_LARGE');
    await pipeline(createReadStream(file.source),raw.stream,createGzip(),encoded.stream,createWriteStream(compressed,{flags:'wx',mode:0o600}));if(raw.size()!==file.size)fail('BACKUP_INVALID');
    yield (i?',':'')+JSON.stringify({name:file.name,encoding:'gzip',size:raw.size(),sha256:hash.digest('hex')}).slice(0,-1)+',"data":"';
    let tail=Buffer.alloc(0);for await(const chunk of createReadStream(compressed)){const bytes=tail.length?Buffer.concat([tail,chunk]):chunk,end=bytes.length-bytes.length%3;yield bytes.subarray(0,end).toString('base64');tail=bytes.subarray(end);}if(tail.length)yield tail.toString('base64');yield '"}';await rm(compressed);
   }
   yield ']}';
  }
  const encrypted=path.join(staging,'encrypted'),guard=byteGuard(FULL_BACKUP_LIMITS.payloadBytes,'BACKUP_TOO_LARGE');await pipeline(Readable.from(jsonChunks()),guard.stream,cipher,createWriteStream(encrypted,{flags:'wx',mode:0o600}));
  const archive={kind:'pageposter-full-encrypted-backup',version:2,kdf:'scrypt-32768-8-1',salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:(await readFile(encrypted)).toString('base64')};
  if(Buffer.byteLength(JSON.stringify({...archive,ciphertext:''}))+archive.ciphertext.length>FULL_BACKUP_LIMITS.archiveBytes)fail('BACKUP_TOO_LARGE');return archive;
 }finally{key?.fill(0);await rm(staging,{recursive:true,force:true});}
}
async function decode(archive,passphrase){password(passphrase);let key,plain;
 try{
  if(!archive||archive.kind!=='pageposter-full-encrypted-backup'||![1,2].includes(archive.version)||archive.kdf!=='scrypt-32768-8-1')throw Error();
  const max=archive.version===1?LEGACY_MAX*2:4*Math.ceil(FULL_BACKUP_LIMITS.payloadBytes/3);base64(archive.ciphertext,max);
  const salt=Buffer.from(base64(archive.salt,24),'base64'),iv=Buffer.from(base64(archive.iv,16),'base64'),tag=Buffer.from(base64(archive.tag,24),'base64');if(salt.length!==16||iv.length!==12||tag.length!==16)throw Error();
  key=await scrypt(passphrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});const decipher=createDecipheriv('aes-256-gcm',key,iv);decipher.setAAD(AAD(archive.version));decipher.setAuthTag(tag);const bytes=Buffer.concat([decipher.update(Buffer.from(archive.ciphertext,'base64')),decipher.final()]);
  if(archive.version===2&&bytes.length>FULL_BACKUP_LIMITS.payloadBytes)throw Error();plain=JSON.parse((archive.version===1?await unzip(bytes,{maxOutputLength:LEGACY_MAX*2}):bytes).toString('utf8'));
 }catch{fail('BACKUP_PASSWORD_INVALID');}finally{key?.fill(0);}
 if(!plain||plain.version!==archive.version||!Array.isArray(plain.files)||plain.files.length>FULL_BACKUP_LIMITS.files||!Number.isFinite(Date.parse(plain.createdAt)))fail('BACKUP_INVALID');try{createSecretBox(plain.masterKey);}catch{fail('BACKUP_INVALID');}let total=0;const seen=new Set();
 for(const file of plain.files){
  if(!file||!allowed(file.name)||seen.has(file.name)||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256))fail('BACKUP_INVALID');seen.add(file.name);base64(file.data,plain.version===1?LEGACY_MAX*2:FULL_BACKUP_LIMITS.payloadBytes);
  if(plain.version===2){if(file.encoding!=='gzip'||!Number.isSafeInteger(file.size)||file.size<0||file.size>fileLimit(file.name))fail('BACKUP_INVALID');}else file.size=Buffer.byteLength(file.data,'base64');
  total+=file.size;if(total>(plain.version===1?LEGACY_MAX:FULL_BACKUP_LIMITS.rawBytes))fail('BACKUP_INVALID');
 }
 if(!DBS.every(name=>seen.has(name)))fail('BACKUP_INVALID');return plain;
}
async function materialize(payload,dir){
 for(const file of payload.files){
  const target=path.join(dir,file.name);await mkdir(path.dirname(target),{recursive:true,mode:0o700});const hash=createHash('sha256'),raw=byteGuard(file.size,'BACKUP_INVALID',hash),bytes=Buffer.from(file.data,'base64');delete file.data;
  try{await pipeline(Readable.from([bytes]),...(payload.version===2?[createGunzip()]:[]),raw.stream,createWriteStream(target,{flags:'wx',mode:0o600}));}catch{fail('BACKUP_INVALID');}
  if(raw.size()!==file.size||hash.digest('hex')!==file.sha256)fail('BACKUP_INVALID');
 }
}
async function summaryFor(payload,dir){const summary={createdAt:payload.createdAt,files:payload.files.length,projects:0,sites:0,pages:0,runs:0,jobs:0};for(const name of DBS){const counts=checkDB(path.join(dir,name),name);for(const key of Object.keys(counts))summary[key]+=counts[key];}return summary;}
export async function inspectFullBackup({backup,passphrase,dataDir}){const payload=await decode(backup,passphrase),dir=await mkdtemp(path.join(os.tmpdir(),'pageposter-full-inspect-'));try{await materialize(payload,dir);return {summary:await summaryFor(payload,dir),canRestore:dataDir?await canRestoreFullBackup(dataDir):true};}finally{await rm(dir,{recursive:true,force:true});}}
function prepareRestoredDatabase(dir,oldKey,newKey){
 const oldBox=createSecretBox(oldKey),newBox=createSecretBox(newKey),db=new DatabaseSync(path.join(dir,'pageposter.sqlite')),runs=new DatabaseSync(path.join(dir,'generation-runs.sqlite'));
 try{db.exec('PRAGMA trusted_schema=OFF;BEGIN IMMEDIATE');runs.exec('PRAGMA trusted_schema=OFF;BEGIN IMMEDIATE');
 // Policy HMAC inputs are intentionally not stored. Preserve private policy refs
 // and their key identity on restore; the evaluator fails closed on a new key.
 const frozenJobs=new Map(db.prepare("SELECT id,revision FROM jobs WHERE state='queued' OR (state='running' AND effect!='write')").all().map(row=>[row.id,row.revision+1]));
 const frozenRuns=new Map(runs.prepare("SELECT id,revision FROM generation_runs WHERE state='queued'").all().map(row=>[row.id,row.revision+1]));
 for(const row of db.prepare('SELECT site_id,envelope FROM site_credentials').all()){const siteRow=db.prepare('SELECT data FROM sites WHERE id=?').get(row.site_id),site=siteRow?JSON.parse(siteRow.data):null;db.prepare('UPDATE site_credentials SET envelope=? WHERE site_id=?').run(JSON.stringify(rekeySiteCredential(oldBox,newBox,row.site_id,JSON.parse(row.envelope),site)),row.site_id);}
 for(const row of db.prepare('SELECT id,data FROM sites').all()){const value=JSON.parse(row.data);value.enabled=false;value.bootstrap={...value.bootstrap,restored:true};db.prepare('UPDATE sites SET enabled=0,data=? WHERE id=?').run(JSON.stringify(value),row.id);}
 for(const row of db.prepare("SELECT id,data FROM workspace_records WHERE kind='autopilot'").all()){
  const value=JSON.parse(row.data);for(const [field,identity] of [['candidateCredential',row.id],['alternateCredential',row.id+':alternate'],['apiCredential',row.id+':api'],['manualCredential',row.id+':manual']])if(value[field])value[field]=newBox.encrypt(identity,oldBox.decrypt(identity,value[field]));
  value.leaseToken=null;value.leaseOwner=null;value.leaseUntil=null;if(['queued','running','publishing','checking','waiting_source'].includes(value.state)){value.state='paused';value.error={code:'RESTORED_PAUSED',message:'Запуск відновлено з резервної копії. Продовжіть його вручну.'};value.revision++;}
  db.prepare('UPDATE workspace_records SET data=? WHERE id=?').run(JSON.stringify(value),row.id);
 }
 const trashActions=db.prepare("SELECT id,data FROM workspace_records WHERE kind='published_trash'").all();
 const updateRecord=db.prepare('UPDATE workspace_records SET data=? WHERE id=?');
 for(const row of trashActions){
  const action=JSON.parse(row.data);if(!['queued','running'].includes(action.state))continue;
  action.state=action.phase==='prepared'?'failed':'uncertain';
  action.errorCode='RESTORED_PAUSED';action.revision++;
  updateRecord.run(JSON.stringify(action),row.id);
 }
 const turnRow=db.prepare("SELECT id,data FROM workspace_records WHERE id='publication-turn:global' AND kind='publication_turn'").get();
 if(turnRow){
  const turn=JSON.parse(turnRow.data);
  if(!turn.releasedAt&&trashActions.some(action=>action.id===turn.runId||action.id===turn.trashRunId)){
   if(turn.trashRunId)turn.trashRunId=null;
   else{turn.releasedAt=new Date().toISOString();turn.releaseReason='trash_restored';}
   turn.revision++;
   updateRecord.run(JSON.stringify(turn),turnRow.id);
  }
 }
 // Evidence remains in check history, but the restored environment needs a fresh check.
 for(const row of db.prepare("SELECT id,data FROM workspace_records WHERE kind='project_queue_control'").all()){const value=JSON.parse(row.data);value.paused=true;value.revision++;db.prepare('UPDATE workspace_records SET data=? WHERE id=?').run(JSON.stringify(value),row.id);}
 for(const row of db.prepare("SELECT id,data FROM workspace_records WHERE kind='verification'").all()){const value=JSON.parse(row.data);value.summary={...value.summary,state:'pending',checkedRevision:null,summary:'Після відновлення потрібна нова перевірка.'};value.revision++;db.prepare('UPDATE workspace_records SET data=? WHERE id=?').run(JSON.stringify(value),row.id);}
 for(const row of db.prepare('SELECT id,data FROM campaigns').all()){
  const value=JSON.parse(row.data);let active=false;
  for(const item of value.items){
   const run=runs.prepare('SELECT state FROM generation_runs WHERE id=?').get(item.runId),receipt=db.prepare('SELECT data FROM generation_receipts WHERE id=?').get(item.runId),jobId=receipt?JSON.parse(receipt.data).jobId:null,job=jobId?db.prepare('SELECT state FROM jobs WHERE id=?').get(jobId):null;
   const state=job?.state||run?.state||item.state;if(['queued','running','paused','uncertain'].includes(state))active=true;
   if(frozenRuns.has(item.runId))item.pausedRunRevision=frozenRuns.get(item.runId);
   if(frozenJobs.has(jobId))item.pausedJobRevision=frozenJobs.get(jobId);
  }
  if(active)value.state='paused';
  db.prepare('UPDATE campaigns SET data=? WHERE id=?').run(JSON.stringify(value),row.id);
 }
 db.exec("UPDATE jobs SET state=CASE WHEN state='running' AND effect='write' THEN 'uncertain' ELSE 'paused' END,worker_id=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1 WHERE state IN ('queued','running');COMMIT;PRAGMA wal_checkpoint(TRUNCATE);");
 runs.exec("UPDATE generation_runs SET state=CASE WHEN state='running' THEN 'uncertain' ELSE 'paused' END,worker_id=NULL,lease_token=NULL,lease_until=NULL,revision=revision+1 WHERE state IN ('queued','running');COMMIT;PRAGMA wal_checkpoint(TRUNCATE);");
 }catch(e){try{db.exec('ROLLBACK');}catch{}try{runs.exec('ROLLBACK');}catch{}throw e;}finally{db.close();runs.close();}
 const budget=new DatabaseSync(path.join(dir,'ai-budget.sqlite'));try{budget.exec("PRAGMA trusted_schema=OFF;UPDATE ai_requests SET state='uncertain',error_code='AI_RESULT_UNCERTAIN' WHERE state='reserved';PRAGMA wal_checkpoint(TRUNCATE);");}finally{budget.close();}
}
/** Caller must quiesce/close runtime database handles before restore. Export requires a quiescent runtime. */
export async function restoreFullBackup({dataDir,masterKey,backup,passphrase}){
 const absolute=path.resolve(dataDir);if(absolute===path.parse(absolute).root)fail('BACKUP_INVALID');if(!await canRestoreFullBackup(absolute))fail('RESTORE_NOT_EMPTY');createSecretBox(masterKey);
 const payload=await decode(backup,passphrase),parent=path.dirname(absolute);await mkdir(parent,{recursive:true});const staging=await mkdtemp(path.join(parent,'.pageposter-restore-'));let previous=null,swapped=false;
 try{await materialize(payload,staging);const summary=await summaryFor(payload,staging);prepareRestoredDatabase(staging,payload.masterKey,masterKey);for(const [name,identity] of [['openai-key.json','pageposter:openai:v1'],['autopilot-source.json','pageposter:source:v1'],['google-oauth.json','pageposter:google-oauth:v1'],['proxy-settings.json','pageposter:proxies:v1']]){const keyFile=path.join(staging,name),secret=await readOptional(keyFile);if(secret){const credentials=createSecretBox(payload.masterKey).decrypt(identity,JSON.parse(secret.toString('utf8')));await writeFile(keyFile,JSON.stringify(createSecretBox(masterKey).encrypt(identity,credentials)),{mode:0o600});}}
 if(!await canRestoreFullBackup(absolute))fail('RESTORE_NOT_EMPTY');try{const current=await lstat(absolute);if(!current.isDirectory()||current.isSymbolicLink())fail('BACKUP_INVALID');previous=absolute+'.empty-before-restore-'+randomBytes(6).toString('hex');await rename(absolute,previous);}catch(e){if(e.code!=='ENOENT')throw e;}
 await rename(staging,absolute);swapped=true;return {restored:true,restartRequired:true,summary};
 }catch(e){if(previous&&!swapped){try{await rename(previous,absolute);}catch{}}throw e;}finally{if(!swapped)await rm(staging,{recursive:true,force:true});}
}
