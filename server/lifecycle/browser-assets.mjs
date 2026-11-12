import {validatePublicUrl} from './network.mjs';

const MAX_BYTES=32*1024*1024,MAX_ENTRIES=256,MAX_BODY=5*1024*1024,MAX_TTL=300000;
const assetKinds={
 js:['script',['application/javascript','text/javascript','application/x-javascript','application/ecmascript','text/ecmascript']],
 css:['stylesheet',['text/css']],
 woff:['font',['font/woff','application/font-woff','application/x-font-woff']],
 woff2:['font',['font/woff2','application/font-woff2','application/x-font-woff2']],
 png:['image',['image/png']],jpg:['image',['image/jpeg']],jpeg:['image',['image/jpeg']],
 gif:['image',['image/gif']],svg:['image',['image/svg+xml']],
 ico:['image',['image/x-icon','image/vnd.microsoft.icon']],webp:['image',['image/webp']]
};
const privateHeaders=new Set(['set-cookie','set-cookie2','cookie','authorization','proxy-authorization','www-authenticate','proxy-authenticate','authentication-info','proxy-authentication-info']);
const forbiddenDirectives=new Set(['no-store','no-cache','private','must-revalidate']);

function target(input,resourceType,method){
 if(method!=='GET')return null;
 let url,pathname;
 try{url=validatePublicUrl(input);pathname=decodeURIComponent(url.pathname);}catch{return null;}
 if(url.hash||/%(?:2f|5c)/i.test(url.pathname)||/[\u0000-\u001f\u007f\\]/.test(pathname)||
    !/^\/wp-(?:includes|content)\//.test(pathname)||/(?:^|\/)\.{1,2}(?:\/|$)/.test(pathname)||/\.php\d*(?:[./;]|$)/i.test(pathname))return null;
 const extension=pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
 const kind=Object.hasOwn(assetKinds,extension)?assetKinds[extension]:null;
 if(!kind||kind[0]!==resourceType)return null;
 let versioned=false;
 for(const [name,value]of url.searchParams){
  if(!['ver','v','version'].includes(name)||!value||value.length>256||/[\u0000-\u0020\u007f]/.test(value))return null;
  versioned=true;
 }
 return {key:url.href,mimes:kind[1],versioned};
}

function responseHeaders(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const values=new Map();let bytes=0;
 for(const [rawName,rawValue]of Object.entries(input)){
  const name=rawName.toLowerCase(),parts=Array.isArray(rawValue)?rawValue:[rawValue];
  if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)||privateHeaders.has(name)||
     parts.some(value=>typeof value!=='string'||/[\r\n\u0000]/.test(value)))return null;
  const value=parts.join(', ');bytes+=Buffer.byteLength(name)+Buffer.byteLength(value);
  if(bytes>64*1024)return null;
  values.set(name,values.has(name)?values.get(name)+', '+value:value);
 }
 return Object.fromEntries(values);
}

function lifetime(headers,versioned){
 if((headers.vary||'').split(',').some(value=>value.trim()&&value.trim().toLowerCase()!=='accept-encoding')||
    /challenge/i.test(headers['cf-mitigated']||''))return null;
 let maxAge=null;
 for(const directive of (headers['cache-control']||'').split(',')){
  const match=directive.trim().match(/^([^=\s]+)(?:\s*=\s*(.*))?$/);
  if(!match)continue;
  const name=match[1].toLowerCase();
  if(forbiddenDirectives.has(name))return null;
  if(name==='max-age'){
   if(!/^(?:\d+|"\d+")$/.test(match[2]||''))return null;
   const seconds=Number(match[2].replaceAll('"',''));
   if(!Number.isFinite(seconds)||seconds<=0)return null;
   maxAge=maxAge===null?seconds:Math.min(maxAge,seconds);
  }
 }
 if(maxAge===null&&!versioned)return null;
 return Math.min(MAX_TTL,maxAge===null?MAX_TTL:maxAge*1000);
}

const bounded=(value,maximum)=>Number.isSafeInteger(value)&&value>=0?Math.min(value,maximum):maximum;

// One cache belongs to one private browser session and authenticated account.
// Only transport response bytes and public static-response headers are retained.
export function createBrowserAssetCache({clock=Date.now,maxBytes=MAX_BYTES,maxEntries=MAX_ENTRIES}={}){
 const byteLimit=bounded(maxBytes,MAX_BYTES),entryLimit=bounded(maxEntries,MAX_ENTRIES),entries=new Map();let bytes=0;
 const remove=key=>{const entry=entries.get(key);if(entry){bytes-=entry.bytes;entries.delete(key);}};
 function get(url,resourceType,method='GET'){
  const asset=target(url,resourceType,method);if(!asset)return null;
  const entry=entries.get(asset.key);if(!entry)return null;
  const now=clock();if(!Number.isFinite(now)||entry.expiresAt<=now){remove(asset.key);return null;}
  entries.delete(asset.key);entries.set(asset.key,entry);
  return {status:200,headers:{...entry.headers},body:Buffer.from(entry.body)};
 }
 function put(url,resourceType,method,response){
  const asset=target(url,resourceType,method);
  if(!asset||!byteLimit||!entryLimit||response?.status!==200)return false;
  const headers=responseHeaders(response.headers);if(!headers)return false;
  const mime=(headers['content-type']||'').split(';')[0].trim().toLowerCase();
  if(!asset.mimes.includes(mime))return false;
  const ttl=lifetime(headers,asset.versioned);if(ttl===null)return false;
  const source=response.body??response.text;
  if(typeof source!=='string'&&!(source instanceof Uint8Array))return false;
  const length=typeof source==='string'?Buffer.byteLength(source):source.byteLength;
  if(length>MAX_BODY||length>byteLimit)return false;
  const body=Buffer.from(source);
  if(/^\s*(?:<!doctype\s+html|<html(?:\s|>))/i.test(body.subarray(0,512).toString('utf8')))return false;
  const now=clock();if(!Number.isFinite(now))return false;
  for(const [key,entry]of entries)if(entry.expiresAt<=now)remove(key);
  remove(asset.key);
  while(entries.size>=entryLimit||bytes+length>byteLimit)remove(entries.keys().next().value);
  entries.set(asset.key,{headers,body,bytes:length,expiresAt:now+ttl});bytes+=length;
  return true;
 }
 function clear(){entries.clear();bytes=0;}
 return {get,put,clear};
}
