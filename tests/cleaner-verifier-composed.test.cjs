'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const {chromium}=require('./browser-runtime.cjs').playwright;
const runtime=require('../dist/page-runtime.js');
const executablePath=require('./browser-runtime.cjs').chromePath,url='https://site.example/offer/',partner='https://partner.example/go?a=%2f&offer=7#offer';
const php56=require('./qa/php-runtime.cjs').resolvePHP56();
const plugin=path.resolve(__dirname,'../wordpress/pageposter-clean-links/pageposter-clean-links.php');
const html=runtime.prepare('<style>body{margin:0}#pp-landing{padding:20px}a,button{display:inline-block;padding:12px}</style><div id="pp-landing"><h1>Fresh title</h1><a href="https://partner.example/go?a=%2f&amp;offer=7#offer">Exact anchor</a><button data-pp-url="https://partner.example/go?a=%2f&amp;offer=7#offer">Repeated offer</button></div>');
function clean(source=html,hosts={}){
 const r=spawnSync(php56,['-n',path.join(__dirname,'fixtures/clean-links-published.php')],{encoding:'utf8',input:source,env:{...process.env,PP_CANVAS_PLUGIN:plugin,...hosts},timeout:30000,windowsHide:true});
 assert.equal(r.status,0,r.stderr||r.stdout);assert.match(r.stdout,/<script id="pageposter-clean-links-runtime">/);return r.stdout;
}
async function verifier(published,headers={}){const {createBrowserVerifier}=await import('../server/lifecycle/browser-check.mjs');return createBrowserVerifier({chromium,executablePath,timeoutMs:20000,transport:async(address)=>{assert.equal(address,url);return {status:200,url,headers:{'content-type':'text/html',...headers},text:published};}});}
async function prepare(published){return (await import('../server/lifecycle/published-snapshot.mjs')).preparePublished({url,text:published},async()=>{throw Error('No assets expected');});}

test('actual PHP cleaner output passes the real public verifier, store and terminal autopilot check',async t=>{
 const packaged=require('../server/lifecycle/plugin-integrity.cjs').archiveRuntimeHashes(fs.readFileSync(path.join(__dirname,'../assets/pageposter-clean-links-1.1.3.zip')),'pageposter-clean-links');
 assert.equal(packaged['pageposter-clean-links.php'],createHash('sha256').update(fs.readFileSync(plugin)).digest('hex'),'The actual PHP fixture must be identical to the shipped plugin runtime.');
 const published=clean(),requests=[],transport=async(address,init)=>{
  requests.push(address);assert.equal(address,url);assert.equal(init.method,'GET');assert.equal(init.sameOriginOnly,true);
  assert.ok(!init.headers.authorization&&!init.headers.cookie);
  return {status:200,url,headers:{'content-type':'text/html'},text:published};
 };
 const browserVerifier=await verifier(published),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-cleaner-composed-'));
 const {createLifecycleService}=await import('../server/lifecycle/service.mjs');
 const app=await createLifecycleService({dataDir:dir,masterKey:Buffer.alloc(32,67).toString('base64'),browserVerifier,proxyOptions:{directTransport:transport},client:{checkPage:async()=>['public','content','wp_access','wp_status','wp_content','noindex','robots','links'].map(kind=>({kind,state:'ok',evidence:'fixture'}))}});
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const s=app.store,project=s.createProject({name:'Composed cleaner'}),site=s.createSite(project.id,{name:'Fixture',baseUrl:'https://site.example/'});
 const page=s.createPage(project.id,{title:'Fresh title',siteId:site.id,wpId:71,fullUrl:url,expectedUrls:[partner],expectedMarker:'pp-landing',remoteSnapshot:{content:html}});
 const job=s.enqueueJob({projectId:project.id,pageId:page.id,siteId:site.id,type:'page_check',idempotencyKey:'cleaner-composed'});
 const run=s.createRecord(project.id,'autopilot',{state:'checking',stage:'checking',pageId:page.id,checkJobId:job.id,links:[]});
 await app.tick();const check=s.listChecks(page.id).find(c=>c.kind==='live_browser');
 assert.equal(check.state,'ok',JSON.stringify(check));assert.equal(s.getPage(page.id).verification.state,'ok');
 await app.tick();assert.equal(s.getRecord(run.id).state,'completed');assert.equal(s.getRecord(run.id).error,null);
 assert.equal(s.listJobs(project.id).length,1,'Verification must not schedule a publication.');
 assert.deepEqual(requests,[url],'The service public transport must remain inside the anonymous fixture.');
});

test('cleaner recognition is exact and rejects spoofed IDs, mutated bytes, src and unexpected host payloads',async()=>{
 const published=clean(),script=published.match(/<script id="pageposter-clean-links-runtime">([\s\S]*?)<\/script>/)[0];
 for(const candidate of [script.replace(" 'use strict';"," 'use strict';window.__pwned=1;"),script.replace('["site.example","site.example"]','["site.example","evil.example"]'),script.replace('["site.example","site.example"]','["site.example",(window.__pwned=1)]'),script.replace('["site.example","site.example"]','["site.example","site.exampl\\u0065"]'),script.replace('<script id=','<script type="module" id='),script.replace('<script id=','<script type="application/json" id='),script.replace('<script id=','<script src="" id='),script.replace('<script id=','<script src="https://evil.example/a.js" id='),'<script id="pageposter-clean-links-runtime">fetch("https://evil.example/")</script>']){
  const result=await prepare(published.replace(script,candidate));assert.equal(result.network.untrustedScripts,1,candidate.slice(0,100));assert.equal(result.html.includes('__pwned'),false);
 }
 const normalized=await prepare(clean(html,{PP_HOME_HOST:'WWW.SITE.EXAMPLE.',PP_SITE_HOST:'www.site.example'}));assert.equal(normalized.network.untrustedScripts,0);
 const malicious=published.replace(script,script.replace('["site.example","site.example"]','["site.example","evil.example"]'));
 const result=await (await verifier(malicious)).verifyPublished({url,expectedHtml:html,expectedUrls:[partner]});assert.equal(result.state,'unknown');assert.equal(result.code,'unsupported_page_scripts');assert.equal(result.network.untrustedScripts,1);
});

test('cleaner execution is verified when public CSP allows the PagePoster runtime but blocks cleaner',async()=>{
 const published=clean(),{runtimeHash}=await import('../server/lifecycle/published-snapshot.mjs');
 const result=await (await verifier(published,{'content-security-policy':"script-src 'sha256-"+runtimeHash+"'"})).verifyPublished({url,expectedHtml:html,expectedUrls:[partner]});
 assert.equal(result.state,'problem');assert.ok(result.viewports.every(v=>v.checks.some(c=>c.kind==='clean_links_runtime'&&c.state==='problem')));
});
