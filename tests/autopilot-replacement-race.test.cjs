'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwrightPath=require('./browser-runtime.cjs').playwrightPath,chromePath=require('./browser-runtime.cjs').chromePath;
const browserOptions={timeout:30000,skip:!(fs.existsSync(playwrightPath)&&fs.existsSync(chromePath))};
async function fixture(t,delayed){
 const {chromium}=require(playwrightPath),root=path.resolve(__dirname,'../dist'),errors=[],calls=[];let release,entered;
 const hold=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const server=http.createServer((req,res)=>{const file=path.resolve(root,new URL(req.url,'http://localhost').pathname.slice(1)||'autopilot.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':{'.html':'text/html','.js':'application/javascript','.css':'text/css'}[path.extname(file)]||'text/plain'});res.end(fs.readFileSync(file));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--disable-background-networking','--no-first-run']}),context=await browser.newContext();
 t.after(async()=>{release();await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));assert.deepEqual(errors,[]);});
 const pages=['A','B'].map(id=>({id,projectId:'p1',revision:4,title:'Page '+id,fullUrl:'https://published.example/'+id+'/',verification:{state:'ok'}}));
 let jobs=[];
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  const endpoint=url.pathname.replace('/api/lifecycle','');calls.push(endpoint);let data;
  if(endpoint==='/projects')data={projects:[{id:'p1',name:'Project',revision:1}]};
  else if(endpoint==='/autopilot/status')data={source:{configured:false},aiConfigured:true};
  else if(endpoint==='/projects/p1/pages')data={pages};
  else if(endpoint==='/projects/p1/overview')data={pages:[],incidents:[]};
  else if(endpoint==='/projects/p1/autopilot')data={runs:[]};
  else if(endpoint==='/projects/p1/jobs')data={jobs};
  else if(/^\/pages\/[AB]\/placements$/.test(endpoint)){const id=endpoint.split('/')[2];data={pageRevision:4,placements:[{id:'cta',label:'Page '+id+' CTA',url:'https://page-'+id.toLowerCase()+'.example/',anchor:'Page '+id,anchorEditable:true}]};}
  else if(endpoint==='/pages/A/proposals')data={proposal:{id:'proposalA',revision:1,diff:[{label:'Page A proposal',before:{url:'https://page-a.example/'},after:{url:'https://new-a.example/'}}]}};
  else if(endpoint==='/proposals/proposalA/confirm'){jobs=[{id:'replaceA',projectId:'p1',pageId:'A',state:'queued',type:'replace'}];data={job:jobs[0]};}
  else return route.fulfill({status:404,contentType:'application/json',body:'{}'});
  if(endpoint===delayed){entered();await hold;}
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/autopilot.html');await page.getByRole('heading',{name:'Page A',exact:true}).waitFor();
 async function releaseResponse(){const received=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/lifecycle'+delayed);release();await (await received).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
 const open=id=>page.locator('.ap-page').filter({hasText:'Page '+id}).getByRole('button',{name:'Замінити посилання',exact:true}).click();
 const close=()=>page.getByRole('button',{name:'Закрити заміну посилань',exact:true}).click();
 async function propose(){await page.locator('[name=replacementSelected]').check();await page.locator('[name=replacementUrl]').fill('https://new-a.example/');await page.getByRole('button',{name:'Показати зміни',exact:true}).click();}
 return {page,calls,started,releaseResponse,open,close,propose};
}
test('late placement responses cannot replace a newer page replacement session',browserOptions,async t=>{
 const f=await fixture(t,'/pages/A/placements');await f.open('A');await f.started;await f.open('B');assert.equal(await f.page.locator('[name=replacementUrl]').inputValue(),'https://page-b.example/');await f.releaseResponse();assert.equal(await f.page.locator('[name=replacementUrl]').inputValue(),'https://page-b.example/');
});
test('closing a pending proposal keeps its late response out of another page dialog',browserOptions,async t=>{
 const f=await fixture(t,'/pages/A/proposals');await f.open('A');await f.propose();await f.started;await f.close();await f.open('B');await f.releaseResponse();assert.equal(await f.page.locator('#ap-replacement-form').count(),1);assert.equal(await f.page.locator('[name=replacementUrl]').inputValue(),'https://page-b.example/');assert.equal(await f.page.getByRole('button',{name:'Підтвердити заміну',exact:true}).count(),0);
});
test('late confirmed jobs remain tracked without closing a newer replacement dialog',browserOptions,async t=>{
 const f=await fixture(t,'/proposals/proposalA/confirm');await f.open('A');await f.propose();await f.page.getByRole('button',{name:'Підтвердити заміну',exact:true}).click();await f.started;await f.close();await f.open('B');await f.releaseResponse();assert.equal(await f.page.locator('#ap-replacement').evaluate(dialog=>dialog.open),true);assert.equal(await f.page.locator('[name=replacementUrl]').inputValue(),'https://page-b.example/');await f.page.waitForFunction(()=>document.querySelector('#ap-replacement').open);assert.ok(f.calls.includes('/projects/p1/jobs'),'Accepted background write must remain tracked');
});
