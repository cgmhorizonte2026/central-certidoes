const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= require('node:path').join(__dirname, '..', '.runtime', 'browsers');
const { chromium } = require('playwright');
const { BrowserManager } = require('../automation/browser');
const { speedGovAdapter } = require('../automation/providers');
const { runPortal } = require('../automation/portalRunner');

test('resolving reCAPTCHA and clicking Continue deactivates the visible widget and releases submit', async () => {
  const browser = await chromium.launch({ headless: true });
  const events = [];
  const manager = new BrowserManager(event => events.push(event));
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="form">
        <label for="cnpj">CPF ou CNPJ</label><input id="cnpj" value="32161086000120">
        <div class="g-recaptcha"><iframe title="reCAPTCHA" srcdoc="<div id='recaptcha-anchor' role='checkbox' aria-checked='false' style='width:30px;height:30px'></div>"></iframe>
          <span>Não sou um robô</span><textarea name="g-recaptcha-response" hidden></textarea></div>
        <input type="submit" name="commit" value="Consultar" class="btn btn-lime" id="gerar_certidao">
      </form>`);
    manager.page = page;

    const before = await manager.captchaState(page);
    assert.equal(before.detected, true);
    assert.equal(before.blocking, true);

    const waiting = manager.waitForCaptcha(page, 'Resolva e retome', 10000, false, true);
    const waitUntil = async predicate => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('O fluxo não chegou ao estado esperado de CAPTCHA.');
    };
    await waitUntil(() => events.some(event => event.type === 'human_action_required'));

    const captchaFrame = page.frames().find(frame => frame.parentFrame());
    await captchaFrame.locator('#recaptcha-anchor').evaluate(element => element.setAttribute('aria-checked', 'true'));
    await page.locator('textarea[name="g-recaptcha-response"]').evaluate(element => { element.value = 'valid-human-token'; });
    await waitUntil(() => events.some(event => event.type === 'waiting_for_central_resume'));

    const solved = await manager.captchaState(page);
    assert.equal(solved.detected, true, 'the widget remains present in the DOM');
    assert.equal(solved.solved, true);
    assert.equal(solved.captcha_active, false);
    assert.equal(solved.blocking, false);

    manager.resume();
    assert.equal(await waiting, true);
    const recheck = events.findLast(event => event.type === 'CAPTCHA_RECHECK');
    assert.equal(recheck.solved, true);
    assert.equal(recheck.blocking, false);
  } finally {
    await manager.close();
    await browser.close();
  }
});

test('SpeedGov adapter keeps the real Pacajus Consultar control as its post-CAPTCHA action', () => {
  const adapter = speedGovAdapter({ key: 'municipal' }, { cnpj: [] });
  assert.ok(adapter.afterCaptchaActions[0].selectors.includes('#gerar_certidao'));
  assert.equal(adapter.afterCaptchaActions[0].name, 'Consultar certidão');
});

test('municipal issuance waits for the user and archives the official PDF downloaded in the managed browser', async () => {
  const browser = await chromium.launch({ headless: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pacajus-captcha-'));
  const events = [];
  let manager;
  try {
    const context = await browser.newContext({ acceptDownloads: true });
    const pdfPage = await context.newPage();
    await pdfPage.setContent('<h1>CERTIDÃO MUNICIPAL DE TESTE</h1>');
    const pdf = await pdfPage.pdf();
    await pdfPage.close();
    await context.route('https://pacajus.test/**', async route => {
      if (route.request().url().endsWith('/certidao.pdf')) {
        return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <h1>Portal Oficial de Certidões Municipais</h1>
        <a href="/certidao.pdf">Abrir certidão</a>` });
    });
    manager = new BrowserManager(event => events.push(event));
    manager.browser = browser;
    manager.context = context;
    const portal = {
      ...speedGovAdapter({ key: 'municipal', name: 'Municipal · Pacajus', shortName: 'Municipal', url: 'https://pacajus.test/form', allowedHosts: ['pacajus.test'] }, { cnpj: ['#cnpj'] }),
      key: 'municipal', name: 'Municipal · Pacajus', shortName: 'Municipal', url: 'https://pacajus.test/form',
      allowedHosts: ['pacajus.test'],
      selectors: { cnpj: ['#cnpj'] }, preActions: [], beforeCaptchaActions: [],
      afterCaptchaActions: [{ name: 'Consultar certidão', selectors: ['#gerar_certidao'], captureDownload: true, downloadTimeout: 10000, waitMs: 100 }]
    };
    const running = runPortal({ portal, cnpj: '32161086000120', browser: manager, baseDir: root, emit: event => events.push(event) });
    const waitUntil = async predicate => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Timeout aguardando a Central solicitar a emissão manual municipal.');
    };
    await waitUntil(() => events.some(event => event.type === 'human_action_required'));
    const page = manager.page;
    assert.ok(events.some(event => event.type === 'municipal_manual_issuance'));
    assert.equal(await page.locator('#cnpj').count(), 0, 'a Central deixa a conclusão da emissão ao usuário');
    assert.equal(events.some(event => event.type === 'form_submit_attempt'), false);
    manager.resume();
    await waitUntil(() => events.filter(event => event.type === 'human_action_required' && event.manualDownloadRequired).length >= 2);
    await page.getByRole('link', { name: 'Abrir certidão' }).click({ timeout: 5000 });

    const result = await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout aguardando a captura manual do PDF.')), 8000))]);
    assert.ok(result.filePath && fs.existsSync(result.filePath));
    assert.equal(fs.readFileSync(result.filePath).subarray(0, 5).toString(), '%PDF-');
    assert.ok(result.captureStage.startsWith('municipal-manual-official-'));
    assert.ok(events.some(event => event.type === 'downloaded' && event.portal === 'municipal'));
  } finally {
    await manager?.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
