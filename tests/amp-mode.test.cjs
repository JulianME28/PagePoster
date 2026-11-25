'use strict';
const test=require('node:test'),assert=require('node:assert/strict');

test('AMP preparation preserves content and destinations without executing customer scripts',async()=>{
 const {buildAmpPayload,appendAmpPayload,renderAmpDocument}=await import('../server/lifecycle/amp-mode.mjs');
 const source='<style>#pp-landing{position:fixed!important;inset:0;overflow:auto}h1{color:navy!important}</style><div id="pp-landing"><h1>Original title</h1><p>Original café text.</p><button data-pp-url="https://offer.example/path?a=1&amp;b=2" data-pp-target="_blank" onclick="throw 1">Visit</button><details><summary>Question</summary>Answer</details></div><script>throw Error("must not run")</script>';
 const payload=buildAmpPayload({html:source,title:'Original title',language:'pl'});
 assert.match(payload.body,/Original café text/);assert.match(payload.body,/<a[^>]+href="https:\/\/offer.example\/path\?a=1&amp;b=2"[^>]*>Visit<\/a>/);
 assert.doesNotMatch(payload.body,/<script|onclick|data-pp-url|<button/i);assert.doesNotMatch(payload.css,/!important/i);
 assert.match(payload.body,/target="_blank"/);
 const encoded=appendAmpPayload(source,payload);assert.equal(encoded.startsWith(source),true);assert.equal((encoded.match(/data-pp-amp=/g)||[]).length,1);
 const document=renderAmpDocument(payload,'https://site.example/page/');assert.match(document,/<html amp lang="pl">/);assert.match(document,/<link rel="canonical" href="https:\/\/site.example\/page\/">/);assert.match(document,/<style amp-custom>/);assert.match(document,/amp-boilerplate/);
 assert.equal((document.match(/<script\b/g)||[]).length,1);
 const {initializeAmpValidator,validateAmpDocument}=await import('../server/lifecycle/amp-validator.mjs');await initializeAmpValidator();assert.equal(validateAmpDocument(document).status,'PASS');
});

test('AMP conversion refuses unsupported active content, CSS imports and unsafe destinations',async()=>{
 const {buildAmpPayload}=await import('../server/lifecycle/amp-mode.mjs');
 for(const html of ['<h1>Title</h1><iframe src="https://widget.example"></iframe>','<h1>Title</h1><form><input></form>','<style>@import "https://styles.example/a.css";</style><h1>Title</h1>','<h1>Title</h1><a href="javascript:alert(1)">Visit</a>']){
  assert.throws(()=>buildAmpPayload({html,title:'Title'}),error=>/^AMP_/.test(error.code));
 }
});

test('AMP removes oversized embedded fonts and uses a readable compact style only if the remaining CSS is too large',async()=>{
 const {buildAmpPayload,renderAmpDocument}=await import('../server/lifecycle/amp-mode.mjs'),{initializeAmpValidator,validateAmpDocument}=await import('../server/lifecycle/amp-validator.mjs');await initializeAmpValidator();
 const body='<h1>Title</h1><p>Original text</p><a href="https://offer.example/">Visit</a>';
 const font=buildAmpPayload({html:'<style>@font-face{font-family:Heavy;src:url("data:font/woff2;base64,'+'a'.repeat(80000)+'")}h1{color:navy}</style>'+body,title:'Title'});
 assert.doesNotMatch(font.css,/data:font/);assert.match(font.css,/h1\{color:navy\}/);assert.equal(font.styleMode,undefined);
 const large=buildAmpPayload({html:'<style>'+'.widget{padding:12px;color:#112233}'.repeat(2500)+'</style>'+body,title:'Title'});
 assert.equal(large.styleMode,'compact');assert.ok(Buffer.byteLength(large.css)<75000);assert.equal(large.body,font.body);assert.equal(validateAmpDocument(renderAmpDocument(large,'https://fixture.example/page/')).status,'PASS');
});

test('AMP image conversion requires dimensions and removes resource hints and untrusted attributes',async()=>{
 const {buildAmpPayload}=await import('../server/lifecycle/amp-mode.mjs');
 const payload=buildAmpPayload({html:'<h1>Title</h1><img src="https://images.example/a.png" width="800" height="400" onerror="alert(1)"><link rel="preload" href="https://styles.example/a.css">',title:'Title'});
 assert.match(payload.body,/<amp-img[^>]+width="800"[^>]+height="400"[^>]+layout="responsive"/);assert.doesNotMatch(payload.body,/onerror|<link/);
 assert.throws(()=>buildAmpPayload({html:'<h1>Title</h1><img src="https://images.example/a.png">',title:'Title'}),{code:'AMP_IMAGE_DIMENSIONS_REQUIRED'});
});
