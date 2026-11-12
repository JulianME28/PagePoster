(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(null);else root.PagePosterLinkPlacements=factory(root);})(typeof window!=='undefined'?window:globalThis,function(defaultWindow){
  'use strict';
  var GROUPS=['cards','moreCards','tiles','services','reviews','sections','faq','navLinks'];
  var BODY_FIELDS={'cards.bonus':10000,'moreCards.bonus':10000,promoBody:10000,'sections.body':50000,'tiles.body':10000,'services.body':10000,'reviews.body':20000,'faq.answer':20000};
  function fail(message){throw Error(message);}
  function clone(value){return JSON.parse(JSON.stringify(value));}
  function own(value,key){return Object.prototype.hasOwnProperty.call(value,key);}
  function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(function(key){return JSON.stringify(key)+':'+canonical(value[key]);}).join(',')+'}';return JSON.stringify(value);}
  function validUrl(value){if(typeof value!=='string'||value.length>4000||/[\u0000-\u0020\u007f]/.test(value))return false;try{var u=new URL(value);return /^https?:$/.test(u.protocol)&&!!u.hostname&&!u.username&&!u.password;}catch(_){return false;}}
  function ensureUrl(value){if(!validUrl(value))fail('Потрібна повна безпечна HTTP(S) URL-адреса без змін параметрів.');return value;}
  function hash(value){var h=2166136261;for(var i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(36);}
  function escape(value){return String(value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function ensureConfig(config){if(!config||typeof config!=='object'||Array.isArray(config))fail('Потрібна конфігурація сторінки.');}
  function read(config,path){return path.split('.').reduce(function(obj,key){return obj&&own(obj,key)?obj[key]:undefined;},config);}
  function write(config,path,value){var parts=path.split('.'),last=parts.pop(),object=config;parts.forEach(function(key){if(!object||!own(object,key))fail('Конфлікт: поле змінилося.');object=object[key];});object[last]=value;}
  function rowKey(row,group,index){return row&&typeof row._ppRowId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(row._ppRowId)?row._ppRowId:'unprepared-'+group+'-'+index+'-'+hash(canonical(row));}
  function firstOffer(config){var rows=(config.cards||[]).concat(config.moreCards||[]);for(var i=0;i<rows.length;i++)if(validUrl(rows[i].url))return rows[i].url;return '';}
  function brandUrl(config){return config.brandUrl?config.brandUrl:firstOffer(config);}
  function hasChrome(config){return config.contentMode==='html'?config.importChrome!=='none':config.chromeMode!=='overlay-only';}
  function markdownLabelEnd(text,start){var depth=1,index=start+1;for(;index<text.length;index++){if(text[index]==='[')depth++;else if(text[index]===']'&&!--depth)return index;}return -1;}
  function markdownLinks(text){
    var result=[],cursor=0;
    while(cursor<text.length){if(text[cursor]!=='['){cursor++;continue;}var labelEnd=markdownLabelEnd(text,cursor);if(labelEnd<0||text[labelEnd+1]!=='('){cursor++;continue;}var end=labelEnd+2,depth=1;while(end<text.length&&depth){if(text[end]==='(')depth++;else if(text[end]===')')depth--;if(depth)end++;}if(depth){cursor++;continue;}var url=text.slice(labelEnd+2,end).trim();if(validUrl(url))result.push({start:cursor,end:end+1,labelStart:cursor+1,labelEnd:labelEnd,urlStart:labelEnd+2,urlEnd:end,url:url,anchor:text.slice(cursor+1,labelEnd)});cursor=end+1;}
    return result;
  }
  function fieldRows(config){var result=[];if(typeof config.promoBody==='string')result.push({path:'promoBody',key:'promoBody',value:config.promoBody,label:'Промотекст'});[['sections','body'],['tiles','body'],['services','body'],['reviews','body'],['faq','answer']].forEach(function(pair){(config[pair[0]]||[]).forEach(function(row,index){if(typeof row[pair[1]]==='string')result.push({path:pair[0]+'.'+index+'.'+pair[1],key:rowKey(row,pair[0],index)+':'+pair[1],value:row[pair[1]],label:row.title||row.name||row.question||pair[0]+' '+(index+1)});});});return result;}
  function create(options){
    var window=options&&options.window||defaultWindow;
    function parse(source){if(!window||typeof window.DOMParser!=='function')fail('Для HTML-місць потрібен DOM-адаптер create({window}).');if(typeof source!=='string'||source.length>500001)fail('HTML перевищує дозволений розмір.');return new window.DOMParser().parseFromString(source,'text/html');}
    function serialize(document,source){var doctype=/^\s*<!doctype\b[^>]*>/i.exec(source);return (doctype?doctype[0].trim()+'\n':'')+document.documentElement.outerHTML;}
    function navigation(node){
      if(node.closest('form,fieldset[disabled]')||node.hasAttribute('disabled'))return null;
      var href=node.getAttribute('href'),handler=node.getAttribute('onclick');
      if(handler){
        if(validUrl(href))return null;
        var match=handler.match(/^\s*(?:return\s+)?(?:window\.)?open\(\s*(['"])(https?:\/\/[^'"\\\s]+)\1\s*(?:,\s*(['"])(_blank|_self)\3\s*(?:,\s*(['"])(?:noopener(?:,noreferrer)?|noreferrer(?:,noopener)?)\5\s*)?)?\)\s*;?\s*$/i);
        return match&&validUrl(match[2])?{url:match[2],attribute:'onclick',target:match[4]||'_blank',returns:/^\s*return\b/.test(handler)}:null;
      }
      return node.tagName==='A'&&validUrl(href)?{url:href,attribute:'href'}:null;
    }
    function htmlNodes(document){return Array.from(document.querySelectorAll('a[href],button[onclick],div[onclick],span[onclick],a[onclick]')).filter(function(node){return !!navigation(node);});}
    function imported(config){
      var document=parse(config.importHtml||'');
      return htmlNodes(document).map(function(node,index){var id=node.getAttribute('data-pp-placement-id')||'unprepared-html-'+index+'-'+hash(node.outerHTML);var role=node.closest('header')?'brand-header':node.closest('footer')?'brand-footer':node.querySelector('img')||/(?:^|\s)logo(?:\s|$)/i.test(node.className)?'offer-logo':node.tagName==='BUTTON'||/(?:^|\s)(?:pp-cta|cta|button|btn)(?:\s|$)/i.test(node.className)?'offer-cta':'article-link';return {id:'html:'+id,path:'importHtml',label:'HTML: '+(node.textContent.trim()||node.getAttribute('aria-label')||node.querySelector('img')&&node.querySelector('img').getAttribute('alt')||'Посилання '+(index+1)),role:role,url:navigation(node).url,attribute:navigation(node).attribute,anchor:node.textContent,source:'html',nodeId:id,anchorEditable:node.children.length===0,binding:node.outerHTML};});
    }
    function list(config){
      ensureConfig(config);var result=[];
      function add(id,path,role,label,url,anchor,extra){result.push(Object.assign({id:id,path:path,role:role,label:label,url:typeof url==='string'?url:'',anchor:typeof anchor==='string'?anchor:'',source:'field'},extra||{}));}
      var chrome=hasChrome(config);
      if(chrome){add('brand-header','brandUrl','brand-header','Бренд у хедері',brandUrl(config),config.brand,{anchorEditable:false});add('brand-footer','footerBrandUrl','brand-footer','Бренд у футері',config.footerBrandUrl||brandUrl(config),config.brand,{anchorEditable:false});}
      if(config.contentMode==='html')return result.concat(imported(config));
      ['cards','moreCards'].forEach(function(group){(config[group]||[]).forEach(function(row,index){var key=rowKey(row,group,index),prefix=group+'.'+index;add(key+':cta',prefix+'.url','offer-cta',(row.name||'Картка '+(index+1))+': кнопка',row.url,row.button||config.ctaLabel,{anchorPath:prefix+'.button',anchorEditable:true});add(key+':logo',prefix+'.logoUrl','offer-logo',(row.name||'Картка '+(index+1))+': логотип',row.logoUrl||row.url,row.name,{anchorEditable:false});});});
      [['tiles','article-link'],['services','article-link'],['reviews','article-link'],['navLinks','article-link']].forEach(function(pair){if(pair[0]==='navLinks'&&!chrome)return;(config[pair[0]]||[]).forEach(function(row,index){add(rowKey(row,pair[0],index)+':url',pair[0]+'.'+index+'.url',pair[1],row.name||row.title||'Посилання '+(index+1),row.url,row.name||row.title,{anchorEditable:false});});});
      if(own(config,'promoUrl'))add('promo:cta','promoUrl','offer-cta','Кнопка промоблоку',config.promoUrl,config.promoButton,{anchorPath:'promoButton',anchorEditable:true});
      fieldRows(config).forEach(function(field){markdownLinks(field.value).forEach(function(link,index){add(field.key+':markdown:'+index,field.path,'article-link',field.label+': '+link.anchor,link.url,link.anchor,{source:'markdown',start:link.start,end:link.end,anchorEditable:true,binding:field.value});});});
      if(config.aiLinkInsertions&&config.aiLinkInsertions.length){
        var tokenPlan=createTokenPlan(config,config.aiLinkInsertions);
        Object.keys(tokenPlan.fields).forEach(function(path){resolveTokens(read(config,path),path,tokenPlan);});
        config.aiLinkInsertions.forEach(function(item,index){add('token:'+item.id,'aiLinkInsertions.'+index+'.url','article-link','Вставка: '+item.anchor,item.url,item.anchor,{source:'token',anchorPath:'aiLinkInsertions.'+index+'.anchor',anchorEditable:true,binding:read(config,item.fieldPath),fieldPath:item.fieldPath});});
      }
      var ids=new Set();result.forEach(function(p){if(ids.has(p.id))fail('Повторний ID місця посилання.');ids.add(p.id);});return result;
    }
    function prepare(config){
      ensureConfig(config);var next=clone(config),diff=[],used=new Set(),warnings=[],coverage={supportedControls:0,unsupportedControls:0};
      GROUPS.forEach(function(group){(next[group]||[]).forEach(function(row,index){if(!row||typeof row!=='object'||Array.isArray(row))fail('Некоректний рядок конфігурації.');var id=rowKey(row,group,index);if(id.indexOf('unprepared-')===0)id='r-'+group+'-'+index+'-'+hash(canonical(row));if(used.has(id))fail('Повторний ID рядка; перевірте скопійовані дані.');used.add(id);if(row._ppRowId!==id){row._ppRowId=id;diff.push({path:group+'.'+index+'._ppRowId',kind:'identity',value:id});}});});
      function materialize(path,value){if(!read(next,path)&&value){write(next,path,value);diff.push({path:path,kind:'inheritance',value:value});}}
      if(hasChrome(next)){materialize('brandUrl',brandUrl(next));materialize('footerBrandUrl',next.brandUrl||firstOffer(next));}
      if(next.contentMode==='html'){
        var original=next.importHtml||'',document=parse(original),changed=false,htmlIds=new Set();
        coverage.supportedControls=htmlNodes(document).length;coverage.unsupportedControls=Array.from(document.querySelectorAll('[onclick],[data-pp-url]')).filter(function(node){return !navigation(node);}).length;
        if(coverage.unsupportedControls)warnings.push('Деякі переходи мають непідтримуваний скрипт або неоднозначну адресу. Вони не включені до точкової заміни.');
        htmlNodes(document).forEach(function(node,index){var id=node.getAttribute('data-pp-placement-id');if(id&&!/^[a-zA-Z0-9_-]{1,100}$/.test(id))fail('Некоректний ID HTML-посилання.');if(!id){id='h-'+index+'-'+hash(node.outerHTML);node.setAttribute('data-pp-placement-id',id);changed=true;}if(htmlIds.has(id))fail('Повторний ID HTML-посилання.');htmlIds.add(id);});
        if(changed){next.importHtml=serialize(document,original);diff.push({path:'importHtml',kind:'identity',description:'Додано ID вузлам посилань без зміни текстів і стилів.'});}
      }else ['cards','moreCards'].forEach(function(group){(next[group]||[]).forEach(function(row,index){materialize(group+'.'+index+'.logoUrl',row.url);});});
      return {config:next,diff:diff,placements:list(next),warnings:warnings,coverage:coverage};
    }
    function propose(config,changes){
      ensureConfig(config);if(canonical(prepare(config).config)!==canonical(config))fail('Спершу підготуйте й збережіть ID та окремі адреси через prepare().');if(!Array.isArray(changes)||!changes.length||changes.length>1000)fail('Потрібен непорожній список змін.');
      var placements=list(config),byId=new Map(placements.map(function(p){return [p.id,p];})),seen=new Set(),next=clone(config),diff=[],edits=new Map(),htmlChanges=[];
      changes.forEach(function(change){
        if(!change||typeof change!=='object'||!byId.has(change.id))fail('Конфлікт: місце посилання змінилося.');if(seen.has(change.id))fail('Повторне місце у пакеті змін.');seen.add(change.id);var place=byId.get(change.id);
        if(change.expectedUrl!==place.url||change.expectedAnchor!==place.anchor)fail('Конфлікт: адреса або анкор уже змінилися.');ensureUrl(change.url);
        if(place.binding!==undefined&&change.expectedBinding!==place.binding)fail('Конфлікт: розмітка посилання змінилася.');
        var anchor=own(change,'anchor')?change.anchor:place.anchor;
        if(typeof anchor!=='string'||anchor.length>2000)fail('Некоректний анкор.');if(anchor!==place.anchor&&!place.anchorEditable)fail('Зміна анкора пошкодить спільний текст або дочірню розмітку; змініть її окремо.');
        diff.push({id:place.id,path:place.path,role:place.role,label:place.label,oldUrl:place.url,newUrl:change.url,oldAnchor:place.anchor,newAnchor:anchor});
        if(place.source==='html'){htmlChanges.push({place:place,url:change.url,anchor:anchor});return;}
        if(place.source==='markdown'){
          if(anchor!==place.anchor&&(/[\[\]\r\n]/.test(anchor)||anchor.indexOf('**')>=0))fail('Для спеціальних символів анкора використайте точну токен-вставку.');
          var depth=0;for(var at=0;at<change.url.length;at++){if(change.url[at]==='(')depth++;if(change.url[at]===')')depth--;if(depth<0)break;}if(depth!==0)fail('Для URL з непарними дужками потрібна токен-вставка.');
          if(!edits.has(place.path))edits.set(place.path,[]);edits.get(place.path).push({start:place.start,end:place.end,value:'['+anchor+']('+change.url+')'});return;
        }
        write(next,place.path,change.url);if(anchor!==place.anchor&&place.anchorPath)write(next,place.anchorPath,anchor);
      });
      edits.forEach(function(parts,path){var value=read(config,path);parts.sort(function(a,b){return b.start-a.start;}).forEach(function(part){value=value.slice(0,part.start)+part.value+value.slice(part.end);});write(next,path,value);});
      if(htmlChanges.length){var document=parse(config.importHtml);htmlChanges.forEach(function(change){var matches=Array.from(document.querySelectorAll('[data-pp-placement-id]')).filter(function(node){return node.getAttribute('data-pp-placement-id')===change.place.nodeId;});if(matches.length!==1)fail('HTML-місце не підготовлено або неоднозначне.');var node=matches[0],nav=navigation(node);if(!nav||nav.url!==change.place.url||node.textContent!==change.place.anchor)fail('Конфлікт: HTML-посилання змінилося.');if(nav.attribute==='href'){if(!node.hasAttribute('data-pp-original-href'))node.setAttribute('data-pp-original-href',node.getAttribute('href'));node.setAttribute('href',change.url);}else{if(/[\"'\\]/.test(change.url))fail('URL зі лапками чи зворотним слешем не підтримується для вихідного onclick.');node.setAttribute('onclick',(nav.returns?'return ':'')+'window.open('+JSON.stringify(change.url)+','+JSON.stringify(nav.target)+',\"noopener,noreferrer\")');}if(change.anchor!==change.place.anchor)node.textContent=change.anchor;});next.importHtml=serialize(document,config.importHtml);}
      list(next).forEach(function(place){var old=byId.get(place.id);if(!seen.has(place.id)&&old&&(old.url!==place.url||old.anchor!==place.anchor))fail('Зміна зачіпає невибране місце посилання. Додайте його до пакета або задайте йому окрему адресу.');});
      return {version:1,baseSnapshot:canonical(config),changes:clone(changes),diff:diff,nextConfig:next};
    }
    function apply(config,proposal){if(!proposal||proposal.version!==1||proposal.baseSnapshot!==canonical(config))fail('Конфлікт: початкова сторінка змінилася.');return propose(config,proposal.changes).nextConfig;}
    return {prepare:prepare,list:list,propose:propose,apply:apply,createTokenPlan:createTokenPlan,resolveTokens:resolveTokens,create:create};
  }
  function textField(config,path){if(path==='promoBody')return {value:config.promoBody||'',limit:BODY_FIELDS.promoBody};var m=/^(cards|moreCards|sections|tiles|services|reviews|faq)\.(\d+)\.(bonus|body|answer)$/.exec(path);if(!m||!own(BODY_FIELDS,m[1]+'.'+m[3]))fail('Токен дозволений лише в конкретному текстовому полі.');var row=config[m[1]]&&config[m[1]][Number(m[2])];if(!row||typeof row[m[3]]!=='string')fail('Текстове поле не знайдено.');return {value:row[m[3]],limit:BODY_FIELDS[m[1]+'.'+m[3]]};}
  function createTokenPlan(config,placements){ensureConfig(config);if(config.contentMode==='html')fail('ШІ-токени недоступні для готового HTML.');if(!Array.isArray(placements)||!placements.length||placements.length>100)fail('Потрібен список дозволених вставок.');var ids=new Set(),fields={},items=[];placements.forEach(function(item){if(!item||typeof item.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)||ids.has(item.id))fail('Некоректний або повторний ID вставки.');ids.add(item.id);ensureUrl(item.url);if(typeof item.anchor!=='string'||!item.anchor.length||item.anchor.length>2000)fail('Потрібен точний анкор.');var field=textField(config,item.fieldPath),count=item.count===undefined?1:item.count;if(!Number.isSafeInteger(count)||count<1||count>10)fail('Некоректна кількість вставок.');fields[item.fieldPath]={baseValue:field.value,maxLength:field.limit};items.push({id:item.id,fieldPath:item.fieldPath,url:item.url,anchor:item.anchor,count:count});});return {version:1,fields:fields,placements:items};}
  function urlsInText(value){return (value.match(/https?:\/\/[^\s<>"']+/gi)||[]).sort();}
  function resolveTokens(value,fieldPath,plan){
    if(typeof value!=='string'||!plan||plan.version!==1||!plan.fields||!own(plan.fields,fieldPath)||!Array.isArray(plan.placements))fail('Невідоме поле або план вставок.');var field=plan.fields[fieldPath];if(!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>50000||typeof field.baseValue!=='string')fail('Некоректний план поля.');
    if(canonical(urlsInText(value))!==canonical(urlsInText(field.baseValue)))fail('ШІ не може додавати, прибирати або змінювати URL поза токенами.');
    var oldAnchors=markdownLinks(field.baseValue.replace(/\[\[PP_LINK:[a-zA-Z0-9_-]+\]\]/g,'')).map(function(link){return [link.url,link.anchor];}).sort(),newAnchors=markdownLinks(value.replace(/\[\[PP_LINK:[a-zA-Z0-9_-]+\]\]/g,'')).map(function(link){return [link.url,link.anchor];}).sort();
    if(canonical(oldAnchors)!==canonical(newAnchors))fail('Ручні URL та анкори не можна змінювати через ШІ.');
    var all=new Map(),counts=new Map(),segments=[],cursor=0,pattern=/\[\[PP_LINK:([a-zA-Z0-9_-]+)\]\]/g,match;
    plan.placements.forEach(function(item){if(!item||all.has(item.id)||typeof item.anchor!=='string'||!validUrl(item.url)||!Number.isSafeInteger(item.count)||item.count<1||item.count>10)fail('Некоректний реєстр вставок.');all.set(item.id,item);});
    while((match=pattern.exec(value))){var item=all.get(match[1]);if(!item||item.fieldPath!==fieldPath)fail('Токен не дозволений у цьому полі.');if(match.index>cursor)segments.push({type:'text',text:value.slice(cursor,match.index)});segments.push({type:'link',id:item.id,url:item.url,anchor:item.anchor});counts.set(item.id,(counts.get(item.id)||0)+1);cursor=pattern.lastIndex;}
    if(cursor<value.length)segments.push({type:'text',text:value.slice(cursor)});
    if(segments.some(function(s){return s.type==='text'&&s.text.indexOf('[[PP_LINK:')>=0;}))fail('Некоректний токен вставки.');
    plan.placements.forEach(function(item){if(item.fieldPath===fieldPath&&(counts.get(item.id)||0)!==item.count)fail('Не всі обов’язкові вставки присутні рівно задану кількість разів.');});
    var expanded=segments.map(function(s){return s.type==='text'?s.text:s.anchor+s.url;}).join('');if(expanded.length>field.maxLength)fail('Довжина тексту після вставки перевищує ліміт; адресу й анкор не обрізано.');
    return {segments:segments,html:segments.map(function(s){return s.type==='text'?escape(s.text):'<a href="'+escape(s.url)+'" rel="noopener noreferrer" data-pp-priority="article">'+escape(s.anchor)+'</a>';}).join('')};
  }
  return create({window:defaultWindow});
});
