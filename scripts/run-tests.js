const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDir = path.join(__dirname, '..', 'test');
const bundledBrowsers = path.join(__dirname, '..', '.runtime', 'browsers');
if (fs.existsSync(bundledBrowsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
const files = fs.readdirSync(testDir)
  .filter(name => name.endsWith('.test.js'))
  .sort();

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', path.join(testDir, file)], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Não foi possível executar ${file}: ${result.error.message}`);
    failed++;
  } else if (result.status !== 0) {
    failed++;
  }
}

console.log(`\nResultado: ${files.length - failed}/${files.length} arquivos de teste passaram.`);
process.exitCode = failed ? 1 : 0;
