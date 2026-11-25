const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const importerModule=import('../server/lifecycle/project-import.mjs');
const html='\uFEFF<!doctype html>\r\n<!-- exact -->\r\n<html lang="pl"><body data-owner="customer"><h1>Łódź</h1><a href="https://example.com/a%2Fb?q=x%20y#part">  exact  </a></body></html>\r\n';
const ai=(extra={})=>({key:'one',links:[{url:'https://example.com/a%2Fb',anchor:' exact '}],...extra});
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const semantic=({provenance,...item})=>item;
const response=(url,data)=>({url,status:200,headers:{},text:JSON.stringify(data),body:Buffer.from(JSON.stringify(data))});

test('normalized items carry versioned safe provenance and distinguish explicit values from import defaults',async()=>{
 const {normalizeImportItems}=await importerModule,input=ai({language:'pl',geo:'pl',minDr:0});
 const [item]=normalizeImportItems('ai',[input],{defaults:{language:'de',geo:'DE',minDr:30,minTraffic:400}});
 assert.equal(item.provenance?.version,1);assert.equal(item.provenance.parserVersion,'pageposter-import/1');
 assert.deepEqual(item.provenance.source,{kind:'items',row:1});
 for(const field of ['key','language','geo','minDr','links'])assert.ok(item.provenance.fields.explicit.includes(field),field);
 for(const field of ['title','minTraffic','format','topic','chromeMode'])assert.ok(item.provenance.fields.defaulted.includes(field),field);
 assert.deepEqual(item.provenance.fields.detected,[]);assert.deepEqual(normalizeImportItems('ai',[item]),[item]);assert.equal(input.provenance,undefined);
});

test('CSV provenance retains safe basename and actual source row after blank lines',async()=>{
 const {createProjectImporter}=await importerModule;
 const result=await createProjectImporter().preview({type:'ai',sourceFile:'customer pages.csv',text:'id,url,anchor,language\none,https://example.com,a,pl\n,,,\ntwo,https://example.com,b,'});
 assert.deepEqual(result.issues,[]);assert.deepEqual(result.items.map(i=>i.provenance.source),[{kind:'table',file:'customer pages.csv',row:2},{kind:'table',file:'customer pages.csv',row:4}]);
 assert.ok(result.items[1].provenance.warnings.includes('LANGUAGE_DEFAULTED'));assert.ok(result.items[1].provenance.warnings.includes('GEO_UNSPECIFIED'));
});

test('file provenance distinguishes detected metadata, explicit overrides and defaults without changing HTML bytes',async()=>{
 const {createProjectImporter}=await importerModule;
 const result=await createProjectImporter().preview({type:'html',files:[{name:'pl-page.html',html}],defaults:{detectFileRegions:true,minDr:25}});
 assert.deepEqual(result.issues,[]);const item=result.items[0];assert.equal(item.html,html);assert.deepEqual(item.provenance.source,{kind:'files',file:'pl-page.html',row:1});
 for(const field of ['language','geo','title','key'])assert.ok(item.provenance.fields.detected.includes(field),field);assert.ok(item.provenance.fields.explicit.includes('html'));assert.ok(item.provenance.fields.defaulted.includes('minDr'));
 const mapped=await createProjectImporter().preview({type:'html',files:[{name:'pl-page.html',html}],text:'key,file,language,geo\nmanual,pl-page.html,de,AT',defaults:{detectFileRegions:true}});
 assert.deepEqual(mapped.issues,[]);assert.equal(mapped.items[0].html,html);assert.ok(mapped.items[0].provenance.fields.explicit.includes('language'));assert.ok(mapped.items[0].provenance.fields.explicit.includes('geo'));
 const unknown=await createProjectImporter().preview({type:'html',files:[{name:'unknown.html',html:'<h1>Exact</h1>'}],defaults:{detectFileRegions:true}});assert.ok(unknown.items[0].provenance.warnings.includes('FILE_REGION_NOT_DETECTED'));
});

test('Sheets and Drive provenance contains resolved safe identifiers and coordinates but never URLs or tokens',async()=>{
 const {createProjectImporter}=await importerModule,requests=[];
 const importer=createProjectImporter({getAccessToken:()=> 'fixture-private-token',transport:async(url)=>{
  const u=new URL(url);requests.push(u);
  if(u.hostname==='sheets.googleapis.com')return u.pathname.includes('/values/')?response(url,{values:[['id','url','anchor'],['sheet-row','https://example.com','exact']]}):response(url,{sheets:[{properties:{sheetId:37,title:'Pages'}}]});
  if(u.searchParams.get('alt')==='media')return {url,status:200,headers:{'content-type':'text/html;charset=utf-8'},text:html,body:Buffer.from(html)};
  return response(url,{id:'html_123',name:'pl-ready.html',mimeType:'text/html',size:String(Buffer.byteLength(html))});
 }});
 const sheet=await importer.preview({type:'ai',spreadsheetUrl:'https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=37',range:'A10:D20'});
 assert.deepEqual(sheet.issues,[]);assert.deepEqual(sheet.items[0].provenance.source,{kind:'google-sheets',spreadsheetId:'sheet_123',gid:37,range:'A10:D20',row:11});
 const drive=await importer.preview({type:'html',driveUrl:'https://drive.google.com/file/d/html_123/view',defaults:{detectFileRegions:true}});
 assert.deepEqual(drive.issues,[]);assert.deepEqual(drive.items[0].provenance.source,{kind:'google-drive',driveId:'html_123',file:'pl-ready.html',row:1});assert.equal(drive.items[0].html,html);
 assert.doesNotMatch(JSON.stringify([sheet.items[0].provenance,drive.items[0].provenance]),/fixture-private-token|https:|authorization|privateKey/);assert.equal(requests.length,4);
});

test('re-preview retains provenance while edits become explicit and metadata cannot authorize actions',async()=>{
 const {createProjectImporter,normalizeImportItems}=await importerModule,importer=createProjectImporter();
 const first=await importer.preview({type:'html',files:[{name:'pl-ready.html',html}],defaults:{detectFileRegions:true,minDr:25}}),original=first.items[0];
 const repeated=await importer.preview({type:'html',items:first.items});assert.deepEqual(repeated.items,first.items);
 const edited={...original,language:'de',geo:'DE',siteSelection:{...original.siteSelection,geo:'DE',minDr:0}};
 const preview=await importer.preview({type:'html',items:[edited]});assert.deepEqual(preview.issues,[]);const next=preview.items[0];
 assert.deepEqual(next.provenance.source,original.provenance.source);assert.ok(next.provenance.fields.explicit.includes('language'));assert.ok(next.provenance.fields.explicit.includes('geo'));assert.ok(next.provenance.fields.explicit.includes('minDr'));assert.equal(next.html,html);
 for(const extra of [{approved:true},{reviewToken:'raw-private-token'},{owner:'remote-owned'}])assert.throws(()=>normalizeImportItems('html',[{...original,provenance:{...original.provenance,...extra}}]),{code:'IMPORT_VALIDATION'});
});

test('untrusted provenance rejects unknown keys, unsafe text, credentials, paths and unbounded fields safely',async()=>{
 const {createProjectImporter,normalizeImportItems}=await importerModule,importer=createProjectImporter(),[item]=normalizeImportItems('ai',[ai()]);
 const bad=[{...item.provenance,version:2},{...item.provenance,parserVersion:'Bearer raw-private-token'},{...item.provenance,source:{kind:'items',file:'C:\\Users\\private.csv'}},{...item.provenance,source:{kind:'items',driveId:'https://drive.google.com/secret'}},{...item.provenance,source:{kind:'items',spreadsheetId:'ya29.private-token'}},{...item.provenance,source:{kind:'items',row:0}},{...item.provenance,source:{kind:'items',range:'C:\\Users\\private.csv'}},{...item.provenance,fields:{explicit:['password'],detected:[],defaulted:[]}},{...item.provenance,warnings:['Bearer raw-private-token']},{...item.provenance,fieldHashes:{html:'x'.repeat(10000)}}];
 for(const provenance of bad){assert.throws(()=>normalizeImportItems('ai',[{...item,provenance}]),{code:'IMPORT_VALIDATION'});const result=await importer.preview({type:'ai',items:[{...item,provenance}]});assert.deepEqual(result.items,[]);assert.equal(result.issues[0].code,'IMPORT_VALIDATION');assert.doesNotMatch(JSON.stringify(result),/raw-private-token|Users|Bearer/);}
 for(const sourceFile of ['C:\\Users\\private.csv','/tmp/private.tsv','private.json','Bearer raw-private-token.csv']){const result=await importer.preview({type:'ai',sourceFile,text:'url,anchor\nhttps://example.com,a'});assert.deepEqual(result.items,[]);assert.ok(result.issues.length);assert.doesNotMatch(JSON.stringify(result),/raw-private-token|Users/);}
});

test('ordinary country-prefixed filenames and safe punctuation keep their supported import behavior',async()=>{
 const {createProjectImporter}=await importerModule,result=await createProjectImporter().preview({type:'html',files:[{name:'sk-page [copy]+1.html',html:'<h1>Exact Slovak file</h1>'}],defaults:{detectFileRegions:true}});
 assert.deepEqual(result.issues,[]);assert.equal(result.items[0].language,'sk');assert.equal(result.items[0].geo,'SK');assert.equal(result.items[0].provenance.source.file,'sk-page [copy]+1.html');
});

for(const name of ['sk-online-casino-bonuses.html','sk-najlepsie-online-kasina.html'])for(const source of ['local','Drive'])test(source+' retains long Slovak basename '+name+' with sk language and SK targeting',async()=>{
 const {createProjectImporter}=await importerModule,exact='<h1>Najlepšie slovenské kasína</h1>\r\n',id='slovak_fixture',requests=[];
 const result=source==='local'?await createProjectImporter().preview({type:'html',files:[{name,html:exact}],defaults:{detectFileRegions:true}}):await createProjectImporter({getAccessToken:()=> 'fixture-private-token',transport:async(url)=>{const u=new URL(url);requests.push(u);return u.searchParams.get('alt')==='media'?{url,status:200,headers:{'content-type':'text/html;charset=utf-8'},text:exact,body:Buffer.from(exact)}:response(url,{id,name,mimeType:'text/html',size:String(Buffer.byteLength(exact))});}}).preview({type:'html',driveUrl:id,defaults:{detectFileRegions:true}});
 assert.deepEqual(result.issues,[],name);assert.equal(result.items[0].language,'sk');assert.equal(result.items[0].geo,'SK');assert.equal(result.items[0].provenance.source.file,name);assert.equal(result.items[0].html,exact);
 if(source==='Drive'){assert.equal(result.items[0].provenance.source.driveId,id);assert.equal(requests.length,2);assert.ok(requests.every(u=>u.hostname==='www.googleapis.com'));}
});

test('recognizable credential-shaped basenames remain rejected without echoing private material',async()=>{
 const {createProjectImporter}=await importerModule,importer=createProjectImporter(),payload='A1b2C3d4'.repeat(6);
 for(const name of ['sk-'+payload+'.html','sk-'+payload+'-copy.html','sk-proj-'+payload+'-a_B.html','sk-svcacct-'+payload+'-a_B.html']){
  const result=await importer.preview({type:'html',files:[{name,html:'<h1>Exact</h1>'}],defaults:{detectFileRegions:true}});assert.deepEqual(result.items,[]);assert.equal(result.issues[0].code,'IMPORT_VALIDATION');assert.equal(JSON.stringify(result).includes(payload),false);
 }
});

async function fixture(t){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-c02-provenance-')),masterKey=Buffer.alloc(32,71).toString('base64');let service=await createLifecycleService({dataDir:dir,masterKey});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const response=await service.handle(new Request('http://localhost:4317/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:response.status,...await response.json()};};
 return {dir,masterKey,q,get service(){return service;},restart:async()=>{await service.close();service=await createLifecycleService({dataDir:dir,masterKey});}};
}

test('provenance and exact HTML survive commit, queue feed, restart and encrypted full backup restore',async t=>{
 const f=await fixture(t),preview=await f.q('/project-import/preview',{type:'html',files:[{name:'pl-ready.html',html}],defaults:{detectFileRegions:true,minDr:25}});assert.deepEqual(preview.issues,[]);assert.equal(preview.items[0].provenance?.version,1);
 const body={idempotencyKey:crypto.randomUUID(),name:'Provenance recovery',type:'html',items:preview.items},committed=await f.q('/project-queue/import',body);assert.equal(committed.status,201,JSON.stringify(committed));
 const record=()=>f.service.store.listRecords(committed.project.id,'project_queue_item')[0];assert.deepEqual(record().input.provenance,preview.items[0].provenance);assert.equal(record().input.html,html);
 f.service.projectQueue.feed();assert.ok(f.service.store.getRecord(record().runId));assert.equal(record().input.html,html);assert.equal(f.service.store.getRecord(record().runId).reviewBeforePublish,true);
 assert.deepEqual((await f.q('/project-queue')).projects[0].items[0].provenance,preview.items[0].provenance);await f.restart();assert.deepEqual(record().input.provenance,preview.items[0].provenance);
 const {createRunStore}=await import('../server/lifecycle/run-store.mjs'),{createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');createRunStore({filename:path.join(f.dir,'generation-runs.sqlite')}).close();createAIBudget({filename:path.join(f.dir,'ai-budget.sqlite')}).close();
 const {exportFullBackup,restoreFullBackup}=await import('../server/lifecycle/full-recovery.mjs'),backup=await exportFullBackup({dataDir:f.dir,masterKey:f.masterKey,passphrase:'fixture backup password'}),target=path.join(f.dir,'restored'),otherKey=Buffer.alloc(32,72).toString('base64');
 await restoreFullBackup({dataDir:target,masterKey:otherKey,backup,passphrase:'fixture backup password'});const {createLifecycleService}=await import('../server/lifecycle/service.mjs'),restored=await createLifecycleService({dataDir:target,masterKey:otherKey});
 try{const saved=restored.store.listRecords(committed.project.id,'project_queue_item')[0];assert.deepEqual(saved.input.provenance,preview.items[0].provenance);assert.equal(saved.input.html,html);assert.deepEqual(restored.projectQueue.overview().projects[0].items[0].provenance,preview.items[0].provenance);}finally{await restored.close();}
});

test('descriptive provenance never changes semantic idempotency or permits changed content, including legacy records',async t=>{
 const f=await fixture(t),preview=await f.q('/project-import/preview',{type:'html',files:[{name:'first.html',html},{name:'second.html',html:'<h1>second</h1>'}]});assert.deepEqual(preview.issues,[]);
 const body={idempotencyKey:crypto.randomUUID(),name:'Semantic snapshots',type:'html',items:preview.items},first=await f.q('/project-queue/import',body);assert.equal(first.status,201);
 const moved=preview.items.map(item=>({...item,provenance:{...item.provenance,source:{...item.provenance.source,row:99}}}));assert.equal((await f.q('/project-queue/import',{...body,items:moved})).status,200);
 const reordered=await f.q('/project-import/preview',{type:'html',files:[{name:'second.html',html:'<h1>second</h1>'},{name:'first.html',html}]});const repeated=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'html',items:reordered.items});assert.equal(repeated.status,201,JSON.stringify(repeated));assert.equal(repeated.batch.duplicateCount,2);
 const changed=await f.q('/project-queue/import',{...body,items:[{...moved[0],html:html+'changed'},moved[1]]});assert.equal(changed.status,409);
 const batch=f.service.store.getRecord(body.idempotencyKey);f.service.store.updateRecord(batch.id,{requestHash:hash({projectId:null,name:body.name,type:'html',items:preview.items.map(semantic)})},batch.revision);
 for(const record of f.service.store.listRecords(first.project.id,'project_queue_item'))f.service.store.updateRecord(record.id,{input:semantic(record.input),inputHash:hash(semantic(record.input))},record.revision);
 assert.equal((await f.q('/project-queue/import',body)).status,200);const legacy=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'html',items:preview.items});assert.equal(legacy.status,201);assert.equal(legacy.batch.duplicateCount,2);
});

test('queue views omit malformed stored provenance and return detached safe metadata',async t=>{
 const f=await fixture(t),preview=await f.q('/project-import/preview',{type:'html',files:[{name:'safe.html',html}]}),first=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Safe public metadata',type:'html',items:preview.items});assert.equal(first.status,201);
 const record=f.service.store.listRecords(first.project.id,'project_queue_item')[0],view=f.service.projectQueue.overview().projects[0].items[0];view.provenance.source.file='different.html';view.provenance.fields.explicit.push('password');assert.deepEqual(f.service.store.getRecord(record.id).input.provenance,preview.items[0].provenance);
 f.service.store.updateRecord(record.id,{input:{...record.input,provenance:{...record.input.provenance,source:{kind:'files',file:'C:\\Users\\private.html',token:'raw-private-token'}}}},record.revision);
 const result=await f.q('/project-queue');assert.equal(result.projects[0].items[0].provenance,null);assert.doesNotMatch(JSON.stringify(result),/raw-private-token|Users/);
});
