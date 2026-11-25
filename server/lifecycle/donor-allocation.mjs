import {validatePublicUrl} from './network.mjs';
import {normalizeSiteCriteria} from './site-source.mjs';
import {isDeepStrictEqual} from 'node:util';
import {donorDomainKey} from './donor-domain.mjs';

const byId=(a,b)=>a.id<b.id?-1:a.id>b.id?1:a.index-b.index;
const originSet=values=>new Set((values||[]).map(value=>new URL(value).origin));
const domainSet=values=>new Set((values||[]).map(donorDomainKey));

function validCredentials(candidate){
 return !!candidate&&typeof candidate==='object'&&typeof candidate.username==='string'&&!!candidate.username.trim()&&candidate.username.length<=256&&!/[\r\n\0:]/.test(candidate.username)&&typeof candidate.password==='string'&&!!candidate.password&&candidate.password.length<=4096&&!/[\r\n\0]/.test(candidate.password);
}
function validCandidate(candidate){
 if(!candidate||typeof candidate!=='object'||typeof candidate.id!=='string'||!candidate.id||candidate.id.length>500||!validCredentials(candidate))return null;
 try{const url=validatePublicUrl(candidate.baseUrl);return {candidate,origin:url.origin,domain:donorDomainKey(url)};}catch{return null;}
}
const metadata=candidate=>Object.fromEntries(Object.entries(candidate).filter(([name])=>!['username','password','alternateCredentials'].includes(name)));

function matches(candidate,criteria,countries){
 const metrics=candidate.metrics||{};
 return (criteria.minDr===null||Number.isFinite(metrics.dr)&&metrics.dr>=criteria.minDr)
  &&(criteria.minTraffic===null||Number.isFinite(metrics.traffic)&&metrics.traffic>=criteria.minTraffic)
  &&(!countries.length||Array.isArray(metrics.geo)&&countries.some(code=>metrics.geo.includes(code)));
}

/**
 * Pure maximum-cardinality assignment. Candidates arrive in source preference
 * order; a duplicate origin contributes its first eligible row for each request.
 * Equal-size requests use ID order, independently of input order. Results retain
 * input order and original candidate objects, so callers must still admit the
 * proposed reservations atomically against their current state.
 *
 * A present pinnedCandidate property is a fixed manual choice, including null
 * for a lost choice. Pins may override criteria but are never moved/replaced.
 * usedOrigins/usedRowIds apply globally and may also be set on each request.
 * Optional pure candidateFor(request, rawCandidate) may exclude a row with null
 * or return a credential-only transformation. Identity, destination and all
 * selection metadata must stay unchanged. It also applies to fixed pins.
 */
export function allocateDonors(requests,candidates,{usedOrigins=[],usedRowIds=[],candidateFor}={}){
 if(candidateFor!==undefined&&typeof candidateFor!=='function')throw new TypeError('candidateFor must be a function.');
 const blockedOrigins=domainSet(usedOrigins),blockedIds=new Set(usedRowIds),selected=new Map(),failures=new Map();
 const entries=requests.map((request,index)=>({request,id:request.id,index,usedOrigins:domainSet(request.usedOrigins),usedIds:new Set(request.usedRowIds||[])}));
 const unavailable=(entry,row)=>blockedOrigins.has(row.domain)||blockedIds.has(row.candidate.id)||entry.usedOrigins.has(row.domain)||entry.usedIds.has(row.candidate.id);
 const forRequest=(entry,row)=>{
  if(!candidateFor)return row;
  // Snapshot source metadata once per row. Per-request account changes cannot
  // alter its criteria or destination, including during augmenting paths.
  if(!Object.hasOwn(row,'metadata'))row.metadata=structuredClone(metadata(row.candidate));
  const candidate=candidateFor(entry.request,row.candidate);
  if(!validCredentials(candidate)||candidate.alternateCredentials!=null&&!validCredentials(candidate.alternateCredentials)||!isDeepStrictEqual(row.metadata,metadata(candidate)))return null;
  return {candidate,origin:row.origin,domain:row.domain};
 };
 const pinned=entries.filter(entry=>Object.hasOwn(entry.request,'pinnedCandidate')).sort(byId);
 for(const entry of pinned){
  let row=validCandidate(entry.request.pinnedCandidate);
  if(!row){failures.set(entry,{reason:'pinned_unavailable',eligibleOrigins:0});continue;}
  if(unavailable(entry,row)){failures.set(entry,{reason:'pinned_reserved',eligibleOrigins:0});continue;}
  row=forRequest(entry,row);if(!row){failures.set(entry,{reason:'pinned_unavailable',eligibleOrigins:0});continue;}
  selected.set(entry,row.candidate);blockedOrigins.add(row.domain);blockedIds.add(row.candidate.id);
 }

 const automatic=entries.filter(entry=>!Object.hasOwn(entry.request,'pinnedCandidate'));
 if(automatic.length){
  // Validate and parse each source URL once, rather than once per request or
  // augmenting step. No transport, clock, store, or credentials leave this API.
  const rows=candidates.map(validCandidate).filter(Boolean),limit=automatic.length;
  for(const entry of automatic){
   const criteria=normalizeSiteCriteria(entry.request.criteria),countries=criteria.geo?criteria.geo.split(','):[];
   const allowed=entry.request.allowedOrigins===undefined?null:originSet(entry.request.allowedOrigins),seen=new Set();
   entry.choices=[];
   for(const row of rows){
    if(unavailable(entry,row)||allowed&&!allowed.has(row.origin)||seen.has(row.domain)||!matches(row.candidate,criteria,countries))continue;
    const eligible=forRequest(entry,row);if(!eligible)continue;
    seen.add(row.domain);
    if(entry.choices.length<limit)entry.choices.push(eligible);
   }
   entry.eligibleOrigins=seen.size;
  }
  // Keeping the first K distinct eligible origins per automatic request is
  // cardinality-safe for K requests: a truncated request retains K neighbors.
  // Any subset containing it therefore has at least K neighbors (at least the
  // subset size); all subsets of only untruncated requests are unchanged. Thus
  // no new Hall deficiency is introduced, including for a partial matching.
  // The scan costs O(K*M), retained edges O(K^2), and matching O(K^3), avoiding
  // repeated scans of a source containing up to 100,000 rows during matching.
  automatic.sort((a,b)=>a.eligibleOrigins-b.eligibleOrigins||byId(a,b));
  const owners=new Map();
  for(const start of automatic){
   // Prefer a free donor over disturbing a higher-priority request's choice.
   const free=start.choices.find(row=>!owners.has(row.domain));
   if(free){owners.set(free.domain,start);selected.set(start,free.candidate);continue;}
   // Breadth-first augmenting paths keep the search iterative for large batches.
   const parents=new Map([[start,null]]),queue=[start];let endpoint=null;
   search:for(let cursor=0;cursor<queue.length;cursor++){
    const entry=queue[cursor];
    for(const row of entry.choices){
     const owner=owners.get(row.domain);
     if(!owner){endpoint={entry,row};break search;}
     if(!parents.has(owner)){parents.set(owner,{entry,row});queue.push(owner);}
    }
   }
   if(!endpoint){failures.set(start,{reason:start.eligibleOrigins?'insufficient_candidates':'no_candidates',eligibleOrigins:start.eligibleOrigins});continue;}
   let {entry,row}=endpoint;
   for(;;){
    selected.set(entry,row.candidate);owners.set(row.domain,entry);
    const parent=parents.get(entry);if(!parent)break;
    ({entry,row}=parent);
   }
  }
 }
 const assignments=[],unassigned=[];
 for(const entry of entries){
  if(selected.has(entry))assignments.push({id:entry.id,candidate:selected.get(entry)});
  else unassigned.push({id:entry.id,...failures.get(entry)});
 }
 return {assignments,unassigned};
}
