'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const load=()=>import('../server/lifecycle/native-link-replacement.mjs');
const old='https://offers.example/Δοκιμή?x=%2F&x=2#α';
const next='https://offers.example/Ελληνικά?b=%2f&a=1&a=2#ω';
const source='<a href="'+old+'">Theme</a>\r\n<style>.card{color:red}a[href="'+old+'"]{font-weight:bold}</style>\r\n<div id="pp-landing" class="pp-editorial-v2"><header><a href=\'https://offers.example/Δοκιμή?x=%2F&amp;x=2#α\'><b>Επωνυμία</b></a></header><main><a class="card" href="https://offers.example/Δοκιμή?x=%2F&#38;x=2#α">Ακριβές &amp; anchor</a><button data-pp-url="https://offers.example/Δοκιμή?x=%2F&amp;x=2#α" data-pp-target="_blank">Again</button></main><footer><a data-pp-url="https://offers.example/Δοκιμή?x=%2F&amp;x=2#α">Footer</a></footer><script type="application/json">{"url":"'+old+'"}</script><script>const original='+JSON.stringify(old)+'</script></div><!-- preserve -->';
const change=(p,url=next)=>({id:p.id,url,expectedUrl:p.url,expectedAnchor:p.anchor,expectedBinding:p.binding});
const code=expected=>error=>error.code===expected;

test('URL replacement updates the paired AMP payload atomically and preserves its validation',async()=>{
 const {buildAmpPayload,appendAmpPayload}=await import('../server/lifecycle/amp-mode.mjs'),{initializeAmpValidator}=await import('../server/lifecycle/amp-validator.mjs');await initializeAmpValidator();
 const {listNativePlacements,proposeNativeReplacement,applyNativeReplacement}=await load(),plain='<div id="pp-landing"><h1>Title</h1><a href="https://old.example/">Visit</a></div>',html=appendAmpPayload(plain,buildAmpPayload({html:plain,title:'Title'}));
 const placement=listNativePlacements(html)[0],proposal=proposeNativeReplacement(html,[change(placement,'https://new.example/')]),result=applyNativeReplacement(html,proposal);
 const encoded=/data-pp-amp="([^"]+)"/.exec(result)[1],payload=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
 assert.match(payload.body,/href="https:\/\/new.example\/"/);assert.doesNotMatch(payload.body,/old\.example/);assert.equal((result.match(/data-pp-amp=/g)||[]).length,1);
});

test('native placement exposes one immutable URL group across href and repeated controls',async()=>{
 const {listNativePlacements}=await load(),rows=listNativePlacements(source);
 assert.equal(rows.length,1);const p=rows[0];assert.equal(p.url,old);assert.equal(p.anchorEditable,false);assert.equal(p.memberCount,4);assert.equal(p.nativeCount,2);
 assert.deepEqual(p.scopes,[{scope:'chrome',memberCount:2,nativeCount:1},{scope:'content',memberCount:2,nativeCount:1}]);
 assert.deepEqual(p.members.map(m=>[m.attribute,m.anchor]),[['href','Επωνυμία'],['href','Ακριβές & anchor'],['data-pp-url','Again'],['data-pp-url','Footer']]);
 assert.equal(typeof p.binding,'string');assert.equal(listNativePlacements(source)[0].id,p.id);
});

test('group replacement changes only destination value bytes, preserving theme, scripts, design and anchor bytes',async()=>{
 const {listNativePlacements,proposeNativeReplacement,applyNativeReplacement}=await load(),p=listNativePlacements(source)[0],proposal=proposeNativeReplacement(source,[change(p)]);
 const expected='<a href="'+old+'">Theme</a>\r\n<style>.card{color:red}a[href="'+old+'"]{font-weight:bold}</style>\r\n<div id="pp-landing" class="pp-editorial-v2"><header><a href=\'https://offers.example/Ελληνικά?b=%2f&amp;a=1&amp;a=2#ω\'><b>Επωνυμία</b></a></header><main><a class="card" href="https://offers.example/Ελληνικά?b=%2f&amp;a=1&amp;a=2#ω">Ακριβές &amp; anchor</a><button data-pp-url="https://offers.example/Ελληνικά?b=%2f&amp;a=1&amp;a=2#ω" data-pp-target="_blank">Again</button></main><footer><a data-pp-url="https://offers.example/Ελληνικά?b=%2f&amp;a=1&amp;a=2#ω">Footer</a></footer><script type="application/json">{"url":"'+old+'"}</script><script>const original='+JSON.stringify(old)+'</script></div><!-- preserve -->';
 assert.equal(proposal.nextHtml,expected);assert.equal(applyNativeReplacement(source,proposal),expected);assert.deepEqual(proposal.expectedUrls,[next]);
 assert.deepEqual(proposal.diff,[{id:p.id,label:p.label,role:p.role,before:{url:old,anchor:p.anchor},after:{url:next,anchor:p.anchor}}]);
 const after=listNativePlacements(proposal.nextHtml)[0];assert.equal(after.memberCount,4);assert.equal(after.nativeCount,2);assert.equal(after.anchor,p.anchor);assert.match(proposal.sourceHash,/^[a-f0-9]{64}$/);assert.notEqual(proposal.nextHash,proposal.sourceHash);
});

test('quoted destination changes preserve literal quotes and Unicode without attribute injection',async()=>{
 const {listNativePlacements,proposeNativeReplacement}=await load(),html='<div id="pp-landing"><a href=\'https://old.example/\'>One</a><a data-pp-url="https://old.example/">Two</a></div>',url='https://new.example/日本語?q="α"&a=\'β\'&amp=1';
 const proposal=proposeNativeReplacement(html,[change(listNativePlacements(html)[0],url)]);
 assert.equal(proposal.nextHtml,'<div id="pp-landing"><a href=\'https://new.example/日本語?q="α"&amp;a=&#39;β&#39;&amp;amp=1\'>One</a><a data-pp-url="https://new.example/日本語?q=&quot;α&quot;&amp;a=\'β\'&amp;amp=1">Two</a></div>');
 assert.equal(listNativePlacements(proposal.nextHtml)[0].url,url);
});

test('default count policy remains one native href and wrapper selection excludes theme controls',async()=>{
 const {listNativePlacements,proposeNativeReplacement}=await load(),html='<header><a href="https://theme.example/">Theme</a></header><div id="pp-universal-pl"><header><a href="https://old.example/">One</a></header><footer><button data-pp-url="https://old.example/">Two</button></footer></div>';
 assert.throws(()=>listNativePlacements(html),code('NATIVE_LINK_UNMARKED'));
 const opts={expectedMarker:'pp-universal-pl'},p=listNativePlacements(html,opts)[0];assert.equal(p.nativeCount,1);assert.equal(p.memberCount,2);assert.deepEqual(p.scopes,[{scope:'content',memberCount:2,nativeCount:1}]);
 assert.equal(proposeNativeReplacement(html,[change(p,'https://new.example/?x=%2F&x=1')],opts).nextHtml,'<header><a href="https://theme.example/">Theme</a></header><div id="pp-universal-pl"><header><a href="https://new.example/?x=%2F&amp;x=1">One</a></header><footer><button data-pp-url="https://new.example/?x=%2F&amp;x=1">Two</button></footer></div>');
});

test('ambiguous scopes, attributes and malformed committed href counts reject before mutation',async()=>{
 const {listNativePlacements}=await load();
 for(const html of [
  '<div id="pp-landing"><a href="https://x.example/" href="https://y.example/">X</a></div>',
  '<div id="pp-landing"><a href="https://x.example/" data-pp-url="https://x.example/">X</a></div>',
  '<div id="pp-landing"><a href="https://x.example/" onclick="go()">X</a></div>',
  '<div id="pp-landing" class="pp-editorial-v2"><header><footer><a href="https://x.example/">X</a></footer></header></div>',
  '<div id="pp-landing"><a href=https://x.example/>X</a></div>'
 ])assert.throws(()=>listNativePlacements(html),code('NATIVE_LINK_AMBIGUOUS'));
 for(const html of [
  '<div id="pp-landing"><a href="https://x.example/">One</a><a href="https://x.example/">Two</a></div>',
  '<div id="pp-landing"><button data-pp-url="https://x.example/">Only repeated</button></div>',
  '<div id="pp-landing" class="pp-editorial-v2"><header><a href="https://x.example/">Brand</a></header><button data-pp-url="https://x.example/">Content without native</button></div>'
 ])assert.throws(()=>listNativePlacements(html),code('NATIVE_LINK_COUNT'));
 assert.throws(()=>listNativePlacements('<div id="pp-landing"></div><div id="pp-landing"></div>'),code('NATIVE_LINK_UNMARKED'));
});

test('replacement rejects stale URL, anchor, binding, duplicate selections, anchor changes and invalid destinations',async()=>{
 const {listNativePlacements,proposeNativeReplacement}=await load(),p=listNativePlacements(source)[0];
 for(const patch of [{expectedUrl:old+'x'},{expectedAnchor:'stale'},{expectedBinding:'stale'},{id:'unknown'},{anchor:'changed'}])assert.throws(()=>proposeNativeReplacement(source,[{...change(p),...patch}]),code('CONFLICT'));
 assert.throws(()=>proposeNativeReplacement(source,[change(p),change(p)]),code('VALIDATION'));
 assert.throws(()=>proposeNativeReplacement(source,[change(p,old)]),code('VALIDATION'));
 for(const url of ['javascript:alert(1)','https://user:pass@example.com/','https://new.example/a b','https://new.example/\\evil','https://new.example/\n'])assert.throws(()=>proposeNativeReplacement(source,[change(p,url)]),code('VALIDATION'));
});

test('collision cannot silently merge distinct native groups and URL swaps remain atomic',async()=>{
 const {listNativePlacements,proposeNativeReplacement}=await load(),html='<div id="pp-landing"><a href="https://a.example/">A</a><span data-pp-url="https://a.example/">AA</span><a href="https://b.example/">B</a></div>',rows=listNativePlacements(html);
 assert.throws(()=>proposeNativeReplacement(html,[change(rows[0],'https://b.example/')]),code('NATIVE_LINK_COLLISION'));
 assert.throws(()=>proposeNativeReplacement(html,rows.map(p=>change(p,'https://new.example/'))),code('NATIVE_LINK_COLLISION'));
 assert.equal(proposeNativeReplacement(html,[change(rows[0],'https://b.example/'),change(rows[1],'https://a.example/')]).nextHtml,'<div id="pp-landing"><a href="https://b.example/">A</a><span data-pp-url="https://b.example/">AA</span><a href="https://a.example/">B</a></div>');
});

test('apply binds source, proposed bytes, diff, hashes and options to the exact reviewed transform',async()=>{
 const {listNativePlacements,proposeNativeReplacement,applyNativeReplacement}=await load(),proposal=proposeNativeReplacement(source,[change(listNativePlacements(source)[0])]);
 assert.throws(()=>applyNativeReplacement(source+' ',proposal),code('CONFLICT'));
 for(const patch of [{nextHtml:proposal.nextHtml.replace('Again','Changed')},{diff:[]},{expectedUrls:['https://attacker.example/']},{nextHash:'forged'},{sourceHash:'forged'},{kind:'other'}])assert.throws(()=>applyNativeReplacement(source,{...proposal,...patch}),code('CONFLICT'));
 assert.throws(()=>applyNativeReplacement(source,proposal,{expectedMarker:'pp-universal-pl'}),code('CONFLICT'));
});

test('event handlers on a navigation ancestor make a static URL group unsafe',async()=>{
 const {listNativePlacements}=await load();
 for(const html of ['<div id="pp-landing" onclick="goElsewhere()"><a href="https://old.example/">One</a></div>','<div id="pp-landing"><section onkeydown="goElsewhere()"><a href="https://old.example/">One</a></section></div>'])assert.throws(()=>listNativePlacements(html),code('NATIVE_LINK_AMBIGUOUS'));
});
