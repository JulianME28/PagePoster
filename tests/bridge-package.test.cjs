'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const root=path.resolve(__dirname,'../wordpress/pageposter-bridge');
test('installable ZIP contains only the complete plugin under one folder and is deterministic',()=>{
 const {buildArchive}=require(path.join(root,'build-zip.cjs'));
 const a=buildArchive(),b=buildArchive();assert.deepEqual(a,b);
 const files=new Map();let at=0;
 while(a.readUInt32LE(at)===0x04034b50){
  const method=a.readUInt16LE(at+8),compressed=a.readUInt32LE(at+18),plain=a.readUInt32LE(at+22),nameLength=a.readUInt16LE(at+26),extra=a.readUInt16LE(at+28);
  const name=a.subarray(at+30,at+30+nameLength).toString('utf8'),start=at+30+nameLength+extra;
  const data=method===8?zlib.inflateRawSync(a.subarray(start,start+compressed)):a.subarray(start,start+compressed);
  assert.equal(data.length,plain);assert.ok(name.startsWith('pageposter-bridge/'));assert.ok(!name.includes('..'));files.set(name,data);at=start+compressed;
 }
 assert.equal(files.size,7);
 for(const name of ['pageposter-bridge.php','includes/class-contract.php','includes/class-database.php','includes/class-engine.php','includes/class-rest.php','includes/class-native-editor.php','readme.txt']){
  assert.deepEqual(files.get('pageposter-bridge/'+name),fs.readFileSync(path.join(root,name)));
 }
 assert.match(files.get('pageposter-bridge/pageposter-bridge.php').toString(),/Version: 0\.2\.1/);
 assert.equal(a.readUInt32LE(a.length-22),0x06054b50);
});


test('runtime checksums cover exactly the PHP files of both distributed packages',()=>{
 const {archiveRuntimeHashes}=require('../server/lifecycle/plugin-integrity.cjs'),{createHash}=require('node:crypto');
 const bridge=archiveRuntimeHashes(require(path.join(root,'build-zip.cjs')).buildArchive(),'pageposter-bridge');assert.equal(Object.keys(bridge).length,6);
 for(const [file,hash] of Object.entries(bridge))assert.equal(hash,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'));
 const cleanRoot=path.resolve(__dirname,'qa/legacy-clean-links'),clean=archiveRuntimeHashes(fs.readFileSync(path.resolve(__dirname,'../assets/pageposter-clean-links-1.1.1.zip')),'pageposter-clean-links');assert.equal(Object.keys(clean).length,6);
 for(const [file,hash] of Object.entries(clean))assert.equal(hash,createHash('sha256').update(fs.readFileSync(path.join(cleanRoot,file))).digest('hex'));
 assert.throws(()=>archiveRuntimeHashes(Buffer.from('broken'),'pageposter-bridge'));
 const truncated=require(path.join(root,'build-zip.cjs')).buildArchive().subarray(0,100);assert.throws(()=>archiveRuntimeHashes(truncated,'pageposter-bridge'));
});

test('download build refuses stale Bridge bytes then embeds the exact fresh runtime package',()=>{
 const os=require('node:os'),{spawnSync}=require('node:child_process'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'pageposter-integrity-build-'));
 try{
  fs.cpSync(root,path.join(temp,'wordpress/pageposter-bridge'),{recursive:true});fs.mkdirSync(path.join(temp,'server/lifecycle'),{recursive:true});fs.mkdirSync(path.join(temp,'assets'));fs.mkdirSync(path.join(temp,'dist'));
  fs.copyFileSync(path.resolve(__dirname,'../server/lifecycle/plugin-integrity.cjs'),path.join(temp,'server/lifecycle/plugin-integrity.cjs'));fs.copyFileSync(path.resolve(__dirname,'../build-downloads.cjs'),path.join(temp,'build-downloads.cjs'));fs.copyFileSync(path.resolve(__dirname,'../assets/pageposter-clean-links-1.1.1.zip'),path.join(temp,'assets/pageposter-clean-links-1.1.1.zip'));
  const builder=require(path.join(temp,'wordpress/pageposter-bridge/build-zip.cjs')),archive=builder.buildArchive(),zip=path.join(temp,'wordpress/pageposter-bridge/pageposter-bridge-0.2.1.zip');fs.writeFileSync(zip,Buffer.from('stale'));
  const bad=spawnSync(process.execPath,[path.join(temp,'build-downloads.cjs')],{encoding:'utf8'});assert.notEqual(bad.status,0);assert.match(bad.stderr,/Bridge ZIP is stale/);assert.equal(fs.existsSync(path.join(temp,'dist/plugin-download.js')),false);
  fs.writeFileSync(zip,archive);const good=spawnSync(process.execPath,[path.join(temp,'build-downloads.cjs')],{encoding:'utf8'});assert.equal(good.status,0,good.stderr);const context={};require('node:vm').runInNewContext(fs.readFileSync(path.join(temp,'dist/plugin-download.js'),'utf8'),context);assert.deepEqual(Buffer.from(context.PagePosterDownloads.bridge.base64,'base64'),archive);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
