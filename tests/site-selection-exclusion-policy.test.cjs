'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const candidate=(id,extra={})=>({id,baseUrl:'https://'+id+'.example/',username:'PRIVATE_USER',password:'PRIVATE_PASSWORD',metrics:{dr:80,traffic:10000,geo:['PL']},...extra});
const describe=async()=>(await import('../server/lifecycle/site-selection.mjs')).describeSiteSelection;
const blocked=(...types)=>({blocked:true,reasons:types.map(type=>({type,reason:'PRIVATE_REASON',credentialRef:'PRIVATE_REF'}))});
test('policy suppression counts unique excluded origins and safe per-type diagnostics',async()=>{
 const selection=await describe(),types={manual:'manual',temporary:'transient',credentials:'auth',visual:'visual',security:'security',tried:'current_run'},rows=[...Object.keys(types),'free','plugin'].map(id=>candidate(id));
 const result=selection(rows,{candidatePolicy:row=>types[row.id]?blocked(types[row.id]):row.id==='plugin'?{blocked:false,advisories:[{type:'plugin'}]}:null});
 assert.equal(result.total,8);assert.equal(result.eligible,8);assert.equal(result.available,2);assert.equal(result.reserved,6);assert.deepEqual(result.unavailable,{unit:'origins',published:0,reserved:0,excluded:6,other:0,manual:1,temporary:1,credentials:1,visual:1,security:1});assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|example|credentialRef|reason/);
});
test('a good eligible duplicate credential row keeps an origin available after a failed pair',async()=>{
 const selection=await describe(),bad=candidate('bad',{baseUrl:'https://shared.example/'}),good=candidate('good',{baseUrl:'https://shared.example/path/'}),rows=[bad,good,good];
 const result=selection(rows,{candidatePolicy:row=>row.id==='bad'?blocked('auth'):null});assert.equal(result.total,1);assert.equal(result.available,1);assert.equal(result.reserved,0);assert.equal(result.unavailable.excluded,0);assert.equal(result.unavailable.credentials,0);
});
test('ownership wins over policy and unavailable ownership rows never require private policy evaluation',async()=>{
 const selection=await describe(),rows=['published','reserved','manual','other'].map(id=>candidate(id)),calls=[];
 const result=selection(rows,{usedOrigins:rows.filter(row=>row.id!=='manual').map(row=>row.baseUrl),unavailability:{publishedOrigins:[rows[0].baseUrl],reservedOrigins:[rows[0].baseUrl,rows[1].baseUrl],excludedOrigins:rows.map(row=>row.baseUrl)},candidatePolicy:row=>{calls.push(row.id);return blocked('manual');}});
 assert.deepEqual(calls,['manual']);assert.deepEqual(result.unavailable,{unit:'origins',published:1,reserved:1,excluded:2,other:0,manual:1,temporary:0,credentials:0,visual:0,security:0});assert.equal(result.available,0);
});
test('explicit ownership metadata and per-row reservations cannot be bypassed by an allowed policy',async()=>{
 const selection=await describe(),rows=[candidate('published'),candidate('reserved'),candidate('reserved-row'),candidate('free-row',{baseUrl:'https://reserved-row.example/other/'})];
 const result=selection(rows,{unavailability:{publishedOrigins:[rows[0].baseUrl],reservedOrigins:[rows[1].baseUrl],reservedRowIds:['reserved-row']},candidatePolicy:()=>null});assert.equal(result.available,1);assert.equal(result.reserved,2);assert.equal(result.unavailable.published,1);assert.equal(result.unavailable.reserved,1);
});
test('only exact metric-eligible rows participate in policy suppression and duplicate recovery',async()=>{
 const selection=await describe(),rows=[candidate('bad'),candidate('ineligible-good',{baseUrl:'https://bad.example/other/',metrics:{dr:20,traffic:10,geo:['US']}})],calls=[];
 const result=selection(rows,{criteria:{minDr:70,minTraffic:1000,geo:'PL'},candidatePolicy:row=>{calls.push(row.id);return row.id==='bad'?blocked('auth'):null;}});assert.deepEqual(calls,['bad']);assert.equal(result.eligible,1);assert.equal(result.available,0);assert.equal(result.unavailable.credentials,1);
});
test('multiple rows and repeated reasons count each origin once per applicable policy subtype',async()=>{
 const selection=await describe(),rows=[candidate('one'),candidate('duplicate',{baseUrl:'https://one.example/other/'})];
 const result=selection(rows,{candidatePolicy:()=>blocked('auth','auth','visual')});assert.equal(result.unavailable.excluded,1);assert.equal(result.unavailable.credentials,1);assert.equal(result.unavailable.visual,1);assert.equal(result.unavailable.security,0);
 const unknown=selection([candidate('unknown')],{candidatePolicy:()=>blocked('plugin')});assert.equal(unknown.unavailable.security,1);
});
test('omitting the callback preserves existing diagnostic shape and default counts',async()=>{
 const selection=await describe(),rows=[candidate('one'),candidate('two')],result=selection(rows,{usedOrigins:[rows[0].baseUrl],unavailability:{excludedOrigins:[rows[0].baseUrl]}});
 assert.deepEqual(result,{criteria:{minDr:null,minTraffic:null,geo:''},total:2,geo:2,dr:2,eligible:2,reserved:1,available:1,unknown:{unit:'origins',dr:0,traffic:0,geo:0},unavailable:{unit:'origins',published:0,reserved:0,excluded:1,other:0}});
});
