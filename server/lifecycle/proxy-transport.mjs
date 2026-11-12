import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {createSafeTransport} from './network.mjs';
import {proxyError} from './proxy-pool.mjs';

function wait(socket,event,signal,errorCode='PROXY_CONNECT_FAILED'){return new Promise((resolve,reject)=>{
 const done=(error,value)=>{socket.off(event,ready);socket.off('error',failed);socket.off('close',ended);signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
 const ready=()=>done(null,socket),failed=()=>done(proxyError(errorCode)),ended=()=>done(proxyError(errorCode)),abort=()=>done(proxyError('PROXY_TIMEOUT'));
 socket.once(event,ready);socket.once('error',failed);socket.once('close',ended);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
function read(socket,size,signal){return new Promise((resolve,reject)=>{
 const finish=(error,value)=>{socket.off('readable',ready);socket.off('error',failed);socket.off('end',ended);socket.off('close',ended);signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
 const ready=()=>{const value=socket.read(size);if(value)finish(null,value);},failed=()=>finish(proxyError('PROXY_TUNNEL_FAILED')),ended=()=>finish(proxyError('PROXY_TUNNEL_FAILED')),abort=()=>finish(proxyError('PROXY_TIMEOUT'));
 socket.on('readable',ready);socket.once('error',failed);socket.once('end',ended);socket.once('close',ended);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else ready();
});}
function ipBytes(address){
 if(net.isIPv4(address))return Buffer.from([1,...address.split('.').map(Number)]);
 if(!net.isIPv6(address)||address.includes('.'))throw proxyError('unsafe_address');
 const halves=address.split('::'),left=halves[0]?halves[0].split(':'):[],right=halves[1]?halves[1].split(':'):[];
 const words=halves.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;
 const value=Buffer.alloc(17);value[0]=4;words.forEach((word,i)=>value.writeUInt16BE(parseInt(word,16),1+i*2));return value;
}
async function socks(proxy,target,signal,register,netConnect){
 const endpoint=new URL(proxy.server),socket=register(netConnect({host:endpoint.hostname.replace(/^\[|\]$/g,''),port:Number(endpoint.port)||1080}));
 await wait(socket,'connect',signal);socket.write(proxy.username?Buffer.from([5,2,0,2]):Buffer.from([5,1,0]));
 const greeting=await read(socket,2,signal);if(greeting[0]!==5||![0,2].includes(greeting[1]))throw proxyError('PROXY_AUTH_FAILED');
 if(greeting[1]===2){
  const user=Buffer.from(proxy.username||''),password=Buffer.from(proxy.password||'');if(!user.length||!password.length||user.length>255||password.length>255)throw proxyError('PROXY_AUTH_FAILED');
  socket.write(Buffer.concat([Buffer.from([1,user.length]),user,Buffer.from([password.length]),password]));const auth=await read(socket,2,signal);if(auth[0]!==1||auth[1]!==0)throw proxyError('PROXY_AUTH_FAILED');
 }
 const port=Buffer.alloc(2);port.writeUInt16BE(target.port);socket.write(Buffer.concat([Buffer.from([5,1,0]),ipBytes(target.address),port]));
 const reply=await read(socket,4,signal);if(reply[0]!==5||reply[1]!==0||reply[2]!==0)throw proxyError('PROXY_TUNNEL_FAILED');
 if(reply[3]===1)await read(socket,6,signal);else if(reply[3]===4)await read(socket,18,signal);else if(reply[3]===3){const length=(await read(socket,1,signal))[0];await read(socket,length+2,signal);}else throw proxyError('PROXY_TUNNEL_FAILED');
 return socket;
}
function connectHttp(proxy,target,signal,register,proxyCa){return new Promise((resolve,reject)=>{
 const endpoint=new URL(proxy.server),authority=(net.isIPv6(target.address)?'['+target.address+']':target.address)+':'+target.port;
 const headers={host:authority};if(proxy.username)headers['proxy-authorization']='Basic '+Buffer.from(proxy.username+':'+proxy.password).toString('base64');
 const request=(endpoint.protocol==='https:'?https:http).request({hostname:endpoint.hostname.replace(/^\[|\]$/g,''),port:Number(endpoint.port)||(endpoint.protocol==='https:'?443:80),method:'CONNECT',path:authority,headers,agent:false,rejectUnauthorized:true,...(proxyCa?{ca:proxyCa}:{}),maxHeaderSize:16384,signal});
 request.once('error',()=>reject(proxyError(signal.aborted?'PROXY_TIMEOUT':'PROXY_CONNECT_FAILED')));
 request.once('connect',(reply,socket,head)=>{register(socket);if(reply.statusCode!==200){socket.destroy();reject(proxyError(reply.statusCode===407?'PROXY_AUTH_FAILED':'PROXY_TUNNEL_FAILED'));return;}if(head.length)socket.unshift(head);resolve(socket);});
 request.once('response',reply=>{reply.resume();request.destroy();reject(proxyError(reply.statusCode===407?'PROXY_AUTH_FAILED':'PROXY_TUNNEL_FAILED'));});
 request.end();
});}

// Destination address is provided by createSafeTransport's validated, pinned
// lookup. Proxy authentication never enters destination request headers.
export function createProxyTransport(proxy,{lookup,tlsConnect=tls.connect,netConnect=net.connect,timeoutMs=15000,proxyCa}={}){
 const sockets=new Set(),agents=new Set(),requests=new Set();let closed=false;
 const register=socket=>{sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));return socket;};
 const request=(url,{onProxyConnect,...options},receive)=>{
  if(closed)throw proxyError('PROXY_SESSION_CLOSED');
  const controller=new AbortController(),owned=new Set(),agent=new https.Agent({keepAlive:false,maxSockets:1});agents.add(agent);
  const own=socket=>{owned.add(socket);socket.once('close',()=>owned.delete(socket));return register(socket);};
  controller.signal.addEventListener('abort',()=>{for(const socket of owned)socket.destroy();},{once:true});
  let connectionTimer;
  agent.createConnection=(_options,callback)=>{
   connectionTimer=setTimeout(()=>controller.abort(),Math.max(1,Math.floor(Math.min(Number.isInteger(timeoutMs)&&timeoutMs>0?timeoutMs:15000,15000)*0.8)));
   (async()=>{
    let tunnel;
    try{
     const host=url.hostname.replace(/^\[|\]$/g,''),pinned=await new Promise((resolve,reject)=>options.lookup(host,{},(error,address,family)=>error?reject(error):resolve({address,family})));
     if(controller.signal.aborted)throw proxyError('PROXY_TIMEOUT');
     const target={...pinned,port:Number(url.port)||443};
     onProxyConnect?.();
     tunnel=proxy.scheme==='socks5'?await socks(proxy,target,controller.signal,own,netConnect):await connectHttp(proxy,target,controller.signal,own,proxyCa);
     if(controller.signal.aborted)throw proxyError('PROXY_TIMEOUT');
     const secure=own(tlsConnect({socket:tunnel,host,servername:net.isIP(host)?undefined:host,rejectUnauthorized:true,checkServerIdentity:(_name,certificate)=>tls.checkServerIdentity(host,certificate),ALPNProtocols:['http/1.1']}));
     await wait(secure,'secureConnect',controller.signal,'network_failed');clearTimeout(connectionTimer);callback(null,secure);
    }catch(error){clearTimeout(connectionTimer);tunnel?.destroy();const clean=proxyError(/^PROXY_/.test(error?.code||'')?error.code:'network_failed');clean.proxyRequestNotStarted=true;callback(clean);}
   })();
  };
  const headers={...options.headers};delete headers['proxy-authorization'];
  const req=https.request(url,{...options,headers,agent},receive);requests.add(req);
  req.once('close',()=>{controller.abort();clearTimeout(connectionTimer);agent.destroy();agents.delete(agent);requests.delete(req);});
  return req;
 };
 const transport=createSafeTransport({allowWrites:true,maxBytes:5*1024*1024,timeoutMs,...(lookup?{lookup}:{}),request,measureProxy:true});
 return {transport,close:async()=>{closed=true;for(const req of requests)req.destroy();for(const socket of sockets)socket.destroy();for(const agent of agents)agent.destroy();}};
}
