// Aggregate only: callers keep candidate credentials private.
export function describeSiteSelection(candidates,{criteria={minDr:null,minTraffic:null,geo:''},usedOrigins=[],usedRowIds=[],unavailability={},inputDiagnostics,candidatePolicy}={}){
 if(candidatePolicy!==undefined&&typeof candidatePolicy!=='function')throw new TypeError('candidatePolicy must be a function.');
 const policyEnabled=typeof candidatePolicy==='function';
 const total=new Set(),geo=new Set(),dr=new Set(),eligible=new Set(),available=new Set(),used=new Set(usedOrigins.map(value=>new URL(value).origin)),ids=new Set(usedRowIds),countries=criteria.geo?criteria.geo.split(','):[],origins=new Map();
 const originSet=values=>new Set((Array.isArray(values)?values:[]).flatMap(value=>{try{return [new URL(value).origin];}catch{return [];}}));
 const published=originSet(unavailability?.publishedOrigins),reserved=originSet(unavailability?.reservedOrigins),excluded=originSet(unavailability?.excludedOrigins),reservedIds=new Set(unavailability?.reservedRowIds||[]),excludedIds=new Set(unavailability?.excludedRowIds||[]);
 for(const candidate of candidates){
  const origin=new URL(candidate.baseUrl).origin,metrics=candidate.metrics||{};total.add(origin);
  let observed=origins.get(origin);if(!observed){observed={dr:false,traffic:false,geo:false,eligibleIds:[],...(policyEnabled?{policyBlocked:false,policyTypes:new Set()}: {})};origins.set(origin,observed);}
  if(Number.isFinite(metrics.dr)&&metrics.dr>=0&&metrics.dr<=100)observed.dr=true;
  if(Number.isSafeInteger(metrics.traffic)&&metrics.traffic>=0)observed.traffic=true;
  if(Array.isArray(metrics.geo)&&metrics.geo.some(code=>typeof code==='string'&&/^[A-Z]{2}$/.test(code)))observed.geo=true;
  if(countries.length&&!countries.some(code=>metrics.geo?.includes(code)))continue;geo.add(origin);
  if(criteria.minDr!=null&&(!Number.isFinite(metrics.dr)||metrics.dr<criteria.minDr))continue;dr.add(origin);
  if(criteria.minTraffic!=null&&(!Number.isSafeInteger(metrics.traffic)||metrics.traffic<criteria.minTraffic))continue;eligible.add(origin);observed.eligibleIds.push(candidate.id);
  if(used.has(origin)||ids.has(candidate.id))continue;
  if(policyEnabled){
   // Ownership remains authoritative. Policy operates on exact eligible rows,
   // allowing an unfailed duplicate pair to keep its origin available.
   if(published.has(origin)||reserved.has(origin)||reservedIds.has(candidate.id))continue;
   const decision=candidatePolicy(candidate);
   if(decision?.blocked===true){
    observed.policyBlocked=true;
    const reasons=Array.isArray(decision.reasons)?decision.reasons:[];
    if(!reasons.length)observed.policyTypes.add('security');
    for(const reason of reasons){if(reason?.type==='current_run')continue;observed.policyTypes.add(({manual:'manual',transient:'temporary',auth:'credentials',visual:'visual',security:'security'})[reason?.type]||'security');}
    continue;
   }
  }
  available.add(origin);
 }
 const unknown={unit:'origins',dr:0,traffic:0,geo:0},unavailable={unit:'origins',published:0,reserved:0,excluded:0,other:0,...(policyEnabled?{manual:0,temporary:0,credentials:0,visual:0,security:0}:{})};
 for(const [origin,observed]of origins){
  for(const key of ['dr','traffic','geo'])if(!observed[key])unknown[key]++;
  if(!eligible.has(origin)||available.has(origin))continue;
  const reason=published.has(origin)?'published':reserved.has(origin)||observed.eligibleIds.some(id=>reservedIds.has(id))?'reserved':observed.policyBlocked||excluded.has(origin)||observed.eligibleIds.some(id=>excludedIds.has(id))?'excluded':'other';unavailable[reason]++;
  if(policyEnabled&&reason==='excluded'&&observed.policyBlocked)for(const type of observed.policyTypes)unavailable[type]++;
 }
 const input=inputDiagnostics&&typeof inputDiagnostics==='object'?{unit:'rows',...Object.fromEntries(['nonempty','disabled','invalidUrl','invalidRow','missingCredentials'].map(key=>[key,Number.isSafeInteger(inputDiagnostics[key])&&inputDiagnostics[key]>=0?inputDiagnostics[key]:0]))}:null;
 return {criteria:{minDr:criteria.minDr??null,minTraffic:criteria.minTraffic??null,geo:criteria.geo||''},total:total.size,geo:geo.size,dr:dr.size,eligible:eligible.size,reserved:eligible.size-available.size,available:available.size,...(input?{input}:{}),unknown,unavailable};
}
