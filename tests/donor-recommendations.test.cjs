'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {rankDonorRecommendations}=require('../server/lifecycle/donor-recommendations.mjs');

function donor(host,geo,overrides={}){
 return {id:host,baseUrl:'https://'+host+'/',geo,dr:50,traffic:300,available:true,current:false,...overrides};
}

test('exact country precedes ordered locale stages and other GEO, with stable source ties',()=>{
 const ranked=rankDonorRecommendations([
  donor('unknown.example',[],{language:'English',dr:100}),
  donor('europe.example',['DE'],{dr:90}),
  donor('nordic-later.example',['SE'],{rowNumber:9}),
  donor('exact.example',['FI'],{dr:40}),
  donor('nordic-first.example',['NO'],{rowNumber:5}),
 ],{geo:'FI',minDr:40,minTraffic:300});
 assert.deepEqual(ranked.map(row=>[row.id,row.recommendation.group]),[
  ['exact.example','exact'],['nordic-first.example','locale'],['nordic-later.example','locale'],['europe.example','locale'],['unknown.example','other'],
 ]);
 assert.match(ranked[0].recommendation.reason,/Точний збіг GEO.*FI/);
 assert.match(ranked[1].recommendation.reason,/Скандинавія/);
});

test('eligible available reserve choices use distinct roots and respect independent hosted tenants',()=>{
 const ranked=rankDonorRecommendations([
  donor('main.example',['PL'],{current:true}),
  donor('blog.main.example',['PL']),
  donor('one.wordpress.com',['PL']),
  donor('www.one.wordpress.com',['PL']),
  donor('two.wordpress.com',['PL']),
  donor('unavailable.example',['PL'],{available:false}),
  donor('low-dr.example',['PL'],{dr:10}),
  donor('low-traffic.example',['PL'],{traffic:29}),
 ],{geo:'PL',minDr:40,minTraffic:30});
 assert.deepEqual(ranked.flatMap(row=>row.recommendation.reserveRank==null?[]:[[row.id,row.recommendation.reserveRank]]),[
  ['one.wordpress.com',1],['two.wordpress.com',2],
 ]);
 assert.match(ranked.find(row=>row.id==='low-dr.example').recommendation.reason,/мінімуму DR/);
 assert.match(ranked.find(row=>row.id==='low-traffic.example').recommendation.reason,/мінімуму трафіку/);
});

test('locale branch order respects UK aliases, distinct English groups, and KZ/CN restrictions',()=>{
 const cases=[
  ['UK',['GB','NZ','ZA','DE'],['exact','locale','other','other']],
  ['KZ',['KZ','AZ','TR'],['exact','locale','other']],
  ['AZ',['AZ','TR','RU'],['exact','locale','locale']],
  ['JP',['JP','KR','VN'],['exact','locale','other']],
  ['VN',['VN','TH','KH'],['exact','other','other']],
 ];
 for(const [geo,countries,groups] of cases){
  const ranked=rankDonorRecommendations(countries.map(code=>donor(code.toLowerCase()+'.example',[code])),{geo});
  assert.deepEqual(ranked.map(row=>row.recommendation.group),groups,geo);
 }
});
