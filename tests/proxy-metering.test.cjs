const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');

test('proxy metering records redirect hops, aborted bodies and explicit retries once each',async()=>{
 const {createSafeTransport}=await import('../server/lifecycle/network.mjs');
 const controller=new AbortController(),usage=[];
 const transport=createSafeTransport({
  measureProxy:true,
  lookup:async()=>[{address:'93.184.216.34',family:4}],
  request:(url,options,receive)=>{
   const req=new EventEmitter();
   req.destroy=()=>{};
   req.end=()=>queueMicrotask(()=>{
    options.onProxyConnect();
    req.emit('finish');
    const res=new EventEmitter();
    res.statusCode=url.pathname==='/redirect'?302:200;
    res.headers=res.statusCode===302?{location:'/asset'}:{};
    res.destroy=()=>res.emit('close');
    receive(res);
    res.emit('data',Buffer.from(res.statusCode===302?'next':'asset'));
    if(url.pathname==='/interrupted'){controller.abort();res.emit('data',Buffer.from('late'));}
    res.emit('end');
   });
   return req;
  }
 });
 const onProxyUsage=event=>usage.push(event);
 await transport('https://wp.example/redirect',{onProxyUsage});
 await assert.rejects(transport('https://wp.example/interrupted',{signal:controller.signal,onProxyUsage}),{code:'network_timeout'});
 await transport('https://wp.example/asset',{onProxyUsage});
 assert.deepEqual(usage.map(({eventId,...event})=>event),[4,5,5,5].map(bytesReceived=>({bytesSent:0,bytesReceived,requests:1,connections:1})));
 assert.equal(new Set(usage.map(event=>event.eventId)).size,4);
});
