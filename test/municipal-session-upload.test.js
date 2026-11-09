const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launchBrowser } = require('../automation/launch');
const { app, sessions, sessionRegistry } = require('../server');

test('municipal session accepts a human-validated PDF with matching company and authentication code', async () => {
  const browser = await launchBrowser(true);
  const page = await browser.newPage();
  await page.setContent('<h1>Prefeitura Municipal — Certidão Negativa de Tributos Municipais</h1><p>CNPJ: 00.000.000/0001-91</p><p>Código de autenticação: ABCD-2026-XYZ</p><p>Validade: 31/12/2026</p>');
  const pdf = await page.pdf({ format: 'A4' });
  await browser.close();

  const id = `manual-upload-test-${process.pid}-${Date.now()}`;
  let accepted = null;
  const session = {
    id, cnpj: '00000000000191', currentPortal: 'municipal', status: 'running', events: [],
    browserManager: { acceptManualMunicipalPdf: async value => { accepted = value; return true; } }
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  assert.equal(sessionRegistry.reserve(session), true);
  const port = server.address().port;
  const logFile = path.join(__dirname, '..', 'data', 'logs', `${id}.jsonl`);
  try {
    let response = await fetch(`http://127.0.0.1:${port}/api/session/${id}/municipal-pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Certificate-Code': 'ABCD-2026-XYZ' }, body: pdf
    });
    assert.equal(response.status, 403, 'a human confirmation is required before upload');
    response = await fetch(`http://127.0.0.1:${port}/api/session/${id}/municipal-pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Certificate-Code': 'WRONG-CODE', 'X-Official-Validation': 'confirmed' }, body: pdf
    });
    assert.equal(response.status, 422, 'the supplied code must occur in the PDF');
    assert.equal(accepted, null, 'unverified uploads must not reach the active session');
    response = await fetch(`http://127.0.0.1:${port}/api/session/${id}/municipal-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Certificate-Code': 'ABCD-2026-XYZ', 'X-Official-Validation': 'confirmed' },
      body: pdf
    });
    const body = await response.json();
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(accepted.code, 'ABCD2026XYZ');
    assert.equal(accepted.buffer.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(session.events.some(event => event.type === 'manual_municipal_pdf_accepted'));
  } finally {
    sessionRegistry.release(id);
    sessions.delete(id);
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(logFile, { force: true }); } catch {}
  }
});
