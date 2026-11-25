'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('offline catalogue assignment never uses two aliases of one registrable domain',async()=>{
 const {allocateDonors}=await import('../server/lifecycle/donor-allocation.mjs');
 const rows=['https://a.example.co.uk/','http://www.example.co.uk/','https://other.example/'].map((baseUrl,index)=>({id:'row-'+index,baseUrl,username:'fixture',password:'fixture-only',metrics:{dr:50,traffic:100,geo:['GB']}}));
 const requests=[0,1,2].map(id=>({id:'page-'+id,criteria:{geo:'GB'}}));
 const result=allocateDonors(requests,rows);assert.equal(result.assignments.length,2);
 assert.equal(allocateDonors(requests.slice(0,1),rows,{usedOrigins:['https://already.example.co.uk/']}).assignments[0].candidate.baseUrl,'https://other.example/');
 // Destination allow-lists remain exact; sharing a root never grants another origin.
 assert.equal(allocateDonors([{id:'exact',criteria:{},allowedOrigins:['https://not-listed.example.co.uk']}],rows).assignments.length,0);
});
test('separate managed hosting tenants remain separate offline catalogue entries',async()=>{
 const {donorDomainKey}=await import('../server/lifecycle/donor-domain.mjs');
 assert.equal(donorDomainKey('https://a.example.com/'),donorDomainKey('https://www.example.com/'));
 assert.notEqual(donorDomainKey('https://first.wordpress.com/'),donorDomainKey('https://second.wordpress.com/'));
 assert.notEqual(donorDomainKey('https://first.github.io/'),donorDomainKey('https://second.github.io/'));
});

test('a reserved root is excluded consistently from catalogue reading and availability counts',async()=>{
 const {createSiteSource}=await import('../server/lifecycle/site-source.mjs');
 const source=createSiteSource({readSheet:async()=>({values:[['https://sub.example.co.uk/','fixture','fixture-only',50,100,'UK'],['https://other.example/','fixture','fixture-only',50,100,'GB']]})});
 const config={spreadsheetId:'demo',range:'A:F',headerRows:0,columns:{url:'A',username:'B',password:'C',dr:'D',traffic:'E',geo:'F'}};
 const output=await source.readCandidates(config,{criteria:{geo:'GB'},usedOrigins:['https://www.example.co.uk/'],preserveOrigins:true});
 assert.equal(output.candidates.length,1);assert.equal(output.candidates[0].baseUrl,'https://other.example/');assert.equal(output.diagnostics.available,1);
});
