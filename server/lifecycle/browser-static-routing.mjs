// Playwright routes are called only for the first URL of an HTTP redirect.
// Chromium Fetch pauses every static hop, preserving the final URL (relative
// CSS/module dependencies) without allowing any hop onto Chromium's network.
export async function attachBrowserStaticRouting({context,page,handle,epoch,isCurrent}){
 if(typeof context.newCDPSession!=='function')return null;
 const cdp=await context.newCDPSession(page),pending=new Map();let closed=false;
 const error=code=>Object.assign(Error(code),{code});
 async function paused(event){
  const {requestId,request,redirectedRequestId}=event;
  const previous=redirectedRequestId?pending.get(redirectedRequestId):null;
  if(redirectedRequestId)pending.delete(redirectedRequestId);
  const chain=previous?.chain||{epoch:epoch(),hops:0,bytes:0,seen:new Set([request.url])};
  const abort=async()=>{pending.delete(requestId);await cdp.send('Fetch.failRequest',{requestId,errorReason:'Aborted'}).catch(()=>{});};
  if(closed||request.method!=='GET'||!isCurrent(chain.epoch)||redirectedRequestId&&(!previous||previous.target!==request.url))return abort();
  let redirectTarget=null;
  const route={
   staticResource:true,
   request:()=>({url:()=>request.url,method:()=>request.method,resourceType:()=>event.resourceType.toLowerCase(),postDataBuffer:()=>null,isNavigationRequest:()=>false,frame:()=>page.mainFrame(),allHeaders:async()=>{
    const headers=Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),String(value)]));
    // Fetch pauses before Chromium's network layer attaches cookies. Use only
    // this private context's current account jar for the exact target URL.
    delete headers.cookie;const jar=await context.cookies(request.url);
    if(jar.length)headers.cookie=jar.map(cookie=>cookie.name+'='+cookie.value).join('; ');
    return headers;
   }}),
   redirect(target){
    if(chain.seen.has(target))throw error('BROWSER_ASSET_REDIRECT_LOOP');
    if(++chain.hops>5)throw error('BROWSER_ASSET_REDIRECT_LIMIT');
    chain.seen.add(target);redirectTarget=target;
   },
   async fulfill({status=200,headers={},contentType,body=Buffer.alloc(0)}){
    if(closed||!isCurrent(chain.epoch))return abort();
    const bytes=Buffer.from(body);chain.bytes+=bytes.length;
    if(chain.bytes>5*1024*1024)throw error('response_too_large');
    if(status>=300&&status<400){
     if(!redirectTarget)throw error('BROWSER_ASSET_REDIRECT_BLOCKED');
     if(pending.size>=512)throw error('BROWSER_REQUEST_LIMIT');
     pending.set(requestId,{target:redirectTarget,chain});
    }
    const responseHeaders=Object.entries(headers).map(([name,value])=>({name,value:String(value)}));
    if(contentType)responseHeaders.push({name:'content-type',value:contentType});
    try{await cdp.send('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders,body:bytes.toString('base64')});}
    catch(cause){pending.delete(requestId);throw cause;}
   },
   abort
  };
  try{await handle(route);}catch{await abort();}
 }
 cdp.on('Fetch.requestPaused',paused);
 try{await cdp.send('Fetch.enable',{patterns:[{resourceType:'Script',requestStage:'Request'},{resourceType:'Stylesheet',requestStage:'Request'}]});}
 catch(cause){cdp.off('Fetch.requestPaused',paused);await cdp.detach().catch(()=>{});throw cause;}
 return {async close(){closed=true;pending.clear();cdp.off('Fetch.requestPaused',paused);await cdp.detach().catch(()=>{});}};
}
