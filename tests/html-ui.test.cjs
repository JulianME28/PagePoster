'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const generator=require('../dist/generator.js');
const source=fs.readFileSync(path.join(__dirname,'../dist/app.js'),'utf8');
const STORAGE='pageposter.micro.v1';
const clone=value=>JSON.parse(JSON.stringify(value));

class Element {
  constructor(id=''){this.id=id;this.dataset={};this.handlers={};this.hidden=false;this.disabled=false;this.open=false;this.value='';this.textContent='';this.innerHTML='';this.scrollTop=0;this.files=[];this.classList={toggle(){},add(){},remove(){}};}
  addEventListener(name,callback){(this.handlers[name]||(this.handlers[name]=[])).push(callback);}
  async emit(name,event={}){for(const callback of this.handlers[name]||[])await callback({target:this,...event});}
  click(){return this.emit('click');}
  closest(selector){if(selector.includes('data-path')&&this.dataset.path)return this;if(selector==='[data-html-action]'&&this.dataset.htmlAction)return this;return null;}
  querySelectorAll(){return [];}
  querySelector(){return null;}
  setAttribute(){}
  focus(){}
  select(){}
  scrollIntoView(){}
  remove(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
  getBoundingClientRect(){return {left:0,right:1,top:0,bottom:1};}
}
function harness(saved,downloads) {
  const elements=new Map();
  const get=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};
  const tabs=['base','cards','blocks','content','design','html','ai'].map(value=>{const item=new Element();item.dataset.tab=value;return item;});
  const views=['preview','code'].map(value=>{const item=new Element();item.dataset.view=value;return item;});
  const devices=['desktop','mobile'].map(value=>{const item=new Element();item.dataset.device=value;return item;});
  const storage=new Map(saved?[[STORAGE,JSON.stringify(saved)]]:[]);
  const blobs=[],copies=[],timers=new Map();let nextTimer=0;
  const analyze=data=>{
    if(data.importHtml==='BROKEN')return {error:true,title:'',headings:[],warnings:['Некоректний HTML.'],stats:{},hasHeader:false,hasFooter:false,addHeader:false,addFooter:false};
    const header=(data.importHtml||'').includes('<header>'),footer=(data.importHtml||'').includes('<footer>');
    return {title:'<img src=x onerror=alert(1)>',headings:[{id:'title',text:'<script>bad</script>'}],warnings:[],stats:{headings:1,links:2,images:1},hasHeader:header,hasFooter:footer,addHeader:data.importChrome!=='none',addFooter:data.importChrome!=='none'};
  };
  const core={...generator,analyzeHTML:analyze,analyzeLinks:()=>({urls:['https://example.com/offer?a=1&b=2','https://example.com/offer?a=2'],uniqueCount:2,totalControls:4,duplicateControls:2}),renderSnippet:data=>'<div>'+data.contentMode+'</div>',renderDocument:()=>'<html><head></head><body>Preview</body></html>',validateConfig:()=>[]};
  const document={getElementById:get,querySelectorAll:selector=>selector==='[data-tab]'?tabs:selector==='[data-view]'?views:selector==='[data-device]'?devices:[],createElement:()=>new Element(),body:{append(){}}};
  const window={PagePoster:core,PagePosterDownloads:downloads};
  const context={window,document,location:{protocol:'http:'},navigator:{clipboard:{writeText:async value=>{copies.push(value);}}},localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},TextEncoder,Blob,Uint8Array,atob,URL:{createObjectURL(blob){blobs.push(blob);return 'blob:test';},revokeObjectURL(){}},setTimeout(callback){const id=++nextTimer;timers.set(id,callback);return id;},clearTimeout(id){timers.delete(id);}};
  vm.runInNewContext(source,context);
  return {
    get,blobs,copies,storage,tabs,
    project:()=>JSON.parse(storage.get(STORAGE)||JSON.stringify(saved||generator.DEFAULT_DATA)),
    async tab(value){await tabs.find(item=>item.dataset.tab===value).click();},
    async input(name,value){const control=new Element();control.dataset.path=name;control.type=typeof value==='boolean'?'checkbox':'text';control.value=value;control.checked=value;await get('form-panel').emit('input',{target:control});},
    async action(name){const control=new Element();control.dataset.htmlAction=name;await get('form-panel').emit('click',{target:control});},
    async file(file){get('html-import-file').files=[file];await get('html-import-file').emit('change');},
    flush(){const pending=[...timers.values()];timers.clear();pending.forEach(callback=>callback());}
  };
}

test('HTML mode is explicit and switching preserves builder content and imported source',async()=>{
  const h=harness();
  await h.tab('html');
  const originalTitle=h.project().title;
  await h.input('importHtml','<main><h1>Imported</h1></main>');
  assert.equal(h.project().contentMode,'builder');
  await h.input('contentMode','html');h.flush();
  assert.equal(h.project().title,originalTitle);
  assert.equal(h.project().importHtml,'<main><h1>Imported</h1></main>');
  await h.tab('cards');
  assert.match(h.get('form-panel').innerHTML,/Поля конструктора збережені/);
  assert.doesNotMatch(h.get('form-panel').innerHTML,/data-path="cards\.0/);
  await h.action('builder');
  assert.equal(h.project().contentMode,'builder');
  assert.equal(h.project().importHtml,'<main><h1>Imported</h1></main>');
  assert.equal(h.project().title,originalTitle);
});
test('HTML files load as text and wrong or oversized files leave the previous source intact',async()=>{
  const h=harness();
  await h.input('importHtml','<p>Previous</p>');
  await h.file({name:'ready.HTML',size:40,text:async()=>'\uFEFF<main>Imported</main>'});
  assert.equal(h.project().importHtml,'<main>Imported</main>');
  assert.equal(h.project().contentMode,'builder');
  assert.equal(h.get('html-import-file').value,'');
  await h.file({name:'large.html',size:500001,text:async()=>{throw new Error('must not read');}});
  assert.equal(h.project().importHtml,'<main>Imported</main>');
  assert.match(h.get('toast').textContent,/500 KB/);
  await h.file({name:'code.js',size:10,text:async()=>'<p>Wrong file</p>'});
  assert.equal(h.project().importHtml,'<main>Imported</main>');
  assert.match(h.get('toast').textContent,/розширенням/);
});
test('oversized pasted or synthetic text is rejected without truncating the previous source',async()=>{
  const h=harness();
  await h.input('importHtml','<p>Keep me</p>');
  const control=new Element();control.dataset.path='importHtml';control.value='<p>Keep me</p>';control.selectionStart=0;control.selectionEnd=0;
  let prevented=false;
  await h.get('form-panel').emit('paste',{target:control,clipboardData:{getData:()=>'<'.repeat(500001)},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  await h.input('importHtml','x'.repeat(500001));
  assert.equal(h.project().importHtml,'<p>Keep me</p>');
});
test('metadata is escaped and brand controls stay available for a newly added footer',async()=>{
  const h=harness();
  await h.tab('html');await h.input('importHtml','<header>Original</header><h1>Title</h1>');
  await h.input('contentMode','html');h.flush();
  assert.match(h.get('html-analysis').innerHTML,/&lt;img/);
  assert.match(h.get('html-analysis').innerHTML,/&lt;script&gt;/);
  assert.doesNotMatch(h.get('html-analysis').innerHTML,/<script>|<img src=x/);
  assert.equal(h.get('html-header-fields').disabled,false);
  assert.equal(h.get('html-footer-fields').disabled,false);
  await h.input('importHtml','<header>Original</header><main>Body</main><footer>Original</footer>');h.flush();
  assert.equal(h.get('html-header-fields').disabled,false);
  assert.equal(h.get('html-footer-fields').disabled,false);
  await h.input('importChrome','none');h.flush();
  assert.equal(h.get('html-header-fields').disabled,true);
  assert.equal(h.get('html-footer-fields').disabled,true);
  await h.input('importChrome','add');h.flush();
  assert.equal(h.get('html-header-fields').disabled,false);
});
test('empty or failed HTML cannot be copied or exported while JSON backup stays available',async()=>{
  const h=harness();
  await h.tab('html');await h.input('contentMode','html');h.flush();
  assert.equal(h.get('copy-main').disabled,true);
  assert.equal(h.get('download-page').disabled,true);
  await h.get('copy-main').click();
  assert.equal(h.copies.length,0);
  await h.input('importHtml','BROKEN');h.flush();
  assert.equal(h.get('download-snippet').disabled,true);
  await h.get('download-snippet').click();
  assert.equal(h.blobs.length,0);
  await h.get('backup-btn').click();
  const backup=JSON.parse(await h.blobs[0].text());
  assert.equal(backup.contentMode,'html');
  assert.equal(backup.importHtml,'BROKEN');
  await h.input('importHtml','<p>Ready</p>');h.flush();
  assert.equal(h.get('copy-main').disabled,false);
  await h.get('copy-main').click();
  assert.equal(h.copies.length,1);
});
test('saved HTML drafts reopen in the HTML tab with mode and options preserved',()=>{
  const saved={...clone(generator.DEFAULT_DATA),contentMode:'html',importHtml:'<p>Saved</p>',importBaseUrl:'https://example.com/article/',importChrome:'none',importReplaceHeader:true,importReplaceFooter:false};
  const h=harness(saved);
  assert.match(h.get('form-panel').innerHTML,/Сторінка з готового HTML/);
  assert.match(h.get('form-panel').innerHTML,/&lt;p&gt;Saved&lt;\/p&gt;/);
  assert.equal(h.project().contentMode,'html');
  assert.equal(h.project().importBaseUrl,'https://example.com/article/');
  assert.equal(h.project().importReplaceHeader,true);
  assert.equal(h.project().importChrome,'none');
});
test('a file completing after another edit does not overwrite that edit',async()=>{
  const h=harness();
  let finish;
  const pending=h.file({name:'slow.html',size:10,text:()=>new Promise(resolve=>{finish=resolve;})});
  await h.input('importHtml','<p>Manual edit</p>');
  finish('<p>Slow file</p>');await pending;
  assert.equal(h.project().importHtml,'<p>Manual edit</p>');
  assert.match(h.get('toast').textContent,/змінилася під час читання/);
});

test('JSON import restores HTML source, mode and wrapper choices after confirmation',async()=>{
  const h=harness();
  const saved={...clone(generator.DEFAULT_DATA),contentMode:'html',importHtml:'<main>From JSON</main>',importBaseUrl:'https://example.com/page/',importReplaceHeader:true,importReplaceFooter:true};
  h.get('import-file').files=[{size:1000,text:async()=>JSON.stringify(saved)}];
  const pending=h.get('import-file').emit('change');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.get('confirm-dialog').open,true);
  await h.get('confirmation-accept').click();
  await pending;
  assert.equal(h.project().contentMode,'html');
  assert.equal(h.project().importHtml,'<main>From JSON</main>');
  assert.equal(h.project().importBaseUrl,'https://example.com/page/');
  assert.equal(h.project().importReplaceFooter,true);
  assert.match(h.get('form-panel').innerHTML,/Сторінка з готового HTML/);
});


test('HTML chrome choices preserve the source and expose source replacement only as an explicit advanced option',async()=>{
  const h=harness();
  await h.tab('html');await h.input('contentMode','html');
  const original='<header><h1>Original hero</h1></header><main>Body</main><footer>Original disclosure</footer>';
  await h.input('importHtml',original);h.flush();
  assert.match(h.get('form-panel').innerHTML,/Додати наш хедер і футер/);
  assert.match(h.get('form-panel').innerHTML,/Лише мій HTML/);
  assert.match(h.get('form-panel').innerHTML,/Розширені налаштування/);
  await h.input('importChrome','none');h.flush();
  assert.equal(h.project().importHtml,original);
  assert.equal(h.project().importReplaceHeader,false);
  assert.equal(h.project().importReplaceFooter,false);
  assert.equal(h.project().importChrome,'none');
  await h.input('importChrome','bad-value');
  assert.equal(h.project().importChrome,'none');
  assert.match(h.get('html-header-note').textContent,/Лише мій HTML/);
  await h.input('importChrome','add');h.flush();
  assert.equal(h.get('html-header-fields').disabled,false);
  assert.equal(h.project().importHtml,original);
});

test('output audit shows exact unique destinations and script requirement without creating extra outbound anchors',()=>{
  const h=harness();
  assert.match(h.get('link-audit-count').textContent,/2/);
  assert.match(h.get('link-audit-list').innerHTML,/https:\/\/example.com\/offer\?a=1&amp;b=2/);
  assert.doesNotMatch(h.get('link-audit-list').innerHTML,/<a[ >]/);
  assert.match(h.get('link-audit-note').textContent,/2/);
  assert.doesNotMatch(h.get('preview-status').textContent,/без скриптів/);
});

test('clean links plugin downloads exact bundled ZIP bytes and reports a missing bundle',async()=>{
  const bytes=Buffer.from([0x50,0x4b,0x03,0x04,0xff,0x00,0x41]);
  const h=harness(undefined,{cleanLinks:{filename:'pageposter-clean-links-1.1.1.zip',base64:bytes.toString('base64'),version:'1.1.1'}});
  await h.get('download-clean-links').click();
  assert.equal(h.blobs.length,1);
  assert.equal(h.blobs[0].type,'application/zip');
  assert.deepEqual(Buffer.from(await h.blobs[0].arrayBuffer()),bytes);
  assert.match(h.get('plugin-version').textContent,/1.1.1/);
  const absent=harness();
  assert.equal(absent.get('download-clean-links').disabled,true);
  await absent.get('download-clean-links').click();
  assert.equal(absent.blobs.length,0);
});

test('preview executes generated navigation in an opaque sandbox',()=>{
  const index=fs.readFileSync(path.join(__dirname,'fixtures/legacy-editor.html'),'utf8');
  const sandbox=index.match(/<iframe[^>]*id="preview-frame"[^>]*sandbox="([^"]+)"/)[1].split(/\s+/);
  assert.ok(sandbox.includes('allow-scripts'));
  assert.ok(sandbox.includes('allow-popups'));
  assert.ok(!sandbox.includes('allow-same-origin'));
  assert.match(index,/дубльованих кнопок/);
});
