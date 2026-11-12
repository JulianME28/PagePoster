import {JSDOM} from './dom-runtime.mjs';
import {AMP_PARAMETER,buildAmpPayload} from './amp-mode.mjs';
import {initializeAmpValidator,validateAmpDocument} from './amp-validator.mjs';

function sameUrl(value,expected){
 if(!value)return false;
 let actual;try{actual=new URL(value);}catch{return false;}
 return !actual.username&&!actual.password&&actual.origin===expected.origin&&actual.pathname===expected.pathname&&
  actual.hash===expected.hash&&actual.searchParams.toString()===expected.searchParams.toString();
}

function headLinks(document,relation){
 return Array.from(document.head.querySelectorAll('link[rel]')).filter(link=>link.rel.toLowerCase().split(/[\t\n\f\r ]+/).includes(relation));
}

// Read-only and optional after confirmed publication. An unavailable AMP check
// never authorizes another Publish, changes a donor or creates a second post.
export async function checkAmpPair({url,html,title,language='en',transport}){
 let canonical;try{canonical=new URL(url);canonical.hash='';}catch{return {state:'unknown',code:'AMP_READ_UNAVAILABLE'};}
 const alternate=new URL(canonical);alternate.searchParams.set(AMP_PARAMETER,'1');
 const unknown=code=>({state:'unknown',code,url:alternate.href});
 if(canonical.protocol!=='https:'||canonical.username||canonical.password||canonical.searchParams.has(AMP_PARAMETER)||!transport)return {state:'unknown',code:'AMP_READ_UNAVAILABLE'};
 const read=async target=>{
  const result=await transport(target.href,{method:'GET',sameOriginOnly:true,headers:{accept:'text/html'},signal:AbortSignal.timeout(15000)});
  if(result.status!==200||typeof result.text!=='string'||Buffer.byteLength(result.text)>2000000||result.url&&!sameUrl(result.url,target))throw Error('AMP_READ_UNAVAILABLE');
  return result.text;
 };
 let main,amp;
 try{
  main=new JSDOM(await read(canonical));
  const canonicals=headLinks(main.window.document,'canonical'),alternates=headLinks(main.window.document,'amphtml');
  if(canonicals.length!==1||alternates.length!==1||!sameUrl(canonicals[0].getAttribute('href'),canonical)||!sameUrl(alternates[0].getAttribute('href'),alternate))return unknown('AMP_HEAD_MISMATCH');
  const ampHtml=await read(alternate);
  await initializeAmpValidator();validateAmpDocument(ampHtml);
  amp=new JSDOM(ampHtml);
  const doc=amp.window.document,back=headLinks(doc,'canonical');
  if(back.length!==1||!sameUrl(back[0].getAttribute('href'),canonical))return unknown('AMP_CANONICAL_MISMATCH');
  const expected=buildAmpPayload({html,title,language}),body=new JSDOM('<!doctype html><body>'+expected.body);
  try{if(doc.title!==expected.title.replace(/[\t\n\f\r ]+/g,' ').trim()||doc.documentElement.lang!==expected.language||
   doc.body.innerHTML!==body.window.document.body.innerHTML||doc.head.querySelector('style[amp-custom]')?.textContent!==expected.css)return unknown('AMP_CONTENT_MISMATCH');}
  finally{body.window.close();}
  return {state:'ready',url:alternate.href,...(expected.styleMode==='compact'?{styleMode:'compact'}:{})};
 }catch{return unknown('AMP_READ_UNCONFIRMED');}
 finally{main?.window.close();amp?.window.close();}
}
