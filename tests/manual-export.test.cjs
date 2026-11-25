const test=require('node:test'),assert=require('node:assert/strict');
const api=()=>import('../server/lifecycle/manual-export.mjs');
const original='\uFEFF<!doctype html>\r\n<!-- authored bytes -->\r\n<html><body><h1>Original Łódź</h1><a href="https://real.example.net/a%2fb?x=1&amp;x=2#part"> Exact anchor </a></body></html>\r\n';
const prepared='<style>#root{color:#123456}.offer{display:inline-block;padding:12px}.offer:hover{color:red}</style>\n<div id="root" class="page"><h1>Prepared Łódź</h1><a href="https://publisher.org/a%2fb?x=1&amp;x=2#part"> Exact anchor </a></div>';
const input=(extra={})=>({title:'Exact title',originalHtml:original,preparedHtml:prepared,...extra});
const parse=async html=>{const {JSDOM}=await import('../server/lifecycle/dom-runtime.mjs');return new JSDOM(html);};

test('manual exports distinguish byte-exact original and prepared variants and preserve current identity',async()=>{
 const {createManualExport}=await api(),identity={runId:'run-1',pageId:'page-1',pageRevision:7},ready=createManualExport(input(identity));
 assert.equal(ready.version,1);assert.equal(ready.variant,'prepared');assert.equal(ready.html,prepared);assert.equal(ready.title,'Exact title');assert.equal(ready.runId,'run-1');assert.equal(ready.pageId,'page-1');assert.equal(ready.pageRevision,7);
 assert.deepEqual(ready.available,{original:true,prepared:true,simplified:true});assert.equal(ready.audit.state,'ready');assert.equal(ready.audit.placeholderCount,0);
 const source=createManualExport(input({...identity,variant:'original'}));assert.equal(source.html,original);assert.equal(source.variant,'original');assert.notEqual(source.filename,ready.filename);assert.equal(ready.html,prepared);
 assert.ok(ready.steps.some(step=>step.includes('WordPress')));assert.ok(ready.steps.some(step=>step.includes('HTML')));assert.ok(ready.warnings.some(w=>w.code==='WORDPRESS_CSS_REQUIRED'));
});

test('AI exports advertise unavailable original and reject only the explicit missing-original request',async()=>{
 const {createManualExport}=await api(),ready=createManualExport(input({originalHtml:null}));assert.deepEqual(ready.available,{original:false,prepared:true,simplified:true});assert.equal(ready.runId,null);assert.equal(ready.pageId,null);assert.equal(ready.pageRevision,null);
 assert.throws(()=>createManualExport(input({originalHtml:null,variant:'original'})),{code:'MANUAL_ORIGINAL_UNAVAILABLE'});
});

test('manual export validation rejects unknown variants and malformed bounded content without unsafe errors',async()=>{
 const {createManualExport}=await api();
 for(const bad of [{variant:'auto'},{variant:''},{variant:null},{preparedHtml:''},{preparedHtml:42},{preparedHtml:'x'.repeat(2100000)},{originalHtml:42},{title:'bad\u0000title'},{runId:'C:\\secret'},{pageRevision:-1},{pageRevision:1.5}])assert.throws(()=>createManualExport(input(bad)),error=>error.code==='VALIDATION'&&!/secret|2100000/.test(error.message));
 assert.throws(()=>createManualExport(null),{code:'VALIDATION'});
});

test('simplified is explicit and converts prepared navigation to native anchors retaining exact URLs CSS labels and identifiers',async()=>{
 const {createManualExport}=await api(),url='https://partner.org/a%2fb?x=1&x=2&ref=%2520#part',source='<style>.offer{padding:12px;color:#123456}#cta{display:inline-block}[data-pp-url]{cursor:pointer}</style><div id="root"><h1>Exact text</h1><button id="cta" class="offer" style="border:1px solid red" data-pp-url="'+url.replaceAll('&','&amp;')+'" data-pp-target="_blank" type="button">  Exact <strong>anchor</strong>  </button><div id="tile" class="offer" role="link" tabindex="0" data-pp-url="'+url.replaceAll('&','&amp;')+'">Tile text</div><a href="#root">Jump</a></div><script>document.querySelector("#root h1").textContent="EXECUTED"</script>';
 const exact=createManualExport(input({preparedHtml:source}));assert.equal(exact.html,source);assert.equal(exact.variant,'prepared');
 const result=createManualExport(input({preparedHtml:source,variant:'simplified'})),dom=await parse(result.html);
 try{const d=dom.window.document,cta=d.querySelector('#cta'),tile=d.querySelector('#tile');assert.equal(cta.localName,'a');assert.equal(tile.localName,'a');assert.equal(cta.getAttribute('href'),url);assert.equal(tile.getAttribute('href'),url);assert.equal(cta.textContent,'  Exact anchor  ');assert.equal(cta.className,'offer');assert.equal(cta.getAttribute('style'),'border:1px solid red');assert.equal(cta.getAttribute('data-pp-url'),url);assert.equal(cta.target,'_blank');assert.match(cta.rel,/noopener/);assert.equal(d.querySelector('style').textContent,'.offer{padding:12px;color:#123456}#cta{display:inline-block}[data-pp-url]{cursor:pointer}');assert.equal(d.querySelector('h1').textContent,'Exact text');assert.equal(d.querySelector('[href="#root"]').textContent,'Jump');assert.equal(d.querySelectorAll('script,[onclick],[onerror]').length,0);}finally{dom.window.close();}
 assert.ok(result.warnings.some(w=>w.code==='SIMPLIFIED_SELECTED'));assert.equal(result.variant,'simplified');
});

test('simplified removes active content and unsafe navigation but retains text and disables arbitrary controls without invented URLs',async()=>{
 const {createManualExport}=await api(),source='<style>.card{color:red}</style><div id="safe"><h1>Article</h1><button id="dynamic" class="card" onclick="window.open(getSecretUrl())">Dynamic label</button><a id="unsafe" href="javascript:alert(1)" onclick="alert(2)">Unsafe label</a><button id="credential" data-pp-url="https://user:private-password@host.org/">Credential label</button><img id="image" src="javascript:alert(1)" onerror="alert(3)"><form id="form" action="https://collect.org"><input name="email" type="email"><button type="submit">Send</button></form><iframe src="https://outside.org" srcdoc="<script>alert(1)</script>"></iframe><object data="https://outside.org"></object><script src="https://outside.org/active.js"></script></div><meta http-equiv="refresh" content="0;url=https://outside.org">';
 const result=createManualExport(input({preparedHtml:source,variant:'simplified'})),dom=await parse(result.html);
 try{const d=dom.window.document;assert.equal(d.querySelectorAll('script,iframe,object,meta[http-equiv],[onclick],[onerror],form').length,0);assert.equal(d.querySelector('#dynamic').textContent,'Dynamic label');assert.equal(d.querySelector('#dynamic').hasAttribute('disabled'),true);assert.equal(d.querySelector('#dynamic').getAttribute('href'),null);assert.equal(d.querySelector('#unsafe').getAttribute('href'),null);assert.equal(d.querySelector('#credential').getAttribute('data-pp-url'),null);assert.equal(d.querySelector('#image').getAttribute('src'),null);assert.equal(d.querySelector('#safe h1').textContent,'Article');assert.equal(d.querySelector('input').disabled,true);assert.equal(d.querySelector('#form').id,'form');}finally{dom.window.close();}
 assert.equal(result.audit.state,'needs_review');for(const code of ['UNRESOLVED_CONTROLS','UNSAFE_NAVIGATION','ACTIVE_CONTENT_REMOVED','FORM_CONTROLS_DISABLED'])assert.ok(result.warnings.some(w=>w.code===code),code);assert.doesNotMatch(JSON.stringify([result.warnings,result.audit]),/private-password|getSecretUrl|active\.js/);
});

test('placeholder audit is structural and ignores ordinary fragments text and unrelated resource URLs',async()=>{
 const {createManualExport}=await api(),source='<p>example.com .invalid {{URL}} are article text.</p><img src="https://images.invalid/image.png"><link rel="stylesheet" href="https://cdn.test/style.css"><a href="#">Top</a><a href="#part">Fragment</a><a href="/example.com">Same-site path</a><a href="https://valid.org/example.com">Real page</a><a href="https://example.com/offer">Demo</a><button data-pp-url="https://offers.invalid/deal">Offer</button><a href="https://site.test/page">Test</a><a href="{{OFFER_URL}}">Template</a><a href="https://sub.example.org/">Subdomain</a>';
 const result=createManualExport(input({preparedHtml:source}));assert.equal(result.html,source);assert.equal(result.audit.state,'needs_review');assert.equal(result.audit.placeholderCount,5);assert.equal(result.audit.placeholders.length,5);assert.ok(result.audit.placeholders.every(p=>['href','data-pp-url'].includes(p.attribute)));assert.ok(result.audit.placeholders.some(p=>p.url==='{{OFFER_URL}}'));assert.ok(result.warnings.some(w=>w.code==='PLACEHOLDERS_FOUND'));
});

test('placeholder audit counts every occurrence while its detached deduplicated list and labels remain bounded',async()=>{
 const {createManualExport}=await api(),repeated=Array.from({length:80},()=>'<a href="https://same.invalid/path">Repeated</a>').join(''),unique=Array.from({length:80},(_,i)=>'<a href="https://host'+i+'.invalid/path">'+'Label '.repeat(100)+'</a>').join('');
 const result=createManualExport(input({preparedHtml:repeated+unique}));assert.equal(result.audit.placeholderCount,160);assert.ok(result.audit.placeholders.length<=50);assert.equal(result.audit.placeholders.filter(p=>p.url==='https://same.invalid/path').length,1);assert.ok(result.audit.placeholders.every(p=>p.label.length<=160&&p.url.length<=1000));assert.equal(new Set(result.warnings.map(w=>w.code)).size,result.warnings.length);
});

test('ambiguous destinations and controls in inert templates cannot retain executable behavior',async()=>{
 const {createManualExport}=await api(),source='<a id="ambiguous" href="https://first.org/a%2F" data-pp-url="https://second.org/?x=1&amp;x=2">Choice</a><template><button onclick="alert(1)">Template action</button><script>alert(2)</script><svg><a xlink:href="javascript:alert(3)">SVG</a><set attributeName="href" to="javascript:alert(4)"></set></svg></template>';
 const result=createManualExport(input({preparedHtml:source,variant:'simplified'})),dom=await parse(result.html);
 try{const d=dom.window.document,content=d.querySelector('template').content;assert.equal(d.querySelector('#ambiguous').getAttribute('href'),'https://first.org/a%2F');assert.equal(d.querySelector('#ambiguous').getAttribute('data-pp-url'),null);assert.equal(content.querySelectorAll('script,[onclick],set').length,0);assert.equal(content.querySelector('a').getAttribute('xlink:href'),null);}finally{dom.window.close();}
 assert.equal(result.audit.state,'needs_review');assert.ok(result.warnings.some(w=>w.code==='AMBIGUOUS_NAVIGATION'));
});

test('download filenames are local basenames and warning/step arrays are independent per export',async()=>{
 const {createManualExport}=await api(),first=createManualExport(input({title:'CON / bad:\\ name? <x>'})),other=createManualExport(input({title:'CON / bad:\\ name? <x>'}));assert.match(first.filename,/-prepared\.html$/);assert.doesNotMatch(first.filename,/[\\/:?<>|*\u0000-\u001f]/);assert.ok(first.filename.length<=140);first.steps.push('changed');first.warnings[0].message='changed';assert.equal(other.steps.includes('changed'),false);assert.notEqual(other.warnings[0].message,'changed');
});

test('simplified retains image navigation visuals and disabled controls while native input buttons get their explicit destination',async()=>{
 const {createManualExport}=await api(),source='<div id="root"><img id="logo" class="brand" style="width:60px" alt="Brand" src="https://assets.org/logo.png" data-pp-url="https://partner.org/?q=%2f&amp;q=2"><button id="disabled" disabled data-pp-url="https://partner.org/disabled">Disabled</button><input id="input" type="button" class="cta" style="padding:12px" value=" Exact input label " data-pp-url="https://partner.org/input%2f?x=1&amp;x=2"><img id="unsafe-set" srcset="data:text/html,unsafe 1x"></div>';
 const result=createManualExport(input({preparedHtml:source,variant:'simplified'})),dom=await parse(result.html);
 try{const d=dom.window.document,logo=d.querySelector('#logo');assert.equal(logo.localName,'img');assert.equal(logo.src,'https://assets.org/logo.png');assert.equal(logo.parentElement.localName,'a');assert.equal(logo.parentElement.getAttribute('href'),'https://partner.org/?q=%2f&q=2');assert.equal(logo.className,'brand');assert.equal(logo.getAttribute('style'),'width:60px');assert.equal(d.querySelector('#disabled').localName,'button');assert.equal(d.querySelector('#disabled').disabled,true);assert.equal(d.querySelector('#disabled').getAttribute('data-pp-url'),null);const control=d.querySelector('#input');assert.equal(control.localName,'a');assert.equal(control.textContent,' Exact input label ');assert.equal(control.getAttribute('href'),'https://partner.org/input%2f?x=1&x=2');assert.equal(control.getAttribute('style'),'padding:12px');assert.equal(d.querySelector('#unsafe-set').getAttribute('srcset'),null);}finally{dom.window.close();}
});

test('audit redacts credentials on protocol-relative placeholders and long diagnostic URLs remain bounded',async()=>{
 const {createManualExport}=await api(),result=createManualExport(input({preparedHtml:'<a href="//user:fixture-private-password@offer.invalid/">Private</a><a href="https://offer.invalid/?x='+'a'.repeat(1500)+'">Long</a>'}));assert.equal(result.audit.placeholderCount,2);assert.doesNotMatch(JSON.stringify([result.warnings,result.audit]),/fixture-private-password/);assert.ok(result.audit.placeholders.every(p=>p.url.length<=1000));
});
