const test=require('node:test'),assert=require('node:assert/strict');
test('WordPress login recognizes only the HTTPS www alias of the same installation',async()=>{
 const {canonicalLoginBase}=await import('../server/lifecycle/wordpress-canonical-login.mjs');
 assert.equal(canonicalLoginBase('https://site.example/','https://www.site.example/wp-login.php'),'https://www.site.example/');
 assert.equal(canonicalLoginBase('https://www.site.example/blog/','https://site.example/blog/wp-login.php?reauth=1'),'https://site.example/blog/');
 for(const target of ['https://evil.example/wp-login.php','https://site.example.evil.example/wp-login.php','https://admin.site.example/wp-login.php','https://www.site.example:8443/wp-login.php','https://www.site.example/other/wp-login.php','https://www.site.example/wp-login.php?action=logout','http://www.site.example/wp-login.php','https://user:pass@www.site.example/wp-login.php'])assert.equal(canonicalLoginBase('https://site.example/',target),null,target);
});

test('a pre-login server redirect can discover a child WordPress installation and validate the full chain',async()=>{
 const {redirectedLoginBase,canonicalLoginProofBase}=await import('../server/lifecycle/wordpress-canonical-login.mjs');
 const requested='https://site.example/',alias='https://www.site.example/',installed='https://www.site.example/wp/';
 const steps=[{kind:'redirect',from:requested+'wp-login.php',to:alias+'wp-login.php'},{kind:'redirect',from:alias+'wp-login.php',to:installed+'wp-login.php'}];
 assert.equal(redirectedLoginBase(alias,alias+'wp-login.php',installed+'wp-login.php'),installed);
 assert.equal(canonicalLoginProofBase(requested,{requestedBaseUrl:requested,baseUrl:installed,steps}),installed);
 for(const target of ['https://evil.example/wp/wp-login.php','http://www.site.example/wp/wp-login.php','https://www.site.example/wp/wp-login.php?action=logout','https://www.site.example/wp/wp-login.php#x','https://www.site.example/wp/other.php'])assert.equal(redirectedLoginBase(alias,alias+'wp-login.php',target),null,target);
 assert.equal(redirectedLoginBase(installed,installed+'wp-login.php',alias+'other/wp-login.php'),null);
 assert.equal(redirectedLoginBase(alias,alias+'wp-admin/',installed+'wp-login.php'),null);
 assert.equal(canonicalLoginProofBase(requested,{requestedBaseUrl:requested,baseUrl:installed}),null,'a browser label without server redirect evidence cannot change the installation path');
 assert.equal(canonicalLoginProofBase(requested,{requestedBaseUrl:requested,baseUrl:installed,steps:[{kind:'form',from:requested+'wp-login.php',to:installed+'wp-login.php'}]}),null);
 for(const proof of [null,{}, {requestedBaseUrl:requested,baseUrl:'not a URL'}, {requestedBaseUrl:requested,baseUrl:'http://www.site.example/wp/'}, {requestedBaseUrl:requested,baseUrl:installed,steps:[null]}, {requestedBaseUrl:requested,baseUrl:installed,steps:[{kind:'redirect',from:'not a URL',to:installed+'wp-login.php'}]}])assert.equal(canonicalLoginProofBase(requested,proof),null);
});
