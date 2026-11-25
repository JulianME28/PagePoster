import {donorDomainKey} from './donor-domain.mjs';

// Standard locale branches from the 2026-11-06 AUTOPICK summary (§6).
const locale=(label,countries)=>({label,countries:new Set(countries.split(' '))});
const english=locale('англомовна локаль','US GB CA AU NZ IE SG PH');
const spanish=locale('іспаномовна локаль','ES MX AR CL PE CO EC VE DO PY UY GT BO PA CR HN SV NI PR');
const portuguese=locale('португаломовна локаль','BR PT MZ AO');
const middleEast=locale('близькосхідна локаль','SA AE QA KW BH OM EG MA TN DZ IQ JO LB PS IR');
const nordic=locale('Скандинавія','SE NO DK FI IS');
const european=locale('Європа','FR DE IT NL PL RO CZ HU GR BG HR RS SK SI BA MK AL ME AT CH BE LU EE LT LV UA SE NO DK FI IS');
const cis=locale('СНД','RU BY MD KZ UZ TM GE AM AZ');
const turkic=locale('тюркська локаль','TR AZ KZ UZ TM');
const southAsian=locale('Індійський субконтинент','IN PK BD NP LK MV');
const malay=locale('малайська локаль','ID MY');
const african=locale('англомовна локаль Африки','ZA NG KE GH TZ UG ZW ZM RW BW NA ET LS MU');
const eastAsian=locale('східноазійська локаль','CN JP KR TW HK');
const branches=[european,cis,turkic,spanish,portuguese,middleEast,southAsian,malay,african,english,eastAsian];

function permittedLocales(code){
 if(nordic.countries.has(code))return [nordic,european];
 if(['AZ','UZ','TM'].includes(code))return [turkic,cis];
 return branches.filter(group=>group.countries.has(code)).slice(0,1);
}

function countryCode(value){
 const code=String(value).trim().toUpperCase();
 return code==='UK'?'GB':code;
}

export function rankDonorRecommendations(candidates,{geo='',minDr=null,minTraffic=null}={},currentBaseUrl){
 const targets=geo.split(',').filter(Boolean).map(countryCode);
 const locales=targets.map(permittedLocales);
 const ranked=candidates.map((candidate,index)=>{
  const countries=candidate.geo.map(countryCode);
  const exact=targets.find(code=>countries.includes(code));
  const groups=locales.flatMap((branch,targetIndex)=>branch.map(({label,countries:members},stage)=>({
   label,stage,target:targets[targetIndex],country:countries.find(code=>members.has(code)),
  }))).sort((a,b)=>a.stage-b.stage);
  const match=exact?null:groups.find(group=>group.country);
  const group=exact?'exact':match?'locale':'other';
  let reason=exact?'Точний збіг GEO: '+exact+'.':match?match.target+' → '+match.label+' ('+match.country+').':
   !targets.length?'GEO сторінки не задано.':countries.length?'Інше GEO: '+countries.join(', ')+'.':'GEO донора невідоме.';
  const quality=[];
  if(minDr!==null&&(!Number.isFinite(candidate.dr)||candidate.dr<minDr))quality.push('нижче мінімуму DR або немає даних');
  if(minTraffic!==null&&(!Number.isSafeInteger(candidate.traffic)||candidate.traffic<minTraffic))quality.push('нижче мінімуму трафіку або немає даних');
  if(quality.length)reason+=' Поза рекомендаціями: '+quality.join(', ')+'.';
  return {candidate,index,eligible:!quality.length,group,reason,priority:exact?0:match?match.stage+1:3};
 });
 ranked.sort((a,b)=>Number(b.eligible)-Number(a.eligible)||a.priority-b.priority||
  Number(b.candidate.available)-Number(a.candidate.available)||(b.candidate.dr??-1)-(a.candidate.dr??-1)||
  (b.candidate.traffic??-1)-(a.candidate.traffic??-1)||(a.candidate.rowNumber??Infinity)-(b.candidate.rowNumber??Infinity)||a.index-b.index);

 const current=currentBaseUrl||candidates.find(candidate=>candidate.current)?.baseUrl;
 const roots=new Set(current?[donorDomainKey(current)]:[]);
 let primaryChosen=!!current,reserveRank=0;
 return ranked.map(({candidate,eligible,group,reason})=>{
  let primary=false,rank=null;
  const root=donorDomainKey(candidate.baseUrl);
  if(eligible&&candidate.available&&!roots.has(root)){
   roots.add(root);
   if(primaryChosen)rank=++reserveRank;
   else{primary=true;primaryChosen=true;}
  }
  return {...candidate,recommendation:{group,reason,primary,reserveRank:rank}};
 });
}
