const test=require('node:test'),assert=require('node:assert/strict');
const G=require('../dist/generator.js');
test('editorial pages use controlled layouts without giant bonus copy, empty scores or anchor logos',()=>{
 for(const format of ['article','guide','comparison','discussion','blog_post','faq']){
  const config={...G.DEFAULT_DATA,editorialFormat:format,fontFamily:'Georgia',colors:{background:'#ff0000',header:'#00ff00',card:'#0000ff',accent:'#ff00ff'},cards:[{name:'casinotest1',url:'https://offer50.example/?track=%2F',bonus:'Read the details before choosing.',button:'Visit casino'}],moreCards:[],reviews:[],tiles:[],services:[]};
  const html=G.renderSnippet(config);
  assert.match(html,/pp-editorial-v2/);
  assert.match(html,/pp-resource/);
  assert.doesNotMatch(html,/class="pp-score"|class="pp-bonus"|class="pp-wordmark"/);
  assert.match(html,/offer50\.example/);
  assert.doesNotMatch(html,/#ff0000|#00ff00|#ff00ff/);
 }
});
