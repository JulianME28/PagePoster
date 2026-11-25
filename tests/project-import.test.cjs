const test=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync,verify}=require('node:crypto');
const modulePromise=import('../server/lifecycle/project-import.mjs');
const html='<html lang="pl"><head><title>Polski tekst</title></head><body><p>Treść.</p></body></html>';
const ai=(extra={})=>({links:[{url:'https://example.com/path?q=a%20b',anchor:' Dokładny anchor '}],...extra});
const invalid=fn=>assert.throws(fn,error=>error.code==='IMPORT_VALIDATION'&&!/private|secret|Bearer/.test(error.message));
const response=(url,data,status=200)=>({url,status,headers:{},text:JSON.stringify(data)});

test('brief source lines locate validation failures and reject an inconsistent row map',async()=>{
 const {createProjectImporter}=await modulePromise;
 const importer=createProjectImporter();
 const input={type:'ai',text:'url,anchor\nhttps://example.com/,Exact\nnot-a-url,Wrong',sourceFile:'project.md',sourceRows:[3,17]};
 const invalid=await importer.preview(input);
 assert.equal(invalid.items.length,0);
 assert.deepEqual(invalid.issues.map(issue=>issue.row),[17]);
 for(const sourceRows of [[3],[17,3],[3,3],[0,17],['3',17]]){
  const result=await importer.preview({...input,sourceRows});
  assert.equal(result.items.length,0);
  assert.equal(result.issues.length,1);
  assert.match(result.issues[0].message,/номери рядків/);
 }
});
test('a requested publication URL supplies the donor and exact slug and rejects conflicting fields',async()=>{
 const {createProjectImporter}=await modulePromise;
 const importer=createProjectImporter();
 const row={html:'<h1>Page</h1>',placementUrl:'https://example.org/wp/exact-slug/'};
 const result=await importer.preview({type:'html',items:[row]});
 assert.deepEqual(result.issues,[]);
 assert.equal(result.items[0].donor,'https://example.org/wp/');
 assert.equal(result.items[0].slug,'exact-slug');
 for(const patch of [{slug:'different'},{donor:'different.example'},{placementUrl:'https://example.org/wp/exact-slug/?preview=1'}]){
  const bad=await importer.preview({type:'html',items:[{...row,...patch}]});
  assert.equal(bad.items.length,0);
  assert.equal(bad.issues.length,1);
 }
});
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const account={clientEmail:'reader@test.iam.gserviceaccount.com',privateKey:privateKey.export({type:'pkcs8',format:'pem'})};
function fixture(routes){
 const requests=[];
 return {requests,transport:async(url,options={})=>{
  const u=new URL(url);requests.push({url:u,options});
  if(u.hostname==='oauth2.googleapis.com'){
   const token=new URLSearchParams(options.body).get('assertion'),parts=token.split('.');
   assert.equal(verify('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),publicKey,Buffer.from(parts[2],'base64url')),true);
   const claims=JSON.parse(Buffer.from(parts[1],'base64url'));
   assert.deepEqual(claims.scope.split(' ').sort(),['https://www.googleapis.com/auth/drive.readonly','https://www.googleapis.com/auth/spreadsheets.readonly']);
   assert.equal(claims.aud,'https://oauth2.googleapis.com/token');
   assert.equal(options.followRedirects,false);
   return response(url,{access_token:'fixture-private-token',token_type:'Bearer',expires_in:3600});
  }
  assert.equal(options.headers.authorization,'Bearer fixture-private-token');
  assert.equal(options.followRedirects,false);
  return routes(u,options);
 }};
}

test('normalizes per-page criteria and editorial language without changing exact links',async()=>{
 const {normalizeImportItems}=await modulePromise;
 const input=ai({id:'one',title:' Label ',language:'pl',geo:'pl,de',minDr:'25.5',minTraffic:'1200',format:'guide',topic:'custom',customTopic:'Różne tematy'});
 const items=normalizeImportItems('ai',[input],{defaults:{language:'en',geo:'US',minDr:10}});
 assert.deepEqual(items.map(({provenance,...item})=>item),[{key:'one',title:'Label',source:'ai',language:'pl',geo:'DE,PL',siteSelection:{minDr:25.5,minTraffic:1200,geo:'DE,PL'},links:[{url:'https://example.com/path?q=a%20b',anchor:' Dokładny anchor '}],editorial:{format:'guide',topic:'custom',customTopic:'Różne tematy',language:'pl'},chromeMode:'custom'}]);
 assert.deepEqual(normalizeImportItems('ai',items),items);
 assert.equal(input.geo,'pl,de');
 assert.equal(normalizeImportItems('ai',[ai()])[0].title,'');
});

test('rejects mixed source types, duplicate keys, malformed criteria and invalid links atomically',async()=>{
 const {normalizeImportItems}=await modulePromise;
 for(const rows of [[ai({html})],[ai({source:'html'})],[ai({id:'same'}),ai({id:'same'})],[ai({language:'zz'})],[ai({minDr:101})],[ai({minTraffic:1.5})],[ai({geo:'Poland'})],[ai({links:[{url:'https://user:password@example.com',anchor:'one'}]})],[ai({links:[{url:'https://example.com',anchor:'a\nsecret'}]})],[ai({password:'secret'})]])invalid(()=>normalizeImportItems('ai',rows));
 invalid(()=>normalizeImportItems('html',[{html,links:[]}]))
 invalid(()=>normalizeImportItems('ai',[]));
 invalid(()=>normalizeImportItems('ai',Array.from({length:1001},()=>ai())));
});

test('AI card count may come from defaults and refuses invalid counts and HTML imports',async()=>{
 const {normalizeImportItems}=await modulePromise;
 assert.equal(normalizeImportItems('ai',[ai()],{defaults:{cardCount:3}})[0].links.length,3);
 for(const cardCount of [0,21,3.5,'2e1','foo'])invalid(()=>normalizeImportItems('ai',[ai({cardCount})]));
 invalid(()=>normalizeImportItems('ai',[ai({cardCount:1,links:[
  {url:'https://example.org/',anchor:'First'},{url:'https://example.net/',anchor:'Second'}
 ]})]));
 invalid(()=>normalizeImportItems('html',[{html,cardCount:3}]));
 invalid(()=>normalizeImportItems('html',[{html}],{defaults:{cardCount:3}}));
});

test('pasted CSV supports quoted delimiters, multiline fields, extra link pairs and row overrides',async()=>{
 const {createProjectImporter}=await modulePromise;
 const result=await createProjectImporter().preview({type:'ai',text:'ID,title,url,anchor,url2,anchor2,language,geo,format,topic,customTopic\r\none,"A, B\nC",https://example.com,"exact, anchor",https://other.example/a,second,de,DE,article,custom,"Line one, line two"',defaults:{language:'en'}});
 assert.equal(result.items.length,1);assert.deepEqual(result.issues,[]);
 assert.equal(result.items[0].title,'A, B C');
 assert.deepEqual(result.items[0].links,[{url:'https://example.com',anchor:'exact, anchor'},{url:'https://other.example/a',anchor:'second'}]);
 assert.equal(result.items[0].language,'de');
 assert.equal(result.items[0].editorial.customTopic,'Line one, line two');
});

test('TSV table previews report all invalid rows and never return a partial import',async()=>{
 const {createProjectImporter}=await modulePromise;
 const result=await createProjectImporter().preview({type:'ai',text:'id\turl\tanchor\tlanguage\none\thttps://example.com\tgood\tpl\nbad\tjavascript:alert(1)\ta\tfr\nthird\thttps://example.com\tb\txx'});
 assert.deepEqual(result.items,[]);assert.equal(result.issues.length,2);
 assert.deepEqual(result.issues.map(x=>[x.row,x.key]),[[3,'bad'],[4,'third']]);
 for(const entry of result.issues)assert.equal(typeof entry.message,'string');
});

test('malformed tables, duplicate headers, uneven rows and ambiguous sources fail explicitly',async()=>{
 const {createProjectImporter}=await modulePromise;
 for(const body of [
  {text:'url,anchor,url\nhttps://example.com,a,x'},
  {text:'url,anchor\n"https://example.com,a'},
  {text:'url,anchor\nhttps://example.com,a,extra'},
  {text:'url,anchor\nhttps://example.com,a',items:[ai()]},
  {text:'url,anchor,unknown\nhttps://example.com,a,secret'}
 ]){const result=await createProjectImporter().preview({type:'ai',...body});assert.deepEqual(result.items,[]);assert.ok(result.issues.length);}
});

test('HTML files infer labels and table mappings match every unique filename',async()=>{
 const {createProjectImporter,normalizeImportItems}=await modulePromise;
 const importer=createProjectImporter();
 const inferred=await importer.preview({type:'html',files:[{name:'polski.html',html}],defaults:{language:'pl',geo:'PL'}});
 assert.deepEqual(inferred.issues,[]);assert.equal(inferred.items[0].title,'polski');assert.equal(inferred.items[0].html,html);
 assert.deepEqual(normalizeImportItems('html',inferred.items),inferred.items);
 const mapped=await importer.preview({type:'html',files:[{name:'polski.html',html},{name:'deutsch.htm',html}],text:'id\tfile\ttitle\tlanguage\tgeo\np\tpolski.html\tPolski\tpl\tPL\nd\tdeutsch.htm\tDeutsch\tde\tDE'});
 assert.deepEqual(mapped.issues,[]);assert.deepEqual(mapped.items.map(i=>[i.key,i.title,i.language,i.geo]),[['p','Polski','pl','PL'],['d','Deutsch','de','DE']]);
 for(const body of [
  {files:[{name:'same.html',html},{name:'same.html',html}]},
  {files:[{name:'polski.html',html}],text:'file\nmissing.html'},
  {files:[{name:'polski.html',html},{name:'unmapped.html',html}],text:'file\npolski.html'},
  {files:[{name:'polski.html',html}],text:'id,file\na,polski.html\nb,polski.html'},
  {files:[{name:'note.txt',html}]}
 ]){const result=await importer.preview({type:'html',...body});assert.deepEqual(result.items,[]);assert.ok(result.issues.length);}
});

test('HTML byte limits and the total import limit reject oversized work without truncation',async()=>{
 const {normalizeImportItems,createProjectImporter}=await modulePromise;
 invalid(()=>normalizeImportItems('html',[{html:'é'.repeat(250001)}]));
 invalid(()=>normalizeImportItems('html',Array.from({length:43},(_,n)=>({key:String(n),html:'x'.repeat(500000)}))));
 const result=await createProjectImporter().preview({type:'ai',files:[{name:'a.html',html}],items:[ai()]});
 assert.deepEqual(result.items,[]);assert.ok(result.issues.length);
});

test('Sheets uses the requested gid, bounded A1 range and read-only JWT authentication',async()=>{
 const {createProjectImporter}=await modulePromise;
 const fake=fixture(u=>{
  if(!u.pathname.includes('/values/'))return response(u.href,{sheets:[{properties:{sheetId:0,title:'First'}},{properties:{sheetId:37,title:"Bob's table"}}]});
  assert.equal(decodeURIComponent(u.pathname.split('/values/')[1]),"'Bob''s table'!A1:AZ1002");
  return response(u.href,{range:"'Bob''s table'!A1:D2",majorDimension:'ROWS',values:[['ID','url','anchor','language'],['es','https://example.com','sin cambiar','es']]});
 });
 const result=await createProjectImporter({getAccount:()=>account,transport:fake.transport}).preview({type:'ai',spreadsheetUrl:'https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=37'});
 assert.deepEqual(result.issues,[]);assert.equal(result.items[0].language,'es');
 assert.equal(JSON.stringify(result).includes('fixture-private-token'),false);
 assert.ok(fake.requests.every(r=>['oauth2.googleapis.com','sheets.googleapis.com'].includes(r.url.hostname)));
});

test('Sheets range and returned row limits never silently truncate an import',async()=>{
 const {createProjectImporter}=await modulePromise;
 const fake=fixture(u=>response(u.href,{values:[['url','anchor'],...Array.from({length:1001},()=>['https://example.com','one'])]}));
 const importer=createProjectImporter({getAccount:()=>account,transport:fake.transport});
 const tooMany=await importer.preview({type:'ai',spreadsheetUrl:'sheet_123'});
 assert.deepEqual(tooMany.items,[]);assert.ok(tooMany.issues.some(i=>/1000/.test(i.message)));
 for(const range of ['A:A','A1:AZ200000','A1:ZZ2','A1','https://evil.example']){
  const result=await importer.preview({type:'ai',spreadsheetUrl:'sheet_123',range});assert.deepEqual(result.items,[]);assert.ok(result.issues.length);
 }
});

test('Google access failures and hostile URLs yield actionable safe issues without leaking provider bodies',async()=>{
 const {createProjectImporter}=await modulePromise;
 let calls=0;
 const importer=createProjectImporter({transport:async()=>{calls++;throw Error('secret');}});
 const noAccount=await importer.preview({type:'ai',spreadsheetUrl:'sheet_123'});
 assert.equal(noAccount.issues[0].code,'GOOGLE_ACCOUNT_REQUIRED');assert.equal(calls,0);
 for(const spreadsheetUrl of ['http://127.0.0.1/data','https://evil.example/spreadsheets/d/sheet_123','https://docs.google.com.evil.example/spreadsheets/d/sheet_123']){
  const result=await importer.preview({type:'ai',spreadsheetUrl});assert.ok(result.issues.length);assert.equal(calls,0);
 }
 const fake=fixture(u=>response(u.href,{error:{message:'secret credential internal body'}},403));
 const denied=await createProjectImporter({getAccount:()=>account,transport:fake.transport}).preview({type:'ai',spreadsheetUrl:'sheet_123'});
 assert.equal(denied.issues[0].code,'GOOGLE_ACCESS_DENIED');assert.doesNotMatch(JSON.stringify(denied),/credential|internal body|fixture-private-token/);
});

test('Drive folder import paginates direct children and maps table rows by Drive ID',async()=>{
 const {createProjectImporter}=await modulePromise;
 const fake=fixture(u=>{
  if(u.pathname.endsWith('/folder_1'))return response(u.href,{id:'folder_1',name:'Content',mimeType:'application/vnd.google-apps.folder'});
  if(u.pathname==='/drive/v3/files'){
   assert.match(u.searchParams.get('q'),/'folder_1' in parents/);
   if(!u.searchParams.get('pageToken'))return response(u.href,{nextPageToken:'page-2',files:[{id:'html_1',name:'one.html',mimeType:'text/html',size:String(Buffer.byteLength(html))}]});
   assert.equal(u.searchParams.get('pageToken'),'page-2');
   return response(u.href,{files:[{id:'html_2',name:'two.html',mimeType:'text/html',size:String(Buffer.byteLength(html))}]});
  }
  assert.equal(u.searchParams.get('alt'),'media');
  return {url:u.href,status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from(html),text:html};
 });
 const result=await createProjectImporter({getAccount:()=>account,transport:fake.transport}).preview({type:'html',driveUrl:'https://drive.google.com/drive/folders/folder_1',text:'id,file,language\na,html_2,fr\nb,html_1,pl'});
 assert.deepEqual(result.issues,[]);assert.deepEqual(result.items.map(i=>[i.key,i.title,i.language]),[['a','two','fr'],['b','one','pl']]);
 assert.ok(fake.requests.every(r=>['oauth2.googleapis.com','www.googleapis.com'].includes(r.url.hostname)));
});

test('Drive rejects shortcuts, non-HTML content, invalid UTF-8, repeated pages and oversized metadata',async()=>{
 const {createProjectImporter}=await modulePromise;
 for(const metadata of [
  {id:'file_1',name:'one.html',mimeType:'application/vnd.google-apps.shortcut'},
  {id:'file_1',name:'one.pdf',mimeType:'application/pdf'},
  {id:'file_1',name:'one.html',mimeType:'text/html',size:'500001'}
 ]){
  const fake=fixture(u=>response(u.href,metadata));
  const result=await createProjectImporter({getAccount:()=>account,transport:fake.transport}).preview({type:'html',driveUrl:'https://drive.google.com/file/d/file_1/view'});
  assert.deepEqual(result.items,[]);assert.ok(result.issues.length);assert.equal(fake.requests.length,2);
 }
 const fake=fixture(u=>u.searchParams.get('alt')==='media'?{url:u.href,status:200,headers:{},body:Buffer.from([0xc3,0x28]),text:'�('}:response(u.href,{id:'file_1',name:'one.html',mimeType:'text/html',size:'2'}));
 const badUtf=await createProjectImporter({getAccount:()=>account,transport:fake.transport}).preview({type:'html',driveUrl:'file_1'});
 assert.deepEqual(badUtf.items,[]);assert.ok(badUtf.issues.some(i=>/UTF-8/.test(i.message)));
 const looping=fixture(u=>u.pathname.endsWith('/folder_1')?response(u.href,{id:'folder_1',name:'folder',mimeType:'application/vnd.google-apps.folder'}):response(u.href,{nextPageToken:'repeat',files:[]}));
 const repeated=await createProjectImporter({getAccount:()=>account,transport:looping.transport}).preview({type:'html',driveUrl:'https://drive.google.com/drive/folders/folder_1'});
 assert.deepEqual(repeated.items,[]);assert.ok(repeated.issues.length);assert.ok(looping.requests.length<6);
});

test('Drive folder downloads HTML from mixed folders without following shortcuts',async()=>{
 const {createProjectImporter}=await modulePromise;
 const folder=(id,name)=>({id,name,mimeType:'application/vnd.google-apps.folder'});
 const fake=fixture(u=>{
  if(u.pathname.endsWith('/folder_1'))return response(u.href,folder('folder_1','Content'));
  if(u.pathname==='/drive/v3/files'){
   if(u.searchParams.get('q').includes("'folder_1' in parents"))return response(u.href,{files:[
    folder('sub_1','nested'),{id:'note',name:'notes.csv',mimeType:'text/csv'},
    {id:'image',name:'image.png',mimeType:'image/png'},{id:'shortcut',name:'skip.html',mimeType:'application/vnd.google-apps.shortcut'}
   ]});
   assert.match(u.searchParams.get('q'),/'sub_1' in parents/);
   return response(u.href,{files:[{id:'html_1',name:'page.html',mimeType:'text/html'}]});
  }
  assert.match(u.pathname,/\/html_1$/);assert.equal(u.searchParams.get('alt'),'media');
  return {url:u.href,status:200,headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from(html),text:html};
 });
 const snapshot=await createProjectImporter({getAccount:()=>account,transport:fake.transport}).preview({type:'html',driveUrl:'https://drive.google.com/drive/folders/folder_1',text:'file,slug\nnested/page.html,exact-page'});
 assert.deepEqual(snapshot.issues,[]);
 assert.deepEqual(snapshot.items.map(item=>[item.slug,item.provenance.source.driveId]),[['exact-page','html_1']]);
 assert.equal(fake.requests.filter(request=>request.url.searchParams.get('alt')==='media').length,1);
});

test('links JSON preserves exact values and rejects a competing URL column',async()=>{
 const {createProjectImporter}=await modulePromise;
 const importer=createProjectImporter();
 const result=await importer.preview({type:'ai',text:'id\tlinks\tlanguage\njson\t[{"url":"https://example.com/a%2Fb","anchor":"  exact  "}]\tes'});
 assert.deepEqual(result.issues,[]);assert.deepEqual(result.items[0].links,[{url:'https://example.com/a%2Fb',anchor:'  exact  '}]);
 const competing=await importer.preview({type:'ai',items:[ai({url:'https://other.example',anchor:'other'})]});
 assert.deepEqual(competing.items,[]);assert.ok(competing.issues.length);
});

test('three identical Drive filenames remain ambiguous while Drive IDs still map correctly',async()=>{
 const {createProjectImporter}=await modulePromise;
 const fake=fixture(u=>{
  if(u.pathname.endsWith('/folder_1'))return response(u.href,{id:'folder_1',name:'folder',mimeType:'application/vnd.google-apps.folder'});
  if(u.pathname==='/drive/v3/files')return response(u.href,{files:[1,2,3].map(n=>({id:'file_'+n,name:'same.html',mimeType:'text/html',size:String(Buffer.byteLength(html))}))});
  return {url:u.href,status:200,headers:{},body:Buffer.from(html),text:html};
 });
 const importer=createProjectImporter({getAccount:()=>account,transport:fake.transport});
 const ambiguous=await importer.preview({type:'html',driveUrl:'folder_1',text:'id,file\na,same.html\nb,file_1\nc,file_2'});
 assert.deepEqual(ambiguous.items,[]);assert.equal(ambiguous.issues[0].row,2);assert.equal(ambiguous.issues[0].key,'a');
 const byId=await importer.preview({type:'html',driveUrl:'folder_1',text:'id,file\na,file_1\nb,file_2\nc,file_3'});
 assert.deepEqual(byId.issues,[]);assert.equal(byId.items.length,3);
});

test('oversized network responses produce an explicit import limit issue',async()=>{
 const {createProjectImporter}=await modulePromise;
 const fake=fixture(()=>{throw Object.assign(Error('private failure'),{code:'response_too_large'});});
 const result=await createProjectImporter({getAccount:()=>account,transport:fake.transport}).preview({type:'ai',spreadsheetUrl:'sheet_123'});
 assert.deepEqual(result.items,[]);assert.match(result.issues[0].message,/1000/);
});

test('blank criteria inherit import defaults while explicit zero values override them',async()=>{
 const {createProjectImporter,normalizeImportItems}=await modulePromise;
 const defaults={geo:'PL',minDr:30,minTraffic:100};
 const importer=createProjectImporter();
 for(const text of ['id,url,anchor,geo,minDr,minTraffic\nblank,https://example.com,anchor,,,','id,url,anchor,geo,minDr,minTraffic\nblank,https://example.com,anchor, , , ']){
  const result=await importer.preview({type:'ai',text,defaults});
  assert.deepEqual(result.issues,[]);assert.deepEqual(result.items[0].siteSelection,{geo:'PL',minDr:30,minTraffic:100});
 }
 const [blank,zero]=normalizeImportItems('ai',[ai({id:'blank',geo:'',minDr:'',minTraffic:''}),ai({id:'zero',geo:'DE',minDr:0,minTraffic:'0'})],{defaults});
 assert.deepEqual(blank.siteSelection,{geo:'PL',minDr:30,minTraffic:100});
 assert.deepEqual(zero.siteSelection,{geo:'DE',minDr:0,minTraffic:0});
});
