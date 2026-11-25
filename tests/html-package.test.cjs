'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { JSDOM } = require('jsdom');
let Package;
try { Package = require('../dist/html-package.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB2QAAAAASUVORK5CYII=', 'base64');
const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(44)]);
function file(name, content, relativePath) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { name, size: bytes.length, webkitRelativePath: relativePath || '', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(items, options = {}) {
  const records = [], directory = []; let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.name), bytes = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content || '');
    const method = item.method ?? 8, data = method === 0 ? bytes : zlib.deflateRawSync(bytes);
    const flags = item.flags || 0, checksum = item.crc ?? crc32(bytes), size = item.size ?? bytes.length;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(item.attributes || 0, 38); central.writeUInt32LE(offset, 42);
    records.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const directoryBytes = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, directoryBytes, end, options.trailing || Buffer.alloc(0)]);
}
async function prepare(files) {
  assert.ok(Package && typeof Package.create === 'function', 'HTML package helper must expose create(window).prepareFiles');
  const window = new JSDOM('').window;
  try { return await Package.create(window).prepareFiles(files); } finally { window.close(); }
}
function document(result) { return new JSDOM(result.html).window.document; }

test('embeds selected image and font files from a flattened multi-file picker', async () => {
  const result = await prepare([file('index.html', '<style>@font-face{font-family:Reading;src:url("assets/read.woff2") format("woff2")}h1{background:url(assets/pixel.png)}</style><h1>Read</h1><img src="assets/pixel.png">'), file('pixel.png', PNG), file('read.woff2', WOFF2)]);
  assert.equal(result.name, 'index.html'); assert.equal(result.assetCount, 2);
  assert.equal(document(result).querySelector('img').src, 'data:image/png;base64,' + PNG.toString('base64'));
  assert.match(result.html, /data:font\/woff2;base64,d09GMg/); assert.doesNotMatch(result.html, /assets\//);
});

test('inlines nested CSS imports with paths relative to their own stylesheet', async () => {
  const result = await prepare([
    file('index.html', '<link rel="stylesheet" media="screen" href="css/site.css"><h1 style="background:url(assets/pixel.png)">Title</h1>', 'page/index.html'),
    file('site.css', '@import "inner/more.css" print;h1{color:red}', 'page/css/site.css'),
    file('more.css', 'p{background-image:url(../../assets/pixel.png)}', 'page/css/inner/more.css'),
    file('pixel.png', PNG, 'page/assets/pixel.png')
  ]);
  const doc = document(result); assert.equal(doc.querySelectorAll('link').length, 0); assert.equal(doc.querySelector('style').media, 'screen');
  assert.match(doc.querySelector('style').textContent, /@media print/); assert.match(doc.querySelector('style').textContent, /data:image\/png/);
  assert.match(doc.querySelector('h1').getAttribute('style'), /data:image\/png/); assert.equal(result.assetCount, 3);
});

test('embeds image srcset alternatives and keeps navigation URLs unchanged', async () => {
  const result = await prepare([file('index.html', '<img srcset="assets/pixel.png 1x, assets/large.png 2x"><a href="other.html">Link</a>'), file('pixel.png', PNG), file('large.png', PNG)]);
  const doc = document(result); assert.match(doc.querySelector('img').getAttribute('srcset'), /^data:image\/png;base64,\S+ 1x, data:image\/png;base64,\S+ 2x$/);
  assert.equal(doc.querySelector('a').getAttribute('href'), 'other.html');
});

test('reads bounded stored and deflated ZIP packages with a single HTML source', async () => {
  for (const method of [0, 8]) {
    const result = await prepare([file('article.zip', zip([{ name: 'site/index.html', content: '<img src="assets/pixel.png">' , method }, { name: 'site/assets/pixel.png', content: PNG, method }, { name: 'README.txt', content: 'Read me', method }]))]);
    assert.equal(result.name, 'index.html'); assert.equal(result.assetCount, 1); assert.match(result.html, /data:image\/png;base64,/);
  }
});

test('rejects missing and ambiguous HTML sources and missing packaged dependencies', async () => {
  await assert.rejects(prepare([]), /HTML|файл/i);
  await assert.rejects(prepare([file('one.html', '<p>One</p>'), file('two.html', '<p>Two</p>')]), /кілька|один|multiple|ambiguous/i);
  await assert.rejects(prepare([file('index.html', '<img src="assets/missing.png">'), file('other.png', PNG)]), /missing\.png/);
  await assert.rejects(prepare([file('broken.zip', zip([{ name: 'index.html', content: '<img src="assets/missing.png">' }]))]), /missing\.png/);
});

test('keeps lone HTML relative URLs available for the explicit base URL flow', async () => {
  const original = '<link rel="stylesheet" href="assets/site.css">\n<style>h1 { background: url(assets/background.png) }</style><img src="assets/missing.png">';
  const result = await prepare([file('index.html', original)]);
  assert.equal(document(result).querySelector('img').getAttribute('src'), 'assets/missing.png');
  assert.equal(document(result).querySelector('link').getAttribute('href'), 'assets/site.css');
  assert.match(result.html, /assets\/background.png/); assert.match(result.warnings.join(' '), /assets|ZIP|базов/i);
  assert.equal(result.html, original);
});

test('bounds repeated CSS expansion before constructing an oversized output', async () => {
  const hugeCSS = 'p{content:"' + 'A'.repeat(90000) + '"}';
  await assert.rejects(prepare([file('index.html', '<link rel="stylesheet" href="a.css">'), file('a.css', '@import "b.css";'.repeat(8)), file('b.css', hugeCSS)]), /500|HTML|ліміт|CSS/i);
});

test('browser script exposes prepareFiles and uses the existing CSS Tree global', async () => {
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  try {
    Object.assign(dom.window, { csstree: require('css-tree'), TextEncoder, TextDecoder });
    dom.window.eval(fs.readFileSync(path.join(__dirname, '../dist/html-package.js'), 'utf8'));
    const result = await dom.window.PagePosterHTMLPackage.prepareFiles([file('index.html', '<img src="a.png">'), file('a.png', PNG)]);
    assert.match(result.html, /data:image\/png;base64,/); assert.equal(result.assetCount, 1);
  } finally { dom.window.close(); }
});

test('rejects ambiguous case names and flattened asset basenames', async () => {
  await assert.rejects(prepare([file('index.html', '<p>Hi</p>'), file('A.png', PNG), file('a.png', PNG)]), /неоднознач|дубл|duplicate|ambiguous/i);
  await assert.rejects(prepare([file('index.html', '<img src="pixel.png">'), file('pixel.png', PNG, 'a/pixel.png'), file('pixel.png', PNG, 'b/pixel.png')]), /неоднознач|відсут|missing|ambiguous/i);
});

test('rejects archive traversal, absolute paths, duplicate names and encoded traversal', async () => {
  for (const bad of ['../bad.png', '/bad.png', 'C:/bad.png', 'assets\\bad.png', 'a/../../bad.png', 'assets/%2e%2e/bad.png']) {
    await assert.rejects(prepare([file('bad.zip', zip([{ name: 'index.html', content: '<p>Safe</p>' }, { name: bad, content: PNG }]))]), /шлях|path|archive|архів/i);
  }
  await assert.rejects(prepare([file('bad.zip', zip([{ name: 'index.html', content: '<p>Safe</p>' }, { name: 'INDEX.HTML', content: '<p>Wrong</p>' }]))]), /неоднознач|дубл|duplicate|ambiguous/i);
});

test('rejects encrypted, unsupported, corrupt and oversized ZIP entries', async () => {
  for (const item of [
    { name: 'index.html', content: '<p>Secret</p>', flags: 1 },
    { name: 'index.html', content: '<p>Other</p>', method: 99 },
    { name: 'index.html', content: '<p>Broken</p>', crc: 1 },
    { name: 'index.html', content: '<p>Huge</p>', size: 21 * 1024 * 1024 },
    { name: 'index.html', content: '<p>Symlink</p>', attributes: 0xa0000000 }
  ]) await assert.rejects(prepare([file('bad.zip', zip([item]))]), /ZIP|архів|розмір|ліміт|символ|пошкод|encrypted|unsupported|CRC|size|symlink/i);
  await assert.rejects(prepare([file('bad.zip', Buffer.from('not a zip'))]), /ZIP|архів/i);
});

test('validates actual uncompressed byte count and compression ratio before embedding', async () => {
  await assert.rejects(prepare([file('bad.zip', zip([{ name: 'index.html', content: 'A'.repeat(100000), size: 10 }]))]), /ZIP|архів|розмір|size/i);
  await assert.rejects(prepare([file('bad.zip', zip([{ name: 'index.html', content: 'A'.repeat(1000000) }]))]), /ZIP|архів|стис|compression|ліміт/i);
});

test('rejects unsupported executable resources and mislabeled image or font bytes', async () => {
  for (const [name, content, html] of [
    ['x.svg', '<svg onload="alert(1)"></svg>', '<img src="x.svg">'],
    ['x.js', 'alert(1)', '<style>p{background:url(x.js)}</style>'],
    ['x.png', '<script>bad()</script>', '<img src="x.png">'],
    ['x.woff2', '<script>bad()</script>', '<style>@font-face{font-family:x;src:url(x.woff2)}</style>']
  ]) await assert.rejects(prepare([file('index.html', html), file(name, content)]), /ресурс|формат|підтрим|resource|format/i);
});

test('never executes scripts or fetches remote resources while preparing HTML', async () => {
  const original = '<script>globalThis.packagePwned=true</script><script src="https://evil.test/x.js"></script><img src="https://images.test/x.png"><style>p{background:url(https://images.test/bg.png)}</style><p>Keep</p>';
  const result = await prepare([file('index.html', original)]);
  assert.equal(globalThis.packagePwned, undefined); assert.equal(result.html, original);
  assert.equal(document(result).querySelector('img').getAttribute('src'), 'https://images.test/x.png'); assert.equal(result.assetCount, 0);
});

test('rejects cyclic CSS imports and escaped local paths outside the package root', async () => {
  await assert.rejects(prepare([file('index.html', '<link rel="stylesheet" href="a.css">'), file('a.css', '@import "b.css";'), file('b.css', '@import "a.css";')]), /цикл|cycle|circular/i);
  await assert.rejects(prepare([file('index.html', '<img src="%2e%2e/x.png">'), file('x.png', PNG)]), /шлях|path/i);
});

test('enforces final HTML UTF-8 byte limit and input package byte limit', async () => {
  await assert.rejects(prepare([file('index.html', '<p>' + 'ї'.repeat(260000) + '</p>')]), /500|HTML|розмір|ліміт/i);
  await assert.rejects(prepare([file('index.html', '<img src="x.png">'), file('x.png', Buffer.concat([PNG, Buffer.alloc(380000)]))]), /500|HTML|розмір|ліміт/i);
  const huge = { name: 'index.html', size: 21 * 1024 * 1024, arrayBuffer: async () => { throw new Error('must not read oversized input'); } };
  await assert.rejects(prepare([huge]), /розмір|ліміт|size|20/i);
});

test('does not turn CSS string contents into closing style tags', async () => {
  const result = await prepare([file('index.html', '<link rel="stylesheet" href="a.css"><p>Safe</p>'), file('a.css', 'p:before{content:"</style><script>bad()</script>"}')]);
  const doc = document(result); assert.equal(doc.querySelectorAll('script').length, 0); assert.equal(doc.querySelector('p').textContent, 'Safe');
});

const playwrightPath = require('./browser-runtime.cjs').playwrightPath;
const chromePath = require('./browser-runtime.cjs').chromePath;
test('Chromium inflates a ZIP without executing source scripts or requesting source resources', { timeout: 30000, skip: !(fs.existsSync(playwrightPath) && fs.existsSync(chromePath)) }, async () => {
  const browser = await require(playwrightPath).chromium.launch({ executablePath: chromePath, headless: true, args: ['--disable-background-networking', '--no-first-run'] });
  try {
    const context = await browser.newContext(), page = await context.newPage(), requests = [];
    context.on('request', request => requests.push(request.url())); await context.route('**/*', route => route.abort());
    await page.addScriptTag({ path: path.resolve(__dirname, '../dist/csstree.js') });
    await page.addScriptTag({ path: path.resolve(__dirname, '../dist/html-package.js') });
    const bytes = zip([{ name: 'index.html', content: '<script>window.packageMarker=1</script><iframe src="https://never.test/frame"></iframe><img src="assets/pixel.png"><img src="https://never.test/image.png"><link rel="stylesheet" href="https://never.test/style.css"><style>@import "https://never.test/inner.css";p{background:url(https://never.test/bg.png)}</style>' }, { name: 'assets/pixel.png', content: PNG }]);
    const result = await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      const result = await window.PagePosterHTMLPackage.prepareFiles([new File([bytes], 'package.zip', { type: 'application/zip' })]);
      return { html: result.html, assets: result.assetCount, marker: window.packageMarker };
    }, bytes.toString('base64'));
    await page.waitForTimeout(100);
    assert.equal(result.assets, 1); assert.match(result.html, /data:image\/png;base64,/); assert.equal(result.marker, undefined); assert.deepEqual(requests, []);
  } finally { await browser.close(); }
});
