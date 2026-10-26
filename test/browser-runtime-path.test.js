const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('BrowserManager configures the bundled Playwright browser before loading Playwright', () => {
  const root = path.resolve(__dirname, '..');
  const script = [
    "require('./automation/browser');",
    "const path=require('node:path');",
    "const expected=path.resolve('.runtime','browsers');",
    "const actual=path.relative(process.cwd(),process.env.PLAYWRIGHT_BROWSERS_PATH);",
    "if(path.resolve(actual)!==expected)process.exit(2);",
    "const {chromium}=require('playwright');",
    "if(!chromium.executablePath().startsWith(path.resolve(expected)+path.sep))process.exit(3);"
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '' }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
