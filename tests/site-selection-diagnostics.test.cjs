const test=require('node:test'),assert=require('node:assert/strict');
const config={spreadsheetId:'diagnostics-sheet',range:'Sites!A1:F100',columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'},headerRows:1};
test('source diagnostics count unique origins through each filter without exposing credentials',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const rows=[['url','user','pass','dr','traffic','geo'],
 ['one.example','private-user','private-secret',30,100,'SK'],['one.example','private-user','private-secret',80,1000,'HU'],
 ['two.example','private-user','private-secret',5,100,'SK'],['three.example','private-user','private-secret',30,10,'SK'],
 ['four.example','private-user','private-secret',40,'','SK'],['five.example','private-user','private-secret',30,100,'HU'],
 ['no-login.example','','',90,2000,'SK']];
 const source=createSiteSource({readSheet:async()=>({values:rows})});
 const result=await source.readCandidates(config,{criteria:{minDr:20,minTraffic:50,geo:'SK'},usedOrigins:['https://one.example/']});
 assert.equal(result.candidates.length,0);
 const {input,unknown,unavailable,...funnel}=result.diagnostics;
 assert.deepEqual(funnel,{criteria:{minDr:20,minTraffic:50,geo:'SK'},total:5,geo:4,dr:3,eligible:1,reserved:1,available:0});
 assert.doesNotMatch(JSON.stringify(result.diagnostics),/private-user|private-secret|example/);
 assert.equal(result.issues.find(i=>i.code==='missing_credentials').rowNumber,8);
});

// Fails if duplicate rows inflate counts or one unknown row hides a known metric.
test('unknown metrics count only origins without any known value for that metric',async()=>{
 const {describeSiteSelection}=await import('../server/lifecycle/site-selection.mjs');
 const candidate=(id,host,metrics)=>({id,baseUrl:'https://'+host+'.example/',metrics,username:'private-user',password:'private-secret'});
 const result=describeSiteSelection([
  candidate('a1','a',{dr:null,traffic:null,geo:[]}),candidate('a2','a',{dr:0,traffic:0,geo:['SK']}),
  candidate('b1','b',{dr:null,traffic:10,geo:[]}),candidate('b2','b',{dr:null,traffic:null,geo:[]}),
  candidate('c','c',{dr:20,traffic:null,geo:['HU']})
 ]);
 assert.equal(result.total,3);assert.equal(result.available,3);
 assert.deepEqual(result.unknown,{unit:'origins',dr:1,traffic:1,geo:1});
 assert.doesNotMatch(JSON.stringify(result),/private-|example/);
});

// Fails if historical rejection is presented as a reservation or categories overlap.
test('unavailable reasons partition blocked eligible origins with ownership precedence',async()=>{
 const {describeSiteSelection}=await import('../server/lifecycle/site-selection.mjs');
 const candidates=['published','reserved','excluded','other','free'].map(id=>({id,baseUrl:'https://'+id+'.example/',metrics:{dr:50,traffic:100,geo:['SK']}}));
 candidates.push({...candidates[1],id:'reserved-duplicate'});
 const result=describeSiteSelection(candidates,{criteria:{minDr:20,minTraffic:50,geo:'SK'},usedOrigins:candidates.slice(0,4).map(c=>c.baseUrl),
  unavailability:{publishedOrigins:['https://published.example/path'],reservedOrigins:['https://published.example','https://reserved.example'],reservedRowIds:['excluded'],excludedOrigins:['https://published.example','https://reserved.example','https://excluded.example'],excludedRowIds:['other-unrelated']}});
 assert.deepEqual(result.unavailable,{unit:'origins',published:1,reserved:2,excluded:0,other:1});
 assert.equal(result.reserved,4);assert.equal(result.available,1);
 assert.equal(Object.entries(result.unavailable).filter(([key])=>key!=='unit').reduce((sum,[,n])=>sum+n,0),result.reserved);
 const excluded=describeSiteSelection(candidates,{usedRowIds:['excluded'],unavailability:{excludedRowIds:['excluded']}});
 assert.deepEqual(excluded.unavailable,{unit:'origins',published:0,reserved:0,excluded:1,other:0});
 assert.doesNotMatch(JSON.stringify(result),/example|duplicate/);
});

// Fails if malformed/missing-credential rows disappear behind a zero-donor result.
test('source input counts distinguish row failures while its funnel remains unique origins',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const rows=[['URL','User','Password','DR','Traffic','GEO','Enabled'],[],
  ['off.example','private-user','private-secret',50,100,'SK','false'],
  ['invalid url','private-user','private-secret',50,100,'SK','true'],'broken row',
  ['flag.example','private-user','private-secret',50,100,'SK','maybe'],
  ['no-login.example','','',50,100,'SK','true'],
  ['known.example','private-user','private-secret','bad',100,'SK','true'],
  ['known.example','private-user','private-secret',40,'','','true'],
  ['unknown.example','private-user','private-secret','','','','true']];
 const source=createSiteSource({readSheet:async()=>({values:rows})});
 const result=await source.readCandidates({...config,range:'Sites!A1:G100',columns:{...config.columns,enabled:'G'}},{usedOrigins:['https://known.example'],unavailability:{excludedOrigins:['https://known.example']}});
 assert.deepEqual(result.inputDiagnostics,{unit:'rows',nonempty:8,disabled:1,invalidUrl:1,invalidRow:2,missingCredentials:1});
 assert.deepEqual(result.diagnostics.input,result.inputDiagnostics);
 assert.equal(result.diagnostics.total,2);assert.equal(result.diagnostics.reserved,1);
 assert.deepEqual(result.diagnostics.unknown,{unit:'origins',dr:1,traffic:1,geo:1});
 assert.deepEqual(result.diagnostics.unavailable,{unit:'origins',published:0,reserved:0,excluded:1,other:0});
 assert.doesNotMatch(JSON.stringify(result.diagnostics),/private-|example|broken row/);
 const {describeSiteSelection}=await import('../server/lifecycle/site-selection.mjs');
 const cached=describeSiteSelection(result.candidates,{inputDiagnostics:{...result.inputDiagnostics,privatePassword:'private-secret'}});
 assert.deepEqual(cached.input,result.inputDiagnostics);assert.doesNotMatch(JSON.stringify(cached),/private/);
});
