const test = require('node:test');
const assert = require('node:assert/strict');
const {generateKeyPairSync, verify} = require('node:crypto');
const config = {spreadsheetId:'private-sheet',range:'Sites!A1:D100',headerRows:1,columns:{url:'A',username:'B',password:'C',enabled:'D'},serviceAccount:{clientEmail:'reader@example.iam.gserviceaccount.com',privateKey:'fixture-key'}};
test('private sheet candidates preserve passwords, skip disabled/used/invalid rows, and choose deterministically', async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const source=createSiteSource({readSheet:async()=>({values:[['URL','User','Password','Enabled'],['https://used.example/','u','p','yes'],['https://off.example/','u','p','false'],['https://first.example/blog/','user',' exact secret ','true'],['https://first.example/blog/','duplicate','other','true'],['http://bad.example/','u','p','true'],['https://second.example/','u2','p2','1']]})});
 const result=await source.readCandidates(config,{usedOrigins:['https://used.example']});
 assert.deepEqual(result.candidates.map(c=>c.baseUrl),['https://first.example/blog/','https://second.example/']);
 assert.equal(result.candidates[0].password,' exact secret ');assert.equal(result.candidates[0].rowNumber,4);
 assert.equal((await source.pickUnused(config,{usedOrigins:['https://used.example']})).id,result.candidates[0].id);
 assert.ok(!JSON.stringify(result.issues).includes('secret'));
 assert.equal(await source.pickUnused(config,{usedOrigins:['https://used.example','https://first.example','https://second.example']}),null);
});
test('service account signs readonly JWT, obtains token and only reads the selected private range',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const calls=[];
 const source=createSiteSource({clock:()=>1700000000000,transport:async(url,options)=>{
  calls.push({url,options});
  if(url==='https://oauth2.googleapis.com/token'){
   const params=new URLSearchParams(options.body),jwt=params.get('assertion'),parts=jwt.split('.');
   assert.equal(params.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
   const claims=JSON.parse(Buffer.from(parts[1],'base64url'));assert.equal(claims.scope,'https://www.googleapis.com/auth/spreadsheets.readonly');assert.equal(claims.iss,config.serviceAccount.clientEmail);assert.equal(claims.exp-claims.iat,3600);assert.equal(verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),publicKey,Buffer.from(parts[2],'base64url')),true);
   return{status:200,text:JSON.stringify({access_token:'fixture-token',token_type:'Bearer',expires_in:3600}),url};
  }
  assert.equal(options.method,'GET');assert.equal(options.headers.authorization,'Bearer fixture-token');assert.equal(new URL(url).pathname,'/v4/spreadsheets/private-sheet/values/Sites!A1%3AD100');
  return{status:200,text:JSON.stringify({range:'Sites!A1:D100',values:[['URL','U','P','E'],['https://selected.example','user','pass','yes']]}),url};
 }});
 const result=await source.readCandidates({...config,serviceAccount:{...config.serviceAccount,privateKey:privateKey.export({type:'pkcs8',format:'pem'})}});
 assert.equal(result.candidates[0].baseUrl,'https://selected.example/');assert.equal(calls.length,2);assert.equal(calls[0].options.followRedirects,false);
});
test('source authentication errors and redirects never expose response bodies or send bearer tokens elsewhere',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const cfg={...config,serviceAccount:{...config.serviceAccount,privateKey:privateKey.export({type:'pkcs8',format:'pem'})}};
 let calls=0;const source=createSiteSource({transport:async(url)=>{calls++;return{status:302,headers:{location:'https://foreign.example/'},text:'private-password fixture-key',url};}});
 await assert.rejects(source.readCandidates(cfg),e=>e.code==='source_auth_failed'&&!e.message.includes('private-password'));assert.equal(calls,1);
 await assert.rejects(createSiteSource({readSheet:async()=>{throw Error('private-password');}}).readCandidates(config),e=>e.code==='source_read_failed'&&!e.message.includes('private-password'));
});

test('A1 range row/column offsets and headerRows refer to the actual sheet cells',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');const source=createSiteSource({readSheet:async()=>({values:[['URL','User','Password','Enabled'],['https://offset.example/','u','exact','true']]})});
 const result=await source.readCandidates({...config,range:"'Private Sites'!C6:F20",columns:{url:'C',username:'D',password:'E',enabled:'F'},headerRows:1});assert.equal(result.candidates[0].rowNumber,7);assert.equal(result.candidates[0].password,'exact');
 await assert.rejects(source.readCandidates({...config,range:'Sites!C6:F20'}),{code:'source_validation'});
});

test('historic reservations do not hide unused domains after Sheet rows move or change',async t=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const header=['URL','User','Password','Enabled'],used=['https://used.example/','used-user','used-password','true'],unused=['https://unused.example/','new-user',' exact new password ','true'];
 // Saved by the former row-position identity for private-sheet / Sites / row 2.
 const legacyId='sheet-e3bb0fce6b0dd7e3a1ff83b8e00b3327be6562584c70a8a2d1d314071d60a7dd';
 for(const [name,rows] of [['sorted',[header,unused,used]],['used row deleted',[header,unused]],['used row replaced',[header,unused,used,unused]]])await t.test(name,async()=>{
  const source=createSiteSource({readSheet:async()=>({values:rows})});
  const result=await source.readCandidates(config,{usedOrigins:['https://used.example'],usedRowIds:[legacyId]});
  assert.deepEqual(result.candidates.map(candidate=>candidate.baseUrl),['https://unused.example/']);
  assert.equal(result.candidates[0].rowNumber,2);assert.equal(result.candidates[0].password,' exact new password ');assert.deepEqual(result.issues,[]);
 });
});

test('candidate reservations follow the same origin across reordered rows and URL paths',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const header=['URL','User','Password','Enabled'];
 let rows=[header,['https://reserved.example/blog/','u','p','true'],['https://free.example/','u','p','true']];
 const source=createSiteSource({readSheet:async()=>({values:rows})}),reserved=await source.pickUnused(config);
 rows=[header,['https://free.example/','u','p','true'],['https://reserved.example/other/','u','p','true'],['https://free.example/duplicate/','u','p','true']];
 const result=await source.readCandidates(config,{usedRowIds:[reserved.id]});
 assert.deepEqual(result.candidates.map(candidate=>candidate.baseUrl),['https://free.example/']);
 assert.equal(result.candidates[0].rowNumber,2);
});

const extendedColumns={url:'B',dr:'D',traffic:'E',geo:'F',username:'K',password:'L',alternateUsername:'N',alternatePassword:'O'};
const extendedConfig={...config,range:'Sites!A1:O50000',columns:extendedColumns};
function extendedRow({domain='site.example',dr=20,traffic=100,geo='(us, 0)',username='primary',password=' primary secret ',alternateUsername='',alternatePassword=''}={}){
 const row=Array(15).fill('');Object.assign(row,{1:domain,3:dr,4:traffic,5:geo,10:username,11:password,13:alternateUsername,14:alternatePassword});return row;
}

test('source validation canonicalizes new mappings, accepts an accountless draft, and normalizes explicit criteria',async()=>{
 const {validateSiteSourceConfig,normalizeSiteCriteria}=await import('../server/lifecycle/site-source.mjs');
 const value=validateSiteSourceConfig({...extendedConfig,serviceAccount:{client_email:config.serviceAccount.clientEmail,private_key:'exact-key'},columns:{...extendedColumns,url:'b',enabled:''}});
 assert.equal(value.columns.url,'B');assert.equal(value.columns.enabled,undefined);assert.deepEqual(value.serviceAccount,{clientEmail:config.serviceAccount.clientEmail,privateKey:'exact-key'});
 const draft={...extendedConfig};delete draft.serviceAccount;assert.equal(validateSiteSourceConfig(draft,{allowMissingAccount:true}).serviceAccount,undefined);
 assert.throws(()=>validateSiteSourceConfig(draft),{code:'source_validation'});
 assert.deepEqual(normalizeSiteCriteria(),{minDr:null,minTraffic:null,geo:''});
 assert.deepEqual(normalizeSiteCriteria({minDr:25.5,minTraffic:1000,geo:'pl, DE,pl'}),{minDr:25.5,minTraffic:1000,geo:'DE,PL'});
 for(const bad of [{minDr:101},{minDr:'25'},{minTraffic:-1},{minTraffic:1.5},{geo:'POLAND'},{geo:'us.example'},{unexpected:true}])assert.throws(()=>normalizeSiteCriteria(bad),{code:'source_validation'});
 const missingPair={...extendedColumns};delete missingPair.alternatePassword;assert.throws(()=>validateSiteSourceConfig({...extendedConfig,columns:missingPair}),{code:'source_validation'});
});

test('bare domains, exact metric filters and country tuples rank candidates without mixing credential pairs',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const rows=[[],extendedRow({domain:'lower.example',dr:40,traffic:500}),extendedRow({domain:'highest.example',dr:60,traffic:1200,geo:'US',alternateUsername:'backup',alternatePassword:' exact backup '}),extendedRow({domain:'higher-traffic.example',dr:40,traffic:1500,geo:'(de, 3), (us, 0)'}),extendedRow({domain:'secondary.example',dr:45,username:'',password:'',alternateUsername:'second',alternatePassword:' untouched '}),extendedRow({domain:'missing.example',dr:'',traffic:''}),extendedRow({domain:'bad-geo.example',dr:99,geo:'status'}),extendedRow({domain:'bad-creds.example',username:'missing',password:'',alternateUsername:'',alternatePassword:'not paired'}),extendedRow({domain:'http://insecure.example/'}),extendedRow({domain:'127.0.0.1'}),extendedRow({domain:'user:pass@host.example'})];
 const source=createSiteSource({readSheet:async()=>({values:rows})}),result=await source.readCandidates(extendedConfig,{criteria:{minDr:30,minTraffic:100,geo:'us'}});
 assert.deepEqual(result.candidates.map(c=>c.baseUrl),['https://highest.example/','https://secondary.example/','https://higher-traffic.example/','https://lower.example/']);
 assert.equal(result.candidates[0].password,' primary secret ');assert.deepEqual(result.candidates[0].alternateCredentials,{username:'backup',password:' exact backup '});
 assert.deepEqual(result.candidates[0].metrics,{dr:60,traffic:1200,geo:['US']});
 assert.equal(result.candidates[1].username,'second');assert.equal(result.candidates[1].password,' untouched ');assert.equal(result.candidates[1].alternateCredentials,undefined);
 assert.ok(result.issues.every(issue=>Object.keys(issue).every(key=>['rowNumber','code'].includes(key))));assert.doesNotMatch(JSON.stringify(result.issues),/primary|secret|backup|untouched|not paired/);
 assert.equal((await source.pickUnused(extendedConfig,{criteria:{minDr:30,minTraffic:100,geo:'DE'}})).baseUrl,'https://higher-traffic.example/');
});

test('missing metrics stay unknown, strict text numbers parse, and equal ranks keep original row order',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const rows=[[],extendedRow({domain:'unknown.example',dr:'',traffic:''}),extendedRow({domain:'zero.example',dr:0,traffic:0}),extendedRow({domain:'first.example',dr:'42.5',traffic:'1200'}),extendedRow({domain:'second.example',dr:42.5,traffic:1200}),extendedRow({domain:'malformed.example',dr:'42percent',traffic:'1,200'})];
 const source=createSiteSource({readSheet:async()=>({values:rows})}),all=await source.readCandidates(extendedConfig);
 assert.deepEqual(all.candidates.slice(0,3).map(c=>c.baseUrl),['https://first.example/','https://second.example/','https://zero.example/']);
 assert.deepEqual(all.candidates.find(c=>c.baseUrl==='https://unknown.example/').metrics,{dr:null,traffic:null,geo:['US']});
 const filtered=await source.readCandidates(extendedConfig,{criteria:{minDr:0,minTraffic:0}});assert.deepEqual(filtered.candidates.map(c=>c.baseUrl),['https://first.example/','https://second.example/','https://zero.example/']);
 await assert.rejects(source.readCandidates(config,{criteria:{minDr:10}}),{code:'source_validation'});
});

test('injected whole-sheet fixtures support a best candidate beyond row 30000 and reject silent truncation',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const rows=Array.from({length:30002},()=>[]);rows[1]=extendedRow({domain:'early.example',dr:20});rows[30001]=extendedRow({domain:'last.example',dr:90});
 const source=createSiteSource({readSheet:async()=>({values:rows})});const result=await source.readCandidates(extendedConfig);assert.equal(result.candidates[0].rowNumber,30002);assert.equal(result.candidates[0].baseUrl,'https://last.example/');
 await assert.rejects(createSiteSource({readSheet:async()=>({values:Array.from({length:100001},()=>[])})}).readCandidates({...extendedConfig,range:'Sites!A:O'}),{code:'source_limit_exceeded'});
});

test('whole-sheet Google reads page through empty middle ranges and only select after the bounded scan ends',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const ranges=[];
 const source=createSiteSource({transport:async(url,options)=>{
  if(url==='https://oauth2.googleapis.com/token')return {status:200,url,text:JSON.stringify({access_token:'page-token',token_type:'Bearer'})};
  const parsed=new URL(url);assert.equal(options.method,'GET');assert.equal(options.headers.authorization,'Bearer page-token');
  if(!parsed.pathname.includes('/values/')){assert.equal(parsed.searchParams.has('fields'),true);return {status:200,url,text:JSON.stringify({sheets:[{properties:{sheetId:0,title:'Sites',index:0,gridProperties:{rowCount:30005,columnCount:15}}}]})};}
  const range=decodeURIComponent(parsed.pathname.split('/values/')[1]),match=/!A(\d+):O(\d+)$/.exec(range);assert.ok(match,range);const first=Number(match[1]),last=Number(match[2]);ranges.push([first,last]);assert.ok(last-first<2000);
  const values=[];if(first===1)values[1]=extendedRow({domain:'early.example',dr:20});if(last===30005){while(values.length<30005-first)values.push([]);values.push(extendedRow({domain:'late.example',dr:95}));}
  return {status:200,url,text:JSON.stringify({range,values})};
 }});
 const selected=await source.pickUnused({...extendedConfig,range:'Sites!A:O',serviceAccount:{clientEmail:config.serviceAccount.clientEmail,privateKey:privateKey.export({type:'pkcs8',format:'pem'})}});
 assert.equal(selected.baseUrl,'https://late.example/');assert.equal(selected.rowNumber,30005);assert.ok(ranges.length>=16);assert.equal(ranges[0][0],1);assert.equal(ranges.at(-1)[1],30005);for(let index=1;index<ranges.length;index++)assert.equal(ranges[index][0],ranges[index-1][1]+1);
});

async function pagedReader({rowCount=3000,title='Sites',columnCount=15,onRange}={}){
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});let valueCalls=0;
 const source=createSiteSource({transport:async(url)=>{
  if(url==='https://oauth2.googleapis.com/token')return {status:200,url,text:JSON.stringify({access_token:'fixture-secret-token',token_type:'Bearer'})};
  const parsed=new URL(url);if(!parsed.pathname.includes('/values/'))return {status:200,url,text:JSON.stringify({sheets:[{properties:{title,index:0,gridProperties:{rowCount,columnCount}}}]})};
  valueCalls++;const range=decodeURIComponent(parsed.pathname.split('/values/')[1]),reply=await onRange(range,valueCalls);return {status:200,url,text:JSON.stringify(reply)};
 }});
 return {source,config:{...extendedConfig,range:'Sites!A:O',serviceAccount:{clientEmail:config.serviceAccount.clientEmail,privateKey:privateKey.export({type:'pkcs8',format:'pem'})}},valueCalls:()=>valueCalls};
}

test('an oversized grid fails before reading rows and a late read error never returns a partial winner',async()=>{
 const oversized=await pagedReader({rowCount:100001,onRange:()=>assert.fail('No values may be read beyond the scan cap')});
 await assert.rejects(oversized.source.pickUnused(oversized.config),error=>error.code==='source_limit_exceeded'&&/100 000/.test(error.message));assert.equal(oversized.valueCalls(),0);
 const interrupted=await pagedReader({onRange:(_range,call)=>{if(call===2)throw Error('fixture-password and token must stay private');return {values:[[],extendedRow({domain:'partial.example',dr:90})]};}});
 await assert.rejects(interrupted.source.pickUnused(interrupted.config),error=>error.code==='source_read_failed'&&!/password|token/.test(error.message));assert.equal(interrupted.valueCalls(),2);
});

test('paged ranges retain quoted sheet names and absolute row offsets, skipping headers only once',async()=>{
 const ranges=[],reader=await pagedReader({title:"Owner's ! Sites",rowCount:2010,columnCount:17,onRange:range=>{ranges.push(range);return {values:ranges.length===2?[extendedRow({domain:'page-boundary.example',dr:75})]:[]};}});
 const cfg={...reader.config,range:"'Owner''s ! Sites'!C6:Q",headerRows:2,columns:{url:'D',dr:'F',traffic:'G',geo:'H',username:'M',password:'N',alternateUsername:'P',alternatePassword:'Q'}};
 const candidate=await reader.source.pickUnused(cfg);assert.equal(candidate.rowNumber,2006);assert.equal(candidate.baseUrl,'https://page-boundary.example/');
 assert.deepEqual(ranges,["'Owner''s ! Sites'!C6:Q2005","'Owner''s ! Sites'!C2006:Q2010"]);
});

test('duplicate origins keep the best eligible ranked row and country matching never uses substrings',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const rows=[[],extendedRow({domain:'same.example',dr:20,password:' low '}),extendedRow({domain:'same.example',dr:90,password:' high '}),extendedRow({domain:'not-us.example',dr:99,geo:'RUS'}),extendedRow({domain:'real-us.example',dr:95,geo:"('us', 0)"})];
 const source=createSiteSource({readSheet:async()=>({values:rows})}),result=await source.readCandidates(extendedConfig,{criteria:{geo:'US'}});
 assert.deepEqual(result.candidates.map(c=>c.baseUrl),['https://real-us.example/','https://same.example/']);assert.equal(result.candidates[1].password,' high ');assert.equal(result.candidates[1].rowNumber,3);
 assert.equal((await source.pickUnused(extendedConfig,{usedRowIds:[result.candidates[0].id],usedOrigins:['https://same.example'],criteria:{geo:'US'}})),null);
});

test('site criteria canonicalize UK and reject unassigned country codes',async()=>{
 const {normalizeSiteCriteria}=await import('../server/lifecycle/site-source.mjs');
 assert.equal(normalizeSiteCriteria({geo:'uk,GB,ua'}).geo,'GB,UA');
 assert.throws(()=>normalizeSiteCriteria({geo:'ZZ'}),{code:'source_validation'});
});
