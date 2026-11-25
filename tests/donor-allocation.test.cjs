const test = require('node:test');
const assert = require('node:assert/strict');

const criteria = {minDr:null,minTraffic:null,geo:''};
const donor = (id, metrics={}) => ({id,baseUrl:`https://${id}.example/`,username:'fixture-user',password:'fixture-password',metrics:{dr:50,traffic:1000,geo:['UA'],...metrics}});
const request = (id, extra={}) => ({id,criteria:{...criteria},...extra});
const origins = result => Object.fromEntries(result.assignments.map(({id,candidate})=>[id,new URL(candidate.baseUrl).origin]));
const allocator = async () => (await import('../server/lifecycle/donor-allocation.mjs')).allocateDonors;

test('a flexible request leaves the sole exact donor for a strict request in either input order', async()=>{
 const allocateDonors = await allocator(), candidates = [donor('a',{dr:90}),donor('b',{dr:40})];
 const flexible=request('flexible'), strict=request('strict',{criteria:{...criteria,minDr:80}});
 for(const requests of [[flexible,strict],[strict,flexible]]){
  const result=allocateDonors(requests,candidates);
  assert.deepEqual(origins(result),{flexible:'https://b.example',strict:'https://a.example'});
  assert.deepEqual(result.assignments.map(value=>value.id),requests.map(value=>value.id));
  assert.deepEqual(result.unassigned,[]);
 }
});

test('augmenting paths recover a full allocation after every request initially has two choices',async()=>{
 const allocateDonors=await allocator(),candidates=['a','b','c','d'].map(id=>donor(id));
 const result=allocateDonors([
  request('one',{allowedOrigins:['https://a.example','https://b.example']}),
  request('two',{allowedOrigins:['https://a.example','https://c.example']}),
  request('three',{allowedOrigins:['https://b.example','https://c.example']}),
  request('four',{allowedOrigins:['https://b.example','https://d.example']})
 ],candidates);
 assert.equal(result.assignments.length,4);
 assert.equal(new Set(Object.values(origins(result))).size,4);
 assert.deepEqual(result.unassigned,[]);
});

test('equally constrained requests preserve source ranking with stable ID tie breaking',async()=>{
 const allocateDonors=await allocator(),candidates=[donor('lower-id',{dr:5}),donor('higher-id',{dr:99}),donor('last')];
 for(const requests of [[request('alpha'),request('beta')],[request('beta'),request('alpha')]]){
  assert.deepEqual(origins(allocateDonors(requests,candidates)),{alpha:'https://lower-id.example',beta:'https://higher-id.example'});
 }
});

test('GEO and metric requirements remain exact with no fallback to missing or insufficient metrics',async()=>{
 const allocateDonors=await allocator(),candidates=[
  donor('missing',{dr:null,traffic:null,geo:[]}),donor('low-dr',{dr:49}),
  donor('low-traffic',{traffic:999}),donor('wrong-geo',{geo:['US']}),donor('exact')
 ];
 const strict=request('strict',{criteria:{minDr:50,minTraffic:1000,geo:'UA,PL'}});
 assert.deepEqual(origins(allocateDonors([strict],candidates)),{strict:'https://exact.example'});
 const result=allocateDonors([strict],candidates.slice(0,-1));
 assert.deepEqual(result.assignments,[]);
 assert.deepEqual(result.unassigned,[{id:'strict',reason:'no_candidates',eligibleOrigins:0}]);
});

test('each request deduplicates origins only after evaluating its exact row criteria',async()=>{
 const allocateDonors=await allocator(),high=donor('shared-high',{dr:90}),low={...donor('shared-low',{dr:20}),baseUrl:'https://shared-high.example/other/'};
 const result=allocateDonors([request('flexible'),request('strict',{criteria:{...criteria,minDr:80}})],[low,high,donor('spare',{dr:40}),high]);
 assert.deepEqual(origins(result),{flexible:'https://spare.example',strict:'https://shared-high.example'});
 assert.equal(result.assignments.find(value=>value.id==='strict').candidate,high);
 const shortage=allocateDonors([request('one'),request('two')],[low,high,high]);
 assert.deepEqual(origins(shortage),{one:'https://shared-high.example'});
 assert.deepEqual(shortage.unassigned,[{id:'two',reason:'insufficient_candidates',eligibleOrigins:1}]);
});

test('global and request-specific origin and row reservations are removed before matching',async()=>{
 const allocateDonors=await allocator(),candidates=['a','b','c','d'].map(id=>donor(id));
 const result=allocateDonors([
  request('one',{usedOrigins:['https://c.example/path/']}),
  request('two',{usedRowIds:['d']})
 ],candidates,{usedOrigins:['https://a.example/old/'],usedRowIds:['b']});
 assert.deepEqual(origins(result),{one:'https://d.example',two:'https://c.example'});
 assert.deepEqual(result.unassigned,[]);
});

test('pinned candidates claim their exact destination and are never reassigned to help automatic requests',async()=>{
 const allocateDonors=await allocator(),a=donor('a'),b=donor('b');
 const result=allocateDonors([
  request('automatic',{allowedOrigins:['https://a.example']}),
  request('pinned',{criteria:{...criteria,minDr:99},pinnedCandidate:a})
 ],[a,b]);
 assert.deepEqual(origins(result),{pinned:'https://a.example'});
 assert.equal(result.assignments[0].candidate,a);
 assert.deepEqual(result.unassigned,[{id:'automatic',reason:'no_candidates',eligibleOrigins:0}]);
});

test('missing, reserved, and conflicting pins never receive an automatic replacement',async()=>{
 const allocateDonors=await allocator(),a=donor('a'),b=donor('b');
 assert.deepEqual(allocateDonors([request('missing',{pinnedCandidate:null})],[b]).unassigned,[{id:'missing',reason:'pinned_unavailable',eligibleOrigins:0}]);
 assert.deepEqual(allocateDonors([request('reserved',{pinnedCandidate:a})],[a,b],{usedOrigins:['https://a.example']}).unassigned,[{id:'reserved',reason:'pinned_reserved',eligibleOrigins:0}]);
 const result=allocateDonors([request('z',{pinnedCandidate:a}),request('a',{pinnedCandidate:a})],[a,b]);
 assert.deepEqual(origins(result),{a:'https://a.example'});
 assert.deepEqual(result.unassigned,[{id:'z',reason:'pinned_reserved',eligibleOrigins:0}]);
});

test('invalid candidate rows cannot crash matching or block a later valid row of the same origin',async()=>{
 const allocateDonors=await allocator(),valid=donor('valid');
 const candidates=[null,undefined,{},'row',{...valid,id:''},{...valid,baseUrl:'bad url'},
  {...valid,baseUrl:'http://insecure.example/'},{...valid,baseUrl:'https://127.0.0.1/'},
  {...valid,baseUrl:'https://user:secret@credentials.example/'},{...valid,username:''},
  {...valid,password:null},valid];
 assert.deepEqual(origins(allocateDonors([request('one')],candidates)),{one:'https://valid.example'});
 assert.deepEqual(allocateDonors([request('pin',{pinnedCandidate:{baseUrl:'bad'}})],candidates).unassigned,[{id:'pin',reason:'pinned_unavailable',eligibleOrigins:0}]);
});

test('malformed credential rows do not consume an origin or reach atomic credential admission',async()=>{
 const allocateDonors=await allocator(),valid=donor('valid');
 const candidates=[{...valid,id:'x'.repeat(501)},{...valid,username:' '},{...valid,username:'user:name'},
  {...valid,username:'x'.repeat(257)},{...valid,password:'secret\nvalue'},{...valid,password:'x'.repeat(4097)},valid];
 const result=allocateDonors([request('one')],candidates);
 assert.equal(result.assignments[0].candidate,valid);
});

test('a pinned row identity cannot also be admitted under a different candidate origin',async()=>{
 const allocateDonors=await allocator(),a=donor('a'),sameRow={...donor('other'),id:'a'},b=donor('b');
 const result=allocateDonors([request('fixed',{pinnedCandidate:a}),request('automatic')],[sameRow,b]);
 assert.deepEqual(origins(result),{fixed:'https://a.example',automatic:'https://b.example'});
});

test('allocation does not mutate requests, criteria, reservations, or source candidates',async()=>{
 const allocateDonors=await allocator(),requests=[request('one',{usedOrigins:['https://a.example'],allowedOrigins:['https://b.example/path/']})],candidates=[donor('a'),donor('b')],reservations={usedOrigins:[],usedRowIds:[]};
 const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
 freeze(requests);freeze(candidates);freeze(reservations);
 assert.deepEqual(origins(allocateDonors(requests,candidates,reservations)),{one:'https://b.example'});
});

test('an empty allowed-origin list stays empty and no-candidate failures retain original request order',async()=>{
 const allocateDonors=await allocator();
 const result=allocateDonors([request('z',{allowedOrigins:[]}),request('a',{criteria:{...criteria,minDr:90}})],[donor('low')]);
 assert.deepEqual(result,{assignments:[],unassigned:[{id:'z',reason:'no_candidates',eligibleOrigins:0},{id:'a',reason:'no_candidates',eligibleOrigins:0}]});
 assert.deepEqual(allocateDonors([],[]),{assignments:[],unassigned:[]});
});

for(const size of [20,100])test(`a ${size}-request batch preserves all matches when donors after the preferred prefix are needed`,async()=>{
 const allocateDonors=await allocator(),candidates=Array.from({length:1000},(_,i)=>donor('site-'+i));
 const requests=Array.from({length:size},(_,i)=>request(String(i).padStart(4,'0'),i===size-1?{allowedOrigins:['https://site-999.example']}:{}));
 const result=allocateDonors(requests,candidates);
 assert.equal(result.assignments.length,size);
 assert.equal(new Set(Object.values(origins(result))).size,size);
 assert.equal(origins(result)[String(size-1).padStart(4,'0')],'https://site-999.example');
});

test('maximum cardinality agrees with exhaustive assignments across every small allowed-origin graph',async()=>{
 const allocateDonors=await allocator();
 for(const [requestCount,donorCount] of [[4,3],[3,4]]){
  const candidates=Array.from({length:donorCount},(_,i)=>donor('site-'+i));
  for(let graph=0;graph<2**(requestCount*donorCount);graph++){
   const allowed=Array.from({length:requestCount},(_,r)=>Array.from({length:donorCount},(_,d)=>d).filter(d=>graph&(1<<(r*donorCount+d))));
   // Enumerate every legal assignment, including leaving each request unmatched;
   // this independent oracle does not use augmenting paths or candidate trims.
   const exhaustive=(index,taken)=>{
    if(index===requestCount)return 0;
    let best=exhaustive(index+1,taken);
    for(const d of allowed[index])if(!(taken&(1<<d)))best=Math.max(best,1+exhaustive(index+1,taken|(1<<d)));
    return best;
   };
   const requests=allowed.map((choices,index)=>request('request-'+index,{allowedOrigins:choices.map(d=>`https://site-${d}.example`)}));
   const result=allocateDonors(requests,candidates);
   assert.equal(result.assignments.length,exhaustive(0,0),`graph ${requestCount}x${donorCount}: ${graph}`);
   assert.equal(new Set(result.assignments.map(value=>value.candidate.id)).size,result.assignments.length);
  }
 }
});

test('100 requests against 100,000 source rows read candidate URLs once and retain a complete allocation',{timeout:20000},async()=>{
 const allocateDonors=await allocator();let urlReads=0,metricReads=0;
 const candidates=Array.from({length:100000},(_,i)=>({id:'site-'+i,username:'fixture-user',password:'fixture-password',get baseUrl(){urlReads++;return `https://site-${i}.example/`;},get metrics(){metricReads++;return {dr:50,traffic:1000,geo:['UA']};}}));
 const requests=Array.from({length:100},(_,i)=>request(String(i).padStart(4,'0'))),result=allocateDonors(requests,candidates);
 assert.equal(result.assignments.length,100);
 assert.equal(new Set(result.assignments.map(value=>value.candidate.id)).size,100);
 assert.ok(urlReads<=100000,`URLs read ${urlReads} times`);
 assert.ok(metricReads<=100000*100,`Metrics read ${metricReads} times`);
 assert.equal(result.assignments[0].candidate.id,'site-0');
 assert.equal(result.assignments[99].candidate.id,'site-99');
});
