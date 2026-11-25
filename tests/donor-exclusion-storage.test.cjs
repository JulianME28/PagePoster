'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const key=Buffer.alloc(32,71).toString('base64'),otherKey=Buffer.alloc(32,72).toString('base64'),passphrase='private donor policy recovery';
const observedAt='2026-11-03T12:00:00.000Z';
const policy=()=>({format:1,type:'authentication',originAliases:['https://donor.example'],observedAt,expiresAt:'2026-11-04T12:00:00.000Z',sourceRef:'private-source-hmac-71',credentialRef:'private-credential-hmac-71',keyRef:'private-key-hmac-71',runId:'originating-run',proof:{loginRejectedBeforeWrites:true}});
test.beforeEach(t=>{t.mock.method(globalThis,'fetch',()=>assert.fail('Policy storage and recovery must not perform remote requests.'));});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-donor-policy-')),stores=[];
 const {createStore}=await import('../server/lifecycle/store.mjs');
 let current=Date.parse(observedAt);
 const open=(filename=path.join(dir,'pageposter.sqlite'),masterKey=key)=>{const store=createStore({filename,masterKey,clock:()=>current});stores.push(store);return store;};
 t.after(()=>{for(const store of stores)store.close();const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^pp-donor-policy-/);fs.rmSync(resolved,{recursive:true,force:true});});
 return {dir,open,track:handle=>stores.push(handle),advance:ms=>current+=ms};
}

test('schema v5 migrates to projectless private policy storage without changing existing project records',async t=>{
 const f=await fixture(t),filename=path.join(f.dir,'legacy.sqlite'),raw=new DatabaseSync(filename);
 const project={id:'legacy-project',name:'Legacy',revision:1,createdAt:observedAt,updatedAt:observedAt},record={id:'legacy-run',projectId:project.id,kind:'autopilot',revision:1,state:'paused'};
 raw.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE workspace_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,data TEXT NOT NULL);PRAGMA user_version=5;');
 raw.prepare('INSERT INTO projects VALUES(?,?)').run(project.id,JSON.stringify(project));raw.prepare('INSERT INTO workspace_records VALUES(?,?,?,?)').run(record.id,project.id,record.kind,JSON.stringify(record));raw.close();
 const store=f.open(filename),inspection=new DatabaseSync(filename,{readOnly:true});
 try{assert.equal(inspection.prepare('PRAGMA user_version').get().user_version,6);assert.deepEqual(inspection.prepare('PRAGMA table_info(workspace_policy_records)').all().map(x=>[x.name,x.type,x.pk,x.notnull]),[['id','TEXT',1,0],['kind','TEXT',0,1],['data','TEXT',0,1]]);assert.equal(inspection.prepare('PRAGMA foreign_key_list(workspace_policy_records)').all().length,0);}finally{inspection.close();}
 assert.equal(store.getProject(project.id).name,'Legacy');assert.deepEqual(store.getRecord(record.id),record);assert.deepEqual(store.listPolicyRecords('donor_exclusion'),[]);
});

test('workspace policy exists without a project and survives project deletion and restart',async t=>{
 const f=await fixture(t),filename=path.join(f.dir,'pageposter.sqlite'),store=f.open(filename);
 const record=store.createPolicyRecord('donor_exclusion',policy(),'policy-global');
 assert.equal(record.id,'policy-global');assert.equal(record.kind,'donor_exclusion');assert.equal(record.projectId,undefined);assert.equal(record.revision,1);assert.equal(record.createdAt,observedAt);assert.equal(record.updatedAt,observedAt);assert.deepEqual(store.listProjects(),[]);
 const project=store.createProject({name:'Temporary project'});store.pruneChecks(project.id,1);
 const raw=new DatabaseSync(filename);raw.prepare('DELETE FROM projects WHERE id=?').run(project.id);raw.close();store.close();
 const reopened=f.open(filename);assert.deepEqual(reopened.listProjects(),[]);assert.deepEqual(reopened.getPolicyRecord(record.id),record);assert.deepEqual(reopened.listPolicyRecords('donor_exclusion'),[record]);assert.equal(reopened.getRecord(record.id),null);assert.equal(reopened.getPolicyRecord('absent'),null);
});

test('policy revisions reject stale writes and preserve immutable metadata',async t=>{
 const f=await fixture(t),store=f.open(),record=store.createPolicyRecord('donor_exclusion',policy());
 f.advance(1000);const changed=store.updatePolicyRecord(record.id,{releasedAt:'2026-11-03T12:00:01.000Z'},record.revision);
 assert.equal(changed.revision,2);assert.equal(changed.createdAt,observedAt);assert.equal(changed.updatedAt,'2026-11-03T12:00:01.000Z');assert.equal(changed.id,record.id);assert.equal(changed.kind,record.kind);assert.equal(changed.sourceRef,record.sourceRef);
 assert.throws(()=>store.updatePolicyRecord(record.id,{releasedAt:null},1),{code:'CONFLICT'});assert.throws(()=>store.updatePolicyRecord(record.id,{},undefined),{code:'VALIDATION'});assert.throws(()=>store.updatePolicyRecord('absent',{},1),{code:'NOT_FOUND'});
 for(const field of ['id','projectId','kind','revision','createdAt','updatedAt']){
  assert.throws(()=>store.createPolicyRecord('donor_exclusion',{[field]:'forged'}),{code:'VALIDATION'},'create '+field);
  assert.throws(()=>store.updatePolicyRecord(record.id,{[field]:'forged'},2),{code:'VALIDATION'},'update '+field);
 }
 assert.deepEqual(store.getPolicyRecord(record.id),changed);assert.throws(()=>store.createPolicyRecord('unreviewed_policy',{}),{code:'VALIDATION'});assert.throws(()=>store.listPolicyRecords('unreviewed_policy'),{code:'VALIDATION'});assert.throws(()=>store.createPolicyRecord('donor_exclusion',{value:NaN}),{code:'VALIDATION'});assert.throws(()=>store.updatePolicyRecord(record.id,{value:NaN},2),{code:'VALIDATION'});
});

test('policy creation and revision changes participate in nested atomic rollback and read snapshots',async t=>{
 const f=await fixture(t),store=f.open(),record=store.createPolicyRecord('donor_exclusion',policy(),'existing');
 assert.throws(()=>store.atomic(()=>{store.updatePolicyRecord(record.id,{releasedAt:observedAt},1);store.atomic(()=>{store.createPolicyRecord('donor_exclusion',policy(),'rolled-back');});throw Error('rollback policy and checkpoint');}),/rollback policy and checkpoint/);
 assert.deepEqual(store.getPolicyRecord(record.id),record);assert.equal(store.getPolicyRecord('rolled-back'),null);
 assert.throws(()=>store.readSnapshot(()=>store.createPolicyRecord('donor_exclusion',policy())),{code:'READ_ONLY_SNAPSHOT'});assert.throws(()=>store.readSnapshot(()=>store.updatePolicyRecord(record.id,{releasedAt:observedAt},1)),{code:'READ_ONLY_SNAPSHOT'});assert.equal(store.getPolicyRecord(record.id).revision,1);
});

test('public lifecycle backups omit private policy payloads and refuse to overwrite a policy-only workspace',async t=>{
 const f=await fixture(t),store=f.open(),record=store.createPolicyRecord('donor_exclusion',policy(),'private-policy-id');
 const backup=store.exportBackup();assert.doesNotMatch(JSON.stringify(backup),/workspace_policy|donor_exclusion|private-policy-id|private-source-hmac|private-credential-hmac|private-key-hmac/);assert.deepEqual(backup.projects,[]);
 const source=f.open(path.join(f.dir,'public-source.sqlite')),publicBackup=source.exportBackup();assert.throws(()=>store.restoreBackup(publicBackup),{code:'RESTORE_NOT_EMPTY'});assert.deepEqual(store.getPolicyRecord(record.id),record);
});

test('encrypted full recovery preserves private policies under the same and a different master key',async t=>{
 const f=await fixture(t),source=path.join(f.dir,'source');fs.mkdirSync(source);const store=f.open(path.join(source,'pageposter.sqlite')),record=store.createPolicyRecord('donor_exclusion',policy(),'full-private-policy');
 const {createRunStore}=await import('../server/lifecycle/run-store.mjs'),{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs'),recovery=await import('../server/lifecycle/full-recovery.mjs');
 const runs=createRunStore({filename:path.join(source,'generation-runs.sqlite')}),budget=createAIBudget({filename:path.join(source,'ai-budget.sqlite')});f.track(runs);f.track(budget);
 const backup=await recovery.exportFullBackup({dataDir:source,masterKey:key,passphrase});assert.doesNotMatch(JSON.stringify(backup),/full-private-policy|private-source-hmac|private-credential-hmac|private-key-hmac|donor\.example/);
 const inspection=await recovery.inspectFullBackup({backup,passphrase});assert.equal(inspection.summary.projects,0);assert.doesNotMatch(JSON.stringify(inspection),/private-source-hmac|private-credential-hmac|private-key-hmac/);
 for(const [name,masterKey] of [['same-key',key],['new-key',otherKey]]){
  const destination=path.join(f.dir,name);await recovery.restoreFullBackup({dataDir:destination,masterKey,backup,passphrase});const restored=f.open(path.join(destination,'pageposter.sqlite'),masterKey);
  assert.deepEqual(restored.getPolicyRecord(record.id),record);assert.deepEqual(restored.listProjects(),[]);assert.equal(await recovery.canRestoreFullBackup(destination),false);assert.doesNotMatch(JSON.stringify(restored.exportBackup()),/private-source-hmac|private-credential-hmac|private-key-hmac|full-private-policy/);
 }
 assert.equal(await recovery.canRestoreFullBackup(source),false);await assert.rejects(recovery.restoreFullBackup({dataDir:source,masterKey:key,backup,passphrase}),{code:'RESTORE_NOT_EMPTY'});
});
