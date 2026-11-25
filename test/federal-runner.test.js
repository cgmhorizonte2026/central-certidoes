const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runFederal } = require('../automation/federalRunner');
const url = 'https://servicos.receitafederal.gov.br/servico/certidoes/';
const cnpj = '00000000000191';
async function fixture(t, html, manual, json = false, pdfText = '<h1>Receita Federal Certidão Negativa</h1><p>CNPJ 00.000.000/0001-91</p>', wakeOnPdf = false) {
  const browser = await require('../automation/launch').launchBrowser(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'federal-runner-'));
  t.after(async () => { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const context = await browser.newContext({ acceptDownloads: true });
  const printer = await context.newPage();
  await printer.setContent(pdfText);
  const pdf = await printer.pdf(); await printer.close();
  await context.route('**/*', route => route.request().url().includes('/pdf')
    ? route.fulfill(json ? { contentType: 'application/json', body: JSON.stringify({ documento: pdf.toString('base64') }) }
      : { contentType: 'application/pdf', headers: { 'content-disposition': 'attachment; filename=certidao.pdf' }, body: pdf })
    : route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  let page, waits = 0, resume;
  const manager = { newPortalPage: async () => page = await context.newPage(), abortable: p => p,
    resume: () => resume?.(),
    waitForHumanResume: async message => {
      waits++; if (!manual || waits > 3) throw Error('Unexpected manual wait: ' + message);
      const wake = wakeOnPdf ? new Promise(resolve => resume = resolve) : Promise.resolve();
      await manual(page, message); await wake;
    } };
  const result = await runFederal({ portal: { key: 'federal', name: 'Federal', url }, cnpj, browser: manager, baseDir: root, emit: () => {}, timing: { responseMs: 2000, pollMs: 50 } });
  assert.equal(result.provenance.officialPortal, true);
  assert.deepEqual(fs.readFileSync(result.filePath), pdf);
  return { page, waits, result };
}
const form = '<input name="niContribuinte"><button onclick="window.emissions=(window.emissions||0)+1;fetch(\'/pdf\')">Emitir Certidão</button>';
test('federal captures an immediate JSON PDF on the first click, without duplicate issuance', async t => {
  const { page, waits } = await fixture(t, form, null, true);
  assert.equal(await page.evaluate(() => window.emissions), 1); assert.equal(waits, 0);
});
test('federal does not click or scroll behind an unknown modal; captures manual download', async t => {
  const { page, waits } = await fixture(t, form + '<div role="dialog" style="position:fixed;inset:0;background:white">Confirmação não reconhecida<button onclick="location.href=\'/pdf\'">Baixar manualmente</button></div>',
    async (page, message) => { assert.match(message, /janela do portal/); assert.equal(await page.evaluate(() => window.emissions || 0), 0); await page.getByText('Baixar manualmente', { exact: true }).click(); await page.waitForTimeout(300); });
  assert.equal(waits, 1); assert.equal(await page.evaluate(() => window.emissions || 0), 0);
});
test('federal accepts the cookie overlay before filling or issuing', async t => {
  const html = form + '<div id="card0" style="position:fixed;inset:0;background:white">Utilizamos cookies<button onclick="this.parentElement.remove()">Aceitar</button></div>';
  const { page } = await fixture(t, html, null, true);
  assert.equal(await page.locator('#card0').count(), 0); assert.equal(await page.evaluate(() => window.emissions), 1);
});
test('federal error pauses for human action and never resubmits the underlying form', async t => {
  const html = '<input name="niContribuinte"><button onclick="window.emissions=(window.emissions||0)+1;document.body.insertAdjacentHTML(\'beforeend\',\'<div role=dialog>Mensagem de Erro 105 - 25/11/2026</div>\')">Emitir Certidão</button>';
  const { page, waits } = await fixture(t, html, async (page, message) => {
    assert.match(message, /erro ou uma verificação/);
    await page.evaluate(() => { document.querySelector('[role=dialog]').remove(); fetch('/pdf'); }); await page.waitForTimeout(300);
  }, true);
  assert.equal(waits, 1); assert.equal(await page.evaluate(() => window.emissions), 1);
});
test('federal retrieves the existing certificate through its modal and search without clicking the background button', async t => {
  const html = `<input name="niContribuinte"><button onclick="window.wrong=true">Consultar Certidão</button>
    <button onclick="document.querySelector('dialog').showModal()">Emitir Certidão</button>
    <dialog><h2>Certidão Válida Encontrada</h2><button onclick="this.parentElement.close();location.hash='/home/cnpj/consultar';document.querySelector('main').hidden=false;document.querySelector('body>button').remove()">Consultar Certidão</button></dialog>
    <main hidden><p>CNPJ 00.000.000/0001-91</p><label>Data Inicial<input value="01/01/2026"></label><label>Data Final<input value="31/12/2026"></label>
    <button onclick="location.hash='/home/cnpj/consultar/resultado';document.querySelector('table').hidden=false;this.remove()">Consultar Certidão</button>
    <table hidden><tr><td>Válida</td><td>31/12/2099</td><td><button title="Segunda via" onclick="window.copies=(window.copies||0)+1;fetch('/pdf')">Baixar</button></td></tr></table></main>`;
  const { page, waits } = await fixture(t, html, null, true);
  assert.equal(waits, 0); assert.equal(await page.evaluate(() => window.copies), 1); assert.equal(await page.evaluate(() => !!window.wrong), false);
});
test('federal confirms a renewal only inside its modal and only once', async t => {
  const html = `<input name="niContribuinte"><button onclick="document.querySelector('dialog').showModal()">Emitir Certidão</button>
    <dialog><p>Já existe uma certidão válida.</p><button onclick="window.renewals=(window.renewals||0)+1;fetch('/pdf')">Emitir nova certidão</button></dialog>`;
  const { page } = await fixture(t, html, null, true);
  assert.equal(await page.evaluate(() => window.renewals), 1);
});
test('federal rejects another municipality PDF even when returned by the current official page', async t => {
  await assert.rejects(fixture(t, form, async () => { throw Error('NO_VALID_PDF'); }, true,
    '<h1>Prefeitura Municipal Certidão Negativa de Débitos Municipais</h1><p>CNPJ 00.000.000/0001-91</p>'), /NO_VALID_PDF/);
});
test('federal automatically resumes when a PDF arrives during manual assistance', { timeout: 20000 }, async t => {
  const { waits } = await fixture(t, '<div role="dialog">Conferência manual</div>', async page => {
    await page.evaluate(() => { fetch('/pdf'); });
  }, true, undefined, true);
  assert.equal(waits, 1);
});
test('Stop interrupts the federal manual wait and cannot archive a late result', async t => {
  const chrome = await require('../automation/launch').launchBrowser(true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'federal-stop-'));
  const context = await chrome.newContext();
  t.after(async () => { await chrome.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await context.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<div role="dialog">Verificação manual</div>' }));
  const { BrowserManager } = require('../automation/browser');
  let resolveWait; const waiting = new Promise(resolve => resolveWait = resolve);
  const manager = new BrowserManager(e => { if (e.type === 'human_action_required') resolveWait(); });
  manager.newPortalPage = async () => { const page = await context.newPage(); manager.own(page); return page; };
  const running = require('../automation/cancellation').withCancellation(manager.signal, () => runFederal({ portal: { key: 'federal', url }, cnpj, browser: manager, baseDir: root, emit: () => {} }));
  const rejected = assert.rejects(running, e => e.code === 'SESSION_CANCELLED');
  await waiting; await manager.close(); await rejected;
  assert.equal(fs.existsSync(path.join(root, 'data', 'certidoes')), false);
});
