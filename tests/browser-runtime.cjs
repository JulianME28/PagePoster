'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolvePlaywright() {
  const explicit = process.env.PAGEPOSTER_PLAYWRIGHT_MODULE;
  const cached = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  for (const candidate of explicit ? [explicit] : ['playwright', cached]) {
    try {
      const resolved = require.resolve(/^\.{1,2}[\\/]/.test(candidate) ? path.resolve(candidate) : candidate);
      if (require(resolved).chromium?.launch) return resolved;
    } catch {}
  }
  return '';
}

function resolveChrome(playwrightPath) {
  const explicit = process.env.PAGEPOSTER_CHROME;
  if (explicit) return path.resolve(explicit);

  let bundled;
  if (playwrightPath) {
    try { bundled = require(playwrightPath).chromium.executablePath(); } catch {}
  }
  const installed = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean).map(directory => path.join(directory, 'Google/Chrome/Application/chrome.exe'));
  const candidates = [bundled, ...installed, '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find(candidate => {
    try { return candidate && fs.statSync(candidate).isFile(); } catch { return false; }
  }) || '';
}

const playwrightPath = resolvePlaywright();
const chromePath = resolveChrome(playwrightPath);

module.exports = {
  playwrightPath,
  chromePath,
  get playwright() {
    if (!playwrightPath) throw Error('Browser tests require Playwright. Run pnpm install or set PAGEPOSTER_PLAYWRIGHT_MODULE.');
    return require(playwrightPath);
  }
};
