'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function resolvePHP56() {
  const explicit = process.env.PAGEPOSTER_PHP56;
  const cached = path.resolve(__dirname, '../../../deliverables/link-cleaner-qa/php56/php.exe');
  for (const command of explicit ? [path.resolve(explicit)] : ['php', cached]) {
    const result = spawnSync(command, ['-n', '-r', 'echo PHP_VERSION_ID;'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    const version = Number(result.stdout);
    if (result.status === 0 && version >= 50600 && version < 50700) return command;
  }
  return '';
}

async function createPHP() {
  const { PHP, loadPHPRuntime } = require('@php-wasm/universal');
  const { getPHPLoaderModule } = require('@php-wasm/node-8-4');
  const base = path.dirname(require.resolve('@php-wasm/node-8-4'));
  const loader = await getPHPLoaderModule();
  const mode = loader.phpWasmAsyncMode || 'asyncify';
  return new PHP(await loadPHPRuntime(loader, {
    locateFile: file => path.isAbsolute(file) ? file : path.join(base, mode, file)
  }));
}

module.exports = { resolvePHP56, createPHP };
