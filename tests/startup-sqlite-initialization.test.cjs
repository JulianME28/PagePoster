'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pp-startup-schema-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'fixture.sqlite');}
const schema=db=>db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row=>({...row}));

test('a late run schema migration failure rolls back all newly created schema objects',async t=>{
 const {createRunStore}=await import('../server/lifecycle/run-store.mjs'),filename=temporary(t);
 let db=new DatabaseSync(filename);db.exec("PRAGMA application_id=1347441237; PRAGMA user_version=1; CREATE TABLE generation_runs(id TEXT PRIMARY KEY,project_id TEXT,state TEXT,retry_count INTEGER GENERATED ALWAYS AS (0) VIRTUAL);INSERT INTO generation_runs(id,project_id,state) VALUES('keep','project','queued');");
 const original=schema(db);db.close();assert.throws(()=>createRunStore({filename}),/duplicate column name: retry_count/);
 db=new DatabaseSync(filename);try{assert.deepEqual(schema(db),original,'failure must not leave partial tables or indexes committed');assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(db.prepare('SELECT id FROM generation_runs').get().id,'keep');}finally{db.close();}
});

test('a late AI migration failure rolls back earlier ALTER and index creation',async t=>{
 const {createAIBudget}=await import('../server/lifecycle/ai-budget.mjs'),filename=temporary(t);
 let db=new DatabaseSync(filename);db.exec("PRAGMA user_version=1; CREATE TABLE ai_requests(request_id TEXT PRIMARY KEY,month TEXT,retry_authorized INTEGER GENERATED ALWAYS AS (0) VIRTUAL); INSERT INTO ai_requests(request_id,month) VALUES('keep','2026-11');");
 const original=schema(db);db.close();assert.throws(()=>createAIBudget({filename}),/duplicate column name: retry_authorized/);
 db=new DatabaseSync(filename);try{assert.deepEqual(schema(db),original,'failure must roll back the added retry_count and index');assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(db.prepare('SELECT request_id FROM ai_requests').get().request_id,'keep');}finally{db.close();}
});

for(const [name,moduleName,exportName] of [['runs','run-store','createRunStore'],['budget','ai-budget','createAIBudget']])test('opening an unchanged '+name+' schema preserves WAL frames and full durability',async t=>{
 const create=(await import('../server/lifecycle/'+moduleName+'.mjs'))[exportName],filename=temporary(t);
 const first=create({filename}),observer=new DatabaseSync(filename);observer.prepare('SELECT COUNT(*) FROM sqlite_schema').get();first.close();
 try{const before=fs.readFileSync(filename+'-wal');const reopened=create({filename});reopened.close();
 assert.equal(fs.readFileSync(filename+'-wal').equals(before),true,'warm schema validation must not write redundant version records');
 assert.equal(observer.prepare('PRAGMA journal_mode').get().journal_mode,'wal');assert.equal(observer.prepare('PRAGMA synchronous').get().synchronous,2);
 assert.equal(observer.prepare('PRAGMA user_version').get().user_version,2);assert.equal(observer.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{observer.close();}
});

test('a version-one run upgrade preserves the uncertain checkpoint and initializes retry count',async t=>{
 const {createRunStore}=await import('../server/lifecycle/run-store.mjs'),filename=temporary(t);
 let store=createRunStore({filename});const run=store.createRun({projectId:'project',idempotencyKey:'fixture',spec:{pageId:'page',sourceRevision:1,siteId:null,status:'review',brief:{},generation:{},batches:[]}}),lease=store.claimRun({workerId:'worker'});
 store.transition(run.id,{leaseToken:lease.leaseToken,state:'uncertain',stage:'publication',result:{requestId:'kept'},error:{code:'WRITE_UNKNOWN'}});store.close();
 const db=new DatabaseSync(filename);db.exec('ALTER TABLE generation_runs DROP COLUMN retry_count; PRAGMA user_version=1;');db.close();
 store=createRunStore({filename});try{const restored=store.getRun(run.id);assert.equal(restored.state,'uncertain');assert.equal(restored.stage,'publication');assert.deepEqual(restored.result,{requestId:'kept'});assert.equal(restored.retryCount,0);assert.equal(store.claimRun({workerId:'other'}),null);}finally{store.close();}
});

test('a version-one AI upgrade preserves the unknown reservation without dispatch',async t=>{
 const {createAIBudget}=await import('../server/lifecycle/ai-budget.mjs'),filename=temporary(t),request={model:'gpt-5.4-mini',store:false,instructions:'Fixture',input:'Synthetic brief',max_output_tokens:100};
 let store=createAIBudget({filename});const receipt=store.reserve({requestId:'fixture',request});store.uncertain('fixture',receipt.reservationToken,{code:'NETWORK_ERROR'});const reserved=store.status().reservedTokens;store.close();
 const db=new DatabaseSync(filename);db.exec('ALTER TABLE ai_requests DROP COLUMN retry_count; ALTER TABLE ai_requests DROP COLUMN retry_authorized; PRAGMA user_version=1;');db.close();
 store=createAIBudget({filename});try{const restored=store.reserve({requestId:'fixture',request});assert.equal(restored.dispatch,false);assert.equal(restored.state,'uncertain');assert.equal(store.status().reservedTokens,reserved);}finally{store.close();}
});

for(const [name,moduleName,exportName,index] of [['runs','run-store','createRunStore','generation_project'],['budget','ai-budget','createAIBudget','ai_request_month']])test('current-version '+name+' still validates and restores required schema objects',async t=>{
 const create=(await import('../server/lifecycle/'+moduleName+'.mjs'))[exportName],filename=temporary(t);create({filename}).close();
 let db=new DatabaseSync(filename);db.exec('DROP INDEX '+index);db.close();create({filename}).close();
 db=new DatabaseSync(filename);try{assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name=?").get(index).name,index);assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);}finally{db.close();}
});
