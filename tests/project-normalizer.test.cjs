'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const {JSDOM} = require('jsdom');
const htmlPackage = require('../dist/html-package.js');
const {readProjectRar} = require('../desktop/project-rar.cjs');
const {zip, rar, xlsx, pages} = require('./fixtures/project-normalizer.cjs');

async function normalize(t, name, content, options) {
  const {window} = new JSDOM('');
  t.after(() => window.close());
  const context = {TextEncoder, TextDecoder, Uint8Array, URL, DOMParser: window.DOMParser,
    PagePosterProjectTable: require('../dist/project-table.js'),
    PagePosterHTMLPackage: {...htmlPackage, ...htmlPackage.create(window)},
    pageposterDesktop: {readProjectRar: async bytes => ({entries: await readProjectRar(bytes)})}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/project-normalizer.js'), 'utf8'), context);
  const bytes = Uint8Array.from(Buffer.from(content));
  return JSON.parse(JSON.stringify(await context.PagePosterProjectNormalizer.normalize({name, size: bytes.length, arrayBuffer: async () => bytes.buffer},options)));
}

async function preview(file) {
  const {createProjectImporter} = await import('../server/lifecycle/project-import.mjs');
  const {headers, sheet, ...input} = file;
  const result = await createProjectImporter().preview({...input, defaults: {detectFileRegions: true}});
  assert.deepEqual(result.issues, []);
  return result.items;
}

test('imports an Excel CSV with an explicit separator, BOM and quoted fields', async t => {
  const source = '\uFEFFsep=;\r\nurl;anchor;language\r\n"https://example.org/guide?a=1&b=2";"Guide; exact anchor";pl\r\n';
  const file = await normalize(t, 'excel-export.csv', source);
  const [item] = await preview(file);
  assert.equal(item.language, 'pl');
  assert.deepEqual(item.links, [{url:'https://example.org/guide?a=1&b=2',anchor:'Guide; exact anchor'}]);
});

test('normalizes XLSX headers and preserves URL, anchor and GEO through the existing importer', async t => {
  const file = await normalize(t, 'Campaign.xlsx', xlsx());
  assert.equal(file.sheet, 'Pages'); assert.equal(file.type, 'ai');
  const [item] = await preview(file);
  assert.deepEqual(item.links, [{url: 'https://example.com/?a=%2F&b=2', anchor: 'Exact anchor'}]);
  assert.equal(item.geo, 'NZ'); assert.equal(item.provenance.source.file, 'Campaign.xlsx');
});

function workbook(sheets,hidden=[]) {
  return zip([
    ['xl/workbook.xml','<workbook xmlns:r="urn:office"><sheets>'+sheets.map((_,i)=>'<sheet name="Sheet '+i+'" r:id="rId'+i+'"'+(hidden.includes(i)?' state="hidden"':'')+'/>').join('')+'</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels','<Relationships>'+sheets.map((_,i)=>'<Relationship Id="rId'+i+'" Type="urn:office/worksheet" Target="worksheets/sheet'+i+'.xml"/>').join('')+'</Relationships>'],
    ...sheets.map((rows,i)=>['xl/worksheets/sheet'+i+'.xml','<worksheet><sheetData>'+rows+'</sheetData></worksheet>'])
  ]);
}

test('reads actual workbook sheets, cached scalar cells and physical row coordinates', async t => {
  const inline = (address, value) => '<c r="'+address+'" t="inlineStr"><is><t>'+value+'</t></is></c>';
  const first = '<row r="1">'+inline('A1','url')+inline('B1','anchor')+'</row>'+
    '<row r="4">'+inline('A4','https://example.com/')+'<c r="B4" t="str"><f>CONCAT("Exact"," anchor")</f><v>Exact anchor</v></c></row>';
  const second = '<row r="2">'+inline('A2','anchor')+inline('B2','url')+'</row>'+
    '<row r="5">'+inline('A5','Other anchor')+inline('B5','https://example.org/')+'</row>';
  const notes='<row r="1">'+inline('A1','Meeting notes')+inline('ZZ1','Unrelated far column')+'</row>'+
    '<row r="2"><c r="A2" t="e"><v>#REF!</v></c></row>';
  const cover='<row r="1">'+inline('A1','July project tasks')+'</row>';
  const items = await preview(await normalize(t,'tasks.xlsx',workbook([notes,first,cover+second])));
  assert.deepEqual(items.map(item=>[item.links[0].anchor,item.provenance.source]),[
    ['Exact anchor',{kind:'table',file:'tasks.xlsx',sheet:1,row:4}],
    ['Other anchor',{kind:'table',file:'tasks.xlsx',sheet:2,row:5}]
  ]);
});

test('combines project maps and keeps source table and exact HTML ownership', async t => {
  const input = zip([...pages,['notes.csv','title,notes\nMeeting,Follow-up'],['extra.html','<h1>Cover</h1>'],
    ['maps/first.csv','file,slug,donor\npages/nz-guide.html,exact-nz,example.org'],
    ['second.csv','file,placementUrl\npl-guide.html,https://example.net/precise-pl']]);
  const items = await preview(await normalize(t,'campaign.zip',input));
  assert.deepEqual(items.map(item=>[item.slug,item.donor,item.provenance.source]),[
    ['exact-nz','https://example.org/',{kind:'files',file:'nz-guide.html',tableFile:'first.csv',row:2}],
    ['precise-pl','https://example.net/',{kind:'files',file:'pl-guide.html',tableFile:'second.csv',row:2}]
  ]);
});

const wordNs='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wordTable=rows=>'<w:tbl>'+rows.map(row=>'<w:tr>'+row.map(cell=>'<w:tc><w:p>'+cell+'</w:p></w:tc>').join('')+'</w:tr>').join('')+'</w:tbl>';
const wordText=text=>'<w:r><w:t xml:space="preserve">'+text.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</w:t></w:r>';
const wordRelNs='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRelNs='http://schemas.openxmlformats.org/package/2006/relationships';
const wordFile=(body,prolog='',relations='')=>zip([
 ['word/document.xml',prolog+'<w:document xmlns:w="'+wordNs+'" xmlns:r="'+wordRelNs+'"><w:body>'+body+'</w:body></w:document>'],
 ...(relations?[['word/_rels/document.xml.rels','<Relationships xmlns="'+packageRelNs+'">'+relations+'</Relationships>']]:[])
]);
const wordLink=(label,id='rId1')=>'<w:hyperlink r:id="'+id+'">'+wordText(label)+'</w:hyperlink>';
const wordRelation=(target,id='rId1',mode='External')=>'<Relationship Id="'+id+'" Type="'+wordRelNs+'/hyperlink" TargetMode="'+mode+'" Target="'+target+'"/>';

test('reads one DOCX table, preserves exact visible links and records its provenance',async t=>{
 const rows=[['Посилання','Анкор','Гео'].map(wordText),[
  wordText('https://example.com/?a=%2F&b=2'),wordText('Точний ')+wordText('анкор'),wordText('NZ')
 ]];
 const [item]=await preview(await normalize(t,'Campaign.docx',wordFile('<w:p>'+wordText('PRIVATE NOTE OUTSIDE TABLE')+'</w:p>'+wordTable(rows))));
 assert.deepEqual(item.links,[{url:'https://example.com/?a=%2F&b=2',anchor:'Точний анкор'}]);
 assert.equal(item.geo,'NZ');
 assert.equal(item.provenance.source.file,'Campaign.docx');
 assert.equal(item.provenance.source.row,2);
 assert.doesNotMatch(JSON.stringify(item),/PRIVATE NOTE/);
});

test('rejects ambiguous or unsafe DOCX tables before creating a preview',async t=>{
 const table=wordTable([['url','anchor'].map(wordText),['https://example.com/','Anchor'].map(wordText)]);
 await assert.rejects(normalize(t,'two.docx',wordFile(table+table)),/одну.*таблицю/i);
 await assert.rejects(normalize(t,'text.docx',wordFile('<w:p>'+wordText('https://example.com/')+'</w:p>')),/одну.*таблицю/i);
 await assert.rejects(normalize(t,'merged.docx',wordFile(table.replace('<w:tc>','<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>'))),/об’єднан/i);
 await assert.rejects(normalize(t,'extra.docx',wordFile(wordTable([['url','anchor'].map(wordText),['https://example.com/'].map(wordText)]))),/кількість.*клітин/i);
 await assert.rejects(normalize(t,'entity.docx',wordFile(table,'<!DOCTYPE w:document SYSTEM "https://fixture.invalid/secret">')),/непідтримуваний XML/i);
 const changed=table.replace(wordText('Anchor'),'<w:ins>'+wordText('New')+'</w:ins>');
 await assert.rejects(normalize(t,'tracked.docx',wordFile(changed)),/невирішених правок/i);
});

test('resolves Word hyperlink targets in URL columns without changing visible anchor text',async t=>{
 const rows=[['Посилання','Анкор','url2','anchor2'].map(wordText),[
  wordLink('Відкрити'),wordLink('Точний анкор','rIdUnused'),
  wordLink('https://example.org/path#section','rId2'),wordText('Second')
 ]];
 const relations=wordRelation('https://example.com/?a=%2F&amp;b=2')+
  wordRelation('https://example.org/path#section','rId2')+
  wordRelation('file:///unused','rIdUnused');
 const [item]=await preview(await normalize(t,'Word links.docx',wordFile(wordTable(rows),'',relations)));
 assert.deepEqual(item.links,[
  {url:'https://example.com/?a=%2F&b=2',anchor:'Точний анкор'},
  {url:'https://example.org/path#section',anchor:'Second'}
 ]);
 for (const label of ['www.example.org/path#section','//www.example.org/path#section','https://WWW.example.org/path#section','www.example.org:443/path#section']) {
  const equivalent=[['url','anchor'].map(wordText),[wordLink(label),wordText('Exact')]];
  const [result]=await preview(await normalize(t,'Equivalent.docx',wordFile(wordTable(equivalent),'',wordRelation('https://www.example.org/path#section'))));
  assert.equal(result.links[0].url,'https://www.example.org/path#section');
 }
});

test('rejects ambiguous Word hyperlinks and unsafe or missing targets in URL columns without exposing URLs',async t=>{
 const file=(cell,relations)=>wordFile(wordTable([['url','anchor'].map(wordText),[cell,wordText('Anchor')]]),'',relations);
 const target='https://example.com/';
 for (const [cell,relations] of [
  [wordLink('https://wrong.example/'),wordRelation(target)],
  [wordLink('wrong.example/path'),wordRelation(target)],
  [wordLink('Open')+wordText(' trailing text'),wordRelation(target)],
  [wordLink('Open')+wordLink('More','rId2'),wordRelation(target)+wordRelation(target,'rId2')],
  [wordLink('Open'),wordRelation(target)+wordRelation(target)],
  [wordLink('Open'),wordRelation(target,'rId2')],
  [wordLink('Open'),wordRelation(target,'rId1','Internal')],
  [wordLink('Open'),wordRelation('file:///PRIVATE-FIXTURE')],
  [wordLink('Open'),wordRelation('https://PRIVATE-FIXTURE:secret@example.com/')],
  [wordLink('Open').replace('r:id=', 'w:anchor="local" r:id='),wordRelation(target)]
 ]) {
  await assert.rejects(normalize(t,'unsafe.docx',file(cell,relations)),error=>{
   assert.match(error.message,/DOCX.*рядок 2.*колонка 1.*посилання/i);
   assert.doesNotMatch(error.message,/PRIVATE-FIXTURE|wrong\.example/);
   return true;
  });
 }
});

test('rejects wrapped Word rows and alternate content instead of silently dropping or combining data',async t=>{
 const table=wordTable([['url','anchor'].map(wordText),['https://example.com/','Anchor'].map(wordText)]);
 const wrapped=table.replace('</w:tbl>','<w:customXml><w:tr><w:tc><w:p>'+wordText('https://example.org/')+'</w:p></w:tc><w:tc><w:p>'+wordText('Second')+'</w:p></w:tc></w:tr></w:customXml></w:tbl>');
 await assert.rejects(normalize(t,'wrapped.docx',wordFile(wrapped)),/вкладену структуру/);
 const alternative='<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="w">'+wordText('Primary')+'</mc:Choice><mc:Fallback>'+wordText('Fallback')+'</mc:Fallback></mc:AlternateContent>';
 await assert.rejects(normalize(t,'alternate.docx',wordFile(table.replace(wordText('Anchor'),alternative))),/альтернативний вміст/);
});

test('a DOCX credentials column is rejected by the importer without exposing its value',async t=>{
 const {createProjectImporter}=await import('../server/lifecycle/project-import.mjs');
 const rows=[['url','anchor','password'].map(wordText),['https://example.com/','Anchor','SECRET-FIXTURE-DO-NOT-ECHO'].map(wordText)];
 const {headers,sheet,...payload}=await normalize(t,'Extra.docx',wordFile(wordTable(rows)));
 const result=await createProjectImporter().preview(payload);
 assert.equal(result.items.length,0);
 assert.equal(result.issues.length,1);
 assert.doesNotMatch(JSON.stringify(result),/SECRET-FIXTURE-DO-NOT-ECHO/);
});

test('normalizes ZIP with multiple HTML files, shared assets and per-file metadata', async t => {
  const file = await normalize(t, 'Campaign.zip', zip([...pages, ['manifest.csv', 'file,title,minTraffic\nnz-guide.html,NZ draft,50\npl-guide.html,PL draft,75']]));
  assert.equal(file.type, 'html');
  const items = await preview(file);
  assert.deepEqual(items.map(item => [item.title, item.language, item.geo, item.siteSelection.minTraffic]), [['NZ draft','en-nz','NZ',50], ['PL draft','pl','PL',75]]);
  for (const item of items) assert.match(item.html, /#102030/);
});

test('automatic archive import uses manifest rows and ignores the bundle index and inventory columns', async t => {
  const archive=zip([...pages,['index.html','<link rel="stylesheet" href="missing.css"><h1>Bundle index</h1>'],
    ['publication-map.csv','filename,main_key,GEO,language,brand,words,FAQ\nnz-guide.html,main phrase,NZ,en-NZ,Kiwi Guide,4657,12\npl-guide.html,other phrase,PL,pl,Polish Guide,2500,10']]);
  const normalized=await normalize(t,'Brief.zip',archive,{mapColumns(){assert.fail('Known inventory headings require no API');}});
  assert.deepEqual(normalized.files.map(file=>file.name),['nz-guide.html','pl-guide.html']);
  assert.deepEqual((await preview(normalized)).map(item=>item.geo),['NZ','PL']);
});

test('reads a real RAR through Windows tar and keeps shared assets usable', {skip: process.platform !== 'win32'}, async t => {
  const file = await normalize(t, 'Campaign.rar', rar(pages));
  assert.equal(file.type, 'html');
  const items = await preview(file);
  assert.deepEqual(items.map(item => item.geo), ['NZ','PL']);
  assert.match(items[0].html, /#102030/);
  await assert.rejects(readProjectRar(rar([['../outside.html', '<h1>Unsafe</h1>']])), /шлях|RAR/);
  await assert.rejects(readProjectRar(rar([['short.html', '<h1>Short</h1>'], ['x'.repeat(96)+'.html', '<h1>Long</h1>']])), /RAR прочитано не повністю/);
});

test('keeps the BOM and line endings of an asset-free archived HTML', async t => {
  const html = '\uFEFF<!doctype html>\r\n<html lang="pl"><body>Treść</body></html>\r\n';
  const file = await normalize(t, 'exact.zip', zip([['pl-exact.html',html]]));
  assert.equal(file.files[0].html,html);
  assert.equal((await preview(file))[0].html,html);
});

test('imports BOM-marked UTF-16LE and UTF-16BE HTML from a mixed-language ZIP with shared CSS', async t => {
  const polish = '<!doctype html><html lang="pl"><head><link rel="stylesheet" href="../assets/main.css"></head><body><h1>Zażółć gęślą jaźń</h1></body></html>';
  const hungarian = '<!doctype html><html lang="hu"><body><h1>Árvíztűrő tükörfúrógép</h1></body></html>';
  const le = value => Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(value,'utf16le')]);
  const be = value => Buffer.concat([Buffer.from([0xfe,0xff]),Buffer.from(value,'utf16le').swap16()]);
  const archive = zip([['pages/pl-guide.html',le(polish)],['pages/hu-guide.html',be(hungarian)],
    ['assets/main.css',le('h1 { color: #102030; }')]]);
  const [pl,hu] = await preview(await normalize(t,'mixed.zip',archive));
  assert.deepEqual([pl.geo,hu.geo],['PL','HU']);
  assert.match(pl.html,/Zażółć gęślą jaźń/);
  assert.match(pl.html,/#102030/);
  assert.equal(hu.html,hungarian);
  assert.equal((await normalize(t,'hu-guide.html',be(hungarian))).files[0].html,hungarian);
});

test('rejects damaged UTF-16 and BOM-less UTF-16 before import', async t => {
  const invalid = Buffer.from([0xff,0xfe,0x00,0xd8]);
  const bomless = Buffer.from('<h1>Page</h1>','utf16le');
  for (const bytes of [invalid,bomless]) {
    await assert.rejects(normalize(t,'bad.html',bytes),/кодування/);
    await assert.rejects(normalize(t,'bad.zip',zip([['bad.html',bytes]])),/кодування/);
  }
});

test('README that resembles metadata cannot supply or override archive mappings', async t => {
  const archive = zip([...pages,['docs/README.txt','file,geo\nnz-guide.html,US'],
    ['manifest.csv','file,geo\nnz-guide.html,NZ\npl-guide.html,PL']]);
  const items = await preview(await normalize(t,'with-readme.zip',archive));
  assert.deepEqual(items.map(item=>item.geo),['NZ','PL']);
});

test('rejects case-conflicting archive directories and paths used as files and folders', async t => {
  for (const entries of [
    [['Pages/nz.html','<h1>NZ</h1>'],['pages/pl.html','<h1>PL</h1>']],
    [['pages','conflict'],['pages/pl.html','<h1>PL</h1>']]
  ]) await assert.rejects(normalize(t,'conflict.zip',zip(entries)),/Неоднозначн.*шлях/);
});

test('reads compressed RAR5 from WinRAR with Unicode and long names', {skip: process.platform !== 'win32'}, async t => {
  const names = ['nz-огляд.html','pl-'+'x'.repeat(98)+'.html'];
  const content = ['<p>New Zealand</p>'.repeat(160), '<p>Polska</p>'.repeat(160)];
  // WinRAR 6.24: rar a -cfg- -ma5 -m3 -ep -inul -- compressed-rar5.rar <names>
  const bytes=fs.readFileSync(path.join(__dirname,'fixtures/compressed-rar5.rar'));
  assert.ok(bytes.length<content.join('').length);
  const file=await normalize(t,'fixture.rar',bytes);
  assert.deepEqual(file.files.map(item=>item.name),names);
  assert.deepEqual(file.files.map(item=>item.html),content);
});

test('supports tabular TXT in an archive and ignores a plain README', async t => {
  const text='url2;anchor2\rhttps://example.com/?a=1,2;Exact anchor';
  const [item]=await preview(await normalize(t,'table.zip',zip([['README.txt','Plain instructions'],['tasks.txt',text]])));
  assert.deepEqual(item.links,[{url:'https://example.com/?a=1,2',anchor:'Exact anchor'}]);
});

test('an archived font license with quoted prose does not block the HTML upload', async t => {
  const html='<html lang="en-IN"><h1>Exact imported page</h1></html>';
  const license='Copyright The Font Project Authors\r\n\r\n"Font Software" refers to the files supplied with the font.';
  const input=zip([['index.html',html],['assets/font-license.txt',license]]);
  const [item]=await preview(await normalize(t,'aviator.zip',input,{mapColumns:()=>assert.fail('A license is not an import table')}));
  assert.equal(item.html,html);
  assert.equal(item.language,'en-in');
});

test('a malformed data row in a tabular TXT archive still blocks import', async t => {
  const table='file,slug\n"index.html"x,expected-slug';
  const input=zip([['index.html','<h1>Page</h1>'],['placement.txt',table]]);
  await assert.rejects(normalize(t,'bad.zip',input),/роздільник/);
});

test('automatic archive import maps unknown headers without sending rows or HTML to the mapper', async t => {
  const html='<h1>Exact private material</h1>';
  const archive=zip([['pages/landing.html',html],['placement.csv','Source asset,Requested path,Website to use,Password\npages/landing.html,exact-path,https://example.org/,private-fixture']]);
  let calls=0;
  const normalized=await normalize(t,'campaign.zip',archive,{mapColumns:async(headers,hasHtml)=>{
    calls++;
    assert.deepEqual(Array.from(headers),['Source asset','Requested path','Website to use','']);
    assert.equal(hasHtml,true);
    return ['file','slug','donor',''];
  }});
  assert.equal(calls,1);
  const [item]=await preview(normalized);
  assert.equal(item.html,html);
  assert.equal(item.slug,'exact-path');
  assert.equal(item.donor,'https://example.org/');
  assert.doesNotMatch(JSON.stringify(item),/private-fixture/);
});

test('automatic table imports do not drop unclassified donor or metric columns', async t => {
  const table='url,anchor,Donor URL:,DR >=\nhttps://example.com/,Exact,required.example,50';
  const [item]=await preview(await normalize(t,'project.csv',table,{mapColumns:async labels=>{
    assert.deepEqual(Array.from(labels),['url','anchor','Donor URL:','DR >=']);
    return ['url','anchor','donor','minDr'];
  }}));
  assert.equal(item.donor,'https://required.example/');
  assert.equal(item.siteSelection.minDr,50);
  await assert.rejects(normalize(t,'project.csv',table,{mapColumns:async()=>['url','anchor','','minDr']}),/не визначив/);
  await assert.rejects(normalize(t,'project.csv','url,anchor,Unknown $ column\nhttps://example.com/,Exact,value',{mapColumns:async()=>assert.fail('Unsafe labels must not reach the mapper')}),/колонка 3/);
});

test('normalizes two labeled TXT or Markdown tasks without guessing links or requirements', async t => {
  const brief = [
    '', '## Сторінка: Гід по покеру', '- ID: pl-guide', '- **Посилання:** https://example.com/?a=%2F&b=1,2',
    '- Анкор: Точний "анкор"', '- URL: https://example.org/guide#start', '- Анкор: Другий анкор',
    '- Мова: pl', '- Гео: PL', '- Формат: guide', '- Тема: poker', '- Мін. DR: 20', '- Трафік: 50',
    '', 'Page: German guide', 'URL: https://example.net/?campaign=one', 'Anchor: Exact anchor', 'Language: de', 'GEO: DE'
  ].join('\n');
  for (const name of ['Project.txt','Project.md']) {
    const [first,second] = await preview(await normalize(t,name,brief));
    assert.deepEqual(first.links,[
      {url:'https://example.com/?a=%2F&b=1,2',anchor:'Точний "анкор"'},
      {url:'https://example.org/guide#start',anchor:'Другий анкор'}
    ]);
    assert.deepEqual([first.key,first.title,first.language,first.geo],['pl-guide','Гід по покеру','pl','PL']);
    assert.deepEqual(first.siteSelection,{geo:'PL',minDr:20,minTraffic:50});
    assert.equal(first.editorial.format,'guide');
    assert.equal(first.editorial.topic,'poker');
    assert.deepEqual(second.provenance.source,{kind:'table',file:name,row:15});
    assert.equal(second.language,'de');
  }
});

test('normalizes a labeled Word brief and preserves the real hyperlink address', async t => {
  const paragraphs = [
    wordText('Сторінка: Огляд'), wordText('Посилання: ')+wordLink('Відкрити'),
    wordText('Анкор: Точний анкор'), wordText('Мова: pl'), wordText('Гео: PL')
  ].map(content=>'<w:p>'+content+'</w:p>').join('');
  const [item] = await preview(await normalize(t,'Project.docx',wordFile(paragraphs,'',wordRelation('https://example.com/?x=%2F&amp;y=2'))));
  assert.deepEqual(item.links,[{url:'https://example.com/?x=%2F&y=2',anchor:'Точний анкор'}]);
  assert.equal(item.provenance.source.row,1);
});

test('Word run elements with unsupported visible characters cannot alter a URL or anchor silently', async t => {
  const url=wordText('https://example.com/black')+'<w:r><w:noBreakHyphen/></w:r>'+wordText('friday');
  const paragraphs=[wordText('Page: Guide'),wordText('URL: ')+url,wordText('Anchor: Exact')].map(content=>'<w:p>'+content+'</w:p>').join('');
  await assert.rejects(normalize(t,'brief.docx',wordFile(paragraphs)),/спеціальні символи/);
  const rows=[['url','anchor'].map(wordText),[url,wordText('Exact')]];
  await assert.rejects(normalize(t,'table.docx',wordFile(wordTable(rows))),/спеціальні символи/);
});

test('applies brief metadata to packaged HTML without changing the material', async t => {
  const html='<h1>Exact source material</h1><a href="https://example.com/?a=%2F&amp;b=2">Exact anchor</a>';
  const brief='Page: Ready page\nFile: de-page.html\nLanguage: de\nGEO: DE\nTraffic: 30';
  const [item] = await preview(await normalize(t,'Project.zip',zip([['pages/de-page.html',html],['mapping.txt',brief]])));
  assert.equal(item.html,html);
  assert.deepEqual([item.title,item.language,item.geo,item.siteSelection.minTraffic],['Ready page','de','DE',30]);
  assert.equal(item.provenance.source.row,1);
});

test('rejects ambiguous or partial briefs and avoids leaking private field values', async t => {
  await assert.rejects(normalize(t,'missing.txt','Page: Test\nURL: https://example.com/'),/рядок 1.*пару/);
  await assert.rejects(normalize(t,'duplicate.txt','Page: Test\nGEO: PL\nGEO: DE\nURL: https://example.com/\nAnchor: A'),/рядок 3.*повтор/);
  await assert.rejects(normalize(t,'unknown.txt','Page: Test\nPassword: PRIVATE-VALUE\nURL: https://example.com/\nAnchor: A'),error=>{
    assert.match(error.message,/рядок 2.*поле/);
    assert.doesNotMatch(error.message,/PRIVATE-VALUE/);
    return true;
  });
  await assert.rejects(normalize(t,'mixed.txt','Page: AI\nURL: https://example.com/\nAnchor: A\nPage: HTML\nFile: page.html'),/Розділіть/);
  const combined=await preview(await normalize(t,'two-documents.zip',zip([
    ['first.txt','Page: Test\nURL: https://example.com/\nAnchor: A'],
    ['second.txt','Page: Another\nURL: https://example.net/\nAnchor: B']
  ])));
  assert.deepEqual(combined.map(item=>[item.title,item.provenance.source.file,item.provenance.source.row]),[
    ['Test','first.txt',1],['Another','second.txt',1]
  ]);
});

test('rejects ambiguous, malformed or unsupported inputs before queue preparation', async t => {
  await assert.rejects(normalize(t, 'broken.xlsx', xlsx({multiple:true})), /визначити аркуш/);
  await assert.rejects(normalize(t, 'formula.xlsx', xlsx({formula:true})), /формули/);
  await assert.rejects(normalize(t, 'broken.zip', zip([['../outside.html', '<h1>Unsafe</h1>']])), /шлях/);
  await assert.rejects(normalize(t, 'mixed.zip', zip([...pages, ['links.csv','url,anchor\nhttps://example.com/,Link']])), /зіставлення/);
  await assert.rejects(normalize(t, 'brief.pdf', '%PDF-1.7'), /Підтримуються/);
});

test('rejects unverifiable cached formulas and workbook errors in project rows',async t=>{
  const header='<row r="1"><c r="A1" t="str"><v>url</v></c><c r="B1" t="str"><v>anchor</v></c></row>';
  const url='<c r="A2" t="str"><v>https://example.org/</v></c>';
  for (const cell of [
    '<c r="B2" t="str"><f>TRIM(A2)</f></c>',
    '<c r="B2" t="e"><f>TRIM(A2)</f><v>#REF!</v></c>',
    '<c r="B2" t="str"><f>\'[External.xlsx]Sheet 1\'!A1</f><v>Exact</v></c>',
    '<c r="B2" t="str"><f>HYPERLINK(A2,"Exact")</f><v>Exact</v></c>',
    '<c r="B2" t="str"><f t="shared" si="0"/><v>Exact</v></c>'
  ]) await assert.rejects(normalize(t,'formulas.xlsx',workbook([header+'<row r="2">'+url+cell+'</row>'])),/формули/);
});

test('rejects competing archive rows and ambiguous HTML ownership',async t=>{
  const html=['nested/page.html','<h1>Nested</h1>'];
  await assert.rejects(normalize(t,'duplicate.zip',zip([html,
    ['first.csv','file,slug\nnested/page.html,one'],
    ['second.csv','file,slug\npage.html,two']
  ])),/повторюється/);
  await assert.rejects(normalize(t,'ambiguous.zip',zip([html,['other/page.html','<h1>Other</h1>'],
    ['map.csv','file,slug\npage.html,exact']
  ])),/неоднозначно/);
  await assert.rejects(normalize(t,'duplicate-task.zip',zip([
    ['first.csv','id,url,anchor\nsame,https://example.org/,First'],
    ['second.csv','key,url,anchor\nsame,https://example.net/,Second']
  ])),/однаковий ID/);
});

test('card-count aliases expand project links with repeats and preserve their order',async t=>{
  const table='url,anchor,url2,anchor2,кількість карток\nhttps://example.org/,First,https://example.net/,Second,5';
  const [item]=await preview(await normalize(t,'cards.csv',table));
  assert.deepEqual(item.links.map(link=>link.anchor),['First','Second','First','Second','First']);
});

const xlsxText=(address,value)=>'<c r="'+address+'" t="inlineStr"><is><t>'+value+'</t></is></c>';
const xlsxTaskHeader='<row r="1">'+xlsxText('A1','url')+xlsxText('B1','anchor');
const xlsxTaskRow='<row r="9">'+xlsxText('A9','https://example.org/')+xlsxText('B9','Exact')+'</row>';

test('XLSX coordinates use the physical sheet index when earlier sheets are hidden',async t=>{
 const source=workbook(['',xlsxTaskHeader+'</row>'+xlsxTaskRow],[0]);
 const [item]=await preview(await normalize(t,'tasks.xlsx',source));
 assert.equal(item.provenance.source.sheet,1);
});

test('archive rejects same-named source tables that cannot retain distinct provenance',async t=>{
 const source=zip([
  ['a/tasks.csv','url,anchor\nhttps://example.org/,First'],
  ['b/tasks.csv','url,anchor\nhttps://example.net/,Second']
 ]);
 await assert.rejects(normalize(t,'tasks.zip',source),/назвою таблиці/);
});

test('XLSX discards rows containing only ignored columns without moving task coordinates',async t=>{
 const worksheet=xlsxTaskHeader+xlsxText('C1','Notes')+'</row>'+
  '<row r="2">'+xlsxText('C2','An internal note')+'</row>'+xlsxTaskRow;
 const mapColumns=async()=>['url','anchor',''];
 for(const worksheets of [[worksheet],[worksheet,xlsxTaskHeader+'</row>'+xlsxTaskRow.replace('example.org','example.net')]]){
  const items=await preview(await normalize(t,'tasks.xlsx',workbook(worksheets),{mapColumns}));
  assert.deepEqual(items.map(item=>item.provenance.source.row),worksheets.map(()=>9));
 }
});

test('XLSX rejects cached formulas containing unrecognized Unicode functions',async t=>{
 const row='<row r="2">'+xlsxText('A2','https://example.org/')+
  '<c r="B2" t="str"><f>IF(TRUE;Обчислити(A2);"" )</f><v>Exact</v></c></row>';
 await assert.rejects(normalize(t,'tasks.xlsx',workbook([xlsxTaskHeader+'</row>'+row])),/формули/);
});

test('automatic archive admission keeps custom task headings regardless of the single table basename',async t=>{
 const header='Source asset,Requested path,Website to use,Password';
 for(const name of ['instructions.csv','custom-schema.csv']){
  let calls=0;
  const archive=zip([['landing.html','<h1>Content</h1>'],[name,header+'\nlanding.html,exact-path,https://example.org/,secret']]);
  const [item]=await preview(await normalize(t,'campaign.zip',archive,{mapColumns:async labels=>{
   calls++;
   assert.deepEqual(Array.from(labels),['Source asset','Requested path','Website to use','']);
   return ['file','slug','donor',''];
  }}));
  assert.equal(calls,1);
  assert.deepEqual([item.slug,item.donor],['exact-path','https://example.org/']);
 }
});

test('multiple unknown archive tables distinguish HTML instructions from unrelated notes',async t=>{
 const archive=zip([['landing.html','<h1>Content</h1>'],['random.csv','Source asset,Requested path\nlanding.html,exact-path'],
  ['notes.csv','Activity,Owner\nReview,Writer']]);
 const [item]=await preview(await normalize(t,'campaign.zip',archive,{mapColumns:async labels=>{
  assert.deepEqual(Array.from(labels),['Source asset','Requested path']);
  return ['file','slug'];
 }}));
 assert.equal(item.slug,'exact-path');
});

test('archive refuses to silently apply HTML defaults when a table supplies a slug or donor without ownership',async t=>{
 const archive=zip([['landing.html','<h1>Content</h1>'],['notes.csv','title,notes\nMeeting,Follow-up'],
  ['pages.csv','slug,donor\nexact-path,example.org']]);
 await assert.rejects(normalize(t,'campaign.zip',archive),/зіставлення.*file/);
});
