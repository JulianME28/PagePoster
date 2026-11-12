(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('dompurify'), require('css-tree'));
  else root.PagePosterHTML = factory(root, root.DOMPurify, root.csstree);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root, purifierLibrary, csstree) {
  'use strict';
  var MAX_SOURCE = 500000, MAX_ELEMENTS = 10000, MAX_RULES = 2000, MAX_DECLARATIONS = 15000;
  var FORBIDDEN = ['script', 'iframe', 'object', 'embed', 'form', 'input', 'select', 'option', 'textarea', 'base', 'meta', 'svg', 'math', 'template', 'canvas', 'video', 'audio', 'source', 'track', 'noscript'];
  var BAD_PROPERTIES = new Set(['behavior', '-moz-binding', 'animation', 'animation-name', 'animation-duration', 'animation-delay', 'animation-iteration-count', 'animation-timing-function', 'animation-fill-mode', 'animation-direction', 'animation-play-state', 'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'scroll-timeline', 'view-timeline', 'anchor-name', 'position-anchor']);
  var SAFE_FUNCTIONS = new Set(['counter', 'counters', 'var', 'calc', 'min', 'max', 'clamp', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient', 'repeat', 'minmax', 'fit-content', 'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale', 'scalex', 'scaley', 'scalez', 'scale3d', 'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective', 'cubic-bezier', 'steps']);
  function fail(message) { throw new Error(message); }
  function decode(value) { try { return csstree.ident.decode(value); } catch (_) { return value; } }
  function makeList(items) { return new csstree.List().fromArray(items); }
  function attributeValue(node) { return node && (node.type === 'String' ? node.value : node.type === 'Identifier' ? decode(node.name) : ''); }
  function stableHash(value) { var hash = 2166136261; for (var i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return (hash >>> 0).toString(36); }
  function create(window) {
    if (!window || !window.document || !window.DOMParser || !purifierLibrary || !csstree) fail('Для імпорту HTML потрібні DOMPurify, CSS Tree та браузерний DOM.');
    var purifier = typeof purifierLibrary.sanitize === 'function' && window === root ? purifierLibrary : purifierLibrary(window);
    if (!purifier || !purifier.isSupported || typeof purifier.sanitize !== 'function') fail('Безпечний HTML-імпорт недоступний у цьому браузері.');
    function process(source, options) {
      if (typeof source !== 'string') fail('HTML має бути текстовим рядком.');
      if (source.length > MAX_SOURCE) fail('HTML перевищує дозволений розмір 500 000 символів.');
      if (!source.trim()) fail('Додайте HTML для імпорту.');
      options = options || {};
      var baseUrl = '', warnings = [], warningSet = new Set(), idMap = new Map(), usedIds = new Set(), generated = 0;
      var stats = { elements: 0, links: 0, images: 0, headings: 0, cssRules: 0, removedElements: 0, removedAttributes: 0, removedRules: 0, removedDeclarations: 0 };
      var declarationCount = 0, ruleCount = 0, inlineCount = 0, inlineCSS = [], navigation = [], fonts = [], structuredData = [], customProperties = new Set(), fontFamilies = new Map();
      var sourceHash = stableHash(source), fontPrefix = 'ppi-font-' + sourceHash + '-', sourceSrcsets = [];
      var scope = '#pp-imported-content', normalScope = scope.repeat(3), importantScope = scope.repeat(4);
      var rootUnit = '--ppi-root-unit', rootVariablePrefix = '--ppi-root-var', usesRem = false;
      function warn(message) { if (!warningSet.has(message)) { warningSet.add(message); warnings.push(message); } }
      function absolute(value) {
        if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return '';
        try { var url = new window.URL(value); return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password ? value : ''; } catch (_) { return ''; }
      }
      if (options.baseUrl) { baseUrl = absolute(String(options.baseUrl).trim()); if (!baseUrl) fail('Базова адреса має бути повною HTTP(S)-адресою без даних входу.'); }
      function safeUrl(value, kind) {
        value = typeof value === 'string' ? value.trim() : '';
        if (!value) return '';
        if (value[0] === '#') {
          var original = value.slice(1), decoded;
          try { decoded = decodeURIComponent(original); } catch (_) { decoded = original; }
          var mapped = idMap.get(decoded) || (usedIds.has(decoded) ? decoded : '');
          if (mapped) return '#' + mapped;
          warn('Посилання на відсутні внутрішні розділи видалено.'); return '';
        }
        if (kind === 'image' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= MAX_SOURCE) return value;
        if (kind === 'font' && /^data:font\/(?:woff2?|ttf|otf);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= MAX_SOURCE) return value;
        if (kind === 'font') return '';
        if (absolute(value)) return value;
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) { warn('Небезпечні або непідтримувані URL видалено.'); return ''; }
        if (!baseUrl) { warn('Відносні URL видалено: вкажіть базову адресу оригінальної сторінки.'); return ''; }
        try { return absolute(new window.URL(value, baseUrl).href); } catch (_) { warn('Некоректні URL видалено.'); return ''; }
      }
      // Parse without executing source code. Recognize only a complete literal
      // window.open call; never evaluate source JavaScript or salvage partial calls.
      var original = new window.DOMParser().parseFromString(source, 'text/html');
      if (original.querySelectorAll('*').length > MAX_ELEMENTS) fail('HTML містить забагато елементів: ліміт 10 000 вузлів.');
      original.querySelectorAll('[data-ppi-nav], [data-ppi-srcset], [data-pp-url], [data-pp-target], [data-pp-priority]').forEach(function (element) {
        ['data-ppi-nav', 'data-ppi-srcset', 'data-pp-url', 'data-pp-target', 'data-pp-priority'].forEach(function (name) { element.removeAttribute(name); });
      });
      // DOMPurify's generic srcset parser splits data URL commas. Carry the
      // original inert value through a private attribute, then validate every
      // candidate below using the same strict image URL policy as ordinary src.
      original.querySelectorAll('img[srcset]').forEach(function (image) { var index = sourceSrcsets.length; sourceSrcsets.push(image.getAttribute('srcset')); image.setAttribute('data-ppi-srcset', String(index)); image.removeAttribute('srcset'); });
      original.querySelectorAll('button[onclick], div[onclick], span[onclick], a[onclick]').forEach(function (element) {
        if (element.closest('form,fieldset[disabled]') || element.hasAttribute('disabled')) return;
        var handler = element.getAttribute('onclick') || '';
        var match = handler.match(/^\s*(?:return\s+)?(?:window\.)?open\(\s*(['"])(https?:\/\/[^'"\\\s]+)\1\s*(?:,\s*(['"])(_blank|_self)\3\s*(?:,\s*(['"])(?:noopener(?:,noreferrer)?|noreferrer(?:,noopener)?)\5\s*)?)?\)\s*;?\s*$/i);
        if (!match || !absolute(match[2])) return;
        var index = navigation.length;
        navigation.push({ url: match[2], target: match[4] || '_blank', priority: element.tagName === 'BUTTON' ? 'offer' : '' });
        element.setAttribute('data-ppi-nav', String(index));
      });
      original.querySelectorAll('script[type="application/ld+json"]').forEach(function (script) {
        try { var value = JSON.parse(script.textContent); if (value && typeof value === 'object') structuredData.push(JSON.stringify(value).replace(/</g, '\\u003c')); } catch (_) { warn('Некоректну структуровану розмітку JSON-LD видалено.'); }
        script.remove();
      });
      var clean = purifier.sanitize(original.documentElement.outerHTML, { WHOLE_DOCUMENT: true, USE_PROFILES: { html: true }, ADD_TAGS: ['style', 'title', 'link'], ADD_ATTR: ['data-ppi-nav','data-ppi-srcset','data-pp-original-href','data-pp-placement-id'], FORBID_TAGS: FORBIDDEN, ADD_FORBID_CONTENTS: ['form', 'select', 'textarea'], FORBID_ATTR: ['srcdoc', 'ping', 'autofocus', 'formaction', 'action', 'is', 'slot', 'popover', 'popovertarget'], ALLOW_DATA_ATTR: false, ALLOW_UNKNOWN_PROTOCOLS: false });
      (purifier.removed || []).forEach(function (item) {
        if (item.element) { stats.removedElements++; if (String(item.element.nodeName).toLowerCase() === 'script') warn('Довільні скрипти видалено; розпізнані безпечні переходи з кнопок збережено.'); }
        if (item.attribute) stats.removedAttributes++;
      });
      var document = new window.DOMParser().parseFromString(clean, 'text/html');
      if (document.querySelectorAll('*').length > MAX_ELEMENTS) fail('HTML містить забагато елементів: ліміт 10 000 вузлів.');
      var title = document.querySelector('title') ? document.querySelector('title').textContent.trim().slice(0, 1000) : '';
      var lang = (document.documentElement.getAttribute('lang') || '').slice(0, 35);
      if (!/^[a-z0-9-]*$/i.test(lang)) lang = '';
      var sourceStyles = Array.from(document.querySelectorAll('style')).map(function (style) { var entry = { text: style.textContent, media: (style.getAttribute('media') || '').trim() }; style.remove(); return entry; });
      document.querySelectorAll('link').forEach(function (link) {
        var rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/), href = absolute(link.getAttribute('href') || ''), approved = false;
        if (href && rel.indexOf('stylesheet') !== -1) {
          var fontURL = new window.URL(href);
          approved = fontURL.protocol === 'https:' && fontURL.hostname === 'fonts.googleapis.com' && !fontURL.port && /^\/css2?$/.test(fontURL.pathname);
          if (approved && fonts.indexOf(href) === -1) fonts.push(href);
        }
        if (!approved && rel.indexOf('stylesheet') !== -1) warn('Зовнішні CSS-файли, крім шрифтів Google Fonts, видалені; вставте їхні стилі у HTML.');
        link.remove();
      });
      if (!title) { var firstHeading = document.body.querySelector('h1,h2'); if (firstHeading) title = firstHeading.textContent.trim().slice(0, 1000); }
      function landmarks(tag, role) {
        return Array.from(document.body.querySelectorAll(tag + ',[role~="' + role + '"]')).filter(function (element) {
          var parent = element.parentElement;
          while (parent && parent !== document.body) {
            if (/^(ARTICLE|SECTION|ASIDE|NAV|MAIN|HEADER|FOOTER)$/.test(parent.tagName) || /^(article|region|complementary|navigation|main|banner|contentinfo)$/.test((parent.getAttribute('role') || '').toLowerCase())) return false;
            parent = parent.parentElement;
          }
          return true;
        });
      }
      var headers = landmarks('header', 'banner'), footers = landmarks('footer', 'contentinfo');
      function replaceLandmark(items, replace, name) {
        if (!replace || !items.length) return false;
        if (items.length !== 1) { warn('Заміна ' + name + ' неоднозначна: знайдено кілька елементів, тому їх збережено.'); return false; }
        items[0].remove(); return true;
      }
      var headerRemoved = replaceLandmark(headers, options.replaceHeader === true, 'хедера'), footerRemoved = replaceLandmark(footers, options.replaceFooter === true, 'футера');
      // WordPress wpautop does not recognize main as a block. Keep its semantic role.
      document.body.querySelectorAll('main').forEach(function (main) {
        var replacement = document.createElement('div');
        Array.from(main.attributes).forEach(function (attribute) { replacement.setAttribute(attribute.name, attribute.value); });
        replacement.classList.add('ppi-main'); replacement.setAttribute('role', 'main');
        while (main.firstChild) replacement.appendChild(main.firstChild);
        main.replaceWith(replacement);
      });
      var idElements = [document.documentElement, document.body].concat(Array.from(document.body.querySelectorAll('[id]'))).filter(function (element) { return element.hasAttribute('id'); });
      function freshId() { var id; do { id = 'ppi-node-' + (++generated); } while (usedIds.has(id)); return id; }
      // Reserve ordinary IDs first, so generated names never steal a later original ID.
      idElements.forEach(function (element) { var id = element.getAttribute('id'); if (id && !/^pp-/i.test(id) && !/[\s\u0000-\u001f]/.test(id)) usedIds.add(id); });
      var seenOriginal = new Set();
      idElements.forEach(function (element) {
        var original = element.getAttribute('id'), id = original;
        if (!id || /^pp-/i.test(id) || /[\s\u0000-\u001f]/.test(id) || seenOriginal.has(id)) id = freshId();
        if (!idMap.has(original)) idMap.set(original, id);
        seenOriginal.add(original); usedIds.add(id); element.id = id;
      });
      document.body.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function (heading) { if (!heading.id) { heading.id = freshId(); usedIds.add(heading.id); } });
      function sanitizeDeclarations(children) {
        var kept = [];
        children.forEach(function (declaration) {
          if (++declarationCount > MAX_DECLARATIONS) fail('CSS містить забагато декларацій стилів.');
          if (declaration.type !== 'Declaration') { stats.removedDeclarations++; return; }
          var property = decode(declaration.property), valid = true, hasVariable = false;
          var custom = property.indexOf('--') === 0;
          if (!custom) property = property.toLowerCase();
          declaration.property = property;
          if (BAD_PROPERTIES.has(property) || property.indexOf('animation-') === 0 || property.indexOf('--ppi-root-') === 0) valid = false;
          csstree.walk(declaration.value, function (node) {
            if (node.type === 'Dimension' && /^(?:rlh|rex|rch|rcap|ric)$/i.test(node.unit)) warn('Кореневі одиниці CSS, крім rem, можуть залежати від теми; перевірте розміри у перегляді та після публікації.');
            if (node.type === 'Raw') valid = false;
            else if (node.type === 'Function') { var functionName = decode(node.name).toLowerCase(); if (!SAFE_FUNCTIONS.has(functionName)) valid = false; if (functionName === 'var') hasVariable = true; }
            else if (node.type === 'Url') { var url = safeUrl(node.value, 'image'); if (!url) valid = false; else node.value = url; }
            else if (node.type === 'Dimension' && /^(?:[dsl]?vh|vb)$/i.test(node.unit) && /height|block-size/.test(property)) valid = false;
            else if ((node.type === 'Number' || node.type === 'Dimension') && Math.abs(Number(node.value)) > 100000) valid = false;
          });
          if (hasVariable && /^(?:position|z-index|inset(?:-.+)?|top|right|bottom|left|(?:min-|max-)?(?:height|block-size))$/.test(property)) valid = false;
          if (valid && property === 'position' && /^(fixed|sticky)$/i.test(csstree.generate(declaration.value))) declaration.value = csstree.parse('relative', { context: 'value' });
          // The imported root already creates an isolated, paint-contained
          // stacking context. Preserve source layer order inside it: clamping
          // negative values puts decorative gradients above the article text.
          if (valid && !custom && !/^(?:-webkit-font-smoothing|-moz-osx-font-smoothing)$/.test(property)) { try { if (!csstree.lexer.getProperty(property) || (!hasVariable && csstree.lexer.matchProperty(property, declaration.value).error)) valid = false; } catch (_) { valid = false; } }
          if (valid) { kept.push(declaration); if (custom) customProperties.add(property); } else stats.removedDeclarations++;
        });
        return makeList(kept);
      }
      // A registered length computes 1em on the simulated html element once,
      // then inherits its pixel length. Descendant rem values therefore follow
      // the source root (including media queries), never the host document root.
      // The root's own font-size is special: rem there means the initial 16px.
      function rootRelative(declaration, initialRoot) {
        var copy = csstree.clone(declaration);
        csstree.walk(copy.value, function (node) {
          if (node.type === 'Dimension' && /^rem$/i.test(node.unit)) {
            usesRem = true;
            var replacement = csstree.parse(initialRoot ? String(Number(node.value) * 16) + 'px' : 'calc(' + node.value + '*var(' + rootUnit + ',16px))', { context: 'value' }).children.head.data;
            Object.keys(node).forEach(function (key) { delete node[key]; }); Object.assign(node, replacement); return this.skip;
          }
          if (initialRoot && node.type === 'Function' && /^var$/i.test(decode(node.name))) {
            var name = node.children.head && node.children.head.data;
            if (name && name.type === 'Identifier') name.name = csstree.ident.encode(rootVariablePrefix + decode(name.name));
          }
        });
        return copy;
      }
      function expandedDeclarations(declarations) {
        var expanded = [];
        declarations.forEach(function (declaration) {
          expanded.push(rootRelative(declaration, false));
          if (declaration.property.indexOf('--') === 0) {
            // Keep separate variable graphs for the initial root font context.
            // This also supports var() fallbacks and chained root variables.
            var alias = rootRelative(declaration, true); alias.property = rootVariablePrefix + declaration.property;
            customProperties.add(alias.property); expanded.push(alias);
          }
        });
        return expanded;
      }
      function rootFontDeclarations(declarations) {
        if (!declarations.some(function (item) { return /^(?:font-size|font)$/.test(item.property) && /(?:rem\b|var\()/i.test(csstree.generate(item.value)); })) return [];
        var result = [];
        declarations.forEach(function (declaration) {
          // Retain all subsequent font longhands so the root override preserves
          // declaration order, shorthand resets, and source priority.
          if (!/^(?:font(?:-.+)?|line-height)$/.test(declaration.property)) return;
          result.push(rootRelative(declaration, /^(?:font-size|font)$/.test(declaration.property)));
          if (declaration.property !== 'font') return;
          if (/var\(/i.test(csstree.generate(declaration.value))) warn('Скорочений font зі змінними може неоднозначно задавати кореневий розмір rem; перевірте шрифт та міжрядковий інтервал або використайте окремі font-size і line-height.');
          var tokens = declaration.value.children.toArray(), slash = tokens.findIndex(function (node) { return node.type === 'Operator' && node.value === '/'; });
          if (slash !== -1 && tokens[slash + 1]) {
            // A var() in a shorthand's line-height also makes font-size depend
            // on it, creating a cycle with the registered root length. Split
            // line-height into its own declaration to keep that dependency out.
            var line = csstree.clone(declaration); line.property = 'line-height'; line.value.children = makeList([csstree.clone(tokens[slash + 1])]);
            result.push(rootRelative(line, false));
          }
        });
        return result;
      }
      function layerRule(name, rule) {
        var layer = csstree.parse('@layer ' + name + '{}').children.head.data;
        layer.block.children = makeList([csstree.clone(rule)]); return layer;
      }
      function scopeSelector(selector, prefix) {
        var invalid = false;
        csstree.walk(selector, function (node) {
          if (node.type === 'Raw' || node.type === 'NestingSelector') invalid = true;
          if (node.type === 'TypeSelector' && /^button$/i.test(decode(node.name))) { var equivalent = csstree.parse(':is(button,.ppi-was-button)', { context: 'selector' }).children.head.data; Object.keys(node).forEach(function (key) { delete node[key]; }); Object.assign(node, equivalent); return this.skip; }
          if (node.type === 'TypeSelector' && /^(html|body|main)$/i.test(decode(node.name))) {
            // These source tags become divs. Keep type-selector specificity:
            // :root and source classes must still outrank html/body/main, while
            // the original tag selectors must continue to outrank universal ones.
            var wrapped = csstree.parse(':is(div:where(.ppi-' + decode(node.name).toLowerCase() + '))', { context: 'selector' }).children.head.data;
            Object.keys(node).forEach(function (key) { delete node[key]; }); Object.assign(node, wrapped); return this.skip;
          }
          if (node.type === 'PseudoClassSelector') {
            var pseudo = decode(node.name).toLowerCase();
            if (pseudo === 'root' || pseudo === 'scope') { node.type = 'ClassSelector'; node.name = 'ppi-html'; delete node.children; }
            else if (pseudo === 'link' || pseudo === 'any-link') {
              var linked = csstree.parse(':is(:' + pseudo + ',[data-pp-original-href])', { context: 'selector' }).children.head.data;
              Object.keys(node).forEach(function (key) { delete node[key]; }); Object.assign(node, linked); return this.skip;
            }
            else if (pseudo === 'empty') {
              var empty = csstree.parse(':is(:empty,[data-pp-icon-empty])', { context: 'selector' }).children.head.data;
              Object.keys(node).forEach(function (key) { delete node[key]; }); Object.assign(node, empty); return this.skip;
            }
            else if (['global', 'host', 'host-context'].indexOf(pseudo) !== -1) invalid = true;
          }
          if (node.type === 'IdSelector') { var id = decode(node.name); node.name = csstree.ident.encode(idMap.get(id) || (id.indexOf('pp-') === 0 ? 'ppi-missing-id' : id)); }
          if (node.type === 'AttributeSelector') {
            var attr = decode(node.name.name).toLowerCase(), value = attributeValue(node.value), replacement = '';
            if (attr === 'id') replacement = idMap.get(value) || '';
            if (attr === 'href' && value && value[0] === '#') replacement = idMap.has(value.slice(1)) ? '#' + idMap.get(value.slice(1)) : '';
            if (replacement) node.value = { type: 'String', loc: null, value: replacement };
            if (attr === 'href') {
              // Repeated destinations become JS controls, but retain the source's
              // href-dependent appearance, including value filters and :not().
              var duplicate = csstree.clone(node); duplicate.name.name = 'data-pp-original-href';
              var equivalent = csstree.parse(':is(' + csstree.generate(node) + ',' + csstree.generate(duplicate) + ')', { context: 'selector' }).children.head.data;
              Object.keys(node).forEach(function (key) { delete node[key]; }); Object.assign(node, equivalent); return this.skip;
            }
          }
        });
        if (invalid) return null;
        // CSS Tree drops trailing whitespace; prepend the descendant relation
        // before the full specificity prefix so its repeated IDs stay together.
        selector.children.prependData({ type: 'Combinator', loc: null, name: ' ' });
        selector.children.prependList(csstree.parse(prefix || normalScope, { context: 'selector' }).children);
        return selector;
      }
      function sanitizeRules(children, depth) {
        if (depth > 8) fail('CSS має надто складну вкладеність правил.');
        var kept = [];
        children.forEach(function (node) {
          if (++ruleCount > MAX_RULES) fail('CSS перевищує ліміт 2 000 правил.');
          if (node.type === 'Rule' && node.prelude && node.prelude.type === 'SelectorList') {
            var declarations = sanitizeDeclarations(node.block.children).toArray();
            // Keep original !important declarations above ordinary source styles,
            // while both outrank the scoped reset and the WordPress theme.
            [false, true].forEach(function (important) {
              var originalGroup = declarations.filter(function (item) { return !!item.important === important; });
              var group = expandedDeclarations(originalGroup);
              if (!group.length) return;
              var rule = csstree.clone(node);
              var selectors = rule.prelude.children.toArray().map(function (selector) { return scopeSelector(selector, important ? importantScope : normalScope); }).filter(Boolean);
              group.forEach(function (declaration) { declaration.important = true; });
              if (selectors.length) {
                rule.prelude.children = makeList(selectors); rule.block.children = makeList(group); kept.push(rule); kept.push(layerRule(important ? 'ppi-source-important' : 'ppi-source-normal', rule)); stats.cssRules++;
                var rootFonts = rootFontDeclarations(originalGroup);
                if (rootFonts.length) {
                  var rootRule = csstree.clone(rule);
                  rootRule.prelude.children.forEach(function (selector) { selector.children.appendList(csstree.parse(':where(.ppi-html)', { context: 'selector' }).children); });
                  rootFonts.forEach(function (declaration) { declaration.important = true; }); rootRule.block.children = makeList(rootFonts);
                  kept.push(rootRule); kept.push(layerRule(important ? 'ppi-source-important' : 'ppi-source-normal', rootRule));
                }
              } else stats.removedRules++;
            });
            if (!declarations.length) stats.removedRules++;
          } else if (node.type === 'Atrule' && /^font-face$/i.test(node.name) && node.block && !node.prelude) {
            var fontDeclarations = [], hasFontSource = false, hasFontFamily = false;
            node.block.children.forEach(function (declaration) {
              if (++declarationCount > MAX_DECLARATIONS) fail('CSS містить забагато декларацій стилів.');
              if (declaration.type !== 'Declaration') { stats.removedDeclarations++; return; }
              var property = decode(declaration.property).toLowerCase(), valid = /^(?:font-family|src|font-style|font-weight|font-stretch|font-display|unicode-range)$/.test(property), sources = 0;
              declaration.property = property;
              csstree.walk(declaration.value, function (part) {
                if (part.type === 'Raw') valid = false;
                if (part.type === 'Function' && !(property === 'src' && /^(?:format|tech)$/i.test(decode(part.name)))) valid = false;
                if (part.type === 'Url') { var url = property === 'src' ? safeUrl(part.value, 'font') : ''; if (!url) valid = false; else { part.value = url; sources++; } }
              });
              try { if (csstree.lexer.matchAtruleDescriptor('font-face', property, declaration.value).error) valid = false; } catch (_) { valid = false; }
              if (property === 'src' && !sources) valid = false;
              if (valid) { declaration.important = false; fontDeclarations.push(declaration); if (property === 'src') hasFontSource = true; if (property === 'font-family') hasFontFamily = true; } else stats.removedDeclarations++;
            });
            if (hasFontSource && hasFontFamily) {
              var familyDeclaration = fontDeclarations.filter(function (item) { return item.property === 'font-family'; }).pop();
              var family = fontFamilyName(familyDeclaration.value.children.toArray()), privateFamily = fontPrefix + stableHash(family);
              if (family) {
                fontFamilies.set(family, privateFamily);
                fontDeclarations.forEach(function (item) { if (item.property === 'font-family') item.value = csstree.parse('"' + privateFamily + '"', { context: 'value' }); });
                node.block.children = makeList(fontDeclarations); kept.push(node);
              } else stats.removedRules++;
            } else stats.removedRules++;
          } else if (node.type === 'Atrule' && /^(media|supports)$/i.test(node.name) && node.block && node.prelude) {
            var raw = false; csstree.walk(node.prelude, function (part) { if (part.type === 'Raw' || part.type === 'Url') raw = true; });
            if (!raw) { node.block.children = sanitizeRules(node.block.children, depth + 1); if (!node.block.children.isEmpty) kept.push(node); else stats.removedRules++; } else stats.removedRules++;
          } else stats.removedRules++;
        });
        return makeList(kept);
      }
      var cssParts = [];
      sourceStyles.forEach(function (entry) {
        var ast;
        try {
          ast = csstree.parse(entry.text, { context: 'stylesheet', parseCustomProperty: true });
          if (entry.media) {
            var media = csstree.parse(entry.media, { context: 'mediaQueryList' });
            ast.children = makeList([{ type: 'Atrule', loc: null, name: 'media', prelude: { type: 'AtrulePrelude', loc: null, children: makeList([media]) }, block: { type: 'Block', loc: null, children: ast.children } }]);
          }
        } catch (_) { stats.removedRules++; warn('Пошкоджені CSS-правила видалено.'); return; }
        ast.children = sanitizeRules(ast.children, 0);
        cssParts.push(csstree.generate(ast));
      });
      [document.documentElement, document.body].concat(Array.from(document.body.querySelectorAll('*'))).forEach(function (element) {
        Array.from(element.attributes).forEach(function (attribute) {
          var name = attribute.name.toLowerCase(), value = attribute.value;
          if (name === 'data-ppi-nav') return;
          if (name === 'data-pp-placement-id') {if(!/^[a-zA-Z0-9_-]{1,100}$/.test(value))element.removeAttribute(name);return;}
          if (name === 'data-pp-original-href') {if(!safeUrl(value,'link'))element.removeAttribute(name);return;}
          if (/^on/i.test(name) || ['name', 'srcdoc', 'ping', 'formaction', 'action', 'is', 'contenteditable', 'autofocus', 'tabindex'].indexOf(name) !== -1) { element.removeAttribute(attribute.name); stats.removedAttributes++; return; }
          if (name === 'style') {
            try {
              var ast = csstree.parse(value, { context: 'declarationList', parseCustomProperty: true });
              var declarations = sanitizeDeclarations(ast.children).toArray(), expanded = expandedDeclarations(declarations);
              if (element === document.documentElement) {
                var rootFonts = rootFontDeclarations(declarations), fontProperties = new Set(rootFonts.map(function (item) { return item.property; }));
                expanded = expanded.filter(function (item) { return !fontProperties.has(item.property); }).concat(rootFonts);
              }
              ast.children = makeList(expanded);
              var normalInline = ast.children.toArray().filter(function (declaration) { return !declaration.important; }).map(function (declaration) { var copy = csstree.clone(declaration); copy.important = true; return copy; });
              if (normalInline.length) {
                var inlineId = String(++inlineCount); element.setAttribute('data-ppi-inline', inlineId);
                var inlineRule = csstree.parse(normalScope + '[data-ppi-inline="' + inlineId + '"]{}').children.head.data;
                inlineRule.prelude.children.forEach(function (selector) { selector.children = csstree.parse(normalScope + ' [data-ppi-inline="' + inlineId + '"]', { context: 'selector' }).children; });
                inlineRule.block.children = makeList(normalInline);
                inlineCSS.push(csstree.generate(inlineRule), csstree.generate(layerRule('ppi-source-inline', inlineRule)));
              }
              var style = csstree.generate(ast); if (style) element.setAttribute('style', style); else element.removeAttribute('style');
            }
            catch (error) { if (/забагато/.test(error.message)) throw error; element.removeAttribute('style'); stats.removedDeclarations++; }
          } else if (name === 'href' || name === 'src' || name === 'poster' || name === 'background' || name === 'cite') {
            var safe = safeUrl(value, name === 'href' || name === 'cite' ? 'link' : 'image');
            if (safe) element.setAttribute(name, safe); else { element.removeAttribute(name); stats.removedAttributes++; }
          } else if (name === 'srcset' || name === 'data-ppi-srcset') {
            if (name === 'data-ppi-srcset') { element.removeAttribute(name); value = /^\d+$/.test(value) ? sourceSrcsets[Number(value)] || '' : ''; }
            var accepted = [], cursor = 0, candidateCount = 0;
            while (cursor < value.length && candidateCount++ < 512) {
              while (/[\s,]/.test(value[cursor] || '') && cursor < value.length) cursor++;
              var rest = value.slice(cursor), token = rest.match(/^data:[^\s,]*,[^\s,]*/i) || rest.match(/^[^\s,]+/);
              if (!token) break;
              cursor += token[0].length;
              var end = value.indexOf(',', cursor); if (end === -1) end = value.length;
              var descriptor = value.slice(cursor, end).trim(); cursor = end + 1;
              if (descriptor && !/^(?:[1-9]\d*w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor)) continue;
              if (descriptor.endsWith('x') && Number(descriptor.slice(0, -1)) <= 0) continue;
              var url = safeUrl(token[0], 'image'); if (url) accepted.push(url + (descriptor ? ' ' + descriptor : ''));
            }
            if (accepted.length) element.setAttribute('srcset', accepted.join(', ')); else { element.removeAttribute('srcset'); stats.removedAttributes++; }
          } else if (['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-details', 'aria-errormessage', 'headers', 'for'].indexOf(name) !== -1) {
            var references = value.split(/\s+/).map(function (id) { return idMap.get(id) || (usedIds.has(id) ? id : ''); }).filter(Boolean);
            if (references.length) element.setAttribute(name, references.join(' ')); else element.removeAttribute(name);
          } else if (name === 'target') {
            if (element.tagName !== 'A' || value !== '_blank') element.removeAttribute(name);
          }
        });
        if (element.tagName === 'A' && element.hasAttribute('href')) {
          var relations = (element.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(function (token) { return /^[a-z][a-z0-9-]*$/.test(token) && token !== 'opener'; });
          relations = Array.from(new Set(relations.concat(['noopener', 'noreferrer'])));
          element.setAttribute('rel', relations.join(' '));
          if (!element.getAttribute('href').startsWith('http')) element.removeAttribute('target');
        } else if (element.tagName === 'A') element.removeAttribute('target');
      });
      document.body.querySelectorAll('[data-ppi-nav]').forEach(function (element) {
        var info = navigation[Number(element.getAttribute('data-ppi-nav'))]; element.removeAttribute('data-ppi-nav');
        if (!info) return;
        element.setAttribute('data-pp-url', info.url); element.setAttribute('data-pp-target', info.target);
        if (info.priority) element.setAttribute('data-pp-priority', info.priority);
        if (element.tagName === 'BUTTON') { element.setAttribute('type', 'button'); element.classList.add('ppi-was-button'); }
        else { element.setAttribute('role', 'link'); element.setAttribute('tabindex', '0'); }
      });
      document.body.querySelectorAll('button').forEach(function (button) { button.setAttribute('type', 'button'); });
      // Mark genuine paragraphs and line breaks so wpautop-created wrappers can
      // be neutralized without changing original article/FAQ paragraphs.
      document.body.querySelectorAll('p').forEach(function (p) { p.setAttribute('data-ppi-paragraph', ''); });
      document.body.querySelectorAll('br').forEach(function (br) { br.setAttribute('data-ppi-break', ''); });
      if (stats.removedElements || stats.removedAttributes) warn('Активні елементи, обробники подій і небезпечні атрибути видалено.');

      function fontFamilyName(nodes) {
        if (!nodes.length || nodes.some(function (node) { return node.type !== 'String' && node.type !== 'Identifier'; })) return '';
        if (nodes.some(function (node) { return node.type === 'String'; }) && nodes.length !== 1) return '';
        return nodes.map(function (node) { return node.type === 'String' ? node.value : decode(node.name); }).join(' ').trim().replace(/\s+/g, ' ').toLowerCase();
      }
      function replaceFontGroup(list, nodes) {
        var name = fontFamilyName(nodes), replacement = fontFamilies.get(name); if (!replacement) return false;
        var anchor = null, selected = new Set(nodes);
        list.forEach(function (node, item) { if (node === nodes[0]) anchor = item; });
        if (!anchor) return false;
        list.insertData({ type: 'String', loc: null, value: replacement }, anchor);
        list.forEach(function (node, item) { if (selected.has(node)) list.remove(item); }); return true;
      }
      function rewriteFontList(list, allowSuffix) {
        var groups = [[]];
        list.forEach(function (node) { if (node.type === 'Operator' && node.value === ',') groups.push([]); else groups[groups.length - 1].push(node); });
        groups.forEach(function (nodes, index) {
          if (replaceFontGroup(list, nodes)) return;
          if (!allowSuffix || index !== 0) return;
          // The first shorthand family follows font size/line-height. Only its
          // trailing identifier/string run can be a literal family name.
          for (var start = 1; start < nodes.length; start++) {
            if (fontFamilyName(nodes.slice(start)) && replaceFontGroup(list, nodes.slice(start))) break;
          }
        });
      }
      var fontVariables = new Set();
      function fontVariableAlias(name) { return '--ppi-font-var-' + sourceHash + '-' + stableHash(name); }
      function variableReferences(value) {
        var names = new Set();
        csstree.walk(value, function (node) {
          if (node.type !== 'Function' || !/^var$/i.test(decode(node.name))) return;
          var first = node.children.head && node.children.head.data; if (first && first.type === 'Identifier' && decode(first.name).indexOf('--') === 0) names.add(decode(first.name));
        }); return names;
      }
      function rewriteFontDeclaration(declaration, customAlias) {
        var property = decode(declaration.property); if (property.indexOf('--') !== 0) property = property.toLowerCase();
        if (property !== 'font' && property !== 'font-family' && !customAlias) return;
        if (property === 'font') {
          var fragments = csstree.lexer.findDeclarationValueFragments(declaration, 'Type', 'family-name');
          fragments.forEach(function (fragment) { replaceFontGroup(fragment.parent, fragment.nodes.toArray()); });
          if (!fragments.length) rewriteFontList(declaration.value.children, true);
        } else rewriteFontList(declaration.value.children, property.indexOf('--') === 0);
        csstree.walk(declaration.value, function (node) {
          if (node.type !== 'Function' || !/^var$/i.test(decode(node.name))) return;
          var first = node.children.head && node.children.head.data;
          if (first && first.type === 'Identifier' && fontVariables.has(decode(first.name))) first.name = fontVariableAlias(decode(first.name));
          node.children.forEach(function (fallback) { if (fallback.type === 'Value') rewriteFontList(fallback.children, true); });
        });
      }
      if (fontFamilies.size) {
        // Only source styles are rewritten. The host reset keeps its system
        // Arial, and rejected font faces never create replacement mappings.
        var stylesheetASTs = cssParts.map(function (text) { return csstree.parse(text, { parseCustomProperty: true }); });
        var inlineASTs = inlineCSS.map(function (text) { return csstree.parse(text, { parseCustomProperty: true }); }), attributeASTs = [];
        [document.documentElement, document.body].concat(Array.from(document.body.querySelectorAll('[style]'))).forEach(function (element) {
          if (!element.hasAttribute('style')) return;
          var ast = csstree.parse(element.getAttribute('style'), { context: 'declarationList', parseCustomProperty: true });
          attributeASTs.push({ element: element, ast: ast });
        });
        var allASTs = stylesheetASTs.concat(inlineASTs, attributeASTs.map(function (entry) { return entry.ast; })), dependencies = new Map();
        allASTs.forEach(function (ast) {
          csstree.walk(ast, { visit: 'Declaration', enter: function (declaration) {
            var property = decode(declaration.property), references = variableReferences(declaration.value);
            if (/^(?:font|font-family)$/i.test(property)) references.forEach(function (name) { fontVariables.add(name); });
            if (property.indexOf('--') === 0) {
              if (!dependencies.has(property)) dependencies.set(property, new Set());
              references.forEach(function (name) { dependencies.get(property).add(name); });
            }
          } });
        });
        var pending = Array.from(fontVariables);
        for (var variable = 0; variable < pending.length; variable++) (dependencies.get(pending[variable]) || []).forEach(function (name) { if (!fontVariables.has(name)) { fontVariables.add(name); pending.push(name); } });
        allASTs.forEach(function (ast) {
          csstree.walk(ast, { visit: 'Declaration', enter: function (declaration, item, list) {
            var name = decode(declaration.property);
            if (name.indexOf('--') === 0) {
              if (!fontVariables.has(name)) return;
              // A variable may also be a color or another non-font value. Keep
              // its source graph and create a parallel graph only for fonts.
              var alias = csstree.clone(declaration); alias.property = fontVariableAlias(name); customProperties.add(alias.property);
              rewriteFontDeclaration(alias, true); list.insertData(alias, item); return;
            }
            rewriteFontDeclaration(declaration, false);
          } });
        });
        cssParts = stylesheetASTs.map(function (ast) { return csstree.generate(ast); }); inlineCSS = inlineASTs.map(function (ast) { return csstree.generate(ast); });
        attributeASTs.forEach(function (entry) { entry.element.setAttribute('style', csstree.generate(entry.ast)); });
      }
      
      var htmlWrap = document.createElement('div'), bodyWrap = document.createElement('div');
      htmlWrap.className = 'ppi-html' + (document.documentElement.className ? ' ' + document.documentElement.className : '');
      bodyWrap.className = 'ppi-body' + (document.body.className ? ' ' + document.body.className : '');
      if (lang) htmlWrap.lang = lang;
      ['dir', 'style', 'id', 'data-ppi-inline'].forEach(function (name) {
        if (document.documentElement.hasAttribute(name)) htmlWrap.setAttribute(name, document.documentElement.getAttribute(name));
        if (document.body.hasAttribute(name)) bodyWrap.setAttribute(name, document.body.getAttribute(name));
      });
      var blocks = /^(?:BODY|DIV|MAIN|ARTICLE|SECTION|ASIDE|NAV|HEADER|FOOTER|TABLE|THEAD|TBODY|TFOOT|TR|TH|TD|UL|OL|LI|DL|DT|DD|BLOCKQUOTE|FIGURE|FIGCAPTION|DETAILS|SUMMARY|P|H[1-6]|HR|PRE)$/;
      var walker = document.createTreeWalker(document.body, window.NodeFilter.SHOW_TEXT), spacing = [], textNode;
      while ((textNode = walker.nextNode())) {
        if (textNode.nodeValue.trim() || !blocks.test(textNode.parentElement.tagName) || textNode.parentElement.closest('pre,code,kbd,samp')) continue;
        var previous = textNode.previousSibling, next = textNode.nextSibling;
        if ((!previous || (previous.nodeType === 1 && blocks.test(previous.tagName))) && (!next || (next.nodeType === 1 && blocks.test(next.tagName)))) spacing.push(textNode);
      }
      spacing.forEach(function (textNode) { textNode.remove(); });
      if (stats.removedRules || stats.removedDeclarations) warn('Непідтримувані або небезпечні CSS-стилі видалено; зовнішній вигляд може відрізнятися.');
      while (document.body.firstChild) bodyWrap.appendChild(document.body.firstChild);
      htmlWrap.appendChild(bodyWrap);
      if (!bodyWrap.textContent.trim() && !bodyWrap.querySelector('img,hr,table')) fail('Після очищення HTML не містить придатного статичного вмісту.');
      var headings = Array.from(htmlWrap.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(function (heading) { return { id: heading.id, text: heading.textContent.trim().slice(0, 1000), level: Number(heading.tagName.slice(1)) }; });
      var links = Array.from(htmlWrap.querySelectorAll('a[href],[data-pp-url]'));
      var firstLink = '', orderedLinks = links.filter(function (link) { return link.getAttribute('data-pp-priority') === 'offer'; }).concat(links);
      orderedLinks.some(function (link) { var url = link.getAttribute('data-pp-url') || link.getAttribute('href'); if (absolute(url)) { firstLink = url; return true; } return false; });
      stats.elements = htmlWrap.querySelectorAll('*').length; stats.links = links.length; stats.images = htmlWrap.querySelectorAll('img').length; stats.headings = headings.length;
      var resources = fonts.map(function (href) { var link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; return link.outerHTML; }).join('');
      resources += structuredData.map(function (json) { return '<script type="application/ld+json">' + json + '</script>'; }).join('');
      var html = (resources + htmlWrap.outerHTML).replace(/\r\n?|\n/g, '&#10;');
      var resetScope = scope.repeat(2);
      var reset = resetScope + ',' + resetScope + ' *,' + resetScope + ' *::before,' + resetScope + ' *::after{all:revert!important;unicode-bidi:normal!important;}' + resetScope + '{display:block!important;position:relative!important;isolation:isolate!important;contain:layout paint!important;overflow:clip!important;width:100%!important;min-width:0!important;max-width:none!important;margin:0!important;padding:0!important;border:0!important;font:16px/normal Arial,sans-serif!important;text-align:start!important;}' + resetScope + ' .ppi-html,' + resetScope + ' .ppi-body{display:block!important;margin:0!important;padding:0!important;min-width:0!important;max-width:none!important;}';
      if (usesRem) reset += resetScope + '>.ppi-html{' + rootUnit + ':1em!important;}';
      if (customProperties.size) reset += resetScope + ' *{' + Array.from(customProperties).map(function (name) { return name + ':inherit!important;'; }).join('') + '}';
      reset += resetScope + ' a.ppi-was-button{appearance:auto!important;display:inline-block!important;box-sizing:border-box!important;border:2px outset ButtonBorder!important;background:ButtonFace!important;color:ButtonText!important;padding:2px 6px!important;font:400 13.3333px Arial,sans-serif!important;text-align:center!important;text-decoration:none!important;cursor:default!important;}';
      var wordpress = importantScope + ' p:not([data-ppi-paragraph]){all:unset!important;display:contents!important;}' + importantScope + ' p:not([data-ppi-paragraph])>br:not([data-ppi-break]){display:none!important;}';
      // Cascade layers preserve source precedence independently of theme
      // specificity: original !important > normal inline > ordinary source CSS.
      // Unlayered copies provide a scoped fallback for older browsers.
      var css = '@layer ppi-import-fix,ppi-source-important,ppi-source-inline,ppi-source-normal,ppi-import-reset;' + reset + '@layer ppi-import-reset{' + reset + '}' + inlineCSS.join('') + cssParts.join('') + wordpress + '@layer ppi-import-fix{' + wordpress + '}';
      if (usesRem) css += '@property ' + rootUnit + '{syntax:"<length>";inherits:true;initial-value:16px;}';
      css = css.replace(/</g, '\\3c ').replace(/\r\n?|\n/g, ' ');
      return { html: html, css: css, title: title, lang: lang, fonts: fonts, headings: headings, ids: (htmlWrap.id ? [htmlWrap.id] : []).concat(Array.from(htmlWrap.querySelectorAll('[id]')).map(function (element) { return element.id; })), firstLink: firstLink, hasHeader: headers.length > 0, hasFooter: footers.length > 0, headerRemoved: headerRemoved, footerRemoved: footerRemoved, addHeader: headers.length === 0 || headerRemoved, addFooter: footers.length === 0 || footerRemoved, warnings: warnings, stats: stats };
    }
    return Object.freeze({ process: process });
  }
  var defaultInstance;
  return Object.freeze({ create: create, process: function (source, options) { if (!defaultInstance) defaultInstance = create(root.window || root); return defaultInstance.process(source, options); } });
}));
