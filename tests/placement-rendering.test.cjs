const test=require('node:test'),assert=require('node:assert/strict');const G=require('../dist/generator.js');const {JSDOM}=require('jsdom');
test('logo, offer and each brand destination stay independent and exact',()=>{const config={...G.DEFAULT_DATA,brandUrl:'https://example.com/top?x=A%2FB&y=2#top',footerBrandUrl:'https://example.com/bottom?z=2&x=1',cards:[{name:'Test',url:'https://example.com/offer',logoUrl:'https://example.com/logo',button:'View',_ppRowId:'fixed-row'}],moreCards:[],navLinks:[],tiles:[],services:[],reviews:[],sections:[],faq:[]};const c=G.normalizeConfig(config);assert.equal(c.cards[0]._ppRowId,'fixed-row');assert.equal(c.cards[0].logoUrl,config.cards[0].logoUrl);const d=new JSDOM(G.renderSnippet(c)).window.document;assert.equal(d.querySelector('.pp-header .pp-brand').getAttribute('href'),config.brandUrl);assert.equal(d.querySelector('.pp-footer .pp-brand').getAttribute('href'),config.footerBrandUrl);assert.equal(d.querySelector('.pp-logo a').getAttribute('href'),config.cards[0].logoUrl);assert.equal(d.querySelector('.pp-cta').getAttribute('href'),config.cards[0].url);});
test('font variant is allowlisted and design metadata survives normalization',()=>{const c=G.normalizeConfig({...G.DEFAULT_DATA,fontFamily:'Verdana',designVariant:{seed:'s',sequence:3,version:1}});assert.equal(c.fontFamily,'Verdana');assert.equal(c.designVariant.sequence,3);assert.match(G.renderSnippet(c),/Verdana/);assert.equal(G.normalizeConfig({...c,fontFamily:'Arial; background:url(evil)'}).fontFamily,'Arial');});

test('two exact token URLs and anchors render safely with ten offers and only one native href each',()=>{
 const R=require('../dist/link-placements.js');const {JSDOM}=require('jsdom');
 const urls=['https://example.com/go?b=2&a=%2F#x','https://other.example/p?x=one&x=two'];
 const anchors=['Exact [anchor] **not bold**','Точний & <анкор>'];
 const cfg=G.normalizeConfig({title:'Guide',brand:'Guide',cards:Array.from({length:10},(_,i)=>({name:'Offer '+i,url:urls[i%2]})),sections:[{title:'Guide',body:'Before **text** [[PP_LINK:one]] and [[PP_LINK:two]].'}],faq:[],aiLinkInsertions:urls.map((url,i)=>({id:i?'two':'one',fieldPath:'sections.0.body',url,anchor:anchors[i],count:1}))});
 const doc=new JSDOM(G.renderSnippet(cfg)).window.document;
 for(let i=0;i<2;i++){const native=[...doc.querySelectorAll('a[href]')].filter(a=>a.getAttribute('href')===urls[i]);assert.equal(native.length,1);assert.equal(native[0].textContent,anchors[i]);assert.ok(native[0].closest('.pp-prose'));}
 assert.equal(doc.querySelectorAll('.pp-offer').length,10);assert.ok(doc.querySelectorAll('[data-pp-url]').length>=10);
 const prepared=R.prepare(cfg).config, place=R.list(prepared).find(p=>p.id==='token:one');
 const next=R.apply(prepared,R.propose(prepared,[{id:place.id,url:'https://changed.example/?q=%2f',anchor:'Exact new anchor',expectedUrl:place.url,expectedAnchor:place.anchor,expectedBinding:place.binding}]));
 assert.equal(next.sections[0].body,prepared.sections[0].body);assert.equal(next.cards[0].url,urls[0]);assert.equal(next.aiLinkInsertions[0].url,'https://changed.example/?q=%2f');
 const after=new JSDOM(G.renderSnippet(next)).window.document;assert.equal([...after.querySelectorAll('a[href]')].find(a=>a.textContent==='Exact new anchor').getAttribute('href'),'https://changed.example/?q=%2f');
});
test('unknown misplaced nested or missing required tokens cannot silently export broken content',()=>{
 const base={title:'Guide',cards:[],sections:[{title:'Text',body:'[[PP_LINK:one]]'}],faq:[],aiLinkInsertions:[{id:'one',fieldPath:'sections.0.body',url:'https://example.com/?x=1',anchor:'Exact',count:1}]};
 for(const body of ['[[PP_LINK:unknown]]','Missing token','[a [[PP_LINK:one]]](https://example.com)'])assert.throws(()=>G.renderSnippet({...base,sections:[{title:'Text',body}]}));
 assert.throws(()=>G.renderSnippet({...base,aiLinkInsertions:[]}));
});
