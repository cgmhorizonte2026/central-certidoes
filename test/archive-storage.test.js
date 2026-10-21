const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareArchiveStorage, ensureCompanyArchiveDirectory } = require('../lib/archive-storage');

test('archive storage falls back when the configured root cannot be created', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'central-storage-'));
  try {
    const blockedRoot = path.join(temp, 'not-a-directory');
    fs.writeFileSync(blockedRoot, 'blocks child directories');
    const fallbackRoot = path.join(temp, 'fallback');
    const storage = prepareArchiveStorage(blockedRoot, [fallbackRoot]);
    assert.equal(storage.root, fallbackRoot);
    assert.ok(fs.existsSync(storage.certs));
    assert.ok(fs.existsSync(storage.index));
    const pdf = path.join(storage.certs, 'sample.pdf');
    fs.writeFileSync(pdf, '%PDF-1.7 fixture');
    assert.equal(fs.readFileSync(pdf, 'utf8'), '%PDF-1.7 fixture');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test('a company-specific folder failure falls back without dropping the captured PDF', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'central-company-storage-'));
  try {
    const primary = path.join(temp, 'primary');
    const fallback = path.join(temp, 'fallback');
    const ready = prepareArchiveStorage(primary, [fallback]);
    const blockedCompanyPath = path.join(ready.certs, '12345678000199');
    fs.writeFileSync(blockedCompanyPath, 'blocks the date directory');
    const result = ensureCompanyArchiveDirectory(primary, [fallback], '12345678000199', '2026-10-19');
    assert.equal(result.root, fallback);
    const pdf = path.join(result.destination, 'certificate.pdf');
    fs.writeFileSync(pdf, '%PDF-1.7 fixture');
    assert.equal(fs.readFileSync(pdf, 'utf8'), '%PDF-1.7 fixture');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
