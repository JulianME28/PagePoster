const test=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync}=require('node:crypto');
const modulePromise=import('../server/lifecycle/project-import.mjs');
const ready=(language='',body='Exact customer content')=>'\uFEFF<!doctype html>\r\n<!-- customer comment -->\r\n<html'+(language?' lang="'+language+'"':'')+'><head><title>Original</title></head><body data-owner="customer">'+body+'</body></html>\r\n';
const invalid=fn=>assert.throws(fn,error=>error.code==='IMPORT_VALIDATION');

test('fifteen ready files retain exact HTML and form HU, NZ and PL targeting groups',async()=>{
 const {createProjectImporter,normalizeImportItems}=await modulePromise;
 const files=[
  ...Array.from({length:5},(_,n)=>({name:'hu-uj-kaszinok-'+(n+10)+'.html',html:ready('hu','Árvíztűrő '+n)})),
  ...Array.from({length:5},(_,n)=>({name:'nz-new-casinos-'+(n+20)+'.html',html:ready('en-NZ','New Zealand '+n)})),
  ...Array.from({length:5},(_,n)=>({name:'pl-bez-weryfikacji-'+(n+30)+'.html',html:ready('pl','Treść '+n)}))
 ];
 const importer=createProjectImporter(),defaults={detectFileRegions:true,language:'fr',geo:'CA',minDr:22.5,minTraffic:1234};
 const result=await importer.preview({type:'html',files,defaults});
 assert.deepEqual(result.issues,[]);
 assert.equal(result.items.length,15);
 assert.deepEqual(result.items.map(item=>[item.language,item.geo]),[
  ['hu','HU'],['hu','HU'],['hu','HU'],['hu','HU'],['hu','HU'],
  ['en-nz','NZ'],['en-nz','NZ'],['en-nz','NZ'],['en-nz','NZ'],['en-nz','NZ'],
  ['pl','PL'],['pl','PL'],['pl','PL'],['pl','PL'],['pl','PL']
 ]);
 const reordered=await importer.preview({type:'html',files:[...files].reverse(),defaults});assert.deepEqual(reordered.issues,[]);
 assert.equal(new Set(result.items.map(item=>item.key)).size,15);
 result.items.forEach((item,index)=>{
  assert.equal(item.key,reordered.items[files.length-1-index].key);
  assert.equal(item.title,files[index].name.slice(0,-5));
  assert.equal(item.html,files[index].html);
  assert.deepEqual(item.siteSelection,{minDr:22.5,minTraffic:1234,geo:item.geo});
 });
 assert.deepEqual(normalizeImportItems('html',result.items),result.items);
 assert.deepEqual(result.source,{kind:'files',fileCount:15,rowCount:15});
});

test('explicit table language and geography override root and filename metadata',async()=>{
 const {createProjectImporter}=await modulePromise;
 const html=ready('hu');
 const result=await createProjectImporter().preview({type:'html',files:[{name:'hu-uj-kaszinok-abc.html',html}],text:'id\tfile\ttitle\tlanguage\tgeo\tminDr\tminTraffic\nexact-key\thu-uj-kaszinok-abc.html\tCustomer title\tde-AT\tDE,AT\t0\t0',defaults:{detectFileRegions:true,minDr:30,minTraffic:2000}});
 assert.deepEqual(result.issues,[]);
 const [item]=result.items;
 assert.equal(item.key,'exact-key');assert.equal(item.title,'Customer title');assert.equal(item.html,html);
 assert.equal(item.language,'de-at');assert.equal(item.geo,'AT,DE');
 assert.deepEqual(item.siteSelection,{minDr:0,minTraffic:0,geo:'AT,DE'});
});

test('unknown and plain language prefixes use defaults without inventing a country',async()=>{
 const {createProjectImporter}=await modulePromise;
 const files=['unknown-new-casinos.html','en-new-casinos.html','uk-new-casinos.html'].map(name=>({name,html:ready()}));
 const result=await createProjectImporter().preview({type:'html',files,defaults:{detectFileRegions:true,language:'fr',geo:'CA'}});
 assert.deepEqual(result.issues,[]);
 assert.deepEqual(result.items.map(item=>[item.language,item.geo]),[['fr','CA'],['fr','CA'],['fr','CA']]);
 const noDefault=await createProjectImporter().preview({type:'html',files:[files[0]],defaults:{detectFileRegions:true}});
 assert.deepEqual(noDefault.issues,[]);assert.equal(noDefault.items[0].geo,'');assert.equal(noDefault.items[0].language,'en');
});

test('absent or disabled detection preserves legacy file metadata defaults',async()=>{
 const {createProjectImporter}=await modulePromise;
 for(const extra of [{},{detectFileRegions:false}]){
  const result=await createProjectImporter().preview({type:'html',files:[{name:'hu-uj-kaszinok-abc.html',html:ready('hu')}],defaults:{language:'fr',geo:'CA',...extra}});
  assert.deepEqual(result.issues,[]);assert.equal(result.items[0].language,'fr');assert.equal(result.items[0].geo,'CA');
 }
});

test('detection is a boolean flag and is limited to local or Drive file sources',async()=>{
 const {createProjectImporter,normalizeImportItems}=await modulePromise;
 const importer=createProjectImporter();
 for(const detectFileRegions of ['true',1,null,{},[]]){
  const result=await importer.preview({type:'html',files:[{name:'hu-page.html',html:ready('hu')}],defaults:{detectFileRegions}});
  assert.deepEqual(result.items,[]);assert.equal(result.issues[0].code,'IMPORT_VALIDATION');
  invalid(()=>normalizeImportItems('html',[{html:ready()}],{defaults:{detectFileRegions}}));
 }
 const result=await importer.preview({type:'html',items:[{key:'explicit',html:ready('hu'),siteSelection:{geo:'PL',minDr:12,minTraffic:34}}],defaults:{detectFileRegions:true,language:'de',geo:'NZ'}});
 assert.deepEqual(result.issues,[]);assert.equal(result.items[0].language,'de');assert.equal(result.items[0].geo,'PL');
 assert.deepEqual(result.items[0].siteSelection,{geo:'PL',minDr:12,minTraffic:34});
 const ai=await importer.preview({type:'ai',items:[{links:[{url:'https://example.com',anchor:'Exact'}]}],defaults:{detectFileRegions:true,language:'pl',geo:'PL'}});
 assert.deepEqual(ai.issues,[]);assert.equal(ai.items[0].language,'pl');
});

test('filename locales and country defaults supply metadata when a valid root language is absent',async()=>{
 const {createProjectImporter}=await modulePromise;
 const cases=[
  ['en-nz-new-casinos.html','', 'en-nz','NZ'],
  ['pt-br-cassinos.html','', 'pt-br','BR'],
  ['HU-uj-kaszinok.html','', 'hu','HU'],
  ['nz-new-casinos.html','not_a_language', 'en','NZ'],
  ['pl-bez-weryfikacji.html','', 'pl','PL'],
  ['gb-casinos.html','', 'en','GB'],
  ['de-casinos.html','', 'de','DE'],
  ['pt-br-cassinos-2.html','es-MX', 'es-mx','BR']
 ];
 const result=await createProjectImporter().preview({type:'html',files:cases.map(([name,language])=>({name,html:ready(language)})),defaults:{detectFileRegions:true,language:'fr',geo:'CA'}});
 assert.deepEqual(result.issues,[]);
 assert.deepEqual(result.items.map(item=>[item.language,item.geo]),cases.map(([, ,language,geo])=>[language,geo]));
});

test('only a real root language is detected, ignoring comments, body and script lookalikes',async()=>{
 const {createProjectImporter}=await modulePromise;
 const cases=[
  ['<!-- <html lang="hu"> --><!doctype html><HTML LANG="pl"><body>Exact</body></HTML>','pl'],
  ['<!doctype html><html lang="&#104;u"><body>Exact</body></html>','hu'],
  ['<html><head><script>const markup="<html lang=hu>";</script></head><body>Exact</body></html>','de'],
  ['<body><html lang="hu">Exact</body>','de'],
  ['<script>const markup="<html lang=hu>";</script>','de'],
  ['<!-- <html lang="hu"> --><p>Fragment</p>','de'],
  ['<html><body><html lang="hu">Exact</body></html>','de'],
  ['<html data-language="hu" lang="bad_value"><body>Exact</body></html>','de']
 ];
 for(const [index,[html,language]] of cases.entries()){
  const result=await createProjectImporter().preview({type:'html',files:[{name:'unknown-'+index+'.html',html}],defaults:{detectFileRegions:true,language:'de'}});
  assert.deepEqual(result.issues,[],String(index));assert.equal(result.items[0].language,language,String(index));assert.equal(result.items[0].html,html);
 }
});

test('HTML language metadata accepts bounded ISO and BCP47 tags while AI retains its language set',async()=>{
 const {normalizeImportItems}=await modulePromise;
 for(const [language,want] of [['hu','hu'],['en-NZ','en-nz'],['pt-BR','pt-br'],['zh-Hant-TW','zh-hant-tw'],['fil','fil'],['es-419','es-419']]){
  const [item]=normalizeImportItems('html',[{key:'safe',html:ready(),language}]);assert.equal(item.language,want);
  assert.deepEqual(normalizeImportItems('html',[item]),[item]);
 }
 for(const language of Object.keys(require('../dist/generation-options.js').languages)){
  const [item]=normalizeImportItems('ai',[{language,links:[{url:'https://example.com',anchor:'Exact'}]}]);
  assert.equal(item.language,language);assert.equal(item.editorial.language,language);
 }
 for(const language of ['xx','en-NZ','pt-BR','fil'])invalid(()=>normalizeImportItems('ai',[{language,links:[{url:'https://example.com',anchor:'Exact'}]}]));
 for(const language of ['h','hungarian','hu_PL','hu--HU','hu-<script>','hu-x-private','en-US-abcdefghi','en-abc-def-ghi-jkl','en\n'])invalid(()=>normalizeImportItems('html',[{language,html:ready()}]));
});

test('durable revalidation preserves group edits and rejects mutated unsafe language or geography',async()=>{
 const {createProjectImporter,normalizeImportItems}=await modulePromise;
 const preview=await createProjectImporter().preview({type:'html',files:[{name:'hu-page.html',html:ready('hu')}],defaults:{detectFileRegions:true}});
 assert.deepEqual(preview.issues,[]);
 const edited={...preview.items[0],language:'pt-BR',geo:'BR',siteSelection:{...preview.items[0].siteSelection,geo:'BR'}};
 const [committed]=normalizeImportItems('html',[edited]);
 assert.equal(committed.language,'pt-br');assert.equal(committed.geo,'BR');assert.equal(committed.html,preview.items[0].html);
 invalid(()=>normalizeImportItems('html',[{...edited,language:'hu<script>'}]));
 invalid(()=>normalizeImportItems('html',[{...edited,geo:'Hungary'}]));
 invalid(()=>normalizeImportItems('html',[{...edited,siteSelection:{...edited.siteSelection,geo:'HU'}}]));
 const rechecked=await createProjectImporter().preview({type:'html',items:[edited]});
 assert.deepEqual(rechecked.issues,[]);assert.deepEqual(rechecked.items,[committed]);
});

test('Drive files infer their separate regions and preserve row mappings and explicit overrides',async()=>{
 const {createProjectImporter}=await modulePromise;
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const account={clientEmail:'reader@test.iam.gserviceaccount.com',privateKey:privateKey.export({type:'pkcs8',format:'pem'})};
 const files=[{id:'hu_file',name:'hu-uj-kaszinok-hash.html',html:ready('hu')},{id:'nz_file',name:'nz-new-casinos-hash.html',html:ready('en')},{id:'pl_file',name:'pl-bez-weryfikacji-hash.html',html:ready('pl')}];
 const json=(url,value)=>({url,status:200,headers:{},text:JSON.stringify(value)});
 const transport=async url=>{
  const u=new URL(url);
  if(u.hostname==='oauth2.googleapis.com')return json(url,{access_token:'test-only-token',token_type:'Bearer'});
  assert.equal(u.hostname,'www.googleapis.com');
  if(u.pathname.endsWith('/folder'))return json(url,{id:'folder',name:'Content',mimeType:'application/vnd.google-apps.folder'});
  if(u.pathname==='/drive/v3/files')return json(url,{files:files.map(file=>({id:file.id,name:file.name,mimeType:'text/html',size:String(Buffer.byteLength(file.html))}))});
  const file=files.find(file=>u.pathname.endsWith('/'+file.id));assert.ok(file);assert.equal(u.searchParams.get('alt'),'media');
  return {url,status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from(file.html),text:file.html};
 };
 const importer=createProjectImporter({getAccount:()=>account,transport});
 const preview=await importer.preview({type:'html',driveUrl:'folder',defaults:{detectFileRegions:true,language:'fr',geo:'CA'}});
 assert.deepEqual(preview.issues,[]);assert.deepEqual(preview.items.map(item=>[item.key,item.language,item.geo]),[['hu_file','hu','HU'],['nz_file','en','NZ'],['pl_file','pl','PL']]);
 const mapped=await importer.preview({type:'html',driveUrl:'folder',text:'id\tfile\tlanguage\tgeo\nthird\tpl_file\tfr\tFR\nfirst\thu_file\t\t\nsecond\tnz_file\t\t',defaults:{detectFileRegions:true}});
 assert.deepEqual(mapped.issues,[]);assert.deepEqual(mapped.items.map(item=>[item.key,item.language,item.geo]),[['third','fr','FR'],['first','hu','HU'],['second','en','NZ']]);
 assert.equal(mapped.items[0].html,files[2].html);
});
