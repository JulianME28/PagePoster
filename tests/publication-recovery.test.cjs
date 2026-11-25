const test=require('node:test'),assert=require('node:assert/strict');
test('publication truth retains published identity through failed verification and bounds safe diagnostics',async()=>{
 const {publicPublication,safePublicationDiagnostics}=await import('../server/lifecycle/publication-diagnostics.mjs');
 const run={revision:9,publicationMode:'native',state:'needs_attention',stage:'checking',nativePublication:{postId:42,phase:'published',url:'https://fixture.example/page/'},error:{code:'CHECK_FAILED'},publicationDiagnostics:[{phase:'reconcile',code:'network_timeout',httpStatus:503,method:'GET',startedAt:1,endedAt:7,elapsedMs:6,budgetMs:100,safeReadRetries:2,url:'https://secret?nonce=secret',message:'password-secret',html:'<secret>'}]};
 const result=publicPublication(run,{wpId:42,fullUrl:run.nativePublication.url,verification:{state:'unknown'}});
 assert.equal(result.state,'verification_unknown');assert.equal(result.postId,42);assert.equal(result.revision,9);assert.equal(result.url,run.nativePublication.url);assert.equal(result.diagnostics[0].httpStatus,503);
 assert.doesNotMatch(JSON.stringify(safePublicationDiagnostics(run.publicationDiagnostics)),/secret|url|message|html/);
 assert.equal(publicPublication({...run,nativePublication:{postId:null,phase:'creating'},stage:'publishing',state:'uncertain'},{}).state,'verification_unknown');
 assert.equal(publicPublication({revision:1,stage:'generating'},{}),null);
});
test('safe read recovery is bounded, resumes its durable attempt count and never retries content or manual failures',async()=>{
 const {recoverSafeRead}=await import('../server/lifecycle/publication-recovery.mjs');let calls=0;const records=[];
 const result=await recoverSafeRead(async()=>{calls++;if(calls===1)throw Object.assign(Error('secret'),{code:'network_timeout'});return 'published';},{previous:{attempt:1},scope:'fixture',clock:()=>1000,wait:async()=>{},persist:async value=>records.push(value)});
 assert.equal(result,'published');assert.equal(calls,2);assert.equal(records.at(-1).state,'confirmed');assert.equal(records.at(-1).attempt,3);
 for(const code of ['NATIVE_CONTENT_CHANGED','BROWSER_CAPTCHA_REQUIRED','BROWSER_ORIGIN_BLOCKED']){calls=0;await assert.rejects(recoverSafeRead(async()=>{calls++;throw Object.assign(Error('secret'),{code});},{scope:'fixture',wait:async()=>{},persist:async()=>{}}),{code});assert.equal(calls,1);}
 calls=0;await assert.rejects(recoverSafeRead(async()=>{calls++;throw Object.assign(Error(),{code:'network_timeout'});},{scope:'fixture',previous:{attempt:3},wait:async()=>{},persist:async()=>{}}));assert.equal(calls,0);
});
test('manual CAPTCHA on the final safe read can finish that read after the user continues',async()=>{
 const {recoverSafeRead}=await import('../server/lifecycle/publication-recovery.mjs');
 let saved,calls=0;
 const options={scope:'fixture',wait:async()=>{},persist:async value=>{saved=value;}};
 await assert.rejects(recoverSafeRead(async()=>{calls++;throw Object.assign(Error(),{code:'BROWSER_CAPTCHA_REQUIRED'});},{...options,previous:{scope:'fixture',attempt:2}}),{code:'BROWSER_CAPTCHA_REQUIRED'});
 assert.equal(calls,1);assert.equal(saved.state,'manual_action');assert.equal(saved.attempt,3);
 assert.equal(await recoverSafeRead(async()=>{calls++;return 'published';},{...options,previous:saved}),'published');
 assert.equal(calls,2);assert.equal(saved.state,'confirmed');assert.equal(saved.attempt,3);
});
