const test=require('node:test'),assert=require('node:assert/strict');
test('a transient static-script failure is retried once before its response reaches Chromium',async()=>{
 const {retryBrowserAssetRead}=await import('../server/lifecycle/browser-asset-read.mjs');for(const path of ['wp-includes/js/dist/rich-text.min.js?ver=1','wp-admin/load-scripts.php?c=1&load%5Bchunk_0%5D=jquery,wp-hooks&ver=1']){let calls=0;const reply=await retryBrowserAssetRead(async()=>{if(++calls===1)throw Object.assign(Error(),{code:'network_timeout'});return {status:200,text:'core loaded'};},{url:'https://wp.example/blog/'+path,baseUrl:'https://wp.example/blog/',method:'GET',resourceType:'script'});assert.equal(calls,2);assert.equal(reply.status,200);}
});
test('writes, pages, API requests, unsafe assets and cancelled reads are never replayed',async()=>{
 const {retryBrowserAssetRead}=await import('../server/lifecycle/browser-asset-read.mjs'),base={baseUrl:'https://wp.example/',method:'GET',resourceType:'script'};const controller=new AbortController();controller.abort();
 for(const extra of [{url:'https://wp.example/wp-admin/post.php',method:'POST'},{url:'https://wp.example/wp-admin/post-new.php',resourceType:'document'},{url:'https://wp.example/wp-json/wp/v2/pages/71'},{url:'https://other.example/wp-includes/a.js'},{url:'https://wp.example/wp-includes/handler.php/a.js'},{url:'https://wp.example/wp-includes/a.js?action=delete'},{url:'https://wp.example/wp-includes/a.js',signal:controller.signal}]){let calls=0;await assert.rejects(retryBrowserAssetRead(async()=>{calls++;throw Object.assign(Error(),{code:'network_timeout'});},{...base,...extra}),{code:'network_timeout'});assert.equal(calls,1);}
});
test('asset retry stops after two attempts and never retries access, DNS policy or body-limit failures',async()=>{
 const {retryBrowserAssetRead}=await import('../server/lifecycle/browser-asset-read.mjs'),input={url:'https://wp.example/wp-includes/core.js',baseUrl:'https://wp.example/',method:'GET',resourceType:'script'};
 for(const [code,count]of [['network_failed',2],['unsafe_address',1],['response_too_large',1],['invalid_headers',1]]){let calls=0;await assert.rejects(retryBrowserAssetRead(async()=>{calls++;throw Object.assign(Error(),{code});},input),{code});assert.equal(calls,count);}
});
