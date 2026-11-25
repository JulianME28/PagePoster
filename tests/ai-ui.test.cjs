'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const ui=require('../dist/ai-ui.js');
const core=require('../dist/ai-core.js');
const generator=require('../dist/generator.js');

const clone=value=>JSON.parse(JSON.stringify(value));
const settle=()=>new Promise(resolve=>setImmediate(resolve));
class Element {
  constructor(){this.handlers={};this.innerHTML='';this.hidden=false;this.scrollTop=0;this.ownerDocument={activeElement:null};this.keyInput={value:''};}
  addEventListener(name,callback){this.handlers[name]=callback;}
  querySelectorAll(){return [];}
  querySelector(selector){return selector==='[data-ai-key]'?this.keyInput:null;}
  contains(){return false;}
  emit(name,target){target.closest=()=>target;this.handlers[name]({target});}
  click(action){this.emit('click',{dataset:{aiAction:action},disabled:false});}
  change(dataset,value,checked){this.emit('change',{dataset,value,checked});}
  input(name,value){this.emit('input',{dataset:{aiInput:name},value});}
}
function harness({initial,fetch,protocol='http:',configured=true,keyEntryAllowed=false}={}) {
  const element=new Element();
  let data=initial||core.createProject(generator.DEFAULT_DATA,'Example | https://example.com/');
  let revision=0,replacements=0;
  const calls=[];
  const request=async(url,settings={})=>{
    calls.push({url,settings});
    if(url==='/api/ai/status')return {ok:true,json:async()=>({configured,keyEntryAllowed})};
    if(fetch)return fetch(url,settings);
    const body=JSON.parse(settings.body);
    return {ok:true,json:async()=>({requestId:body.requestId,updates:body.targets.map(target=>({targetId:target.targetId,value:'Написано: '+target.field})),notes:[]})};
  };
  const controller=ui.create({element,core,fetch:request,protocol,getData:()=>data,getRevision:()=>revision,replaceData:next=>{data=next;revision++;replacements++;},switchToBuilder:()=>{data.contentMode='builder';revision++;controller.onProjectChange();controller.refresh();},toast:()=>{}});
  controller.refresh();
  return {element,controller,calls,get data(){return data;},get replacements(){return replacements;},edit(fn){fn(data);revision++;controller.onProjectChange();}};
}
test('file version has local editor link and never calls an API',()=>{
  const h=harness({protocol:'file:'});
  assert.match(h.element.innerHTML,/http:\/\/127\.0\.0\.1:4317/);
  assert.doesNotMatch(h.element.innerHTML,/data-ai-key/);
  h.element.click('generate');
  assert.equal(h.calls.length,0);
});
test('selected field is reviewed before apply, escapes markup, and undo restores the previous page',async()=>{
  const initial=core.createProject(generator.DEFAULT_DATA,'Shop | https://example.com/?x=1&y=2');
  initial.title='Власний заголовок';
  const h=harness({initial,fetch:async(_url,settings)=>{
    const body=JSON.parse(settings.body);
    assert.equal(body.targets.length,1);
    assert.equal(body.targets[0].field,'intro');
    assert.match(body.brief.context,/Shop/);
    assert.match(body.brief.context,/https:\/\/example\.com/);
    return {ok:true,json:async()=>({requestId:body.requestId,updates:[{targetId:body.targets[0].targetId,value:'<img src=x onerror=alert(1)>'}],notes:[]})};
  }});
  await settle();
  h.element.change({aiPath:'intro'},'',true);
  h.element.click('generate');
  await settle();
  assert.equal(h.data.intro,'');
  assert.equal(h.replacements,0);
  assert.match(h.element.innerHTML,/data-ai-action="apply"/);
  assert.match(h.element.innerHTML,/&lt;img src=x/);
  assert.doesNotMatch(h.element.innerHTML,/<img src=x/);
  h.element.click('apply');
  assert.equal(h.data.intro,'<img src=x onerror=alert(1)>');
  assert.equal(h.data.title,'Власний заголовок');
  assert.equal(h.data.cards[0].url,'https://example.com/?x=1&y=2');
  h.element.click('undo');
  assert.equal(h.data.intro,'');
  assert.equal(h.data.title,'Власний заголовок');
});
test('filled fields are preserved in empty mode and explicitly replaceable in selected mode',async()=>{
  const h=harness();
  h.data.intro='Мій вступ';
  await settle();
  h.element.change({aiPath:'intro'},'',true);
  h.element.click('generate');
  await settle();
  assert.equal(h.calls.filter(call=>call.url==='/api/ai/generate').length,0);
  h.element.change({aiInput:'mode'},'selected');
  h.element.click('generate');
  await settle();
  assert.equal(h.data.intro,'Мій вступ');
  h.element.click('apply');
  assert.equal(h.data.intro,'Написано: intro');
});
test('batches run sequentially and a later failure applies none of the earlier responses',async()=>{
  let requestNumber=0,active=0,maxActive=0;
  const h=harness({fetch:async(_url,settings)=>{
    requestNumber++;active++;maxActive=Math.max(maxActive,active);
    const body=JSON.parse(settings.body);
    assert.ok(body.targets.length<=16);
    await settle();active--;
    return requestNumber===2?{ok:false,json:async()=>({error:'Сервіс тимчасово недоступний.'})}:{ok:true,json:async()=>({requestId:body.requestId,updates:body.targets.map(target=>({targetId:target.targetId,value:'Текст'})),notes:[]})};
  }});
  const before=clone(h.data);
  await settle();
  h.element.click('all');h.element.click('generate');
  await settle();await settle();await settle();
  assert.equal(requestNumber,2);
  assert.equal(maxActive,1);
  assert.deepEqual(h.data,before);
  assert.equal(h.replacements,0);
  assert.match(h.element.innerHTML,/Сервіс тимчасово недоступний/);
  assert.doesNotMatch(h.element.innerHTML,/data-ai-action="apply"/);
});
test('cancel ignores a late response and aborts the fetch',async()=>{
  let resolveRequest,signal;
  const h=harness({fetch:(_url,settings)=>{
    signal=settings.signal;
    const body=JSON.parse(settings.body);
    return new Promise(resolve=>{resolveRequest=()=>resolve({ok:true,json:async()=>({requestId:body.requestId,updates:body.targets.map(target=>({targetId:target.targetId,value:'Пізній текст'})),notes:[]})});});
  }});
  await settle();
  h.element.change({aiPath:'intro'},'',true);h.element.click('generate');
  h.element.click('cancel');
  assert.equal(signal.aborted,true);
  resolveRequest();await settle();
  assert.equal(h.data.intro,'');
  assert.doesNotMatch(h.element.innerHTML,/data-ai-action="apply"/);
});
test('manual edits invalidate a proposal and protect edited text',async()=>{
  const h=harness();await settle();
  h.element.change({aiPath:'intro'},'',true);h.element.click('generate');await settle();
  assert.match(h.element.innerHTML,/data-ai-action="apply"/);
  h.edit(data=>{data.intro='Ручна правка';});
  h.element.click('apply');
  assert.equal(h.data.intro,'Ручна правка');
  assert.equal(h.replacements,0);
  assert.doesNotMatch(h.element.innerHTML,/data-ai-action="apply"/);
});
test('new page is staged, complete across batches, and replaces current page only on Apply',async()=>{
  const h=harness({initial:clone(generator.DEFAULT_DATA)});
  const before=clone(h.data);
  await settle();
  h.element.change({aiInput:'workflow'},'new');
  h.element.input('links','First | https://first.example/path\nSecond | https://second.example/');
  h.element.click('prepare');
  assert.deepEqual(h.data,before);
  h.element.click('generate');await settle();
  const requests=h.calls.filter(call=>call.url==='/api/ai/generate');
  assert.ok(requests.length>1);
  assert.deepEqual(h.data,before);
  h.element.click('apply');
  assert.equal(h.data.cards.length,2);
  assert.equal(h.data.cards[0].url,'https://first.example/path');
  assert.equal(h.data.cards[1].url,'https://second.example/');
  assert.match(h.data.intro,/Написано/);
  assert.equal(h.replacements,1);
  h.element.click('undo');
  assert.deepEqual(h.data,before);
});
test('a duplicate target response is rejected without exposing Apply',async()=>{
  const h=harness({fetch:async(_url,settings)=>{
    const body=JSON.parse(settings.body);
    return {ok:true,json:async()=>({requestId:body.requestId,updates:body.targets.map(()=>({targetId:body.targets[0].targetId,value:'Текст'}))})};
  }});
  await settle();h.element.click('all');h.element.click('generate');await settle();
  assert.match(h.element.innerHTML,/некоректні тексти/);
  assert.doesNotMatch(h.element.innerHTML,/data-ai-action="apply"/);
});
test('API key entry appears only when allowed and clears the password before sending',async()=>{
  let posted=false;
  const h=harness({configured:false,keyEntryAllowed:true,fetch:async(url,settings)=>{
    assert.equal(url,'/api/ai/connect');
    assert.equal(h.element.keyInput.value,'');
    assert.deepEqual(JSON.parse(settings.body),{apiKey:'test-key-not-a-secret'});
    posted=true;
    return {ok:true,json:async()=>({configured:true,keyEntryAllowed:true})};
  }});
  await settle();assert.match(h.element.innerHTML,/data-ai-key/);
  h.element.keyInput.value='test-key-not-a-secret';h.element.click('connect');await settle();
  assert.equal(posted,true);
  assert.doesNotMatch(h.element.innerHTML,/test-key-not-a-secret/);
  assert.match(h.element.innerHTML,/Ключ API налаштовано/);
  const hosted=harness({configured:false,keyEntryAllowed:false});await settle();
  assert.doesNotMatch(hosted.element.innerHTML,/data-ai-key/);
});

test('HTML mode blocks AI against invisible builder content until an explicit mode switch',async()=>{
  const h=harness({initial:{...clone(generator.DEFAULT_DATA),contentMode:'html',importHtml:'<main>Imported</main>'}});
  await settle();
  assert.equal(h.calls.length,0);
  assert.match(h.element.innerHTML,/Перейти до конструктора/);
  assert.doesNotMatch(h.element.innerHTML,/data-ai-action="generate"/);
  h.element.click('generate');
  assert.equal(h.calls.length,0);
  assert.equal(h.data.contentMode,'html');
  h.element.click('builder-mode');await settle();
  assert.equal(h.data.contentMode,'builder');
  assert.equal(h.data.importHtml,'<main>Imported</main>');
  assert.match(h.element.innerHTML,/data-ai-action="generate"/);
});


test('a mocked AI-added destination is rejected before review and leaves exported links unchanged',async()=>{
  const initial=core.createProject(generator.DEFAULT_DATA,'Offer | https://example.com/?offer=1669');
  initial.sections[0].body='Manual [reference](https://reference.example/?a=%2F&b=2).';
  const before=clone(initial);
  const h=harness({initial,fetch:async(_url,settings)=>{
    const body=JSON.parse(settings.body);
    return {ok:true,json:async()=>({requestId:body.requestId,updates:body.targets.map(target=>({targetId:target.targetId,value:'Read [more](https://unprovided.example/extra).'})),notes:[]})};
  }});
  await settle();
  h.element.change({aiPath:'sections.1.body'},'',true);h.element.click('generate');await settle();
  assert.match(h.element.innerHTML,/посилан/i);
  assert.doesNotMatch(h.element.innerHTML,/data-ai-action="apply"/);
  h.element.click('apply');
  assert.deepEqual(h.data,before);
  assert.equal(h.replacements,0);
  assert.deepEqual(generator.analyzeLinks(h.data).urls,['https://example.com/?offer=1669','https://reference.example/?a=%2F&b=2']);
});
