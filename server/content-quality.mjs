// Deterministic review gate for generated copy. This is conservative evidence matching,
// not a claim that arbitrary prose is factually proven. Supplied facts remain user data.
const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const offerPath=/^(?:cards|moreCards)\.\d+\.(?:name|bonus|rating|note|features|payout|payoutNote)$/;
const categories={
 bonus:/bonus|bonuses|free spins?|welcome (?:offer|package)|бонус|фріспін|безкоштовн.{0,12}обертан|bonusu?|premi[ae]/iu,
 payout:/payout|withdraw|payment|виплат|виведен|плат[еі]ж|wypłat|wypłac|płatno/iu,
 licence:/licen[cs]|regulat|legal status|ліценз|регулю|легаль|licenc|legaln/iu,
 rating:/\b(?:ratings?|rated|scores?|stars?)\b|рейтинг|оцінк|зірок|ocen/iu,
 guarantee:/guarantee|guaranteed|risk.free|win probability|winning chance|гарант|без ризик|ймовірніст.{0,10}виграш|gwarant/iu,
 experience:/(?:we|our (?:team|experts?))\s+(?:have\s+)?(?:tested|verified|reviewed)|ми\s+(?:перевірили|тестували)|наші експерти/iu,
 methods:/\b(?:visa|mastercard|paypal|skrill|neteller|bitcoin|ethereum|apple pay|google pay)\b/iu
};
// Detect declarations, not category words or a verb anywhere in a sentence.
// A question/checklist cell or a subordinate "check how X is ..." is not
// evidence that X has the property. Independent claims after "and" still count.
const declaration=/(?:^|[:;,|]|\b(?:and|but|however|while)\s+)([\p{L}\p{N}_'’ -]{1,100}?)\s+(?:is|are|was|were|has|have|founded|established|operates|serves|supports|holds|provides|offers|accepts|guarantees|awards|earns|receives|пропонує|має|гарантує|приймає|підтримує|ліцензован\p{L}*|oferuje)(?![\p{L}\p{N}_])/giu;
const genericSubject=/^(?:(?:a|an|the|your|any|each|all|some|many|most|valid|clear|published|current|these|those|reputable|reliable|good|online|available|different|specific|detailed|important|other)\s+)*(?:some|many|most|all|any|each|parameters|transparency|reliable|these|those|licen[cs]es?|licensing|bonus|bonuses|a bonus|terms|conditions|payments?|payment methods|withdrawals?|wagering requirements?|support(?: availability(?: and quality)?)?|customer support|support services|security measures|privacy|information|details|user reviews|reviews|ratings|fees|costs|pricing|policies|regulations|options|tools|services|features|websites|casinos|providers|operators|this information|this guide|this page|this resource|it|they|we|you)$/iu;
function declaresProperty(clause,subjects,editorialSubjects=[],offerContext=false,protectedContext=false){
 const value=clause.trim();
 // An interrogative must encompass the whole clause. Inspect table cells
 // separately so a question in one cell cannot conceal a claim in another.
 if(/^(?:is|are|was|were|has|have|does|do|can|could|should|will|would|what|which|who|where|when|why|how|чи|як|що|де|коли)\b/iu.test(value)&&/\?$/.test(value)&&!/:|\b(?:but|however|and)\b.*\b(?:is|has|offers|guarantees)\b/iu.test(value))return false;
 for(const part of value.split(/\b(?:and|but|however|while)\s+/iu)){
 for(const match of part.matchAll(declaration)){
  const actor=match[1].trim(),normalized=normalize(actor);
  if(!part.slice(match.index+match[0].length).trim())continue;
  if(/^it is (?:important|essential|helpful|useful|advisable|possible|crucial|necessary)\b/iu.test(actor+match[0].slice(match[0].indexOf(actor)+actor.length)+part.slice(match.index+match[0].length)))continue;
  if(subjects.some(subject=>normalized===normalize(subject)))return true;
  if(editorialSubjects.some(subject=>normalized===normalize(subject)))continue;
  if(/^(?:this site|this page|this guide)$/iu.test(actor)&&/provides?\s+(?:(?:general|informational|neutral|practical|educational)\s+)?(?:guidance|information|advice)\b/iu.test(part))continue;
  if(/^(?:this|that|our|the)\s+(?:casino|operator|service|site|website|platform|provider|company|product)\b/iu.test(actor))return true;
  if(/^(?:it|they|we|this|он|она|вони|ми)$/iu.test(actor)){if(offerContext||protectedContext&&/\b(?:licensed|regulated|certified|accepts|guarantees|offers|has|holds)\b/iu.test(part))return true;continue;}
  // Headings, gerunds and instructions do not identify a provider.
  if(genericSubject.test(actor)||/^(?:avoid|ensure|see|assess|verify|check|read|compare|review|confirm|visit|explore|evaluate|analy[sz]e|consider|understand|learn|knowing|reviewing|checking|understanding|verifying|using|choosing|looking|before|after|if|when|whether)\b/iu.test(actor))continue;
  if(/^[\p{Lu}\p{N}][\p{L}\p{N}_'’-]*(?:\s+[\p{Lu}\p{N}][\p{L}\p{N}_'’-]*)*$/u.test(actor)&&(protectedContext||/\b(?:founded|established|has|holds)\b/iu.test(match[0])||/\b(?:offers|supports|accepts)\s+(?:a|an|the|free|secure|instant|games|bonuses|bonus|visa|mastercard|paypal|\d+)\b/iu.test(part)))return true;
 }
 }
 // Elliptical promotional assertions have no explicit grammatical subject.
 return /^(?:licensed|regulated|guaranteed|certified|verified|risk.free|ліцензован\p{L}*|гарантован\p{L}*)(?![\p{L}\p{N}_])/iu.test(value);
}
const numeric=/(?:[$€£₴]\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:%|EUR|USD|GBP|UAH|PLN|CAD|AUD|USDT|BTC|євро|грн|долар\p{L}*|zł|hours?|days?|minutes?|seconds?|годин\p{L}*|дн(?:ів|і)|хвилин\p{L}*|spins?|обертан\p{L}*|stars?|\/\s*(?:5|10)))|(?<![\p{L}\p{N}_])\d+(?:[.,]\d+)?(?![\p{L}\p{N}_])/giu;
function numbers(value){const text=String(value);return [...text.matchAll(numeric)].filter(match=>!(/^20\d{2}$/.test(match[0])&&/\b(?:in|for|during|through|since|year)\s+$/iu.test(text.slice(0,match.index)))).map(match=>normalize(match[0]));}
function clean(value){return String(value||'').replace(/\[\[PP_LINK:[a-zA-Z0-9_-]+\]\]/g,' ').replace(/https?:\/\/[^\s<>"']+/gi,' ').replace(/(^|\n)\s*\d+[.)]\s+/g,'$1').replace(/\*\*|^##\s+/gm,'');}
function kinds(value){return Object.keys(categories).filter(key=>categories[key].test(value));}
function factKinds(fact){const result=kinds(fact.value),field=fact.fieldPath.split('.').pop();if(field==='bonus')result.push('bonus');if(field==='payout'||field==='payoutNote')result.push('payout');if(field==='rating')result.push('rating');return [...new Set(result)];}
function mentionsSubject(value,subject){
 const name=normalize(subject);if(!name)return false;
 let offset=value.indexOf(name);
 while(offset!==-1){const before=value.slice(0,offset),after=value.slice(offset+name.length);if(!/[\p{L}\p{N}_]$/u.test(before)&&! /^[\p{L}\p{N}_]/u.test(after))return true;offset=value.indexOf(name,offset+name.length);}
 return false;
}
// A numerical illustration of game rules is not an operator offer. This narrow
// exception is enabled only by the trusted editorial planner, never by free copy.
function educationalQuantity(clause,target,input,subjects,claimKinds,monetary,declarationPresent){
 if(input.brief?.editorial!==true||!/^sections\.\d+\.body$/.test(target.fieldPath||'')||monetary||declarationPresent)return false;
 if(claimKinds.some(kind=>!['payout','rating'].includes(kind)))return false;
 if(subjects.some(subject=>mentionsSubject(normalize(clause),subject)))return false;
 if(/\b(?:this|that|our)\s+(?:casino|site|operator|platform)\b/iu.test(clause))return false;
 const example=/\b(?:for example|for instance|hypothetical|imagine|suppose)\b/iu.test(clause)&&/\b(?:reels?|paylines?|symbols?|goals?|odds)\b/iu.test(clause);
 const market=/\b(?:over|under)\s+\d+(?:\.\d+)?\s+goals\b/iu.test(clause)&&/\bmarket\b/iu.test(clause);
 return example||market;
}
function fieldSubject(target,facts){const row=target.fieldPath?.replace(/\.[^.]+$/,'');return facts.find(f=>f.fieldPath.replace(/\.[^.]+$/,'')===row)?.subject||'';}
export function normalizeFacts(value){
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>1000)throw new Error('Некоректний список наданих фактів.');
 const seen=new Set();let total=0;
 return value.map(fact=>{
  if(!object(fact)||Object.keys(fact).some(key=>!['id','fieldPath','subject','value'].includes(key))||typeof fact.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(fact.id)||seen.has(fact.id)||typeof fact.fieldPath!=='string'||!offerPath.test(fact.fieldPath)||typeof fact.subject!=='string'||fact.subject.length>300||typeof fact.value!=='string'||!fact.value.trim()||fact.value.length>4000)throw new Error('Некоректний факт або його прив’язка до пропозиції.');
  seen.add(fact.id);total+=fact.value.length+fact.subject.length;if(total>48000)throw new Error('Надані факти перевищують ліміт.');
  return {id:fact.id,fieldPath:fact.fieldPath,subject:fact.subject,value:fact.value};
 });
}
export function resolveFactReferences(value,facts){
 const byId=new Map(facts.map(f=>[f.id,f]));let invalid=false;
 const resolved=value.replace(/\[\[PP_FACT:([a-zA-Z0-9_-]+)\]\]/g,(token,id)=>{const fact=byId.get(id);if(!fact){invalid=true;return token;}return fact.value;});
 return {value:resolved,invalid:invalid||/\[\[PP_FACT:/i.test(resolved)};
}
export function inspectContentQuality(input,updates){
 const facts=input.brief?.facts||[],byId=new Map(input.targets.map(t=>[t.targetId,t])),issues=[];
 function issue(target,code,detail){issues.push({code,targetId:target.targetId,...(target.fieldPath?{fieldPath:target.fieldPath}:{}),detail});}
 for(const update of updates){
  const target=byId.get(update.targetId);if(!target||typeof update.value!=='string'||!update.value.trim()||update.value===target.currentValue)continue;
  if((offerPath.test(target.fieldPath||'')||/^(?:cards|moreCards)\.(?:name|bonus|note|features|payout|payoutNote)$/.test(target.field))&&target.currentValue?.trim()){
   issue(target,'MANUAL_FACT_CHANGED','Наданий вручну факт пропозиції треба зберегти дослівно.');continue;
  }
  const before=normalize(clean(target.currentValue)),subject=fieldSubject(target,facts);
  const clauses=clean(update.value).split(/(?<=[.!?;])\s+|\n+|\|/u);
  for(const clause of clauses){
   const normalized=normalize(clause);if(!normalized||before.includes(normalized))continue;
   const claimKinds=kinds(clause),quantities=numbers(clause),field=target.field.split('.').pop();
   if(/^(?:cards|moreCards)\./.test(target.field)&&['bonus','payout','payoutNote'].includes(field)&&quantities.length){const kind=field==='bonus'?'bonus':'payout';if(!claimKinds.includes(kind))claimKinds.push(kind);}
   const monetary=/(?:[$€£₴%]|\b(?:EUR|USD|GBP|UAH|PLN|CAD|AUD|USDT|BTC)\b|євро|грн|долар|zł)/iu.test(clause);
   const named=[...new Set(facts.map(f=>f.subject).filter(Boolean))].filter(name=>mentionsSubject(normalized,name));
   const subjects=[...facts.map(f=>f.subject),...(input.brief?.claimSubjects||[])].filter(Boolean);
   const declarationPresent=declaresProperty(clause,subjects,claimKinds.length||monetary?[]:input.brief?.editorialSubjects||[],offerPath.test(target.fieldPath||''),Boolean(claimKinds.length));
   if(quantities.length&&educationalQuantity(clause,target,input,subjects,claimKinds,monetary,declarationPresent))continue;
   if(!quantities.length&&!declarationPresent&&!claimKinds.includes('experience'))continue;
   if(!claimKinds.length&&!monetary){
    if(declarationPresent&&!facts.some(f=>f.fieldPath.split('.').pop()!=='name'&&(!named.length?f.subject===subject:named.includes(f.subject))&&normalized.includes(normalize(f.value))))issue(target,'UNSUPPORTED_OFFER_CLAIM','Твердження про конкретну пропозицію потребує підтвердження наданими фактами.');
    continue;
   }
   const candidates=facts.filter(f=>!named.length?!subject||f.subject===subject:named.includes(f.subject));
   const applicable=candidates.filter(f=>claimKinds.length?claimKinds.some(kind=>factKinds(f).includes(kind)):numbers(f.value).length);
   const unsupportedNumber=quantities.some(number=>!applicable.some(f=>numbers(f.value).includes(number)));
   const ambiguous=quantities.length&&(named.length>1||claimKinds.length>1||(!named.length&&!subject&&new Set(applicable.map(f=>f.subject).filter(Boolean)).size>1));
   const unsupportedKind=claimKinds.some(kind=>{
    const supporting=applicable.filter(f=>factKinds(f).includes(kind));
    if(['licence','guarantee','experience','methods'].includes(kind))return !supporting.some(f=>normalized.includes(normalize(f.value)));
    return !quantities.length&&declarationPresent&&!supporting.some(f=>normalized.includes(normalize(f.value)));
   });
   if(unsupportedNumber||unsupportedKind||ambiguous)issue(target,'UNSUPPORTED_OFFER_CLAIM','Твердження про пропозицію не має однозначного підтвердження у наданих фактах; потрібна перевірка.');
  }
 }
 return {state:issues.length?'review_required':'passed',issues};
}
// Only generated changes contribute; manual repetition and design never count as duplicates.
export function generatedTextParts(input,updates){
 const byId=new Map(input.targets.map(t=>[t.targetId,t]));
 return updates.flatMap(update=>{const target=byId.get(update.targetId);if(!target||!update.value?.trim()||update.value===target.currentValue)return [];const links=new Map((target.allowedLinks||[]).map(link=>[link.id,link.anchor]));const text=update.value.replace(/\[\[PP_LINK:([a-zA-Z0-9_-]+)\]\]/g,(_,id)=>links.get(id)||'').replace(/\r\n?/g,'\n').replace(/\s+/g,' ').trim();return [{fieldPath:target.fieldPath||target.field,text}];});
}
