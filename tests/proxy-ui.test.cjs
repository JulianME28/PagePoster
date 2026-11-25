const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
test('both entry documents provide the same required controls for the shared application script',()=>{
 const documents=['index.html','autopilot.html'].map(file=>new JSDOM(fs.readFileSync(path.join(__dirname,'../dist',file),'utf8')));
 try{const ids=documents.map(dom=>[...dom.window.document.querySelectorAll('[id]')].map(node=>node.id).sort());assert.deepEqual(ids[0],ids[1]);for(const dom of documents)assert.ok(dom.window.document.querySelector('script[defer][src="proxy-check-ui.js"]'),'Proxy buttons must load their event handlers');}finally{documents.forEach(dom=>dom.window.close());}
});
test('proxy check UI displays results safely and sends a pasted list without saving it',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../dist/index.html'),'utf8'),{runScripts:'outside-only',url:'http://127.0.0.1:4317/'}),w=dom.window,calls=[];
 try{const result={id:'fixture',state:'completed',source:'draft',total:1,completed:1,finishedAt:new Date().toISOString(),rows:[{index:1,server:'http://<img>:8000',state:'ok',ip:'8.8.8.8',country:'US',responseMs:120}]};w.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/settings')?{proxy:{revision:3}}:{check:options.method==='POST'?result:null}};};
 w.eval(fs.readFileSync(path.join(__dirname,'../dist/proxy-check-ui.js'),'utf8'));w.document.dispatchEvent(new w.Event('DOMContentLoaded'));w.document.getElementById('ap-proxy-list').value='a.example:8000:alice:secret';w.document.getElementById('ap-proxy-check').click();await new Promise(setImmediate);
 assert.equal(calls[1].url,'/api/lifecycle/proxy/checks');assert.equal(JSON.parse(calls[1].options.body).expectedRevision,3);assert.match(JSON.parse(calls[1].options.body).list,/alice:secret/);const table=w.document.getElementById('ap-proxy-results');assert.equal(table.hidden,false);assert.match(table.textContent,/8\.8\.8\.8/);assert.match(table.textContent,/US/);assert.match(table.textContent,/120 мс/);assert.equal(table.querySelectorAll('img').length,0);assert.doesNotMatch(table.textContent,/alice|secret/);assert.equal(w.document.getElementById('ap-proxy-list').value,'a.example:8000:alice:secret');
 }finally{w.close();}
});
for(const entry of ['index.html','autopilot.html'])test(entry+': proxy form imports a list, clears secrets and appears in its own desktop tab',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../dist',entry),'utf8'),dom=new JSDOM(html,{runScripts:'outside-only',url:'http://127.0.0.1:4317/'}),w=dom.window;const calls=[];
 try{
 w.pageposterDesktop={};w.fetch=async(_url,options)=>{calls.push(options);return {ok:true,json:async()=>({proxy:{enabled:options.method==='POST',count:options.method==='POST'?2:0,revision:options.method==='POST'?1:0,activeSessions:0,storageAvailable:true}})};};
 w.eval(fs.readFileSync(path.join(__dirname,'../dist/proxy-settings-ui.js'),'utf8'));w.document.dispatchEvent(new w.Event('DOMContentLoaded'));w.dispatchEvent(new w.CustomEvent('pageposter:settings-opened'));await new Promise(setImmediate);
 const form=w.document.getElementById('ap-proxy-form');assert.ok(form);w.document.getElementById('ap-proxy-list').value='a.example:8000:alice:secret\nb.example:8000';w.document.getElementById('ap-proxy-enabled').checked=true;form.dispatchEvent(new w.Event('submit',{cancelable:true}));await new Promise(setImmediate);
 assert.equal(JSON.parse(calls.at(-1).body).enabled,true);assert.equal(JSON.parse(calls.at(-1).body).list.split('\n').length,2);assert.equal(w.document.getElementById('ap-proxy-list').value,'');assert.doesNotMatch(w.document.getElementById('ap-proxy-status').textContent,/secret/);
 assert.ok(fs.readFileSync(path.join(__dirname,'../dist/workspace-ui.js'),'utf8').includes("['proxy','Проксі',[4]]"));
 assert.ok(fs.readFileSync(path.join(__dirname,'../dist/index.html'),'utf8').includes('src="proxy-settings-ui.js"'));
 }finally{w.close();}
});
