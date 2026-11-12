(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('css-tree'));
  else root.PagePosterHTMLPackage = factory(root, root.csstree);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root, csstree) {
  'use strict';
  var MAX_HTML = 500000, MAX_PACKAGE = 20 * 1024 * 1024, MAX_FILES = 512, MAX_RATIO = 200, MAX_CSS_DEPTH = 12;
  function fail(message) { throw new Error(message); }
  function decodeText(bytes, preserveBom, allowUtf16) {
    var encoding = 'utf-8';
    if (allowUtf16 && bytes[0] === 255 && bytes[1] === 254) encoding = 'utf-16le';
    if (allowUtf16 && bytes[0] === 254 && bytes[1] === 255) encoding = 'utf-16be';
    try {
      var value = new root.TextDecoder(encoding, { fatal: true, ignoreBOM: encoding === 'utf-8' && !!preserveBom }).decode(bytes);
      if (value.includes('\0')) fail('NUL');
      return value;
    } catch (_) {
      fail(allowUtf16 ? 'Некоректне кодування HTML/CSS. Використайте UTF-8 або UTF-16 з BOM.' : 'Назва файлу має некоректне кодування UTF-8.');
    }
  }
  function byteLength(value) { return new root.TextEncoder().encode(value).length; }
  function htmlBound(value) { if (byteLength(value) > MAX_HTML) fail('HTML разом із вбудованими ресурсами перевищує ліміт 500 000 байтів.'); return value; }
  function archivePath(value, directory) {
    if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\u0000-\u001f\u007f?#]/.test(value) || value[0] === '/') fail('Небезпечний шлях файлу в HTML-пакеті.');
    if (directory && value.endsWith('/')) value = value.slice(0, -1);
    var parts = value.split('/');
    parts.forEach(function (part) {
      if (!part || part === '.' || part === '..' || /[. ]$/.test(part)) fail('Небезпечний шлях файлу в HTML-пакеті.');
      var decoded; try { decoded = decodeURIComponent(part); } catch (_) { fail('Некоректний шлях файлу в HTML-пакеті.'); }
      if (decoded !== part || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) fail('Небезпечний шлях файлу в HTML-пакеті.');
    });
    return parts.join('/');
  }
  function registerPath(paths, name, directory) {
    var parts = name.split('/'), prefix = '';
    parts.forEach(function (part, index) {
      prefix = prefix ? prefix + '/' + part : part;
      var key = prefix.normalize('NFC').toLowerCase(), existing = paths.get(key);
      var explicit = index === parts.length - 1, folder = directory || !explicit;
      if (existing && (existing.name !== prefix || existing.folder !== folder || (existing.explicit && explicit))) {
        fail('Неоднозначний або дубльований шлях у HTML-пакеті: ' + prefix);
      }
      if (!existing || explicit) paths.set(key, {name: prefix, folder: folder, explicit: explicit});
    });
  }
  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) { crc ^= bytes[i]; for (var bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  }
  async function inflate(bytes, expected) {
    if (!root.DecompressionStream || !root.ReadableStream) fail('Цей браузер не підтримує розпакування ZIP. Виберіть HTML та файли ресурсів окремо.');
    var reader;
    try {
      var stream = new root.ReadableStream({ start: function (controller) { controller.enqueue(bytes); controller.close(); } });
      reader = stream.pipeThrough(new root.DecompressionStream('deflate-raw')).getReader();
      var chunks = [], size = 0;
      while (true) {
        var part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > expected || size > MAX_PACKAGE) { await reader.cancel(); fail('ZIP: розмір розпакованого файлу перевищує заявлений ліміт.'); }
        chunks.push(part.value);
      }
      if (size !== expected) fail('ZIP: некоректний розмір розпакованого файлу.');
      var result = new Uint8Array(size), offset = 0;
      chunks.forEach(function (chunk) { result.set(chunk, offset); offset += chunk.length; });
      return result;
    } catch (error) {
      if (reader) { try { await reader.cancel(); } catch (_) {} }
      fail('Пошкоджений або непідтримуваний ZIP-архів: ' + error.message);
    }
  }
  async function unzip(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX_PACKAGE) fail('ZIP має бути не більшим за 20 МБ.');
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    function check(offset, length) { if (offset < 0 || length < 0 || offset + length > bytes.length) fail('Пошкоджений ZIP-архів.'); }
    function u16(offset) { check(offset, 2); return view.getUint16(offset, true); }
    function u32(offset) { check(offset, 4); return view.getUint32(offset, true); }
    var end = -1;
    for (var position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
      if (u32(position) === 0x06054b50 && position + 22 + u16(position + 20) === bytes.length) { end = position; break; }
    }
    if (end < 0) fail('Пошкоджений ZIP-архів або ZIP64 не підтримується.');
    var count = u16(end + 10), directorySize = u32(end + 12), directoryOffset = u32(end + 16);
    if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count === 65535 || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('Багатотомні ZIP та ZIP64 не підтримуються.');
    if (!count || count > MAX_FILES || directoryOffset + directorySize !== end) fail('ZIP: перевищено ліміт файлів або пошкоджено каталог архіву.');
    var entries = [], paths = new Map(), ranges = [], total = 0, cursor = directoryOffset;
    for (var i = 0; i < count; i++) {
      check(cursor, 46);
      if (u32(cursor) !== 0x02014b50) fail('Пошкоджений каталог ZIP-архіву.');
      var flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16), compressed = u32(cursor + 20), size = u32(cursor + 24);
      var nameSize = u16(cursor + 28), extraSize = u16(cursor + 30), commentSize = u16(cursor + 32), disk = u16(cursor + 34), attributes = u32(cursor + 38), localOffset = u32(cursor + 42);
      if ((flags & ~0x080e) || (flags & 1) || (flags & 0x40) || (method !== 0 && method !== 8) || disk || compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) fail('Зашифровані або непідтримувані файли ZIP-архіву.');
      if (((attributes >>> 16) & 0xf000) === 0xa000) fail('ZIP: символічні посилання не підтримуються.');
      check(cursor + 46, nameSize + extraSize + commentSize);
      var rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
      // UTF-8 and ASCII names are deterministic; legacy code pages are ambiguous.
      if (!(flags & 0x800) && rawName.some(function (value) { return value > 127; })) fail('ZIP: назва файлу має використовувати UTF-8.');
      var originalName = decodeText(rawName), directory = originalName.endsWith('/'), name = archivePath(originalName, directory);
      registerPath(paths, name, directory);
      if (size > MAX_PACKAGE || (total += size) > MAX_PACKAGE || (size && (!compressed || size / compressed > MAX_RATIO))) fail('ZIP: перевищено ліміт розміру 20 МБ або коефіцієнта стиснення.');
      check(localOffset, 30);
      if (u32(localOffset) !== 0x04034b50 || u16(localOffset + 6) !== flags || u16(localOffset + 8) !== method) fail('Пошкоджений локальний заголовок ZIP-архіву.');
      var localNameSize = u16(localOffset + 26), localExtra = u16(localOffset + 28), start = localOffset + 30 + localNameSize + localExtra;
      check(localOffset + 30, localNameSize + localExtra); check(start, compressed);
      if (localNameSize !== nameSize || rawName.some(function (value, index) { return bytes[localOffset + 30 + index] !== value; })) fail('Неоднозначний шлях у заголовках ZIP-архіву.');
      if (!(flags & 8) && (u32(localOffset + 14) !== crc || u32(localOffset + 18) !== compressed || u32(localOffset + 22) !== size)) fail('Пошкоджені розміри або CRC ZIP-архіву.');
      if (start + compressed > directoryOffset || localOffset >= directoryOffset) fail('ZIP: файли перекривають каталог архіву.');
      ranges.push([localOffset, start + compressed]);
      if (directory && (size || compressed)) fail('Пошкоджений каталог ZIP-архіву.');
      entries.push({ name: name, directory: directory, size: size, method: method, crc: crc, compressed: bytes.subarray(start, start + compressed) });
      cursor += 46 + nameSize + extraSize + commentSize;
    }
    if (cursor !== directoryOffset + directorySize) fail('Пошкоджений каталог ZIP-архіву.');
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    for (var range = 1; range < ranges.length; range++) if (ranges[range][0] < ranges[range - 1][1]) fail('ZIP: файли архіву перекриваються.');
    var files = [];
    // Validate every entry, including unused extras, before making it available.
    for (var entry of entries) {
      var unpacked = entry.method === 0 ? entry.compressed : await inflate(entry.compressed, entry.size);
      if (unpacked.length !== entry.size || crc32(unpacked) !== entry.crc) fail('ZIP: пошкоджений файл або некоректний CRC.');
      if (!entry.directory) files.push({ name: entry.name, bytes: unpacked });
    }
    return files;
  }
  function mimeFor(name, bytes, kind) {
    var extension = name.split('.').pop().toLowerCase(), mime = '', signature = function (text, offset) { offset = offset || 0; return Array.from(text).every(function (character, i) { return bytes[offset + i] === character.charCodeAt(0); }); };
    if (kind === 'image') {
      if (extension === 'png' && bytes.length >= 24 && bytes[0] === 137 && signature('PNG\r\n\x1a\n', 1)) mime = 'image/png';
      if (/^jpe?g$/.test(extension) && bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
      if (extension === 'gif' && bytes.length >= 10 && (signature('GIF87a') || signature('GIF89a'))) mime = 'image/gif';
      if (extension === 'webp' && bytes.length >= 16 && signature('RIFF') && signature('WEBP', 8)) mime = 'image/webp';
    } else if (kind === 'font') {
      if (extension === 'woff2' && bytes.length >= 48 && signature('wOF2')) mime = 'font/woff2';
      if (extension === 'woff' && bytes.length >= 44 && signature('wOFF')) mime = 'font/woff';
      if (extension === 'ttf' && bytes.length >= 12 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) mime = 'font/ttf';
      if (extension === 'otf' && bytes.length >= 12 && signature('OTTO')) mime = 'font/otf';
    }
    if (!mime) fail('Непідтримуваний або некоректний формат ресурсу: ' + name + '. Дозволені PNG, JPEG, GIF, WEBP та WOFF/WOFF2/TTF/OTF.');
    return mime;
  }
  function base64(bytes) {
    var parts = [];
    for (var i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    return root.btoa(parts.join(''));
  }
  function create(window) {
    if (!window || !window.DOMParser || !csstree) fail('Для HTML-пакета потрібні браузерний DOM та CSS Tree.');
    async function prepareFiles(selection) {
      var selected = Array.from(selection || []);
      if (!selected.length) fail('Виберіть один HTML-файл або ZIP-пакет із ресурсами.');
      if (selected.length > MAX_FILES) fail('HTML-пакет містить забагато файлів: ліміт 512.');
      var totalInput = 0;
      selected.forEach(function (file) {
        if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.arrayBuffer !== 'function' || (totalInput += file.size) > MAX_PACKAGE) fail('Перевищено ліміт розміру HTML-пакета 20 МБ.');
      });
      var isZip = selected.length === 1 && /\.zip$/i.test(selected[0].name || ''), files = [], flat = !isZip && selected.every(function (file) { return !file.webkitRelativePath; });
      if (!isZip && selected.some(function (file) { return /\.zip$/i.test(file.name || ''); })) fail('Виберіть один ZIP-архів або HTML та ресурси окремо.');
      for (var file of selected) {
        var bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length !== file.size || bytes.length > MAX_PACKAGE) fail('Некоректний розмір файлу HTML-пакета.');
        if (isZip) files = await unzip(bytes);
        else files.push({ name: archivePath(file.webkitRelativePath || file.name, false), bytes: bytes });
      }
      var sources = files.filter(function (item) { return /\.html?$/i.test(item.name); });
      if (sources.length !== 1) fail('HTML-пакет має містити рівно один HTML-файл; кілька сторінок неоднозначні.');
      return prepareSource(sources[0], indexPackage(files), flat, !isZip && selected.length === 1);
    }
    function indexPackage(files) {
      if (!files.length || files.length > MAX_FILES) fail('HTML-пакет має містити від 1 до 512 файлів.');
      var byPath = new Map(), basenames = new Map(), paths = new Map(), packageBytes = 0;
      files.forEach(function (item) {
        registerPath(paths, archivePath(item.name, false), false);
        byPath.set(item.name, item); packageBytes += item.bytes.length;
        var basename = item.name.split('/').pop();
        if (!basenames.has(basename)) basenames.set(basename, []); basenames.get(basename).push(item);
      });
      if (packageBytes > MAX_PACKAGE) fail('Розпакований HTML-пакет перевищує 20 МБ.');
      return {byPath: byPath, basenames: basenames, packageBytes: packageBytes};
    }
    async function prepareArchiveFiles(files, selected = files.filter(function (item) { return /\.html?$/i.test(item.name); })) {
      var index = indexPackage(files), result = [], names = new Set(), total = 0;
      for (var source of selected) {
        var name = source.name.split('/').pop(), key = name.normalize('NFC').toLowerCase();
        if (names.has(key)) fail('В архіві кілька HTML із назвою «' + name + '». Зробіть назви унікальними.');
        names.add(key);
        var prepared = await prepareSource(source, index, false, false, true);
        total += byteLength(prepared.html);
        if (total > MAX_PACKAGE) fail('HTML після вбудовування ресурсів перевищує 20 МБ.');
        result.push(prepared);
      }
      return result;
    }
    async function prepareSource(source, index, flat, loneHTML, preserveBom) {
      var byPath = index.byPath, basenames = index.basenames, packageBytes = index.packageBytes;
      var sourceText = htmlBound(decodeText(source.bytes, preserveBom, true)), used = new Set(), cachedData = new Map(), cachedCSS = new Map(), warnings = [], preparedStyles = new Set();
      var cssImports = 0;
      var document = new window.DOMParser().parseFromString(sourceText, 'text/html');
      if (document.querySelectorAll('*').length > 10000) fail('HTML містить забагато елементів: ліміт 10 000 вузлів.');
      function resolve(value, context) {
        value = String(value || '').trim();
        if (!value || value[0] === '#') return null;
        if (/^(?:https?:)?\/\//i.test(value)) return null;
        if (/^data:/i.test(value)) return null;
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /[\\\u0000-\u001f\u007f]/.test(value)) fail('Непідтримуваний шлях ресурсу: ' + value);
        var path = value.split(/[?#]/)[0];
        try { path = decodeURIComponent(path); } catch (_) { fail('Некоректний шлях ресурсу: ' + value); }
        if (/[\\:\u0000-\u001f\u007f%]/.test(path) || path.startsWith('//')) fail('Небезпечний шлях ресурсу: ' + value);
        var parts = path[0] === '/' ? [] : context.split('/').slice(0, -1);
        path.split('/').forEach(function (part) { if (!part || part === '.') return; if (part === '..') { if (!parts.length) fail('Шлях ресурсу виходить за межі HTML-пакета: ' + value); parts.pop(); } else parts.push(part); });
        var resolved = parts.join('/'), match = byPath.get(resolved);
        if (!match && flat) {
          var candidates = basenames.get(parts[parts.length - 1]) || [];
          if (candidates.length === 1) match = candidates[0];
          else if (candidates.length > 1) fail('Неоднозначний ресурс у HTML-пакеті: ' + value);
        }
        if (!match && loneHTML) {
          warnings.push('Не вибрано локальний ресурс ' + value + ': додайте папку assets або ZIP-пакет, або вкажіть базову адресу сторінки.');
          return null;
        }
        if (!match) fail('Відсутній локальний ресурс: ' + value + '. Виберіть HTML разом із папкою assets або ZIP-пакет.');
        return match;
      }
      function embedded(value, kind, context) {
        if (/^data:/i.test(value)) {
          var allowed = kind === 'font' ? /^data:font\/(?:woff2?|ttf|otf);base64,[a-z0-9+/]+={0,2}$/i : /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i;
          if (!allowed.test(value)) fail('Непідтримуваний формат вбудованого ресурсу.');
          return value;
        }
        var item = resolve(value, context); if (!item) return value;
        var key = kind + ':' + item.name;
        if (!cachedData.has(key)) {
          // No legal embedded resource can fit if its own encoding exceeds the output limit.
          if (Math.ceil(item.bytes.length / 3) * 4 > MAX_HTML) fail('HTML із ресурсами перевищує ліміт 500 000 байтів.');
          cachedData.set(key, 'data:' + mimeFor(item.name, item.bytes, kind) + ';base64,' + base64(item.bytes));
        }
        used.add(item.name); return cachedData.get(key);
      }
      async function css(text, context, stack, inline) {
        if (stack.length > MAX_CSS_DEPTH) fail('CSS перевищує ліміт глибини імпортів.');
        htmlBound(text);
        var ast;
        try { ast = csstree.parse(text, { context: inline ? 'declarationList' : 'stylesheet', parseCustomProperty: true }); }
        catch (_) { fail('Некоректний CSS у файлі: ' + context); }
        var imports = [], urls = [], estimate = byteLength(csstree.generate(ast));
        csstree.walk(ast, { enter: function (node, item, list) {
          if (node.type === 'Atrule' && csstree.ident.decode(node.name).toLowerCase() === 'import') { imports.push({ node: node, item: item, list: list }); return this.skip; }
          if (node.type === 'Url') urls.push({ node: node, font: !!(this.atrule && csstree.ident.decode(this.atrule.name).toLowerCase() === 'font-face') });
        } });
        for (var importing of imports) {
          if (++cssImports > MAX_FILES) fail('CSS перевищує ліміт кількості імпортів.');
          var children = importing.node.prelude && importing.node.prelude.children.toArray(), first = children && children[0];
          if (!first || (first.type !== 'Url' && first.type !== 'String')) fail('Непідтримуваний CSS @import у файлі: ' + context);
          var dependency = resolve(first.value, context);
          if (!dependency) { warnings.push('Зовнішній CSS @import не завантажено; його перевірить HTML-імпортер.'); continue; }
          if (!/\.css$/i.test(dependency.name)) fail('Непідтримуваний формат CSS ресурсу: ' + dependency.name);
          if (stack.indexOf(dependency.name) !== -1) fail('Цикл імпортів CSS у HTML-пакеті: ' + dependency.name);
          var tail = children.slice(1);
          if (tail.some(function (node) { return node.type !== 'MediaQueryList'; })) fail('Непідтримувана умова CSS @import: ' + dependency.name);
          var imported = await stylesheet(dependency, stack);
          var replacement = tail.length ? '@media ' + tail.map(function (node) { return csstree.generate(node); }).join(' ') + '{' + imported + '}' : imported;
          estimate += byteLength(replacement) - byteLength(csstree.generate(importing.node));
          if (estimate > MAX_HTML) fail('CSS із ресурсами перевищує ліміт HTML 500 000 байтів.');
          var parsed = csstree.parse(replacement);
          importing.list.replace(importing.item, parsed.children);
        }
        for (var url of urls) {
          var previousSize = byteLength(url.node.value);
          url.node.value = embedded(url.node.value, url.font ? 'font' : 'image', context);
          estimate += byteLength(url.node.value) - previousSize;
          if (estimate > MAX_HTML) fail('CSS із ресурсами перевищує ліміт HTML 500 000 байтів.');
        }
        // A style element's text is raw HTML even when set with textContent.
        return htmlBound(csstree.generate(ast).replace(/</g, '\\3c '));
      }
      async function stylesheet(item, stack) {
        used.add(item.name);
        if (!cachedCSS.has(item.name)) cachedCSS.set(item.name, await css(decodeText(item.bytes, false, true), item.name, stack.concat(item.name), false));
        return cachedCSS.get(item.name);
      }
      // This is resource preparation, not a sanitizer. DOMParser leaves source
      // scripts inert; the existing HTML importer sanitizes the prepared source.
      document.querySelectorAll('base').forEach(function (base) { base.remove(); });
      for (var link of Array.from(document.querySelectorAll('link'))) {
        var rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/), href = link.getAttribute('href') || '';
        if (rel.indexOf('stylesheet') !== -1) {
          var sheet = resolve(href, source.name);
          if (!sheet) continue;
          if (!/\.css$/i.test(sheet.name)) fail('Непідтримуваний формат CSS ресурсу: ' + sheet.name);
          var style = document.createElement('style'); style.textContent = await stylesheet(sheet, []);
          preparedStyles.add(style);
          if (link.hasAttribute('media')) style.setAttribute('media', link.getAttribute('media')); link.replaceWith(style);
        } else link.remove(); // Preloads and favicons are unnecessary after embedding.
      }
      for (var styleElement of Array.from(document.querySelectorAll('style'))) {
        // Styles created from CSS files have already resolved their relative paths.
        if (!preparedStyles.has(styleElement)) styleElement.textContent = await css(styleElement.textContent, source.name, [], false);
      }
      for (var element of Array.from(document.querySelectorAll('[style]'))) element.setAttribute('style', await css(element.getAttribute('style'), source.name, [], true));
      for (var image of Array.from(document.querySelectorAll('img'))) {
        if (image.hasAttribute('src')) image.setAttribute('src', embedded(image.getAttribute('src'), 'image', source.name));
        if (image.hasAttribute('srcset')) {
          var candidates = image.getAttribute('srcset').split(',').map(function (candidate) {
            var parts = candidate.trim().match(/^(\S+)(?:\s+((?:\d+(?:\.\d+)?x)|(?:\d+w)))?$/);
            if (!parts || /^data:/i.test(parts[1])) fail('Непідтримуваний формат srcset; використайте локальні зображення.');
            return embedded(parts[1], 'image', source.name) + (parts[2] ? ' ' + parts[2] : '');
          });
          image.setAttribute('srcset', candidates.join(', '));
        }
      }
      var html = used.size ? htmlBound('<!doctype html>\n' + document.documentElement.outerHTML) : sourceText;
      return { html: html, name: source.name.split('/').pop(), assetCount: used.size, sourceBytes: source.bytes.length, packageBytes: packageBytes, warnings: Array.from(new Set(warnings)) };
    }
    return { prepareFiles: prepareFiles, prepareArchiveFiles: prepareArchiveFiles };
  }
  return { create: create, unpackZip: unzip, archivePath: archivePath, decodeHtml: function (bytes, preserveBom) { return htmlBound(decodeText(bytes, preserveBom !== false, true)); }, prepareFiles: function (files) { return create(root).prepareFiles(files); }, prepareArchiveFiles: function (files, selected) { return create(root).prepareArchiveFiles(files, selected); } };
}));
