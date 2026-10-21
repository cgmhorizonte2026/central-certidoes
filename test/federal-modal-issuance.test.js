const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchBrowser } = require('../automation/launch');
const { runPortal } = require('../automation/portalRunner');
const federalPortal = require('../config/portals').find(portal => portal.key === 'federal');

test('Receita modal with a valid certificate follows Emitir Nova Certidão and saves its PDF', async () => {
  const browser = await launchBrowser(true);
  const context = await browser.newContext({ acceptDownloads: true });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-federal-modal-'));
  try {
    const pdfPage = await context.newPage();
    await pdfPage.setContent('<h1>Certidão Federal de teste</h1>');
    const pdf = await pdfPage.pdf({ format: 'A4' });
    await pdfPage.close();

    await context.route('https://servicos.receitafederal.gov.br/**', async route => {
      if (route.request().url().endsWith('/certidao.pdf')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/pdf',
          body: pdf
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><input name="cnpj" maxlength="18">
          <button id="initial">Emitir Certidão</button>
          <dialog id="valid"><h2>Certidão Válida Encontrada</h2>
            <p>Já existe uma certidão válida para este CNPJ.</p>
            <button id="consult" onclick="window.consulted=(window.consulted||0)+1">Consultar Certidão</button>
            <button id="new" onclick="window.newIssued=(window.newIssued||0)+1;fetch('/certidao.pdf')">Emitir Nova Certidão</button>
          </dialog>
          <script>document.querySelector('#initial').onclick=()=>document.querySelector('#valid').showModal();</script>`
      });
    });

    const manager = {
      context,
      newPortalPage: () => context.newPage(),
      captchaState: async () => ({ captcha_active: false, blocking: false }),
      waitForCaptcha: async () => true
    };
    const events = [];
    const portal = {
      ...federalPortal,
      url: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj',
      beforeCaptchaActions: [{ name: 'Emitir Certidão', selectors: ['#initial'], waitMs: 10 }],
      afterCaptchaActions: federalPortal.afterCaptchaActions.map(action => ({ ...action, downloadTimeout: 3000, waitMs: 10 }))
    };

    const result = await runPortal({
      portal,
      cnpj: '31.302.808/0001-57',
      browser: manager,
      baseDir,
      emit: event => events.push(event)
    });

    assert.equal(await manager.context.pages().at(-1).evaluate(() => window.consulted || 0), 0);
    assert.equal(await manager.context.pages().at(-1).evaluate(() => window.newIssued || 0), 1);
    assert.equal(fs.readFileSync(result.filePath).subarray(0, 5).toString(), '%PDF-');
    assert.ok(events.some(event => event.type === 'federal_valid_certificate_found'));
    assert.ok(events.some(event => event.type === 'downloaded' && event.portal === 'federal'));
  } finally {
    await browser.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
