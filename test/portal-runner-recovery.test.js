const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(__dirname, '..', '.runtime', 'browsers');
const { chromium } = require('playwright');
const { runPortal, classifyStateCePortalError } = require('../automation/portalRunner');
const { municipalPortal } = require('../config/portalResolver');

test('SEFAZ Ceará pendency response is classified as an official result, not unknown state', () => {
  const result = classifyStateCePortalError('Não foi possível emitir o documento solicitado, consultar pendências no site. Acesse: portaldocontribuinte.pge.ce.gov.br');
  assert.equal(result.category, 'PORTAL_SOLICITA_CONSULTA_DE_PENDENCIAS');
  assert.match(result.message, /Portal do Contribuinte da PGE/);
  assert.equal(classifyStateCePortalError('Certidão negativa emitida com sucesso'), null);
});

test('municipal portal leaves issuance to the user and archives the official reprint PDF', async () => {
  const browser = await chromium.launch({ headless: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-fortaleza-reprint-'));
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const pdfPage = await context.newPage();
    await pdfPage.setContent('<h1>CERTIDÃO MUNICIPAL FICTÍCIA PARA TESTE</h1><p>Reimpressão oficial</p>');
    const pdf = await pdfPage.pdf();
    await pdfPage.close();
    await context.route('https://grpfordam.sefin.fortaleza.ce.gov.br/**', async route => {
      if (route.request().url().endsWith('/certidao.pdf')) {
        return route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'content-disposition': 'attachment; filename="certidao.pdf"' }, body: pdf });
      }
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<h1>CERTIDÃO NEGATIVA DE DÉBITOS DE TRIBUTOS MUNICIPAIS</h1>
          <form id="lookup" onsubmit="event.preventDefault();document.querySelector('#modalReimpressaoForm').hidden=false">
            <input id="cnpj" name="cnpj"><button type="submit">Emitir</button>
          </form>
          <form id="modalReimpressaoForm" hidden>
            <p>Existe uma certidão municipal válida até 04/01/2027. Deseja reimprimir?</p>
            <button type="button" onclick="location.href='/certidao.pdf'">Reimprimir Certidão</button>
          </form>`
      });
    });

    const events = [];
    const configuredPortal = municipalPortal({ uf: 'CE', municipio: 'FORTALEZA', municipio_codigo_ibge: '2304400' });
    const manager = {
      context,
      newPortalPage: async () => page,
      captchaState: async () => ({ captcha_active: false, blocking: false })
    };
    const running = runPortal({
      portal: {
        ...configuredPortal,
        key: 'municipal', name: 'Municipal · Fortaleza', shortName: 'Municipal',
        url: 'https://grpfordam.sefin.fortaleza.ce.gov.br/grpfor/pagesPublic/certidoes/emitirCertidao.seam',
        selectors: { cnpj: ['#cnpj'] }, humanCaptcha: false,
        preActions: [], beforeCaptchaActions: [], afterCaptchaActions: [],
        downloadButtons: []
      },
      cnpj: '07047251000170', browser: manager, baseDir: root,
      emit: event => events.push(event)
    });
    const waitFor = async predicate => {
      const started = Date.now();
      while (Date.now() - started < 10000) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Timeout aguardando a emissão municipal manual.');
    };
    await waitFor(() => events.some(event => event.type === 'human_action_required'));
    assert.equal(await page.locator('#cnpj').inputValue(), '', 'o robô não deve preencher nem enviar a emissão municipal');
    await page.locator('#cnpj').fill('07047251000170');
    await page.getByRole('button', { name: 'Emitir' }).click();
    await page.getByRole('button', { name: 'Reimprimir Certidão' }).click();
    const result = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout aguardando captura do PDF municipal reimpresso.')), 10000))]);

    assert.ok(result.filePath && fs.existsSync(result.filePath), 'the reprinted certificate should be saved');
    assert.equal(fs.readFileSync(result.filePath).subarray(0, 5).toString(), '%PDF-');
    assert.ok(events.some(event => event.type === 'municipal_manual_issuance'));
    assert.ok(events.some(event => event.type === 'municipal_pdf_captured'));
    assert.ok(events.some(event => event.type === 'downloaded' && event.portal === 'municipal'));
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('municipal print preview archives the official certificate as a PDF without relying on Chromium Downloads', async () => {
  const browser = await chromium.launch({ headless: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-municipal-beforeprint-'));
  let context;
  try {
    context = await browser.newContext({ acceptDownloads: true });
    await context.route('https://municipio.test/**', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<h1>CERTIDÃO NEGATIVA DE TRIBUTOS MUNICIPAIS</h1>
        <p>CNPJ: 00.000.000/0001-91</p><p>Válida até 31/12/2026</p>
        <p>Código de validação: ABCD-2026-XYZ</p>
        <button id="print" onclick="window.dispatchEvent(new Event('beforeprint'))">Imprimir</button>`
    }));
    const page = await context.newPage();
    const events = [];
    const manager = {
      context, closed: false,
      newPortalPage: async () => page
    };
    const portal = { key: 'municipal', name: 'Municipal · Teste', url: 'https://municipio.test/certidoes', allowedHosts: ['municipio.test'] };
    const running = runPortal({ portal, cnpj: '00000000000191', browser: manager, baseDir: root, emit: event => events.push(event) });
    const waitFor = async predicate => {
      const started = Date.now();
      while (Date.now() - started < 10000) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error('Timeout aguardando o monitor de impressão municipal.');
    };
    await waitFor(() => events.some(event => event.type === 'human_action_required' && event.manualDownloadRequired));
    await page.getByRole('button', { name: 'Imprimir' }).click();
    const result = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout capturando o PDF gerado pela impressão.')), 10000))]);
    assert.equal(fs.readFileSync(result.filePath).subarray(0, 5).toString('ascii'), '%PDF-');
    assert.equal(result.captureStage, 'municipal-print-preview');
    assert.ok(events.some(event => event.type === 'municipal_pdf_captured' && event.captureStage === 'municipal-print-preview'));
    assert.ok(events.some(event => event.type === 'downloaded' && event.portal === 'municipal'));
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('municipal manual fallback asks for PDF and authentication code after Continue, then resolves the same session', async () => {
  const browser = await chromium.launch({ headless: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-municipal-upload-'));
  const events = [];
  let context;
  try {
    context = await browser.newContext({ acceptDownloads: true });
    const pdfPage = await context.newPage();
    await pdfPage.setContent('<h1>Prefeitura Municipal — Certidão Negativa de Tributos Municipais</h1><p>CNPJ: 00.000.000/0001-91</p><p>Código de autenticação: ABCD-2026-XYZ</p>');
    const pdf = await pdfPage.pdf();
    await pdfPage.close();
    await context.route('https://municipio.test/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Portal oficial municipal</h1><p>Emita e baixe a certidão</p>' }));
    const page = await context.newPage();
    const manager = {
      context, page, closed: false,
      newPortalPage: async () => page,
      resume() { this.resumeResolver?.(); this.resumeResolver = null; }
    };
    const portal = { key: 'municipal', name: 'Municipal · Teste', shortName: 'Municipal', url: 'https://municipio.test/certidoes', allowedHosts: ['municipio.test'], selectors: { cnpj: [] }, preActions: [], beforeCaptchaActions: [], afterCaptchaActions: [], downloadButtons: [] };
    const running = runPortal({ portal, cnpj: '00000000000191', browser: manager, baseDir: root, emit: event => events.push(event) });
    const waitFor = async predicate => {
      const started = Date.now();
      while (Date.now() - started < 10000) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      throw new Error('Timeout aguardando etapa municipal manual.');
    };
    await waitFor(() => events.some(event => event.type === 'human_action_required' && event.manualDownloadRequired));
    manager.resume();
    await waitFor(() => events.some(event => event.type === 'human_action_required' && event.manualUploadRequired));
    const accepted = await manager.acceptManualMunicipalPdf({ buffer: pdf, code: 'ABCD-2026-XYZ' });
    assert.equal(accepted, true);
    const result = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout arquivando o PDF anexado.')), 5000))]);
    assert.equal(fs.readFileSync(result.filePath).subarray(0, 5).toString('ascii'), '%PDF-');
    assert.equal(result.manualValidation.status, 'conferida_pelo_responsavel');
    assert.equal(result.captureStage, 'municipal-manual-validated-upload');
    assert.ok(events.some(event => event.type === 'municipal_pdf_captured' && event.manualValidation));
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
