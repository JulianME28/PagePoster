const test=require('node:test');
const assert=require('node:assert/strict');
const spreadsheetId='1Private-Sheet_Example';
const spreadsheetUrl='https://docs.google.com/spreadsheets/d/1Private-Sheet_Example/edit?gid=178594066#gid=178594066';
const columns={url:'B',dr:'D',traffic:'E',geo:'F',username:'K',password:'L',alternateUsername:'N',alternatePassword:'O'};

test('full Sheet links retain the exact tab and canonicalize matching query/hash gids',async()=>{
 const {parseSheetReference}=await import('../server/lifecycle/sheet-reference.mjs');
 assert.deepEqual(parseSheetReference(spreadsheetUrl),{spreadsheetId,spreadsheetUrl:'https://docs.google.com/spreadsheets/d/1Private-Sheet_Example/edit#gid=178594066',sheetId:178594066});
 assert.equal(parseSheetReference('https://docs.google.com/spreadsheets/d/abc/edit?gid=0').sheetId,0);
 assert.equal(parseSheetReference('https://docs.google.com/spreadsheets/d/abc/edit#gid=7&range=B2:O20').sheetId,7);
 assert.deepEqual(parseSheetReference('https://docs.google.com/spreadsheets/d/abc/edit?usp=sharing&authuser=1#gid=0'),{spreadsheetId:'abc',spreadsheetUrl:'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',sheetId:0});
 assert.equal(parseSheetReference('https://docs.google.com/spreadsheets/d/abc/edit?authuser=0&usp=drive_link&gid=7').sheetId,7);
 assert.deepEqual(parseSheetReference('legacy-ID'),{spreadsheetId:'legacy-ID',spreadsheetUrl:'https://docs.google.com/spreadsheets/d/legacy-ID/edit',sheetId:null});
});

test('Sheet references reject ambiguous gids and foreign or noncanonical authority/path input',async()=>{
 const {parseSheetReference}=await import('../server/lifecycle/sheet-reference.mjs');
 for(const input of [
  'https://docs.google.com/spreadsheets/d/abc/edit?gid=1#gid=2',
  'https://docs.google.com/spreadsheets/d/abc/edit?gid=1&gid=1',
  'https://docs.google.com/spreadsheets/d/abc/edit#gid=1&gid=1',
  ...['-1','1.5','abc','2147483648','9007199254740992',''].map(gid=>'https://docs.google.com/spreadsheets/d/abc/edit#gid='+gid),
  'http://docs.google.com/spreadsheets/d/abc/edit#gid=0',
  'https://docs.google.com.evil.example/spreadsheets/d/abc/edit#gid=0',
  'https://user@docs.google.com/spreadsheets/d/abc/edit#gid=0',
  'https://docs.google.com:443/spreadsheets/d/abc/edit#gid=0',
  'https://docs.google.com/spreadsheets/d/abc/../def/edit#gid=0',
  ...['-1','100','abc','1.5'].map(authuser=>'https://docs.google.com/spreadsheets/d/abc/edit?authuser='+authuser+'#gid=0'),
  'https://docs.google.com/spreadsheets/d/abc/edit?authuser=0&authuser=1#gid=0',
  'https://docs.google.com/spreadsheets/d/abc/edit?usp=unknown#gid=0',
  'https://docs.google.com/spreadsheets/d/abc/edit?usp=sharing&usp=sharing#gid=0',
  'https://docs.google.com/spreadsheets/d/abc/edit#gid=0&authuser=0',
  'https://docs.google.com/spreadsheets/d/abc/edit#unexpected=0',
 ])assert.throws(()=>parseSheetReference(input),{code:'source_validation'},input);
});

test('full URL source configs derive a bounded column range and preserve legacy output',async()=>{
 const {validateSiteSourceConfig}=await import('../server/lifecycle/site-source.mjs');
 const options={allowMissingAccount:true};
 assert.deepEqual(validateSiteSourceConfig({spreadsheetUrl,columns,authMode:'browser'},options),{spreadsheetId,spreadsheetUrl:'https://docs.google.com/spreadsheets/d/1Private-Sheet_Example/edit#gid=178594066',sheetId:178594066,range:'B:O',columns,headerRows:1,authMode:'browser'});
 const legacy={spreadsheetId:'legacy',range:'Sites!B:O',columns,headerRows:1};
 assert.deepEqual(validateSiteSourceConfig(legacy,options),legacy);
 assert.equal(validateSiteSourceConfig({spreadsheetUrl,spreadsheetId,range:'LegacyName!B2:O50',columns,sheetId:178594066},options).range,'LegacyName!B2:O50');
 for(const bad of [{spreadsheetUrl,spreadsheetId:'other',columns},{spreadsheetUrl,sheetId:0,columns},{spreadsheetUrl:'https://docs.google.com/spreadsheets/d/abc/edit',columns},{spreadsheetId,sheetId:-1,range:'B:O',columns},{spreadsheetUrl:'https://docs.google.com/spreadsheets/d/abc/edit',range:'Sites!B:O',columns,authMode:'browser'}])assert.throws(()=>validateSiteSourceConfig(bad,options),{code:'source_validation'});
});

async function reader({sheetId=178594066,title="Owner's ! Renamed",rows=3,selected=true,range,firstRow=1}={}){
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');const calls=[];
 const source=createSiteSource({getAccessToken:async()=> 'fixture-token',transport:async(url,options)=>{
  calls.push(url);assert.equal(options.headers.authorization,'Bearer fixture-token');
  if(!new URL(url).pathname.includes('/values/'))return {status:200,url,text:JSON.stringify({sheets:[{properties:{sheetId:99,title:'Wrong first tab',index:0,gridProperties:{rowCount:3,columnCount:15}}},...(selected?[{properties:{sheetId,title,index:1,gridProperties:{rowCount:rows,columnCount:15}}}]:[])]})};
  const requested=decodeURIComponent(new URL(url).pathname.split('/values/')[1]);
  assert.equal(requested,range||"'Owner''s ! Renamed'!B1:O3");
  const row=Array(14).fill('');row[0]='selected.example';row[2]=75;row[3]=1000;row[4]='US';row[9]='user';row[10]=' exact password ';
  return {status:200,url,text:JSON.stringify({values:firstRow===1?[[],row]:[row]})};
 }});
 return {source,calls,config:{spreadsheetUrl:'https://docs.google.com/spreadsheets/d/abc/edit#gid='+sheetId,columns,authMode:'user'}};
}

test('authorized reads resolve gid by numeric identity and quote the current tab title',async()=>{
 const {source,calls,config}=await reader();const selected=await source.pickUnused(config,{criteria:{minDr:70,geo:'US'}});
 assert.equal(selected.baseUrl,'https://selected.example/');assert.equal(selected.rowNumber,2);assert.equal(selected.password,' exact password ');assert.equal(calls.length,2);
});

test('gid zero still fetches metadata and overrides a stale named range while keeping bounds',async()=>{
 const {source,calls,config}=await reader({sheetId:0,range:"'Owner''s ! Renamed'!B6:O8",rows:10,firstRow:6});
 const selected=await source.pickUnused({...config,range:'OldName!B6:O8',headerRows:0});assert.equal(selected.rowNumber,6);assert.equal(calls.length,2);
});

test('missing selected gid fails closed before values and oversize tab scans retain the cap',async()=>{
 const missing=await reader({selected:false});await assert.rejects(missing.source.pickUnused(missing.config),{code:'source_sheet_not_found'});assert.equal(missing.calls.length,1);
 const oversized=await reader({rows:100001});await assert.rejects(oversized.source.pickUnused(oversized.config),{code:'source_limit_exceeded'});assert.equal(oversized.calls.length,1);
});

test('browser fixture errors retain safe actionable authentication, access, and scan-limit codes',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 for(const [code,expected] of [['GOOGLE_BROWSER_AUTH_REQUIRED','source_auth_failed'],['GOOGLE_BROWSER_ACCESS_DENIED','source_access_denied'],['GOOGLE_BROWSER_LIMIT','source_limit_exceeded']]){
  const source=createSiteSource({readSheet:async()=>{throw Object.assign(Error('private token and password'),{code});}});
  await assert.rejects(source.readCandidates({spreadsheetUrl,columns,authMode:'browser'}),error=>error.code===expected&&!/token|password/.test(error.message));
 }
});
