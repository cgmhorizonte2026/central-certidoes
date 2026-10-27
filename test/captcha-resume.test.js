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

test('Pacajus SpeedGov flow submits Consultar in the same session after CAPTCHA and Continue', async () => {
  const browser = await chromium.launch({ headless: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'central-pacajus-captcha-'));
  const events = [];
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
        <h1>Certidão Negativa de Tributos Municipais</h1>
        <form id="emissao" onsubmit="event.preventDefault(); window.open('/certidao.pdf', '_blank')">
          <label for="cnpj">CPF ou CNPJ (Somente números)</label><input id="cnpj" value="">
          <div class="g-recaptcha"><iframe title="reCAPTCHA" srcdoc="<div id='recaptcha-anchor' role='checkbox' aria-checked='false' style='width:30px;height:30px'></div>"></iframe>
            <span>Não sou um robô</span><textarea name="g-recaptcha-response" hidden></textarea></div>
          <input type="submit" name="commit" value="Consultar" class="btn btn-lime" id="gerar_certidao">
        </form>` });
    });
    const manager = new BrowserManager(event => events.push(event));
    manager.browser = browser;
    manager.context = context;
    const portal = {
      ...speedGovAdapter({ key: 'municipal', name: 'Municipal · Pacajus', shortName: 'Municipal', url: 'https://pacajus.test/form' }, { cnpj: ['#cnpj'] }),
      key: 'municipal', name: 'Municipal · Pacajus', shortName: 'Municipal', url: 'https://pacajus.test/form',
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
      throw new Error('Timeout aguardando etapa do fluxo municipal.');
    };
    await waitUntil(() => events.some(event => event.type === 'human_action_required'));
    const page = manager.page;
    const captchaFrame = page.frames().find(frame => frame.parentFrame());
    await captchaFrame.locator('#recaptcha-anchor').evaluate(element => element.setAttribute('aria-checked', 'true'));
    await page.locator('textarea[name="g-recaptcha-response"]').evaluate(element => { element.value = 'valid-human-token'; });
    await waitUntil(() => events.some(event => event.type === 'waiting_for_central_resume'));
    manager.resume(); // equivale ao botão Continuar na Central

    const result = await running;
    assert.ok(result.filePath && fs.existsSync(result.filePath));
    assert.equal(fs.readFileSync(result.filePath).subarray(0, 5).toString(), '%PDF-');
    assert.ok(events.some(event => event.type === 'after_captcha_action' && event.action === 'Consultar certidão' && event.clicked));
    assert.ok(events.some(event => event.type === 'CAPTCHA_RECHECK' && event.solved && !event.blocking));
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
