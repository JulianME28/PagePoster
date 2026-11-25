'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM, VirtualConsole} = require('jsdom');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('bundled plugin remains the exact versioned ZIP for automatic installation', () => {
  const context = {};
  vm.runInNewContext(read('dist/plugin-download.js'), context);
  const info = context.PagePosterDownloads.cleanLinks;
  assert.equal(info.version, '1.1.1');
  assert.equal(info.filename, 'pageposter-clean-links-1.1.1.zip');
  const expected = fs.readFileSync(path.join(root, 'assets', info.filename));
  assert.deepEqual(Buffer.from(info.base64, 'base64'), expected);
  assert.equal(expected.subarray(0, 2).toString(), 'PK');
});

test('portable autopilot boots without manual editor or external scripts', async () => {
 const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(read('dist/PagePoster.html'),{runScripts:'dangerously',url:'https://portable.test/',virtualConsole:vc,beforeParse(w){w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.fetch=async()=>new Response(JSON.stringify({available:false}),{headers:{'Content-Type':'application/json'}});}});
 try{await new Promise(r=>setTimeout(r,20));assert.ok(dom.window.document.getElementById('ap-launch-form'));assert.equal(dom.window.document.querySelectorAll('script[src]').length,0);assert.equal(dom.window.document.querySelectorAll('.editor-tabs').length,0);const document=dom.window.document;document.getElementById('ap-settings-open').click();document.getElementById('ap-backup-open').click();assert.equal(document.getElementById('ap-backup').open,true,'The inlined recovery module binds its dialog controls');assert.equal(document.getElementById('ap-settings').open,false);assert.deepEqual(errors,[]);}finally{dom.window.close();}
});

test('local server serves the same navigation and plugin modules used by the hosted build', async () => {
  const {createLocalServer} = require('../server/local.cjs');
  const server = await createLocalServer({env: {}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const name of ['page-runtime.js', 'plugin-download.js', 'autopilot-recovery.js']) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/' + name);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), read('dist/' + name));
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('hosted assets include every stylesheet and script referenced by both workspace entry points',()=>{
 const firstLine=read('dist/server/index.js').split('\n')[0];
 const assets=JSON.parse(firstLine.slice('const PAGEPOSTER_ASSETS='.length,-1));
 for(const name of ['index.html','autopilot.html']){
  const dom=new JSDOM(assets[name].body);
  try{
   for(const node of dom.window.document.querySelectorAll('script[src],link[rel="stylesheet"]')){
    const filename=node.getAttribute('src')||node.getAttribute('href');
    assert.ok(assets[filename],name+' requires '+filename);
    assert.equal(assets[filename].body,read('dist/'+filename));
   }
  }finally{dom.window.close();}
 }
});

test('local desktop server serves every entry-point stylesheet and script dependency',async()=>{
 const server=await require('../server/local.cjs').createLocalServer({env:{}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const assets=new Set();for(const name of ['index.html','autopilot.html']){const dom=new JSDOM(read('dist/'+name));for(const node of dom.window.document.querySelectorAll('script[src],link[rel="stylesheet"]'))assets.add(node.getAttribute('src')||node.getAttribute('href'));dom.window.close();}
  for(const name of assets){const response=await fetch('http://127.0.0.1:'+server.address().port+'/'+name);assert.equal(response.status,200,name);assert.equal(await response.text(),read('dist/'+name),name);}
 }finally{await new Promise(resolve=>server.close(resolve));await server.closeResources?.();}
});

test('a clean source checkout builds hosted assets without private hosting registration',t=>{
 const os=require('node:os'),{spawnSync}=require('node:child_process'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'pp-public-build-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 for(const area of ['dist','server','worker'])fs.cpSync(path.join(root,area),path.join(temp,area),{recursive:true,filter:source=>!source.includes(path.sep+'.openai')});
 fs.copyFileSync(path.join(root,'build-hosted.cjs'),path.join(temp,'build-hosted.cjs'));
 const result=spawnSync(process.execPath,[path.join(temp,'build-hosted.cjs')],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);assert.ok(fs.existsSync(path.join(temp,'dist/server/index.js')));assert.equal(fs.existsSync(path.join(temp,'dist/.openai/hosting.json')),false);
});
