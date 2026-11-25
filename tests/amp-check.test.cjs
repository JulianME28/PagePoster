'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('AMP read verification requires the real head, valid matching content, and only anonymous GETs',async()=>{
 const {buildAmpPayload,renderAmpDocument}=await import('../server/lifecycle/amp-mode.mjs'),{checkAmpPair}=await import('../server/lifecycle/amp-check.mjs');
 const url='https://fixture.example/page/',alternate=url+'?pageposter_amp=1',html='<h1>Original</h1><p>Exact source.</p>',payload=buildAmpPayload({html,title:'Original'}),amp=renderAmpDocument(payload,url),head='<link rel="canonical" href="'+url+'"><link rel="amphtml" href="'+alternate+'">';
 const calls=[];
 const transport=async(target,options)=>{calls.push(target);assert.equal(options.method,'GET');assert.equal(options.headers.authorization,undefined);assert.equal(options.headers.cookie,undefined);return {status:200,text:target===url?'<!doctype html><head>'+head+'</head><body>'+html:amp};};
 assert.deepEqual(await checkAmpPair({url,html,title:'Original',transport}),{state:'ready',url:alternate});assert.deepEqual(calls,[url,alternate]);
 const misplaced=async()=>({status:200,text:'<!doctype html><head></head><body>'+head+html});
 assert.equal((await checkAmpPair({url,html,title:'Original',transport:misplaced})).code,'AMP_HEAD_MISMATCH');
 const changed=async target=>({status:200,text:target===url?'<!doctype html><head>'+head+'</head><body>'+html:amp.replace('Exact source.','Changed source.')});
 assert.equal((await checkAmpPair({url,html,title:'Original',transport:changed})).code,'AMP_CONTENT_MISMATCH');
 const failed=async()=>{throw Error('Private network details');};
 assert.equal((await checkAmpPair({url,html,title:'Original',transport:failed})).state,'unknown');
});

test('AMP verification validates the original response and detects duplicate relation tokens',async()=>{
 const {buildAmpPayload,renderAmpDocument}=await import('../server/lifecycle/amp-mode.mjs'),{checkAmpPair}=await import('../server/lifecycle/amp-check.mjs');
 const url='https://fixture.example/page/',alternate=url+'?pageposter_amp=1',html='<h1>Original</h1>',title='Original';
 const amp=renderAmpDocument(buildAmpPayload({html,title}),url),head='<link rel="canonical" href="'+url+'"><link rel="amphtml" href="'+alternate+'">';
 const verify=(main,remoteAmp)=>checkAmpPair({url,html,title,transport:async target=>({status:200,text:target===url?'<!doctype html><head>'+main+'</head>':remoteAmp})});
 const invalid=amp.replace('<body>','');
 assert.equal((await verify(head,invalid)).state,'unknown');
 assert.equal((await verify(head+'<link rel="alternate CANONICAL" href="'+url+'">',amp)).code,'AMP_HEAD_MISMATCH');
 assert.equal((await verify(head,amp.replace('<title>Original</title>','<title>Different</title>'))).code,'AMP_CONTENT_MISMATCH');
});

test('AMP verification accepts equivalent encodings in WordPress query permalinks',async()=>{
 const {buildAmpPayload,renderAmpDocument}=await import('../server/lifecycle/amp-mode.mjs'),{checkAmpPair}=await import('../server/lifecycle/amp-check.mjs');
 const url='https://fixture.example/?page_id=42&label=two%20words',alternate=url+'&pageposter_amp=1',html='<h1>Original</h1>',title='Original';
 const amp=renderAmpDocument(buildAmpPayload({html,title}),url);
 const result=await checkAmpPair({url,html,title,transport:async target=>({
  status:200,text:new URL(target).searchParams.has('pageposter_amp')?amp:
   '<!doctype html><head><link rel="Canonical" href="'+url.replaceAll('&','&amp;')+'"><link rel="amphtml" href="'+alternate.replaceAll('&','&amp;')+'"></head>'
 })});
 assert.equal(result.state,'ready');
});
