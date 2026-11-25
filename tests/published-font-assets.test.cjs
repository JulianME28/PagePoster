const test=require('node:test'),assert=require('node:assert/strict');
const mod=import('../server/lifecycle/published-snapshot.mjs'),pageUrl='https://site.example/page/',cssUrl='https://fonts.googleapis.com/css2?family=Inter&display=swap',fontUrl='https://fonts.gstatic.com/s/inter/v1/example.woff2';
const response=text=>({status:200,url:pageUrl,headers:{'content-type':'text/html'},text});
test('published snapshots load the Google Fonts stylesheets already supported by HTML import without credentials',async()=>{
 const calls=[],transport=async(url,options)=>{calls.push({url,options});return url===cssUrl?{status:200,url,headers:{'content-type':'text/css'},body:Buffer.from('@font-face{font-family:Inter;src:url('+fontUrl+')}')}:{status:200,url,headers:{'content-type':'font/woff2'},body:Buffer.from([119,79,70,50,0])};};
 const result=await(await mod).preparePublished(response('<link rel="stylesheet" href="'+cssUrl+'"><div id="pp-landing">Hello</div>'),transport);
 assert.equal(result.network.blockedAssets,0);assert.equal(result.network.failedAssets,0);assert.equal(result.network.fetchedAssets,2);assert.deepEqual(calls.map(c=>c.url),[cssUrl,fontUrl]);assert.match(result.html,/data:font\/woff2;base64/);assert.ok(calls.every(c=>c.options.method==='GET'&&c.options.sameOriginOnly===true&&!c.options.headers.cookie&&!c.options.headers.authorization));
});
test('font host lookalikes, arbitrary CSS and cross-origin redirects remain blocked',async()=>{
 const calls=[],transport=async url=>{calls.push(url);return{status:200,url:'https://evil.example/leak',headers:{'content-type':'text/css'},text:'body{color:red}'};};
 const urls=['https://fonts.googleapis.com.evil.example/css2','https://fonts.googleapis.com:8443/css2','https://fonts.googleapis.com/not-css','https://other.example/theme.css','https://fonts.gstatic.com/tracking.woff2'];
 const result=await(await mod).preparePublished(response(urls.map(u=>'<link rel="stylesheet" href="'+u+'">').join('')+'<link rel="stylesheet" href="'+cssUrl+'"><div id="pp-landing">Text</div>'),transport);
 assert.deepEqual(calls,[cssUrl]);assert.ok(result.network.blockedAssets>=urls.length);assert.equal(result.network.failedAssets,1);assert.doesNotMatch(result.html,/body\{color:red\}/);
});
