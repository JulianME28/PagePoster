(function (root) {
  'use strict';
  const excelSeparator = /^\uFEFF?sep=([,;\t])(?:\r\n|\r|\n)/i;
  function delimiterOf(text) {
    const directive = excelSeparator.exec(text);
    if (directive) return directive[1];
    const separators = new Set();
    let quoted = false;
    for (const character of text) {
      if (character === '"') quoted = !quoted;
      if (quoted) continue;
      if (character === '\r' || character === '\n') break;
      if (character === '\t' || character === ',' || character === ';') separators.add(character);
    }
    return ['\t', ',', ';'].find(separator => separators.has(separator)) || ',';
  }

  function read(text, {headerOnly = false, maxRows = 1002, onLimit = () => { throw Error('Забагато рядків у таблиці.'); }} = {}) {
    const delimiter = delimiterOf(text), rows = [];
    text = text.replace(excelSeparator, '');
    text = text.replace(/^\uFEFF/, '');
    let cells = [], cell = '', quoted = false, closed = false;
    const finishCell = () => { cells.push(cell); cell = ''; closed = false; };
    const finishRow = () => {
      finishCell();
      rows.push(cells);
      cells = [];
      if (rows.length > maxRows) onLimit();
    };
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (character !== '"') cell += character;
        else if (text[index + 1] === '"') { cell += character; index++; }
        else { quoted = false; closed = true; }
        continue;
      }
      if (character === '"') {
        // Pasted TSV can contain literal JSON and HTML in unquoted cells.
        if (delimiter === '\t' && cell && !closed) { cell += character; continue; }
        if (cell || closed) throw Error('Некоректні лапки в таблиці.');
        quoted = true;
        continue;
      }
      if (character === delimiter) { finishCell(); continue; }
      if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index++;
        finishRow();
        if (headerOnly) return rows;
        continue;
      }
      if (closed) throw Error('Після закривальних лапок має бути роздільник або кінець рядка.');
      cell += character;
    }
    if (quoted) throw Error('У таблиці не закрито лапки.');
    if (cell || cells.length || closed) finishRow();
    return rows;
  }

  const api = Object.freeze({delimiterOf, read});
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PagePosterProjectTable = api;
}(globalThis));
