(function (root) {
  'use strict';
  const maxPackage = 20 * 1024 * 1024;
  const maxHtml = 500000;
  const tableExtension = /\.(csv|tsv|txt|md|xlsx|docx)$/i;
  const urlColumn = /^url(?:[2-9]|1\d|20)?$/;
  const textBriefExtension = /\.(txt|md)$/i;
  const aliases = new Map(Object.entries({
    'посилання': 'url', 'ссылка': 'url', 'link': 'url', 'target url': 'url',
    'анкор': 'anchor', 'anchor text': 'anchor',
    'назва': 'title', 'заголовок': 'title', 'название': 'title',
    'мова': 'language', 'язык': 'language', 'lang': 'language',
    'країна': 'geo', 'страна': 'geo', 'гео': 'geo', 'country': 'geo',
    'файл': 'file', 'filename': 'file', 'ім’я файлу': 'file',
    'dr': 'minDr', 'мін. dr': 'minDr', 'трафік': 'minTraffic', 'трафик': 'minTraffic', 'traffic': 'minTraffic',
    'донор':'donor', 'donor domain':'donor', 'сайт розміщення':'donor', 'домен розміщення':'donor',
    'слаг':'slug', 'слагг':'slug', 'url slug':'slug', 'page slug':'slug', 'post_name':'slug',
    'publication url':'placementUrl', 'url публікації':'placementUrl', 'адреса публікації':'placementUrl', 'url для публікації':'placementUrl'
  }));
  const knownColumn = /^(?:id|key|title|url(?:[2-9]|1\d|20)?|anchor(?:[2-9]|1\d|20)?|language|geo|mindr|mintraffic|format|topic|customtopic|file|links|html|baseurl|brand|brandurl|chromemode|slug|donor|placementurl)$/i;
  const privateHeader = /password|passwd|\bpwd\b|\blogin\b|username|api[\s_-]*key|credential|token|secret|парол|лог[іи]н|hasło|contraseña|passwort|mot de passe/iu;
  const briefFields = new Map(Object.entries({
    page:'page', 'сторінка':'page', 'страница':'page',
    key:'key', id:'key', 'ключ':'key', title:'title',
    url:'url', anchor:'anchor', language:'language', geo:'geo', file:'file',
    mindr:'minDr', mintraffic:'minTraffic', format:'format', 'формат':'format',
    topic:'topic', 'тема':'topic', customtopic:'customTopic', 'власна тема':'customTopic',
    baseurl:'baseUrl', 'адреса ресурсів':'baseUrl', slug:'slug', donor:'donor', placementurl:'placementUrl'
  }));

  function decode(bytes) {
    const utf16 = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : null;
    try {
      const value = new TextDecoder(utf16 || 'utf-8', {fatal: true}).decode(bytes);
      if (value.includes('\0')) throw Error();
      return value;
    } catch {
      throw Error('Не вдалося прочитати кодування. Збережіть файл у UTF-8.');
    }
  }

  function header(value) {
    const name = String(value).trim().toLowerCase();
    return aliases.get(name) || name;
  }

  async function tablePayload(text, sourceFile, sheet, optional, {mapColumns,hasHtml:packagedHtml=false}={}) {
    const parser = root.PagePosterProjectTable;
    // Archive TXT/MD files may contain licenses and notes. Look for a
    // table header before interpreting their prose as quoted CSV cells.
    const records = parser.read(text, {headerOnly: optional});
    const labels = (records[0] || []).map(value => value.trim());
    let headers = labels.map(header);
    if (optional && !headers.some(value => knownColumn.test(value)) && (!mapColumns || labels.length < 2)) return null;
    const matrix = optional ? parser.read(text) : records;
    let columnMapping;
    if(mapColumns && headers.some(value=>!knownColumn.test(value))){
      const inventory = packagedHtml && headers.includes('file') && /(?:^|\/)(?:publication-map|manifest)\./i.test(sourceFile);
      const safeLabels=labels.map((value,index)=>{
        if(!value||privateHeader.test(value)||inventory&&/^(?:main_key|words|faq)$/i.test(value))return '';
        if(value.length>80||!/^[\p{L}\p{M}\d _().#/:<>=?%+-]+$/u.test(value)||/[A-Za-z0-9_-]{28,}/.test(value))throw Error('Таблиця: колонка '+(index+1)+'. Заголовок не можна безпечно передати для розпізнавання.');
        return value;
      });
      const proposal = headers.some((value,index)=>!knownColumn.test(value)&&safeLabels[index])?await mapColumns(safeLabels,packagedHtml):headers.map(()=> '');
      if(!Array.isArray(proposal)||proposal.length!==headers.length||proposal.some(field=>typeof field!=='string'||field&&!knownColumn.test(field)))throw Error('API не підтвердив структуру таблиці.');
      if(proposal.some((field,index)=>!field&&safeLabels[index]&&!knownColumn.test(headers[index])&&!/^(?:notes?|comments?|примітк[аи]|коментарі?|заметки?)$/iu.test(safeLabels[index])))throw Error('API не визначив призначення всіх колонок. Перевірте заголовки таблиці.');
      columnMapping=headers.map((value,index)=>knownColumn.test(value)?value:safeLabels[index]?proposal[index]:'');
      if(new Set(columnMapping.filter(Boolean).map(value=>value.toLowerCase())).size!==columnMapping.filter(Boolean).length)throw Error('У таблиці кілька колонок з однаковим призначенням.');
      headers=columnMapping;
    }
    const hasHtml = headers.includes('html') || headers.includes('file');
    const hasAi = headers.includes('links') || headers.some(name => urlColumn.test(name) && headers.includes('anchor' + name.slice(3)));
    if (!hasHtml && !hasAi) {
      if (optional) return null;
      throw Error('У першому рядку таблиці потрібні колонки URL і анкор, HTML або ім’я файлу.');
    }
    if (hasHtml && hasAi) throw Error('Таблиця поєднує завдання для AI та готовий HTML. Розділіть їх на два проєкти.');
    return {
      type: hasHtml ? 'html' : 'ai',
      sourceFile: sourceFile.split('/').pop(),
      headers,
      text: columnMapping||labels.every((label,index)=>label===headers[index]) ? text :
        [headers,...matrix.slice(1)].map(row=>row.map(quote).join(',')).join('\n'),
      ...(columnMapping?{columnMapping}:{}),
      sheet
    };
  }

  function xml(files, name, expectedRoot, format = 'XLSX') {
    const entry = files.get(name);
    if (!entry) throw Error('У ' + format + ' бракує частини «' + name + '».');
    const value = decode(entry.bytes);
    if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(value)) throw Error(format + ' містить непідтримуваний XML.');
    const doc = new DOMParser().parseFromString(value, 'application/xml');
    if (doc.documentElement.localName !== expectedRoot || doc.getElementsByTagName('parsererror').length) throw Error('Пошкоджений XML у ' + format + '.');
    return doc.documentElement;
  }

  const descendants = (element, name) => Array.from(element.getElementsByTagNameNS('*', name));
  const children = (element, name) => Array.from(element.children).filter(child => child.localName === name);
  const richText = element => Array.from(element.children).map(child => {
    if (child.localName === 't') return child.textContent;
    if (child.localName === 'r') return children(child, 't').map(value => value.textContent).join('');
    return '';
  }).join('');
  const quote = value => '"' + value.replace(/"/g, '""') + '"';

  function briefField(line) {
    const plain = line.trim().replace(/^(?:#{1,6}|[-*+])\s+/, '');
    const match = /^(?:\*\*([^:*]{1,64}):\*\*|\*\*([^:*]{1,64})\*\*\s*:|([^:*]{1,64}):)\s*(.*)$/u.exec(plain);
    if (!match) return {};
    const label = header(match[1] || match[2] || match[3]).toLowerCase();
    return {key:briefFields.get(label),value:match[4].trim()};
  }

  function briefPayload(text, name) {
    const lines = text.split(/\r\n|\n|\r/,65001);
    const first = lines.findIndex(line => line.trim());
    if (first < 0 || briefField(lines[first]).key !== 'page') return null;
    if (lines.length > 65000) throw Error('ТЗ має містити не більше 65 000 рядків.');
    const records = [];
    let current;
    for (let index = first; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      const row = index + 1;
      const {key,value} = briefField(lines[index]);
      if (!key || !value) throw Error('ТЗ: рядок ' + row + '. Вкажіть відоме поле та його значення.');
      if (key === 'page') {
        if (records.length === 1000) throw Error('ТЗ має містити не більше 1000 сторінок.');
        current = {row,fields:{title:value},pairs:0};
        records.push(current);
        continue;
      }
      const suffix = current.pairs ? String(current.pairs + 1) : '';
      const pairField = key === 'url' || key === 'anchor';
      const field = key + (pairField ? suffix : '');
      if (pairField && current.pairs === 20) throw Error('ТЗ: рядок ' + row + '. Дозволено до 20 пар URL і анкорів на сторінку.');
      if (Object.hasOwn(current.fields,field)) throw Error('ТЗ: рядок ' + row + '. Поле повторюється або попередня пара URL і анкора неповна.');
      current.fields[field] = value;
      if (pairField && current.fields['url' + suffix] && current.fields['anchor' + suffix]) current.pairs++;
    }
    const kinds = new Set();
    for (const {row,fields,pairs} of records) {
      const hasLinks = Object.keys(fields).some(key => /^(?:url|anchor)\d*$/.test(key));
      if ((fields.file && (hasLinks || fields.format || fields.topic || fields.customTopic)) || (!fields.file && fields.baseUrl)) {
        throw Error('ТЗ: рядок ' + row + '. Розділіть завдання для AI та готовий HTML.');
      }
      if (!fields.file && (!pairs || fields['url' + (pairs + 1)] || fields['anchor' + (pairs + 1)])) {
        throw Error('ТЗ: рядок ' + row + '. Для кожного посилання вкажіть повну пару URL і анкора.');
      }
      kinds.add(fields.file ? 'html' : 'ai');
    }
    if (kinds.size > 1) throw Error('Розділіть завдання для AI та готовий HTML на два проєкти.');
    const headers = [...new Set(records.flatMap(record => Object.keys(record.fields)))];
    const rows = records.map(({fields}) => headers.map(key => quote(fields[key] || '')).join(','));
    const table = [headers.join(','), ...rows].join('\n');
    if (new TextEncoder().encode(table).length > maxPackage) throw Error('ТЗ після читання перевищує 20 МБ.');
    return {type:records[0].fields.file?'html':'ai',sourceFile:name.split('/').pop(),headers,text:table,sourceRows:records.map(record=>record.row)};
  }

  function wordLinkMatchesLabel(label, target) {
    const bareDomain = /^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+\.?(?::\d+)?(?:[/?#]\S*)?$/u.test(label);
    const absolute = !bareDomain && /^[a-z][a-z\d+.-]*:/i.test(label);
    const protocolRelative = label.startsWith('//');
    if (!absolute && !protocolRelative && !bareDomain) return true;
    const address = new URL(target);
    const displayed = absolute ? label : address.protocol + (protocolRelative ? '' : '//') + label;
    try {
      return new URL(displayed).href === address.href;
    } catch {
      return false;
    }
  }

  function sheetPath(target) {
    const path = target?.startsWith('/') ? target.slice(1) : 'xl/' + (target || '');
    if (!/^xl\/worksheets\/[a-z0-9_.-]+\.xml$/i.test(path)) throw Error('XLSX містить непідтримуваний шлях до аркуша.');
    return path;
  }

  async function readXlsx(bytes) {
    const entries = await root.PagePosterHTMLPackage.unpackZip(bytes);
    const files = new Map(entries.map(entry => [entry.name, entry]));
    const book = xml(files, 'xl/workbook.xml', 'workbook');
    const sheets = descendants(book, 'sheet').filter(sheet => !['hidden', 'veryHidden'].includes(sheet.getAttribute('state')));
    if (sheets.length !== 1) throw Error('Для імпорту XLSX залиште один видимий аркуш із даними або збережіть потрібний аркуш у CSV.');
    const sheet = sheets[0];
    const id = Array.from(sheet.attributes).find(attribute => attribute.localName === 'id')?.value;
    const relations = xml(files, 'xl/_rels/workbook.xml.rels', 'Relationships');
    const matches = descendants(relations, 'Relationship').filter(relation => relation.getAttribute('Id') === id && relation.getAttribute('Type')?.endsWith('/worksheet') && relation.getAttribute('TargetMode') !== 'External');
    if (matches.length !== 1) throw Error('Не вдалося визначити аркуш XLSX.');
    const worksheet = xml(files, sheetPath(matches[0].getAttribute('Target')), 'worksheet');
    const strings = files.has('xl/sharedStrings.xml') ? descendants(xml(files, 'xl/sharedStrings.xml', 'sst'), 'si').map(richText) : [];
    const rows = [];
    for (const row of descendants(worksheet, 'row')) {
      const number = Number(row.getAttribute('r'));
      if (!Number.isInteger(number) || number < 1 || number > 1001 || rows[number - 1]) throw Error('XLSX має містити до 1000 рядків даних після заголовка.');
      const values = [];
      for (const cell of children(row, 'c')) {
        const address = /^([A-Z]{1,3})([1-9]\d*)$/.exec(cell.getAttribute('r') || '');
        const column = address ? Array.from(address[1]).reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0) - 1 : -1;
        if (column < 0 || column >= 128 || Number(address[2]) !== number || values[column] !== undefined) throw Error('XLSX містить некоректні адреси або понад 128 колонок.');
        const type = cell.getAttribute('t') || 'n';
        if (children(cell, 'f').length || type === 'e') throw Error('Замініть формули й помилки Excel готовими значеннями перед імпортом.');
        const raw = children(cell, 'v')[0]?.textContent || '';
        if (type === 's' && (!/^\d+$/.test(raw) || strings[Number(raw)] === undefined)) throw Error('XLSX містить пошкоджену текстову клітинку.');
        const inline = children(cell, 'is')[0];
        values[column] = type === 's' ? strings[Number(raw)] : type === 'inlineStr' && inline ? richText(inline) : raw;
      }
      rows[number - 1] = values;
    }
    const width = rows[0]?.length || 0;
    if (!width) throw Error('Перша стрічка аркуша XLSX має містити заголовки.');
    let total = 0;
    const encoder = new TextEncoder();
    const text = Array.from(rows, row => {
      if (row?.slice(width).some(value => value !== '')) throw Error('У XLSX є дані в колонках без заголовків.');
      return Array.from({length: width}, (_, column) => {
        const cell = quote(row?.[column] || '');
        total += encoder.encode(cell).length + 2;
        if (total > maxPackage) throw Error('Таблиця після читання перевищує 20 МБ.');
        return cell;
      }).join(',');
    }).join('\r\n');
    return {text, sheet: sheet.getAttribute('name')};
  }

  async function readDocx(bytes,name) {
    const entries = await root.PagePosterHTMLPackage.unpackZip(bytes);
    const files = new Map(entries.map(entry => [entry.name, entry]));
    const document = xml(files, 'word/document.xml', 'document', 'DOCX');
    const ns = document.namespaceURI;
    if (!['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main'].includes(ns)) throw Error('Непідтримуваний формат Word XML.');
    const wordChildren = (element, name) => children(element, name).filter(child => child.namespaceURI === ns);
    const body = wordChildren(document, 'body'), tables = document.getElementsByTagNameNS(ns, 'tbl');
    const shapeError = 'Залиште в DOCX одну звичайну таблицю із заголовками й даними або почніть ТЗ з «Сторінка: назва».';
    if (body.length !== 1 || tables.length > 1 || tables.length === 1 && tables[0].parentNode !== body[0]) throw Error(shapeError);
    const content = tables[0] || body[0];
    const elements = Array.from(content.getElementsByTagNameNS(ns, '*'));
    if (content.getElementsByTagNameNS('http://schemas.openxmlformats.org/markup-compatibility/2006', 'AlternateContent').length) throw Error('DOCX містить альтернативний вміст. Збережіть потрібний варіант звичайним текстом.');
    if (elements.some(node => ['ins','del','moveTo','moveFrom','drawing','pict','object','fldChar','fldSimple','sdt','altChunk','vanish','webHidden'].includes(node.localName))) throw Error('DOCX: збережіть звичайний текст без полів, об’єктів, прихованого тексту чи невирішених правок.');
    if (elements.some(node => ['noBreakHyphen','softHyphen','sym'].includes(node.localName))) throw Error('DOCX: замініть спеціальні символи Word звичайними символами в тексті та адресах.');
    const paragraph = element => Array.from(element.getElementsByTagNameNS(ns, '*')).map(node => {
      if (node.localName === 't') return node.textContent;
      if (node.localName === 'tab') return '\t';
      return node.localName === 'br' || node.localName === 'cr' ? '\n' : '';
    }).join('');
    const relationshipNs = ns.replace('/wordprocessingml/', '/officeDocument/').replace(/\/main$/, '/relationships');
    const packageNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const relationshipFile = 'word/_rels/document.xml.rels';
    let relationships;
    function hyperlinkTarget(link) {
      if (!relationships) {
        relationships = new Map();
        if (files.has(relationshipFile)) {
          const root = xml(files, relationshipFile, 'Relationships', 'DOCX');
          for (const relation of children(root, 'Relationship')) {
            if (root.namespaceURI !== packageNs || relation.namespaceURI !== packageNs) continue;
            const id = relation.getAttribute('Id');
            relationships.set(id, relationships.has(id) ? null : relation);
          }
        }
      }
      const id = link.getAttributeNS(relationshipNs, 'id');
      const relation = id && relationships.get(id);
      if (relation?.getAttribute('Type') !== relationshipNs + '/hyperlink' ||
          relation.getAttribute('TargetMode') !== 'External' ||
          link.hasAttributeNS(ns, 'anchor') || link.hasAttributeNS(ns, 'docLocation')) return '';
      const target = relation.getAttribute('Target') || '';
      if (target.length > 4000 || !/^https?:\/\/[^/?#]/i.test(target) || /[\s\\\u0000-\u001f\u007f]/.test(target)) return '';
      try {
        const address = new URL(target);
        return address.hostname && !address.username && !address.password ? target : '';
      } catch {
        return '';
      }
    }
    if (!tables.length) {
      if (Array.from(content.children).some(node => node.namespaceURI !== ns || !['p','sectPr'].includes(node.localName))) throw Error(shapeError);
      let row = 1;
      const lines = wordChildren(content,'p').map(element => {
        const text = paragraph(element);
        const line = row;
        row += text.split('\n').length;
        const {key,value} = briefField(text);
        const links = element.getElementsByTagNameNS(ns,'hyperlink');
        if (!links.length) return text;
        if (text.includes('\n')) throw Error('DOCX: рядок ' + line + '. Помістіть поле з гіперпосиланням в окремий абзац.');
        if (key !== 'url') return text;
        const label = paragraph(links[0]).trim();
        const target = links.length === 1 && label && label === value ? hyperlinkTarget(links[0]) : '';
        if (!target || !wordLinkMatchesLabel(label,target)) throw Error('DOCX: рядок ' + line + '. Вкажіть одне однозначне посилання HTTP або HTTPS.');
        return 'URL: ' + target;
      });
      const brief = briefPayload(lines.join('\n'),name);
      if (!brief) throw Error(shapeError);
      return {brief};
    }
    const table = tables[0];
    const directParents = new Map([['tr','tbl'],['tc','tr'],['p','tc']]);
    if (elements.some(node => directParents.has(node.localName) &&
        (node.parentNode.namespaceURI !== ns || node.parentNode.localName !== directParents.get(node.localName)))) throw Error('DOCX: таблиця має вкладену структуру. Перенесіть рядки та клітинки у звичайну таблицю.');
    if (elements.some(node => ['gridSpan','hMerge','vMerge','gridBefore','gridAfter'].includes(node.localName))) throw Error('DOCX: роз’єднайте об’єднані клітинки та заповніть пропущені колонки.');
    const rows = wordChildren(table, 'tr');
    if (rows.length < 2 || rows.length > 1001) throw Error('DOCX: потрібен заголовок і від 1 до 1000 рядків даних.');
    const width = wordChildren(rows[0], 'tc').length;
    if (!width || width > 128) throw Error('DOCX: таблиця має містити від 1 до 128 колонок.');
    let headers;
    const text = rows.map((row, index) => {
      const cells = wordChildren(row, 'tc');
      if (cells.length !== width) throw Error('DOCX: рядок ' + (index + 1) + ' має іншу кількість клітинок, ніж заголовок.');
      const values = cells.map((cell, column) => {
        const value = wordChildren(cell, 'p').map(paragraph).join('\n');
        if (!headers || !urlColumn.test(headers[column])) return value;
        const links = cell.getElementsByTagNameNS(ns, 'hyperlink');
        if (!links.length) return value;
        const label = paragraph(links[0]).trim();
        const target = links.length === 1 && label && value.trim() === label ? hyperlinkTarget(links[0]) : '';
        if (!target || !wordLinkMatchesLabel(label, target)) {
          throw Error('DOCX: рядок ' + (index + 1) + ', колонка ' + (column + 1) + '. Вкажіть одне однозначне посилання HTTP або HTTPS.');
        }
        return target;
      });
      if (index === 0) {
        if (values.some(value => /[,;\t\r\n"]/.test(value))) throw Error('DOCX: укажіть прості назви колонок в одному рядку.');
        headers = values.map(header);
      }
      return values.map(quote).join(',');
    }).join('\r\n');
    return {text};
  }

  async function readTable(name, bytes, optional = false, options) {
    const {text, sheet, brief} = /\.xlsx$/i.test(name) ? await readXlsx(bytes) : /\.docx$/i.test(name) ? await readDocx(bytes,name) : {text: decode(bytes)};
    if (brief) return brief;
    if (textBriefExtension.test(name)) {
      const labeled = briefPayload(text,name);
      if (labeled) return labeled;
    }
    if (new TextEncoder().encode(text).length > maxPackage) throw Error('Таблиця після читання перевищує 20 МБ.');
    return tablePayload(text, name, sheet, optional,options);
  }

  async function normalize(file,options) {
    if (!file || file.size <= 0 || file.size > maxPackage) throw Error('Виберіть непорожній файл розміром до 20 МБ.');
    const name = file.name, bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length !== file.size) throw Error('Файл змінився під час читання. Виберіть його ще раз.');
    if (tableExtension.test(name)) {
      const table = await readTable(name, bytes,false,options);
      if (table.headers.includes('file')) throw Error('Джерело посилається на окремі HTML-файли. Додайте його разом із HTML в один архів.');
      return table;
    }
    if (/\.html?$/i.test(name)) {
      if (bytes.length > maxHtml) throw Error('Одна HTML-сторінка має бути не більшою за 500 000 байтів.');
      return {type: 'html', files: [{name, html: root.PagePosterHTMLPackage.decodeHtml(bytes)}]};
    }
    let entries;
    if (/\.zip$/i.test(name)) entries = await root.PagePosterHTMLPackage.unpackZip(bytes);
    else if (/\.rar$/i.test(name)) {
      if (!root.pageposterDesktop?.readProjectRar) throw Error('RAR можна прочитати в десктопі PagePoster.');
      const result = await root.pageposterDesktop.readProjectRar(bytes);
      if (result.error) throw Error(result.error);
      entries = result.entries;
    } else throw Error('Підтримуються CSV, TSV, TXT, MD, XLSX, DOCX, HTML, ZIP та RAR.');

    const tables = [];
    const sources = entries.filter(entry => /\.html?$/i.test(entry.name));
    const hasHtml = sources.length>0;
    for (const entry of entries.filter(entry => tableExtension.test(entry.name) && !/(?:^|\/)readme(?:[._ -]|$)/i.test(entry.name))) {
      const optional = textBriefExtension.test(entry.name);
      // A README or other plain text note is not an import table.
      const candidate = await readTable(entry.name, entry.bytes, optional,{...options,hasHtml});
      if (candidate) tables.push(candidate);
      if (tables.length > 1) break;
    }
    if (tables.length > 1) throw Error('В архіві кілька таблиць. Залиште одну таблицю завдань або зіставлення HTML.');
    const table = tables[0] || null;
    if (!hasHtml) {
      if (table && !table.headers.includes('file')) return table;
      throw Error('В архіві немає HTML-сторінок або самодостатньої таблиці завдань.');
    }
    if (table && !table.headers.includes('file')) throw Error('В архіві є HTML і таблиця. Для зіставлення вкажіть колонку «file» з іменами HTML-файлів.');
    let selected = sources;
    if (table && options?.mapColumns) {
      const column = table.headers.indexOf('file');
      const names = new Map();
      for (const source of sources) {
        for (const name of new Set([source.name, source.name.split('/').pop()])) {
          names.set(name, names.has(name) ? null : source);
        }
      }
      const included = new Set();
      const rows = root.PagePosterProjectTable.read(table.text).slice(1);
      for (const [index, row] of rows.entries()) {
        if (!row.some(value => value.trim())) continue;
        const source = names.get(row[column]?.trim());
        const number = table.sourceRows?.[index] ?? index + 2;
        if (!source || included.has(source)) {
          throw Error('Таблиця: рядок ' + number + '. HTML-файл відсутній, повторюється або вказаний неоднозначно.');
        }
        included.add(source);
      }
      selected = sources.filter(source => included.has(source));
    }
    const prepared = await root.PagePosterHTMLPackage.prepareArchiveFiles(entries, selected);
    return {...table, type: 'html', files: prepared.map(({name, html},index) => ({
      name,html,...(options?.mapColumns&&selected[index].name!==name?{path:selected[index].name}:{})
    }))};
  }

  root.PagePosterProjectNormalizer = Object.freeze({normalize});
}(globalThis));
