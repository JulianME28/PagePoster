import {JSDOM,VirtualConsole} from './dom-runtime.mjs';

// These are deliberate filename conventions, not a guess from arbitrary words
// or a language-to-country conversion. UK is not a country prefix here: GB is.
const COUNTRY_LANGUAGES=Object.freeze({
 AR:'es',AT:'de',AU:'en',BE:'nl',BG:'bg',BR:'pt',CA:'en',CH:'de',CL:'es',CN:'zh',CO:'es',CZ:'cs',
 DE:'de',DK:'da',EE:'et',ES:'es',FI:'fi',FR:'fr',GB:'en',GR:'el',HK:'zh',HR:'hr',HU:'hu',ID:'id',
 IE:'en',IL:'he',IN:'en',IS:'is',IT:'it',JP:'ja',KR:'ko',LT:'lt',LV:'lv',MT:'en',MX:'es',MY:'ms',
 NG:'en',NL:'nl',NO:'no',NZ:'en',PE:'es',PH:'en',PK:'ur',PL:'pl',PT:'pt',RO:'ro',RS:'sr',RU:'ru',
 SE:'sv',SG:'en',SI:'sl',SK:'sk',TH:'th',TR:'tr',TW:'zh',UA:'uk',US:'en',UY:'es',VN:'vi',ZA:'en'
});
const FILENAME_LANGUAGES=new Set([...Object.values(COUNTRY_LANGUAGES),'ar','fil','hi','nb','nn','ta']);

/** Ready HTML carries language metadata only; it does not use AI's language list. */
export function normalizeHtmlLanguage(value){
 if(typeof value!=='string'||value.length>35||/[\u0000-\u001f\u007f]/.test(value))return '';
 const language=value.trim().toLowerCase();
 // Common ISO/BCP47 language, script, region and variant tags. Singletons,
 // private-use extensions and unbounded subtag chains are intentionally absent.
 if(!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/.test(language))return '';
 try{Intl.getCanonicalLocales(language);}catch{return '';}
 return language;
}

function rootLanguage(html){
 let dom;
 try{
  // No scripts or remote resources are enabled. Source locations distinguish a
  // real root attribute from parser-created roots or a later <html> in the body.
  dom=new JSDOM(html.replace(/^\uFEFF/,''),{includeNodeLocations:true,virtualConsole:new VirtualConsole()});
  const root=dom.window.document.documentElement,location=dom.nodeLocation(root);
  if(!location?.startTag?.attrs?.lang)return '';
  return normalizeHtmlLanguage(root.getAttribute('lang'));
 }catch{return '';}
 finally{dom?.window.close();}
}

export function detectImportFileRegions(name,html){
 const stem=name.replace(/\.html?$/i,'').toLowerCase();
 let geo='',language='';
 const locale=/^([a-z]{2,3})[-_]([a-z]{2})(?=[-_. ]|$)/.exec(stem);
 if(locale&&FILENAME_LANGUAGES.has(locale[1])&&Object.hasOwn(COUNTRY_LANGUAGES,locale[2].toUpperCase())){
  geo=locale[2].toUpperCase();language=locale[1]+'-'+locale[2];
 }else{
  const prefix=/^([a-z]{2})(?=[-_. ]|$)/.exec(stem)?.[1].toUpperCase();
  if(prefix&&Object.hasOwn(COUNTRY_LANGUAGES,prefix)){geo=prefix;language=COUNTRY_LANGUAGES[prefix];}
 }
 return {geo,language:rootLanguage(html)||language};
}
