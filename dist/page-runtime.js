(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PagePosterRuntime = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function escape(value) { return String(value).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function decode(value) {
    return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, function (whole, key) {
      if (key[0] === '#') { var n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2),16) : parseInt(key.slice(1),10); return n > 0 && n <= 1114111 ? String.fromCodePoint(n) : '\ufffd'; }
      return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[key.toLowerCase()];
    });
  }
  function validURL(value) {
    if (!/^https?:\/\//i.test(value || '') || /[\u0000-\u0020\u007f]/.test(value)) return '';
    try { var url = new URL(value); return url.hostname && !url.username && !url.password ? value : ''; } catch (_) { return ''; }
  }
  // This scanner only rewrites already generated/sanitized start tags. Quoted
  // attributes, raw style/script text, comments and all text bytes are preserved.
  function scan(html) {
    var tokens = [], stack = [], expression = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][a-z0-9:-]*(?:"[^"]*"|'[^']*'|[^'">])*>/gi, match;
    var voidTags = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
    while ((match = expression.exec(html))) {
      if (/^<!/.test(match[0])) continue;
      var found = /^<(\/?)([a-z][a-z0-9:-]*)/i.exec(match[0]);
      var token = {start:match.index,end:expression.lastIndex,raw:match[0],name:found[2].toLowerCase(),close:!!found[1],attrs:[],values:{},parents:stack.map(function (item) { return item.name; })};
      tokens.push(token);
      if (token.close) {
        for (var at = stack.length - 1; at >= 0; at--) if (stack[at].name === token.name) { stack[at].closing = token; stack.length = at; break; }
        continue;
      }
      var attrExpression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, attr;
      attrExpression.lastIndex = found[0].length;
      while ((attr = attrExpression.exec(token.raw))) {
        var name = attr[1].toLowerCase(), value = decode(attr[2] !== undefined ? attr[2] : attr[3] !== undefined ? attr[3] : attr[4] || '');
        token.attrs.push({name:name,value:value,bare:attr[2] === undefined && attr[3] === undefined && attr[4] === undefined});
        if (!Object.prototype.hasOwnProperty.call(token.values,name)) token.values[name] = value;
      }
      if (/^(?:script|style|textarea|title)$/.test(token.name)) {
        var end = new RegExp('</'+token.name+'\\s*>','gi'); end.lastIndex = expression.lastIndex;
        var closing = end.exec(html); expression.lastIndex = closing ? end.lastIndex : html.length;
        continue;
      }
      if (!voidTags.test(token.name) && !/\/>$/.test(token.raw)) stack.push(token);
    }
    return tokens;
  }
  function rewrite(token, changes, tag) {
    var seen = {}, result = '<'+(tag || token.name);
    token.attrs.forEach(function (attr) {
      if (seen[attr.name]) return; seen[attr.name] = true;
      var value = Object.prototype.hasOwnProperty.call(changes,attr.name) ? changes[attr.name] : attr.value;
      if (value === null) return;
      result += ' '+attr.name+(attr.bare && !Object.prototype.hasOwnProperty.call(changes,attr.name) ? '' : '="'+escape(value)+'"');
    });
    Object.keys(changes).forEach(function (name) { if (!seen[name] && changes[name] !== null) result += ' '+name+'="'+escape(changes[name])+'"'; });
    return result+'>';
  }
  function controls(html) {
    return scan(html).filter(function (token) {
      if (token.close) return false;
      var url = token.name === 'a' ? validURL(token.values.href) : '';
      token.url = url || validURL(token.values['data-pp-url']);
      return token.url;
    });
  }
  function priority(token) {
    var classes = token.values['class'] || '';
    if(token.values['data-pp-priority']==='resource')return -2;
    if(token.values['data-pp-priority']==='article')return -1;
    if (token.values['data-pp-priority'] === 'offer' || /(?:^|\s)pp-cta(?:\s|$)/.test(classes)) return 0;
    if (token.name === 'button' || /(?:^|\s)(?:btn|cta|button)(?:\s|$)/i.test(classes)) return 1;
    if (token.parents.indexOf('header') !== -1 || token.parents.indexOf('footer') !== -1 || /(?:^|\s)pp-brand(?:\s|$)/.test(classes)) return 4;
    if (token.name === 'a' && token.values.href) return 2;
    return 3;
  }
  function summarize(html) {
    var links = [], byURL = Object.create(null), count = 0;
    controls(html).forEach(function (token) {
      var link = byURL[token.url];
      if (!link) { link = {url:token.url,count:0,nativeCount:0}; byURL[token.url] = link; links.push(link); }
      link.count++; count++; if (token.name === 'a' && validURL(token.values.href)) link.nativeCount++;
    });
    return {urls:links.map(function (item) { return item.url; }),links:links,uniqueCount:links.length,totalControls:count,duplicateControls:count-links.length,unique:links.length,total:count,duplicates:count-links.length};
  }
  // This is the only executable code emitted by PagePoster. URLs are read from
  // validated attributes, never interpolated into JavaScript or evaluated.
  function mount() {
    var layer = document.getElementById('pp-landing');
    if (!layer || layer.getAttribute('data-pp-mounted')) return;
    layer.setAttribute('data-pp-mounted','true');
    if (layer.getAttribute('data-pp-fullscreen') === 'true') {
      if (layer.parentElement !== document.body) document.body.appendChild(layer);
      document.documentElement.style.setProperty('overflow','hidden','important');
      document.body.style.setProperty('overflow','hidden','important');
    }
    // Icon-only controls have no text/IMG to wrap. Their native link fills the
    // original click area, leaving decorative descendants and :empty intact.
    layer.querySelectorAll('[data-pp-icon-hit]').forEach(function(link) {
      var icon = link.parentElement, position = window.getComputedStyle(icon).position;
      if (!position || position === 'static') icon.style.setProperty('position','relative','important');
    });
    function destination(node) {
      var value = node.getAttribute('data-pp-url') || '';
      if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return '';
      try { var parsed = new URL(value); return parsed.hostname && !parsed.username && !parsed.password ? value : ''; } catch (_) { return ''; }
    }
    function navigate(node,event) {
      var value = destination(node); if (!value) return;
      event.preventDefault();
      var target = node.getAttribute('data-pp-target') || node.getAttribute('target') || '_self';
      if (target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) window.open(value,'_blank','noopener,noreferrer');
      else window.location.assign(value);
    }
    function controlled(event) { var node = event.target && event.target.closest ? event.target.closest('a[href],button,[role="link"],[data-pp-url]') : null; return node && layer.contains(node) && node.hasAttribute('data-pp-url') ? node : null; }
    layer.addEventListener('click',function(event) { var node = controlled(event); if (node) navigate(node,event); });
    layer.addEventListener('auxclick',function(event) { var node = controlled(event); if (node && event.button === 1) navigate(node,event); });
    layer.addEventListener('keydown',function(event) {
      var node = controlled(event); if (!node || event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
      // Native buttons supply their own keyboard click; custom link controls need it.
      if (node.tagName !== 'BUTTON') navigate(node,event);
    });
    function hashTarget(hash) { if (!hash || hash === '#') return null; try { var target = document.getElementById(decodeURIComponent(hash.slice(1))); return target && layer.contains(target) ? target : null; } catch (_) { return null; } }
    function go(hash) { var target = hashTarget(hash); if (target && target.scrollIntoView) target.scrollIntoView({block:'start'}); }
    layer.addEventListener('click',function(event) {
      var link = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
      if (!link || !layer.contains(link)) return;
      var hash = link.getAttribute('href'); if (!hashTarget(hash)) return;
      event.preventDefault(); try { history.pushState(null,'',hash); } catch (_) {} go(hash);
      var menu = link.closest('details.pp-mobile-nav'); if (menu) menu.open = false;
    });
    window.addEventListener('hashchange',function() { go(location.hash); });
    if (location.hash) requestAnimationFrame(function() { go(location.hash); });
  }
  function prepare(html, options) {
    options = options || {};
    var candidates = controls(html), canonical = Object.create(null), changes = [], tokens = scan(html);
    function group(token) { return (options.separateChrome && (token.parents.indexOf('header')!==-1 || token.parents.indexOf('footer')!==-1) ? 'chrome:' : 'content:')+token.url; }
    candidates.forEach(function (token) { var key=group(token);if (!canonical[key] || priority(token) < priority(canonical[key])) canonical[key] = token; });
    candidates.forEach(function (token) {
      var winner = canonical[group(token)] === token, update = {}, tag = token.name;
      if (winner && token.name === 'a' && token.values.href && !token.values['data-pp-url']) return;
      var target = token.values['data-pp-target'] || token.values.target || '_self';
      if (winner && token.name !== 'a' && token.name !== 'button') {
        // Preserve container tags and their CSS selectors. A native link wraps an
        // existing visible text label; the surrounding control keeps its handler.
        // Never wrap a descendant interactive control in another anchor.
        var label = null, inner = tokens.filter(function(item) { return !item.close && item.start > token.start && token.closing && item.end < token.closing.start && (/^(?:a|button|input|select|textarea|details|summary)$/.test(item.name) || item.values['data-pp-url'] || item.values.role === 'link' || item.values.role === 'button'); });
        for (var t = 0; t < tokens.length - 1 && !label; t++) {
          var left = tokens[t], right = tokens[t+1], from = left.end, to = right.start;
          if (from < token.end || !token.closing || to > token.closing.start || to <= from || /^(?:script|style|textarea|title)$/.test(left.name)) continue;
          var raw = html.slice(from,to);
          if (!decode(raw).trim() || raw.indexOf('<') !== -1 || inner.some(function(item) { return from >= item.start && (!item.closing || to <= item.closing.end); })) continue;
          label = {start:from,end:to,text:'<a href="'+escape(token.url)+'"'+(target === '_blank' ? ' target="_blank" rel="noopener noreferrer"' : '')+' style="color:inherit!important;font:inherit!important;text-decoration:inherit!important;display:inline!important;">'+raw+'</a>'};
        }
        if (!label && token.closing) {
          var image = tokens.find(function(item) { return item.name === 'img' && item.start > token.end && item.end < token.closing.start && !inner.some(function(control) { return item.start > control.start && (!control.closing || item.end < control.closing.end); }); });
          if (image) label = {start:image.start,end:image.end,text:'<a href="'+escape(token.url)+'"'+(target === '_blank' ? ' target="_blank" rel="noopener noreferrer"' : '')+' style="display:contents!important;color:inherit!important;">'+image.raw+'</a>'};
        }
        if (!label && token.closing && !inner.length) {
          // Use the original control's hit area, never an arbitrary empty child
          // that may be hidden or rely on :empty to display its icon.
          if (!html.slice(token.end,token.closing.start).replace(/<!--[\s\S]*?-->/g,'').length) update['data-pp-icon-empty'] = '1';
          var accessible = token.values['aria-label'] || token.values.title || 'Open link';
          label = {start:token.closing.start,end:token.closing.start,text:'<a href="'+escape(token.url)+'" aria-label="'+escape(accessible)+'" data-pp-icon-hit="1"'+(target === '_blank' ? ' target="_blank" rel="noopener noreferrer"' : '')+' style="display:block!important;position:absolute!important;inset:0!important;z-index:1!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;cursor:pointer!important;"></a>'};
        }
        if (label) changes.push(label);
        winner = false;
      }
      if (winner) {
        tag = 'a'; update.href = token.url; update['data-pp-url'] = null; update['data-pp-target'] = null; update['data-pp-priority'] = null;
        update.type = null; update.role = null; update.tabindex = null;
        if (target === '_blank') { update.target = '_blank'; var rel = (token.values.rel || '').split(/\s+/).filter(Boolean); ['noopener','noreferrer'].forEach(function (value) { if (rel.indexOf(value) === -1) rel.push(value); }); update.rel = rel.join(' '); }
        if (token.name === 'button') update['class'] = ((token.values['class'] || '')+' ppi-was-button').trim();
      } else {
        if (token.name === 'a' && token.values.href) update['data-pp-original-href'] = token.values['data-pp-original-href'] || token.values.href;
        update.href = null; update['data-pp-url'] = token.url; update['data-pp-target'] = target === '_blank' ? '_blank' : '_self'; update['data-pp-priority'] = null;
        if (token.name !== 'button') { update.role = 'link'; update.tabindex = '0'; }
      }
      changes.push({start:token.start,end:token.end,text:rewrite(token,update,tag)});
      if (tag !== token.name && token.closing) changes.push({start:token.closing.start,end:token.closing.end,text:'</'+tag+'>'});
    });
    scan(html).forEach(function(token) {
      if (token.close) return;
      if (token.values.id === 'pp-landing') changes.push({start:token.start,end:token.end,text:rewrite(token,{'data-pp-fullscreen':options.fullscreen ? 'true' : 'false'})});
      else if (Object.prototype.hasOwnProperty.call(token.values,'data-pp-url') && !validURL(token.values['data-pp-url'])) changes.push({start:token.start,end:token.end,text:rewrite(token,{'data-pp-url':null,'data-pp-target':null})});
    });
    changes.sort(function(a,b) { return b.start-a.start; }).forEach(function(change) { html = html.slice(0,change.start)+change.text+html.slice(change.end); });
    // Single-line script survives wpautop. Source comments are removed separately
    // so line-comment newlines cannot accidentally swallow generated statements.
    var code = mount.toString().replace(/^[ \t]*\/\/[^\r\n]*/gm,'').replace(/\r?\n\s*/g,' ');
    return html+'<script data-pp-runtime="1">('+code+')();</script>';
  }
  return {prepare:prepare,summarize:summarize};
}));
