'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const KEY=Buffer.alloc(32,81).toString('base64'),START=Date.UTC(2026,10,3),MINUTE=60000,DAY=86400000;
const origin='https://policy-fixture.example',primary={username:'PRIVATE_USER',applicationPassword:'PRIVATE_PASSWORD'},alternate={username:'PRIVATE_ALT',password:'PRIVATE_ALT_PASSWORD'};
const source={spreadsheetId:'PRIVATE_SHEET',sheetId:7,range:"'Donors'!A2:O100",columns:{url:'A',username:'B',password:'C'},headerRows:1,authMode:'user',readerPrincipal:'PRIVATE_READER'};
function memoryStore(){const rows=new Map();return {rows,atomic(fn){const snapshot=structuredClone(rows);try{return fn();}catch(error){rows.clear();for(const [id,row] of snapshot)rows.set(id,row);throw error;}},createPolicyRecord(kind,input,id=crypto.randomUUID()){if(rows.has(id))throw Object.assign(Error('Conflict'),{code:'CONFLICT'});const row={...structuredClone(input),id,kind,revision:1};rows.set(id,row);return structuredClone(row);},getPolicyRecord(id){return structuredClone(rows.get(id)||null);},listPolicyRecords(kind){return [...rows.values()].filter(row=>row.kind===kind).map(row=>structuredClone(row));},updatePolicyRecord(id,patch,revision){const previous=rows.get(id);if(!previous||previous.revision!==revision)throw Object.assign(Error('Conflict'),{code:'CONFLICT'});const row={...previous,...structuredClone(patch),revision:revision+1};rows.set(id,row);return structuredClone(row);}};}
const resources=[];test.after(()=>{for(const resource of resources)resource();});
async function fixture({runs=[],store}={}){const {createDonorExclusions}=await import('../server/lifecycle/donor-exclusions.mjs');let now=START,key=KEY,policy,filename,createStore;
 if(!store){({createStore}=await import('../server/lifecycle/store.mjs'));const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pp-donor-policy-'));filename=path.join(directory,'pageposter.sqlite');store=createStore({filename,masterKey:key,clock:()=>START});resources.push(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});}
 const reopen=()=>policy=createDonorExclusions({store,masterKey:key,clock:()=>now,allRuns:()=>runs});reopen();return {get store(){return store;},runs,get policy(){return policy;},time(value){now=value;},restart(newKey=key){key=newKey;if(filename){store.close();store=createStore({filename,masterKey:key,clock:()=>START});}reopen();},observe(extra={}){return policy.observe({runId:'attempt-one',origin,sourceIdentity:source,credentials:primary,...extra});},evaluate(extra={}){return policy.evaluate({runId:'attempt-two',origin,sourceIdentity:source,credentials:[primary,alternate],materialHash:'exact-material',...extra});}};}
test('pre-page transient cooldown has a fixed exact boundary and current run never cycles',async()=>{
 const f=await fixture(),record=f.observe({code:'network_timeout',proof:{prePage:true}});assert.equal(record.type,'transient');assert.equal(record.expiresAt,new Date(START+15*MINUTE).toISOString());
 f.time(START+15*MINUTE-1);assert.equal(f.evaluate().blocked,true);assert.equal(f.policy.listPublic().rows[0].expiresAt,record.expiresAt);
 f.time(START+15*MINUTE);assert.equal(f.evaluate().blocked,false);assert.equal(f.evaluate({runId:'attempt-one'}).blocked,true);f.restart();assert.equal(f.evaluate({runId:'attempt-one'}).blocked,true);
});
test('all five proven pre-page failures expire while missing proof, unsafe and unknown failures stay conservative',async()=>{
 for(const code of ['dns_failed','network_failed','network_timeout','BROWSER_TIMEOUT','BROWSER_PAGE_UNAVAILABLE']){const f=await fixture();f.observe({code,proof:{prePage:true}});f.time(START+DAY);assert.equal(f.evaluate().blocked,false,code);}
 for(const input of [{code:'network_timeout'},{code:'URL_BLOCKED',proof:{prePage:true}},{code:'PRIVATE_PROVIDER_SECRET'}]){const f=await fixture();assert.equal(f.observe(input).type,'security');f.time(START+DAY*100);assert.equal(f.evaluate().blocked,true);assert.equal(f.evaluate({mode:'manual',all:1}).blocked,true);}
});
test('auth suppresses only the exact failed source and credential pair, retaining an alternate',async()=>{
 const f=await fixture();const row=f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});assert.equal(row.type,'auth');let decision=f.evaluate();assert.equal(decision.blocked,false);assert.deepEqual(decision.allowedCredentials,[alternate]);
 assert.equal(f.evaluate({credentials:[primary]}).blocked,true);assert.equal(f.evaluate({credentials:[{...primary,applicationPassword:'CHANGED'}]}).blocked,false);
 for(const change of [{readerPrincipal:'other'},{sheetId:8},{range:"'Donors'!A2:O101"},{columns:{...source.columns,password:'D'}},{headerRows:2},{authMode:'service'},{spreadsheetId:'other'}])assert.equal(f.evaluate({sourceIdentity:{...source,...change},credentials:[primary]}).blocked,false,JSON.stringify(change));
 const reordered={readerPrincipal:source.readerPrincipal,accessToken:'PRIVATE_ROTATED_TOKEN',columns:{password:'C',url:'A',username:'B'},range:source.range,authMode:source.authMode,headerRows:1,sheetId:7,spreadsheetId:source.spreadsheetId};assert.equal(f.evaluate({sourceIdentity:reordered,credentials:[primary]}).blocked,true);
 f.time(START+DAY);assert.equal(f.evaluate({credentials:[primary]}).blocked,false);
});
test('both failed accounts are independently suppressed and identical pairs deduplicate',async()=>{
 const f=await fixture();f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});f.observe({code:'bootstrap_auth_failed',credentials:alternate,proof:{loginRejectedBeforeWrites:true}});assert.equal(f.evaluate().blocked,true);
 const g=await fixture();assert.equal(g.evaluate({credentials:[primary,{...primary}]}).allowedCredentials.length,1);
});
test('plugin capability restrictions remain advisory, and visual rejection requires exact owned Trash',async()=>{
 const f=await fixture();f.observe({code:'CLEAN_LINKS_FILESYSTEM_REQUIRED',proof:{cleanLinksRestricted:true}});assert.equal(f.evaluate().blocked,false);assert.equal(f.evaluate().advisories.length,1);f.time(START+DAY);assert.equal(f.evaluate().advisories.length,0);
 const g=await fixture();const row=g.observe({code:'NATIVE_VISUAL_REJECTED',materialHash:'exact-material',proof:{ownedTrashConfirmed:true}});assert.equal(row.type,'visual');assert.equal(g.evaluate().blocked,true);assert.equal(g.evaluate({materialHash:'different'}).blocked,false);g.time(START+DAY);assert.equal(g.evaluate().blocked,false);
 const h=await fixture();h.observe({code:'NATIVE_VISUAL_REJECTED',materialHash:'exact-material'});h.time(START+DAY*2);assert.equal(h.evaluate({materialHash:'different'}).blocked,true);
});
test('requested and canonical origin aliases share typed restrictions',async()=>{
 const f=await fixture();f.observe({code:'bootstrap_auth_failed',origins:['https://canonical-fixture.example/'],proof:{loginRejectedBeforeWrites:true}});assert.equal(f.evaluate({origin:'https://canonical-fixture.example',credentials:[primary]}).blocked,true);assert.equal(f.evaluate({origin:'https://other.example',credentials:[primary]}).blocked,false);
});
test('manual bans persist and explicit revision-bound release retains immutable observation',async()=>{
 const f=await fixture();const row=f.policy.setManualBan({origin,expectedRevision:0});assert.equal(row.type,'manual');assert.equal(f.evaluate({mode:'manual',all:1}).blocked,true);f.time(START+DAY*100);f.restart();assert.equal(f.evaluate().blocked,true);
 assert.throws(()=>f.policy.release({id:row.id,expectedRevision:0}),{code:'CONFLICT'});const released=f.policy.release({id:row.id,expectedRevision:row.revision});assert.equal(released.revision,row.revision+1);assert.ok(released.releasedAt);assert.equal(f.evaluate().blocked,false);assert.throws(()=>f.policy.release({id:row.id,expectedRevision:row.revision}),{code:'CONFLICT'});
 assert.equal(f.policy.listPublic({state:'released'}).total,1);assert.equal(f.policy.listPublic({state:'active'}).total,0);
});
test('manual choice may override historical retry restrictions with warnings but not same-run security',async()=>{
 for(const input of [{code:'network_timeout',proof:{prePage:true}},{code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}},{code:'NATIVE_VISUAL_REJECTED',materialHash:'exact-material',proof:{ownedTrashConfirmed:true}}]){const f=await fixture();f.observe(input);const decision=f.evaluate({credentials:[primary],mode:'manual'});assert.equal(decision.blocked,false);assert.equal(decision.warnings.length,1);}
 const f=await fixture();f.observe({code:'unsafe_url'});assert.equal(f.evaluate({mode:'manual'}).blocked,true);
});
test('invalid or future observation time, rollback and non-finite clock fail closed',async()=>{
 for(const at of ['not-time','2026-11-03T25:00:00.000Z','2026-11-04T00:00:00.000Z']){const f=await fixture();f.observe({code:'network_timeout',observedAt:at,proof:{prePage:true}});f.time(START+DAY*30);assert.equal(f.evaluate().blocked,true);}
 const f=await fixture();f.observe({code:'network_timeout',proof:{prePage:true}});for(const now of [START-1,NaN,Infinity]){f.time(now);assert.equal(f.evaluate().blocked,true);}
});
test('key rotation cannot silently make scoped restrictions eligible and public output explains review',async()=>{
 const f=await fixture();f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});const saved=f.store.listPolicyRecords('donor_exclusion');f.restart(Buffer.alloc(32,82).toString('base64'));assert.equal(f.evaluate().blocked,true);assert.equal(f.evaluate().reasons[0].reason,'Ключ захисту змінився. Перевірте донора перед повторним підбором.');assert.deepEqual(f.store.listPolicyRecords('donor_exclusion'),saved);
});
test('legacy valid past transient expires across runs, and missing/future/auth/visual/unknown entries remain conservative',async()=>{
 for(const code of ['dns_failed','network_failed','network_timeout','BROWSER_TIMEOUT','BROWSER_PAGE_UNAVAILABLE']){const f=await fixture({runs:[{id:'legacy-run',donorSkips:[{baseUrl:origin,code,at:new Date(START-15*MINUTE).toISOString()}]}]});assert.equal(f.evaluate().blocked,false);assert.equal(f.evaluate({runId:'legacy-run'}).blocked,true);}
 for(const skip of [{code:'bootstrap_auth_failed',at:new Date(START-DAY*3).toISOString()},{code:'NATIVE_VISUAL_REJECTED'},{code:'unknown'},{code:'network_timeout'},{code:'network_timeout',at:'invalid'},{code:'network_timeout',at:new Date(START+1).toISOString()}]){const f=await fixture({runs:[{id:'legacy-run',donorSkips:[{baseUrl:origin,...skip}]}]});assert.equal(f.evaluate().blocked,true);assert.equal(f.policy.listPublic().rows[0].legacy,true);}
});
test('linked typed observations never gain a second unscoped legacy ban',async()=>{
 const f=await fixture();const row=f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});f.runs.push({id:'attempt-one',donorSkips:[{baseUrl:origin,code:'bootstrap_auth_failed',at:new Date(START).toISOString(),policyId:row.id}]});assert.equal(f.evaluate({credentials:[alternate]}).blocked,false);assert.equal(f.policy.listPublic().total,1);assert.equal(f.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,true);
});
test('forged or mismatched typed links retain conservative legacy scope',async()=>{
 for(const mismatch of ['missing','run','origin','code']){const f=await fixture(),row=f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});f.runs.push({id:mismatch==='run'?'different-run':'attempt-one',donorSkips:[{baseUrl:mismatch==='origin'?'https://different.example':origin,code:mismatch==='code'?'NATIVE_VISUAL_REJECTED':'bootstrap_auth_failed',policyId:mismatch==='missing'?'missing':row.id}]});assert.equal(f.evaluate({origin:mismatch==='origin'?'https://different.example':origin,credentials:[alternate]}).blocked,true,mismatch);}
});
test('legacy virtual IDs are stable and explicit release materializes history without editing skips',async()=>{
 const runs=[{id:'legacy-run',donorSkips:[{baseUrl:origin,code:'bootstrap_auth_failed'}]}],original=JSON.stringify(runs),f=await fixture({runs});const row=f.policy.listPublic().rows[0];assert.equal(row.revision,0);f.restart();assert.equal(f.policy.listPublic().rows[0].id,row.id);assert.throws(()=>f.policy.release({id:row.id,expectedRevision:1}),{code:'CONFLICT'});f.policy.release({id:row.id,expectedRevision:0});assert.equal(f.evaluate().blocked,false);assert.equal(f.evaluate({runId:'legacy-run'}).blocked,true);assert.equal(JSON.stringify(runs),original);assert.equal(f.store.listPolicyRecords('donor_exclusion').length,1);
});
test('public pagination, state and search expose safe fields without private binding or payload',async()=>{
 const f=await fixture();f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true},providerPayload:'PRIVATE_PAYLOAD'});f.policy.setManualBan({origin:'https://second.example',expectedRevision:0});const page=f.policy.listPublic({search:'second',offset:0,limit:1,state:'active'});assert.equal(page.total,1);assert.equal(page.rows[0].origin,'https://second.example');assert.equal(f.policy.listPublic({offset:1,limit:1}).rows.length,1);
 const rows=f.store.listPolicyRecords('donor_exclusion'),saved=JSON.stringify(rows),publicJson=JSON.stringify(f.policy.listPublic());assert.doesNotMatch(saved,/PRIVATE_/);assert.doesNotMatch(publicJson,/PRIVATE_|sourceRef|credentialRef|materialRef|keyMarker|runId/);assert.ok(rows.some(row=>row.sourceRef));
});
test('manual ban revision races conflict and rebanning retains release history',async()=>{
 const f=await fixture(),first=f.policy.setManualBan({origin,expectedRevision:0});assert.throws(()=>f.policy.setManualBan({origin,expectedRevision:0}),{code:'CONFLICT'});const released=f.policy.release({id:first.id,expectedRevision:first.revision});const second=f.policy.setManualBan({origin,expectedRevision:released.revision});assert.equal(second.id,first.id);assert.equal(f.evaluate().blocked,true);assert.equal(f.store.getPolicyRecord(first.id).events.length,3);
});
test('public API items include reviewable active/release fields and safe human reasons',async()=>{
 const f=await fixture();f.observe({code:'network_timeout',proof:{prePage:true}});const row=f.policy.listPublic().items[0];assert.equal(row.active,true);assert.equal(row.canRelease,true);assert.equal(typeof row.reason,'string');f.time(START+15*MINUTE);const expired=f.policy.listPublic().items[0];assert.equal(expired.active,false);assert.equal(expired.canRelease,false);
});
test('public policy reasons and scope labels use precise Ukrainian wording',async()=>{
 const cases=[
  [{code:'network_timeout',proof:{prePage:true}},'Донор тимчасово недоступний.','домен'],
  [{code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}},'Дані для входу відхилено.','конкретне джерело й пара логін/пароль'],
  [{code:'CLEAN_LINKS_FILESYSTEM_REQUIRED',proof:{cleanLinksRestricted:true}},'Є обмеження Clean Links. Публікація без плагіна з перевіркою вигляду залишається доступною.','конкретне джерело й пара логін/пароль'],
  [{code:'NATIVE_VISUAL_REJECTED',materialHash:'exact-material',proof:{ownedTrashConfirmed:true}},'Підготовлений матеріал не пройшов перевірку вигляду.','конкретний матеріал і домен'],
  [{code:'unsafe_url'},'Обмеження донора потребує перевірки.','домен']
 ];
 for(const [input,reason,scope] of cases){const f=await fixture({store:memoryStore()}),row=f.observe(input);assert.deepEqual({reason:row.reason,scope:row.scope},{reason,scope});}
 const f=await fixture({store:memoryStore()}),manual=f.policy.setManualBan({origin,expectedRevision:0});assert.deepEqual({reason:manual.reason,scope:manual.scope},{reason:'Донор заборонений вручну.',scope:'домен у всіх проєктах'});
 const g=await fixture({store:memoryStore()});g.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});assert.equal(g.evaluate({credentials:[primary]}).reason,'Цю пару логін/пароль відхилено.');const current=g.evaluate({runId:'attempt-one'}).reasons[0];assert.deepEqual({reason:current.reason,scope:current.scope},{reason:'Донора вже спробували в цьому запуску.',scope:'поточний запуск'});
 const h=await fixture({store:memoryStore(),runs:[{id:'legacy-run',donorSkips:[{baseUrl:origin,code:'bootstrap_auth_failed'}]}]});assert.deepEqual({reason:h.evaluate().reason,scope:h.policy.listPublic().items[0].scope},{reason:'Попередня відмова донора потребує перевірки.',scope:'домен із попередньої відмови'});
});
test('malformed release metadata is not proof that a restriction was deliberately released',async()=>{
 const f=await fixture({store:memoryStore()}),row=f.observe({code:'network_timeout',proof:{prePage:true}});f.store.rows.get(row.id).releasedAt='invalid';assert.equal(f.evaluate().blocked,true);
});
test('missing private context cannot prove a changed source, account or material is eligible',async()=>{
 const f=await fixture();f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});assert.equal(f.evaluate({sourceIdentity:null,credentials:[primary]}).blocked,true);assert.equal(f.evaluate({credentials:[]}).blocked,true);
 const g=await fixture();g.observe({code:'NATIVE_VISUAL_REJECTED',materialHash:'exact-material',proof:{ownedTrashConfirmed:true}});assert.equal(g.evaluate({materialHash:null}).blocked,true);
});
test('release and read-only evaluation never remove current-run attempts or update fixed history',async()=>{
 const f=await fixture(),row=f.observe({code:'network_timeout',proof:{prePage:true}});const prior=f.store.getPolicyRecord(row.id);for(let i=0;i<10;i++)f.evaluate();assert.deepEqual(f.store.getPolicyRecord(row.id),prior);f.policy.release({id:row.id,expectedRevision:row.revision});f.restart();assert.equal(f.evaluate({runId:'attempt-one'}).blocked,true);assert.equal(f.evaluate().blocked,false);
});
test('full encrypted recovery preserves private references and same-key scope, and new keys require review',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-policy-recovery-')),src=path.join(dir,'source');fs.mkdirSync(src);
 const {createStore}=await import('../server/lifecycle/store.mjs'),{createRunStore}=await import('../server/lifecycle/run-store.mjs'),{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs'),{createDonorExclusions}=await import('../server/lifecycle/donor-exclusions.mjs'),{exportFullBackup,restoreFullBackup}=await import('../server/lifecycle/full-recovery.mjs');
 const store=createStore({filename:path.join(src,'pageposter.sqlite'),masterKey:KEY}),runs=createRunStore({filename:path.join(src,'generation-runs.sqlite')}),budget=createAIBudget({filename:path.join(src,'ai-budget.sqlite')});t.after(()=>{store.close();runs.close();budget.close();fs.rmSync(dir,{recursive:true,force:true});});
 const policy=createDonorExclusions({store,masterKey:KEY,clock:()=>START});policy.observe({runId:'recovery-run',origin,code:'bootstrap_auth_failed',sourceIdentity:source,credentials:primary,proof:{loginRejectedBeforeWrites:true}});policy.setManualBan({origin:'https://manual-recovery.example',expectedRevision:0});const original=store.listPolicyRecords('donor_exclusion'),backup=await exportFullBackup({dataDir:src,masterKey:KEY,passphrase:'fixture recovery password'});assert.doesNotMatch(JSON.stringify(backup),/PRIVATE_|sourceRef|credentialRefs|keyMarker/);
 for(const [label,key] of [['same',KEY],['rotated',Buffer.alloc(32,94).toString('base64')]]){const target=path.join(dir,label);await restoreFullBackup({dataDir:target,masterKey:key,backup,passphrase:'fixture recovery password'});const restored=createStore({filename:path.join(target,'pageposter.sqlite'),masterKey:key});try{assert.deepEqual(restored.listPolicyRecords('donor_exclusion'),original);const recovered=createDonorExclusions({store:restored,masterKey:key,clock:()=>START});const result=recovered.evaluate({origin,sourceIdentity:source,credentials:[alternate]});assert.equal(result.blocked,label==='rotated');assert.equal(recovered.evaluate({origin:'https://manual-recovery.example'}).blocked,true);if(label==='rotated')assert.equal(recovered.listPublic({search:'policy-fixture'}).items[0].reason,'Ключ захисту змінився. Перевірте донора перед повторним підбором.');}finally{restored.close();}}
});
test('unsupported record versions or damaged scoped proof never imply a new source or pair',async()=>{
 for(const [change,reason] of [[{format:2},'Непідтримуваний формат обмеження. Перевірте донора перед повторним підбором.'],[{sourceRef:'invalid'},'Відомості про відхилені дані для входу неповні. Перевірте донора перед повторним підбором.'],[{credentialRefs:{[origin]:'invalid'}},'Відомості про відхилені дані для входу неповні. Перевірте донора перед повторним підбором.'],[{proof:{}},'Підстави обмеження неповні. Перевірте донора перед повторним підбором.']]){const f=await fixture({store:memoryStore()}),row=f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});Object.assign(f.store.rows.get(row.id),change);assert.equal(f.evaluate({credentials:[alternate]}).blocked,true,JSON.stringify(change));assert.equal(f.policy.listPublic().items[0].reason,reason);}
});
test('current-run diagnostics cannot advertise a cooldown as the end of the run exclusion',async()=>{
 const f=await fixture();f.observe({code:'network_timeout',proof:{prePage:true}});assert.equal(f.evaluate({runId:'attempt-one'}).expiresAt,null);assert.equal(f.evaluate({runId:'attempt-one'}).reasons[0].type,'current_run');
});
test('operation snapshot stays read-only and stale policy never replaces live admission evaluation',async()=>{
 const f=await fixture(),snapshot=f.policy.snapshot();assert.equal(snapshot.evaluate({origin,credentials:[primary]}).blocked,false);f.policy.setManualBan({origin,expectedRevision:0});assert.equal(snapshot.evaluate({origin,credentials:[primary]}).blocked,false);assert.equal(f.evaluate().blocked,true);
});
test('one operation snapshot reads policy and run history once for a thousand candidate evaluations',async()=>{
 const {createDonorExclusions}=await import('../server/lifecycle/donor-exclusions.mjs'),store=memoryStore();let reads=0,runs=0;const list=store.listPolicyRecords;store.listPolicyRecords=kind=>{reads++;return list.call(store,kind);};const policy=createDonorExclusions({store,masterKey:KEY,clock:()=>START,allRuns:()=>{runs++;return [{id:'past-run',donorSkips:[{baseUrl:origin,code:'bootstrap_auth_failed'}]}];}}),snapshot=policy.snapshot();for(let n=0;n<1000;n++)assert.equal(snapshot.evaluate({origin:'https://donor-'+n+'.example',credentials:[primary]}).blocked,false);assert.equal(reads,1);assert.equal(runs,1);
});
test('snapshot preserves credential/material/current-run scopes and fixes time for the operation',async()=>{
 const f=await fixture();f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});const snapshot=f.policy.snapshot();assert.deepEqual(snapshot.evaluate({runId:'other',origin,sourceIdentity:source,credentials:[primary,alternate]}).allowedCredentials,[alternate]);assert.equal(snapshot.evaluate({runId:'attempt-one',origin,sourceIdentity:source,credentials:[alternate]}).blocked,true);f.time(START+DAY);assert.equal(snapshot.evaluate({runId:'other',origin,sourceIdentity:source,credentials:[primary]}).blocked,true);assert.equal(f.evaluate({credentials:[primary]}).blocked,false);
 const g=await fixture();g.observe({code:'NATIVE_VISUAL_REJECTED',materialHash:'same',proof:{ownedTrashConfirmed:true}});const visual=g.policy.snapshot();assert.equal(visual.evaluate({origin,materialHash:'same'}).blocked,true);assert.equal(visual.evaluate({origin,materialHash:'other'}).blocked,false);
});
test('public key mismatches and damaged proof require review without suggesting expiry or plugin advice',async()=>{
 const f=await fixture();f.observe({code:'CLEAN_LINKS_FILESYSTEM_REQUIRED',proof:{cleanLinksRestricted:true}});f.time(START+DAY*2);f.restart(Buffer.alloc(32,95).toString('base64'));const row=f.policy.listPublic().items[0];assert.equal(row.active,true);assert.equal(row.state,'active');assert.equal(row.expiresAt,null);assert.equal(row.requiresReview,true);assert.equal(f.evaluate().advisories.length,0);
 const g=await fixture({store:memoryStore()}),observed=g.observe({code:'network_timeout',proof:{prePage:true}});g.store.rows.get(observed.id).proof={};g.time(START+DAY*2);const broken=g.policy.listPublic().items[0];assert.equal(broken.requiresReview,true);assert.equal(broken.expiresAt,null);assert.equal(broken.active,true);
});
test('snapshot exposes safe restriction metadata without requiring a prepared render',async()=>{
 const f=await fixture();assert.equal(f.policy.snapshot().hasRestrictions,false);assert.equal(f.policy.snapshot().hasMaterialRestrictions,false);f.policy.setManualBan({origin,expectedRevision:0});assert.equal(f.policy.snapshot().hasRestrictions,true);assert.equal(f.policy.snapshot().hasMaterialRestrictions,false);
 const g=await fixture();g.observe({code:'NATIVE_VISUAL_REJECTED',materialHash:'exact',proof:{ownedTrashConfirmed:true}});assert.equal(g.policy.snapshot().hasRestrictions,true);assert.equal(g.policy.snapshot().hasMaterialRestrictions,true);
 const h=await fixture({runs:[{id:'legacy-run',donorSkips:[{baseUrl:origin,code:'network_timeout',at:new Date(START-DAY).toISOString()}]}]});assert.equal(h.policy.snapshot().hasRestrictions,true);assert.equal(h.policy.snapshot().hasMaterialRestrictions,false);
});
test('a proven auth trial suppresses its failed pair without retiring the good backup from the same run',async()=>{
 const f=await fixture(),row=f.observe({code:'bootstrap_auth_failed',retired:false,proof:{loginRejectedBeforeWrites:true}});assert.equal(f.store.getPolicyRecord(row.id).retired,false);assert.equal(f.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,false);assert.equal(f.evaluate({runId:'attempt-one',credentials:[primary]}).blocked,true);assert.deepEqual(f.evaluate({runId:'attempt-one'}).allowedCredentials,[alternate]);assert.equal(f.evaluate({credentials:[primary]}).blocked,true);f.restart();assert.equal(f.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,false);
 f.runs.push({id:'attempt-one',donorSkips:[{baseUrl:origin,code:'bootstrap_auth_failed',policyId:row.id,at:new Date(START).toISOString()}]});assert.equal(f.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,true);assert.equal(f.evaluate({credentials:[alternate]}).blocked,false);assert.doesNotMatch(JSON.stringify(f.policy.listPublic()),/retirementRef/);
});
test('default and legacy auth observations retain the current-run origin exclusion',async()=>{
 const f=await fixture();f.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});assert.equal(f.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,true);
 const g=await fixture({runs:[{id:'attempt-one',donorSkips:[{baseUrl:origin,code:'bootstrap_auth_failed'}]}]});assert.equal(g.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,true);
});
test('non-auth and malformed retirement input is rejected and tampered retirement metadata fails closed',async()=>{
 const f=await fixture();assert.throws(()=>f.observe({code:'network_timeout',retired:false,proof:{prePage:true}}),{code:'VALIDATION'});assert.throws(()=>f.observe({code:'bootstrap_auth_failed',retired:'false',proof:{loginRejectedBeforeWrites:true}}),{code:'VALIDATION'});
 for(const change of [{retired:false},{retired:'false'},{retired:null}]){const g=await fixture({store:memoryStore()}),row=g.observe({code:'bootstrap_auth_failed',proof:{loginRejectedBeforeWrites:true}});Object.assign(g.store.rows.get(row.id),change);assert.equal(g.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,true);assert.equal(g.policy.listPublic().items[0].requiresReview,true);}
 const g=await fixture({store:memoryStore()}),row=g.observe({code:'bootstrap_auth_failed',retired:false,proof:{loginRejectedBeforeWrites:true}});g.store.rows.get(row.id).retirementRef='invalid';assert.equal(g.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,true);assert.equal(g.policy.listPublic().items[0].requiresReview,true);
});
test('an explicitly untimed exact auth trial stays pair-bound indefinitely without inventing a timestamp',async()=>{
 const f=await fixture(),row=f.observe({code:'bootstrap_auth_failed',retired:false,observedAt:null,proof:{loginRejectedBeforeWrites:true}}),stored=f.store.getPolicyRecord(row.id);assert.equal(stored.type,'auth');assert.equal(stored.observedAt,null);assert.equal(stored.expiresAt,null);assert.equal(stored.retired,false);assert.equal(f.evaluate({runId:'attempt-one',credentials:[primary]}).blocked,true);assert.equal(f.evaluate({runId:'attempt-one',credentials:[alternate]}).blocked,false);assert.equal(f.evaluate({credentials:[primary]}).blocked,true);f.time(START+DAY*365);f.restart();assert.equal(f.evaluate({credentials:[primary]}).blocked,true);assert.equal(f.evaluate({credentials:[alternate]}).blocked,false);assert.equal(f.evaluate({sourceIdentity:{...source,readerPrincipal:'changed'},credentials:[primary]}).blocked,false);const publicRow=f.policy.listPublic().items[0];assert.equal(publicRow.observedAt,null);assert.equal(publicRow.expiresAt,null);assert.equal(publicRow.active,true);assert.doesNotMatch(JSON.stringify(publicRow),/sourceRef|credentialRefs|retirementRef|keyMarker|PRIVATE_/);
});
test('only explicit null time permits an untimed auth trial while malformed/future trials and default observations fail closed',async()=>{
 const f=await fixture();for(const observedAt of ['invalid','2026-11-03T25:00:00.000Z','2026-11-04T00:00:00.000Z'])assert.throws(()=>f.observe({code:'bootstrap_auth_failed',retired:false,observedAt,proof:{loginRejectedBeforeWrites:true}}),{code:'VALIDATION'});
 const row=f.observe({code:'bootstrap_auth_failed',observedAt:null,proof:{loginRejectedBeforeWrites:true}});assert.equal(row.type,'security');assert.equal(f.evaluate({credentials:[alternate]}).blocked,true);
});
