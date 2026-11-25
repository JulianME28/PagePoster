"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const {wpautop}=require('./wordpress-fixture.cjs');
const runtime=require('../dist/page-runtime.js');
const url='https://example.org/go?offer=1&token=UNCHANGED%2F';
const esc=url.replace('&','&amp;');
test('one visible offer anchor for each exact URL; all duplicates retained',()=>{
 const result=runtime.prepare(`<div id="pp-landing"><header><a class="pp-brand" href="${esc}">Brand</a></header><div data-pp-url="${esc}">Logo</div><button class="btn" data-pp-url="${esc}" data-pp-target="_blank" data-pp-priority="offer">VIEW OFFER</button><a href="${esc}">Again</a><a href="https://example.org/go?offer=2">Second</a><a href="#faq">FAQ</a></div>`,{fullscreen:true});
 const doc=new JSDOM(result).window.document;
 assert.equal(doc.querySelectorAll('a[href^="https:"]').length,2);
 assert.equal(doc.querySelector('a.ppi-was-button').getAttribute('href'),url);
 assert.equal(doc.querySelectorAll('[data-pp-url]').length,3);
 assert.equal(doc.querySelector('.pp-brand').getAttribute('tabindex'),'0');
 assert.equal(doc.querySelector('a[href="#faq"]').textContent,'FAQ');
 const s=runtime.summarize(result);assert.equal(s.uniqueCount,2);assert.equal(s.totalControls,5);assert.equal(s.duplicateControls,3);assert.deepEqual(s.urls,[url,'https://example.org/go?offer=2']);
});
test('tokenizer handles quoted markup and rejects unsafe navigation',()=>{
 const source=`<style>.x:after{content:'<a href="https://fake.example/">'}</style><!-- <a href="https://fake.example/"> --><div id="pp-landing"><a title="a > b" href="https://real.example/?a=1&amp;b=2">Real</a><button data-pp-url="javascript:alert(1)">Bad</button></div>`;
 const result=runtime.prepare(source,{fullscreen:false});
 assert.deepEqual(runtime.summarize(result).urls,['https://real.example/?a=1&b=2']);assert.ok(result.includes('title="a > b"'));assert.ok(!result.includes('data-pp-url="javascript:'));
});
test('keyboard and mouse retain exact destinations after two WordPress passes',()=>{
 const source=`<div id="pp-landing"><button data-pp-url="${esc}" data-pp-target="_blank">View</button><div data-pp-url="${esc}" data-pp-target="_blank">Logo</div></div>`;
 const output=runtime.prepare(source,{fullscreen:true});
 for(const format of [x=>x,wpautop,x=>wpautop(wpautop(x))]){
  const dom=new JSDOM('<body><div id="theme">'+format(output)+'</div>',{runScripts:'dangerously',url:'https://host.example/page'});
  const calls=[];dom.window.open=(...args)=>calls.push(args);
  const root=dom.window.document.getElementById('pp-landing');assert.equal(root.parentElement,dom.window.document.body);
  const duplicate=root.querySelector('[data-pp-url]');
  duplicate.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
  duplicate.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  duplicate.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:' ',bubbles:true}));
  assert.deepEqual(calls.map(c=>c[0]),[url,url,url]);assert.ok(calls.every(c=>c[2]==='noopener,noreferrer'));dom.window.close();
 }
});


test('clickable containers keep their CSS tags and never swallow a nested native link',()=>{
 const output=runtime.prepare('<div id="pp-landing"><div class="logo" data-pp-url="https://outer.example/" data-pp-target="_blank">Outer <a href="https://inner.example/" target="_blank">Inner</a></div></div>',{fullscreen:false});
 const dom=new JSDOM(output,{runScripts:'dangerously',url:'https://host.example/'}),doc=dom.window.document;
 const wrapper=doc.querySelector('div.logo');assert.ok(wrapper);assert.equal(wrapper.textContent,'Outer Inner');
 assert.equal(doc.querySelectorAll('a[href="https://outer.example/"]').length,1);
 assert.equal(doc.querySelectorAll('a[href="https://inner.example/"]').length,1);
 assert.equal(doc.querySelectorAll('a a').length,0);
 const calls=[];dom.window.open=(...args)=>calls.push(args);
 const inner=doc.querySelector('a[href="https://inner.example/"]');
 inner.addEventListener('click',e=>e.preventDefault());inner.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
 assert.equal(calls.length,0,'Inner native link must not invoke outer navigation');
 wrapper.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));assert.equal(calls[0][0],'https://outer.example/');dom.window.close();
});


test('icon-only containers expose one accessible native link without changing icon tags or box styles', () => {
 const source='<style>div.logo > span.icon{display:inline-block;width:20px;height:20px;background:green}</style><div id="pp-landing"><div class="logo" data-pp-url="https://offer.test/?a=1&amp;b=2" data-pp-target="_blank" aria-label="View offer"><span class="icon"></span></div></div>';
 const output=runtime.prepare(source,{fullscreen:false});
 const dom=new JSDOM(output,{runScripts:'dangerously',url:'https://host.example/'}),doc=dom.window.document;
 const links=doc.querySelectorAll('a[href="https://offer.test/?a=1&b=2"]');
 assert.equal(links.length,1);
 const icon=doc.querySelector('div.logo > span.icon'), css=dom.window.getComputedStyle(icon);
 assert.ok(icon); assert.equal(css.display,'inline-block'); assert.equal(css.width,'20px'); assert.equal(css.height,'20px'); assert.equal(css.backgroundColor,'rgb(0, 128, 0)');
 const link=links[0]; assert.equal(link.getAttribute('aria-label'),'View offer'); assert.equal(link.tabIndex,0); assert.equal(link.closest('[hidden],[aria-hidden="true"]'),null);
 assert.equal(dom.window.getComputedStyle(link).position,'absolute');
 assert.equal(dom.window.getComputedStyle(link).inset,'0px');
 const calls=[];dom.window.open=(...args)=>calls.push(args);
 link.addEventListener('click',e=>e.preventDefault());link.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));
 assert.equal(calls.length,0,'Native link must not also invoke surrounding JS navigation');
 const report=runtime.summarize(output);assert.equal(report.links[0].nativeCount,1);dom.window.close();
});


test('icon fallback never puts a native link inside a nested non-navigation button', () => {
 const output=runtime.prepare('<div id="pp-landing"><div data-pp-url="https://offer.test/"><button type="button"><span class="icon"></span></button></div></div>',{fullscreen:false});
 const doc=new JSDOM(output).window.document;
 assert.equal(doc.querySelectorAll('button a').length,0);
 assert.equal(doc.querySelectorAll('[data-pp-icon-hit]').length,0);
});


test('icon fallback preserves empty decorative icons and avoids hidden empty children', () => {
 for (const decorative of ['<span class="icon"></span>', '<span class="unused"></span><span class="icon"></span>']) {
  const source='<style>.unused{display:none}.icon:empty{display:inline-block;width:40px;height:40px;background:green}</style><div id="pp-landing"><div class="logo" data-pp-url="https://offer.test/" aria-label="View offer">'+decorative+'</div></div>';
  const dom=new JSDOM(runtime.prepare(source,{fullscreen:false}),{runScripts:'dangerously',url:'https://host.example/'}),doc=dom.window.document;
  const icon=doc.querySelector('.icon'),css=dom.window.getComputedStyle(icon);
  assert.equal(css.display,'inline-block');assert.equal(css.width,'40px');assert.equal(css.height,'40px');assert.equal(css.backgroundColor,'rgb(0, 128, 0)');assert.equal(icon.childElementCount,0);
  const link=doc.querySelector('a[href="https://offer.test/"]');assert.ok(link);assert.equal(link.parentElement,doc.querySelector('.logo'));assert.equal(link.closest('.unused'),null);
  dom.window.close();
 }
});
