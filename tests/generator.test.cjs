'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const file = path.join(__dirname, '../dist/generator.js');
const api = fs.existsSync(file) ? require(file) : {};
const withoutRuntime = html => html.replace(/<script data-pp-runtime="1">[\s\S]*?<\/script>/g, '');
const empty = { title: 'Моя сторінка', cards: [], sections: [], faq: [] };

test('publishes the same complete API to browsers and CommonJS', () => {
  for (const key of ['DEFAULT_DATA', 'PRESETS', 'normalizeConfig', 'validateConfig', 'renderSnippet', 'renderDocument']) assert.ok(api[key], `Missing public API: ${key}`);
  const context = { URL, csstree:require('css-tree') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/page-runtime.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  assert.equal(typeof context.PagePoster.renderSnippet, 'function');
  assert.match(context.PagePoster.renderSnippet(empty), /Моя сторінка/);
});

test('escapes hostile text in headings, cards, FAQ and document titles', () => {
  const attack = '<script>alert("x")</script><img src=x onerror="alert(1)">';
  const config = { ...empty, title: attack, brand: attack, footer: attack,
    cards: [{ name: attack, bonus: attack, button: attack, note: attack, url: 'https://example.com' }],
    sections: [{ title: attack, body: attack }], faq: [{ question: attack, answer: attack }] };
  const output = api.renderDocument(config);
  assert.ok(!/<script\b|<img\b[^>]*onerror\s*=|\sonclick\s*=/i.test(withoutRuntime(output)));
  assert.ok(output.includes('&lt;script&gt;'));
  assert.ok(output.includes('&quot;x&quot;'));
});

test('rejects executable URLs and injected CSS while retaining ordinary content', () => {
  const output = api.renderSnippet({ ...empty, colors: { background: '</style><script>alert(1)</script>', accent: 'red;position:fixed', header: '#123456', card: 'url(https://evil.invalid)' },
    cards: [{ name: 'Unsafe', image: 'data:image/svg+xml,<svg onload=alert(1)>', url: 'javascript:alert(1)' },
      { name: 'Whitespace', image: '//evil.invalid/a.png', url: 'java\nscript:alert(1)' }],
    sections: [{ title: 'Текст', body: '[Bad](javascript:alert(1))\n\n[Relative](//evil.invalid)' }] });
  assert.ok(!/<script\b|javascript:|data:image|url\(|href="\/\//i.test(withoutRuntime(output)));
  assert.ok(!/<a\b[^>]*class="pp-cta"/.test(output));
  assert.ok(output.includes('Unsafe'));
});

test('renders valid images and CTA links with escaped query strings and safe relations', () => {
  const output = api.renderSnippet({ ...empty, cards: [{ name: 'Приклад', image: 'https://example.com/a.png?x=1&y=2', url: 'https://example.com/?a=1&b=%22hi%22', button: 'Далі' }] });
  assert.ok(output.includes('src="https://example.com/a.png?x=1&amp;y=2"'));
  assert.ok(output.includes('href="https://example.com/?a=1&amp;b=%22hi%22"'));
  assert.match(output, /rel="sponsored noopener noreferrer"/);
  assert.match(output, /target="_blank"/);
});

test('keeps internal IDs unique and every navigation target present', () => {
  const output = api.renderSnippet({ cards: [{ name: 'Same' }, { name: 'Same' }], sections: [{ title: 'FAQ', body: '## Same\nOne\n## Same\nTwo' }, { title: 'FAQ', body: 'Three' }], faq: [{ question: 'Same' }, { question: 'Same' }] });
  const ids = [...output.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const target of output.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(target[1]), `Missing ${target[1]}`);
});

test('preserves zero collections and omits navigation for absent sections', () => {
  const normalized = api.normalizeConfig(empty);
  assert.deepEqual(normalized.cards, []);
  assert.deepEqual(normalized.sections, []);
  assert.deepEqual(normalized.faq, []);
  const output = api.renderSnippet(empty);
  assert.ok(!/href="#pp-(offers|article|faq)"/.test(output));
  assert.ok(!/<details\b/.test(output));
});

test('scopes every CSS selector and distinguishes fixed and inline placement', () => {
  const fixed = api.renderSnippet({ ...empty, mode: 'fullscreen' });
  const inline = api.renderSnippet({ ...empty, mode: 'inline' });
  for (const output of [fixed, inline]) {
    const css = output.match(/<style>([\s\S]*?)<\/style>/)[1];
    for (const rule of css.matchAll(/([^{}]+)\{/g)) {
      const selector = rule[1].trim();
      if (selector.startsWith('@')) continue;
      for (const part of selector.split(',')) assert.ok(part.trim().startsWith('#pp-landing'), `Leaking selector: ${part}`);
    }
    assert.ok(!/\[(?:class|id)[*^$]=/.test(css));
    assert.match(css, /@media[^{}]*650px/);
  }
  assert.match(fixed, /#pp-landing#pp-landing#pp-landing\s*\{[^}]*position:fixed/);
  assert.match(fixed, /z-index:2147483000/);
  assert.ok(!/#pp-landing#pp-landing#pp-landing\s*\{[^}]*position:fixed/.test(inline));
});

test('formats paragraphs headings lists and balanced-parenthesis Markdown links safely', () => {
  const output = api.renderSnippet({ ...empty, sections: [{ title: 'Розділ', body: 'Вступ <b>текст</b>.\n\n## Підзаголовок\n- Один\n- Два\n\n[Довідка](https://example.com/wiki/Title_(topic)?a=1&b=2)' }] });
  assert.match(output, /<p>Вступ &lt;b&gt;текст&lt;\/b&gt;\.<\/p>/);
  assert.match(output, /<h3>Підзаголовок<\/h3>/);
  assert.match(output, /<ul><li>Один<\/li><li>Два<\/li><\/ul>/);
  assert.ok(output.includes('href="https://example.com/wiki/Title_(topic)?a=1&amp;b=2"'));
  const link = output.match(/<a [^>]*>Довідка<\/a>/)[0];
  assert.ok(!link.includes('sponsored'));
});

test('normalizes imported JSON with bounded known fields and no prototype pollution', () => {
  const imported = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"version":99,"mode":"bad","preset":"rose","colors":{"accent":"#abc","background":"bogus"},"cards":[],"sections":[],"faq":[],"title":"","surprise":true}');
  const normalized = api.normalizeConfig(imported);
  assert.equal(normalized.version, 1);
  assert.equal(normalized.mode, 'fullscreen');
  assert.equal(normalized.preset, 'rose');
  assert.match(normalized.colors.background, /^#[0-9a-f]{6}$/i);
  assert.ok(!Object.hasOwn(normalized, 'surprise'));
  assert.ok(!Object.hasOwn(normalized, '__proto__'));
  assert.equal({}.polluted, undefined);
  assert.equal(normalized.title, '');
  const bounded = api.normalizeConfig({ cards: Array.from({ length: 120 }, () => ({ name: 'x'.repeat(10000), injected: 1 })), sections: Array(120).fill({}), faq: Array(120).fill({}) });
  assert.equal(bounded.cards.length, 100);
  assert.equal(bounded.sections.length, 100);
  assert.equal(bounded.faq.length, 100);
  assert.ok(bounded.cards[0].name.length < 10000);
  assert.ok(!Object.hasOwn(bounded.cards[0], 'injected'));
  assert.doesNotThrow(() => api.normalizeConfig(null));
  assert.doesNotThrow(() => api.normalizeConfig([]));
});

test('clamps numerical ratings while keeping missing or invalid ratings blank', () => {
  const normalized = api.normalizeConfig({ cards: [{ rating: '8' }, { rating: '-2' }, { rating: '4.84' }, { rating: 'n/a' }, { rating: '' }] });
  assert.deepEqual(normalized.cards.map(c => c.rating), ['5', '0', '4.8', '', '']);
  const output = api.renderSnippet({ ...empty, cards: [{ name: 'Без оцінки', rating: '' }] });
  assert.ok(!output.includes('/ 5'));
});

test('returns Ukrainian validation warnings without blocking rendering', () => {
  const config = { ...empty, title: '', cards: [{ name: 'A', url: '' }, { name: 'B', url: 'ftp://example.com' }] };
  const warnings = api.validateConfig(config);
  assert.equal(warnings.length, 3);
  for (const warning of warnings) assert.match(warning, /[А-Яа-яІіЇїЄє]/);
  const output = api.renderSnippet(config);
  assert.ok(!/<a\b[^>]*class="pp-cta"/.test(output));
  assert.equal(api.validateConfig({ ...empty, cards: [{ name: 'A', url: 'https://example.com' }] }).length, 0);
});

test('separates fragments from documents and emits only the dedicated navigation runtime', () => {
  const snippet = api.renderSnippet(empty);
  const document = api.renderDocument(empty);
  assert.match(snippet, /^<style>/);
  assert.ok(!/<\/?(?:html|head|body)\b|<!doctype/i.test(snippet));
  assert.match(document, /^<!doctype html>/i);
  assert.match(document, /<html lang="uk">/);
  assert.match(document, /<meta name="viewport"/);
  assert.match(document, /<title>Моя сторінка<\/title>/);
  assert.ok(document.includes(snippet));
  assert.ok(!/<script\b|\son(?:click|load|error)\s*=/i.test(withoutRuntime(document)));
  assert.equal((snippet.match(/<script data-pp-runtime="1">/g) || []).length, 1);
});


test('renders inline bold in article text, headings, lists and FAQ answers', () => {
  const output = api.renderSnippet({ ...empty, sections: [{ title: 'Текст', body: 'Звичайний **жирний текст** і **ще раз**.\n\n## Наш **вибір**\n- **Перевага**\n\nНезакритий **маркер' }], faq: [{ question: 'Чому?', answer: 'Бо це **важливо**.' }] });
  assert.ok(output.includes('<p>Звичайний <strong>жирний текст</strong> і <strong>ще раз</strong>.</p>'));
  assert.ok(output.includes('<h3>Наш <strong>вибір</strong></h3>'));
  assert.ok(output.includes('<li><strong>Перевага</strong></li>'));
  assert.ok(output.includes('<p>Бо це <strong>важливо</strong>.</p>'));
  assert.ok(output.includes('Незакритий **маркер'));
});

test('keeps bold content and links safe, including bold labels and links inside bold', () => {
  const output = api.renderSnippet({ ...empty, sections: [{ title: '', body: '**<img src=x onerror=alert(1)>** [**<script>x</script>**](javascript:alert(1))\n\n[**Довідка**](https://example.com/?a=1&b=2)\n\n**[Далі](https://example.com/page)**' }] });
  assert.ok(output.includes('<strong>&lt;img src=x onerror=alert(1)&gt;</strong>'));
  assert.ok(output.includes('<strong>&lt;script&gt;x&lt;/script&gt;</strong>'));
  assert.ok(output.includes('<a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer" data-pp-priority="article"><strong>Довідка</strong></a>'));
  assert.ok(output.includes('<strong><a href="https://example.com/page" rel="noopener noreferrer" data-pp-priority="article">Далі</a></strong>'));
  assert.ok(!/<script\b|<img\b|href="javascript:/i.test(withoutRuntime(output)));
});

test('brand links redirect in header and footer with safe new-tab destinations', () => {
  const output = api.renderSnippet({ ...empty, brand: 'HOME', brandUrl: 'https://example.com/home?a=1&b=2', brandTagline: 'YOUR GUIDE', brandImage: 'https://example.com/logo.png' });
  const brands = [...output.matchAll(/<a\b[^>]*class="pp-brand"[^>]*>[\s\S]*?<\/a>/g)].map(m => m[0]);
  assert.equal(brands.length, 2);
  for (const brand of brands) {
    assert.match(brand, /(?:href|data-pp-url)="https:\/\/example.com\/home\?a=1&amp;b=2"/);
    assert.ok(brand.includes('target="_blank"'));
    assert.ok(brand.includes('rel="noopener noreferrer"'));
    assert.ok(!brand.includes('sponsored'));
    assert.ok(brand.includes('YOUR GUIDE'));
  }
  const invalid = { ...empty, brandUrl: 'javascript:alert(1)', brandImage: 'data:image/svg+xml,<svg onload=alert(1)>' };
  assert.ok(api.validateConfig(invalid).some(w => /бренд|логотип/i.test(w)));
  const fallback = api.renderSnippet(invalid);
  assert.ok(fallback.includes('href="#pp-top"'));
  assert.ok(fallback.includes('id="pp-top"'));
  assert.ok(!/javascript:|data:image/.test(fallback));
});

test('renders new page blocks in reading order with safe tables and reachable TOC', () => {
  const output = api.renderSnippet({ ...empty, showToc: true, tocTitle: 'Contents',
    cards: [{ name: 'Primary marker' }], moreCards: [{ name: 'Secondary marker', features: 'Fast overview\nClear terms', payout: 'Check timing', payoutNote: 'Provider information' }],
    tiles: [{ name: 'Tile marker', body: 'Tile body', image: 'https://example.com/tile.png', url: 'https://example.com/tile' }],
    sections: [{ title: 'First section marker', body: 'First body', image: 'https://example.com/section.png' }, { title: 'Second section marker', body: 'Second body' }, { title: 'Third section marker', body: 'Third body' }],
    tableTitle: 'Table marker', tableText: 'Feature|Details\n<img src=x>|Safe & sound\nSpeed|Verify terms',
    faq: [{ question: 'FAQ marker', answer: 'Answer' }], reviews: [{ title: 'Review marker', body: 'Review body', image: '', url: 'https://example.com/review' }]
  });
  const order = ['id="pp-offers"', 'id="pp-more-offers"', 'id="pp-tiles"', 'id="pp-toc"', 'id="pp-article"', 'id="pp-faq"', 'id="pp-reviews"', 'id="pp-footer"'].map(s => output.indexOf(s));
  assert.ok(order.every((index, i) => index >= 0 && (!i || index > order[i - 1])));
  assert.ok(output.indexOf('Second body') < output.indexOf('<table'));
  assert.ok(output.indexOf('<table') < output.indexOf('Third body'));
  assert.ok(output.includes('<th scope="col">Feature</th>'));
  assert.ok(output.includes('&lt;img src=x&gt;'));
  assert.ok(output.includes('Safe &amp; sound'));
  assert.ok(output.includes('Provider information'));
  const ids = [...output.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const target of output.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(target[1]), `Missing ${target[1]}`);
});

test('legacy configs gain no unsolicited new collections or table text', () => {
  const legacy = api.normalizeConfig({ ...empty, cards: [{ name: 'Keep me', bonus: 'Original', note: 'Original note' }], sections: [{ title: 'Original section', body: 'Original body' }] });
  assert.equal(legacy.cards[0].note, 'Original note');
  assert.equal(legacy.cards[0].features, '');
  assert.equal(legacy.sections[0].body, 'Original body');
  assert.equal(legacy.sections[0].image, '');
  for (const key of ['moreCards', 'tiles', 'services', 'reviews', 'navLinks']) assert.deepEqual(legacy[key], []);
  assert.equal(legacy.tableText, '');
  assert.equal(legacy.showToc, false);
  const output = api.renderSnippet(legacy);
  assert.ok(!/id="pp-(more-offers|tiles|reviews|toc|table)"/.test(output));
});

test('uses distinct row and Atlas layouts while retaining readable blank-image wordmarks', () => {
  const config = { ...empty, cards: [{ name: 'NOVA PLAY', bonus: 'Welcome package', rating: '4.9', url: 'https://example.com', features: 'A feature', payout: 'Check terms' }] };
  const emerald = api.renderSnippet({ ...config, preset: 'emerald' });
  const forest = api.renderSnippet({ ...config, preset: 'forest' });
  const rose = api.renderSnippet({ ...config, preset: 'rose' });
  assert.match(emerald, /class="pp-offer pp-offer-row"/);
  assert.match(forest, /class="pp-offer pp-offer-row"/);
  assert.match(rose, /class="pp-offer pp-offer-atlas"/);
  assert.ok(emerald.includes('class="pp-columns"'));
  assert.ok(!rose.includes('class="pp-columns"'));
  assert.ok(rose.includes('class="pp-rating-circle"'));
  assert.ok(emerald.includes('class="pp-wordmark"'));
  assert.ok(emerald.includes('NOVA PLAY'));
  assert.ok(!emerald.includes('>NP</span>'));
  assert.ok(rose.includes('linear-gradient('));
});

test('filters custom navigation to safe external URLs and existing internal targets', () => {
  const output = api.renderSnippet({ ...empty, sections: [{ title: 'Existing', body: 'Body' }], navLinks: [
    { name: 'Existing link', url: '#pp-section-1' }, { name: 'External link', url: 'https://example.com?a=1&b=2' },
    { name: 'Missing link', url: '#missing' }, { name: 'Dangerous link', url: 'javascript:alert(1)' }
  ] });
  assert.ok(output.includes('href="#pp-section-1">Existing link</a>'));
  assert.ok(output.includes('href="https://example.com?a=1&amp;b=2">External link</a>'));
  assert.ok(!output.includes('Missing link'));
  assert.ok(!output.includes('Dangerous link'));
});

test('bounds and escapes added data while default demo provides full editable page', () => {
  const hostile = '<script>alert(1)</script>';
  const normalized = api.normalizeConfig({ ...empty, moreCards: Array(120).fill({ features: hostile }), tiles: Array(120).fill({ name: hostile }), services: Array(120).fill({ name: hostile }), reviews: Array(120).fill({ title: hostile }), navLinks: Array(120).fill({ name: hostile }), authorImage: 'javascript:alert(1)', brandTagline: hostile, footerNote: hostile });
  for (const key of ['moreCards', 'tiles', 'services', 'reviews', 'navLinks']) assert.equal(normalized[key].length, 100);
  const output = api.renderSnippet(normalized);
  assert.ok(!/<script\b|javascript:/i.test(withoutRuntime(output)));
  assert.ok(output.includes('&lt;script&gt;'));
  assert.equal(api.DEFAULT_DATA.cards.length, 5);
  assert.equal(api.DEFAULT_DATA.moreCards.length, 10);
  assert.equal(api.DEFAULT_DATA.tiles.length, 12);
  assert.equal(api.DEFAULT_DATA.services.length, 4);
  assert.equal(api.DEFAULT_DATA.sections.length, 10);
  assert.equal(api.DEFAULT_DATA.faq.length, 5);
  assert.equal(api.DEFAULT_DATA.reviews.length, 10);
  assert.ok(api.DEFAULT_DATA.intro.toLowerCase().includes('demo'));
});


test('renders editable promo and service covers without remote default assets', () => {
  const config = { ...empty, promoTitle: 'Promo heading', promoBody: '**Useful context**', promoButton: 'Learn more', promoUrl: 'https://example.com/promo?a=1&b=2', servicesTitle: 'Service heading', services: [{ name: 'Live experiences', body: 'Checked service description', image: '', url: 'https://example.com/service' }] };
  const output = api.renderSnippet(config);
  assert.ok(output.includes('id="pp-promo"'));
  assert.ok(output.includes('<strong>Useful context</strong>'));
  assert.ok(output.includes('href="https://example.com/promo?a=1&amp;b=2"'));
  assert.ok(output.includes('id="pp-services"'));
  assert.ok(output.includes('class="pp-cover-art"'));
  assert.ok(output.includes('Checked service description'));
  assert.ok(!/<img\b/.test(api.renderSnippet(api.DEFAULT_DATA)));
  const invalid = api.renderSnippet({ ...config, promoUrl: 'javascript:alert(1)', services: [{ name: '<svg onload=alert(1)>', image: 'data:image/svg+xml,x', url: 'javascript:alert(1)' }] });
  assert.ok(!/javascript:|data:image|<svg\b/i.test(invalid));
  assert.ok(invalid.includes('&lt;svg onload=alert(1)&gt;'));
});

test('validates secondary and optional asset URLs without requiring optional links', () => {
  const warnings = api.validateConfig({ ...empty, moreCards: [{ name: 'More', url: 'javascript:alert(1)' }], authorImage: '//invalid.example/image', promoUrl: 'data:text/html,hello', tiles: [{ url: 'ftp://example.com', image: 'javascript:alert(1)' }], services: [{ url: 'javascript:alert(1)' }], reviews: [{ image: 'bad' }], navLinks: [{ name: 'Broken', url: '#missing' }] });
  assert.equal(warnings.length, 8);
  assert.equal(api.validateConfig({ ...empty, tiles: [{}], services: [{}], reviews: [{}], navLinks: [] }).length, 0);
});


test('blank brand destination follows first valid offer but invalid explicit input never reroutes', () => {
  const config = { ...empty, brandUrl: '', cards: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com/first?a=1&b=2' }, { url: 'https://example.com/second' }], moreCards: [{ url: 'https://example.com/extra' }] };
  function brandLinks(value) { return [...api.renderSnippet(value).matchAll(/<a class="pp-brand"[^>]*>/g)].map(m => m[0]); }
  for (const link of brandLinks(config)) {
    assert.ok(link.includes('data-pp-url="https://example.com/first?a=1&amp;b=2"'));
    assert.ok(link.includes('target="_blank"'));
    assert.ok(link.includes('rel="noopener noreferrer"'));
  }
  for (const link of brandLinks({ ...config, brandUrl: 'https://example.com/independent' })) assert.match(link, /(?:href|data-pp-url)="https:\/\/example.com\/independent"/);
  for (const link of brandLinks({ ...config, cards: [] })) assert.ok(link.includes('data-pp-url="https://example.com/extra"'));
  for (const value of [{ ...config, brandUrl: 'javascript:bad()' }, { ...empty, brandUrl: '' }]) {
    for (const link of brandLinks(value)) {
      assert.ok(link.includes('href="#pp-top"'));
      assert.ok(!link.includes('target='));
    }
  }
});

// Use the official WordPress formatter to reproduce host-side HTML rewriting.
const { wpautop: wordpressParagraphFilter } = require('./wordpress-fixture.cjs');
function assertBalancedMarkup(text) {
  const stack = [];
  for (const token of text.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const tag = token[2].toLowerCase();
    if (['img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'area', 'col'].includes(tag)) continue;
    if (token[1]) assert.equal(stack.pop(), tag, `Unexpected closing ${tag} near ${text.slice(Math.max(0, token.index - 100), token.index + 40)}`);
    else stack.push(tag);
  }
  assert.deepEqual(stack, []);
}

test('WordPress filter fixture reproduces the published orphan paragraph failure', () => {
  const transformed = wordpressParagraphFilter('<article class="pp-offer"><span class="pp-rank">1</span><div class="pp-brand-cell">Brand</div></article>');
  assert.ok(transformed.includes('</span></p>'));
  assert.throws(() => assertBalancedMarkup(transformed));
});

test('keeps structural markup balanced after WordPress paragraph filtering in all presets', () => {
  for (const preset of ['emerald', 'forest', 'rose']) {
    const snippet = api.renderSnippet({ ...api.DEFAULT_DATA, preset, brandImage: 'https://example.com/brand.png', authorImage: 'https://example.com/author.png', reviews: [{ title: 'Review', image: 'https://example.com/review.png', body: 'Body', url: 'https://example.com/review' }] });
    const markup = snippet.replace(/^<style>[\s\S]*?<\/style>\s*/, '');
    assertBalancedMarkup(wordpressParagraphFilter(markup));
  }
});

test('exports scoped protection against the observed Koncrete header and list rules', () => {
  const output = api.renderSnippet(empty);
  const css = output.match(/^<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /#pp-landing#pp-landing#pp-landing \.pp-header\{[^}]*display:block/);
  assert.match(css, /#pp-landing#pp-landing#pp-landing li\{[^}]*font:inherit/);
  assert.ok(!/(?:^|})\s*header\s*\{/.test(css));
});

test('preserves visible line breaks without giving WordPress raw text newlines to double', () => {
  const output = api.renderSnippet({ ...empty, intro: 'First\nSecond', cards: [{ name: 'Demo', bonus: 'One\nTwo', payout: 'Fast\nChecked', note: 'A\nB' }] });
  assert.ok(output.includes('First&#10;Second'));
  assert.ok(output.includes('One&#10;Two'));
  assert.ok(output.includes('Fast&#10;Checked'));
  assert.ok(!output.includes('One\nTwo'));
});


test('page and generated chrome styles outrank common theme important rules without global selectors',()=>{
 const tree=require('css-tree'),css=api.renderSnippet(empty).match(/^<style>([\s\S]*?)<\/style>/)[1];
 let display=false,position=false;
 tree.walk(tree.parse(css),{visit:'Rule',enter(rule){
  if(!rule.prelude||rule.prelude.type!=='SelectorList')return;
  const selector=tree.generate(rule.prelude);
  if(selector==='#pp-landing#pp-landing#pp-landing .pp-header') rule.block.children.forEach(d=>{if(d.property==='display'&&d.important)display=true;});
  if(selector==='#pp-landing#pp-landing#pp-landing') rule.block.children.forEach(d=>{if(d.property==='position'&&d.important)position=true;});
 }});
 assert.ok(display);assert.ok(position);
});
