'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const site={baseUrl:'https://public-contract.example/'},page={fullUrl:'https://public-contract.example/guide/',expectedMarker:'pp-landing',expectedUrls:[]};
const publicKinds=['public','content','noindex','robots','links'];
const html='<html><head></head><body><div id="pp-landing"><h1>Exact content</h1></div></body></html>';
const reply=(text,type='text/html')=>({status:200,headers:{'content-type':type},text});

for(const code of ['network_timeout','network_failed','dns_failed'])test('public read exposes structured '+code+' for bounded recovery without parsing evidence',async()=>{
 const {createWordPressClient}=await import('../server/lifecycle/wordpress.mjs'),requests=[];
 const checks=await createWordPressClient({transport:async(url,init)=>{requests.push({url,method:init.method,headers:init.headers});throw Object.assign(Error('private provider detail'),{code});}}).checkPage({site,page,publicOnly:true});
 assert.equal(requests.length,1);assert.equal(requests[0].url,page.fullUrl);assert.equal(requests[0].method,'GET');assert.equal(requests[0].headers.authorization,undefined);
 for(const kind of publicKinds){const result=checks.find(value=>value.kind===kind);assert.equal(result.state,'unknown');assert.equal(result.code,code);assert.equal(result.evidence,'The public response could not be checked. ['+code+']');}
 for(const kind of ['wp_access','wp_content','wp_status']){const result=checks.find(value=>value.kind===kind);assert.equal(result.state,'not_applicable');assert.equal(Object.hasOwn(result,'code'),false);}
 assert.doesNotMatch(JSON.stringify(checks),/private provider detail/);
});

test('a robots-only transient read retains a structured code while healthy page checks stay healthy',async()=>{
 const {createWordPressClient}=await import('../server/lifecycle/wordpress.mjs');
 const checks=await createWordPressClient({transport:async url=>{if(new URL(url).pathname==='/robots.txt')throw Object.assign(Error('private resolver detail'),{code:'dns_failed'});return reply(html);}}).checkPage({site,page,publicOnly:true});
 const robots=checks.find(value=>value.kind==='robots');assert.equal(robots.state,'unknown');assert.equal(robots.code,'dns_failed');assert.equal(robots.evidence,'robots.txt could not be checked. [dns_failed]');
 for(const kind of ['public','content','noindex','links']){const result=checks.find(value=>value.kind===kind);assert.equal(result.state,'ok');assert.equal(Object.hasOwn(result,'code'),false);}
});

test('unknown provider codes become network_failed without exposing arbitrary errors',async()=>{
 const {createWordPressClient}=await import('../server/lifecycle/wordpress.mjs');
 const checks=await createWordPressClient({transport:async()=>{throw Object.assign(Error('secret-message'),{code:'secret-token\nhttps://private.example/?password=secret'});}}).checkPage({site,page,publicOnly:true});
 for(const kind of publicKinds)assert.equal(checks.find(value=>value.kind===kind).code,'network_failed');
 assert.doesNotMatch(JSON.stringify(checks),/secret|private\.example/);
});

test('structured failure codes preserve genuine indexing problems rather than relabeling them retryable',async()=>{
 const {createWordPressClient}=await import('../server/lifecycle/wordpress.mjs');
 const checks=await createWordPressClient({transport:async url=>new URL(url).pathname==='/robots.txt'?reply('User-agent: *\nDisallow: /\n','text/plain'):reply(html.replace('<head>','<head><meta name="robots" content="noindex">'))}).checkPage({site,page,publicOnly:true});
 assert.equal(checks.find(value=>value.kind==='noindex').state,'problem');assert.equal(checks.find(value=>value.kind==='noindex').code,'noindex_detected');
 assert.equal(checks.find(value=>value.kind==='robots').state,'problem');assert.equal(checks.find(value=>value.kind==='robots').code,'crawl_disallowed');
 assert.equal(checks.find(value=>value.kind==='public').state,'ok');
});
