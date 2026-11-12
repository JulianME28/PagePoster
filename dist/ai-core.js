(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PagePosterAI = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // This module only plans text changes. Destinations and images never become AI targets.
  var TOP_GROUPS = [
    ['brand', 'Бренд', [['brand', 'Назва бренду', 200], ['brandTagline', 'Підпис бренду', 300]]],
    ['hero', 'Вступ', [['title', 'Заголовок сторінки', 500], ['intro', 'Вступний текст', 5000]]],
    ['offers', 'Заголовки пропозицій', [['cardsTitle', 'Основні пропозиції', 300], ['moreCardsTitle', 'Додаткові пропозиції', 300], ['ctaLabel', 'Типовий текст кнопки', 100], ['columnBrand', 'Колонка бренду', 100], ['columnBonus', 'Колонка пропозиції', 100], ['columnRating', 'Колонка оцінки', 100], ['columnAction', 'Колонка дії', 100]]],
    ['promo', 'Промоблок', [['promoTitle', 'Заголовок промоблоку', 500], ['promoBody', 'Текст промоблоку', 10000], ['promoButton', 'Кнопка промоблоку', 100]]],
    ['tiles', 'Заголовок плиток', [['tilesTitle', 'Заголовок плиток', 300], ['tilesIntro', 'Вступ до плиток', 5000]]],
    ['services', 'Заголовок сервісів', [['servicesTitle', 'Заголовок сервісів', 300], ['servicesIntro', 'Вступ до сервісів', 5000]]],
    ['article', 'Стаття та зміст', [['articleTitle', 'Заголовок статті', 300], ['tocTitle', 'Заголовок змісту', 300]]],
    ['table', 'Таблиця', [['tableTitle', 'Заголовок таблиці', 300], ['tableText', 'Таблиця: колонки розділяються |', 50000]]],
    ['faq', 'Заголовок FAQ', [['faqTitle', 'Заголовок FAQ', 300]]],
    ['reviews', 'Заголовок оглядів', [['reviewsTitle', 'Заголовок оглядів', 300]]],
    ['footer', 'Підвал', [['footerTitle', 'Заголовок підвалу', 300], ['footer', 'Опис у підвалі', 5000], ['footerLinksTitle', 'Заголовок посилань', 300], ['footerNote', 'Нижній підпис', 5000]]]
  ];
  var CARD_FIELDS = [['name', 'Назва', 300], ['bonus', 'Пропозиція', 3000], ['button', 'Текст кнопки', 100], ['note', 'Примітка', 2000], ['features', 'Особливості', 4000], ['payout', 'Платежі', 300], ['payoutNote', 'Примітка до платежів', 1000]];
  var ROW_GROUPS = [
    ['cards', 'Пропозиція', CARD_FIELDS],
    ['moreCards', 'Додаткова пропозиція', CARD_FIELDS],
    ['tiles', 'Плитка', [['name', 'Назва', 300], ['body', 'Текст', 10000]]],
    ['services', 'Сервіс', [['name', 'Назва', 300], ['body', 'Текст', 10000]]],
    ['sections', 'Розділ статті', [['title', 'Заголовок', 500], ['body', 'Текст розділу', 50000]]],
    ['faq', 'Питання FAQ', [['question', 'Питання', 1000], ['answer', 'Відповідь', 20000]]],
    ['reviews', 'Огляд', [['title', 'Заголовок', 500], ['body', 'Текст огляду', 20000]]],
    ['navLinks', 'Пункт меню', [['name', 'Назва пункту', 200]]]
  ];
  var FIELD_LIMITS = Object.create(null);
  TOP_GROUPS.forEach(function (group) { group[2].forEach(function (field) { FIELD_LIMITS[field[0]] = field[2]; }); });
  ROW_GROUPS.forEach(function (group) { group[2].forEach(function (field) { FIELD_LIMITS[group[0] + '.' + field[0]] = field[2]; }); });
  Object.freeze(FIELD_LIMITS);
  var rowIds = new WeakMap(), plans = new WeakMap(), rowSequence = 0, planSequence = 0;
  function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
  function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function requireConfig(config) { if (!isObject(config)) throw new Error('Потрібен об’єкт конфігурації сторінки.'); }
  function fieldLimit(field) { return typeof field === 'string' && own(FIELD_LIMITS, field) ? FIELD_LIMITS[field] : null; }
  function currentValue(object, key) { return own(object, key) && typeof object[key] === 'string' ? object[key] : ''; }
  function rawValue(object, key) { return own(object, key) ? object[key] : undefined; }
  function rowName(row) { return (currentValue(row, 'name') || currentValue(row, 'title') || currentValue(row, 'question')).slice(0, 300); }
  function rowId(row) { if (!rowIds.has(row)) rowIds.set(row, ++rowSequence); return rowIds.get(row); }
  function descriptor(object, definition, path, qualified) {
    return { path: path, field: qualified, label: definition[1], maxLength: definition[2], currentValue: currentValue(object, definition[0]) };
  }
  function collectGroups(config) {
    requireConfig(config);
    var groups = TOP_GROUPS.map(function (group) {
      return { id: 'top:' + group[0], label: group[1], collection: '', object: config, fields: group[2].map(function (field) { return descriptor(config, field, field[0], field[0]); }) };
    });
    ROW_GROUPS.forEach(function (group) {
      var collection = group[0], seen = new Set();
      if (!Array.isArray(config[collection])) return;
      config[collection].slice(0, 100).forEach(function (row, index) {
        if (!isObject(row) || seen.has(row)) return;
        seen.add(row);
        var name = rowName(row);
        groups.push({ id: 'row:' + collection + ':' + rowId(row), label: group[1] + ' ' + (index + 1) + (name ? ': ' + name : ''), collection: collection, object: row, fields: group[2].map(function (field) { return descriptor(row, field, collection + '.' + index + '.' + field[0], collection + '.' + field[0]); }) });
      });
    });
    return groups;
  }
  function listGroups(config) {
    return collectGroups(config).map(function (group) { return { id: group.id, label: group.label, paths: group.fields.map(function (field) { return field.path; }), fields: group.fields }; });
  }
  function selection(values, allowed, label) {
    if (values === undefined) return null;
    if (!Array.isArray(values)) throw new Error(label + ': потрібен список.');
    var result = new Set();
    values.forEach(function (value) {
      if (typeof value !== 'string' || !allowed.has(value) || result.has(value)) throw new Error(label + ': невідоме або повторне значення.');
      result.add(value);
    });
    return result;
  }

  function planInsertions(config, extra) {
    var existing = config.aiLinkInsertions === undefined ? [] : config.aiLinkInsertions;
    if (!Array.isArray(existing) || !Array.isArray(extra) || existing.length + extra.length > 200) throw new Error('Некоректний реєстр вставок посилань.');
    var fields = new Map(collectGroups(config).reduce(function(all,group){return all.concat(group.fields.map(function(field){return [field.path,field];}));},[])), merged = new Map();
    existing.concat(extra).forEach(function(item){
      if (!isObject(item) || Object.keys(item).some(function(k){return ['id','fieldPath','url','anchor','count'].indexOf(k)<0;}) || !fields.has(item.fieldPath)) throw new Error('Текстове поле вставки посилання не знайдено.');
      var field = fields.get(item.fieldPath), link = normalizeAllowedLinks(field.field,item.fieldPath,[{id:item.id,url:item.url,anchor:item.anchor,count:item.count}])[0];
      var entry = {id:link.id,fieldPath:item.fieldPath,url:link.url,anchor:link.anchor,count:link.count};
      if (merged.has(entry.id) && JSON.stringify(merged.get(entry.id)) !== JSON.stringify(entry)) throw new Error('Існуючі посилання не можна замінювати через ШІ.');
      merged.set(entry.id,entry);
    });
    if (merged.size > 100) throw new Error('Забагато вставок посилань.');
    return Array.from(merged.values());
  }

  function collectFacts(config) {
    var facts=[];
    ['cards','moreCards'].forEach(function(group){(config[group]||[]).forEach(function(row,index){
      ['name','bonus','rating','note','features','payout','payoutNote'].forEach(function(key){
        var value=typeof row[key]==='number'?String(row[key]):currentValue(row,key);
        if(value.trim())facts.push({id:group+'-'+index+'-'+key,fieldPath:group+'.'+index+'.'+key,subject:currentValue(row,'name'),value:value});
      });
    });});
    return facts;
  }
  function languageTag(value) {
    var text=String(value||'').trim(),names={english:'en',ukrainian:'uk',polish:'pl',german:'de',french:'fr',spanish:'es',italian:'it',portuguese:'pt',dutch:'nl',russian:'ru',czech:'cs',romanian:'ro',turkish:'tr',japanese:'ja',chinese:'zh',arabic:'ar','українська':'uk','англійська':'en','польська':'pl','польською':'pl'};
    if(names[text.toLowerCase()])return names[text.toLowerCase()];
    if(/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(text)){try{return Intl.getCanonicalLocales(text)[0];}catch(_){}}
    return 'und';
  }
  function makePlan(config, options) {
    requireConfig(config);
    var checked=new Set();
    function checkUrls(value){if(!isObject(value)&&!Array.isArray(value)||checked.has(value))return;checked.add(value);Object.keys(value).forEach(function(key){var item=value[key];if(typeof item==='string'&&/^(?:url|image|logoUrl|.*Url|.*Image)$/.test(key)&&item.length>4000){var error=new Error('URL перевищує 4000 символів. Повну адресу збережено; скороти її вручну.');error.code='URL_TOO_LONG';throw error;}if(item&&typeof item==='object')checkUrls(item);});}
    checkUrls(config);
    options = options === undefined ? {} : options;
    if (!isObject(options)) throw new Error('Параметри плану мають бути об’єктом.');
    var mode = options.mode === undefined ? 'empty' : options.mode;
    if (mode !== 'empty' && mode !== 'selected') throw new Error('Невідомий режим генерації.');
    var groups = collectGroups(config);
    var selectedGroups = selection(options.groupIds, new Set(groups.map(function (group) { return group.id; })), 'Вибір груп');
    var selectedPaths = selection(options.paths, new Set(groups.reduce(function (all, group) { return all.concat(group.fields.map(function (field) { return field.path; })); }, [])), 'Вибір полів');
    var insertions = planInsertions(config, options.linkInsertions || []);
    var sequence = ++planSequence, targets = [], refs = new Map(), included = [];
    groups.forEach(function (group) {
      if (selectedGroups && !selectedGroups.has(group.id)) return;
      var before = targets.length;
      group.fields.forEach(function (field) {
        if (selectedPaths && !selectedPaths.has(field.path)) return;
        if (mode === 'empty' && field.currentValue.trim()) return;
        var key = field.field.split('.').pop();
        var targetId = 'plan-' + sequence + '-text-' + (targets.length + 1);
        var context = Object.freeze({ groupId: group.id, groupLabel: group.label, rowName: group.collection ? rowName(group.object) : '', url: group.collection ? currentValue(group.object, 'url') : '' });
        var allowedLinks = Object.freeze(insertions.filter(function(item){return item.fieldPath===field.path;}).map(function(item){return Object.freeze({id:item.id,url:item.url,anchor:item.anchor,count:item.count});}));
        var target = Object.freeze({ targetId: targetId, field: field.field, fieldPath: field.path, allowedLinks: allowedLinks, label: field.label, maxLength: field.maxLength, currentValue: field.currentValue, context: context });
        targets.push(target);
        refs.set(targetId, { target: target, collection: group.collection, object: group.object, key: key, snapshot: rawValue(group.object, key), originalPath: field.path });
      });
      if (targets.length > before) included.push(Object.freeze({ id: group.id, label: group.label }));
    });
    var plan = Object.freeze({ mode: mode, groups: Object.freeze(included), targets: Object.freeze(targets) });
    plans.set(plan, { config: config, refs: refs, mode: mode, linkSnapshot: JSON.stringify(config.aiLinkInsertions), insertions: insertions });
    return plan;
  }
  function planState(plan) { if (!plans.has(plan)) throw new Error('План генерації застарів або не був створений у цій сесії.'); return plans.get(plan); }

  // Match the generator's bounded Markdown grammar without creating HTML.
  // Keep exact URLs, including their query strings and encoding. No decoding.
  function markdownLabelEnd(text,start){var depth=1,index=start+1;for(;index<text.length;index++){if(text[index]==='[')depth++;else if(text[index]===']'&&!--depth)return index;}return -1;}
function markdownDestinations(value) {
    var destinations = [];
    function inline(text, allowStrong, allowLinks) {
      var cursor = 0;
      while (cursor < text.length) {
        if (allowStrong && text.slice(cursor, cursor + 2) === '**') {
          var strongEnd = text.indexOf('**', cursor + 2);
          if (strongEnd > cursor + 2) {
            inline(text.slice(cursor + 2, strongEnd), false, allowLinks);
            cursor = strongEnd + 2;
            continue;
          }
        }
        if (!allowLinks || text[cursor] !== '[') { cursor++; continue; }
        var labelEnd = markdownLabelEnd(text,cursor);
        if(labelEnd<0||text[labelEnd+1]!=='('){cursor++;continue;}
        var end = labelEnd + 2, depth = 1;
        while (end < text.length && depth) {
          if (text[end] === '(') depth++;
          else if (text[end] === ')') depth--;
          if (depth) end++;
        }
        if(depth){cursor++;continue;}
        var url = text.slice(labelEnd + 2, end).trim();
        if (/^https?:\/\//i.test(url) && !/[\u0000-\u0020\u007f]/.test(url)) {
          try {
            var parsed = new URL(url);
            if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname) destinations.push([url, text.slice(cursor + 1, labelEnd)]);
          } catch (_) {}
        }
        cursor = end + 1;
      }
    }
    var paragraph = [];
    function flush() {
      if (paragraph.length) { inline(paragraph.join(' '), true, true); paragraph = []; }
    }
    value.replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) flush();
      else if (/^##\s+/.test(line)) { flush(); inline(line.replace(/^##\s+/, ''), true, true); }
      else if (/^-\s+/.test(line)) { flush(); inline(line.replace(/^-\s+/, ''), true, true); }
      else paragraph.push(line);
    });
    flush();
    return destinations.sort(function(a,b){return JSON.stringify(a).localeCompare(JSON.stringify(b));});
  }

function normalizeAllowedLinks(field, fieldPath, entries) {
  if (entries === undefined) entries = [];
  if (!Array.isArray(entries) || entries.length > 100) throw new Error('Некоректний план вставок посилань.');
  if (entries.length && !(/^(?:promoBody|(?:sections|tiles|services|reviews)\.(?:0|[1-9][0-9]?)\.body|faq\.(?:0|[1-9][0-9]?)\.answer)$/.test(fieldPath || ''))) throw new Error('Посилання можна вставити лише в конкретне текстове поле.');
  if (fieldPath !== undefined && (typeof fieldPath !== 'string' || fieldPath.replace(/\.(?:0|[1-9][0-9]?)\./, '.') !== field)) throw new Error('Поле вставки посилання не відповідає цілі.');
  var seen = new Set();
  return entries.map(function(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(function(k){return ['id','url','anchor','count'].indexOf(k)<0;}) || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || seen.has(item.id)) throw new Error('Некоректний або повторний ID посилання.');
    seen.add(item.id);
    if (typeof item.url !== 'string' || item.url.length > 4000 || !/^https?:\/\//i.test(item.url) || /[\u0000-\u0020\u007f]/.test(item.url)) throw new Error('Некоректна URL-адреса посилання.');
    var parsed; try { parsed = new URL(item.url); } catch (_) { throw new Error('Некоректна URL-адреса посилання.'); }
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error('Некоректна URL-адреса посилання.');
    if (typeof item.anchor !== 'string' || !item.anchor.trim() || item.anchor.length > 2000 || /[\u0000-\u001f\u007f]/.test(item.anchor)) throw new Error('Потрібен точний текст анкора посилання.');
    var count = item.count === undefined ? 1 : item.count;
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('Некоректна кількість вставок посилання.');
    return {id:item.id,url:item.url,anchor:item.anchor,count:count};
  });
}
function safeLinkUpdate(target, value) {
  // Blank ordinary text is a no-op; required insertions must never silently disappear.
  if (!value.trim()) return !(target.allowedLinks || []).length;
  var before = target.currentValue || '', allowed = target.allowedLinks || [];
  var manualLinks = function(text) { return markdownDestinations(text.replace(/\[\[PP_LINK:([a-zA-Z0-9_-]+)\]\]/g,'\uE000PP_LINK:$1\uE001')); };
  var oldLinks=manualLinks(before),newLinks=manualLinks(value);
  // A link token must be standalone text, never inside a manual Markdown anchor or URL.
  if (JSON.stringify(newLinks).indexOf('\uE000PP_LINK:')>=0 || JSON.stringify(oldLinks)!==JSON.stringify(newLinks)) return false;
  // Raw URLs cannot become new output even when escaped HTML would render them as plain text.
  var rawUrls = function(text) { return (text.match(/https?:\/\/[^\s<>"']+/gi) || []).map(function(url){return url.replace(/[.,;!?)}\]*]+$/g,'');}).sort(); };
  if (JSON.stringify(rawUrls(before)) !== JSON.stringify(rawUrls(value))) return false;
  var counts = new Map(), byId = new Map(allowed.map(function(item){return [item.id,item];}));
  var expanded = value.replace(/\[\[PP_LINK:([a-zA-Z0-9_-]+)\]\]/g,function(token,id){
    var item = byId.get(id); if (!item) { counts.set('!invalid',1); return ''; }
    counts.set(id,(counts.get(id)||0)+1); return item.anchor + item.url;
  });
  if (counts.has('!invalid') || /\[\[PP_LINK:/i.test(expanded)) return false;
  if (allowed.some(function(item){return counts.get(item.id)!==item.count;})) return false;
  return expanded.length <= target.maxLength;
}

  function validateUpdates(plan, updates) {
    var state = planState(plan), seen = new Set();
    if (!Array.isArray(updates) || updates.length !== state.refs.size) throw new Error('Відповідь AI має містити всі поля плану рівно один раз.');
    return updates.map(function (update) {
      if (!isObject(update) || Object.keys(update).length !== 2 || !own(update, 'targetId') || !own(update, 'value') || typeof update.targetId !== 'string' || typeof update.value !== 'string') throw new Error('Некоректний формат оновлення AI.');
      var reference = state.refs.get(update.targetId);
      if (!reference || seen.has(update.targetId)) throw new Error('AI повернув невідоме або повторне поле.');
      if (update.value.length > reference.target.maxLength) throw new Error('Текст AI перевищує ліміт поля «' + reference.target.label + '».');
      if (/^(?:cards|moreCards)\.(?:name|bonus|note|features|payout|payoutNote)$/.test(reference.target.field) && reference.target.currentValue.trim() && update.value.trim() && update.value !== reference.target.currentValue) { var factError=new Error('Ручні факти пропозиції треба зберегти дослівно. Зміни їх вручну.');factError.code='CONTENT_FACT_REVIEW_REQUIRED';throw factError; }
      if (!safeLinkUpdate(reference.target, update.value)) throw new Error('ШІ додав, прибрав або змінив посилання в тексті. Чернетку не змінено. Спробуй ще раз або відредагуй поле вручну.');
      seen.add(update.targetId);
      return { targetId: update.targetId, value: update.value };
    });
  }
  function apply(plan, currentConfig, updates) {
    requireConfig(currentConfig);
    var state = planState(plan), validated = validateUpdates(plan, updates);
    var result = { applied: 0, conflicts: 0, emptySkipped: 0, unchanged: 0, patches: [], skipped: [] };
    var linksChanged = state.linkSnapshot !== JSON.stringify(currentConfig.aiLinkInsertions);
    validated.forEach(function (update) {
      var reference = state.refs.get(update.targetId), rowIndex = -1, reason = '';
      if (currentConfig !== state.config) reason = 'replaced-config';
      else if (linksChanged) reason = 'changed-links';
      else if (reference.collection) {
        rowIndex = Array.isArray(currentConfig[reference.collection]) ? currentConfig[reference.collection].indexOf(reference.object) : -1;
        if (rowIndex === -1) reason = 'removed';
        else if (reference.target.allowedLinks.length && reference.originalPath !== reference.collection + '.' + rowIndex + '.' + reference.key) reason = 'moved';
      }
      if (!reason && rawValue(reference.object, reference.key) !== reference.snapshot) reason = 'changed';
      if (!reason && state.mode === 'empty' && currentValue(reference.object, reference.key).trim()) reason = 'changed';
      if (reason) { result.conflicts++; result.skipped.push({ targetId: update.targetId, reason: reason }); return; }
      if (!update.value.trim()) { result.emptySkipped++; result.skipped.push({ targetId: update.targetId, reason: 'blank' }); return; }
      if (update.value === reference.snapshot) { result.unchanged++; result.skipped.push({ targetId: update.targetId, reason: 'unchanged' }); return; }
      var path = reference.collection ? reference.collection + '.' + rowIndex + '.' + reference.key : reference.key;
      result.patches.push({ targetId: update.targetId, path: path, before: reference.target.currentValue, after: update.value });
      reference.object[reference.key] = update.value;
      if(reference.target.allowedLinks.length){
        var current = currentConfig.aiLinkInsertions || [];
        var ids = new Set(current.map(function(item){return item.id;}));
        state.insertions.filter(function(item){return item.fieldPath===reference.originalPath;}).forEach(function(item){if(!ids.has(item.id))current=current.concat([Object.assign({},item)]);});
        currentConfig.aiLinkInsertions = current;
      }
      result.applied++;
    });
    return result;
  }
  var PALETTES = {
    emerald: { background: '#f6feff', accent: '#d9361c', header: '#080220', card: '#0c6c4b' },
    forest: { background: '#faf8fc', accent: '#d9361c', header: '#082c00', card: '#116b3a' },
    rose: { background: '#fbf9f8', accent: '#fa78b9', header: '#171717', card: '#293f2d' }
  };
  function normalizeColor(value, fallback) {
    if (typeof value !== 'string') return fallback;
    value = value.trim();
    if (/^#[0-9a-f]{3}$/i.test(value)) value = '#' + value.slice(1).split('').map(function (part) { return part + part; }).join('');
    return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  }
  function parseLinks(linksText) {
    if (typeof linksText !== 'string') throw new Error('Введіть посилання окремими рядками.');
    var lines = linksText.split(/\r\n?|\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    if (!lines.length || lines.length > 20) throw new Error('Додайте від 1 до 20 посилань, кожне з нового рядка.');
    return lines.map(function (line, index) {
      var label = '', url = line, separator = line.indexOf('|');
      if (!/^https?:\/\//i.test(line) && separator !== -1) { label = line.slice(0, separator).trim(); url = line.slice(separator + 1).trim(); }
      var parsed;
      try { parsed = new URL(url); } catch (_) { parsed = null; }
      if (!/^https?:\/\//i.test(url) || /[\u0000-\u0020\u007f]/.test(url) || url.length > 4000 || !parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || !parsed.hostname || parsed.username || parsed.password) throw new Error('Рядок ' + (index + 1) + ': потрібна повна HTTP(S)-адреса без пробілів і даних входу.');
      if (label.length > 300) throw new Error('Рядок ' + (index + 1) + ': назва біля посилання перевищує 300 символів.');
      // Keep the supplied destination, including tracking, encoding and hash, exactly.
      return { name: label || parsed.hostname, url: url };
    });
  }
  function blankCard(link) {
    var card = { name: link.name, image: '', bonus: '', rating: '', url: link.url, logoUrl: '', button: '', note: '', features: '', payout: '', payoutNote: '' };
    return card;
  }
  function repeated(count, factory) { return Array.from({ length: count }, function (_, index) { return factory(index); }); }
  function createProject(existingConfig, linksText, options) {
    requireConfig(existingConfig);
    var links = parseLinks(linksText);
    var cardCount = options && options.cardCount !== undefined ? options.cardCount : links.length;
    if (!Number.isInteger(cardCount) || cardCount < links.length || cardCount > 20) throw new Error('Кількість карток: від кількості посилань до 20.');
    var cardLinks = repeated(cardCount,function(index){return links[index % links.length];});
    var preset = own(PALETTES, existingConfig.preset) ? existingConfig.preset : 'emerald';
    var project = { language: languageTag(existingConfig.language || 'English'), version: 1, contentMode: 'builder', importHtml: '', importBaseUrl: '', importChrome: 'add', importReplaceHeader: false, importReplaceFooter: false };
    TOP_GROUPS.forEach(function (group) { group[2].forEach(function (field) { project[field[0]] = ''; }); });
    ['author', 'date', 'authorImage', 'brandUrl', 'footerBrandUrl', 'brandImage', 'promoUrl'].forEach(function (field) { project[field] = ''; });
    project.preset = preset;
    project.fontFamily = ['Arial','Georgia','Verdana','Trebuchet MS','system-ui'].indexOf(existingConfig.fontFamily) >= 0 ? existingConfig.fontFamily : 'Arial';
    if (isObject(existingConfig.designVariant)) project.designVariant = JSON.parse(JSON.stringify(existingConfig.designVariant));
    project.mode = existingConfig.mode === 'inline' ? 'inline' : 'fullscreen';
    project.chromeMode = existingConfig.chromeMode === 'overlay-only' ? 'overlay-only' : 'custom';
    project.showToc = typeof existingConfig.showToc === 'boolean' ? existingConfig.showToc : true;
    project.colors = {};
    var existingColors = isObject(existingConfig.colors) ? existingConfig.colors : {};
    Object.keys(PALETTES[preset]).forEach(function (field) { project.colors[field] = normalizeColor(own(existingColors, field) ? existingColors[field] : '', PALETTES[preset][field]); });
    project.cards = cardLinks.slice(0, 5).map(blankCard);
    project.moreCards = cardLinks.slice(5).map(blankCard);
    project.sections = repeated(8, function () { return { title: '', body: '', image: '' }; });
    project.faq = repeated(5, function () { return { question: '', answer: '' }; });
    project.tiles = repeated(4, function () { return { name: '', image: '', body: '', url: '' }; });
    project.services = repeated(4, function () { return { name: '', image: '', body: '', url: '' }; });
    project.reviews = links.slice(0, 8).map(function (link) { return { title: link.name, image: '', body: '', url: link.url }; });
    project.navLinks = [];
    return project;
  }
  return Object.freeze({ collectFacts: collectFacts, languageTag: languageTag, FIELD_LIMITS: FIELD_LIMITS, fieldLimit: fieldLimit, listGroups: listGroups, makePlan: makePlan, validateUpdates: validateUpdates, apply: apply, createProject: createProject });
}));
