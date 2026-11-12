(function () {
  'use strict';
  const core = window.PagePoster;
  if (!core) { document.getElementById('form-panel').textContent = 'Не вдалося завантажити генератор. Оновіть сторінку.'; return; }
  const STORAGE = 'pageposter.micro.v1';
  const DESIGN_STORAGE = 'pageposter.design-sequence.v1';
  const designEngine = window.PagePosterDesignVariants;
  let designSequence = null;
  const HTML_LIMIT = 500000;
  const $ = id => document.getElementById(id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const collectionFields = {
    cards: ['name','image','bonus','rating','url','logoUrl','button','note','features','payout','payoutNote'],
    moreCards: ['name','image','bonus','rating','url','logoUrl','button','note','features','payout','payoutNote'],
    navLinks: ['name','url'],
    tiles: ['name','image','body','url'],
    services: ['name','image','body','url'],
    sections: ['title','body','image'],
    faq: ['question','answer'],
    reviews: ['title','image','body','url']
  };
  const topFields = new Set(['brand','footerBrandUrl','fontFamily','brandUrl','brandImage','brandTagline','title','intro','author','authorImage','date','cardsTitle','moreCardsTitle','articleTitle','faqTitle','footer','footerTitle','footerLinksTitle','footerNote','ctaLabel','mode','tocTitle','showToc','tilesTitle','tilesIntro','servicesTitle','servicesIntro','tableTitle','tableText','reviewsTitle','columnBrand','columnBonus','columnRating','columnAction','promoTitle','promoBody','promoButton','promoUrl','contentMode','importChrome','importHtml','importBaseUrl','importReplaceHeader','importReplaceFooter']);
  const freshOpenItems = () => Object.fromEntries(Object.keys(collectionFields).map(key => [key,0]));
  const imageOptions = {type:'url',max:4000,placeholder:'https://…',optional:true,hint:'Пряме посилання на зображення.'};
  const linkOptions = {type:'url',max:4000,placeholder:'https://…',optional:true};
  let data = clone(core.DEFAULT_DATA);
  let activeTab = 'base';
  let revision = 0;
  let aiController = null;
  let currentView = 'preview';
  let updateTimer;
  let toastTimer;
  let confirmationResolve = null;
  let imported = false;
  let storageAvailable = true;
  let openItems = freshOpenItems();
  let openGroups = {brand:false,author:false,navigation:false,footer:false,columns:false,promo:false,tiles:true,services:false,table:false,reviews:false};
  try {
    const saved = localStorage.getItem(STORAGE);
    if (saved) { const parsed = JSON.parse(saved); if (!validProject(parsed)) throw new Error('invalid'); data = core.normalizeConfig(parsed); imported = true; }
  } catch (_) { storageAvailable = false; $('save-state').textContent = 'Чернетку не відновлено — збережи JSON'; }

  if(data.contentMode==='html')activeTab='html';

  function validProject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) && (value.version === undefined || value.version === 1) && typeof value.title === 'string' && Array.isArray(value.cards) && Array.isArray(value.sections) && Array.isArray(value.faq);
  }

  function validDesignSequence(value) {
    return value && typeof value.seed==='string' && value.seed.length>0 && value.seed.length<=200 && Number.isSafeInteger(value.nextSequence) && value.nextSequence>=0 && value.nextSequence<Number.MAX_SAFE_INTEGER-1;
  }
  function nextDesign(config) {
    if(config.contentMode==='html' || !designEngine || typeof designEngine.apply!=='function')return config;
    let saved;try{saved=JSON.parse(localStorage.getItem(DESIGN_STORAGE)||'null');}catch(_){}
    if(validDesignSequence(saved)){if(validDesignSequence(designSequence) && designSequence.seed===saved.seed)saved.nextSequence=Math.max(saved.nextSequence,designSequence.nextSequence);designSequence=saved;}
    const current=config.designVariant;
    const currentValid=current && typeof current.seed==='string' && current.seed.length>0 && current.seed.length<=200 && Number.isSafeInteger(current.sequence) && current.sequence>=0 && current.sequence<Number.MAX_SAFE_INTEGER-2;
    if(!validDesignSequence(designSequence))designSequence={version:1,seed:currentValid?current.seed:(window.crypto?.randomUUID?.()||'pageposter-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)),nextSequence:currentValid?current.sequence+1:0};
    if(currentValid && current.seed===designSequence.seed)designSequence.nextSequence=Math.max(designSequence.nextSequence,current.sequence+1);
    let sequence=designSequence.nextSequence,result=designEngine.apply(config,{seed:designSequence.seed,sequence});
    if(['background','accent','header','card'].every(key=>result.nextConfig.colors[key]===config.colors?.[key]))result=designEngine.apply(config,{seed:designSequence.seed,sequence:++sequence});
    designSequence.nextSequence=sequence+1;
    try{localStorage.setItem(DESIGN_STORAGE,JSON.stringify(designSequence));}catch(_){}
    return result.nextConfig;
  }
  function variantControls() {
    if(data.contentMode==='html')return '<p class="helper">Автоматичні варіанти оформлення доступні для конструктора. Вигляд твого готового HTML зберігається.</p>';
    let html=designEngine?'<div class="section-heading"><h3>Новий варіант оформлення</h3></div><button type="button" class="secondary-btn" data-design-action="next">Інші кольори та шрифт</button><p class="helper">Нові сторінки через ШІ отримують наступний варіант автоматично. Тексти, посилання й зображення від цієї кнопки не змінюються.</p>':'';
    if(data.designVariant && Number.isSafeInteger(data.designVariant.sequence))html+='<p class="helper">Збережений варіант № '+(data.designVariant.sequence+1)+'. Він відновиться разом із чернеткою.</p>';
    html+='<label class="field"><span>Шрифт сторінки</span><select class="secondary-btn" data-path="fontFamily">'+['Arial','Georgia','Verdana','Trebuchet MS','system-ui'].map(font=>'<option value="'+font+'"'+((data.fontFamily||'Arial')===font?' selected':'')+'>'+font+'</option>').join('')+'</select></label><div class="form-divider"></div>';
    return html;
  }

  function field(label, path, value, options = {}) {
    const {type='text',hint='',optional=false,rows=3,placeholder='',max=500} = options;
    const attrs = ' data-path="' + path + '" placeholder="' + esc(placeholder) + '"';
    const input = type === 'textarea' ? '<textarea' + attrs + ' rows="'+rows+'" maxlength="'+max+'">'+esc(value)+'</textarea>' : '<input type="'+type+'"'+attrs+' value="'+esc(value)+'"'+(type === 'number' ? ' min="0" max="5" step="0.1"' : type === 'color' || type === 'date' ? '' : ' maxlength="'+max+'"')+'>';
    return '<label class="field"><span>'+label+(optional?'<em>необов’язково</em>':'')+'</span>'+input+(hint?'<small>'+hint+'</small>':'')+'</label>';
  }
  function checkbox(label,path,value,hint) {
    return '<label class="check-field"><input type="checkbox" data-path="'+path+'"'+(value?' checked':'')+'><span><strong>'+label+'</strong>'+(hint?'<small>'+hint+'</small>':'')+'</span></label>';
  }
  function group(key,label,body,description='') {
    return '<details class="editor-group" data-group="'+key+'"'+(openGroups[key]?' open':'')+'><summary><span>'+label+'</span>'+(description?'<small>'+description+'</small>':'')+'</summary><div class="group-body">'+body+'</div></details>';
  }
  function heading(label,count) {return '<div class="section-heading"><h3>'+label+'</h3>'+(count===undefined?'':'<span>'+count+' / 100</span>')+'</div>';}
  function itemField(label,kind,index,key,value,options={}) { return field(label,kind+'.'+index+'.'+key,value,options); }
  function collection(kind,items,renderer,noun) {
    if (!items.length) return '<div class="empty-state">Поки порожньо. Додай '+noun+' нижче.</div>';
    return items.map((item,index)=>'<details class="collection-item" data-kind="'+kind+'" data-index="'+index+'"'+(openItems[kind]===index?' open':'')+'><summary><span class="item-number">'+String(index+1).padStart(2,'0')+'</span><span class="item-name">'+esc(item.name || item.title || item.question || 'Без назви')+'</span></summary><div class="item-body">'+renderer(item,index)+'<div class="item-actions"><button type="button" data-action="up" data-kind="'+kind+'" data-index="'+index+'" aria-label="Перемістити вгору '+(index+1)+'"'+(index===0?' disabled':'')+'>↑ Вище</button><button type="button" data-action="down" data-kind="'+kind+'" data-index="'+index+'" aria-label="Перемістити вниз '+(index+1)+'"'+(index===items.length-1?' disabled':'')+'>↓ Нижче</button><button type="button" class="delete-item" data-action="remove" data-kind="'+kind+'" data-index="'+index+'">Видалити</button></div></div></details>').join('');
  }
  function addButton(kind,label) { return '<button class="add-full" type="button" data-action="add" data-kind="'+kind+'">＋ '+label+'</button>'; }
  function offerFields(kind,item,i) {
    return itemField('Назва',kind,i,'name',item.name,{max:300})+
      itemField('Посилання на логотип',kind,i,'image',item.image,{...imageOptions,hint:'Пряме посилання на логотип. Без нього покажемо назву на плашці.'})+
      itemField('Головна пропозиція',kind,i,'bonus',item.bonus,{type:'textarea',rows:2,max:3000})+
      itemField('Переваги',kind,i,'features',item.features,{type:'textarea',rows:2,max:4000,optional:true,placeholder:'Наприклад: великий вибір · підтримка 24/7',hint:'Короткі характеристики під пропозицією.'})+
      '<div class="field-row">'+itemField('Оцінка від 0 до 5',kind,i,'rating',item.rating,{type:'number'})+itemField('Текст кнопки',kind,i,'button',item.button,{max:100,placeholder:data.ctaLabel,optional:true})+'</div>'+
      itemField('Куди веде кнопка',kind,i,'url',item.url,{...linkOptions,hint:'Вкажи повну адресу. Без посилання кнопка буде неактивна.'})+
      '<div class="field-row">'+itemField('Час виплати / умова',kind,i,'payout',item.payout,{max:300,optional:true,placeholder:'10–30 хв'})+itemField('Підпис до умови',kind,i,'payoutNote',item.payoutNote,{max:1000,optional:true,placeholder:'Наприклад, строк обробки'})+'</div>'+
      itemField('Додаткова примітка',kind,i,'note',item.note,{type:'textarea',rows:2,max:2000,optional:true,placeholder:'Умови пропозиції або коротке пояснення'});
  }
  function tileFields(kind,item,i) {
    return itemField('Назва',kind,i,'name',item.name,{max:300})+
      itemField('Зображення',kind,i,'image',item.image,imageOptions)+
      itemField('Короткий опис',kind,i,'body',item.body,{type:'textarea',rows:3,max:10000,optional:true})+
      itemField('Куди веде картка',kind,i,'url',item.url,linkOptions);
  }
  function htmlAnalysis() {
    if(!data.importHtml)return null;
    try {return core.analyzeHTML(data);}
    catch(error){return {error:true,title:'',headings:[],warnings:[error.message||'Не вдалося прочитати HTML.'],stats:{},hasHeader:false,hasFooter:false};}
  }
  function htmlRegionVisible(region,analysis) {
    return data.contentMode!=='html'||data.importChrome!=='none';
  }
  function htmlRegionNote(region,analysis) {
    if(!htmlRegionVisible(region,analysis))return 'Обрано «Лише мій HTML». Ці налаштування збережені, але додатковий блок не з’явиться.';
    return region==='header'?'PagePoster додасть власний хедер над твоїм HTML.':'PagePoster додасть окремий футер із брендом, описом і меню під твоїм HTML.';
  }
  function htmlBrandVisible(analysis) {return htmlRegionVisible('header',analysis);}
  function htmlBrandNote(analysis) {
    return htmlBrandVisible(analysis)?'Бренд з’явиться у нашому хедері та футері. Вкажи окрему адресу або залиш перехід до першої пропозиції.':'Обрано «Лише мій HTML». Бренд та його посилання збережені для варіанта з нашим хедером і футером.';
  }
  function analysisMarkup(analysis) {
    if(!analysis)return '<p>Встав HTML або відкрий файл, щоб побачити назву, структуру й підказки.</p>';
    if(analysis.error)return '<p><strong>Не вдалося підготувати HTML.</strong></p><ul class="html-analysis-warnings">'+(analysis.warnings||['Перевір код сторінки.']).slice(0,10).map(warning=>'<li>'+esc(warning)+'</li>').join('')+'</ul>';
    const stats=analysis.stats||{};
    const countLabels={links:'Посилання',images:'Зображення',headings:'Заголовки',elements:'Елементи'};
    const counts=Object.entries(countLabels).filter(([key])=>typeof stats[key]==='number').map(([key,label])=>'<span>'+label+': <strong>'+stats[key]+'</strong></span>').join('');
    return '<div class="html-analysis-title"><strong>'+esc(analysis.title||'Без назви сторінки')+'</strong><span>'+((data.importHtml||'').length/1000).toFixed(1)+' тис. символів</span></div>'+
      (counts?'<div class="html-analysis-counts">'+counts+'</div>':'')+
      '<p>'+(data.importChrome==='none'?'Експорт без додаткового хедера та футера.':'Наш хедер і окремий футер будуть додані навколо HTML.')+' Власні блоки HTML зберігаються, якщо ти окремо не ввімкнеш їхню заміну.</p>'+
      (analysis.headings&&analysis.headings.length?'<details><summary>Заголовки сторінки · '+analysis.headings.length+'</summary><ol>'+analysis.headings.slice(0,20).map(item=>'<li>'+esc(item.text)+'</li>').join('')+(analysis.headings.length>20?'<li>Ще '+(analysis.headings.length-20)+' заголовків.</li>':'')+'</ol></details>':'<p>Заголовків для меню не знайдено. Можна додати власні посилання нижче.</p>')+
      (analysis.warnings&&analysis.warnings.length?'<ul class="html-analysis-warnings">'+analysis.warnings.slice(0,10).map(warning=>'<li>'+esc(warning)+'</li>').join('')+'</ul>':'');
  }
  function refreshHTMLAnalysis() {
    if(activeTab!=='html')return;
    const analysis=htmlAnalysis();
    if($('html-analysis'))$('html-analysis').innerHTML=analysisMarkup(analysis);
    if($('html-char-count'))$('html-char-count').textContent=(data.importHtml||'').length.toLocaleString('uk-UA')+' / 500 000';
    ['header','footer'].forEach(region=>{
      const fields=$('html-'+region+'-fields'),note=$('html-'+region+'-note');
      if(fields)fields.disabled=!(region==='header'?htmlBrandVisible(analysis):htmlRegionVisible(region,analysis));
      if(note)note.textContent=region==='header'?htmlBrandNote(analysis):htmlRegionNote(region,analysis);
    });
    if($('html-menu-fields'))$('html-menu-fields').disabled=!htmlRegionVisible('header',analysis)&&!htmlRegionVisible('footer',analysis);
  }
  function renderHTMLForm() {
    const analysis=htmlAnalysis();
    return '<div class="html-intro"><h3>Сторінка з готового HTML</h3><p>Встав код сторінки або відкрий файл. Вибери: додати наш хедер і футер або показати лише свій HTML. Оформлення самого вмісту зберігається.</p></div>'+
      '<fieldset class="html-mode-picker"><legend>Що показувати й експортувати</legend>'+
      [['builder','Конструктор','Поля, картки й стаття з інших вкладок.'],['html','Готовий HTML','Код із поля нижче та налаштування цієї вкладки.']].map(([value,label,hint])=>'<label class="mode-option"><input type="radio" name="content-mode" data-path="contentMode" value="'+value+'"'+((data.contentMode==='html'?'html':'builder')===value?' checked':'')+'><span><strong>'+label+'</strong><small>'+hint+'</small></span></label>').join('')+
      '</fieldset><p class="helper">Перемикання зберігає обидва варіанти в чернетці. Зараз у перегляді: <strong>'+(data.contentMode==='html'?'готовий HTML':'конструктор')+'</strong>.</p>'+
      '<div class="html-source-top"><button type="button" class="secondary-btn" data-html-action="load">↥ Відкрити HTML-файл</button><small>.html або .htm · до 500 KB</small></div>'+
      '<label class="field"><span>Код сторінки <em id="html-char-count">'+(data.importHtml||'').length.toLocaleString('uk-UA')+' / 500 000</em></span><textarea class="html-source" data-path="importHtml" rows="12" maxlength="500000" spellcheck="false" placeholder="Встав сюди HTML-код сторінки…">'+esc(data.importHtml||'')+'</textarea><small>Повна сторінка або HTML-фрагмент. PagePoster переносить оформлення й розпізнані переходи кнопок. Довільні скрипти з початкового коду не виконуються; підказки нижче покажуть обмеження імпорту.</small></label>'+
      field('Адреса вихідної сторінки','importBaseUrl',data.importBaseUrl||'',{...linkOptions,hint:'Наприклад, https://example.com/article/. Потрібна для відносних адрес зображень і посилань. Сайт не завантажується.'})+
      '<div id="html-analysis" class="html-analysis" role="status">'+analysisMarkup(analysis)+'</div>'+
      '<div class="form-divider"></div><fieldset class="html-mode-picker html-chrome-picker"><legend>Який варіант сторінки потрібен</legend>'+
      [['add','Додати наш хедер і футер','Твій HTML між нашим верхнім меню й окремим нижнім блоком.'],['none','Лише мій HTML','Без додаткових блоків. Власні заголовок і нижній блок HTML зберігаються.']].map(([value,label,hint])=>'<label class="mode-option"><input type="radio" name="import-chrome" data-path="importChrome" value="'+value+'"'+((data.importChrome==='none'?'none':'add')===value?' checked':'')+'><span><strong>'+label+'</strong><small>'+hint+'</small></span></label>').join('')+'</fieldset>'+
      '<p class="helper">Щоб перекрити хедер і футер теми WordPress, вибери «На весь екран» у вкладці «Вигляд». Це працює в обох варіантах.</p>'+
      group('htmlReplace','Розширені налаштування','<p class="helper group-help">Лише якщо хочеш прибрати верхній або нижній блок із самого завантаженого HTML. Це може прибрати вступ або примітки. Для перекриття теми сайту ці перемикачі не потрібні.</p><fieldset class="html-fields"'+(data.importChrome==='none'?' disabled':'')+'>'+checkbox('Замінити верхній блок у моєму HTML','importReplaceHeader',Boolean(data.importReplaceHeader),'Видалити розпізнаний верхній блок із коду та залишити наш хедер.')+checkbox('Замінити нижній блок у моєму HTML','importReplaceFooter',Boolean(data.importReplaceFooter),'Видалити розпізнаний нижній блок із коду та залишити наш футер.')+'</fieldset>','Заміна блоків усередині HTML')+
      group('htmlHeader','Бренд у доданих блоках','<p id="html-header-note" class="helper group-help">'+htmlBrandNote(analysis)+'</p><fieldset id="html-header-fields" class="html-fields"'+(!htmlBrandVisible(analysis)?' disabled':'')+'>'+
        field('Назва бренду','brand',data.brand,{max:200})+field('Куди веде бренд','brandUrl',data.brandUrl, {...linkOptions,hint:'Без власної адреси використовується перше коректне зовнішнє посилання з HTML.'})+field('Куди веде бренд у футері','footerBrandUrl',data.footerBrandUrl,{...linkOptions,hint:'Порожнє поле повторює адресу бренду у хедері.'})+field('Логотип бренду','brandImage',data.brandImage,imageOptions)+field('Короткий підпис','brandTagline',data.brandTagline,{max:300,optional:true})+'</fieldset>','Бренд, логотип і посилання')+
      group('htmlFooter','Нижній блок','<p id="html-footer-note" class="helper group-help">'+htmlRegionNote('footer',analysis)+'</p><fieldset id="html-footer-fields" class="html-fields"'+(!htmlRegionVisible('footer',analysis)?' disabled':'')+'>'+
        field('Заголовок нижнього блоку','footerTitle',data.footerTitle,{max:300,optional:true})+field('Опис нижнього блоку','footer',data.footer,{type:'textarea',rows:3,max:5000,optional:true})+field('Заголовок меню','footerLinksTitle',data.footerLinksTitle,{max:300,optional:true})+field('Нижній рядок / права на матеріал','footerNote',data.footerNote,{type:'textarea',rows:2,max:5000,optional:true})+'</fieldset>','Опис, меню, підпис')+
      group('htmlMenu','Посилання меню','<p class="helper group-help">Без власних посилань PagePoster створить меню з заголовків HTML. Це меню діє в доданих або замінених блоках.</p><fieldset id="html-menu-fields" class="html-fields"'+(!htmlRegionVisible('header',analysis)&&!htmlRegionVisible('footer',analysis)?' disabled':'')+'>'+collection('navLinks',data.navLinks||[],(item,index)=>itemField('Назва пункту','navLinks',index,'name',item.name,{max:200})+itemField('Адреса','navLinks',index,'url',item.url,linkOptions),'пункт меню')+addButton('navLinks','Додати посилання')+'</fieldset>',(data.navLinks||[]).length+' пунктів')+
      '<p class="helper">Кольори й готові оформлення доступні у вкладці «Вигляд». Вони оформлюють додані блоки; власні стилі HTML зберігаються там, де це можливо.</p>';
  }
  function switchContentMode(mode,tab) {
    if(mode!=='html'&&mode!=='builder')return;
    data.contentMode=mode;if(tab)activeTab=tab;
    projectChanged();renderForm();persist();renderOutput();
  }
  function renderForm() {
    $('form-panel').querySelectorAll('[data-group]').forEach(item=>{openGroups[item.dataset.group]=item.open;});
    document.querySelectorAll('[data-tab]').forEach(button=>{button.classList.toggle('active',button.dataset.tab===activeTab);button.setAttribute('aria-pressed',String(button.dataset.tab===activeTab));});
    $('card-count').textContent=data.cards.length + (data.moreCards || []).length;
    $('form-panel').hidden=activeTab==='ai';
    $('ai-panel').hidden=activeTab!=='ai';
    if(activeTab==='ai') { if(aiController)aiController.refresh(); return; }
    let html='';
    if(activeTab==='html') {
      html=renderHTMLForm();
    } else if(data.contentMode==='html'&&['base','cards','blocks','content'].includes(activeTab)) {
      html='<div class="html-mode-notice"><span class="ai-spark">↥</span><h3>Зараз використовується готовий HTML</h3><p>Поля конструктора збережені, але не входять у поточний результат. Вміст і верхній та нижній блоки можна змінити у вкладці «Готовий HTML».</p><button type="button" class="primary-btn" data-html-action="show">Відкрити готовий HTML</button><button type="button" class="secondary-btn" data-html-action="builder">Повернутися до конструктора</button></div>';
    } else if (activeTab==='base') {
      html='<div class="demo-notice">Усі назви, тексти, зображення та посилання можна змінити. «Повний приклад» завантажить заповнену сторінку з усіма блоками.</div>';
      html+=field('Назва бренду','brand',data.brand,{placeholder:'Наприклад, Casino Guide',max:200});
      html+=field('Куди веде натискання на бренд','brandUrl',data.brandUrl,{...linkOptions,hint:'Власна адреса https://… має пріоритет. Якщо поле порожнє, бренд відкриє перше коректне посилання View Offer у новій вкладці.'});
      html+=field('Куди веде бренд у футері','footerBrandUrl',data.footerBrandUrl,{...linkOptions,hint:'Порожнє поле повторює адресу бренду у хедері.'});
      html+=field('Заголовок сторінки','title',data.title,{type:'textarea',rows:2,max:500,placeholder:'Головний заголовок сторінки'});
      html+=field('Короткий вступ','intro',data.intro,{type:'textarea',rows:4,max:5000,placeholder:'Про що сторінка і чим вона корисна читачеві'});
      html+=group('brand','Логотип і підпис бренду',field('Посилання на логотип бренду','brandImage',data.brandImage,imageOptions)+field('Короткий підпис бренду','brandTagline',data.brandTagline,{max:300,optional:true,placeholder:'Кілька слів про сайт'}),'Необов’язково');
      html+=group('author','Автор і дата','<div class="field-row">'+field('Ім’я автора','author',data.author,{max:200,placeholder:'Ім’я та прізвище'})+field('Дата оновлення','date',data.date,{type:'date'})+'</div>'+field('Фото автора','authorImage',data.authorImage,imageOptions),'Ім’я, фото, оновлення');
      html+=group('navigation','Власні посилання меню','<p class="helper group-help">Без власних посилань меню автоматично веде до блоків сторінки.</p>'+collection('navLinks',data.navLinks || [],(item,i)=>itemField('Назва пункту','navLinks',i,'name',item.name,{max:200})+itemField('Адреса посилання','navLinks',i,'url',item.url,{...linkOptions,hint:'Повна адреса https://… або якір розділу, наприклад #pp-offers.'}),'пункт меню')+addButton('navLinks','Додати посилання'),(data.navLinks || []).length+' пунктів');
      html+=group('footer','Нижній блок сторінки',field('Заголовок нижнього блоку','footerTitle',data.footerTitle,{max:300,optional:true})+field('Опис або примітка внизу','footer',data.footer,{type:'textarea',rows:3,max:5000,optional:true})+field('Заголовок меню внизу','footerLinksTitle',data.footerLinksTitle,{max:300,optional:true})+field('Нижній рядок / права на матеріал','footerNote',data.footerNote,{type:'textarea',rows:2,max:5000,optional:true,placeholder:'© 2026 Ваш бренд'}),'Опис, меню, підпис');
    } else if (activeTab==='cards') {
      html=field('Заголовок головного списку','cardsTitle',data.cardsTitle,{max:300});
      html+=field('Текст кнопок за замовчуванням','ctaLabel',data.ctaLabel,{max:100});
      html+=group('columns','Назви колонок',field('Бренд / назва','columnBrand',data.columnBrand,{max:100})+field('Пропозиція','columnBonus',data.columnBonus,{max:100})+'<div class="field-row">'+field('Рейтинг','columnRating',data.columnRating,{max:100})+field('Дія / виплата','columnAction',data.columnAction,{max:100})+'</div>','Для головного списку');
      html+=heading('Головний рейтинг',data.cards.length)+collection('cards',data.cards,(item,i)=>offerFields('cards',item,i),'пропозицію')+addButton('cards','Додати головну пропозицію');
      html+='<div class="form-divider"></div>'+field('Заголовок додаткового списку','moreCardsTitle',data.moreCardsTitle,{max:300,optional:true});
      html+=heading('Додаткові пропозиції',(data.moreCards || []).length)+collection('moreCards',data.moreCards || [],(item,i)=>offerFields('moreCards',item,i),'пропозицію')+addButton('moreCards','Додати пропозицію');
    } else if (activeTab==='blocks') {
      html='<div class="format-hint">Блоки додають сторінці зображення, порівняння й огляди. Порожні списки не з’являються в результаті.</div>';
      html+=group('promo','Банер із кнопкою',field('Заголовок банера','promoTitle',data.promoTitle,{max:500,optional:true})+field('Текст банера','promoBody',data.promoBody,{type:'textarea',rows:3,max:10000,optional:true})+field('Напис на кнопці','promoButton',data.promoButton,{max:100,optional:true})+field('Куди веде кнопка банера','promoUrl',data.promoUrl,linkOptions),'Між списками пропозицій');
      html+=group('tiles','Плитки із зображеннями',field('Заголовок плиток','tilesTitle',data.tilesTitle,{max:300,optional:true})+field('Вступ перед плитками','tilesIntro',data.tilesIntro,{type:'textarea',rows:3,max:5000,optional:true})+heading('Плитки',(data.tiles || []).length)+collection('tiles',data.tiles || [],(item,i)=>tileFields('tiles',item,i),'плитку')+addButton('tiles','Додати плитку'),(data.tiles || []).length+' елементів');
      html+=group('services','Картки категорій і послуг',field('Заголовок категорій','servicesTitle',data.servicesTitle,{max:300,optional:true})+field('Вступ перед категоріями','servicesIntro',data.servicesIntro,{type:'textarea',rows:3,max:5000,optional:true})+heading('Категорії',(data.services || []).length)+collection('services',data.services || [],(item,i)=>tileFields('services',item,i),'категорію')+addButton('services','Додати категорію'),(data.services || []).length+' елементів');
      html+=group('table','Таблиця порівняння',field('Заголовок таблиці','tableTitle',data.tableTitle,{max:300,optional:true})+field('Вміст таблиці','tableText',data.tableText,{type:'textarea',rows:9,max:50000,optional:true,placeholder:'Назва | Перевага | Умови\nПриклад A | Швидке оформлення | Деталі\nПриклад B | Підтримка 24/7 | Деталі',hint:'Перший рядок — назви колонок. Розділяй клітинки знаком |, а кожен новий рядок таблиці починай із нового рядка. Порожнє поле приховає таблицю.'}),'Колонки через |');
      html+=group('reviews','Розгорнуті огляди',field('Заголовок блоку оглядів','reviewsTitle',data.reviewsTitle,{max:300,optional:true})+heading('Огляди',(data.reviews || []).length)+collection('reviews',data.reviews || [],(item,i)=>itemField('Заголовок огляду','reviews',i,'title',item.title,{max:500})+itemField('Зображення огляду','reviews',i,'image',item.image,imageOptions)+itemField('Текст огляду','reviews',i,'body',item.body,{type:'textarea',rows:7,max:20000,placeholder:'Власний огляд: абзаци, списки, переваги й умови.'})+itemField('Посилання з огляду','reviews',i,'url',item.url,linkOptions),'огляд')+addButton('reviews','Додати огляд'),(data.reviews || []).length+' матеріалів');
    } else if (activeTab==='content') {
      html='<div class="format-hint">Розділяй абзаци порожнім рядком.<br><code>**жирний**</code> · <code>- пункт списку</code> · <code>1. крок</code><br><code>## Підзаголовок</code><br>Посилання: <code>[назва](https://example.com)</code></div>';
      html+=checkbox('Показувати зміст статті','showToc',data.showToc,'Автоматичні посилання на розділи статті.');
      html+=field('Заголовок змісту','tocTitle',data.tocTitle,{max:300,optional:true});
      html+=field('Назва розділу зі статтею','articleTitle',data.articleTitle,{max:300,optional:true});
      html+=heading('Розділи статті',data.sections.length);
      html+=collection('sections',data.sections,(item,i)=>itemField('Заголовок розділу','sections',i,'title',item.title,{max:500})+itemField('Зображення розділу','sections',i,'image',item.image,imageOptions)+itemField('Текст розділу','sections',i,'body',item.body,{type:'textarea',rows:8,max:50000,placeholder:'Встав свій текст. Розділяй абзаци порожнім рядком.'}),'розділ');
      html+=addButton('sections','Додати розділ')+'<div class="form-divider"></div>';
      html+=field('Назва блоку запитань','faqTitle',data.faqTitle,{max:300});
      html+=heading('Запитання та відповіді',data.faq.length);
      html+=collection('faq',data.faq,(item,i)=>itemField('Запитання','faq',i,'question',item.question,{max:1000})+itemField('Відповідь','faq',i,'answer',item.answer,{type:'textarea',rows:4,max:20000}),'запитання');
      html+=addButton('faq','Додати запитання');
    } else if (activeTab==='design') {
      html=variantControls()+'<div class="section-heading"><h3>Готове оформлення</h3><span>За твоїми прикладами</span></div><div class="preset-grid">';
      Object.entries(core.PRESETS).forEach(([key,preset])=>{
        html+='<button type="button" class="preset '+(data.preset===key?'active':'')+'" data-preset="'+key+'"><span class="preset-swatches"><i style="background:'+preset.colors.header+'"></i><i style="background:'+preset.colors.card+'"></i><i style="background:'+preset.colors.accent+'"></i></span><span><strong>'+esc(preset.name)+'</strong><small>'+esc(preset.description)+'</small></span>'+(data.preset===key?'<span class="chosen">✓</span>':'')+'</button>';
      });
      html+='</div><div class="section-heading"><h3>Власні кольори</h3><span>Можна змінити будь-який</span></div><div class="field-row">'+field('Фон сторінки','colors.background',data.colors.background,{type:'color'})+field('Кнопки','colors.accent',data.colors.accent,{type:'color'})+field('Верхнє меню','colors.header',data.colors.header,{type:'color'})+field('Картки','colors.card',data.colors.card,{type:'color'})+'</div><div class="form-divider"></div><div class="section-heading"><h3>Як вставляти у WordPress</h3></div><div class="mode-options">';
      [['fullscreen','На весь екран','Поверх оформлення сайту, як у прикладах.'],['inline','Усередині сторінки','Для порожнього шаблону або блоку в статті.']].forEach(([value,label,description])=>{html+='<label class="mode-option"><input type="radio" name="mode" data-path="mode" value="'+value+'"'+(data.mode===value?' checked':'')+'><span><strong>'+label+'</strong><small>'+description+'</small></span></label>';});
      html+='</div><p class="helper">Режим на весь екран потрібно перевірити на твоїй темі WordPress. Код не видаляє стандартне меню сайту.</p>';
    }
    $('form-panel').innerHTML=html;
  }
  function setPath(path,value) {
    if(path==='contentMode'&&value!=='builder'&&value!=='html')return;
    if(path==='fontFamily' && !['Arial','Georgia','Verdana','Trebuchet MS','system-ui'].includes(value))return;
    if(path==='fontFamily' || path.startsWith('colors.'))delete data.designVariant;
    if(path==='importChrome'&&value!=='add'&&value!=='none')return;
    if(path==='importHtml'&&(typeof value!=='string'||value.length>HTML_LIMIT))return;
    const parts=path.split('.');
    if(parts.length===1 && topFields.has(parts[0])) data[parts[0]]=value;
    else if(parts.length===2 && parts[0]==='colors' && ['background','accent','header','card'].includes(parts[1])) data.colors[parts[1]]=value;
    else if(parts.length===3 && Object.prototype.hasOwnProperty.call(collectionFields,parts[0]) && /^\d+$/.test(parts[1]) && collectionFields[parts[0]].includes(parts[2]) && data[parts[0]]?.[Number(parts[1])]) data[parts[0]][Number(parts[1])][parts[2]]=value;
  }
  function persist() {
    try {localStorage.setItem(STORAGE,JSON.stringify(data));storageAvailable=true;$('save-state').textContent='Чернетку збережено';}
    catch (_) {storageAvailable=false;$('save-state').textContent='Не вдалося зберегти — завантаж JSON';}
  }
  function exportReady() {
    return data.contentMode!=='html'||Boolean((data.importHtml||'').trim())&&!htmlAnalysis()?.error;
  }
  function requireExportReady() {
    if(exportReady())return true;
    toast('Додай коректний HTML і перевір підказки перед копіюванням або завантаженням.',true);return false;
  }
  function renderOutput() {
    clearTimeout(updateTimer);
    const ready=exportReady();
    ['copy-main','download-snippet','download-page','select-code'].forEach(id=>{$(id).disabled=!ready;});
    const html=ready?core.renderSnippet(data):'';
    $('output-code').value=html;
    $('preview-frame').srcdoc=core.renderDocument(data).replace(/<head>/i,'<head><base href="about:srcdoc">');
    $('code-size').textContent=(new TextEncoder().encode(html).length/1024).toFixed(1)+' KB · HTML + CSS + JS';
    const warnings=core.validateConfig(data);
    $('warnings').hidden=!warnings.length;
    $('warnings').innerHTML=warnings.length?'<strong>Перед публікацією:</strong><ul>'+warnings.slice(0,8).map(w=>'<li>'+esc(w)+'</li>').join('')+(warnings.length>8?'<li>Ще '+(warnings.length-8)+' підказок — перевір решту полів.</li>':'')+'</ul>':'';
    $('preview-status').textContent=(data.contentMode==='html'?'Готовий HTML · ':'')+(data.mode==='fullscreen'?'На весь екран':'Усередині сторінки');
    refreshHTMLAnalysis();
    refreshLinkAudit(ready);
  }
  function refreshLinkAudit(ready) {
    const available=ready&&typeof core.analyzeLinks==='function';
    let audit=null;
    try {if(available)audit=core.analyzeLinks(data);} catch(_) {}
    const urls=audit&&Array.isArray(audit.urls)?audit.urls:[];
    $('link-audit-count').textContent=audit?urls.length+' унікальних адрес':'Додай сторінку для перевірки';
    $('link-audit-list').innerHTML=urls.map(url=>'<li><code>'+esc(url)+'</code></li>').join('');
    $('link-audit-empty').hidden=Boolean(urls.length);
    $('link-audit-empty').textContent=audit?'Зовнішніх адрес у цьому варіанті ще немає.':'Список з’явиться, коли сторінка буде готова до експорту.';
    $('link-audit-note').textContent=audit?'Переходів: '+audit.totalControls+'. Повторних кнопок або брендів: '+audit.duplicateControls+'. Кожна повна адреса має одне звичайне посилання в HTML. Повторні переходи працюють через JavaScript. Адреси й параметри не змінюються.':'Тут показуємо лише адреси переходів із твоєї сторінки. Зображення та переходи до розділів не враховуються.';
  }
  function projectChanged() {revision++;if(aiController)aiController.onProjectChange();}
  function changed() {projectChanged();persist();clearTimeout(updateTimer);updateTimer=setTimeout(renderOutput,240);}
  function toast(message,error=false) {clearTimeout(toastTimer);$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,error?7000:4000);}
  function requestConfirmation(title,message,label) {
    if(confirmationResolve)return Promise.resolve(false);
    $('confirmation-title').textContent=title;
    $('confirmation-message').textContent=message;
    $('confirmation-accept').textContent=label;
    return new Promise(resolve=>{
      confirmationResolve=resolve;
      $('confirm-dialog').showModal();
      $('confirmation-cancel').focus();
    });
  }
  function finishConfirmation(accepted) {
    const resolve=confirmationResolve;
    confirmationResolve=null;
    if($('confirm-dialog').open)$('confirm-dialog').close();
    if(resolve)resolve(accepted);
  }
  function showView(view) {
    currentView=view;
    $('preview-stage').hidden=view!=='preview';$('code-stage').hidden=view!=='code';
    document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===view);b.setAttribute('aria-pressed',String(b.dataset.view===view));});
    if(view==='code') $('output-code').value=exportReady()?core.renderSnippet(data):'';
  }
  function selectCode() {if(!requireExportReady())return;showView('code');$('output-code').focus();$('output-code').select();}
  function fileName() {const title=data.contentMode==='html'?htmlAnalysis()?.title:data.title;return (title||'pageposter').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'').slice(0,65)||'pageposter';}
  function download(content,name,type) {const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function newItem(kind) {
    if(kind==='cards'||kind==='moreCards')return {name:'Нова пропозиція',image:'',bonus:'',rating:'',url:'',logoUrl:'',button:'',note:'',features:'',payout:'',payoutNote:''};
    if(kind==='navLinks')return {name:'Новий пункт меню',url:''};
    if(kind==='tiles'||kind==='services')return {name:kind==='tiles'?'Нова плитка':'Нова категорія',image:'',body:'',url:''};
    if(kind==='sections')return {title:'Новий розділ',body:'',image:''};
    if(kind==='reviews')return {title:'Новий огляд',image:'',body:'',url:''};
    return {question:'Нове запитання',answer:''};
  }
  $('form-panel').addEventListener('input',event=>{
    const control=event.target.closest('[data-path]');if(!control)return;
    if(control.dataset.path==='importHtml'&&control.value.length>HTML_LIMIT){control.value=data.importHtml||'';toast('HTML завеликий. Максимум — 500 000 символів. Попередній код збережено.',true);return;}
    setPath(control.dataset.path,control.type==='checkbox'?control.checked:control.value);
    const summary=control.closest('.collection-item')?.querySelector('.item-name');
    if(summary&&/\.(name|title|question)$/.test(control.dataset.path))summary.textContent=control.value||'Без назви';
    changed();
    if(['contentMode','importChrome','importReplaceHeader','importReplaceFooter'].includes(control.dataset.path))renderForm();
  });
  $('form-panel').addEventListener('paste',event=>{
    const control=event.target.closest('[data-path="importHtml"]');if(!control||!event.clipboardData)return;
    const pasted=event.clipboardData.getData('text/plain');
    if(control.value.length-(control.selectionEnd-control.selectionStart)+pasted.length>HTML_LIMIT){event.preventDefault();toast('HTML завеликий. Максимум — 500 000 символів. Попередній код збережено.',true);}
  });
  $('form-panel').addEventListener('toggle',event=>{
    if(event.target.matches('.collection-item')){
      const {kind,index}=event.target.dataset;
      if(event.target.open)openItems[kind]=Number(index);
      else if(openItems[kind]===Number(index))openItems[kind]=-1;
    }
    if(event.target.matches('.editor-group'))openGroups[event.target.dataset.group]=event.target.open;
  },true);
  $('form-panel').addEventListener('click',event=>{
    const htmlButton=event.target.closest('[data-html-action]');
    if(htmlButton){
      if(htmlButton.dataset.htmlAction==='load')$('html-import-file').click();
      else if(htmlButton.dataset.htmlAction==='show'){activeTab='html';renderForm();}
      else if(htmlButton.dataset.htmlAction==='builder')switchContentMode('builder','base');
      return;
    }
    const designButton=event.target.closest('[data-design-action="next"]');
    if(designButton){if(data.contentMode==='html')return;data=nextDesign(data);renderForm();changed();toast('Оформлення змінено. Тексти та посилання збережено.');return;}
    const presetButton=event.target.closest('[data-preset]');
    if(presetButton){delete data.designVariant;data.preset=presetButton.dataset.preset;data.colors=clone(core.PRESETS[data.preset].colors);renderForm();changed();return;}
    const button=event.target.closest('[data-action]');if(!button)return;
    const {kind,action}=button.dataset;const index=Number(button.dataset.index);
    if(!Object.prototype.hasOwnProperty.call(collectionFields,kind))return;
    if(!Array.isArray(data[kind]))data[kind]=[];
    const list=data[kind];
    if(action==='add'){
      if(list.length>=100){toast('Можна додати до 100 елементів.',true);return;}
      list.push(newItem(kind));openItems[kind]=list.length-1;
    }else if(action==='remove'){
      if(!Number.isInteger(index)||index<0||index>=list.length)return;
      list.splice(index,1);openItems[kind]=Math.min(index,list.length-1);
    }else if(action==='up'||action==='down'){
      const target=index+(action==='up'?-1:1);if(!Number.isInteger(index)||index<0||index>=list.length||target<0||target>=list.length)return;
      [list[index],list[target]]=[list[target],list[index]];openItems[kind]=target;
    }else return;
    renderForm();changed();
    const item=$('form-panel').querySelector('[data-kind="'+kind+'"][data-index="'+openItems[kind]+'"]');
    if(item)item.scrollIntoView({block:'nearest',behavior:'smooth'});
  });
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{activeTab=b.dataset.tab;renderForm();$('form-panel').scrollTop=0;}));
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
  document.querySelectorAll('[data-device]').forEach(b=>b.addEventListener('click',()=>{showView('preview');$('browser-frame').classList.toggle('mobile',b.dataset.device==='mobile');document.querySelectorAll('[data-device]').forEach(c=>{c.classList.toggle('active',c===b);c.setAttribute('aria-pressed',String(c===b));});}));
  $('copy-main').addEventListener('click',async()=>{
    if(!requireExportReady())return;
    const html=core.renderSnippet(data);$('output-code').value=html;
    try {if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(html);toast('Код скопійовано. Встав його в блок «Довільний HTML».');}
    catch (_) {selectCode();toast('Код виділено. Натисни Ctrl+C (або ⌘C), щоб скопіювати.');}
  });
  $('select-code').addEventListener('click',selectCode);
  $('download-snippet').addEventListener('click',()=>{if(!requireExportReady())return;download(core.renderSnippet(data),fileName()+'-wordpress.html','text/html;charset=utf-8');toast('Код для WordPress завантажено.');});
  $('download-page').addEventListener('click',()=>{if(!requireExportReady())return;download(core.renderDocument(data),fileName()+'-preview.html','text/html;charset=utf-8');toast('Готову сторінку збережено. Відкрий HTML-файл у браузері.');});
  const cleanLinksBundle=window.PagePosterDownloads&&window.PagePosterDownloads.cleanLinks;
  $('download-clean-links').disabled=!cleanLinksBundle||!cleanLinksBundle.base64;
  $('plugin-version').textContent=cleanLinksBundle?'v'+cleanLinksBundle.version:'ZIP не завантажено';
  $('download-clean-links').addEventListener('click',()=>{
    if(!cleanLinksBundle||!cleanLinksBundle.base64){toast('Файл плагіна недоступний. Онови інструмент і спробуй ще раз.',true);return;}
    try {
      const binary=atob(cleanLinksBundle.base64);
      const bytes=Uint8Array.from(binary,character=>character.charCodeAt(0));
      download(bytes,cleanLinksBundle.filename||'pageposter-clean-links.zip','application/zip');
      toast('ZIP плагіна завантажено. Встанови й активуй його у WordPress.');
    } catch(_) {toast('Не вдалося підготувати ZIP плагіна. Онови інструмент і спробуй ще раз.',true);}
  });
  $('backup-btn').addEventListener('click',()=>{download(JSON.stringify(data,null,2),fileName()+'.json','application/json;charset=utf-8');toast('Чернетку збережено у файл.');});
  $('import-btn').addEventListener('click',()=>$('import-file').click());
  $('html-import-file').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    const startedRevision=revision;
    try {
      if(!/\.html?$/i.test(file.name))throw new Error('Вибери HTML-файл із розширенням .html або .htm.');
      if(file.size>HTML_LIMIT)throw new Error('Файл завеликий. Максимум — 500 KB. Попередній код збережено.');
      const source=(await file.text()).replace(/^\uFEFF/,'');
      if(source.length>HTML_LIMIT)throw new Error('HTML завеликий. Максимум — 500 000 символів. Попередній код збережено.');
      if(revision!==startedRevision)throw new Error('Чернетка змінилася під час читання файлу. Відкрий файл ще раз.');
      data.importHtml=source;activeTab='html';projectChanged();renderForm();persist();renderOutput();
      toast(data.contentMode==='html'?'HTML-файл відкрито. Перевір попередній перегляд.':'HTML-файл відкрито. Вибери режим «Готовий HTML», щоб показати його.');
    } catch(error){toast(error.message||'Не вдалося прочитати HTML-файл.',true);}
    finally{event.target.value='';}
  });
  $('import-file').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    try{
      if(file.size>64*1024*1024)throw new Error('Файл завеликий. Максимум — 64 MB.');
      const parsed=JSON.parse((await file.text()).replace(/^\uFEFF/,''));
      if(!validProject(parsed))throw new Error('Це не чернетка PagePoster. Вибери JSON-файл, збережений у цьому інструменті.');
      if(!(await requestConfirmation('Відкрити іншу чернетку?','Це замінить поточну чернетку даними з вибраного JSON-файлу. Щоб залишити свої зміни, скасуй дію й спочатку збережи їх у JSON.','Відкрити чернетку')))return;
      data=core.normalizeConfig(parsed);if(data.contentMode==='html')activeTab='html';projectChanged();openItems=freshOpenItems();renderForm();persist();renderOutput();toast('Чернетку відкрито.');
    }catch(error){toast(error instanceof SyntaxError?'Не вдалося прочитати JSON-файл. Перевір його формат.':error.message,true);}
    finally{event.target.value='';}
  });
  $('reset-btn').addEventListener('click',async()=>{
    if(!(await requestConfirmation('Завантажити повний приклад?','Це замінить поточну чернетку заповненим прикладом. Щоб залишити свої зміни, скасуй дію й спочатку збережи їх у JSON.','Завантажити приклад')))return;
    data=clone(core.DEFAULT_DATA);projectChanged();activeTab='base';openItems=freshOpenItems();renderForm();persist();renderOutput();toast('Повний приклад завантажено. Усі блоки можна редагувати.');
  });
  $('confirmation-accept').addEventListener('click',()=>finishConfirmation(true));
  ['confirmation-cancel','confirmation-close'].forEach(id=>$(id).addEventListener('click',()=>finishConfirmation(false)));
  $('confirm-dialog').addEventListener('cancel',event=>{event.preventDefault();finishConfirmation(false);});
  $('confirm-dialog').addEventListener('close',()=>finishConfirmation(false));
  $('help-open').addEventListener('click',()=>$('help-dialog').showModal());
  ['help-close','help-done'].forEach(id=>$(id).addEventListener('click',()=>$('help-dialog').close()));
  $('help-dialog').addEventListener('click',event=>{if(event.target===$('help-dialog')){const rect=$('help-dialog').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('help-dialog').close();}});
  if(location.protocol==='file:'&&$('download-offline'))$('download-offline').hidden=true;
  if(window.PagePosterAIUI&&window.PagePosterAI)aiController=window.PagePosterAIUI.create({
    element:$('ai-panel'),getData:()=>data,getRevision:()=>revision,toast,
    core:{...window.PagePosterAI,createProject:(existing,links,projectOptions)=>nextDesign(window.PagePosterAI.createProject(existing,links,projectOptions))},
    switchToBuilder:()=>switchContentMode('builder','ai'),
    replaceData:next=>{data=next;revision++;openItems=freshOpenItems();renderForm();persist();renderOutput();}
  });
  else $('ai-panel').textContent='Не вдалося завантажити помічника. Онови сторінку. Ручний редактор працює.';
  if(window.PagePosterLifecycleUI&&$('lifecycle-panel')){
    const panel=$('lifecycle-panel');let editorVisibility=null;
    function editorView(){
      $('save-state').hidden=false;panel.hidden=true;$('lifecycle-editor').hidden=true;$('lifecycle-open').hidden=false;
      if(editorVisibility){for(const [element,hidden] of editorVisibility)element.hidden=hidden;editorVisibility=null;}
      renderOutput();
    }
    const projects=window.PagePosterLifecycleUI.create({element:panel,toast,initialTab:'pages',selectFirstProject:true,
      openEditor:tab=>{editorView();activeTab=tab;renderForm();},
      createPageSnapshot:input=>{
        const config=nextDesign(window.PagePosterAI.createProject(clone(core.DEFAULT_DATA),input.links,{cardCount:input.cardCount}));
        config.title=input.keyword;config.keyword=input.keyword;
        return {title:input.keyword,config,uniqueUrls:core.analyzeLinks(config).urls};
      },
      getEditorSnapshot:()=>({config:clone(data),title:data.title,html:core.renderSnippet(data),uniqueUrls:core.analyzeLinks(data).urls}),
      openEditorSnapshot:async config=>{
        if(!validProject(config)){toast('Збережена сторінка не містить чернетки редактора.',true);return false;}
        if(!(await requestConfirmation('Відкрити сторінку з проєкту?','Поточна чернетка редактора буде замінена. За потреби спочатку збережи її у проєкт або JSON.','Відкрити')))return false;
        data=core.normalizeConfig(config);projectChanged();activeTab=data.contentMode==='html'?'html':'base';openItems=freshOpenItems();renderForm();persist();editorView();return true;
      }
    });
    function projectsView(){
      if(!editorVisibility)editorVisibility=Array.from(panel.parentElement.children).filter(e=>e!==panel).map(e=>[e,e.hidden]);
      for(const [element] of editorVisibility)element.hidden=true;
      $('save-state').hidden=true;panel.hidden=false;$('lifecycle-editor').hidden=false;$('lifecycle-open').hidden=true;projects.refresh();
    }
    $('lifecycle-open').addEventListener('click',projectsView);
    if(location.protocol!=='file:' && (['127.0.0.1','localhost'].includes(location.hostname)||new URLSearchParams(location.search).get('workspace')==='projects') && new URLSearchParams(location.search).get('workspace')!=='editor')projectsView();
    $('lifecycle-editor').addEventListener('click',editorView);
  }
  renderForm();renderOutput();showView(currentView);
  if(imported)$('save-state').textContent='Чернетку відновлено';
  else if(storageAvailable)$('save-state').textContent='Зміни збережуться автоматично';
})();
