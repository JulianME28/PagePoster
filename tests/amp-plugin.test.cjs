'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const php=require('./qa/php-runtime.cjs').resolvePHP56(),fixture=path.join(__dirname,'fixtures/amp-mode.php'),plugin=path.resolve(__dirname,'../wordpress/pageposter-clean-links-amp/amp-mode.php');
async function input(){const amp=await import('../server/lifecycle/amp-mode.mjs');const payload=amp.buildAmpPayload({html:'<style>h1{color:navy!important}</style><div id="pp-landing"><h1>Original</h1><p>Original text.</p><a href="https://offer.example/">Visit</a><img src="https://images.example/a.png" width="800" height="400"></div>',title:'Original',language:'en'});return {amp,payload};}
function run(t,content,mode='inspect'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-amp-php-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'input.json');fs.writeFileSync(file,JSON.stringify({content,mode}));
 const result=spawnSync(php,['-n',fixture,file,plugin],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout;
}
test('experimental PHP helper scopes AMP to opted-in published pages and respects disable and content capabilities',async t=>{
 const {amp,payload}=await input(),proof=JSON.parse(run(t,amp.appendAmpPayload('<p>Main content</p>',payload)));
 assert.deepEqual(proof,{payload:true,eligible:true,disabled:true,filteredAuthor:true,draft:true,ordinary:true});
});
test('PHP emits one canonical and AMP alternate in the real head and a valid standalone AMP response',async t=>{
 const {amp,payload}=await input(),content=amp.appendAmpPayload('<p>Main content remains unchanged</p>',payload);
 const {JSDOM}=require('jsdom'),main=new JSDOM(run(t,content,'main')).window.document;
 assert.equal(main.head.querySelectorAll('link[rel=canonical]').length,1);assert.equal(main.head.querySelector('link[rel=canonical]').href,'https://fixture.example/page/');
 assert.equal(main.head.querySelectorAll('link[rel=amphtml]').length,1);assert.equal(main.head.querySelector('link[rel=amphtml]').href,'https://fixture.example/page/?pageposter_amp=1');assert.match(main.body.textContent,/Main content remains unchanged/);
 const document=run(t,content,'amp'),{initializeAmpValidator,validateAmpDocument}=await import('../server/lifecycle/amp-validator.mjs');await initializeAmpValidator();assert.equal(validateAmpDocument(document).status,'PASS');
});
test('encoded AMP payload cannot bypass the real WordPress KSES filter',async t=>{
 const {payload}=await input();
 for(const body of ['<script>alert(1)</script>','<img src="x" onerror="alert(1)">','<a href="javascript:alert(1)">Visit</a>','<iframe src="https://foreign.example/"></iframe>']){
  const content='<div hidden data-pp-amp="'+Buffer.from(JSON.stringify({...payload,body})).toString('base64')+'"></div>';
  assert.equal(JSON.parse(run(t,content)).payload,false,body);
 }
});
test('PHP updates real head links without modifying comments, scripts, or unrelated attributes',t=>{
 const {JSDOM}=require('jsdom');
 const comment='<!-- <head><link rel="canonical" href="/example"></head> -->';
 const script='<script>const sample = "<link rel=amphtml></head>";</script>';
 const unrelated='<link data-rel="canonical" rel="preload" href="/style.css" as="style">';
 const misleading='<link title=" rel=canonical " rel="stylesheet" href="/other.css">';
 const original='<!doctype html>'+comment+'<html><head>'+script+unrelated+misleading+'<link rel="canonical" href="/old"><link rel="alternate amphtml" href="/old-amp"></head><body>Body</body></html>';
 const output=run(t,original,'head');
 for(const untouched of [comment,script,unrelated,misleading])assert.ok(output.includes(untouched),untouched);
 const document=new JSDOM(output).window.document;
 assert.deepEqual([...document.head.querySelectorAll('link[rel~="canonical"]')].map(node=>node.getAttribute('href')),['https://fixture.example/page/']);
 assert.deepEqual([...document.head.querySelectorAll('link[rel~="amphtml"]')].map(node=>node.getAttribute('href')),['https://fixture.example/page/?pageposter_amp=1']);
});
