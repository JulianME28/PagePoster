const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),https=require('node:https'),net=require('node:net'),tls=require('node:tls'),fs=require('node:fs'),path=require('node:path');
const cert=fs.readFileSync(path.join(__dirname,'fixtures/proxy-tls/test-only.crt')),key=fs.readFileSync(path.join(__dirname,'fixtures/proxy-tls/test-only.key'));
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
async function target(t){const calls=[],sockets=new Set();const server=https.createServer({cert,key},(req,res)=>{calls.push({method:req.method,headers:req.headers,url:req.url});res.setHeader('Content-Type','text/plain');res.end('target-ok');});server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});});const port=await listen(server);t.after(async()=>{sockets.forEach(s=>s.destroy());await new Promise(r=>server.close(r));});return {port,calls};}
const options={lookup:async()=>[{address:'93.184.216.34',family:4}],tlsConnect:opts=>{assert.equal(opts.rejectUnauthorized,true);assert.equal(opts.servername,'wp.example');return tls.connect({...opts,ca:cert});},timeoutMs:1000};

for(const scheme of ['http','https'])test(scheme+' CONNECT tunnels use the pinned target and keep proxy credentials away from WordPress',async t=>{
 const {port,calls}=await target(t),connections=[],sockets=new Set();const proxy=(scheme==='https'?https:http).createServer(scheme==='https'?{key,cert}:{});
 proxy.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.on('close',()=>sockets.delete(s));});
 proxy.on('connect',(req,socket,head)=>{connections.push({target:req.url,auth:req.headers['proxy-authorization']});const upstream=net.connect(port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});sockets.add(upstream);upstream.on('error',()=>socket.destroy());});
 const proxyPort=await listen(proxy);t.after(async()=>{sockets.forEach(s=>s.destroy());await new Promise(r=>proxy.close(r));});
 const {createProxyTransport}=await import('../server/lifecycle/proxy-transport.mjs');
 const adapter=createProxyTransport({scheme,server:scheme+'://127.0.0.1:'+proxyPort,username:'alice',password:'secret'}, {...options,...(scheme==='https'?{proxyCa:cert}:{})});t.after(()=>adapter.close());
 const usage=[];
 const result=await adapter.transport('https://wp.example:'+port+'/page',{method:'POST',headers:{'content-type':'text/plain'},body:'hello',onProxyUsage:event=>usage.push(event)});
 assert.equal(result.text,'target-ok');assert.equal(connections.length,1);assert.equal(connections[0].target,'93.184.216.34:'+port);assert.equal(connections[0].auth,'Basic '+Buffer.from('alice:secret').toString('base64'));
 assert.equal(calls.length,1);assert.equal(calls[0].headers.host,'wp.example:'+port);assert.equal(calls[0].headers['proxy-authorization'],undefined);
 assert.equal(usage.length,1);
 const {eventId,...counts}=usage[0];
 assert.match(eventId,/^[0-9a-f-]{36}$/);
 assert.deepEqual(counts,{bytesSent:5,bytesReceived:9,requests:1,connections:1});
});

test('SOCKS5 authenticates then connects to the pinned address, with destination TLS intact',async t=>{
 const {port,calls}=await target(t),sockets=new Set(),observed=[];
 const proxy=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});let bytes=Buffer.alloc(0),stage=0;
  function consume(chunk){bytes=Buffer.concat([bytes,chunk]);
   while(true){
    if(stage===0){if(bytes.length<2||bytes.length<2+bytes[1])return;assert.equal(bytes[0],5);bytes=bytes.subarray(2+bytes[1]);socket.write(Buffer.from([5,2]));stage=1;}
    else if(stage===1){if(bytes.length<2||bytes.length<3+bytes[1])return;const userLength=bytes[1],passLength=bytes[2+userLength];if(bytes.length<3+userLength+passLength)return;observed.push({user:bytes.subarray(2,2+userLength).toString(),password:bytes.subarray(3+userLength,3+userLength+passLength).toString()});bytes=bytes.subarray(3+userLength+passLength);socket.write(Buffer.from([1,0]));stage=2;}
    else{if(bytes.length<10)return;assert.deepEqual([...bytes.subarray(0,8)],[5,1,0,1,93,184,216,34]);assert.equal(bytes.readUInt16BE(8),port);bytes=bytes.subarray(10);socket.off('data',consume);const upstream=net.connect(port,'127.0.0.1',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,1]));if(bytes.length)upstream.write(bytes);socket.pipe(upstream).pipe(socket);});sockets.add(upstream);upstream.on('error',()=>socket.destroy());return;}
   }
  }socket.on('data',consume);
 });const proxyPort=await listen(proxy);t.after(async()=>{sockets.forEach(s=>s.destroy());await new Promise(r=>proxy.close(r));});
 const {createProxyTransport}=await import('../server/lifecycle/proxy-transport.mjs'),adapter=createProxyTransport({scheme:'socks5',server:'socks5://127.0.0.1:'+proxyPort,username:'alice',password:'secret'},options);t.after(()=>adapter.close());
 assert.equal((await adapter.transport('https://wp.example:'+port+'/')).text,'target-ok');assert.deepEqual(observed,[{user:'alice',password:'secret'}]);assert.equal(calls[0].headers['proxy-authorization'],undefined);
});

test('proxy authentication errors stop the request without direct fallback or secret-bearing errors',async t=>{
 const {port,calls}=await target(t),sockets=new Set(),proxy=http.createServer();let connects=0;
 proxy.on('connection',s=>{sockets.add(s);s.on('error',()=>{});});proxy.on('connect',(_req,socket)=>{connects++;socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');});
 const proxyPort=await listen(proxy);t.after(async()=>{sockets.forEach(s=>s.destroy());await new Promise(r=>proxy.close(r));});
 const {createProxyTransport}=await import('../server/lifecycle/proxy-transport.mjs'),adapter=createProxyTransport({scheme:'http',server:'http://127.0.0.1:'+proxyPort,username:'alice',password:'secret'},options);t.after(()=>adapter.close());
 const usage=[],onProxyUsage=event=>usage.push(event);
 await assert.rejects(adapter.transport('https://wp.example:'+port+'/',{method:'POST',body:'hello',onProxyUsage}),e=>e.code==='PROXY_AUTH_FAILED'&&e.requestNotStarted===true&&!/alice|secret/.test(e.message));assert.equal(calls.length,0);assert.equal(connects,1);
 await assert.rejects(adapter.transport('https://127.0.0.1:'+port+'/',{onProxyUsage}),{code:'unsafe_address'});assert.equal(connects,1);
 assert.equal(usage.length,1);
 const {eventId,...counts}=usage[0];
 assert.deepEqual(counts,{bytesSent:0,bytesReceived:0,requests:0,connections:1});
});

test('a stalled proxy handshake times out and is not retried',async t=>{
 const sockets=new Set(),proxy=http.createServer();let count=0;proxy.on('connection',s=>{sockets.add(s);s.on('error',()=>{});});proxy.on('connect',()=>count++);const port=await listen(proxy);t.after(async()=>{sockets.forEach(s=>s.destroy());await new Promise(r=>proxy.close(r));});
 const {createProxyTransport}=await import('../server/lifecycle/proxy-transport.mjs'),adapter=createProxyTransport({scheme:'http',server:'http://127.0.0.1:'+port},{...options,timeoutMs:100});t.after(()=>adapter.close());
 await assert.rejects(adapter.transport('https://wp.example/'),{code:'PROXY_TIMEOUT'});assert.equal(count,1);
});
