const test=require('node:test'),assert=require('node:assert/strict');

const asset='https://wordpress.example/wp-includes/js/editor.js?ver=6.8.3';
const reply=({status=200,type='application/javascript',headers={},body='window.fixture = true;'}={})=>({status,headers:{...(type?{'Content-Type':type}:{}),...headers},body});
const cacheFactory=async options=>(await import('../server/lifecycle/browser-assets.mjs')).createBrowserAssetCache(options);

test('versioned static assets are copied into and out of the session cache',async()=>{
 const cache=await cacheFactory(),response=reply({body:Buffer.from('fixture bytes')});
 assert.equal(cache.put(asset,'script','GET',response),true);
 response.body.fill(120);response.headers['Content-Type']='text/html';
 const cached=cache.get(asset,'script');
 assert.deepEqual(cached,{status:200,headers:{'content-type':'application/javascript'},body:Buffer.from('fixture bytes')});
 cached.body.fill(121);cached.headers['content-type']='text/html';
 assert.equal(cache.get(asset,'script').body.toString(),'fixture bytes');
 assert.equal(cache.get(asset,'script').headers['content-type'],'application/javascript');
});

test('static extensions require their matching browser resource type and MIME',async()=>{
 const rows=[
  ['js','script','text/javascript; charset=utf-8'],['css','stylesheet','text/css'],
  ['woff','font','font/woff'],['woff2','font','font/woff2'],
  ['png','image','image/png'],['jpg','image','image/jpeg'],['jpeg','image','image/jpeg'],
  ['gif','image','image/gif'],['svg','image','image/svg+xml'],['ico','image','image/x-icon'],['webp','image','image/webp']
 ];
 for(const [extension,type,mime]of rows){
  const cache=await cacheFactory(),url='https://wordpress.example/wp-content/assets/file.'+extension+'?version=1';
  assert.equal(cache.put(url,type,'GET',reply({type:mime})),true,extension);
  assert.ok(cache.get(url,type),extension);
  assert.equal(cache.get(url,type==='image'?'script':'image'),null,extension);
  assert.equal(cache.put(url,type,'GET',reply({type:'text/html'})),false,extension);
 }
});

test('only validated HTTPS static paths and version-only query fields are eligible',async()=>{
 const cache=await cacheFactory(),invalid=[
  'http://wordpress.example/wp-includes/js/editor.js?ver=1',
  'https://user:password@wordpress.example/wp-includes/js/editor.js?ver=1',
  'https://localhost/wp-includes/js/editor.js?ver=1',
  'https://127.0.0.1/wp-includes/js/editor.js?ver=1',
  'https://wordpress.example/wp-admin/load-scripts.php?ver=1',
  'https://wordpress.example/wp-json/fixture.js?ver=1',
  'https://wordpress.example/wp-content/fixture.php?ver=1',
  'https://wordpress.example/wp-content/fixture.php/editor.js?ver=1',
  'https://wordpress.example/wp-content/fixture.php;path/editor.js?ver=1',
  'https://wordpress.example/wp-content/../wp-admin/editor.js?ver=1',
  'https://wordpress.example/wp-content/%2fwp-admin/editor.js?ver=1',
  'https://wordpress.example/wp-content/fixture.html?ver=1',
  asset+'&action=edit',asset+'&_wpnonce=fixture',asset+'&rest_route=/wp/v2/pages',
  asset+'&token=fixture',asset+'#private',asset.replace('ver=6.8.3','ver='),'not a URL'
 ];
 for(const url of invalid){assert.equal(cache.put(url,'script','GET',reply()),false,url);assert.equal(cache.get(url,'script'),null,url);}
 for(const field of ['ver','v','version'])assert.equal(cache.put(asset.replace('ver=6.8.3',field+'=fixture-1'),'script','GET',reply()),true,field);
 assert.equal(cache.put(asset,'script','POST',reply()),false);assert.equal(cache.put(asset,'fetch','GET',reply()),false);
 assert.equal(cache.get(asset,'script','POST'),null);assert.equal(cache.get(asset,'document'),null);
});

test('personalized, non-cacheable, challenge, and failed responses are never stored',async()=>{
 const rows=[
  reply({status:302}),reply({status:403}),reply({status:500}),reply({type:'text/html'}),reply({type:''}),
  reply({headers:{'Set-Cookie':'wordpress_logged_in_fixture=admin'}}),
  reply({headers:{'SET-COOKIE':[]}}),reply({headers:{Authorization:'Bearer fixture'}}),
  reply({headers:{'WWW-Authenticate':'Basic realm="fixture"'}}),
  reply({headers:{'Authentication-Info':'nextnonce="fixture"'}}),
  reply({headers:{Vary:'*'}}),reply({headers:{Vary:'Accept-Encoding, Cookie'}}),
  reply({headers:{Vary:'Authorization'}}),reply({headers:{Vary:'Accept-Language'}}),
  reply({headers:{'Cache-Control':'public, no-store'}}),reply({headers:{'Cache-Control':'NO-CACHE'}}),
  reply({headers:{'Cache-Control':'private="Set-Cookie", max-age=60'}}),
  reply({headers:{'Cache-Control':'public, must-revalidate, max-age=60'}}),
  reply({headers:{'Cache-Control':'max-age=0'}}),reply({headers:{'Cache-Control':'max-age="0"'}}),
  reply({headers:{'Cache-Control':'max-age=60, max-age=0'}}),reply({headers:{'Cache-Control':'max-age=-1'}}),
  reply({headers:{'cf-mitigated':'challenge'}}),
  reply({body:'<!doctype html><html>Challenge</html>'})
 ];
 for(const response of rows){const cache=await cacheFactory();assert.equal(cache.put(asset,'script','GET',response),false,JSON.stringify(response.headers));assert.equal(cache.get(asset,'script'),null);}
 const cache=await cacheFactory();assert.equal(cache.put(asset,'script','GET',reply({headers:{Vary:'Accept-Encoding','Cache-Control':'public, max-age="60"'}})),true);
});

test('unversioned assets need positive max-age and versioned assets still obey its shorter lifetime',async()=>{
 let now=1000;const cache=await cacheFactory({clock:()=>now}),unversioned=asset.split('?')[0];
 assert.equal(cache.put(unversioned,'script','GET',reply()),false);
 assert.equal(cache.put(unversioned,'script','GET',reply({headers:{'Cache-Control':'max-age=2'}})),true);
 assert.equal(cache.put(asset,'script','GET',reply({headers:{'Cache-Control':'max-age=2'}})),true);
 now=2999;assert.ok(cache.get(asset,'script'));assert.ok(cache.get(unversioned,'script'));
 now=3000;assert.equal(cache.get(asset,'script'),null);assert.equal(cache.get(unversioned,'script'),null);
});

test('version-only and long-lived assets expire after at most five minutes',async()=>{
 let now=1000;const cache=await cacheFactory({clock:()=>now}),longLived=asset.replace('6.8.3','6.8.4');
 assert.equal(cache.put(asset,'script','GET',reply()),true);
 assert.equal(cache.put(longLived,'script','GET',reply({headers:{'Cache-Control':'max-age=31536000'}})),true);
 now=300999;assert.ok(cache.get(asset,'script'));assert.ok(cache.get(longLived,'script'));
 now=301000;assert.equal(cache.get(asset,'script'),null);assert.equal(cache.get(longLived,'script'),null);
});

test('entry and body-byte limits evict the least recently read assets',async()=>{
 const urls=['first','second','third'].map(name=>asset.replace('editor.js',name+'.js'));
 for(const options of [{maxEntries:2},{maxBytes:12}]){
  const cache=await cacheFactory(options);
  for(const url of urls.slice(0,2))assert.equal(cache.put(url,'script','GET',reply({body:'123456'})),true);
  assert.ok(cache.get(urls[0],'script'));
  assert.equal(cache.put(urls[2],'script','GET',reply({body:'123456'})),true);
  assert.equal(cache.get(urls[1],'script'),null);assert.ok(cache.get(urls[0],'script'));assert.ok(cache.get(urls[2],'script'));
 }
});

test('replacing a cached asset reclaims its old bytes and clear releases the whole session',async()=>{
 const cache=await cacheFactory({maxBytes:12}),second=asset.replace('editor.js','other.js');
 assert.equal(cache.put(asset,'script','GET',reply({body:'12345678'})),true);
 assert.equal(cache.put(asset,'script','GET',reply({body:'new'})),true);
 assert.equal(cache.put(second,'script','GET',reply({body:'12345678'})),true);
 assert.equal(cache.get(asset,'script').body.toString(),'new');assert.ok(cache.get(second,'script'));
 cache.clear();assert.equal(cache.get(asset,'script'),null);assert.equal(cache.get(second,'script'),null);
 assert.equal(cache.put(second,'script','GET',reply({body:'123456789012'})),true);
});

test('oversized bodies and disabled caches are refused without evicting a useful asset',async()=>{
 const cache=await cacheFactory(),large=Buffer.alloc(5*1024*1024,97),second=asset.replace('editor.js','other.js');
 assert.equal(cache.put(asset,'script','GET',reply({body:large})),true);
 assert.equal(cache.put(second,'script','GET',reply({body:Buffer.alloc(large.length+1)})),false);assert.ok(cache.get(asset,'script'));
 for(const options of [{maxBytes:0},{maxEntries:0},{maxBytes:4}])assert.equal((await cacheFactory(options)).put(asset,'script','GET',reply()),false);
});

test('cache entries stay private to their instance, origin, and exact asset version',async()=>{
 const first=await cacheFactory(),second=await cacheFactory();assert.equal(first.put(asset,'script','GET',reply()),true);
 assert.equal(second.get(asset,'script'),null);
 assert.equal(first.get(asset.replace('wordpress.example','other.example'),'script'),null);
 assert.equal(first.get(asset.replace('6.8.3','6.8.4'),'script'),null);
 const text={status:200,headers:{'content-type':'application/javascript'},text:'text response',request:{headers:{authorization:'fixture-private'}}};
 assert.equal(first.put(asset,'script','GET',text),true);
 assert.deepEqual(first.get(asset,'script'),{status:200,headers:{'content-type':'application/javascript'},body:Buffer.from('text response')});
});

test('unsupported extension and malformed response inputs fail closed',async()=>{
 const cache=await cacheFactory();
 assert.equal(cache.put(asset.replace('editor.js','editor.constructor'),undefined,'GET',reply()),false);
 for(const body of [null,123,{},[]])assert.equal(cache.put(asset,'script','GET',reply({body})),false);
 for(const headers of [null,[],{'Content-Type':123},{'Content-Type':'application/javascript\r\nSet-Cookie: private'}])assert.equal(cache.put(asset,'script','GET',{status:200,headers,body:'fixture'}),false);
 assert.equal(cache.put(asset,'script','GET',null),false);
});

test('expired assets are reclaimed before a still-fresh asset is evicted',async()=>{
 let now=0;const cache=await cacheFactory({clock:()=>now,maxBytes:6}),fresh=asset.replace('editor.js','fresh.js'),next=asset.replace('editor.js','next.js');
 assert.equal(cache.put(asset,'script','GET',reply({headers:{'Cache-Control':'max-age=1'},body:'old'})),true);
 assert.equal(cache.put(fresh,'script','GET',reply({body:'new'})),true);assert.ok(cache.get(asset,'script'));
 now=1000;assert.equal(cache.put(next,'script','GET',reply({body:'123'})),true);
 assert.equal(cache.get(asset,'script'),null);assert.ok(cache.get(fresh,'script'));assert.ok(cache.get(next,'script'));
});

test('configuration cannot raise the 256-entry or 32-MiB session ceiling',async()=>{
 const entries=await cacheFactory({maxEntries:512});
 for(let i=0;i<257;i++)assert.equal(entries.put(asset.replace('editor.js','editor-'+i+'.js'),'script','GET',reply()),true);
 assert.equal(entries.get(asset.replace('editor.js','editor-0.js'),'script'),null);
 assert.ok(entries.get(asset.replace('editor.js','editor-1.js'),'script'));
 const bytes=await cacheFactory({maxBytes:64*1024*1024}),body=Buffer.alloc(5*1024*1024,97);
 for(let i=0;i<7;i++)assert.equal(bytes.put(asset.replace('editor.js','editor-'+i+'.js'),'script','GET',reply({body})),true);
 assert.equal(bytes.get(asset.replace('editor.js','editor-0.js'),'script'),null);
 assert.ok(bytes.get(asset.replace('editor.js','editor-1.js'),'script'));
});
