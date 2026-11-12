import {createHash} from 'node:crypto';
import {rendererWindow} from './render.mjs';

const LIMIT=500000;
const fail=(code='CUSTOMER_HTML_INVALID',warnings=[])=>{
 throw Object.assign(Error(code==='CUSTOMER_HTML_TOO_LARGE'?'HTML перевищує ліміт 500 000 байтів.':'Не вдалося підготувати HTML клієнта.'),{code,error:true,warnings});
};
function optionalUrl(value){
 if(value===undefined||value==='')return '';
 if(typeof value!=='string'||value.length>4000||value!==value.trim()||/[\u0000-\u0020\u007f]/.test(value))fail();
 let url;try{url=new URL(value);}catch{fail();}
 if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)fail();
 return value;
}
function sourceWarnings(document){
 const warnings=[],ids=new Set();let renamed=false,layoutChanged=false;
 for(const element of document.querySelectorAll('[id]')){
  const id=element.getAttribute('id');
  if(id&&(id.startsWith('pp-')||ids.has(id)))renamed=true;
  if(id)ids.add(id);
 }
 if(renamed)warnings.push('Зарезервовані або повторні ID буде перейменовано; перевірте посилання на розділи у перегляді.');
 // The existing importer normalizes these declarations without reporting a removal.
 // Report that visual change before the caller decides whether to publish.
 const css=[...document.querySelectorAll('style')].map(node=>[node.textContent,'stylesheet'])
  .concat([...document.querySelectorAll('[style]')].map(node=>[node.getAttribute('style'),'declarationList']));
 for(const [text,context] of css){
  try{
   const tree=rendererWindow.csstree.parse(text,{context,parseCustomProperty:true});
   rendererWindow.csstree.walk(tree,{visit:'Declaration',enter(node){
    const property=rendererWindow.csstree.ident.decode(node.property).toLowerCase();
    const value=rendererWindow.csstree.generate(node.value);
    if(property==='position'&&/^(fixed|sticky)$/i.test(value))layoutChanged=true;
   }});
  }catch{} // The importer supplies its own bounded parse/removal warnings.
 }
 if(layoutChanged)warnings.push('Позиції fixed/sticky у вихідному HTML будуть обмежені контейнером; перевірте розташування елементів.');
 return warnings;
}
/** Prepare a customer document without calling AI or editing its stored source.
 * The caller must review warnings and bind approval to this exact source/options
 * and its rendered result before automatic publication. */
export function prepareCustomerHtml(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['html','baseUrl','brand','brandUrl','chromeMode'].includes(key)))fail();
 const {html,chromeMode}=input;
 if(typeof html!=='string'||!html.trim()||!['overlay-only','custom'].includes(chromeMode))fail();
 const sourceBytes=Buffer.byteLength(html,'utf8');
 if(sourceBytes>LIMIT)fail('CUSTOMER_HTML_TOO_LARGE');
 if(input.brand!==undefined&&(typeof input.brand!=='string'||input.brand.length>200||/[\u0000-\u001f\u007f]/.test(input.brand)))fail();
 const baseUrl=optionalUrl(input.baseUrl),brandUrl=optionalUrl(input.brandUrl);
 // Clear every demo field explicitly: normalization must not add example content.
 const clean=Object.fromEntries(Object.entries(rendererWindow.PagePoster.DEFAULT_DATA).filter(([,value])=>typeof value==='string').map(([key])=>[key,'']));
 const draft={...clean,contentMode:'html',importHtml:html,importBaseUrl:baseUrl,
  importChrome:chromeMode==='custom'?'add':'none',importReplaceHeader:false,importReplaceFooter:false,
  mode:'fullscreen',cards:[],moreCards:[],sections:[],faq:[],tiles:[],services:[],reviews:[],navLinks:[],showToc:false};
 const analysis=rendererWindow.PagePoster.analyzeHTML(draft);
 if(analysis.error)fail('CUSTOMER_HTML_INVALID',analysis.warnings||[]);
 // DOMParser is inert: there are no source script evaluations or resource fetches.
 const document=new rendererWindow.DOMParser().parseFromString(html,'text/html');
 const warnings=[...new Set([...(analysis.warnings||[]),...sourceWarnings(document)])];
 const title=(analysis.title||analysis.headings?.find(heading=>heading.text)?.text||'Страница клиента').slice(0,500);
 if(!analysis.title)warnings.push('Заголовок сторінки визначено автоматично; перевірте його перед публікацією.');
 const siteName=document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')||'';
 const brand=input.brand?.trim()||siteName.trim().replace(/\s+/g,' ').slice(0,200)||title.slice(0,200);
 const language=rendererWindow.PagePoster.languageTag(analysis.lang||'uk');
 const config=rendererWindow.PagePoster.normalizeConfig({...draft,title,brand,language,
  brandUrl:brandUrl||analysis.firstLink||'',footerBrandUrl:brandUrl||analysis.firstLink||'',
  footerTitle:title.slice(0,300),footerLinksTitle:({pl:'Rozdziały',uk:'Розділи',ru:'Разделы'})[language.split('-')[0]]||'Sections'});
 // Normalization has only a character limit; the byte check above ensures no truncation.
 if(config.importHtml!==html)fail();
 return{config:JSON.parse(JSON.stringify(config)),title,brand,language,chromeMode,sourceBytes,
  sourceHash:createHash('sha256').update(html,'utf8').digest('hex'),warnings,error:false,
  requiresReview:warnings.length>0,state:warnings.length?'needs_review':'ready',
  analysis:{headings:analysis.headings||[],stats:analysis.stats||{},hasHeader:!!analysis.hasHeader,hasFooter:!!analysis.hasFooter}};
}

