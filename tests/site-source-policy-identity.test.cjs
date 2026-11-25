'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const columns={url:'A',username:'B',password:'C'},config={spreadsheetId:'identity-sheet',range:'Sites!A1:C3000',headerRows:1,columns,authMode:'user'};
const token='private-source-token-identity',username='private-source-user-identity',password='private-source-password-identity',privateKey='private-service-key-identity';
function safe(identity){const encoded=JSON.stringify(identity);for(const secret of [token,username,password,privateKey])assert.ok(!encoded.includes(secret));assert.doesNotMatch(encoded,/serviceAccount|privateKey|accessToken|readerPrincipal|"(?:username|password)":"private-/);}
async function apiReader({sheets,onValues}={}){
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');let reads=0,metadataReads=0;const ranges=[];
 const source=createSiteSource({getAccessToken:async()=>token,readRetry:{maxAttempts:1},transport:async(url,options)=>{
  assert.equal(options.method,'GET');assert.equal(options.headers.authorization,'Bearer '+token);
  if(!new URL(url).pathname.includes('/values/')){metadataReads++;return {status:200,url,text:JSON.stringify({sheets:typeof sheets==='function'?sheets(metadataReads):sheets||[{properties:{sheetId:37,title:'Sites',index:0,gridProperties:{rowCount:3000,columnCount:3}}}]})};}
  reads++;const range=decodeURIComponent(new URL(url).pathname.split('/values/')[1]);ranges.push(range);const data=onValues?await onValues(range,reads):{range,values:/A1:/.test(range)?[['URL','User','Password'],['https://candidate.example/',username,password]]:[]};return {status:200,url,text:JSON.stringify(data)};
 }});
 return {source,ranges,get reads(){return reads;},get metadataReads(){return metadataReads;}};
}

test('private source identity retains one resolved sheet across paged reads and normalizes equivalent config',async()=>{
 const reader=await apiReader(),first=await reader.source.readCandidates(config),second=await reader.source.readCandidates({...config,range:"'Sites'!a1:c3000",columns:{password:'c',url:'a',username:'b'}});
 assert.deepEqual(first.sourceIdentity,{spreadsheetId:'identity-sheet',resolvedSheetId:37,sheetName:'Sites',range:'Sites!A1:C3000',columns,headerRows:1,authMode:'user'});assert.deepEqual(second.sourceIdentity,first.sourceIdentity);assert.equal(reader.metadataReads,2);assert.equal(reader.reads,4);assert.deepEqual(reader.ranges.slice(0,2),["'Sites'!A1:C2000","'Sites'!A2001:C3000"]);assert.equal(first.candidates[0].password,password);safe(first.sourceIdentity);
});

test('changing the first visible sheet changes private identity even for a bounded short unqualified range',async()=>{
 const reader=await apiReader({sheets:call=>[{properties:{sheetId:9,title:'Hidden',index:0,hidden:true,gridProperties:{rowCount:10,columnCount:3}}},{properties:{sheetId:call===1?37:38,title:'Sites',index:1,gridProperties:{rowCount:10,columnCount:3}}}]}),short={...config,range:'A1:C10'};
 const first=await reader.source.readCandidates(short),second=await reader.source.readCandidates(short);assert.equal(first.sourceIdentity.resolvedSheetId,37);assert.equal(second.sourceIdentity.resolvedSheetId,38);assert.equal(first.sourceIdentity.sheetName,'Sites');assert.equal(first.sourceIdentity.range,'Sites!A1:C10');assert.notDeepEqual(first.sourceIdentity,second.sourceIdentity);assert.equal(reader.metadataReads,2);safe(second.sourceIdentity);
});

test('actual gid metadata overrides stale configured names and stays fixed while paging quoted ranges',async()=>{
 const reader=await apiReader({sheets:[{properties:{sheetId:0,title:"Owner's ! Sites",index:1,gridProperties:{rowCount:2010,columnCount:6}}}],onValues:()=>({values:[]})}),result=await reader.source.readCandidates({spreadsheetUrl:'https://docs.google.com/spreadsheets/d/identity-sheet/edit#gid=0',range:'OldName!C6:F',columns:{url:'C',username:'D',password:'E',enabled:'F'},headerRows:2,authMode:'user'});
 assert.deepEqual(result.sourceIdentity,{spreadsheetId:'identity-sheet',resolvedSheetId:0,sheetName:"Owner's ! Sites",range:"'Owner''s ! Sites'!C6:F",columns:{url:'C',username:'D',password:'E',enabled:'F'},headerRows:2,authMode:'user'});assert.deepEqual(reader.ranges,["'Owner''s ! Sites'!C6:F2005","'Owner''s ! Sites'!C2006:F2010"]);safe(result.sourceIdentity);
});

test('injected browser reader retains gid zero without inventing an unknown sheet title',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),source=createSiteSource({readSheet:async()=>({values:[[],['https://browser.example/',username,password]],accessToken:token,privateKey})}),result=await source.readCandidates({spreadsheetUrl:'https://docs.google.com/spreadsheets/d/identity-sheet/edit#gid=0',columns,authMode:'browser'});
 assert.deepEqual(result.sourceIdentity,{spreadsheetId:'identity-sheet',resolvedSheetId:0,sheetName:null,range:'A1:C',columns,headerRows:1,authMode:'browser'});assert.equal(result.candidates[0].password,password);safe(result.sourceIdentity);
});

test('injected named ranges provide a private service identity and unqualified unknown sheets leave identity null',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs'),source=createSiteSource({readSheet:async()=>({values:[[],['https://fixture.example/',username,password]]})}),named=await source.readCandidates({...config,authMode:undefined,range:"'Sites'!a1:c10",serviceAccount:{clientEmail:'reader@identity.example',privateKey}}),unknown=await source.readCandidates({...config,range:'A1:C10'});
 assert.deepEqual(named.sourceIdentity,{spreadsheetId:'identity-sheet',resolvedSheetId:null,sheetName:'Sites',range:'Sites!A1:C10',columns,headerRows:1,authMode:'service'});assert.equal(unknown.sourceIdentity,null);safe(named.sourceIdentity);
});

test('a failed later page exposes no partial candidate or descriptor and cannot reuse an earlier read identity',async()=>{
 let mode='success';const reader=await apiReader({sheets:()=>[{properties:{sheetId:mode==='new'?38:37,title:'Sites',index:0,gridProperties:{rowCount:3000,columnCount:3}}}],onValues:(range)=>{if(mode==='fail'&&range.includes('A2001:'))throw Error(token+' '+password);return {values:range.includes('A1:')?[[],['https://partial.example/',username,password]]:[]};}});
 assert.equal((await reader.source.readCandidates(config)).sourceIdentity.resolvedSheetId,37);mode='fail';await assert.rejects(reader.source.readCandidates(config),error=>{assert.equal(error.code,'source_read_failed');assert.equal(error.sourceIdentity,undefined);assert.equal(error.candidates,undefined);assert.ok(!error.message.includes(token));assert.ok(!error.message.includes(password));return true;});mode='new';assert.equal((await reader.source.readCandidates(config)).sourceIdentity.resolvedSheetId,38);
});
