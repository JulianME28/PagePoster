// Trusted server-side client for PagePoster Bridge v1. This is intentionally
// separate from the read-only WordPress monitor. No direct core-REST fallback.
import { createHash } from 'node:crypto';
import pluginIntegrity from './plugin-integrity.cjs';
import { JSDOM } from './dom-runtime.mjs';
import { createSafeTransport, validatePublicUrl } from './network.mjs';
import { createWordPressClient } from './wordpress.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
export const REQUIRED_BRIDGE_VERSION='0.2.1',REQUIRED_CLEAN_LINKS_VERSION='1.1.1';
const CLEAN_FEATURES=['contact-schemes','exact-wrapper-boundary'];
const CAPS=['create','update','atomicCas','idempotentCreate','adopt','inspect'];
const ERRORS=new Set(['pp_bridge_uncertain','pp_bridge_database_failure','pp_bridge_unsupported_storage','pp_bridge_idempotency_conflict','pp_bridge_validation','pp_bridge_authentication','pp_bridge_forbidden','pp_bridge_unmanaged','pp_bridge_operation_not_found','pp_bridge_page_not_found','pp_bridge_not_found','pp_bridge_operation_owner','pp_bridge_cas_conflict','pp_bridge_content_changed','pp_bridge_dom_required','pp_bridge_https_required','pp_bridge_multisite_unsupported','pp_bridge_unavailable','pp_bridge_media_type','pp_bridge_body_too_large','pp_bridge_clean_links_required']);
const NET_CODES=new Set(['unsafe_url','unsafe_address','dns_failed','network_failed','network_timeout','response_too_large','unsupported_encoding','too_many_redirects','write_redirect_blocked','request_too_large','invalid_request_body']);
ERRORS.add('pp_bridge_nonce');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>Number.isSafeInteger(value)&&value>0;
const good=status=>status>=200&&status<300;
const text=(value,limit,required=false)=>typeof value==='string'&&Buffer.byteLength(value,'utf8')<=limit&&!value.includes('\0')&&value.isWellFormed()&&(!required||!!value.trim());
export class BridgeError extends Error {
  constructor(code,{uncertain=false,operationId,status,causeCode}={}) {
    super(code);this.name='BridgeError';this.code=code;this.uncertain=uncertain;
    if(operationId)this.operationId=operationId;
    if(Number.isInteger(status))this.status=status;
    if(NET_CODES.has(causeCode))this.causeCode=causeCode;
  }
}
const fail=(code,details)=>{throw new BridgeError(code,details);};
function url(value) { try{return validatePublicUrl(value);}catch{fail('unsafe_url');} }
function validOperationId(value){if(typeof value!=='string'||!UUID.test(value))fail('bridge_validation');return value;}
function marked(content) {
  const document=new JSDOM(content).window.document;
  try {
    const matches=document.querySelectorAll('[id="pp-landing"],[id="pp-universal-pl"]');
    return matches.length===1&&matches[0].localName==='div';
  }finally{document.defaultView.close();}
}
function operationInput(value) {
  if(!object(value)||!['create','update','adopt'].includes(value.kind))fail('bridge_validation');
  const fields=value.kind==='adopt'?['operationId','kind','postType','postId','expectedContentHash']:['operationId','kind','postType','title','content','status',...(value.kind==='update'?['postId','expectedContentHash']:[])];
  if(Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(value,key)))fail('bridge_validation');
  validOperationId(value.operationId);
  if(value.kind!=='adopt'&&(!['page','post'].includes(value.postType)||!['draft','publish'].includes(value.status)||!text(value.title,2000,true)||!text(value.content,1000000,true)||!marked(value.content)))fail('bridge_validation');
  if(['update','adopt'].includes(value.kind)&&(!['page','post'].includes(value.postType)||!validId(value.postId)||typeof value.expectedContentHash!=='string'||!HASH.test(value.expectedContentHash)))fail('bridge_validation');
  const copy=Object.fromEntries(fields.map(key=>[key,value[key]]));
  if(Buffer.byteLength(JSON.stringify(copy),'utf8')>1200000)fail('bridge_validation');
  return copy;
}
export function bridgeContentHash(snapshot) {
  if(!object(snapshot)||['postType','title','content','status'].some(key=>typeof snapshot[key]!=='string'))fail('bridge_validation');
  const digest=createHash('sha256').update('pageposter-snapshot-v1\0','utf8');
  for(const field of ['postType','title','content','status']) {
    const value=snapshot[field];digest.update(String(Buffer.byteLength(value,'utf8'))+':','utf8');digest.update(value,'utf8');
  }
  return digest.digest('hex');
}
function endpoint(root,route) {
  const parsed=new URL(root);
  if(parsed.searchParams.has('rest_route'))parsed.searchParams.set('rest_route','/pageposter/v1'+route);
  else parsed.pathname=parsed.pathname.replace(/\/?$/,'/')+'pageposter/v1'+route;
  parsed.hash='';return parsed.href;
}
function stringList(value){return Array.isArray(value)&&value.length<=100&&value.every(item=>text(item,2000));}
function operationResult(value,operationId,origin) {
  if(!object(value)||value.operationId!==operationId||!['create','update','adopt'].includes(value.kind)||!['completed','conflict'].includes(value.state)||
     typeof value.replayed!=='boolean'||!validId(value.postId)||!HASH.test(value.contentHash||'')||
     !(value.previousContentHash===null||HASH.test(value.previousContentHash||''))||
     !['page','post'].includes(value.postType)||!text(value.status,40,true)||
     typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||
     typeof value.completedAt!=='string'||!Number.isFinite(Date.parse(value.completedAt))||(value.modifiedGmt!==undefined&&(!text(value.modifiedGmt,100,true)||!Number.isFinite(Date.parse(value.modifiedGmt))))||!stringList(value.warnings))fail('bridge_invalid_response');
  if(url(value.url).origin!==origin)fail('bridge_invalid_response');
  return Object.fromEntries(['operationId','kind','state','replayed','postId','contentHash','previousContentHash','postType','status','url','createdAt','completedAt','warnings',...(value.modifiedGmt===undefined?[]:['modifiedGmt'])].map(key=>[key,value[key]]));
}
function snapshotResult(value,postId,origin) {
  if(!object(value)||value.postId!==postId||!['page','post'].includes(value.postType)||!text(value.title,100000)||!text(value.content,1500000)||!text(value.status,40,true)||
     !HASH.test(value.contentHash||'')||typeof value.managed!=='boolean'||typeof value.canEdit!=='boolean'||!text(value.modifiedGmt,100))fail('bridge_invalid_response');
  if(url(value.url).origin!==origin||bridgeContentHash(value)!==value.contentHash)fail('bridge_invalid_response');
  return Object.fromEntries(['postId','postType','title','content','status','contentHash','modifiedGmt','url','managed','canEdit'].map(key=>[key,value[key]]));
}

/** Methods require {site:{baseUrl,username,applicationPassword},apiRoot?}.
 * apiRoot can come from checkSite; otherwise same-origin WP discovery runs.
 * submitOperation sends exactly one POST; getOperation only reconciles. */
export function createBridgeClient({transport=createSafeTransport({allowWrites:true}),wordpressClient}={}) {
  const discovery=wordpressClient||createWordPressClient({transport});
  async function context({site,apiRoot}={}) {
    const base=url(site?.baseUrl);
    if(!text(site?.username,256,true)||/[:\r\n]/.test(site.username)||!text(site?.applicationPassword,1024,true)||/[\r\n]/.test(site.applicationPassword))fail('credentials_required');
    let root=apiRoot;
    if(!root){const found=await discovery.checkSite(site);if(found.state!=='ok'||!found.apiRoot)fail(found.code==='authentication_failed'?'authentication_failed':'bridge_discovery_failed');root=found.apiRoot;}
    const parsed=url(root);if(parsed.origin!==base.origin)fail('unsafe_url');
    return {root:parsed.href,origin:base.origin,headers:{authorization:'Basic '+Buffer.from(site.username+':'+site.applicationPassword,'utf8').toString('base64'),accept:'application/json'}};
  }
  async function request(ctx,route,{operation,method='GET',send=transport}={}) {
    const address=endpoint(ctx.root,route);
    if(url(address).origin!==ctx.origin)fail('unsafe_url');
    let response,received=false;
    try {
      response=await send(address,{method,headers:{...ctx.headers,...(method==='POST'?{'content-type':'application/json'}:{})},...(operation?{body:JSON.stringify(operation)}:{})});
      received=true;
      const content=typeof response?.text==='function'?await response.text():response?.text;
      if(!response||!Number.isInteger(response.status)||typeof content!=='string'||Buffer.byteLength(content,'utf8')>2*1024*1024)fail('bridge_invalid_response');
      const final=url(response.url||address);
      const moved=Array.isArray(response.redirects)&&response.redirects.some(hop=>new URL(hop.from).origin!==new URL(hop.to).origin);
      if(final.origin!==ctx.origin||moved||(method==='POST'&&((response.redirects?.length||0)>0||response.status>=300&&response.status<400)))fail('write_redirect_blocked');
      let data;try{data=JSON.parse(content);}catch{fail('bridge_invalid_response');}
      return {status:response.status,data};
    }catch(error){
      if(method==='POST'){
        if(error?.writeNotAttempted===true)throw error;
        if(!received&&['request_too_large','invalid_request_body','unsafe_url','unsafe_address'].includes(error?.code))fail('bridge_validation',{operationId:operation.operationId,causeCode:error.code});
        fail('pp_bridge_uncertain',{uncertain:true,operationId:operation.operationId,causeCode:error?.code});
      }
      fail(NET_CODES.has(error?.code)?error.code:(error instanceof BridgeError?error.code:'network_failed'));
    }
  }
  function rejectResponse(reply,operation) {
    const code=object(reply.data)&&ERRORS.has(reply.data.code)?reply.data.code:null;
    if(code)fail(code,{uncertain:['pp_bridge_uncertain','pp_bridge_unavailable'].includes(code),operationId:operation?.operationId,status:reply.status});
    if(reply.status===401||reply.status===403)fail(reply.status===401?'authentication_failed':'permission_denied',{status:reply.status,operationId:operation?.operationId});
    if(operation)fail('pp_bridge_uncertain',{uncertain:true,operationId:operation.operationId,status:reply.status});
    fail('bridge_invalid_response',{status:reply.status});
  }
  async function statusFor(ctx) {
    const reply=await request(ctx,'/status');
    if(!good(reply.status))rejectResponse(reply);
    const data=reply.data;
    if(!object(data)||typeof data.ready!=='boolean'||!object(data.capabilities)||!Number.isSafeInteger(data.schemaVersion)||!text(data.version,40)||!stringList(data.limitations))fail('bridge_invalid_response');
    const capabilities=Object.fromEntries(CAPS.map(key=>[key,data.capabilities[key]===true]));
    const cleanLinksVersion=typeof data.cleanLinksVersion==='string'?data.cleanLinksVersion:'',cleanLinksFeatures=Array.isArray(data.cleanLinksFeatures)?data.cleanLinksFeatures.filter(x=>typeof x==='string'):[];
    const cleanLinksActive=data.cleanLinksActive===true&&cleanLinksVersion===REQUIRED_CLEAN_LINKS_VERSION&&CLEAN_FEATURES.every(x=>cleanLinksFeatures.includes(x));
    const integrity=pluginIntegrity.verifyPackageIntegrity(data.packageIntegrity);
    const limitations=[...data.limitations];
    if(!integrity.verified)limitations.push(integrity.expectedAvailable?'Package checksum mismatch or missing integrity evidence: reinstall the exact supplied Bridge and Clean Links ZIPs.':'Local package checksums are unavailable; restore the supplied plugin archives.');
    if(!cleanLinksActive)limitations.push('Update required: install the current PagePoster Clean Links package with verified version/features.');
    if(data.version!==REQUIRED_BRIDGE_VERSION)limitations.push('Update required: install PagePoster Bridge '+REQUIRED_BRIDGE_VERSION+'.');
    return {version:data.version,schemaVersion:data.schemaVersion,integrityVerified:integrity.verified,integrity,ready:integrity.verified&&data.version===REQUIRED_BRIDGE_VERSION&&data.ready===true&&cleanLinksActive&&data.schemaVersion===1&&CAPS.every(key=>capabilities[key]),cleanLinksActive,cleanLinksVersion,cleanLinksFeatures,capabilities,limitations};
  }
  async function checkStatus(input){return statusFor(await context(input));}
  async function getOperation(input) {
    validOperationId(input?.operationId);const ctx=await context(input);
    const reply=await request(ctx,'/operations/'+input.operationId);
    if(reply.status===404&&reply.data?.code==='pp_bridge_operation_not_found')return {operationId:input.operationId,state:'not_found',uncertain:true};
    if(!good(reply.status)&&!(reply.status===409&&reply.data?.state==='conflict'))rejectResponse(reply);
    return operationResult(reply.data,input.operationId,ctx.origin);
  }
  async function getPage(input) {
    if(!validId(input?.postId))fail('bridge_validation');const ctx=await context(input);
    const reply=await request(ctx,'/pages/'+input.postId);
    if(!good(reply.status))rejectResponse(reply);
    return snapshotResult(reply.data,input.postId,ctx.origin);
  }
  async function inspectPage(input) {
    if(!validId(input?.postId))fail('bridge_validation');const ctx=await context(input);
    const reply=await request(ctx,'/inspect/'+input.postId);if(!good(reply.status))rejectResponse(reply);
    return snapshotResult(reply.data,input.postId,ctx.origin);
  }
  async function submitOperation(input) {
    const operation=operationInput(input?.operation);
    const ctx=await context(input),status=await statusFor(ctx);
    if(!status.ready)fail('bridge_not_ready',{operationId:operation.operationId});
    if(input.beforeSend&&!input.browserSubmit)input.beforeSend();
    const reply=await request(ctx,'/operations',{method:'POST',operation,...(input.browserSubmit?{send:(address,options)=>input.browserSubmit({address,options,operation,beforeSend:input.beforeSend})}:{})});
    if(!good(reply.status)&&!(reply.status===409&&reply.data?.state==='conflict'))rejectResponse(reply,operation);
    try {
      const result=operationResult(reply.data,operation.operationId,ctx.origin);
      if(result.kind!==operation.kind||(['update','adopt'].includes(operation.kind)&&result.postId!==operation.postId))fail('bridge_invalid_response');
      if(result.state==='completed'&&(operation.kind==='adopt'?(result.contentHash!==operation.expectedContentHash||result.postType!==operation.postType):(result.contentHash!==bridgeContentHash(operation)||result.status!==operation.status||result.postType!==operation.postType)))fail('bridge_invalid_response');
      return result;
    }catch{fail('pp_bridge_uncertain',{uncertain:true,operationId:operation.operationId});}
  }
  return {checkStatus,getOperation,getPage,inspectPage,submitOperation};
}
