(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./page-runtime.js'), require('css-tree'), require('./link-placements.js'));
  else root.PagePoster = factory(root.PagePosterRuntime, root.csstree, root.PagePosterLinkPlacements);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (pageRuntime, cssTree, linkPlacements) {
  'use strict';

  var PRESETS = {
    emerald: { name: 'Optek', description: 'Синювате тло, темний хедер і чотири колонки пропозицій.', colors: { background: '#f6feff', accent: '#d9361c', header: '#080220', card: '#0c6c4b' } },
    forest: { name: 'JADPN', description: 'Світле бузкове тло, зелений хедер і пунктирні акценти.', colors: { background: '#faf8fc', accent: '#d9361c', header: '#082c00', card: '#116b3a' } },
    rose: { name: 'Atlas', description: 'Тепле тло, зелені градієнтні картки та рожеві кнопки.', colors: { background: '#fbf9f8', accent: '#fa78b9', header: '#171717', card: '#293f2d' } }
  };
  function demoCard(name, index) {
    return { name: name, image: '', bonus: ['Welcome package\nAdd verified offer terms', 'Explore the collection\nAdd your current offer', 'A fresh place to start\nReplace with checked details'][index % 3], rating: ['4.9', '4.8', '4.7', '4.6', '4.5'][index % 5], url: 'https://example.com/' + name.toLowerCase().replace(/\s+/g, '-'), button: 'VIEW OFFER', note: 'Illustrative demo · replace before publishing', features: 'Add a verified highlight\nExplain eligibility and limits', payout: 'Payment details', payoutNote: 'Add verified methods and timing' };
  }
  var DEFAULT_DATA = {
    version: 1, contentMode: 'builder', chromeMode: 'custom', importHtml: '', importBaseUrl: '', importChrome: 'add', importReplaceHeader: false, importReplaceFooter: false, brand: 'NORTHSTAR', brandTagline: 'YOUR INDEPENDENT GUIDE', brandUrl: '', brandImage: '',
    title: 'Find your next favourite place to play',
    intro: 'A considered shortlist, clear comparisons and practical guides in one place. This is a demo page: all brands, offers and ratings below are illustrative placeholders. Replace them with your own verified content before publishing.',
    author: 'Editorial team', authorImage: '', date: '',
    cardsTitle: 'Featured offers', moreCardsTitle: 'More places to explore', articleTitle: 'A practical guide to making a considered choice', faqTitle: 'Frequently asked questions',
    columnBrand: 'BRAND', columnBonus: 'WELCOME OFFER', columnRating: 'OUR RATING', columnAction: 'EXPLORE',
    tilesTitle: 'Everything you need to get started', tilesIntro: 'Browse the topics that matter to you, then add links to your own detailed guides.',
    servicesTitle: 'Discover a different way to play', servicesIntro: 'Four editable categories to connect the shortlist with your own specialist guides.',
    promoTitle: 'Not sure where to begin?', promoBody: 'Start with the details that matter to you. Use our **editable comparison checklist** to organise your own research, then explore the full guide below.', promoButton: 'EXPLORE THE GUIDE', promoUrl: 'https://example.com/guide',
    showToc: true, tocTitle: 'In this guide', tableTitle: 'Compare the details that matter',
    tableText: 'What to compare | What to record | Where to check\nOffer conditions | Eligibility and limits | Current provider terms\nPayment options | Available methods and timing | Provider payment page\nAccount setup | Required steps and information | Registration guide\nMobile experience | Layout and available features | Your own device checks\nCustomer support | Channels and operating hours | Current support page\nReview date | When each detail was checked | Your editorial notes',
    reviewsTitle: 'A closer look at the shortlist', footerTitle: 'About this guide', footerLinksTitle: 'Explore',
    footer: 'This page is an editable demonstration. It does not recommend real providers, make verified rating claims, or describe live offers. Add your own publication information and disclosure here.',
    footerNote: '© Your brand. Replace all demonstration content before publishing.',
    ctaLabel: 'VIEW OFFER', preset: 'emerald', mode: 'fullscreen',
    colors: { background: '#f6feff', accent: '#d9361c', header: '#080220', card: '#0c6c4b' },
    cards: ['NOVA PLAY', 'AURORA', 'ORBIT CLUB', 'LUMEN', 'VELVET'].map(demoCard),
    moreCards: ['SOLSTICE', 'PINE CLUB', 'MONARCH', 'BLUE HOUR', 'MOSAIC', 'NORTH BAY', 'LANTERN', 'CLOVER ROOM', 'MELLOW', 'DAYBREAK'].map(demoCard),
    navLinks: [],
    services: ['Classic collections', 'Live experiences', 'New discoveries', 'Mobile favourites'].map(function (name, index) { return { name: name, image: '', body: 'Add a checked overview and connect this category to your own guide.', url: 'https://example.com/category-' + (index + 1) }; }),
    tiles: [
      { name: 'Welcome offers', image: '', body: 'Make the headline easy to understand. Explain the conditions that determine whether an offer is useful to your readers.', url: 'https://example.com/welcome-offers' },
      { name: 'Payment options', image: '', body: 'Set out the available methods, their practical limits and where visitors can confirm the latest provider information.', url: 'https://example.com/payments' },
      { name: 'Mobile experience', image: '', body: 'Describe how the service works on a smaller screen, using observations from your own checks and clear examples.', url: 'https://example.com/mobile' },
      { name: 'Terms explained', image: '', body: 'Turn dense conditions into a readable guide. Keep important details close to the offer they describe.', url: 'https://example.com/terms' },
      { name: 'Support options', image: '', body: 'Show readers where to find help and which questions to ask before opening an account or using a service.', url: 'https://example.com/support' },
      { name: 'Getting started', image: '', body: 'Provide a short, useful path from reading a comparison to checking the information directly with the provider.', url: 'https://example.com/getting-started' },
      { name: 'Fresh arrivals', image: '', body: 'Introduce new additions with a clear summary of the details your team has checked.', url: 'https://example.com/new' },
      { name: 'Classic favourites', image: '', body: 'Organise familiar categories and explain the features that define each one.', url: 'https://example.com/classics' },
      { name: 'Quick comparisons', image: '', body: 'Help readers compare the same practical details across a shorter selection.', url: 'https://example.com/compare' },
      { name: 'Reader questions', image: '', body: 'Bring together useful answers and link to the relevant source material.', url: 'https://example.com/questions' },
      { name: 'Editorial notes', image: '', body: 'Explain your research process and show when important details were reviewed.', url: 'https://example.com/editorial' },
      { name: 'Useful resources', image: '', body: 'Collect primary sources and further reading to support your own original guide.', url: 'https://example.com/resources' }
    ],
    sections: [
      { title: 'Start with the experience you are looking for', image: '', body: 'A useful comparison starts with a clear question. Are readers exploring something new, comparing familiar options, or checking one particular feature? Describe that purpose before presenting a long list of names. It gives the page a direction and helps visitors understand what the shortlist is designed to do.\n\nThis demonstration leaves room for your own research and editorial judgement. Replace every example with material you have checked, and explain the audience your guide serves. A concise introduction, a clear shortlist and a few practical next steps can be more useful than a page filled with unsupported superlatives.' },
      { title: 'Read the whole offer, not just the headline', image: '', body: 'A headline is only the beginning of an offer. Put the most relevant conditions beside it so that readers can understand the context without searching through the entire page. Explain who the offer is intended for, which limits apply and where the complete information can be found.\n\n## Details to record\n- The exact offer wording at the time of your check.\n- Eligibility, exclusions and any important limits.\n- A link to the provider’s current terms.\n- The date your editorial team last reviewed the information.\n\nUse the comparison below as an editing checklist. It is a template for your research, rather than a statement about any real provider.' },
      { title: 'Build a comparison readers can follow', image: '', body: 'Choose a small set of criteria and apply them consistently across the shortlist. If one entry explains support hours while another only lists a promotional headline, the comparison becomes difficult to use. A shared structure makes differences easier to understand and missing information easier to spot.\n\nKeep observations separate from opinions. Describe what you checked, what you found and how that affected your assessment. Where a detail could not be verified, say so plainly. You can use the cards above for a quick overview and the article sections for the context that would otherwise make each card too long.' },
      { title: 'Look at payment information in context', image: '', body: 'Payment information is most useful when it is specific. A list of logos alone does not explain whether a method is available to a particular reader or which conditions apply. Record the provider’s published information, then direct readers to the source for the latest details.\n\nAvoid turning an estimated processing window into a promise. Timing may depend on the method, account checks and the provider’s own procedures. In your finished page, replace the placeholder payment captions with carefully checked wording and keep the supporting explanation close enough for readers to find it.' },
      { title: 'Check the mobile journey from start to finish', image: '', body: 'A service can look attractive on a desktop screen and still be awkward to use on a phone. Describe the complete mobile journey: opening the page, finding essential information, reading conditions and reaching support. These ordinary tasks often reveal more than a screenshot of the home page.\n\n## A simple review checklist\n- Are headings and controls easy to read?\n- Can visitors find the same information on a small screen?\n- Do forms and navigation behave as expected?\n- Is important content visible without unnecessary steps?\n\nAdd your own device checks and observations before making any assessment.' },
      { title: 'Understand the account setup process', image: '', body: 'Readers appreciate knowing what to expect before they begin. Explain the main steps in an account setup process without asking them to share private information with your publication. Link to the provider’s own instructions where the requirements need a more detailed explanation.\n\nKeep this section practical. Describe the sequence, identify where readers can get help and clarify which information comes from the provider. If a process changes, update the guide and its review date. The aim is to make the next step understandable while leaving account decisions and personal information with the reader.' },
      { title: 'Make support information easy to find', image: '', body: 'Support is part of the overall experience, so it deserves a place in the comparison. Record the published contact channels, the availability information and the location of any useful help articles. If you have tested a channel yourself, explain the scope of that check rather than treating one interaction as a universal result.\n\nUseful support summaries answer simple questions: where should a reader start, what information should they have ready, and where can they find the provider’s own help resources? Replace this demonstration paragraph with your checked notes and a direct source link.' },
      { title: 'Explain how your ratings are created', image: '', body: 'The ratings on this demo are illustrative. In a published comparison, readers should be able to understand what a score represents. Define the criteria, explain how they are weighted and describe the evidence used to reach an assessment.\n\nA number is most useful when it is supported by a readable explanation. Include both strengths and limitations, and avoid suggesting a level of precision that your research does not support. If you do not use a documented rating method, leave the rating field blank and let the written comparison do the work.' },
      { title: 'Keep the page current and transparent', image: '', body: 'Comparison pages need maintenance. Offers, features and contact information can change after publication, so decide which details your team will review and how those checks will be recorded. A visible author and update date help readers understand the source and age of the material.\n\nBe clear about commercial relationships and the purpose of outbound links. Use your own appropriate disclosure in the footer and beside relevant content where needed. This template provides the space; your finished wording should reflect the way your publication actually works.' },
      { title: 'Use the shortlist as a starting point', image: '', body: 'A good guide helps readers ask better questions. It can organise information, explain differences and point to primary sources, but it should not replace checking the current details directly. End the page with a small number of practical actions that match the purpose of your article.\n\nReview the options that seem relevant, read the complete conditions and confirm any detail that matters to your decision. For this demonstration, every brand link leads to an example address. Replace those destinations, remove any blocks you do not need and check the finished page before sharing it.' }
    ],
    faq: [
      { question: 'Are these real brands and offers?', answer: 'No. This is a demo with fictional brand names, illustrative ratings and placeholder offers. Replace the examples with your own verified material before publishing.' },
      { question: 'How should I compare the options?', answer: 'Choose criteria that are useful to your audience, apply them consistently and explain the evidence behind your assessment. The table in this guide is an editable starting point.' },
      { question: 'Where should readers check current terms?', answer: 'Use direct links to the provider’s current information. Keep important conditions beside the offer and make the source easy to find.' },
      { question: 'What does the rating mean?', answer: 'The numbers in this template are illustrative. Explain your own rating method in the finished article, or leave the rating fields blank if you do not use one.' },
      { question: 'How often should this page be updated?', answer: 'Set a review process that fits the information you publish. Update changed details promptly and use the author and date fields to show when your content was checked.' }
    ],
    reviews: ['NOVA PLAY', 'AURORA', 'ORBIT CLUB', 'LUMEN', 'VELVET', 'SOLSTICE', 'PINE CLUB', 'MONARCH', 'BLUE HOUR', 'MOSAIC'].map(function (name) { return { title: name + ': a closer look', image: '', body: 'Demo editorial summary. Add a concise overview of the experience, the details you checked and the readers it may be relevant to. Link to your complete review for context.', url: 'https://example.com/reviews/' + name.toLowerCase().replace(/\s+/g, '-') }; })
  };
  var own = function (value, key) { return Object.prototype.hasOwnProperty.call(value, key); };
  var object = function (value) { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}; };
  function field(source, key, fallback, limit) {
    var value = own(source, key) ? source[key] : fallback;
    if (/^(?:url|image|logoUrl|.*Url|.*Image)$/.test(key)) return typeof value === 'string' ? value : '';
    return typeof value === 'string' ? value.slice(0, limit) : typeof value === 'number' && Number.isFinite(value) ? String(value).slice(0, limit) : '';
  }
  function color(value, fallback) {
    if (typeof value !== 'string') return fallback;
    value = value.trim();
    if (/^#[0-9a-f]{3}$/i.test(value)) value = '#' + value.slice(1).split('').map(function (c) { return c + c; }).join('');
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  }
  function rating(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return '';
    var text = String(value).trim().replace(',', '.');
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) return '';
    var number = Number(text);
    return Number.isFinite(number) ? String(Math.round(Math.max(0, Math.min(5, number)) * 10) / 10) : '';
  }
  function rows(source, key, mapper, fallback) {
    var list = own(source, key) ? source[key] : fallback;
    return Array.isArray(list) ? list.slice(0, 100).map(function (row) { var value=mapper(object(row));if(row&&typeof row._ppRowId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(row._ppRowId))value._ppRowId=row._ppRowId;return value; }) : [];
  }
  function normalizeCard(row) {
    var card = { rating: rating(own(row, 'rating') ? row.rating : '') };
    var limits = { name: 300, image: 4000, bonus: 3000, url: 4000, logoUrl: 4000, button: 100, note: 2000, features: 4000, payout: 300, payoutNote: 1000 };
    Object.keys(limits).forEach(function (key) { card[key] = field(row, key, '', limits[key]); });

    return card;
  }
  function languageTag(value) {
    var text=String(value||'').trim(),names={english:'en',ukrainian:'uk',polish:'pl',german:'de',french:'fr',spanish:'es',italian:'it',portuguese:'pt',dutch:'nl',russian:'ru',czech:'cs',romanian:'ro',turkish:'tr',japanese:'ja',chinese:'zh',arabic:'ar','українська':'uk','англійська':'en','польська':'pl','польською':'pl'};
    if(names[text.toLowerCase()])return names[text.toLowerCase()];
    if(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(text)){try{return Intl.getCanonicalLocales(text)[0];}catch(_){}}
    return 'und';
  }
  function oversizedUrls(config) {
    var issues=[];
    function visit(value,path){if(!value||typeof value!=='object')return;Object.keys(value).forEach(function(key){var entry=value[key],location=path?path+'.'+key:key;if(typeof entry==='string'&&/^(?:url|image|logoUrl|.*Url|.*Image)$/.test(key)&&entry.length>4000)issues.push(location+': URL перевищує 4000 символів. Збережено повну адресу; скороти її вручну.');else if(entry&&typeof entry==='object')visit(entry,location);});}
    visit(config,'');return issues;
  }
  function normalizeConfig(input) {
    var source = input === undefined ? DEFAULT_DATA : object(input);
    var preset = own(source, 'preset') && typeof source.preset === 'string' && own(PRESETS, source.preset) ? source.preset : 'emerald';
    var palette = PRESETS[preset].colors, inputColors = object(own(source, 'colors') ? source.colors : null);
    var config = { version: 1, language: languageTag(source.language || 'uk') };
    var limits = { brand: 200, title: 500, intro: 5000, author: 200, date: 10, cardsTitle: 300, articleTitle: 300, faqTitle: 300, footer: 5000, ctaLabel: 100 };
    var added = { servicesTitle: 300, servicesIntro: 5000, promoTitle: 500, promoBody: 10000, promoButton: 100, promoUrl: 4000, brandUrl: 4000, footerBrandUrl: 4000, brandImage: 4000, brandTagline: 300, authorImage: 4000, tocTitle: 300, tilesTitle: 300, tilesIntro: 5000, tableTitle: 300, tableText: 50000, moreCardsTitle: 300, reviewsTitle: 300, footerTitle: 300, footerLinksTitle: 300, footerNote: 5000, columnBrand: 100, columnBonus: 100, columnRating: 100, columnAction: 100 };
    Object.keys(limits).forEach(function (key) { config[key] = field(source, key, DEFAULT_DATA[key], limits[key]); });
    Object.keys(added).forEach(function (key) { config[key] = field(source, key, key.indexOf('column') === 0 ? DEFAULT_DATA[key] : '', added[key]); });

    if (!/^\d{4}-\d{2}-\d{2}$/.test(config.date) || Number.isNaN(Date.parse(config.date + 'T00:00:00Z')) || new Date(config.date + 'T00:00:00Z').toISOString().slice(0, 10) !== config.date) config.date = '';
    config.preset = preset;
    config.fontFamily=['Arial','Georgia','Verdana','Trebuchet MS','system-ui'].indexOf(source.fontFamily)!==-1?source.fontFamily:'Arial';
    if(source.designVariant&&typeof source.designVariant==='object')config.designVariant=JSON.parse(JSON.stringify(source.designVariant));
    if(Array.isArray(source.aiLinkInsertions)&&source.aiLinkInsertions.length)config.aiLinkInsertions=JSON.parse(JSON.stringify(source.aiLinkInsertions));
    config.mode = own(source, 'mode') && source.mode === 'inline' ? 'inline' : 'fullscreen';
    config.contentMode = source.contentMode === 'html' ? 'html' : 'builder';
    config.chromeMode = source.chromeMode === 'overlay-only' ? 'overlay-only' : 'custom';
    if (['article','guide','comparison','discussion','blog_post','faq'].indexOf(source.editorialFormat) !== -1) config.editorialFormat = source.editorialFormat;
    if(config.editorialFormat&&Number.isSafeInteger(source.editorialVariant)&&source.editorialVariant>=0&&source.editorialVariant<1000000000)config.editorialVariant=source.editorialVariant;
    config.importHtml = field(source, 'importHtml', '', 500001);
    config.importBaseUrl = field(source, 'importBaseUrl', '', 4000);
    config.importChrome = source.importChrome === 'none' ? 'none' : 'add';
    config.importReplaceHeader = source.importReplaceHeader === true;
    config.importReplaceFooter = source.importReplaceFooter === true;
    config.showToc = own(source, 'showToc') && source.showToc === true;
    config.colors = {};
    Object.keys(palette).forEach(function (key) { config.colors[key] = color(own(inputColors, key) ? inputColors[key] : null, palette[key]); });
    config.cards = rows(source, 'cards', normalizeCard, DEFAULT_DATA.cards);
    config.moreCards = rows(source, 'moreCards', normalizeCard, []);
    config.sections = rows(source, 'sections', function (row) { return { title: field(row, 'title', '', 500), body: field(row, 'body', '', 50000), image: field(row, 'image', '', 4000) }; }, DEFAULT_DATA.sections);
    config.faq = rows(source, 'faq', function (row) { return { question: field(row, 'question', '', 1000), answer: field(row, 'answer', '', 20000) }; }, DEFAULT_DATA.faq);
    config.tiles = rows(source, 'tiles', function (row) { return { name: field(row, 'name', '', 300), image: field(row, 'image', '', 4000), body: field(row, 'body', '', 10000), url: field(row, 'url', '', 4000) }; }, []);
    config.services = rows(source, 'services', function (row) { return { name: field(row, 'name', '', 300), image: field(row, 'image', '', 4000), body: field(row, 'body', '', 10000), url: field(row, 'url', '', 4000) }; }, []);
    config.reviews = rows(source, 'reviews', function (row) { return { title: field(row, 'title', '', 500), image: field(row, 'image', '', 4000), body: field(row, 'body', '', 20000), url: field(row, 'url', '', 4000) }; }, []);
    config.navLinks = rows(source, 'navLinks', function (row) { return { name: field(row, 'name', '', 200), url: field(row, 'url', '', 4000) }; }, []);
    return config;
  }
  function escape(value) {
    return String(value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  // Preserve intentional line breaks without giving wpautop raw newlines to expand.
  function textLines(value) { return escape(value).replace(/\r\n?|\n/g, '&#10;'); }
  function safeUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return '';
    try {
      var parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname ? value : '';
    } catch (_) { return ''; }
  }
  function validateConfig(input) {
    var config = normalizeConfig(input), warnings = oversizedUrls(config);
    if (config.contentMode === 'html') return warnings.concat(validateHTMLConfig(config));
    if (!config.title.trim()) warnings.push('Додайте заголовок сторінки.');
    function optionalUrl(url, label) {
      if (url && !safeUrl(url)) warnings.push(label + ': потрібна повна коректна адреса https:// або http://.');
    }
    [['cards', 'Картка'], ['moreCards', 'Додаткова картка']].forEach(function (group) {
      config[group[0]].forEach(function (card, index) {
        var label = group[1] + ' ' + (index + 1);
        if (!card.url) warnings.push(label + ': додайте посилання, щоб показати активну кнопку.');
        else optionalUrl(card.url, label + ', посилання');
        optionalUrl(card.image, label + ', зображення');
      });
    });
    optionalUrl(config.brandUrl, 'Перехід з логотипа бренду');
    optionalUrl(config.footerBrandUrl, 'Перехід з бренду у футері');
    optionalUrl(config.brandImage, 'Зображення логотипа');
    optionalUrl(config.authorImage, 'Фото автора');
    optionalUrl(config.promoUrl, 'Посилання промоблоку');
    [['tiles', 'Плитка'], ['services', 'Сервіс'], ['reviews', 'Огляд'], ['sections', 'Розділ']].forEach(function (group) {
      config[group[0]].forEach(function (item, index) {
        var label = group[1] + ' ' + (index + 1);
        optionalUrl(item.image, label + ', зображення');
        optionalUrl(item.url, label + ', посилання');
      });
    });
    var ids = existingIds(config);
    config.navLinks.forEach(function (link, index) {
      if (!safeUrl(link.url) && !(link.url[0] === '#' && ids.indexOf(link.url.slice(1)) !== -1)) warnings.push('Пункт меню ' + (index + 1) + ': додайте коректний URL або якір на наявний розділ сторінки.');
    });
    return warnings;
  }
  // Interpret a small inline grammar, escaping every literal and URL separately.
  // Nesting is bounded: bold may contain a link and a link label may contain bold.
  function markdownLabelEnd(text,start){var depth=1,index=start+1;for(;index<text.length;index++){if(text[index]==='[')depth++;else if(text[index]===']'&&!--depth)return index;}return -1;}
  function inlineMarkdown(text, allowStrong, allowLinks, tokens) {
    allowStrong = allowStrong !== false;
    allowLinks = allowLinks !== false;
    var result = '', start = 0, cursor = 0;
    while (cursor < text.length) {
      if(text.slice(cursor,cursor+10)==='[[PP_LINK:'){
        var tokenMatch=/^\[\[PP_LINK:([a-zA-Z0-9_-]+)\]\]/.exec(text.slice(cursor));
        if(!tokenMatch||!tokens||!tokens[tokenMatch[1]]||!allowLinks)throw new Error('Недозволена або невідома вставка посилання. Перевір текст і місце вставки.');
        var token=tokens[tokenMatch[1]];result+=escape(text.slice(start,cursor))+'<a href="'+escape(token.url)+'" rel="noopener noreferrer" data-pp-priority="article" data-pp-placement-id="token-'+escape(token.id)+'">'+escape(token.anchor)+'</a>';cursor+=tokenMatch[0].length;start=cursor;continue;
      }
      if (allowStrong && text.slice(cursor, cursor + 2) === '**') {
        var strongEnd = text.indexOf('**', cursor + 2);
        if (strongEnd > cursor + 2) {
          result += escape(text.slice(start, cursor));
          result += '<strong>' + inlineMarkdown(text.slice(cursor + 2, strongEnd), false, allowLinks, tokens) + '</strong>';
          cursor = strongEnd + 2;
          start = cursor;
          continue;
        }
      }
      if (!allowLinks || text[cursor] !== '[') { cursor++; continue; }
      var labelEnd = markdownLabelEnd(text,cursor);
      if (labelEnd < 0 || text[labelEnd + 1] !== '(') { cursor++; continue; }
      var end = labelEnd + 2, depth = 1;
      while (end < text.length && depth) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')') depth--;
        if (depth) end++;
      }
      if (depth) { cursor++; continue; }
      var label = inlineMarkdown(text.slice(cursor + 1, labelEnd), allowStrong, false, tokens);
      var url = safeUrl(text.slice(labelEnd + 2, end).trim());
      result += escape(text.slice(start, cursor));
      result += url ? '<a href="' + escape(url) + '" rel="noopener noreferrer" data-pp-priority="article">' + label + '</a>' : label;
      cursor = end + 1;
      start = cursor;
    }
    return result + escape(text.slice(start));
  }
  function markdown(text, config, fieldPath) {
    var tokens=Object.create(null),insertions=config&&config.aiLinkInsertions;
    if(insertions&&insertions.length){
      if(!linkPlacements)throw new Error('Модуль точних посилань не завантажився. Онови редактор.');
      var plan=linkPlacements.createTokenPlan(config,insertions);
      if(plan.fields[fieldPath])linkPlacements.resolveTokens(text,fieldPath,plan);
      insertions.filter(function(p){return p.fieldPath===fieldPath;}).forEach(function(p){tokens[p.id]=p;});
    }
    var result = [], paragraph = [], list = [];
    function flushParagraph() { if (paragraph.length) { result.push('<p>' + inlineMarkdown(paragraph.join(' '),true,true,tokens) + '</p>'); paragraph = []; } }
    function flushList() { if (list.length) { result.push('<ul>' + list.map(function (line) { return '<li>' + inlineMarkdown(line,true,true,tokens) + '</li>'; }).join('') + '</ul>'); list = []; } }
    text.replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) { flushParagraph(); flushList(); }
      else if (/^##\s+/.test(line)) { flushParagraph(); flushList(); result.push('<h3>' + inlineMarkdown(line.replace(/^##\s+/, ''),true,true,tokens) + '</h3>'); }
      else if (/^-\s+/.test(line)) { flushParagraph(); list.push(line.replace(/^-\s+/, '')); }
      else { flushList(); paragraph.push(line); }
    });
    flushParagraph(); flushList();
    return result.join('');
  }
  function contrast(hex) {
    var parts = [1, 3, 5].map(function (start) {
      var c = parseInt(hex.slice(start, start + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722 > 0.179 ? '#111a16' : '#ffffff';
  }
  // Koncrete hides generic headers and restyles li; all resets stay inside the export.
  // Block wrappers also keep WordPress wpautop paragraphs out of structural grids.
  var styleCacheKey = '', styleCacheValue = '';
  function protectStyles(markup, chromeOnly) {
    var key = (chromeOnly ? 'chrome:' : 'page:') + markup;
    if (key === styleCacheKey) return styleCacheValue;
    var css = markup.slice(7,-8).replace(/#pp-landing/g, '#pp-landing#pp-landing#pp-landing');
    if (!cssTree) throw new Error('Модуль стилів не завантажився. Онови PagePoster.');
    var ast = cssTree.parse(css);
    cssTree.walk(ast, {visit:'Declaration',enter:function(node) { node.important = true; }});
    var root = '#pp-landing#pp-landing';
    var selectors = chromeOnly ? [root,root+'>.pp-header',root+'>.pp-header *',root+'>.pp-footer',root+'>.pp-footer *'] : [root,root+' *',root+' *::before',root+' *::after'];
    var reset = selectors.join(',')+'{all:revert!important;unicode-bidi:normal!important;}';
    styleCacheKey = key; styleCacheValue = '<style>'+reset+cssTree.generate(ast)+'</style>';
    return styleCacheValue;
  }
  function styles(config) {
    var c = config.colors;
    var position = config.mode === 'fullscreen' ? 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;overflow:auto;overscroll-behavior:contain;' : 'position:relative;width:100%;min-height:100vh;';
    return protectStyles(`<style>
#pp-landing{${position}--pp-bg:${c.background};--pp-accent:${c.accent};--pp-header:${c.header};--pp-card:${c.card};--pp-on-bg:${contrast(c.background)};--pp-on-accent:${contrast(c.accent)};--pp-on-header:${contrast(c.header)};--pp-on-card:${contrast(c.card)};background:var(--pp-bg);color:var(--pp-on-bg);font:17px/1.7 ${config.fontFamily === "Trebuchet MS" ? "\"Trebuchet MS\"" : config.fontFamily},Arial,sans-serif;text-align:left;isolation:isolate;overflow-wrap:anywhere;scroll-behavior:smooth;}
#pp-landing *,#pp-landing *::before,#pp-landing *::after{box-sizing:border-box;}
#pp-landing [data-pp-url]{cursor:pointer;}
#pp-landing [data-pp-url]:focus-visible{outline:3px solid currentColor;outline-offset:4px;}
#pp-landing h1,#pp-landing h2,#pp-landing h3,#pp-landing p,#pp-landing ul,#pp-landing ol,#pp-landing figure{margin:0;padding:0;font-family:inherit;color:inherit;}
#pp-landing li{font:inherit;}
#pp-landing .pp-brand-wrap > p:not([class]),#pp-landing .pp-button-wrap > p:not([class]),#pp-landing .pp-link-wrap > p:not([class]),#pp-landing .pp-cover-wrap > p:not([class]),#pp-landing .pp-promo-action > p:not([class]),#pp-landing .pp-review-visual > p:not([class]){display:contents;}
#pp-landing p:empty{display:none;}
#pp-landing a{color:inherit;text-decoration:none;box-shadow:none;background:none;}
#pp-landing a:focus-visible,#pp-landing summary:focus-visible,#pp-landing .pp-table-scroll:focus-visible{outline:3px solid currentColor;outline-offset:5px;}
#pp-landing img{display:block;max-width:100%;height:auto;border:0;box-shadow:none;}
#pp-landing .pp-shell{width:min(980px,calc(100% - 36px));margin-inline:auto;}
#pp-landing .pp-header{display:block;position:sticky;top:0;z-index:10;background:var(--pp-header);color:var(--pp-on-header);}
#pp-landing .pp-header-inner{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:25px;}
#pp-landing .pp-brand-wrap{min-width:0;max-width:45%;}
#pp-landing .pp-brand{display:inline-flex;align-items:center;gap:10px;line-height:1.12;flex-shrink:0;max-width:100%;}
#pp-landing .pp-brand:hover{opacity:.87;}
#pp-landing .pp-brand img{width:130px;height:42px;object-fit:contain;}
#pp-landing .pp-brand-text{display:flex;flex-direction:column;gap:3px;}
#pp-landing .pp-brand-name{font-size:24px;font-weight:850;letter-spacing:-.025em;}
#pp-landing .pp-brand-tagline{font-size:10px;font-weight:500;letter-spacing:.12em;}
#pp-landing .pp-nav{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px 26px;font-size:15px;font-weight:600;}
#pp-landing .pp-nav a:hover,#pp-landing .pp-footer a:hover{text-decoration:underline;text-underline-offset:4px;}
#pp-landing .pp-mobile-nav{display:none;position:relative;flex-shrink:0;}
#pp-landing .pp-mobile-nav summary{cursor:pointer;font-size:14px;padding:14px 0;}
#pp-landing .pp-mobile-links{position:absolute;right:0;top:100%;min-width:210px;max-height:65vh;overflow:auto;padding:12px;border-radius:0 0 12px 12px;background:var(--pp-header);box-shadow:0 12px 26px #0003;}
#pp-landing .pp-mobile-links a{display:block;padding:10px 14px;}
#pp-landing .pp-hero{margin:26px auto 30px;padding:20px 18px 22px;border:1px solid #b8d4d9;border-radius:8px;background:#e9f6f980;}
#pp-landing h1{font-size:52px;line-height:1.13;font-weight:600;letter-spacing:-.025em;margin-bottom:20px;}
#pp-landing .pp-intro{font-size:20px;line-height:1.7;white-space:pre-line;}
#pp-landing .pp-author{display:flex;align-items:center;gap:13px;margin-top:20px;font-size:14px;line-height:1.5;}
#pp-landing .pp-avatar{width:54px;height:54px;flex:0 0 54px;border-radius:50%;background:#d4e6df;overflow:hidden;}
#pp-landing .pp-avatar img{width:100%;height:100%;object-fit:cover;}
#pp-landing .pp-avatar-art{display:block;width:54px;height:54px;position:relative;background:linear-gradient(135deg,#dcddd2,#a5c5b1);}
#pp-landing .pp-avatar-art::before{content:"";position:absolute;width:17px;height:17px;border-radius:50%;top:9px;left:19px;background:#315344;}
#pp-landing .pp-avatar-art::after{content:"";position:absolute;width:36px;height:28px;border-radius:50% 50% 0 0;bottom:-5px;left:9px;background:#315344;}
#pp-landing .pp-author-lines{display:flex;flex-wrap:wrap;gap:3px 24px;}
#pp-landing .pp-author-lines span{display:block;}
#pp-landing .pp-meta-label{font-size:12px;opacity:.68;}
#pp-landing .pp-section{padding:18px 0 28px;scroll-margin-top:86px;}
#pp-landing h2{font-size:32px;line-height:1.3;font-weight:600;letter-spacing:-.025em;margin-bottom:22px;}
#pp-landing .pp-section-intro{font-size:19px;line-height:1.7;margin:-8px 0 25px;}
#pp-landing #pp-offers > h2,#pp-landing #pp-more-offers > h2{text-align:center;}
#pp-landing .pp-columns{display:grid;grid-template-columns:185px minmax(0,1fr) 130px 180px;gap:20px;padding:0 24px 10px;font-size:12px;font-weight:700;letter-spacing:.06em;text-align:center;}
#pp-landing .pp-offers{display:grid;gap:16px;}
#pp-landing .pp-offer{position:relative;background:var(--pp-card);color:var(--pp-on-card);border-radius:20px;padding:22px 24px;box-shadow:0 4px 12px #12312512;}
#pp-landing .pp-offer-row{display:grid;grid-template-columns:185px minmax(0,1fr) 130px 180px;gap:20px;align-items:center;min-height:185px;}
#pp-landing .pp-rank{position:absolute;left:10px;top:9px;font-size:12px;line-height:23px;min-width:23px;text-align:center;border-radius:50%;background:#ffffff24;font-weight:700;}
#pp-landing .pp-brand-cell{text-align:center;}
#pp-landing .pp-brand-cell h3{font-size:18px;font-weight:500;line-height:1.3;margin:0 0 12px;}
#pp-landing .pp-logo{display:block;text-decoration:none;color:inherit;width:180px;height:90px;max-width:100%;margin:auto;overflow:hidden;border-radius:8px;background:#111c22;}
#pp-landing .pp-logo>a{display:block;width:100%;height:100%;color:inherit;text-decoration:none;}
#pp-landing .pp-logo img{width:100%;height:100%;object-fit:contain;padding:10px;background:#fff;}
#pp-landing .pp-wordmark{display:flex;width:100%;height:100%;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:8px;background:radial-gradient(ellipse at top,#38454a,transparent 75%),linear-gradient(135deg,#151f28,#050e13);color:#fff2c5;font-size:23px;font-weight:900;line-height:1.05;letter-spacing:-.045em;text-align:center;}
#pp-landing .pp-wordmark-symbol{font-size:24px;line-height:1;color:#e5bd73;}
#pp-landing .pp-offer:nth-child(5n+2) .pp-wordmark{background:radial-gradient(ellipse at top,#402265,transparent 75%),#10091b;color:#e8d3ff;}
#pp-landing .pp-offer:nth-child(5n+3) .pp-wordmark{background:radial-gradient(ellipse at top,#2c526a,transparent 75%),#080e1a;color:#b9f4ff;}
#pp-landing .pp-offer:nth-child(5n+4) .pp-wordmark{background:radial-gradient(ellipse at top,#683722,transparent 75%),#1b0d09;color:#ffd8a8;}
#pp-landing .pp-offer:nth-child(5n) .pp-wordmark{background:radial-gradient(ellipse at top,#54461d,transparent 75%),#17120b;color:#f4e0ac;}
#pp-landing .pp-bonus{font-size:24px;line-height:1.35;font-weight:700;text-align:center;white-space:pre-line;}
#pp-landing .pp-features{list-style:none;margin-top:13px;font-size:12px;line-height:1.55;text-align:center;opacity:.9;}
#pp-landing .pp-features li{padding:2px 0;}
#pp-landing .pp-features li::before{content:"✓ ";font-weight:700;}
#pp-landing .pp-score{text-align:center;}
#pp-landing .pp-rating{color:#ffdf21;font-size:29px;line-height:1.2;font-weight:800;white-space:nowrap;}
#pp-landing .pp-rating small{font-size:17px;font-weight:500;}
#pp-landing .pp-stars{display:block;color:#ffdf21;white-space:nowrap;font-size:24px;line-height:1.3;letter-spacing:1px;margin-top:8px;}
#pp-landing .pp-action{display:flex;flex-direction:column;align-items:stretch;gap:9px;text-align:center;}
#pp-landing .pp-cta{display:block;padding:14px 12px;border-radius:7px;background:var(--pp-accent);color:var(--pp-on-accent);font-size:14px;font-weight:800;line-height:1.35;text-align:center;transition:filter .15s;}
#pp-landing .pp-offer-row .pp-cta{box-shadow:0 4px 0 #00000035,inset 0 1px 0 #ffffff30;}
#pp-landing a.pp-cta:hover{filter:brightness(1.09);text-decoration:underline;}
#pp-landing .pp-cta-disabled{opacity:.5;}
#pp-landing .pp-payout{font-size:14px;font-weight:600;line-height:1.4;white-space:pre-line;}
#pp-landing .pp-payout-note{display:block;font-size:11px;font-weight:400;opacity:.8;margin-top:3px;}
#pp-landing .pp-note{font-size:11px;line-height:1.45;opacity:.8;white-space:pre-line;}
#pp-landing .pp-promo{display:grid;grid-template-columns:minmax(0,1fr) 205px;align-items:center;gap:30px;background:linear-gradient(115deg,#331146,#773995);color:#fff;padding:29px 32px;margin:2px 0 28px;border-radius:14px;scroll-margin-top:86px;}
#pp-landing .pp-promo h2{font-size:27px;margin-bottom:9px;}
#pp-landing .pp-promo .pp-prose{font-size:16px;}
#pp-landing .pp-promo .pp-cta{background:#fff;color:#4a205d;}
#pp-landing .pp-tile-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;}
#pp-landing .pp-tile{background:#fff;color:#1c2924;border-radius:10px;overflow:hidden;border:1px solid #16312518;}
#pp-landing .pp-tile-cover{display:block;position:relative;overflow:hidden;}
#pp-landing .pp-tile-cover img{width:100%;height:150px;object-fit:cover;}
#pp-landing .pp-cover-art{width:100%;height:150px;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden;background:radial-gradient(circle at 50% 40%,#fbef9a66,transparent 60%),linear-gradient(135deg,#17384b,#335870);color:#ffdd83;}
#pp-landing .pp-cover-art::before,#pp-landing .pp-cover-art::after{content:"";position:absolute;width:145px;height:145px;border:1px solid #ffffff25;border-radius:50%;transform:rotate(30deg);}
#pp-landing .pp-cover-art::after{width:105px;height:105px;border-radius:15px;transform:rotate(-20deg);}
#pp-landing .pp-cover-symbol{position:relative;z-index:1;font-family:Georgia,serif;font-size:83px;line-height:1;text-shadow:0 7px 1px #0003,0 0 30px #ffffff50;transform:rotate(-8deg);}
#pp-landing .pp-art-1 .pp-cover-art{background:radial-gradient(circle at 50% 35%,#df956b77,transparent 65%),linear-gradient(135deg,#5b103d,#972f42);color:#ffe4c1;}
#pp-landing .pp-art-2 .pp-cover-art{background:radial-gradient(circle at 50% 35%,#77dcf077,transparent 65%),linear-gradient(135deg,#092c63,#334cac);color:#d1faff;}
#pp-landing .pp-art-3 .pp-cover-art{background:radial-gradient(circle at 50% 35%,#ffec7177,transparent 65%),linear-gradient(135deg,#754212,#be751d);color:#fff0a5;}
#pp-landing .pp-art-4 .pp-cover-art{background:radial-gradient(circle at 50% 35%,#e9bcff77,transparent 65%),linear-gradient(135deg,#38235c,#805292);color:#f6cafa;}
#pp-landing .pp-art-5 .pp-cover-art{background:radial-gradient(circle at 50% 35%,#8fecc177,transparent 65%),linear-gradient(135deg,#0a4c36,#267860);color:#d8ffb1;}
#pp-landing .pp-tile-text{padding:15px;}
#pp-landing .pp-tile h3{font-size:18px;font-weight:700;line-height:1.35;margin-bottom:8px;}
#pp-landing .pp-tile .pp-prose{font-size:13px;line-height:1.65;}
#pp-landing .pp-text-link{display:inline-block;margin-top:10px;font-size:12px;font-weight:700;text-decoration:underline;text-underline-offset:4px;}
#pp-landing .pp-services{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;}
#pp-landing .pp-service-card{min-width:0;}
#pp-landing .pp-service-cover{position:relative;display:block;overflow:hidden;border-radius:12px;background:#15271f;color:#fff;}
#pp-landing .pp-service-cover img,#pp-landing .pp-service-cover .pp-cover-art{height:290px;width:100%;object-fit:cover;}
#pp-landing .pp-service-cover .pp-cover-symbol{font-size:130px;transform:translateY(-25px) rotate(-10deg);}
#pp-landing .pp-service-label{position:absolute;bottom:0;left:0;right:0;padding:50px 17px 20px;background:linear-gradient(transparent,#06150be6 55%);}
#pp-landing .pp-service-title{display:block;font-size:21px;font-weight:700;line-height:1.25;}
#pp-landing .pp-service-cta{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.05em;padding:6px 12px;background:#ffffffee;color:#17261e;border-radius:20px;margin-top:10px;}
#pp-landing .pp-service-card .pp-prose{font-size:13px;line-height:1.6;margin:12px 3px 0;}
#pp-landing .pp-toc{border:1px solid #a3c0b880;background:#fff8;border-radius:9px;padding:23px 28px;margin:12px 0 32px;scroll-margin-top:86px;}
#pp-landing .pp-toc h2{font-size:25px;margin-bottom:12px;}
#pp-landing .pp-toc ol{list-style:decimal;padding-left:23px;columns:2;column-gap:35px;}
#pp-landing .pp-toc li{padding:4px 0;font-size:16px;break-inside:avoid;}
#pp-landing .pp-toc a{text-decoration:underline;text-underline-offset:3px;}
#pp-landing .pp-article{padding-top:10px;}
#pp-landing .pp-prose{font-size:19px;line-height:1.8;}
#pp-landing .pp-article > .pp-prose{margin:0 0 35px;scroll-margin-top:86px;}
#pp-landing .pp-prose h3{font-size:27px;line-height:1.35;font-weight:600;margin:26px 0 15px;letter-spacing:-.015em;}
#pp-landing .pp-prose h3:first-child{margin-top:0;}
#pp-landing .pp-prose p,#pp-landing .pp-prose ul{margin:0 0 18px;}
#pp-landing .pp-prose p:last-child,#pp-landing .pp-prose ul:last-child{margin-bottom:0;}
#pp-landing .pp-prose ul{list-style:disc;padding-left:26px;}
#pp-landing .pp-prose li{margin:5px 0;}
#pp-landing .pp-prose a{color:#116546;text-decoration:underline;text-underline-offset:3px;}
#pp-landing .pp-prose-image{width:100%;max-height:420px;object-fit:cover;border-radius:8px;margin:0 0 20px;}
#pp-landing .pp-table-block{margin:15px 0 38px;scroll-margin-top:86px;}
#pp-landing .pp-table-block h3{font-size:27px;font-weight:600;line-height:1.3;margin-bottom:18px;}
#pp-landing .pp-table-scroll{max-width:100%;overflow:auto;border:1px solid #aac9be;border-radius:8px;}
#pp-landing table{width:100%;min-width:580px;border-collapse:collapse;font-size:16px;line-height:1.55;background:#fff;color:#21352b;margin:0;}
#pp-landing th,#pp-landing td{padding:15px 18px;text-align:left;vertical-align:top;border:1px solid #bdd1c9;}
#pp-landing th{background:var(--pp-card);color:var(--pp-on-card);font-weight:700;}
#pp-landing tr:nth-child(even) td{background:#eef6f2;}
#pp-landing .pp-faq{border-top:1px solid #657e7250;}
#pp-landing .pp-faq-item{border-bottom:1px solid #657e7250;padding:0 4px;}
#pp-landing .pp-faq-item summary{cursor:pointer;padding:21px 4px;font-size:21px;font-weight:600;line-height:1.4;}
#pp-landing .pp-faq-item .pp-prose{padding:0 4px 22px;font-size:18px;}
#pp-landing .pp-reviews{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px;}
#pp-landing .pp-review{border:1px solid #16312520;border-radius:10px;overflow:hidden;background:#fff;color:#21352b;}
#pp-landing .pp-review-head{display:flex;align-items:center;gap:17px;padding:20px 22px 0;}
#pp-landing .pp-review-head img{width:104px;height:65px;object-fit:contain;border-radius:6px;background:#f4f6f5;}
#pp-landing .pp-review-symbol{display:flex;align-items:center;justify-content:center;width:60px;height:60px;flex:0 0 60px;border-radius:10px;color:#fff0b8;background:linear-gradient(135deg,#1e503f,#10211e);font:34px/1 Georgia,serif;}
#pp-landing .pp-review h3{font-size:22px;line-height:1.3;font-weight:600;}
#pp-landing .pp-review-body{padding:15px 22px 22px;}
#pp-landing .pp-review .pp-prose{font-size:16px;line-height:1.75;}
#pp-landing .pp-footer{margin-top:35px;background:var(--pp-header);color:var(--pp-on-header);padding:40px 0 22px;scroll-margin-top:86px;}
#pp-landing .pp-footer-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(130px,1fr) minmax(130px,1fr);gap:35px;}
#pp-landing .pp-footer .pp-brand-wrap{max-width:100%;}
#pp-landing .pp-footer .pp-brand{max-width:100%;margin-bottom:18px;}
#pp-landing .pp-footer h2{font-size:18px;margin-bottom:13px;font-weight:600;}
#pp-landing .pp-footer-copy{font-size:13px;line-height:1.8;opacity:.8;white-space:pre-line;}
#pp-landing .pp-footer-links{display:grid;gap:8px;font-size:13px;line-height:1.5;}
#pp-landing .pp-copyright{font-size:12px;opacity:.65;border-top:1px solid #ffffff30;margin-top:29px;padding-top:20px;white-space:pre-line;}
#pp-landing.pp-emerald .pp-author{justify-content:center;}
#pp-landing.pp-forest .pp-header-inner{min-height:56px;}
#pp-landing.pp-forest .pp-hero{border:1px dotted #597c69;border-radius:2px;background:#f3f1f8;padding:18px 20px;}
#pp-landing.pp-forest h1{font-size:49px;font-weight:430;}
#pp-landing.pp-forest .pp-author{justify-content:flex-end;}
#pp-landing.pp-forest .pp-offer{border-radius:14px;}
#pp-landing.pp-forest .pp-columns{letter-spacing:0;font-weight:600;}
#pp-landing.pp-rose .pp-header-inner{min-height:60px;}
#pp-landing.pp-rose .pp-hero{text-align:center;border:0;border-radius:0;background:#f4f5f6;padding:18px 10px 22px;}
#pp-landing.pp-rose h1{font-size:50px;font-weight:500;}
#pp-landing.pp-rose .pp-author{justify-content:center;text-align:left;}
#pp-landing.pp-rose .pp-offers{gap:13px;}
#pp-landing .pp-offer-atlas{display:grid;grid-template-columns:180px 150px minmax(0,1fr);gap:30px;align-items:center;min-height:150px;padding:20px;background:linear-gradient(105deg,var(--pp-card),#060c01);border-radius:14px;color:var(--pp-on-card);}
#pp-landing .pp-offer-atlas .pp-logo{width:170px;height:80px;}
#pp-landing .pp-offer-atlas .pp-wordmark{font-size:23px;}
#pp-landing .pp-rating-circle{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0 auto 7px;border:0;border-radius:50%;background:#3a3a3a;font-size:18px;font-weight:800;color:#fff;line-height:1;}
#pp-landing .pp-offer-atlas .pp-stars{font-size:18px;letter-spacing:2px;margin-top:0;}
#pp-landing .pp-offer-atlas .pp-score h3{font-size:17px;line-height:1.25;margin-top:8px;font-weight:700;}
#pp-landing .pp-atlas-offer .pp-bonus{font-size:18px;line-height:1.25;}
#pp-landing .pp-atlas-offer .pp-features{margin-top:5px;font-size:10px;line-height:1.3;display:flex;flex-wrap:wrap;justify-content:center;gap:2px 8px;}
#pp-landing .pp-atlas-offer .pp-features li{padding:0;}
#pp-landing .pp-atlas-offer .pp-action{max-width:320px;margin:8px auto 0;gap:4px;}
#pp-landing.pp-rose .pp-cta{border-radius:30px;padding:11px 19px;font-size:13px;}
#pp-landing .pp-offer-atlas .pp-payout{font-size:10px;line-height:1.3;}
#pp-landing .pp-offer-atlas .pp-payout-note{display:inline;margin-left:4px;font-size:9px;}
#pp-landing .pp-offer-atlas .pp-note{font-size:8px;line-height:1.3;}
#pp-landing.pp-rose .pp-section > h2{text-align:center;}
#pp-landing.pp-rose .pp-section-intro{text-align:center;}
@media(max-width:850px){#pp-landing .pp-offer-row,#pp-landing .pp-columns{grid-template-columns:155px minmax(0,1fr) 108px 145px;gap:13px;padding-left:18px;padding-right:18px;}#pp-landing .pp-logo{width:150px;height:82px;}#pp-landing .pp-bonus{font-size:21px;}#pp-landing .pp-rating{font-size:25px;}#pp-landing .pp-stars{font-size:19px;}#pp-landing .pp-nav{gap:15px;font-size:14px;}#pp-landing .pp-offer-atlas{grid-template-columns:165px 145px minmax(0,1fr);gap:18px;padding:22px;}#pp-landing .pp-offer-atlas .pp-logo{width:155px;height:80px;}#pp-landing .pp-tile-grid{grid-template-columns:repeat(3,minmax(0,1fr));}#pp-landing .pp-services{grid-template-columns:repeat(2,minmax(0,1fr));}#pp-landing .pp-footer-grid{gap:22px;}}
@media(max-width:650px){#pp-landing .pp-shell{width:calc(100% - 26px);}#pp-landing .pp-header-inner{min-height:58px;gap:20px;}#pp-landing .pp-brand-wrap{max-width:75%;}#pp-landing .pp-brand-name{font-size:21px;}#pp-landing .pp-brand-tagline{font-size:8px;}#pp-landing .pp-brand img{width:105px;height:36px;}#pp-landing .pp-nav{display:none;}#pp-landing .pp-mobile-nav{display:block;}#pp-landing .pp-hero{margin-top:18px;padding:19px 16px;}#pp-landing h1,#pp-landing.pp-forest h1,#pp-landing.pp-rose h1{font-size:35px;line-height:1.18;}#pp-landing .pp-intro{font-size:17px;line-height:1.7;}#pp-landing.pp-forest .pp-author{justify-content:flex-start;}#pp-landing .pp-author-lines{display:block;}#pp-landing .pp-author-lines > div + div{margin-top:4px;}#pp-landing .pp-section{padding:15px 0 23px;scroll-margin-top:78px;}#pp-landing h2{font-size:28px;}#pp-landing .pp-columns{display:none;}#pp-landing .pp-offer-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px 16px;padding:23px 18px;}#pp-landing .pp-offer-row .pp-brand-cell{grid-column:1;grid-row:1;}#pp-landing .pp-offer-row .pp-score{grid-column:2;grid-row:1;}#pp-landing .pp-offer-row .pp-offer-copy{grid-column:1 / -1;grid-row:2;}#pp-landing .pp-offer-row .pp-action{grid-column:1 / -1;grid-row:3;}#pp-landing .pp-brand-cell h3{font-size:15px;}#pp-landing .pp-logo{width:160px;height:90px;}#pp-landing .pp-wordmark{font-size:21px;}#pp-landing .pp-bonus{font-size:23px;}#pp-landing .pp-features{font-size:12px;}#pp-landing .pp-cta{padding:15px;}#pp-landing .pp-offer-atlas{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px 12px;padding:24px 18px;}#pp-landing .pp-offer-atlas .pp-logo{width:155px;height:80px;}#pp-landing .pp-atlas-offer{grid-column:1 / -1;}#pp-landing .pp-atlas-offer .pp-action{max-width:none;}#pp-landing .pp-promo{grid-template-columns:1fr;gap:20px;padding:25px;}#pp-landing .pp-tile-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:13px;}#pp-landing .pp-tile-text{padding:13px;}#pp-landing .pp-tile h3{font-size:16px;}#pp-landing .pp-tile .pp-prose{font-size:12px;}#pp-landing .pp-tile-cover img,#pp-landing .pp-cover-art{height:130px;}#pp-landing .pp-services{gap:13px;}#pp-landing .pp-service-cover img,#pp-landing .pp-service-cover .pp-cover-art{height:240px;}#pp-landing .pp-service-label{padding:40px 13px 17px;}#pp-landing .pp-service-title{font-size:19px;}#pp-landing .pp-service-cover .pp-cover-symbol{font-size:100px;}#pp-landing .pp-toc{padding:22px;}#pp-landing .pp-toc ol{columns:1;}#pp-landing .pp-prose{font-size:18px;line-height:1.75;}#pp-landing .pp-prose h3{font-size:25px;}#pp-landing .pp-faq-item summary{font-size:19px;}#pp-landing .pp-reviews{grid-template-columns:1fr;}#pp-landing .pp-footer-grid{grid-template-columns:1fr 1fr;gap:27px;}#pp-landing .pp-footer-about{grid-column:1 / -1;}#pp-landing .pp-footer{padding-top:30px;}#pp-landing .pp-footer .pp-brand{max-width:100%;}}
@media(prefers-reduced-motion:reduce){#pp-landing{scroll-behavior:auto;}#pp-landing .pp-cta{transition:none;}}
</style>`, false);
  }
  function imageMarkup(url, alt, className) {
    url = safeUrl(url);
    return url ? '<img' + (className ? ' class="' + className + '"' : '') + ' src="' + escape(url) + '" alt="' + escape(alt) + '" loading="lazy" decoding="async">' : '';
  }
  function brandMarkup(config, inFooter) {
    if(inFooter&&config.footerBrandUrl)config=Object.assign({},config,{brandUrl:config.footerBrandUrl});
    // Explicit invalid destinations stay local; an empty field follows an offer.
    var url = config.brandUrl ? safeUrl(config.brandUrl) : '';
    if (!config.brandUrl) {
      var offers = config.cards.concat(config.moreCards);
      for (var index = 0; index < offers.length && !url; index++) url = safeUrl(offers[index].url);
    }
    var attributes = url ? ' target="_blank" rel="noopener noreferrer"' : '';
    return '<div class="pp-brand-wrap"><a class="pp-brand" href="' + escape(url || '#pp-top') + '"' + attributes + '>' + imageMarkup(config.brandImage, '', '') + '<span class="pp-brand-text">' + (config.brandTagline ? '<span class="pp-brand-tagline">' + escape(config.brandTagline) + '</span>' : '') + (config.brand ? '<span class="pp-brand-name">' + escape(config.brand) + '</span>' : '') + '</span></a></div>';
  }
  function actionMarkup(card, config) {
    var url = safeUrl(card.url), label = escape(card.button || config.ctaLabel);
    var button = label ? (url ? '<a class="pp-cta" href="' + escape(url) + '" target="_blank" rel="sponsored noopener noreferrer">' + label + '</a>' : '<span class="pp-cta pp-cta-disabled" title="Посилання не додано">' + label + '</span>') : '';
    return '<div class="pp-action">' + (button ? '<div class="pp-button-wrap">' + button + '</div>' : '') + (card.payout || card.payoutNote ? '<p class="pp-payout">' + textLines(card.payout) + (card.payoutNote ? '<span class="pp-payout-note">' + escape(card.payoutNote) + '</span>' : '') + '</p>' : '') + (card.note ? '<p class="pp-note">' + textLines(card.note) + '</p>' : '') + '</div>';
  }
  function logoMarkup(card, index) {
    var image = imageMarkup(card.image, card.name, ''),url=safeUrl(card.logoUrl||card.url);
    var visual=image || '<span class="pp-wordmark"><span class="pp-wordmark-symbol" aria-hidden="true">' + ['✦', '◈', '♣', '♦', '✶'][index % 5] + '</span><span>' + escape(card.name) + '</span></span>';
    return '<div class="pp-logo">'+(url?'<a href="'+escape(url)+'" target="_blank" rel="sponsored noopener noreferrer">'+visual+'</a>':visual)+'</div>';
  }
  function starsMarkup(ratingValue) {
    if (!ratingValue) return '';
    var filled = Math.round(Number(ratingValue));
    return '<div class="pp-stars" aria-hidden="true">' + '★'.repeat(filled) + '☆'.repeat(5 - filled) + '</div>';
  }
  function featuresMarkup(text) {
    var features = text.split(/\r?\n/).map(function (line) { return line.replace(/^\s*-\s*/, '').trim(); }).filter(Boolean);
    return features.length ? '<ul class="pp-features">' + features.map(function (line) { return '<li>' + escape(line) + '</li>'; }).join('') + '</ul>' : '';
  }
  function cardMarkup(card, index, config, fieldPath) {
    var bonusText=textLines(card.bonus);
    if(config.aiLinkInsertions&&config.aiLinkInsertions.some(function(p){return p.fieldPath===fieldPath;})){
      var plan=linkPlacements.createTokenPlan(config,config.aiLinkInsertions);
      bonusText=linkPlacements.resolveTokens(card.bonus,fieldPath,plan).html.replace(/\r?\n/g,'<br>');
    }
    var bonus = card.bonus ? '<p class="pp-bonus">' + bonusText + '</p>' : '';
    var features = featuresMarkup(card.features);
    var rank = '<div class="pp-rank" aria-hidden="true">' + (index + 1) + '</div>';
    var name = card.name ? '<h3>' + escape(card.name) + '</h3>' : '';
    if (config.preset === 'rose') {
      return '<article class="pp-offer pp-offer-atlas">' + rank + '<div class="pp-brand-cell">' + logoMarkup(card, index) + '</div><div class="pp-score">' + (card.rating ? '<div class="pp-rating-circle" aria-label="Rating ' + card.rating + ' out of 5">' + card.rating + '</div>' + starsMarkup(card.rating) : '') + name + '</div><div class="pp-atlas-offer">' + bonus + features + actionMarkup(card, config) + '</div></article>';
    }
    return '<article class="pp-offer pp-offer-row">' + rank + '<div class="pp-brand-cell">' + name + logoMarkup(card, index) + '</div><div class="pp-offer-copy">' + bonus + features + '</div><div class="pp-score">' + (card.rating ? '<div class="pp-rating" aria-label="Rating ' + card.rating + ' out of 5">' + card.rating + '<small> / 5</small></div>' + starsMarkup(card.rating) : '') + '</div>' + actionMarkup(card, config) + '</article>';
  }
  function offersMarkup(cards, title, id, offset, config) {
    if (!cards.length) return '';
    var columns = config.preset === 'rose' ? '' : '<div class="pp-columns" aria-hidden="true">' + [config.columnBrand, config.columnBonus, config.columnRating, config.columnAction].map(function (text) { return '<span>' + escape(text) + '</span>'; }).join('') + '</div>';
    return '<section class="pp-section" id="' + id + '">' + (title ? '<h2>' + escape(title) + '</h2>' : '') + columns + '<div class="pp-offers">' + cards.map(function (card, index) { return cardMarkup(card, index + offset, config,(id==='pp-more-offers'?'moreCards':'cards')+'.'+index+'.bonus'); }).join('') + '</div></section>';
  }
  // Inline content inside links prevents wpautop from splitting clickable covers.
  function coverMarkup(item, index) {
    return imageMarkup(item.image, item.name, '') || '<span class="pp-cover-art"><span class="pp-cover-symbol" aria-hidden="true">' + ['♠', '♦', '✦', '♣', '7', '♥', '☼', '◈', '★', '♜', '♠', '◆'][index % 12] + '</span></span>';
  }
  function collectionMarkup(items, title, intro, services, config) {
    if (!items.length) return '';
    var body = items.map(function (item, index) {
      var url = safeUrl(item.url), artClass = ' pp-art-' + (index % 6);
      if (services) {
        var cover = coverMarkup(item, index) + '<span class="pp-service-label"><span class="pp-service-title" role="heading" aria-level="3">' + escape(item.name) + '</span>' + (url ? '<span class="pp-service-cta">EXPLORE →</span>' : '') + '</span>';
        return '<article class="pp-service-card' + artClass + '"><div class="pp-cover-wrap">' + (url ? '<a class="pp-service-cover" href="' + escape(url) + '">' + cover + '</a>' : '<div class="pp-service-cover">' + cover + '</div>') + '</div>' + (item.body ? '<div class="pp-prose">' + markdown(item.body,config,(services?'services':'tiles')+'.'+index+'.body') + '</div>' : '') + '</article>';
      }
      return '<article class="pp-tile' + artClass + '"><div class="pp-cover-wrap">' + (url ? '<a class="pp-tile-cover" href="' + escape(url) + '">' + coverMarkup(item, index) + '</a>' : '<div class="pp-tile-cover">' + coverMarkup(item, index) + '</div>') + '</div><div class="pp-tile-text"><h3>' + escape(item.name) + '</h3>' + (item.body ? '<div class="pp-prose">' + markdown(item.body,config,(services?'services':'tiles')+'.'+index+'.body') + '</div>' : '') + (url ? '<div class="pp-link-wrap"><a class="pp-text-link" href="' + escape(url) + '">EXPLORE →</a></div>' : '') + '</div></article>';
    }).join('');
    return '<section class="pp-section" id="' + (services ? 'pp-services' : 'pp-tiles') + '">' + (title ? '<h2>' + escape(title) + '</h2>' : '') + (intro ? '<p class="pp-section-intro">' + textLines(intro) + '</p>' : '') + '<div class="' + (services ? 'pp-services' : 'pp-tile-grid') + '">' + body + '</div></section>';
  }
  function tableMarkup(config) {
    var lines = config.tableText.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean).slice(0, 101);
    if (!lines.length) return '';
    function cells(line) { return line.replace(/^\|/, '').replace(/\|$/, '').split('|').slice(0, 12).map(function (cell) { return cell.trim(); }); }
    // Some saved AI responses supplied a flat glossary instead of table rows.
    // Render those pairs as definitions rather than a single unreadable header.
    var flat=cells(lines[0]);
    if(config.editorialFormat&&lines.length===1&&flat.length>=4&&flat.length%2===0){
      return '<section class="pp-table-block pp-glossary" id="pp-table">'+(config.tableTitle?'<h3>'+escape(config.tableTitle)+'</h3>':'')+'<dl>'+flat.map(function(cell,i){return i%2?'<dd>'+escape(cell)+'</dd>':'<dt>'+escape(cell)+'</dt>';}).join('')+'</dl></section>';
    }
    var headers = cells(lines.shift());
    var body = lines.filter(function (line) { return !/^\|?[\s:|-]+\|?$/.test(line); }).map(function (line) {
      var row = cells(line);
      return '<tr>' + headers.map(function (_, index) { return '<td>' + escape(row[index] || '') + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<section class="pp-table-block" id="pp-table">' + (config.tableTitle ? '<h3>' + escape(config.tableTitle) + '</h3>' : '') + '<div class="pp-table-scroll" tabindex="0" role="region" aria-label="' + escape(config.tableTitle || 'Comparison table') + '"><table><thead><tr>' + headers.map(function (cell) { return '<th scope="col">' + escape(cell) + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table></div></section>';
  }
  function existingIds(config) {
    var ids = ['pp-top'].concat(config.chromeMode === 'overlay-only' ? [] : ['pp-footer']);
    if (config.cards.length) ids.push('pp-offers');
    if (config.moreCards.length) ids.push('pp-more-offers');
    if (config.promoTitle || config.promoBody) ids.push('pp-promo');
    if (config.tiles.length) ids.push('pp-tiles');
    if (config.services.length) ids.push('pp-services');
    if (config.sections.length || config.tableText.trim()) ids.push('pp-article');
    if (config.sections.length && config.showToc) ids.push('pp-toc');
    config.sections.forEach(function (_, i) { ids.push('pp-section-' + (i + 1)); });
    if (config.tableText.trim()) ids.push('pp-table');
    if (config.faq.length) ids.push('pp-faq');
    if (config.reviews.length) ids.push('pp-reviews');
    return ids;
  }
  function navigation(config) {
    var ids = existingIds(config);
    if (config.navLinks.length) return config.navLinks.filter(function (link) { return link.name && (safeUrl(link.url) || (link.url[0] === '#' && ids.indexOf(link.url.slice(1)) !== -1)); });
    var links = [];
    if (config.cards.length) links.push({ name: 'Top offers', url: '#pp-offers' });
    else if (config.moreCards.length) links.push({ name: 'Offers', url: '#pp-more-offers' });
    if (config.tiles.length) links.push({ name: 'Explore', url: '#pp-tiles' });
    else if (config.services.length) links.push({ name: 'Explore', url: '#pp-services' });
    if (ids.indexOf('pp-article') !== -1) links.push({ name: 'Our guide', url: '#pp-article' });
    if (config.faq.length) links.push({ name: 'FAQ', url: '#pp-faq' });
    else if (config.reviews.length) links.push({ name: 'Reviews', url: '#pp-reviews' });
    return links.slice(0, 4);
  }
  function headerMarkup(config, nav) {
    var labels = editorialLabels(config);
    return '<header class="pp-header"><div class="pp-shell pp-header-inner">' + brandMarkup(config) + (nav ? '<nav class="pp-nav" aria-label="' + labels.sections + '">' + nav + '</nav><details class="pp-mobile-nav"><summary>' + labels.menu + '</summary><nav class="pp-mobile-links" aria-label="' + labels.navigation + '">' + nav + '</nav></details>' : '') + '</div></header>';
  }
  function footerMarkup(config, nav, footerTiles) {
    return '<footer class="pp-footer" id="pp-footer"><div class="pp-shell"><div class="pp-footer-grid"><div class="pp-footer-about">' + brandMarkup(config,true) + (config.footerTitle ? '<h2>' + escape(config.footerTitle) + '</h2>' : '') + (config.footer ? '<p class="pp-footer-copy">' + textLines(config.footer) + '</p>' : '') + '</div>' + (nav ? '<div>' + (config.footerLinksTitle ? '<h2>' + escape(config.footerLinksTitle) + '</h2>' : '') + '<nav class="pp-footer-links" aria-label="Footer navigation">' + nav + '</nav></div>' : '') + (footerTiles ? '<div>' + (config.tilesTitle ? '<h2>' + escape(config.tilesTitle) + '</h2>' : '') + '<div class="pp-footer-links">' + footerTiles + '</div></div>' : '') + '</div>' + (config.footerNote ? '<p class="pp-copyright">' + textLines(config.footerNote) + '</p>' : '') + '</div></footer>';
  }

  // This cache is local to one runtime and is never restored from project JSON.
  var htmlCacheKey = '', htmlCacheValue = null;
  function analyzeHTML(input) {
    var config = normalizeConfig(input);
    var key = JSON.stringify([config.importHtml, config.importBaseUrl, config.importChrome, config.importChrome !== 'none' && config.importReplaceHeader, config.importChrome !== 'none' && config.importReplaceFooter]);
    if (key !== htmlCacheKey || !htmlCacheValue) {
      var processor = typeof globalThis !== 'undefined' && globalThis.PagePosterHTML;
      try {
        if (!processor || typeof processor.process !== 'function') throw new Error('Модуль HTML не завантажився. Онови сторінку.');
        htmlCacheValue = processor.process(config.importHtml, {baseUrl: config.importBaseUrl, replaceHeader: config.importChrome !== 'none' && config.importReplaceHeader, replaceFooter: config.importChrome !== 'none' && config.importReplaceFooter});
      } catch (error) {
        htmlCacheValue = {html:'',css:'',title:'',headings:[],ids:[],firstLink:'',hasHeader:false,hasFooter:false,warnings:[error && error.message || 'Не вдалося прочитати HTML.'],stats:{},error:true};
      }
      htmlCacheKey = key;
    }
    return JSON.parse(JSON.stringify(htmlCacheValue));
  }
  function htmlNavigation(config, result) {
    var ids = ['pp-top'].concat(config.importChrome === 'add' ? ['pp-footer'] : [], result.ids || [], (result.headings || []).map(function (heading) { return heading.id; }));
    if (config.navLinks.length) return config.navLinks.filter(function (link) { return link.name && (safeUrl(link.url) || (link.url[0] === '#' && ids.indexOf(link.url.slice(1)) !== -1)); });
    var available = (result.headings || []).filter(function (heading) { return heading.level !== 1; });
    var sections = available.filter(function (heading) { return heading.level === 2; });
    return (sections.length ? sections : available).slice(0,3).map(function (heading) {
      var fullName = heading.text.replace(/\s+/g,' ').trim(), characters = Array.from(fullName), name = fullName;
      if (characters.length > 32) {
        name = characters.slice(0,31).join('');
        var boundary = name.lastIndexOf(' '); if (boundary >= 16) name = name.slice(0,boundary);
        name = name.trim() + '…';
      }
      return {name:name,fullName:fullName,url:'#'+heading.id};
    });
  }
  function validateHTMLConfig(config) {
    var result = analyzeHTML(config), warnings = result.warnings.slice();
    if (!config.importHtml.trim()) warnings.unshift('Встав готовий HTML або завантаж файл.');
    if (config.importBaseUrl && !safeUrl(config.importBaseUrl)) warnings.push('Адреса оригінального сайту: потрібна повна адреса https:// або http://.');
    if (config.brandUrl && !safeUrl(config.brandUrl)) warnings.push('Перехід з бренду: потрібна повна адреса https:// або http://.');
    if (config.brandImage && !safeUrl(config.brandImage)) warnings.push('Логотип бренду: потрібна повна адреса https:// або http://.');
    if (htmlNavigation(config,result).length !== config.navLinks.length && config.navLinks.length) warnings.push('Деякі пункти меню не ведуть до наявних розділів або коректних адрес.');
    return warnings;
  }
  function htmlChromeStyles(config) {
    var c = config.colors;
    var position = config.mode === 'fullscreen' ? 'position:fixed;inset:0;z-index:2147483000;overflow:auto;overscroll-behavior:contain;' : 'position:relative;width:100%;min-height:100vh;';
    return protectStyles(`<style>
#pp-landing{${position}--pp-bg:${c.background};--pp-header:${c.header};--pp-on-bg:${contrast(c.background)};--pp-on-header:${contrast(c.header)};background:var(--pp-bg);color:var(--pp-on-bg);font:17px/1.7 Arial,Helvetica,sans-serif;isolation:isolate;overflow-wrap:anywhere;scroll-behavior:smooth;}
#pp-landing>.pp-header,#pp-landing>.pp-footer{display:block;font:16px/1.6 Arial,Helvetica,sans-serif;color:var(--pp-on-header);background:var(--pp-header);text-align:left;}
#pp-landing>.pp-header *,#pp-landing>.pp-footer *{box-sizing:border-box;}
#pp-landing>.pp-header a,#pp-landing>.pp-footer a{color:inherit;text-decoration:none;box-shadow:none;background:none;}
#pp-landing>.pp-header a:focus-visible,#pp-landing>.pp-footer a:focus-visible,#pp-landing>.pp-header summary:focus-visible{outline:3px solid currentColor;outline-offset:4px;}
#pp-landing>.pp-header .pp-shell,#pp-landing>.pp-footer .pp-shell{width:min(1100px,calc(100% - 40px));margin-inline:auto;}
#pp-landing>.pp-header{position:sticky;top:0;z-index:10;}
#pp-landing>.pp-header .pp-header-inner{min-height:70px;display:flex;align-items:center;justify-content:space-between;gap:24px;}
#pp-landing>.pp-header .pp-brand-wrap{max-width:44%;min-width:0;flex-shrink:0;}
#pp-landing>.pp-header .pp-brand,#pp-landing>.pp-footer .pp-brand{display:inline-flex;align-items:center;gap:12px;line-height:1.15;max-width:100%;}
#pp-landing>.pp-header .pp-brand-text,#pp-landing>.pp-footer .pp-brand-text{display:flex;flex-direction:column;gap:4px;min-width:0;}
#pp-landing>.pp-header .pp-brand-name,#pp-landing>.pp-footer .pp-brand-name{font-size:24px;font-weight:800;letter-spacing:-.025em;}
#pp-landing>.pp-header .pp-brand-tagline,#pp-landing>.pp-footer .pp-brand-tagline{font-size:10px;letter-spacing:.12em;}
#pp-landing>.pp-header .pp-brand img,#pp-landing>.pp-footer .pp-brand img{display:block;width:130px;height:42px;object-fit:contain;}
#pp-landing>.pp-header .pp-nav{display:flex;flex-wrap:nowrap;justify-content:flex-end;gap:18px;font-size:14px;font-weight:600;min-width:0;flex:1;}
#pp-landing>.pp-header .pp-nav a{display:block;max-width:180px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#pp-landing>.pp-header .pp-brand-name,#pp-landing>.pp-header .pp-brand-tagline{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#pp-landing>.pp-header a:hover,#pp-landing>.pp-footer a:hover{opacity:.82;text-decoration:underline;text-underline-offset:4px;}
#pp-landing>.pp-header .pp-mobile-nav{display:none;position:relative;flex-shrink:0;}
#pp-landing>.pp-header .pp-mobile-nav summary{cursor:pointer;padding:15px 0;}
#pp-landing>.pp-header .pp-mobile-links{position:absolute;right:0;top:100%;width:230px;max-height:65vh;overflow:auto;padding:12px;background:var(--pp-header);box-shadow:0 12px 26px #0003;}
#pp-landing>.pp-header .pp-mobile-links a{display:block;padding:10px 14px;}
#pp-landing>.pp-footer{position:relative;z-index:1;padding:44px 0 24px;}
#pp-landing>.pp-footer .pp-footer-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:60px;}
#pp-landing>.pp-footer h2{font:700 18px/1.4 Arial,Helvetica,sans-serif;margin:22px 0 12px;color:inherit;}
#pp-landing>.pp-footer p{font:inherit;color:inherit;margin:12px 0;}
#pp-landing>.pp-footer .pp-footer-copy{font-size:14px;opacity:.85;white-space:pre-line;}
#pp-landing>.pp-footer .pp-footer-links{display:flex;flex-direction:column;gap:9px;font-size:14px;}
#pp-landing>.pp-footer .pp-copyright{padding-top:22px;margin-top:30px;border-top:1px solid #ffffff35;font-size:12px;opacity:.75;white-space:pre-line;}
#pp-landing>.pp-header .pp-brand-wrap>p:not([class]),#pp-landing>.pp-footer .pp-brand-wrap>p:not([class]){display:contents;}
#pp-imported-content{position:relative;display:flow-root;isolation:isolate;min-height:0;max-width:none;}
#pp-landing [data-pp-url]{cursor:pointer;}
#pp-landing [data-pp-url]:focus-visible{outline:3px solid currentColor;outline-offset:4px;}
@media(max-width:850px){#pp-landing>.pp-header .pp-brand-wrap{max-width:75%;}#pp-landing>.pp-header .pp-nav{display:none;}#pp-landing>.pp-header .pp-mobile-nav{display:block;}}
@media(max-width:650px){#pp-landing>.pp-header .pp-brand-wrap{max-width:75%;}#pp-landing>.pp-header .pp-header-inner{min-height:60px;}#pp-landing>.pp-header .pp-nav{display:none;}#pp-landing>.pp-header .pp-mobile-nav{display:block;}#pp-landing>.pp-footer .pp-footer-grid{grid-template-columns:1fr;gap:20px;}#pp-landing>.pp-header .pp-brand-name,#pp-landing>.pp-footer .pp-brand-name{font-size:21px;}}
@media(prefers-reduced-motion:reduce){#pp-landing{scroll-behavior:auto;}}
</style>`, true);
  }
  function renderHTMLSnippet(config) {
    var result = analyzeHTML(config), chrome = Object.assign({}, config);
    // Builder demo cards must never choose the imported page's brand destination.
    chrome.cards = result.firstLink ? [{url:result.firstLink}] : [];
    chrome.moreCards = [];
    var nav = htmlNavigation(config,result).map(function (link) { var label = link.fullName && link.fullName !== link.name ? ' title="'+escape(link.fullName)+'" aria-label="'+escape(link.fullName)+'"' : ''; return '<a href="'+escape(link.url)+'"'+label+'>'+escape(link.name)+'</a>'; }).join('');
    var header = config.importChrome === 'add' ? headerMarkup(chrome,nav) : '';
    var footer = config.importChrome === 'add' ? footerMarkup(chrome,nav,'') : '';
    var content = result.html || '<div class="ppi-body"><p>'+escape(result.error ? 'Не вдалося підготувати HTML. Перевір повідомлення в редакторі.' : 'Встав готовий HTML у вкладці «Готовий HTML».')+'</p></div>';
    var css = (result.css || '').replace(/</g,'\\3c ').replace(/\r?\n/g,' ');
    return htmlChromeStyles(config)+'<style>'+css+'</style><div id="pp-landing" class="pp-'+config.preset+' pp-html-page" lang="'+escape(result.lang || 'uk')+'">'+header+'<div id="pp-top"><div id="pp-imported-content">'+content+'</div></div>'+footer+'</div>';
  }

  function editorialLabels(config) {
    var labels = {
      en:{menu:'Menu',sections:'Page sections',navigation:'Mobile navigation',contents:'Table of contents'},
      es:{menu:'Menú',sections:'Secciones de la página',navigation:'Navegación móvil',contents:'Índice'},
      pl:{menu:'Menu',sections:'Sekcje strony',navigation:'Nawigacja mobilna',contents:'Spis treści'},
      de:{menu:'Menü',sections:'Seitenabschnitte',navigation:'Mobile Navigation',contents:'Inhaltsverzeichnis'},
      fr:{menu:'Menu',sections:'Sections de la page',navigation:'Navigation mobile',contents:'Sommaire'},
      uk:{menu:'Меню',sections:'Розділи сторінки',navigation:'Мобільна навігація',contents:'Зміст'},
      nl:{menu:'Menu',sections:'Paginaonderdelen',navigation:'Mobiele navigatie',contents:'Inhoudsopgave'},
      pt:{menu:'Menu',sections:'Secções da página',navigation:'Navegação móvel',contents:'Índice'},
      it:{menu:'Menu',sections:'Sezioni della pagina',navigation:'Navigazione mobile',contents:'Indice'},
      sv:{menu:'Meny',sections:'Sidans avsnitt',navigation:'Mobil navigering',contents:'Innehållsförteckning'},
      no:{menu:'Meny',sections:'Sidedeler',navigation:'Mobilnavigasjon',contents:'Innholdsfortegnelse'},
      da:{menu:'Menu',sections:'Sidens afsnit',navigation:'Mobilnavigation',contents:'Indholdsfortegnelse'},
      fi:{menu:'Valikko',sections:'Sivun osiot',navigation:'Mobiilinavigointi',contents:'Sisällysluettelo'},
      ro:{menu:'Meniu',sections:'Secțiunile paginii',navigation:'Navigare mobilă',contents:'Cuprins'},
      hu:{menu:'Menü',sections:'Az oldal részei',navigation:'Mobil navigáció',contents:'Tartalomjegyzék'},
      cs:{menu:'Menu',sections:'Části stránky',navigation:'Mobilní navigace',contents:'Obsah'},
      sk:{menu:'Menu',sections:'Časti stránky',navigation:'Mobilná navigácia',contents:'Obsah'},
      el:{menu:'Μενού',sections:'Ενότητες σελίδας',navigation:'Πλοήγηση κινητού',contents:'Περιεχόμενα'},
      tr:{menu:'Menü',sections:'Sayfa bölümleri',navigation:'Mobil gezinme',contents:'İçindekiler'},
      id:{menu:'Menu',sections:'Bagian halaman',navigation:'Navigasi seluler',contents:'Daftar isi'},
      vi:{menu:'Menu',sections:'Các phần của trang',navigation:'Điều hướng di động',contents:'Mục lục'},
      hi:{menu:'मेन्यू',sections:'पृष्ठ के भाग',navigation:'मोबाइल नेविगेशन',contents:'विषय सूची'}
    };
    return config.editorialFormat && labels[config.language] || labels.en;
  }
  // Editorial pages are typeset by the application. Model-selected promotional
  // presets remain available for legacy builder documents only.
  function editorialMarkdown(text,config,fieldPath) {
    // Validate saved token bindings before suppressing their generated link-only
    // paragraphs. Stored AI receipts remain replayable without another request.
    return markdown(text,config,fieldPath).replace(/<p>([\s\S]*?)<\/p>/g,function(whole,body){
      return body.indexOf('data-pp-placement-id=')!==-1?'':whole;
    }).replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g,'$1');
  }
  function renderEditorialPage(config) {
    var format=config.editorialFormat, language=config.language, labels=editorialLabels(config);
    var position=config.mode==='fullscreen'?'position:fixed;inset:0;z-index:2147483000;overflow:auto;overscroll-behavior:contain;':'position:relative;width:100%;min-height:100vh;';
    var formatNames={
      en:['Article','Step-by-step guide','Comparison','Discussion','Journal','Questions & answers'],
      es:['Artículo','Guía paso a paso','Comparación','Debate','Publicación','Preguntas y respuestas'],
      pl:['Artykuł','Poradnik krok po kroku','Porównanie','Dyskusja','Publikacja','Pytania i odpowiedzi'],
      de:['Artikel','Schritt-für-Schritt-Anleitung','Vergleich','Diskussion','Journal','Fragen und Antworten'],
      fr:['Article','Guide pratique','Comparatif','Discussion','Journal','Questions et réponses']
    };
    var formats=['article','guide','comparison','discussion','blog_post','faq'];
    var category=(formatNames[language]||formatNames.en)[formats.indexOf(format)];
    var themes={article:['#236349'],guide:['#216450'],comparison:['#245c49'],discussion:['#4f6250'],blog_post:['#48614d'],faq:['#2f6257']};
    var chromeUrl=safeUrl(config.brandUrl)||safeUrl(config.footerBrandUrl)||safeUrl((config.cards[0]||config.moreCards[0]||{}).url);
    var chromeConfig=Object.assign({},config,{brandUrl:chromeUrl,footerBrandUrl:chromeUrl});
    var variant=config.editorialVariant, hue=Number.isSafeInteger(variant)?([150,214,350,272,30,184,44,240,164,324,202,6][variant%12]+Math.floor(variant/12)*7)%360:null;
    function tone(s,l){return 'hsl('+hue+' '+s+'% '+l+'%)';}
    var theme=hue===null?themes[format]:[tone(36,29)], nav=navigation(config).map(function(link){return '<a href="'+escape(chromeUrl||link.url)+'" target="_blank" rel="noopener noreferrer">'+escape(link.name)+'</a>';}).join('');
    var brand='<div class="pp-identity"><span class="pp-brand-mark" aria-hidden="true">'+escape((config.brand||config.title||'P').slice(0,1))+'</span>'+brandMarkup(chromeConfig)+'</div>';
    var header=config.chromeMode==='overlay-only'?'':'<header class="pp-header"><div class="pp-frame pp-header-inner">'+brand+'<nav class="pp-nav" aria-label="'+labels.sections+'">'+nav+'</nav><details class="pp-mobile-nav"><summary>'+labels.menu+'</summary><nav aria-label="'+labels.navigation+'">'+nav+'</nav></details></div></header>';
    var hero='<section class="pp-hero"><div class="pp-eyebrow"><span class="pp-category">'+escape(category)+'</span>'+(config.brandTagline?'<span class="pp-hero-tagline">'+escape(config.brandTagline)+'</span>':'')+'</div><h1>'+escape(config.title)+'</h1><div class="pp-hero-bottom"><p class="pp-intro">'+textLines(config.intro)+'</p></div></section>';
    var toc=config.showToc&&config.sections.length&&format!=='blog_post'?'<aside class="pp-index"><nav id="pp-toc" aria-label="'+labels.contents+'"><h2>'+escape(config.tocTitle||labels.contents)+'</h2><ol>'+config.sections.map(function(section,i){return '<li><a href="#pp-section-'+(i+1)+'"><span aria-hidden="true">'+String(i+1).padStart(2,'0')+'</span>'+escape(section.title)+'</a></li>';}).join('')+'</ol></nav></aside>':'';
    var articleBody=config.sections.map(function(section,i){
      var title=section.title.replace(format==='guide'?/^(?:step\s*)?\d+[.):\s-]+/i:/$^/,'');
      return '<section class="pp-prose" id="pp-section-'+(i+1)+'">'+(format==='article'||format==='guide'||format==='discussion'||format==='blog_post'?'<span class="pp-section-number" aria-hidden="true">'+String(i+1).padStart(2,'0')+'</span>':'')+'<h3>'+escape(title)+'</h3>'+imageMarkup(section.image,section.title,'pp-prose-image')+editorialMarkdown(section.body,config,'sections.'+i+'.body')+'</section>';
    }).join('');
    var table=tableMarkup(config);
    var article='<section id="pp-article" class="pp-article">'+(config.articleTitle?'<h2 class="pp-article-heading">'+escape(config.articleTitle)+'</h2>':'')+(format==='comparison'?table:'')+articleBody+(format!=='comparison'?table:'')+'</section>';
    function resources(cards,title,id,field) {
      if(!cards.length)return '';
      return '<section id="'+id+'" class="pp-resource-section"><h2>'+escape(title)+'</h2><div class="pp-resources">'+cards.map(function(card,i){
        var domain='';try{domain=new URL(safeUrl(card.url)).hostname.replace(/^www\./,'');}catch{}
        var display=domain||card.name, logo=safeUrl(card.logoUrl||card.url);
        var visual=imageMarkup(card.image,display,'')||'<span>'+escape(domain?domain.split('.').slice(0,-1).join('.'):display)+'</span>';
        var copy=editorialMarkdown(card.bonus,config,field+'.'+i+'.bonus');
        // Model prose can repeat an opaque input label; show the destination
        // instead, without changing validated link bindings or stored copy.
        if(domain&&card.name){
          var label=escape(card.name),pattern=new RegExp('(?<![\\p{L}\\p{N}_])'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\p{L}\\p{N}_])','gu');
          copy=copy.split(/(<[^>]*>)/g).map(function(part,index){return index%2?part:part.replace(pattern,function(){return escape(domain);});}).join('');
        }
        return '<article class="pp-resource"><div class="pp-resource-identity"><a class="pp-resource-logo" href="'+escape(logo||'#pp-top')+'" target="_blank" rel="noopener noreferrer">'+visual+'</a><h3>'+escape(display)+'</h3></div><div class="pp-resource-copy">'+copy+'</div>'+actionMarkup(card,config).replace('class="pp-cta"','class="pp-cta" data-pp-priority="resource"')+'</article>';
      }).join('')+'</div></section>';
    }
    // The destination list is navigation, not one of the article's concepts.
    var resourceTitles={en:['Explore the casinos','Explore the sites'],es:['Explora los casinos','Explora los sitios'],pl:['Poznaj kasyna','Poznaj strony'],de:['Casinos entdecken','Websites entdecken'],fr:['Découvrir les casinos','Découvrir les sites']};
    var casinoAction=/casino|kasyno|kasyna|kasino/i.test(config.ctaLabel||((config.cards[0]||{}).button)||'');
    var primary=resources(config.cards,(resourceTitles[language]||resourceTitles.en)[casinoAction?0:1],'pp-offers','cards');
    var secondary=resources(config.moreCards,config.moreCardsTitle,'pp-more-offers','moreCards');
    var faq=config.faq.length?'<section id="pp-faq" class="pp-faq-section"><div class="pp-faq-heading"><span class="pp-question-mark" aria-hidden="true">?</span><h2>'+escape(config.faqTitle)+'</h2></div><div class="pp-faq">'+config.faq.map(function(row,i){return '<details class="pp-faq-item"'+(format==='faq'&&i===0?' open':'')+'><summary>'+escape(row.question)+'</summary><div class="pp-prose">'+editorialMarkdown(row.answer,config,'faq.'+i+'.answer')+'</div></details>';}).join('')+'</div></section>':'';
    var reading='<div class="pp-reading-grid">'+toc+article+'</div>';
    var content=hero+(format==='faq'?faq+primary+reading:format==='blog_post'?reading+primary+faq:primary+reading+faq)+secondary;
    // Preserve optional content when a saved editorial config was edited elsewhere.
    if(config.promoTitle||config.promoBody)content+='<section class="pp-extra" id="pp-promo"><h2>'+escape(config.promoTitle)+'</h2>'+editorialMarkdown(config.promoBody,config,'promoBody')+actionMarkup({url:config.promoUrl,button:config.promoButton},config)+'</section>';
    content+=collectionMarkup(config.tiles,config.tilesTitle,config.tilesIntro,false,config)+collectionMarkup(config.services,config.servicesTitle,config.servicesIntro,true,config);
    if(config.reviews.length)content+='<section class="pp-extra" id="pp-reviews"><h2>'+escape(config.reviewsTitle)+'</h2>'+config.reviews.map(function(row,i){return '<article><h3>'+escape(row.title)+'</h3>'+editorialMarkdown(row.body,config,'reviews.'+i+'.body')+(safeUrl(row.url)?'<a href="'+escape(row.url)+'">'+escape(row.title)+'</a>':'')+'</article>';}).join('')+'</section>';
    var footer=config.chromeMode==='overlay-only'?'':'<footer id="pp-footer" class="pp-footer"><div class="pp-frame"><div class="pp-footer-grid"><div>'+brandMarkup(chromeConfig,true)+(config.footer?'<p>'+textLines(config.footer)+'</p>':'')+'</div><nav aria-label="'+labels.navigation+'">'+nav+'</nav></div>'+(config.footerNote?'<div class="pp-footer-note">'+textLines(config.footerNote)+'</div>':'')+'</div></footer>';
    var css=`<style>
#pp-landing{${position}--pp-accent:${theme[0]};--pp-paper:#fff;--pp-ink:#172622;--pp-muted:#5c6862;--pp-line:#e1e6e2;display:block;min-height:100%;background:#fff;color:var(--pp-ink);font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;text-align:left;overflow-wrap:anywhere;isolation:isolate;}
#pp-landing *,#pp-landing *::before,#pp-landing *::after{box-sizing:border-box;font-family:inherit;}
#pp-landing [data-pp-url]{cursor:pointer;}
#pp-landing a{color:var(--pp-accent);text-decoration:none;cursor:pointer;}
#pp-landing a:hover{text-decoration:underline;text-underline-offset:4px;}
#pp-landing a:focus-visible,#pp-landing [data-pp-url]:focus-visible,#pp-landing summary:focus-visible{outline:3px solid #b58c3b;outline-offset:5px;}
#pp-landing h1,#pp-landing h2,#pp-landing h3,#pp-landing p{padding:0;margin:0;}
#pp-landing .pp-frame{width:calc(100% - 80px);max-width:1120px;margin:0 auto;}
#pp-landing .pp-header{background:#142c26;position:relative;z-index:3;}
#pp-landing .pp-header-inner{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:36px;padding:16px 0;}
#pp-landing .pp-identity{display:flex;align-items:center;gap:12px;min-width:0;}
#pp-landing .pp-brand-mark{display:grid;place-items:center;width:32px;height:36px;flex:0 0 32px;border:1px solid #82958b;border-radius:2px;color:#e2d0a3;font-family:Georgia,serif;font-size:24px;}
#pp-landing .pp-brand{display:flex;align-items:center;color:inherit;text-decoration:none;}
#pp-landing .pp-brand img{width:100px;height:36px;object-fit:contain;}
#pp-landing .pp-brand-name{font-weight:700;font-size:19px;letter-spacing:-.4px;line-height:1.3;}
#pp-landing .pp-header .pp-brand{color:#fff;}
#pp-landing .pp-brand-tagline{display:none;}
#pp-landing .pp-nav{display:flex;align-items:center;gap:30px;font-size:13px;font-weight:600;}
#pp-landing .pp-nav a{color:#dbe5df;max-width:180px;line-height:1.5;}
#pp-landing .pp-mobile-nav{display:none;}
#pp-landing .pp-hero{padding:44px 0 32px;margin-bottom:12px;max-width:940px;}
#pp-landing .pp-eyebrow{display:flex;align-items:center;gap:16px;margin-bottom:18px;color:var(--pp-muted);font-size:11px;line-height:1.5;}
#pp-landing .pp-category{display:inline-flex;align-items:center;gap:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--pp-accent);white-space:nowrap;}
#pp-landing .pp-category::before{content:'';width:20px;height:2px;background:#b49960;}
#pp-landing .pp-hero-tagline{max-width:440px;}
#pp-landing h1{max-width:940px;font-size:44px;line-height:1.14;letter-spacing:-1.5px;font-weight:700;color:#172622;text-wrap:balance;}
#pp-landing .pp-hero-bottom{margin-top:20px;}
#pp-landing .pp-intro{max-width:820px;font-size:17px;line-height:1.8;color:#5c6862;}
#pp-landing .pp-cta{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 24px;border-radius:5px;background:var(--pp-accent);color:#fff;font-size:14px;font-weight:700;line-height:1.5;text-decoration:none;text-align:center;transition:background .15s;}
#pp-landing .pp-cta:hover{filter:brightness(.88);text-decoration:none;}
#pp-landing .pp-cta::after{content:'↗';font-size:18px;margin-left:18px;}
#pp-landing .pp-cta-disabled{opacity:.55;}
#pp-landing .pp-resource-section{margin:0 0 48px;}
#pp-landing .pp-resource-section>h2{font-size:19px;line-height:1.4;margin-bottom:18px;letter-spacing:-.3px;}
#pp-landing .pp-resources{display:grid;gap:14px;}
#pp-landing .pp-resource{display:grid;grid-template-columns:210px minmax(0,1fr) 194px;align-items:center;gap:28px;padding:8px 24px 8px 8px;border:1px solid var(--pp-line);border-radius:8px;background:#fff;box-shadow:0 3px 12px #142c2608;}
#pp-landing .pp-resource-identity{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;min-width:0;align-self:stretch;min-height:120px;padding:20px 12px;background:#182e29;border-radius:4px;}
#pp-landing .pp-resource-logo{display:flex;align-items:center;justify-content:center;width:100%;min-height:40px;color:#f5ecd8;font-size:23px;font-weight:750;letter-spacing:-.7px;line-height:1.3;text-align:center;}
#pp-landing .pp-resource-logo img{max-width:150px;max-height:66px;object-fit:contain;}
#pp-landing .pp-resource h3{color:#b8c7c0;font-size:11px;font-weight:400;line-height:1.4;text-align:center;}
#pp-landing .pp-resource-copy{font-size:14px;line-height:1.8;color:#53615a;}
#pp-landing .pp-resource-copy p{margin:0;}
#pp-landing .pp-resource .pp-action{width:100%;max-width:220px;}
#pp-landing .pp-resource .pp-cta{display:flex;}
#pp-landing .pp-note,#pp-landing .pp-payout{font-size:12px;margin-top:8px;color:var(--pp-muted);}
#pp-landing .pp-payout-note{display:block;}
#pp-landing .pp-reading-grid{display:grid;grid-template-columns:230px minmax(0,1fr);gap:64px;align-items:start;padding-top:38px;border-top:1px solid var(--pp-line);margin-bottom:56px;}
#pp-landing .pp-reading-grid:not(:has(.pp-index)){display:block;max-width:800px;margin-left:auto;margin-right:auto;}
#pp-landing .pp-index{position:sticky;top:28px;padding:4px 0;}
#pp-landing .pp-index h2{font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;line-height:1.6;margin-bottom:18px;color:#66736b;}
#pp-landing .pp-index ol{list-style:none;margin:0;padding:0;}
#pp-landing .pp-index li{border-bottom:1px solid var(--pp-line);padding:12px 0;}
#pp-landing .pp-index a{display:flex;gap:12px;align-items:baseline;color:#53615a;font-size:12px;line-height:1.6;}
#pp-landing .pp-index a span{flex:0 0 18px;color:#8c968f;font-size:10px;}
#pp-landing .pp-article{min-width:0;}
#pp-landing .pp-article-heading{font-size:26px;line-height:1.3;letter-spacing:-.6px;margin-bottom:28px;}
#pp-landing .pp-prose{font-size:17px;line-height:1.85;color:#435149;}
#pp-landing .pp-article>.pp-prose{margin-bottom:36px;scroll-margin-top:28px;}
#pp-landing .pp-prose h3{font-size:21px;font-weight:700;line-height:1.4;letter-spacing:-.35px;color:#172622;margin:0 0 14px;}
#pp-landing .pp-prose p{margin:0 0 18px;}
#pp-landing .pp-prose p:last-child{margin-bottom:0;}
#pp-landing .pp-prose ul{padding-left:22px;margin:16px 0;}
#pp-landing .pp-prose li{margin:8px 0;}
#pp-landing .pp-prose-image{display:block;max-width:100%;max-height:400px;object-fit:cover;border-radius:4px;margin:20px 0;}
#pp-landing .pp-section-number{display:inline-block;color:var(--pp-accent);font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:12px;}
#pp-landing .pp-table-block{margin:32px 0;background:#fff;border:1px solid var(--pp-line);border-radius:4px;overflow:hidden;}
#pp-landing .pp-table-block h3{font-size:18px;line-height:1.4;padding:20px;border-bottom:1px solid var(--pp-line);}
#pp-landing .pp-table-scroll{max-width:100%;overflow:auto;}
#pp-landing .pp-glossary dl{display:grid;grid-template-columns:minmax(120px,1fr) 3fr;margin:0;font-size:14px;line-height:1.7;}
#pp-landing .pp-glossary dt,#pp-landing .pp-glossary dd{margin:0;padding:18px 20px;border-bottom:1px solid var(--pp-line);}
#pp-landing .pp-glossary dt{font-weight:700;background:#f5f7f4;}
#pp-landing .pp-glossary dd{color:#53615a;}
#pp-landing table{border-collapse:collapse;width:100%;min-width:520px;font-size:13px;line-height:1.7;text-align:left;}
#pp-landing th{padding:15px 20px;background:#f1f4ef;font-weight:700;vertical-align:top;min-width:140px;overflow-wrap:normal;}
#pp-landing td{padding:17px 20px;border-top:1px solid var(--pp-line);vertical-align:top;color:#53615a;min-width:140px;}
#pp-landing tbody tr:nth-child(even){background:#fafbf9;}
#pp-landing .pp-faq-section{border-top:1px solid var(--pp-line);padding-top:40px;margin:0 0 56px;display:grid;grid-template-columns:230px minmax(0,1fr);gap:64px;}
#pp-landing .pp-faq-heading h2{font-size:26px;line-height:1.3;letter-spacing:-.5px;}
#pp-landing .pp-question-mark{display:none;}
#pp-landing .pp-faq-item{border-bottom:1px solid var(--pp-line);}
#pp-landing .pp-faq-item summary{padding:20px 0;cursor:pointer;font-size:15px;font-weight:700;line-height:1.5;}
#pp-landing .pp-faq-item .pp-prose{padding:0 0 24px;font-size:15px;line-height:1.8;}
#pp-landing .pp-footer{background:#f3f5f1;border-top:1px solid var(--pp-line);color:#24382e;padding:40px 0 24px;}
#pp-landing .pp-footer-grid{display:grid;grid-template-columns:minmax(0,640px) auto;justify-content:space-between;gap:60px;}
#pp-landing .pp-footer .pp-brand{margin-bottom:14px;}
#pp-landing .pp-footer p{font-size:13px;line-height:1.85;color:#647069;}
#pp-landing .pp-footer nav{display:flex;flex-direction:column;gap:12px;max-width:260px;}
#pp-landing .pp-footer nav a{color:#354b3e;font-size:13px;}
#pp-landing .pp-footer-note{border-top:1px solid #dbe1d9;margin-top:28px;padding-top:20px;font-size:11px;line-height:1.7;color:#647069;}
#pp-landing.pp-format-article .pp-reading-grid{grid-template-columns:minmax(0,1fr) 230px;}
#pp-landing.pp-format-article .pp-index{grid-column:2;grid-row:1;}
#pp-landing.pp-format-article .pp-article{grid-column:1;grid-row:1;}
#pp-landing.pp-format-article .pp-article-heading,#pp-landing.pp-format-blog_post .pp-article-heading{font-size:28px;line-height:1.35;padding-bottom:24px;margin-bottom:34px;border-bottom:2px solid #243f32;}
#pp-landing.pp-format-article .pp-article>.pp-prose,#pp-landing.pp-format-blog_post .pp-article>.pp-prose{position:relative;padding:0 0 32px 56px;border-bottom:1px solid var(--pp-line);margin-bottom:32px;}
#pp-landing.pp-format-article .pp-article>.pp-prose>.pp-section-number,#pp-landing.pp-format-blog_post .pp-article>.pp-prose>.pp-section-number{position:absolute;left:0;top:-3px;font-family:Georgia,serif;font-size:30px;line-height:1.4;font-weight:400;letter-spacing:-1px;color:#779184;}
#pp-landing.pp-format-article .pp-article>.pp-prose>h3,#pp-landing.pp-format-blog_post .pp-article>.pp-prose>h3{font-size:23px;line-height:1.4;margin-bottom:20px;}
#pp-landing.pp-format-article .pp-article>.pp-prose:nth-of-type(odd)>p:last-of-type:not(:first-of-type),#pp-landing.pp-format-blog_post .pp-article>.pp-prose:nth-of-type(odd)>p:last-of-type:not(:first-of-type){background:#f3f5ef;border-left:3px solid #b39a62;border-radius:0 5px 5px 0;padding:20px 24px;margin-top:24px;color:#324d3e;line-height:1.8;}
#pp-landing.pp-format-article .pp-prose strong,#pp-landing.pp-format-blog_post .pp-prose strong{color:#203b2d;font-weight:700;}
#pp-landing.pp-format-guide .pp-article>.pp-prose{border-bottom:1px solid var(--pp-line);padding-bottom:28px;}
#pp-landing.pp-format-guide .pp-section-number{display:grid;place-items:center;width:32px;height:32px;border:1px solid #b4c8bb;border-radius:50%;}
#pp-landing.pp-format-comparison .pp-hero{max-width:820px;padding-bottom:20px;}
#pp-landing.pp-format-comparison .pp-reading-grid{display:block;}
#pp-landing.pp-format-comparison .pp-index{position:static;margin-bottom:36px;}
#pp-landing.pp-format-comparison .pp-index ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 28px;}
#pp-landing.pp-format-comparison .pp-article{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px 40px;align-items:start;}
#pp-landing.pp-format-comparison .pp-article>.pp-article-heading,#pp-landing.pp-format-comparison .pp-article>.pp-table-block{grid-column:1/-1;margin:0;}
#pp-landing.pp-format-comparison .pp-article>.pp-prose{margin:0;padding-top:20px;border-top:1px solid var(--pp-line);}
#pp-landing.pp-format-discussion .pp-article>.pp-prose{padding:6px 0 8px 26px;border-left:3px solid #a9bfb1;}
#pp-landing.pp-format-discussion .pp-article>.pp-prose:nth-of-type(even){border-color:#cbb996;}
#pp-landing.pp-format-blog_post .pp-hero{max-width:840px;margin:0 auto 32px;text-align:center;padding:54px 0 30px;}
#pp-landing.pp-format-blog_post h1{font-family:Georgia,'Times New Roman',serif;font-weight:400;}
#pp-landing.pp-format-blog_post .pp-eyebrow{justify-content:center;}
#pp-landing.pp-format-blog_post .pp-reading-grid{display:block;max-width:740px;margin-left:auto;margin-right:auto;}
#pp-landing.pp-format-faq .pp-faq-section{margin-top:12px;}
#pp-landing .pp-extra{padding:28px 0;margin-bottom:40px;border-top:1px solid var(--pp-line);}
#pp-landing .pp-extra h2{margin-bottom:18px;}
#pp-landing .pp-section{margin-bottom:40px;}
#pp-landing .pp-tile-grid,#pp-landing .pp-services{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;}
#pp-landing .pp-tile,#pp-landing .pp-service-card{padding:24px;border:1px solid var(--pp-line);border-radius:4px;}
#pp-landing .pp-tile img,#pp-landing .pp-service-card img{max-width:100%;height:auto;}
@media(max-width:1000px){
#pp-landing .pp-frame{width:calc(100% - 48px);}
#pp-landing .pp-reading-grid,#pp-landing .pp-faq-section{grid-template-columns:190px minmax(0,1fr);gap:36px;}
#pp-landing.pp-format-article .pp-reading-grid{grid-template-columns:minmax(0,1fr) 190px;}
#pp-landing h1{font-size:38px;}
#pp-landing .pp-resource{grid-template-columns:170px minmax(0,1fr) 160px;gap:20px;padding-right:16px;}
#pp-landing .pp-resource-logo{font-size:20px;}
}
@media(max-width:700px){
#pp-landing .pp-frame{width:calc(100% - 36px);}
#pp-landing .pp-header-inner{min-height:66px;gap:16px;padding:12px 0;}
#pp-landing .pp-brand-name{font-size:16px;}
#pp-landing .pp-brand-mark{width:26px;height:30px;flex-basis:26px;font-size:20px;}
#pp-landing .pp-nav{display:none;}
#pp-landing .pp-mobile-nav{display:block;position:relative;flex-shrink:0;}
#pp-landing .pp-mobile-nav summary{font-size:12px;cursor:pointer;color:#fff;padding:10px 0;min-height:44px;}
#pp-landing .pp-mobile-nav nav{position:absolute;right:0;top:44px;width:220px;border:1px solid #d9dfd9;border-radius:5px;background:#fff;box-shadow:0 12px 36px #14223916;padding:12px 18px;}
#pp-landing .pp-mobile-nav nav a{display:block;font-size:13px;color:#24382e;padding:12px 0;}
#pp-landing .pp-hero,#pp-landing.pp-format-blog_post .pp-hero{padding:28px 0 22px;margin-bottom:6px;}
#pp-landing .pp-eyebrow{margin-bottom:16px;font-size:10px;}
#pp-landing .pp-hero-tagline{display:none;}
#pp-landing h1{font-size:30px;line-height:1.18;letter-spacing:-.8px;}
#pp-landing .pp-intro{font-size:16px;line-height:1.75;}
#pp-landing .pp-hero-bottom{margin-top:16px;}
#pp-landing .pp-resource-section{margin-bottom:32px;}
#pp-landing .pp-resource-section>h2{font-size:18px;}
#pp-landing .pp-resource{grid-template-columns:minmax(0,1fr);gap:0;padding:8px;}
#pp-landing .pp-resource-identity{min-height:96px;gap:4px;padding:14px;}
#pp-landing .pp-resource-logo{font-size:24px;}
#pp-landing .pp-resource-copy{padding:18px 12px 14px;font-size:14px;}
#pp-landing .pp-resource .pp-action{max-width:none;padding:0 12px 12px;}
#pp-landing .pp-reading-grid,#pp-landing.pp-format-article .pp-reading-grid{display:flex;flex-direction:column;gap:28px;padding-top:28px;margin-bottom:36px;}
#pp-landing .pp-index{position:static;width:100%;}
#pp-landing .pp-index h2{margin-bottom:6px;}
#pp-landing .pp-index a{font-size:12px;}
#pp-landing .pp-article{width:100%;}
#pp-landing .pp-prose{font-size:16px;line-height:1.8;}
#pp-landing .pp-prose h3{font-size:20px;}
#pp-landing .pp-article-heading{font-size:24px;margin-bottom:24px;}
#pp-landing.pp-format-article .pp-article-heading,#pp-landing.pp-format-blog_post .pp-article-heading{font-size:25px;padding-bottom:20px;margin-bottom:26px;}
#pp-landing.pp-format-article .pp-article>.pp-prose,#pp-landing.pp-format-blog_post .pp-article>.pp-prose{padding:0 0 26px;margin-bottom:26px;}
#pp-landing.pp-format-article .pp-article>.pp-prose>.pp-section-number,#pp-landing.pp-format-blog_post .pp-article>.pp-prose>.pp-section-number{position:static;display:block;font-size:25px;margin-bottom:8px;}
#pp-landing.pp-format-article .pp-article>.pp-prose>h3,#pp-landing.pp-format-blog_post .pp-article>.pp-prose>h3{font-size:21px;margin-bottom:16px;}
#pp-landing.pp-format-article .pp-article>.pp-prose:nth-of-type(odd)>p:last-of-type:not(:first-of-type),#pp-landing.pp-format-blog_post .pp-article>.pp-prose:nth-of-type(odd)>p:last-of-type:not(:first-of-type){padding:16px 18px;margin-top:20px;}
#pp-landing .pp-faq-section{display:block;padding-top:28px;margin-bottom:36px;}
#pp-landing .pp-faq-heading h2{font-size:24px;margin-bottom:12px;}
#pp-landing .pp-faq-item summary{font-size:14px;}
#pp-landing .pp-footer-grid{display:block;}
#pp-landing .pp-footer nav{margin-top:26px;}
#pp-landing .pp-footer{padding-top:30px;}
#pp-landing.pp-format-discussion .pp-article>.pp-prose{padding-left:18px;}
#pp-landing.pp-format-comparison .pp-index ol{grid-template-columns:1fr;}
#pp-landing.pp-format-comparison .pp-article{display:block;}
#pp-landing.pp-format-comparison .pp-article>.pp-prose{margin:24px 0;}
#pp-landing.pp-format-comparison .pp-article>.pp-table-block{margin:24px 0;}
#pp-landing .pp-glossary dl{display:block;}
#pp-landing .pp-glossary dt{padding:14px 20px 0;border:0;background:transparent;}
#pp-landing .pp-glossary dd{padding:6px 20px 18px;}
#pp-landing .pp-tile-grid,#pp-landing .pp-services{grid-template-columns:1fr;}
}
</style>`;
    if(hue!==null){
      var palette={'#142c26':tone(28,14),'#182e29':tone(24,16),'#172622':tone(16,13),'#5c6862':tone(8,38),'#53615a':tone(9,34),'#24382e':tone(18,18),'#243f32':tone(22,20),'#203b2d':tone(22,18),'#324d3e':tone(18,25),'#354b3e':tone(18,25),'#435149':tone(9,29),'#f3f5f1':tone(20,96),'#f3f5ef':tone(20,96),'#f5f7f4':tone(18,97),'#f1f4ef':tone(18,95),'#779184':tone(14,47),'#b39a62':tone(24,48),'#b49960':tone(24,48),'#82958b':tone(14,55),'#b8c7c0':tone(15,78),'#a9bfb1':tone(18,70),'#b4c8bb':tone(18,72)};
      css=css.replace(/#[0-9a-f]{6}\b/gi,function(color){return palette[color.toLowerCase()]||color;});
    }
    return protectStyles(css)+'<div id="pp-landing" class="pp-editorial-v2 pp-editorial pp-format-'+format+'" lang="'+escape(language)+'">'+header+'<main id="pp-top" class="pp-frame">'+content+'</main>'+footer+'</div>';
  }
  function renderRawSnippet(input) {
    var config = normalizeConfig(input);
    if (oversizedUrls(config).length) { var error=new Error(oversizedUrls(config).join(' '));error.code='URL_TOO_LONG';throw error; }
    if (config.contentMode === 'html') return renderHTMLSnippet(config);
    if (config.editorialFormat) return renderEditorialPage(config);
    var links = navigation(config);
    var nav = links.map(function (link) { return '<a href="' + escape(link.url) + '">' + escape(link.name) + '</a>'; }).join('');
    var header = config.chromeMode === 'overlay-only' ? '' : headerMarkup(config, nav);
    var avatar = imageMarkup(config.authorImage, config.author, '') || '<span class="pp-avatar-art" aria-hidden="true"></span>';
    var author = config.author || config.date ? '<div class="pp-author"><div class="pp-avatar">' + avatar + '</div><div class="pp-author-lines">' + (config.author ? '<div><span class="pp-meta-label">Author</span><span>' + escape(config.author) + '</span></div>' : '') + (config.date ? '<div><span class="pp-meta-label">Updated</span><time datetime="' + config.date + '">' + config.date.split('-').reverse().join('.') + '</time></div>' : '') + '</div></div>' : '';
    var hero = '<section class="pp-hero">' + (config.title ? '<h1>' + escape(config.title) + '</h1>' : '') + (config.intro ? '<p class="pp-intro">' + textLines(config.intro) + '</p>' : '') + author + '</section>';
    var primary = offersMarkup(config.cards, config.cardsTitle, 'pp-offers', 0, config);
    var secondary = offersMarkup(config.moreCards, config.moreCardsTitle, 'pp-more-offers', config.cards.length, config);
    var promo = config.promoTitle || config.promoBody ? '<section class="pp-promo" id="pp-promo"><div>' + (config.promoTitle ? '<h2>' + escape(config.promoTitle) + '</h2>' : '') + (config.promoBody ? '<div class="pp-prose">' + markdown(config.promoBody,config,'promoBody') + '</div>' : '') + '</div>' + (config.promoButton && safeUrl(config.promoUrl) ? '<div class="pp-promo-action"><a class="pp-cta" href="' + escape(safeUrl(config.promoUrl)) + '">' + escape(config.promoButton) + '</a></div>' : '') + '</section>' : '';
    var tiles = collectionMarkup(config.tiles, config.tilesTitle, config.tilesIntro, false, config);
    var services = collectionMarkup(config.services, config.servicesTitle, config.servicesIntro, true, config);
    var toc = config.showToc && config.sections.length ? '<nav class="pp-toc" id="pp-toc" aria-label="' + editorialLabels(config).contents + '">' + (config.tocTitle ? '<h2>' + escape(config.tocTitle) + '</h2>' : '') + '<ol>' + config.sections.map(function (section, index) { return '<li><a href="#pp-section-' + (index + 1) + '">' + escape(section.title || 'Section ' + (index + 1)) + '</a></li>'; }).join('') + '</ol></nav>' : '';
    var table = tableMarkup(config), editorial = config.editorialFormat || '';
    var articleBody = config.sections.map(function (section, index) {
      return '<section class="pp-prose" id="pp-section-' + (index + 1) + '">' + (section.title ? '<h3>' + (editorial === 'guide' ? '<span class="pp-step" aria-hidden="true">' + (index + 1) + '</span>' : '') + escape(section.title.replace(editorial === 'guide' ? /^(?:step\s*)?\d+[.):\s-]+/i : /$^/, '')) + '</h3>' : '') + imageMarkup(section.image, section.title, 'pp-prose-image') + markdown(section.body,config,'sections.'+index+'.body') + '</section>' + (!editorial && index === 1 ? table : '');
    }).join('') + (!editorial && config.sections.length < 2 ? table : '');
    if (editorial) articleBody = editorial === 'comparison' ? table + articleBody : articleBody + table;
    var article = articleBody ? '<section class="pp-section pp-article" id="pp-article">' + (config.articleTitle ? '<h2>' + escape(config.articleTitle) + '</h2>' : '') + articleBody + '</section>' : '';
    var questions = config.faq.map(function (faq,index) { return '<details class="pp-faq-item"><summary>' + escape(faq.question || 'Question') + '</summary><div class="pp-prose">' + markdown(faq.answer,config,'faq.'+index+'.answer') + '</div></details>'; }).join('');
    var faq = questions ? '<section class="pp-section" id="pp-faq">' + (config.faqTitle ? '<h2>' + escape(config.faqTitle) + '</h2>' : '') + '<div class="pp-faq">' + questions + '</div></section>' : '';
    var reviews = config.reviews.length ? '<section class="pp-section" id="pp-reviews">' + (config.reviewsTitle ? '<h2>' + escape(config.reviewsTitle) + '</h2>' : '') + '<div class="pp-reviews">' + config.reviews.map(function (review, index) { return '<article class="pp-review"><div class="pp-review-head"><div class="pp-review-visual">' + (imageMarkup(review.image, review.title, '') || '<span class="pp-review-symbol" aria-hidden="true">' + ['✦', '◈', '♣', '♦', '✶'][index % 5] + '</span>') + '</div><h3>' + escape(review.title) + '</h3></div><div class="pp-review-body"><div class="pp-prose">' + markdown(review.body,config,'reviews.'+index+'.body') + '</div>' + (safeUrl(review.url) ? '<div class="pp-link-wrap"><a class="pp-text-link" href="' + escape(review.url) + '">READ MORE →</a></div>' : '') + '</div></article>'; }).join('') + '</div></section>' : '';
    var footerTiles = config.tiles.filter(function (tile) { return tile.name && safeUrl(tile.url); }).slice(0, 12).map(function (tile) { return '<a href="' + escape(tile.url) + '">' + escape(tile.name) + '</a>'; }).join('');
    var footer = config.chromeMode === 'overlay-only' ? '' : footerMarkup(config, nav, footerTiles);
    var content = hero + primary + promo + secondary + (config.preset === 'rose' ? services + tiles : tiles + services) + toc + article + faq + reviews;
    if (editorial) content = hero + (editorial === 'faq' ? faq + article : (editorial === 'blog_post' ? '' : toc) + article + faq) + primary + promo + secondary + tiles + services + reviews;
    var editorialStyles = editorial ? '<style>#pp-landing.pp-editorial .pp-hero{max-width:880px;margin-inline:auto;text-align:left}#pp-landing.pp-editorial .pp-article,#pp-landing.pp-editorial #pp-faq,#pp-landing.pp-editorial .pp-toc{max-width:880px;margin-inline:auto}#pp-landing.pp-editorial .pp-prose{font-size:17px;line-height:1.85}#pp-landing.pp-editorial .pp-prose h3{line-height:1.35;margin-top:36px}#pp-landing.pp-editorial .pp-prose p{margin:0 0 1.15em}#pp-landing.pp-editorial .pp-step{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;border:1px solid currentColor;border-radius:50%;margin-right:12px;font-size:16px}#pp-landing.pp-format-discussion .pp-article>section{padding:8px 24px 16px;border-left:3px solid currentColor;margin:24px 0}#pp-landing.pp-format-discussion .pp-article>section:nth-of-type(even){border-left:0;border-right:3px solid currentColor}#pp-landing.pp-format-blog_post .pp-article{max-width:720px}#pp-landing.pp-format-blog_post .pp-prose:first-of-type>p:first-of-type:first-letter{font-size:2.3em;font-weight:bold}#pp-landing.pp-format-faq #pp-faq{margin-top:16px}@media(max-width:600px){#pp-landing.pp-editorial .pp-prose{font-size:16px}#pp-landing.pp-format-discussion .pp-article>section{padding:4px 14px 12px}}</style>' : '';
    return styles(config) + (editorialStyles ? protectStyles(editorialStyles) : '') + '\n<div id="pp-landing" class="pp-' + config.preset + (editorial ? ' pp-editorial pp-format-' + editorial : '') + '" lang="' + escape(config.language) + '">' + header + '<div class="pp-shell" id="pp-top" role="main">' + content + '</div>' + footer + '</div>';
  }
  function renderSnippet(input) {
    var config = normalizeConfig(input);
    if (!pageRuntime || typeof pageRuntime.prepare !== 'function') throw new Error('Модуль посилань не завантажився. Онови PagePoster.');
    return pageRuntime.prepare(renderRawSnippet(config), {fullscreen:config.mode === 'fullscreen',separateChrome:!!config.editorialFormat&&config.contentMode==='builder'});
  }
  function analyzeLinks(input) {
    return pageRuntime.summarize(renderSnippet(input));
  }
  function renderDocument(input) {
    var config = normalizeConfig(input);
    return '<!doctype html>\n<html lang="' + escape(config.contentMode === 'html' ? analyzeHTML(config).lang || 'uk' : config.language) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + escape(config.contentMode === 'html' ? analyzeHTML(config).title || config.title : config.title) + '</title><style>html,body{margin:0;padding:0;min-height:100%;}</style></head><body>' + renderSnippet(config) + '</body></html>';
  }
  return { languageTag: languageTag, DEFAULT_DATA: DEFAULT_DATA, PRESETS: PRESETS, normalizeConfig: normalizeConfig, renderSnippet: renderSnippet, renderDocument: renderDocument, validateConfig: validateConfig, analyzeHTML: analyzeHTML, analyzeLinks: analyzeLinks };
}));



