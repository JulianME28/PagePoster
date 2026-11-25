'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const criteria={minDr:null,minTraffic:null,geo:''},request=(id,extra={})=>({id,criteria:{...criteria},...extra});
const donor=(id,extra={})=>({id,baseUrl:'https://'+id+'.example/',rowNumber:2,username:'primary-user',password:'primary-password',alternateCredentials:{username:'alternate-user',password:'alternate-password'},metrics:{dr:80,traffic:10000,geo:['PL']},...extra});
const allocator=async()=>(await import('../server/lifecycle/donor-allocation.mjs')).allocateDonors;

test('request-specific exclusions are applied before matching so scarce material-compatible donors remain available',async()=>{
 const allocate=await allocator(),candidates=[donor('a'),donor('b')],requests=[request('flexible',{material:'fresh'}),request('restricted',{material:'rejected-on-b'})];
 const result=allocate(requests,candidates,{candidateFor:(run,candidate)=>run.material==='rejected-on-b'&&candidate.id==='b'?null:candidate});
 assert.deepEqual(Object.fromEntries(result.assignments.map(row=>[row.id,row.candidate.id])),{flexible:'b',restricted:'a'});assert.deepEqual(result.unassigned,[]);
});
test('a rejected account row does not consume the origin before a later eligible pair',async()=>{
 const allocate=await allocator(),bad=donor('bad',{baseUrl:'https://shared.example/'}),good=donor('good',{baseUrl:'https://shared.example/path/',username:'corrected-user',password:'corrected-password'});
 const result=allocate([request('run')],[bad,good],{candidateFor:(_,candidate)=>candidate.password==='primary-password'?null:candidate});assert.equal(result.assignments.length,1);assert.equal(result.assignments[0].candidate.id,'good');assert.equal(result.assignments[0].candidate.password,'corrected-password');
});
test('credential promotion is private to each request and retains exact donor metadata',async()=>{
 const allocate=await allocator(),raw=donor('shared'),before=structuredClone(raw);const result=allocate([request('uses-alternate')],[raw],{candidateFor:(_,candidate)=>{const {alternateCredentials,...rest}=candidate;return {...rest,...alternateCredentials};}});const chosen=result.assignments[0].candidate;assert.equal(chosen.username,'alternate-user');assert.equal(chosen.password,'alternate-password');assert.equal(chosen.alternateCredentials,undefined);for(const field of ['id','baseUrl','rowNumber','metrics'])assert.deepEqual(chosen[field],raw[field]);assert.deepEqual(raw,before);
});
test('callback output cannot rewrite identity, destination, ranking, or other selection metadata',async()=>{
 const allocate=await allocator(),raw=donor('a'),changes=[{id:'other'},{baseUrl:'https://other.example/'},{baseUrl:'https://a.example/different/'},{rowNumber:99},{metrics:{...raw.metrics,dr:99}},{metrics:{...raw.metrics,geo:['US']}},{extraSelection:'invented'}];
 for(const change of changes){const result=allocate([request('run')],[raw],{candidateFor:(_,candidate)=>({...candidate,...change})});assert.deepEqual(result.assignments,[],JSON.stringify(change));assert.deepEqual(result.unassigned,[{id:'run',reason:'no_candidates',eligibleOrigins:0}]);}
});
test('callback cannot raise raw metrics to evade criteria and invalid transformed credentials are excluded',async()=>{
 const allocate=await allocator(),low=donor('low',{metrics:{dr:20,traffic:10,geo:['US']}});assert.deepEqual(allocate([request('strict',{criteria:{minDr:70,minTraffic:100,geo:'PL'}})],[low],{candidateFor:(_,candidate)=>({...candidate,metrics:{dr:90,traffic:1000,geo:['PL']}})}).assignments,[]);
 for(const change of [{username:''},{username:'invalid:name'},{password:null},{password:'invalid\nsecret'}])assert.deepEqual(allocate([request('run')],[donor('a')],{candidateFor:(_,candidate)=>({...candidate,...change})}).assignments,[]);
});
test('pinned policy rejection does not replace a fixed donor and accepted promotion retains its reservation',async()=>{
 const allocate=await allocator(),a=donor('a'),b=donor('b'),requests=[request('pin',{pinnedCandidate:a}),request('automatic')];let result=allocate(requests,[a,b],{candidateFor:(run,candidate)=>run.id==='pin'?null:candidate});assert.equal(result.assignments.find(row=>row.id==='automatic').candidate.id,'a');assert.deepEqual(result.unassigned,[{id:'pin',reason:'pinned_unavailable',eligibleOrigins:0}]);
 result=allocate(requests,[a,b],{candidateFor:(run,candidate)=>run.id==='pin'?{...candidate,...candidate.alternateCredentials}:candidate});assert.equal(result.assignments.find(row=>row.id==='pin').candidate.username,'alternate-user');assert.equal(result.assignments.find(row=>row.id==='automatic').candidate.id,'b');
});
test('request-local transformed candidates survive an augmenting path without borrowing another request credentials',async()=>{
 const allocate=await allocator(),candidates=['a','b','c','d'].map(id=>donor(id)),allowed={one:['a','b'],two:['a','c'],three:['b','c'],four:['b','d']};
 const result=allocate(Object.keys(allowed).map(id=>request(id)),candidates,{candidateFor:(run,candidate)=>allowed[run.id].includes(candidate.id)?{...candidate,username:run.id,password:'private-'+run.id}:null});assert.equal(result.assignments.length,4);for(const assignment of result.assignments){assert.equal(assignment.candidate.username,assignment.id);assert.equal(assignment.candidate.password,'private-'+assignment.id);}assert.equal(new Set(result.assignments.map(row=>new URL(row.candidate.baseUrl).origin)).size,4);
});
test('policy-filtered first-K truncation agrees with exhaustive small compatibility graphs',async()=>{
 const allocate=await allocator();
 for(const [requestCount,donorCount] of [[4,3],[3,4]]){const candidates=Array.from({length:donorCount},(_,index)=>donor('site-'+index)),requests=Array.from({length:requestCount},(_,index)=>request(String(index)));
  for(let graph=0;graph<2**(requestCount*donorCount);graph++){const allowed=requests.map((_,index)=>candidates.flatMap((_,donorIndex)=>graph&(1<<(index*donorCount+donorIndex))?[donorIndex]:[])),exhaustive=(index,taken)=>{if(index===requests.length)return 0;let best=exhaustive(index+1,taken);for(const donorIndex of allowed[index])if(!(taken&(1<<donorIndex)))best=Math.max(best,1+exhaustive(index+1,taken|(1<<donorIndex)));return best;};const result=allocate(requests,candidates,{candidateFor:(run,candidate)=>allowed[Number(run.id)].includes(candidates.indexOf(candidate))?candidate:null});assert.equal(result.assignments.length,exhaustive(0,0),`graph ${requestCount}x${donorCount}: ${graph}`);}
 }
});
