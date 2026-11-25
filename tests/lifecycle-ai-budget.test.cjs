'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
async function fixture(t,options={}){
 const {createAIBudget}=await import('../server/lifecycle/ai-budget.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-ai-budget-')),filename=path.join(dir,'ai.sqlite'),stores=[];
 let time=Date.parse('2026-10-15T12:00:00Z');
 const open=(extra={})=>{const ledger=createAIBudget({filename,clock:()=>time,...options,...extra});stores.push(ledger);return ledger;};
 t.after(()=>{stores.forEach(s=>s.close());fs.rmSync(dir,{recursive:true,force:true});});
 return{ledger:open(),open,filename,advance:ms=>time+=ms,setTime:iso=>time=Date.parse(iso)};
}
const request=(extra={})=>({model:'gpt-5.4-mini',store:false,instructions:'Write safe text.',input:'A short user brief.',max_output_tokens:12000,...extra});
const result={requestId:'r1',updates:[{targetId:'t1',value:'Verified response'}],notes:[]};
test('reserves worst-case UTF-8 input and full output budget before dispatch without storing prompt or keys',async t=>{
 const{ledger,filename}=await fixture(t),body=request({input:'Привіт 🌍 private brief 19818'}),receipt=ledger.reserve({requestId:'r1',request:body});
 assert.equal(receipt.dispatch,true);assert.equal(receipt.state,'reserved');assert.ok(receipt.reservationToken);
 assert.ok(receipt.reservedTokens>=Buffer.byteLength(JSON.stringify(body),'utf8')+12000);
 assert.ok(receipt.reservedUSD>0.054);assert.ok(receipt.reservedUSD<0.1);
 assert.equal(ledger.status().reservedTokens,receipt.reservedTokens);assert.equal(ledger.status().spentTokens,0);
 const raw=new DatabaseSync(filename),rows=raw.prepare('SELECT * FROM ai_requests').all();raw.close();
 assert.doesNotMatch(JSON.stringify(rows),/private brief|Write safe text|Authorization|OPENAI_API_KEY/);
});
test('two connections cannot reserve the same request twice and changed payload cannot reuse its ID',async t=>{
 const{ledger,open}=await fixture(t),receipt=ledger.reserve({requestId:'r1',request:request()}),other=open();
 const duplicate=other.reserve({requestId:'r1',request:request()});
 assert.equal(duplicate.dispatch,false);assert.equal(duplicate.reservationToken,undefined);assert.equal(other.status().reservedUSD,receipt.reservedUSD);
 assert.throws(()=>other.reserve({requestId:'r1',request:request({input:'Different'})}),{code:'REQUEST_CONFLICT'});
 assert.equal(ledger.status().counts.reserved,1);
});
test('completed validated result and actual usage replay after restart without a new charge',async t=>{
 const{ledger,open}=await fixture(t),receipt=ledger.reserve({requestId:'r1',request:request()});
 const completed=ledger.complete('r1',receipt.reservationToken,{result,usage:{input_tokens:100,output_tokens:200}});
 assert.equal(completed.state,'completed');assert.deepEqual(completed.result,result);
 assert.equal(ledger.status().spentUSD,0.000975);assert.equal(ledger.status().spentTokens,300);assert.equal(ledger.status().reservedUSD,0);
 const replay=open().reserve({requestId:'r1',request:request()});
 assert.equal(replay.dispatch,false);assert.equal(replay.replay,true);assert.deepEqual(replay.result,result);
 assert.equal(ledger.status().spentUSD,0.000975);
 assert.deepEqual(ledger.complete('r1',receipt.reservationToken,{result,usage:{input_tokens:100,output_tokens:200}}),completed);
});
test('unknown outcome holds its full reservation through restart and cannot dispatch again',async t=>{
 const{ledger,open}=await fixture(t),receipt=ledger.reserve({requestId:'r1',request:request()});
 ledger.uncertain('r1',receipt.reservationToken,{code:'NETWORK_ERROR'});
 const other=open(),retry=other.reserve({requestId:'r1',request:request()});
 assert.equal(retry.state,'uncertain');assert.equal(retry.dispatch,false);assert.equal(retry.replay,false);
 assert.equal(other.status().reservedUSD,receipt.reservedUSD);assert.equal(other.status().counts.uncertain,1);
 assert.throws(()=>ledger.complete('r1','old-token',{result,usage:{input_tokens:1,output_tokens:1}}),{code:'RESERVATION_CONFLICT'});
 assert.equal(ledger.complete('r1',receipt.reservationToken,{result,usage:{input_tokens:100,output_tokens:200}}).state,'completed');
});
test('a crash with a reserved request never silently releases or retries the request',async t=>{
 const{ledger,open}=await fixture(t),receipt=ledger.reserve({requestId:'r1',request:request()});ledger.close();
 const other=open(),retry=other.reserve({requestId:'r1',request:request()});
 assert.equal(retry.dispatch,false);assert.equal(other.status().reservedUSD,receipt.reservedUSD);
});
test('monthly money cap includes held reservations across connections and releases only proved rejection',async t=>{
 const{ledger,open}=await fixture(t,{monthlyUSD:0.07}),receipt=ledger.reserve({requestId:'r1',request:request()}),other=open();
 assert.throws(()=>other.reserve({requestId:'r2',request:request()}),{code:'AI_BUDGET_EXCEEDED'});
 assert.equal(other.status().counts.reserved,1);
 ledger.reject('r1',receipt.reservationToken,{code:'HTTP_401'});
 assert.equal(other.status().reservedUSD,0);assert.equal(other.status().spentUSD,0);
 assert.equal(other.reserve({requestId:'r1',request:request()}).dispatch,false);
 assert.equal(other.reserve({requestId:'r2',request:request()}).dispatch,true);
});
test('monthly token cap is independent of dollars and remains reserved for unknown requests',async t=>{
 const{ledger}=await fixture(t,{monthlyUSD:100,monthlyTokens:5000}),body=request({max_output_tokens:100}),receipt=ledger.reserve({requestId:'r1',request:body});
 ledger.uncertain('r1',receipt.reservationToken,{code:'TIMEOUT'});
 assert.throws(()=>ledger.reserve({requestId:'r2',request:body}),{code:'AI_BUDGET_EXCEEDED'});
 assert.ok(ledger.status().remainingTokens<1000);
});
test('UTC month rollover allows a fresh budget but old request identities never dispatch again',async t=>{
 const{ledger,setTime}=await fixture(t,{monthlyUSD:0.07}),receipt=ledger.reserve({requestId:'r1',request:request()});
 ledger.uncertain('r1',receipt.reservationToken,{code:'TIMEOUT'});setTime('2026-11-01T00:00:00Z');
 assert.equal(ledger.status().month,'2026-11');assert.equal(ledger.status().reservedUSD,0);
 assert.equal(ledger.reserve({requestId:'r1',request:request()}).dispatch,false);
 assert.equal(ledger.reserve({requestId:'r2',request:request()}).dispatch,true);
 ledger.complete('r1',receipt.reservationToken,{result,usage:{input_tokens:100,output_tokens:200}});
 assert.equal(ledger.status().spentUSD,0); // Actual use stays in the reservation month.
});
test('unknown model cannot dispatch until its rates are explicitly configured',async t=>{
 const{ledger,open}=await fixture(t);
 assert.throws(()=>ledger.reserve({requestId:'unknown',request:request({model:'future-model'})}),{code:'AI_RATE_UNKNOWN'});
 const configured=open({rates:{'future-model':{inputUSDPerMillion:1,outputUSDPerMillion:2}}});
 const receipt=configured.reserve({requestId:'future',request:request({model:'future-model'})});
 configured.complete('future',receipt.reservationToken,{result:{updates:[],notes:[]},usage:{input_tokens:100,output_tokens:200}});
 assert.equal(configured.status().spentUSD,0.0005);
});
test('malformed usage cannot release a held reservation or persist a supposedly completed result',async t=>{
 const{ledger}=await fixture(t),receipt=ledger.reserve({requestId:'r1',request:request()});
 for(const usage of [undefined,{}, {input_tokens:-1,output_tokens:2},{input_tokens:1.5,output_tokens:2},{input_tokens:1,output_tokens:'2'}]){
  assert.throws(()=>ledger.complete('r1',receipt.reservationToken,{result,usage}),{code:'VALIDATION'});
  assert.equal(ledger.status().reservedUSD,receipt.reservedUSD);
 }
 assert.throws(()=>ledger.reject('r1',receipt.reservationToken,{code:'NETWORK_ERROR'}),{code:'VALIDATION'});
 assert.equal(ledger.status().counts.reserved,1);
});
test('known billed invalid response settles measured use without saving unsafe response data',async t=>{
 const{ledger,filename}=await fixture(t),receipt=ledger.reserve({requestId:'r1',request:request()});
 const rejected=ledger.reject('r1',receipt.reservationToken,{code:'RESPONSE_INVALID',usage:{input_tokens:100,output_tokens:200}});
 assert.equal(rejected.state,'rejected');assert.equal(ledger.status().spentUSD,0.000975);assert.equal(ledger.status().reservedUSD,0);
 const raw=new DatabaseSync(filename),row=raw.prepare('SELECT * FROM ai_requests').get();raw.close();
 assert.equal(row.result_json,null);assert.equal(row.error_code,'RESPONSE_INVALID');
});
test('invalid configuration/request/result cannot create an unbounded or secret-bearing ledger entry',async t=>{
 const{ledger,open}=await fixture(t);
 for(const extra of [{monthlyUSD:0},{monthlyUSD:NaN},{monthlyTokens:0},{rates:{x:{inputUSDPerMillion:-1,outputUSDPerMillion:2}}}])assert.throws(()=>open(extra),{code:'VALIDATION'});
 for(const body of [request({max_output_tokens:12001}),request({max_output_tokens:0}),request({tools:[{type:'web_search'}]}),request({input:[{type:'input_image'}]}),request({Authorization:'Bearer secret'})]){
  assert.throws(()=>ledger.reserve({requestId:'invalid',request:body}),{code:'VALIDATION'});
 }
 assert.equal(ledger.status().counts.reserved,0);
 const receipt=ledger.reserve({requestId:'r1',request:request()});
 assert.throws(()=>ledger.complete('r1',receipt.reservationToken,{result:{apiKey:'must-not-store'},usage:{input_tokens:1,output_tokens:1}}),{code:'VALIDATION'});
 assert.equal(ledger.status().reservedUSD,receipt.reservedUSD);
});
test('actual provider use above the estimate is recorded fully and blocks further overspending',async t=>{
 const{ledger}=await fixture(t,{monthlyUSD:0.07}),receipt=ledger.reserve({requestId:'r1',request:request()});
 ledger.complete('r1',receipt.reservationToken,{result,usage:{input_tokens:100000,output_tokens:200}});
 assert.equal(ledger.status().spentUSD,0.0759);assert.equal(ledger.status().remainingUSD,0);
 assert.equal(ledger.status().overBudget,true);
 assert.throws(()=>ledger.reserve({requestId:'r2',request:request()}),{code:'AI_BUDGET_EXCEEDED'});
});

test('explicit safe rejection retry retains identity, rotates fencing token, and is bounded',async t=>{
 const {ledger,open}=await fixture(t);let receipt=ledger.reserve({requestId:'retry-one',request:request()});
 for(let attempt=0;attempt<3;attempt++){
  ledger.reject('retry-one',receipt.reservationToken,{code:'HTTP_429'});
  assert.equal(ledger.reserve({requestId:'retry-one',request:request()}).dispatch,false);
  const current=ledger.getRequest('retry-one');assert.equal(current.retryable,attempt<2);
  if(attempt===2){assert.throws(()=>ledger.authorizeRetry('retry-one'),{code:'AI_RETRY_FORBIDDEN'});break;}
  ledger.authorizeRetry('retry-one');const prior=receipt.reservationToken;receipt=open().reserve({requestId:'retry-one',request:request()});assert.equal(receipt.dispatch,true);assert.notEqual(receipt.reservationToken,prior);assert.equal(receipt.requestId,'retry-one');assert.throws(()=>ledger.complete('retry-one',prior,{result,usage:{input_tokens:1,output_tokens:1}}),{code:'RESERVATION_CONFLICT'});
 }
 assert.equal(ledger.status().spentUSD,0);assert.equal(ledger.status().counts.rejected,1);
});
test('paid invalid output and uncertain requests cannot be authorized for a paid retry',async t=>{
 const {ledger}=await fixture(t);const paid=ledger.reserve({requestId:'paid',request:request()});ledger.reject('paid',paid.reservationToken,{code:'INVALID_MODEL_RESPONSE',usage:{input_tokens:10,output_tokens:30}});assert.equal(ledger.getRequest('paid').retryable,false);assert.throws(()=>ledger.authorizeRetry('paid'),{code:'AI_RETRY_FORBIDDEN'});
 const unknown=ledger.reserve({requestId:'unknown',request:request()});ledger.uncertain('unknown',unknown.reservationToken,{code:'NETWORK_ERROR'});assert.equal(ledger.getRequest('unknown').retryable,false);assert.throws(()=>ledger.authorizeRetry('unknown'),{code:'AI_RETRY_FORBIDDEN'});
});
