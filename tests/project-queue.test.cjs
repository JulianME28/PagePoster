const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const G=require('../dist/generator.js');
async function fixture(t,{delay}={}){
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-project-queue-'));let service,generated=[];
 const options={dataDir:dir,masterKey:Buffer.alloc(32,33).toString('base64'),autopilotOptions:{planner:{generate:async input=>{generated.push(input);if(delay)await delay(input);return {config:{...G.DEFAULT_DATA,title:'Page '+input.requestId,brand:'Guide',cards:input.links.map(l=>({name:l.anchor,url:l.url,logoUrl:l.url,button:'Visit casino',bonus:'Resource',rating:''})),sections:[{title:'Article',body:'Content for '+input.requestId}],moreCards:[],tiles:[],services:[],reviews:[],faq:[],navLinks:[],brandUrl:input.links[0].url,footerBrandUrl:input.links[0].url},quality:{state:'passed',generatedTextFingerprint:crypto.createHash('sha256').update(input.requestId).digest('hex')}};}}}};
 service=await createLifecycleService(options);t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const q=async(route,body)=>{const r=await service.handle(new Request('http://localhost:4317/api/lifecycle'+route,{method:body===undefined?'GET':'POST',headers:{Origin:'http://localhost:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}));return {status:r.status,...await r.json()};};
 return {get s(){return service;},q,generated,restart:async()=>{await service.close();service=await createLifecycleService(options);}};
}
const row=(i=1,language='en',geo='AU')=>({key:'row-'+i,title:'Task '+i,source:'ai',language,geo,links:[{url:'https://offer50.example/?item='+i,anchor:'casinotest'+i}],editorial:{format:'article',topic:'casino',language},siteSelection:{minDr:20,minTraffic:100,geo},chromeMode:'custom'});
test('a 120-page project import is durable and idempotent with separate row language and geography',async t=>{
 const f=await fixture(t),body={idempotencyKey:crypto.randomUUID(),name:'Many pages',type:'ai',items:Array.from({length:120},(_,i)=>row(i+1,i%2?'pl':'en',i%2?'PL':'AU'))};
 const first=await f.q('/project-queue/import',body);assert.equal(first.status,201,JSON.stringify(first));const again=await f.q('/project-queue/import',body);assert.equal(again.batch.id,first.batch.id);
 let queue=await f.q('/project-queue');assert.equal(queue.projects.length,1);assert.equal(queue.projects[0].counts.total,120);assert.equal(f.s.store.getProject(first.project.id).workflowType,'ai');await f.restart();queue=await f.q('/project-queue');assert.equal(queue.projects[0].items[1].language,'pl');assert.equal(queue.projects[0].items[1].geo,'PL');assert.equal(f.generated.length,0);
});
test('project type cannot be mixed and invalid import cannot leave a partial project',async t=>{
 const f=await fixture(t);const first=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'AI only',type:'ai',items:[row()]});
 const bad=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'html',items:[{key:'html1',source:'html',html:'<h1>Hello</h1>',title:'Hello',language:'en',geo:''}]});assert.equal(bad.status,409);assert.equal((await f.q('/project-queue')).projects[0].counts.total,1);
 const invalid=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Invalid',type:'ai',items:[row(),{...row(2),language:'invalid'}]});assert.ok(invalid.status>=400);assert.equal(f.s.store.listProjects().length,1);
});
test('HTML items prepare without AI and require an exact reviewed token before publication enters the queue',async t=>{
 const f=await fixture(t);const result=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Customer HTML',type:'html',items:[{key:'file1',source:'html',html:'<!doctype html><title>Customer</title><h1>Customer</h1><p>Unchanged article</p>',title:'Customer',language:'de',geo:'DE'}]});assert.equal(result.status,201,JSON.stringify(result));
 for(let i=0;i<3;i++)await f.s.tick();let item=(await f.q('/project-queue')).projects[0].items[0];assert.equal(item.state,'awaiting_review');assert.equal(f.generated.length,0);
 assert.ok((await f.q('/project-queue/approve',{items:[{id:item.id,reviewToken:'stale'}]})).status>=400);const preview=await f.q('/autopilot/'+item.runId+'/html');assert.match(preview.html,/Unchanged article/);
 assert.equal((await f.q('/project-queue/approve',{items:[{id:item.id,reviewToken:preview.reviewToken}]})).status,202);item=(await f.q('/project-queue')).projects[0].items[0];assert.equal(item.state,'queued');
});
test('language edits update waiting AI input and refuse a paid run without re-generating',async t=>{
 const f=await fixture(t),result=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'AI language',type:'ai',items:[row()]});
 assert.equal(result.status,201);
 const first=(await f.q('/project-queue')).projects[0].items[0];
 const edit=(item,language)=>f.q('/project-queue/requirements',{items:[{id:item.id,expectedRevision:item.requirementsRevision}],changes:{language}});
 assert.equal((await edit(first,'fr')).status,200);
 for(let i=0;i<3;i++)await f.s.tick();
 const prepared=(await f.q('/project-queue')).projects[0].items[0];
 assert.equal(prepared.language,'fr');
 assert.equal(f.generated.length,1);
 const blocked=await edit(prepared,'de');
 assert.equal(blocked.status,409);
 assert.match(blocked.error,/нової генерації/);
 assert.equal(f.generated.length,1);
});

test('exports the exact prepared HTML and placeholder audit as a read-only ZIP',async t=>{
 const f=await fixture(t),rows=Array.from({length:24},(_,index)=>{
  const geo=index%2?'PL':'NZ';
  return {key:'zip-'+index,title:'Archive '+index,source:'html',language:index%2?'pl':'en-nz',geo,
   html:'<h1>Archive '+index+'</h1><a href="https://target.invalid/?code=%2F">Offer</a>'};
 });
 const result=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Prepared ZIP',type:'html',items:rows});
 assert.equal(result.status,201);
 const repeated=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:result.project.id,type:'html',items:[...rows].reverse()});
 assert.equal(repeated.batch.duplicateCount,24);
 for(let i=0;i<rows.length;i++)await f.s.tick();
 const items=(await f.q('/project-queue')).projects[0].items;
 const before=items.map(item=>f.s.store.getRecord(item.runId));
 const request=entries=>f.s.handle(new Request('http://localhost:4317/api/lifecycle/project-queue/export-prepared',{
  method:'POST',headers:{Origin:'http://localhost:4317','X-PagePoster-Request':'1','Content-Type':'application/json'},
  body:JSON.stringify({items:entries})}));
 const selection=items.map(item=>({id:item.id,pageId:item.pageId,pageRevision:item.pageRevision}));
 const response=await request(selection);
 assert.equal(response.status,200);
 assert.equal(response.headers.get('Content-Type'),'application/zip');
 const files=await require('../dist/html-package.js').unpackZip(new Uint8Array(await response.arrayBuffer()));
 const entries=new Map(files.map(file=>[file.name,Buffer.from(file.bytes).toString('utf8')]));
 const audit=JSON.parse(entries.get('audit.json'));
 assert.equal(audit.pages.length,24);
 for(const [index,item] of items.entries()){
  const entry=audit.pages[index],prepared=await f.q('/autopilot/'+item.runId+'/html');
  assert.equal(entries.get(entry.file),prepared.html);
  assert.equal(entry.key,item.key);
  assert.equal(entry.language,item.language);
  assert.equal(entry.geo,item.geo);
  assert.ok(entry.audit.placeholderCount>0);
  assert.ok(entry.audit.placeholders.some(link=>link.url==='https://target.invalid/?code=%2F'));
 }
 assert.deepEqual(items.map(item=>f.s.store.getRecord(item.runId)),before);
 assert.equal(f.generated.length,0);
 assert.equal((await request([selection[0],{...selection[1],pageRevision:selection[1].pageRevision+1}])).status,409);
 assert.equal((await request([selection[0],selection[0]])).status,400);
 assert.equal((await request(Array.from({length:101},(_,index)=>({id:'row-'+index,pageRevision:1})))).status,400);
});

test('mixed HTML regions retain independent languages and donor criteria when preparation workers run',async t=>{
 const f=await fixture(t),files=[['hu-page.html','hu'],['nz-page.html','en'],['pl-page.html','pl']].map(([name,language])=>({name,html:'<!doctype html><html lang="'+language+'"><body><h1>Customer '+language+'</h1><p>Original content.</p></body></html>'}));
 const preview=await f.q('/project-import/preview',{type:'html',files,defaults:{detectFileRegions:true,minDr:25,minTraffic:400}});assert.equal(preview.status,200);assert.deepEqual(preview.issues,[]);
 const imported=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Mixed HTML regions',type:'html',items:preview.items});assert.equal(imported.status,201,JSON.stringify(imported));
 for(let i=0;i<6;i++)await f.s.tick();
 const items=(await f.q('/project-queue')).projects[0].items;assert.equal(items.length,3);assert.ok(items.every(item=>item.state==='awaiting_review'));assert.equal(f.generated.length,0);
 assert.deepEqual(items.map(item=>[item.language,item.geo]),[['hu','HU'],['en','NZ'],['pl','PL']]);
 for(const item of items){const run=f.s.store.getRecord(item.runId);assert.equal(run.language,item.language);assert.deepEqual(run.siteSelection,{minDr:25,minTraffic:400,geo:item.geo});}
});

test('paused project waits while a newly imported project proceeds',async t=>{
 const f=await fixture(t),a=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Paused',type:'ai',items:[row()]});await f.q('/projects/'+a.project.id+'/queue',{action:'pause'});
 const b=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Next',type:'ai',items:[row(2,'fr','FR')]});for(let i=0;i<3;i++)await f.s.tick();const queue=await f.q('/project-queue');assert.equal(queue.projects.find(p=>p.projectId===a.project.id).items[0].state,'waiting');assert.equal(queue.projects.find(p=>p.projectId===b.project.id).items[0].state,'awaiting_review');assert.equal(f.generated.length,1);
});
test('pausing already admitted rows releases generation slots for the next project',async t=>{
 const f=await fixture(t),a=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Admitted first',type:'ai',items:[row(1),row(2)]});f.s.projectQueue.feed();assert.equal(f.s.autopilot.list(a.project.id).length,2);await f.q('/projects/'+a.project.id+'/queue',{action:'pause'});
 const b=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Must proceed',type:'ai',items:[row(3)]});for(let i=0;i<3;i++)await f.s.tick();const item=(await f.q('/project-queue')).projects.find(p=>p.projectId===b.project.id).items[0];assert.equal(item.state,'awaiting_review');assert.equal(f.generated.length,1);
});
test('slow generation does not block adding another project or advancing its publication queue',async t=>{
 let release,started;const gate=new Promise(r=>release=r),began=new Promise(r=>started=r);let held=false;
 const f=await fixture(t,{delay:async()=>{if(held){started();await gate;}}});
 await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Ready HTML',type:'html',items:[{key:'ready',source:'html',html:'<h1>Prepared</h1><p>Ready content</p>',title:'Prepared',language:'en',geo:'GB'}]});await f.s.tick();
 const ready=(await f.q('/project-queue')).projects[0].items[0],preview=await f.q('/autopilot/'+ready.runId+'/html');await f.q('/project-queue/approve',{items:[{id:ready.id,reviewToken:preview.reviewToken}]});
 held=true;await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Slow AI',type:'ai',items:[row()]});f.s.projectQueue.feed();const generating=f.s.autopilot.tick({lane:'generation',slot:0});await began;
 try{const next=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'More work',type:'ai',items:[row(2)]});assert.equal(next.status,201);await f.s.autopilot.tick({lane:'publication'});assert.equal(f.s.store.getRecord(ready.runId).state,'waiting_source');assert.equal((await f.q('/project-queue')).projects.length,3);}finally{release();await generating;}
});
test('two generation workers claim different rows and project source lock also covers single-page launch',async t=>{
 let releases=[];const f=await fixture(t,{delay:()=>new Promise(r=>releases.push(r))});const a=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Concurrent',type:'ai',items:[row(1),row(2)]});
 f.s.projectQueue.feed();const first=f.s.autopilot.tick({lane:'generation',slot:0}),second=f.s.autopilot.tick({lane:'generation',slot:1});
 try{await new Promise(resolve=>setImmediate(resolve));assert.equal(f.generated.length,2);assert.notEqual(f.generated[0].requestId,f.generated[1].requestId);const bad=await f.q('/projects/'+a.project.id+'/autopilot',{idempotencyKey:crypto.randomUUID(),source:'html',html:'<h1>Wrong source</h1>',reviewToken:'x'});assert.ok(bad.status>=400);}finally{releases.forEach(r=>r());await Promise.all([first,second]);}
});
test('duplicate row keys cannot partially append pages or change a legacy project type',async t=>{
 const f=await fixture(t),first=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Stable snapshot',type:'ai',items:[row(1)]});
 const again=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'ai',items:[row(1)]});assert.equal(again.batch.duplicateCount,1);assert.equal(again.batch.count,0);
 const bad=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'ai',items:[row(2),{...row(1),title:'Changed existing row'}]});assert.equal(bad.status,409);assert.equal((await f.q('/project-queue')).projects[0].counts.total,1);
 const patch=f.s.store.getProject(first.project.id);assert.throws(()=>f.s.store.updateProject(patch.id,{workflowType:'html'},patch.revision),e=>e.code==='CONFLICT');
});
test('Google import without an account reports an actionable issue and does not create a project',async t=>{
 const f=await fixture(t),preview=await f.q('/project-import/preview',{type:'ai',spreadsheetUrl:'https://docs.google.com/spreadsheets/d/sheet_example/edit#gid=0'});assert.equal(preview.status,200);assert.equal(preview.items.length,0);assert.equal(preview.issues[0].code,'GOOGLE_ACCOUNT_REQUIRED');assert.equal(f.s.store.listProjects().length,0);
});
test('separate local HTML batches append and reordered reimports retain identities and immutable snapshots',async t=>{
 const f=await fixture(t),firstFile={name:'first.html',html:'<h1>First original file</h1>'},secondFile={name:'second.html',html:'<h1>Second original file</h1>'};
 const preview=async files=>{const result=await f.q('/project-import/preview',{type:'html',files});assert.deepEqual(result.issues,[]);return result.items;};
 const firstItems=await preview([firstFile]),firstBody={idempotencyKey:crypto.randomUUID(),name:'Local batches',type:'html',items:firstItems};
 const first=await f.q('/project-queue/import',firstBody);assert.equal(first.status,201);
 assert.equal((await f.q('/project-queue/import',firstBody)).batch.id,first.batch.id);
 const second=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'html',items:await preview([secondFile])});
 assert.equal(second.status,201,JSON.stringify(second));assert.equal(second.batch.count,1);
 const reordered=await preview([secondFile,firstFile]);assert.equal(reordered[1].key,firstItems[0].key);
 const replay=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'html',items:reordered});
 assert.equal(replay.status,201);assert.equal(replay.batch.count,0);assert.equal(replay.batch.duplicateCount,2);
 const changed=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'html',items:await preview([{name:'third.html',html:'<h1>Do not partially append</h1>'},{...firstFile,html:'<h1>Changed same identity</h1>'}])});
 assert.equal(changed.status,409);assert.equal(changed.code,'IMPORT_DUPLICATE_KEY');
 const queue=await f.q('/project-queue');assert.equal(queue.projects[0].counts.total,2);
 const records=f.s.store.listRecords(first.project.id,'project_queue_item');
 assert.equal(records.length,2);assert.deepEqual(records.map(record=>record.input.html).sort(),[firstFile.html,secondFile.html].sort());
});
test('local file metadata preserves explicit IDs while rows without IDs follow the file across table order',async t=>{
 const f=await fixture(t),files=[{name:'first.html',html:'<h1>First original</h1>'},{name:'second.html',html:'<h1>Second original</h1>'}];
 const preview=async text=>{const result=await f.q('/project-import/preview',{type:'html',files,text});assert.deepEqual(result.issues,[]);return result.items;};
 const implicit=await preview('file,language\nfirst.html,pl\nsecond.html,de'),first=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Metadata rows',type:'html',items:implicit});
 assert.equal(first.status,201);const reordered=await preview('file,language\nsecond.html,de\nfirst.html,pl');assert.equal(reordered[1].key,implicit[0].key);
 const replay=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:first.project.id,type:'html',items:reordered});assert.equal(replay.status,201);assert.equal(replay.batch.duplicateCount,2);
 const explicit=await preview('key,file\ncustomer-a,second.html\ncustomer-b,first.html');assert.deepEqual(explicit.map(item=>item.key),['customer-a','customer-b']);
 const manual=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Explicit customer IDs',type:'html',items:explicit});assert.equal(manual.status,201);
 const changed=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:manual.project.id,type:'html',items:await preview('key,file\ncustomer-a,first.html\ncustomer-b,second.html')});assert.equal(changed.status,409);assert.equal(changed.code,'IMPORT_DUPLICATE_KEY');
});
test('upgraded local imports reject ambiguous copies of legacy positional HTML atomically',async t=>{
 const f=await fixture(t),html='<h1>Original legacy authored HTML</h1>',legacyBody={idempotencyKey:crypto.randomUUID(),name:'Before stable filenames',type:'html',items:[{key:'row-1',title:'Original filename is unknown',html,language:'pl',geo:'PL'}]};
 const legacy=await f.q('/project-queue/import',legacyBody);assert.equal(legacy.status,201);const before=f.s.store.listRecords(legacy.project.id,'project_queue_item');
 const preview=async(files,text)=>{const result=await f.q('/project-import/preview',{type:'html',files,...(text?{text}:{})});assert.deepEqual(result.issues,[]);return result.items;};
 const changedFile={name:'different.html',html:'<h1>Different authored HTML</h1>'},oldFile={name:'old-upload.html',html};
 const conflict=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:legacy.project.id,type:'html',items:await preview([changedFile,oldFile])});
 assert.equal(conflict.status,409,JSON.stringify(conflict));assert.equal(conflict.code,'IMPORT_DUPLICATE_KEY');assert.match(conflict.error,/стар|ID/i);
 assert.deepEqual(f.s.store.listRecords(legacy.project.id,'project_queue_item'),before);
 const receiptReplay=await f.q('/project-queue/import',legacyBody);assert.equal(receiptReplay.status,200);assert.equal(receiptReplay.reused,true);assert.equal(receiptReplay.batch.id,legacy.batch.id);
 const different=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:legacy.project.id,type:'html',items:await preview([changedFile])});assert.equal(different.status,201);assert.equal(different.batch.count,1);
 const explicit=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),projectId:legacy.project.id,type:'html',items:await preview([oldFile],'key,file\ndeliberate-copy,old-upload.html')});assert.equal(explicit.status,201);assert.equal(explicit.batch.count,1);
 const records=f.s.store.listRecords(legacy.project.id,'project_queue_item');assert.equal(records.length,3);assert.deepEqual(records.find(record=>record.key==='row-1'),before[0]);
});
test('retrying an existing standalone run from the shared queue returns the resumed item',async t=>{
 const f=await fixture(t),project=f.s.store.createProject({name:'Existing single-page project'}),run=f.s.autopilot.launch(project.id,{idempotencyKey:crypto.randomUUID(),links:row().links});const raw=f.s.store.getRecord(run.id);f.s.store.updateRecord(run.id,{state:'failed'},raw.revision);
 const response=await f.q('/project-queue/items/'+run.id+'/retry',{});assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.item.runId,run.id);assert.equal(response.item.state,'queued');
});
test('HTML import body over two MB is accepted within the bounded project-import route',async t=>{
 const f=await fixture(t),file='<h1>Large</h1><p>'+('text '.repeat(60000))+'</p>';
 const preview=await f.q('/project-import/preview',{type:'html',files:Array.from({length:8},(_,i)=>({name:'page-'+i+'.html',html:file})),defaults:{language:'fr',geo:'FR'}});assert.equal(preview.status,200);assert.deepEqual(preview.issues,[]);assert.equal(preview.items.length,8);
 const imported=await f.q('/project-queue/import',{idempotencyKey:crypto.randomUUID(),name:'Large HTML',type:'html',items:preview.items});assert.equal(imported.status,201,JSON.stringify(imported));assert.equal((await f.q('/project-queue')).projects[0].counts.total,8);
});
