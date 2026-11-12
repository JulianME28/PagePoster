'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {crc32} = require('node:zlib');
const {archivePath} = require('../dist/html-package.js');

const run = promisify(execFile);
const maxBytes = 20 * 1024 * 1024;
const rar4 = Buffer.from('526172211a0700', 'hex');
const rar5 = Buffer.from('526172211a070100', 'hex');

// RAR5 block layout: https://www.rarlab.com/technote.htm
// Validate metadata before UnRAR sees it. Its stdout is the concatenated file data.
function listRar5(archive) {
  const entries = [], names = new Set(), decoder = new TextDecoder('utf-8', {fatal: true});
  const invalid = () => Error('Пошкоджений або непідтримуваний заголовок RAR5.');
  let cursor = rar5.length, total = 0, mainSeen = false, blocks = 0;
  function vint(limit) {
    let value = 0;
    for (let shift = 0; shift <= 42 && cursor < limit; shift += 7) {
      const byte = archive[cursor++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw invalid();
  }
  function uint32(limit) {
    if (cursor + 4 > limit) throw invalid();
    const value = archive.readUInt32LE(cursor);
    cursor += 4;
    return value;
  }
  while (cursor < archive.length && ++blocks <= 4096) {
    const checksum = uint32(archive.length), headerStart = cursor;
    const headerSize = vint(Math.min(archive.length, cursor + 3));
    const headerEnd = cursor + headerSize;
    if (headerEnd > archive.length || crc32(archive.subarray(headerStart, headerEnd)) !== checksum) throw invalid();
    const type = vint(headerEnd), flags = vint(headerEnd);
    const extraSize = flags & 1 ? vint(headerEnd) : 0;
    const packedSize = flags & 2 ? vint(headerEnd) : 0;
    const extraStart = headerEnd - extraSize, next = headerEnd + packedSize;
    if (cursor > extraStart || next > archive.length || flags > 127 || flags & 24) throw invalid();
    if (type === 4) throw Error('Зашифровані RAR не підтримуються.');
    if (type === 1) {
      if (mainSeen || blocks !== 1 || packedSize || vint(extraStart) & 1) throw Error('Багатотомні або пошкоджені RAR не підтримуються.');
      mainSeen = true;
    } else if (!mainSeen) throw invalid();
    else if (type === 2) {
      const fileFlags = vint(extraStart), size = vint(extraStart), attributes = vint(extraStart);
      const directory = !!(fileFlags & 1);
      if (fileFlags > 15 || fileFlags & 8 || directory && (size || packedSize)) throw invalid();
      if (fileFlags & 2) uint32(extraStart);
      const crc = fileFlags & 4 ? uint32(extraStart) : null;
      const compression = vint(extraStart), host = vint(extraStart), nameSize = vint(extraStart);
      const dictionary = 128 * 1024 * 2 ** ((compression >>> 10) & 31) * (1 + ((compression >>> 15) & 31) / 32);
      if (compression > 0x1fffff || dictionary > 64 * 1024 * 1024 || host > 1 || cursor + nameSize !== extraStart) throw invalid();
      const kind = attributes & 0xf000;
      if (host === 1 && kind && kind !== (directory ? 0x4000 : 0x8000)) throw Error('RAR може містити лише звичайні файли й теки.');
      const name = archivePath(decoder.decode(archive.subarray(cursor, extraStart)), directory);
      const key = name.normalize('NFC').toLowerCase();
      if (names.has(key) || names.size >= 512) throw Error('У RAR є дублікати або понад 512 записів.');
      names.add(key);
      cursor = extraStart;
      while (cursor < headerEnd) {
        const recordSize = vint(headerEnd), recordEnd = cursor + recordSize;
        if (!recordSize || recordEnd > headerEnd) throw invalid();
        const recordType = vint(recordEnd);
        if ([1, 4, 5].includes(recordType)) throw Error('RAR із паролем, версіями файлів або посиланнями не підтримується.');
        cursor = recordEnd;
      }
      total += size;
      if (total > maxBytes || size && (!packedSize || size / packedSize > 200)) throw Error('RAR перевищує ліміт 20 МБ або коефіцієнта стиснення.');
      if (!directory) entries.push({name, size, crc});
    } else if (type === 5) {
      if (packedSize || vint(extraStart) & 1 || next !== archive.length) throw invalid();
      return entries;
    } else if (type !== 3) throw invalid();
    cursor = next;
  }
  throw invalid();
}

async function unrar5(archive, filename, signal) {
  const files = listRar5(archive);
  const candidates = [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean);
  let executable;
  for (const folder of new Set(candidates)) {
    const candidate = path.join(folder, 'WinRAR', 'UnRAR.exe');
    try { await fs.access(candidate); executable = candidate; break; } catch {}
  }
  if (!executable) throw Error('Для RAR5 потрібен установлений WinRAR. Можна зберегти пакет у ZIP.');
  let output;
  try {
    output = await run(executable, ['p', '-cfg-', '-p-', '-inul', '--', filename], {
      encoding: 'buffer', maxBuffer: maxBytes + 1024, timeout: 15000, windowsHide: true, signal
    });
  } catch {
    throw Error('Не вдалося прочитати RAR5. Перевірте цілісність архіву та версію WinRAR.');
  }
  if (output.stderr.length || output.stdout.length !== files.reduce((sum, file) => sum + file.size, 0)) throw Error('RAR5 прочитано не повністю.');
  let offset = 0;
  return files.map(({name, size, crc}) => {
    const bytes = output.stdout.subarray(offset, offset + size);
    offset += size;
    if (crc !== null && crc32(bytes) !== crc) throw Error('Контрольна сума файла в RAR5 не збігається.');
    return {name, bytes: Uint8Array.from(bytes)};
  });
}

function parseEntries(tar) {
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const entries = [], names = new Set();
  let total = 0;
  function field(start, end) {
    const bytes = tar.subarray(start, end);
    const zero = bytes.indexOf(0);
    return decoder.decode(zero === -1 ? bytes : bytes.subarray(0, zero));
  }
  for (let offset = 0; offset + 512 <= tar.length;) {
    if (tar.subarray(offset, offset + 512).every(byte => byte === 0)) {
      if (tar.length - offset >= 1024 && tar.subarray(offset).every(byte => byte === 0)) return entries;
      break;
    }
    const type = tar[offset + 156];
    const directory = type === 53;
    if (field(offset + 257, offset + 263) !== 'ustar' || ![0, 48, 53].includes(type)) throw Error('RAR може містити лише звичайні файли й теки.');
    const prefix = field(offset + 345, offset + 500);
    const name = archivePath((prefix ? prefix + '/' : '') + field(offset, offset + 100), directory);
    const key = name.normalize('NFC').toLowerCase();
    if (names.has(key) || names.size >= 512) throw Error('У RAR є дублікати або понад 512 записів.');
    names.add(key);
    const rawSize = field(offset + 124, offset + 136).trim();
    if (!/^[0-7]+$/.test(rawSize)) break;
    const size = Number.parseInt(rawSize, 8);
    const start = offset + 512;
    offset = start + Math.ceil(size / 512) * 512;
    total += size;
    if (total > maxBytes) throw Error('Розпакований RAR перевищує 20 МБ.');
    if (offset > tar.length || directory && size) break;
    if (!directory) entries.push({name, bytes: Uint8Array.from(tar.subarray(start, start + size))});
  }
  throw Error('Пошкоджена структура RAR.');
}

async function readProjectRar(bytes, {signal} = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length > maxBytes) throw Error('RAR має бути не більшим за 20 МБ.');
  const archive = Buffer.from(bytes);
  const isRar5 = archive.subarray(0, rar5.length).equals(rar5);
  if (!archive.subarray(0, rar4.length).equals(rar4) && !isRar5) throw Error('Файл не має заголовка RAR.');
  if (process.platform !== 'win32') throw Error('Читання RAR доступне в PagePoster для Windows.');
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pageposter-rar-'));
  const filename = path.join(directory, 'input.rar');
  try {
    await fs.writeFile(filename, archive, {flag: 'wx', signal});
    if (isRar5) return await unrar5(archive, filename, signal);
    let output;
    try {
      // Libarchive writes a bounded stream to stdout. Archive paths never reach the filesystem.
      output = await run(executable, ['-cf', '-', '--format', 'ustar', '@' + filename], {
        encoding: 'buffer', maxBuffer: maxBytes + 1024 * 1024, timeout: 15000, windowsHide: true, signal
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('У Windows не знайдено tar.exe. Збережіть пакет у ZIP.');
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.killed) throw Error('RAR перевищив ліміт розміру або часу читання.');
      throw Error('Не вдалося прочитати RAR. Перевірте, що архів цілий, без пароля й усі файли в одному томі.');
    }
    // USTAR can skip a path with a warning and still return exit code 0.
    if (output.stderr.toString().trim()) throw Error('RAR прочитано не повністю. Скоротіть довгі назви файлів або збережіть пакет у ZIP.');
    return parseEntries(output.stdout);
  } finally {
    await fs.unlink(filename).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
  }
}

module.exports = {readProjectRar};
