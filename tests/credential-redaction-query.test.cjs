'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const masterKey=Buffer.alloc(32,37).toString('base64');
async function fixture(t){
 const {createStore}=await import('../server/lifecycle/store.mjs'),{createSecretBox}=await import('../server/lifecycle/secrets.mjs'),directory=fs.mkdtempSync(path.join(os.tmpdir(),'pp-redaction-query-')),filename=path.join(directory,'fixture.sqlite'),stores=[];
 const open=()=>{const store=createStore({filename,masterKey});stores.push(store);return store;},store=open();
 t.after(()=>{for(const store of stores)store.close();const absolute=path.resolve(directory);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('pp-redaction-query-'));fs.rmSync(absolute,{recursive:true,force:true});});
 const project=store.createProject({name:'Synthetic redaction'}),page=store.createPage(project.id,{title:'Synthetic page'}),values=[];
 for(const [kind,name]of [['browser','typed'],['api','api'],['browser','legacy']]){
  const login={username:'fixture-'+name,applicationPassword:'synthetic-'+name+'-private-password'},site=store.createSite(project.id,{name,baseUrl:'https://'+name+'.example/',...(kind==='browser'?{bootstrap:{mode:'browser'}}:{}),...(name==='legacy'?{}:login)});
  if(name==='legacy'){const db=new DatabaseSync(filename);try{db.prepare('INSERT INTO site_credentials(site_id,envelope) VALUES(?,?)').run(site.id,JSON.stringify(createSecretBox(masterKey).encrypt(site.id,login)));}finally{db.close();}}
  values.push({kind,name,site,login,basic:Buffer.from(login.username+':'+login.applicationPassword).toString('base64')});
 }
 return {store,open,filename,project,page,values};
}
function siteReads(action){
 const prepare=DatabaseSync.prototype.prepare;let queries=0;const started=performance.now();
 DatabaseSync.prototype.prepare=function(sql){if(sql==='SELECT data FROM sites WHERE id=?')queries++;return prepare.call(this,sql);};
 try{return {value:action(),queries,elapsedMs:performance.now()-started};}finally{DatabaseSync.prototype.prepare=prepare;}
}

test('metadata redacts typed browser, legacy browser and API secrets without fetching unused site-kind metadata',async t=>{
 const f=await fixture(t),text=f.values.flatMap(v=>[v.login.applicationPassword,v.basic]).join(' | '),measured=siteReads(()=>Array.from({length:5},()=>f.store.addCheck(f.page.id,{kind:'public',state:'ok',evidence:{text}})));
 t.diagnostic(JSON.stringify({metadataWrites:5,credentialRows:3,siteMetadataQueries:measured.queries,elapsedMs:measured.elapsedMs}));
 for(const check of measured.value)for(const v of f.values){assert.equal(check.evidence.text.includes(v.login.applicationPassword),false);assert.equal(check.evidence.text.includes(v.basic),false);assert.match(check.evidence.text,/\[REDACTED\]/);}
 assert.equal(measured.queries,0,'redaction requires only envelope/AAD, not browser/API kind metadata');
 for(const v of f.values){assert.deepEqual(v.kind==='browser'?f.store.getBrowserCredentials(v.site.id):f.store.getSiteCredentials(v.site.id),v.login);assert.equal(v.kind==='browser'?f.store.getSiteCredentials(v.site.id):f.store.getBrowserCredentials(v.site.id),null);}
});

test('credential redaction rereads a changed credential from another connection',async t=>{
 const f=await fixture(t),api=f.values.find(v=>v.kind==='api'),other=f.open(),password='synthetic-replaced-secret',updated=other.updateSite(api.site.id,{username:api.login.username,applicationPassword:password},api.site.revision),basic=Buffer.from(api.login.username+':'+password).toString('base64');
 assert.ok(updated.revision>api.site.revision);
 const result=siteReads(()=>f.store.addCheck(f.page.id,{kind:'public',state:'ok',evidence:{text:password+' '+basic}}));
 assert.equal(result.value.evidence.text,'[REDACTED] [REDACTED]');assert.equal(result.queries,0);
});

test('malformed typed credentials still reject metadata without inserting a partial check',async t=>{
 const f=await fixture(t),typed=f.values.find(v=>v.name==='typed'),db=new DatabaseSync(f.filename);
 try{const stored=JSON.parse(db.prepare('SELECT envelope FROM site_credentials WHERE site_id=?').get(typed.site.id).envelope);db.prepare('UPDATE site_credentials SET envelope=? WHERE site_id=?').run(JSON.stringify({...stored,credentialKind:'api'}),typed.site.id);}finally{db.close();}
 assert.throws(()=>f.store.addCheck(f.page.id,{kind:'public',state:'ok',evidence:'Must not persist'}),{code:'SECRET_DECRYPT_FAILED'});assert.deepEqual(f.store.listChecks(f.page.id),[]);
});
