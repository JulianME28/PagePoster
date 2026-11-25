'use strict';
const {crc32, deflateRawSync} = require('node:zlib');

function zip(entries) {
  const files = [], directory = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(value), compressed = deflateRawSync(data);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 10); local.copy(central, 16, 14, 28);
    central.writeUInt32LE(offset, 42);
    files.push(local, filename, compressed); directory.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const catalog = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(catalog.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, catalog, end]);
}

function rar(entries) {
  function block(type, size, flags = 0) {
    const header = Buffer.alloc(size);
    header[2] = type; header.writeUInt16LE(flags, 3); header.writeUInt16LE(size, 5);
    return header;
  }
  function seal(header) { header.writeUInt16LE(crc32(header.subarray(2)) & 0xffff); return header; }
  const parts = [Buffer.from('526172211a0700', 'hex'), seal(block(0x73, 13))];
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(value);
    const header = block(0x74, 32 + filename.length, 0x8000);
    header.writeUInt32LE(data.length, 7); header.writeUInt32LE(data.length, 11);
    header[15] = 2; header.writeUInt32LE(crc32(data), 16);
    header[24] = 20; header[25] = 0x30; header.writeUInt16LE(filename.length, 26);
    header.writeUInt32LE(0x20, 28); filename.copy(header, 32);
    parts.push(seal(header), data);
  }
  parts.push(seal(block(0x7b, 7)));
  return Buffer.concat(parts);
}

function xlsx({formula = false, multiple = false} = {}) {
  return zip([
    ['xl/workbook.xml', `<workbook xmlns:r="urn:relationships"><sheets><sheet name="Pages" r:id="rId1"/>${multiple ? '<sheet name="Other" r:id="rId2"/>' : ''}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="urn:office/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', '<sst><si><t>Посилання</t></si><si><t>Анкор</t></si><si><t>https://example.com/?a=%2F&amp;b=2</t></si><si><r><t>Exact </t></r><r><t>anchor</t></r></si></sst>'],
    ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Гео</t></is></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s">${formula ? '<f>UNTRUSTED()</f>' : ''}<v>3</v></c><c r="C2" t="inlineStr"><is><t>NZ</t></is></c></row></sheetData></worksheet>`]
  ]);
}

const pages = [
  ['pages/nz-guide.html', '<!doctype html><html lang="en-NZ"><head><link rel="stylesheet" href="../assets/main.css"></head><body><h1>New Zealand</h1></body></html>'],
  ['pages/pl-guide.html', '<!doctype html><html lang="pl"><head><link rel="stylesheet" href="../assets/main.css"></head><body><h1>Polska</h1></body></html>'],
  ['assets/main.css', 'h1 { color: #102030; }']
];

function linkedDocx() {
  const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const text = value => '<w:r><w:t>' + value + '</w:t></w:r>';
  const table = [
    ['Назва','Посилання','Анкор','Гео'].map(text),
    [text('Word Page'), '<w:hyperlink r:id="rId1">' + text('Відкрити') + '</w:hyperlink>', text('Exact anchor'), text('PL')]
  ].map(row => '<w:tr>' + row.map(cell => '<w:tc><w:p>' + cell + '</w:p></w:tc>').join('') + '</w:tr>').join('');
  return zip([
    ['word/document.xml', '<w:document xmlns:w="' + word + '" xmlns:r="' + office + '"><w:body><w:tbl>' + table + '</w:tbl></w:body></w:document>'],
    ['word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="' + office + '/hyperlink" TargetMode="External" Target="https://example.com/?x=%2F&amp;y=2"/></Relationships>']
  ]);
}

module.exports = {zip, rar, xlsx, pages, linkedDocx};
