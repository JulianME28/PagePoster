import AI from '../../dist/ai-core.js';
import Designs from '../../dist/design-variants.js';
import {prepareConfig} from './workflow.mjs';
import {renderPage} from './render.mjs';
import {prepareGeneration} from './generation.mjs';
const fail=(code='VALIDATION')=>{throw Object.assign(Error(code),{code});};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const object=(value,keys)=>{if(!plain(value)||Object.keys(value).some(k=>!keys.includes(k)))fail();return value;};
const string=(value,max,empty=false)=>{if(typeof value!=='string'||value.length>max||(!empty&&!value.trim()))fail();return value.trim();};
const sameColors=(left,right)=>['background','accent','header','card'].every(key=>typeof left?.[key]==='string'&&typeof right?.[key]==='string'&&left[key].toLowerCase()===right[key].toLowerCase());
const eligible=path=>!/^(?:cards|moreCards)\.\d+\.(?:name|bonus|features|note|payout|payoutNote)$/.test(path);

/** Resolve a single immutable launch into complete page inputs; performs no network or writes. */
export function prepareCampaign(input,{store,env={},projectId}={}){
 object(input,['idempotencyKey','name','topics','siteIds','status','config','mode','paths','brief','linkInsertions','varyDesign']);
 const project=store.getProject(projectId);if(!project)fail('NOT_FOUND');
 if(typeof input.idempotencyKey!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.idempotencyKey))fail();
 if(!Array.isArray(input.topics)||!input.topics.length||input.topics.length>20)fail();
 const topics=input.topics.map(t=>string(t,500));
 if(!Array.isArray(input.siteIds)||input.siteIds.length>20||new Set(input.siteIds).size!==input.siteIds.length)fail();
 if(!['review','draft','publish'].includes(input.status)||!['empty','selected','manual'].includes(input.mode))fail();
 if(input.varyDesign!==undefined&&typeof input.varyDesign!=='boolean')fail();
 if(input.status!=='review'&&!input.siteIds.length)fail();
 const siteIds=input.siteIds.length?input.siteIds:[null];
 if(topics.length*siteIds.length>20)fail('CAPACITY_EXCEEDED');
 for(const id of siteIds){if(id===null)continue;string(id,100);const site=store.getSite(id);if(!site||!store.siteBelongsToProject(projectId,id))fail('NOT_FOUND');if(site.enabled===false)fail('disabled');if(input.status!=='review'){if(!site.hasCredential)fail('auth_failed');if(!['ok','ready'].includes(site.status))fail('SITE_NOT_READY');}}
 if(!plain(input.config)||typeof input.config.title!=='string'||!['cards','sections','faq'].every(k=>Array.isArray(input.config[k])))fail();
 if(Buffer.byteLength(JSON.stringify(input.config))>2*1024*1024)fail();
 if(input.config.contentMode==='html'&&input.mode!=='manual')fail('GENERATION_HTML_UNSUPPORTED');
 const base=prepareConfig(input.config);
 const fields=AI.listGroups(base).flatMap(g=>g.fields),allowed=new Map(fields.filter(f=>eligible(f.path)).map(f=>[f.path,f]));
 const requested=input.paths===undefined?[]:input.paths;
 if(!Array.isArray(requested)||requested.length>2000||new Set(requested).size!==requested.length||requested.some(p=>!allowed.has(p)))fail();
 const paths=input.mode==='manual'?[]:input.mode==='selected'?requested:fields.filter(f=>eligible(f.path)&&!f.currentValue.trim()).map(f=>f.path);
 const brief=object(input.brief||{},['language','country','instructions']);
 const language=string(brief.language||project.language||'English',100),country=string(brief.country||project.country||'',100,true),instructions=string(brief.instructions||'',6000,true);
 const linkInsertions=input.linkInsertions===undefined?[]:input.linkInsertions;
 if(!Array.isArray(linkInsertions)||linkInsertions.length>100||input.mode==='manual'&&linkInsertions.length)fail();
 if(paths.length&&!env.OPENAI_API_KEY?.trim())fail('not_configured');
 const varyBuilder=input.varyDesign!==false&&base.contentMode==='builder';
 // Store order is insertion order; imported markup does not define a builder palette.
 let previousColors=varyBuilder?store.listPages(projectId).findLast(page=>page.config&&!['html','exact-import'].includes(page.config.contentMode))?.config.colors:null;
 let sequence=0,designSequence=0;const entries=[];
 for(const topic of topics)for(const siteId of siteIds){
  let config=JSON.parse(JSON.stringify(base));
  config.title=topic;config.keyword=topic;
  if(varyBuilder){
   let variant;
   for(let attempt=0;attempt<32;attempt++,designSequence++){
    variant=Designs.select(input.idempotencyKey,designSequence);
    if(!sameColors(variant.colors,previousColors))break;
   }
   if(sameColors(variant.colors,previousColors))fail('DESIGN_VARIATION_UNAVAILABLE');
   config=Designs.apply(config,{seed:input.idempotencyKey,sequence:designSequence++}).nextConfig;
   previousColors=config.colors;
  }
  const pageBrief={topic,language,country,instructions,context:['Write a complete, useful page with substantive sections and FAQ. Use only supplied offer facts; never invent bonuses, ratings, licenses, payout times or testimonials. Do not browse destination URLs: they are link destinations only.','Create independently worded explanations for page variation '+(++sequence)+'. Keep the supplied topic and exact required link tokens.'].filter(Boolean).join('\n')};
  // The saved run uses explicit selected paths: empty-only choices have already been frozen above.
  const spec=prepareGeneration(config,{paths,brief:pageBrief,linkInsertions,mode:paths.length?'selected':'manual',model:env.OPENAI_MODEL||'gpt-5.4-mini'});
  const rendered=renderPage(config);
  entries.push({page:{title:topic,keyword:topic,siteId,config:rendered.config,expectedUrls:rendered.expectedUrls,expectedMarker:'pp-landing'},launch:{status:input.status,siteId,paths:spec.paths,brief:pageBrief,linkInsertions}});
 }
 return {name:input.name?string(input.name,300):topics[0],status:input.status,entries};
}
