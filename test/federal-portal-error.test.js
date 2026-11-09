const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyFederalPortalError } = require('../automation/portalRunner');

test('classifies the Receita Federal temporary error 106 and explains no certificate was issued', () => {
  const error = classifyFederalPortalError('Não foi possível concluir a ação para o contribuinte informado. Por favor, tente novamente dentro de alguns minutos. 106 - 26/10/2026 16:57:30');
  assert.deepEqual(error, {
    provider: 'Receita Federal',
    portalCode: '106',
    occurrence: '26/10/2026 16:57:30',
    category: 'PORTAL_TEMPORARIAMENTE_INDISPONIVEL',
    message: 'A Receita Federal respondeu com o código 106 e pediu para tentar novamente em alguns minutos. Nenhuma certidão foi emitida nesta tentativa.'
  });
});

test('classifies Receita temporary error 023 without treating it as a certificate result', () => {
  const error = classifyFederalPortalError('Não foi possível concluir a ação para o contribuinte informado. Por favor, tente novamente dentro de alguns minutos. 023 - 29/10/2026 12:47:59');
  assert.equal(error.portalCode, '023');
  assert.equal(error.category, 'PORTAL_TEMPORARIAMENTE_INDISPONIVEL');
  assert.match(error.message, /023/);
  assert.match(error.message, /Nenhuma certidão foi emitida/);
});

test('does not classify ordinary federal form text as a terminal portal error', () => {
  assert.equal(classifyFederalPortalError('Certidão de Pessoa Jurídica. Informe o CNPJ e clique em Emitir Certidão.'), null);
});

test('a real Receita 023 response is recorded with page diagnostics and never archived as a certificate', async () => {
  const { launchBrowser } = require('../automation/launch');
  const { runPortal } = require('../automation/portalRunner');
  const portal = require('../config/portals').find(item => item.key === 'federal');
  const browser = await launchBrowser(true);
  const context = await browser.newContext({ acceptDownloads: true });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-federal-023-'));
  try {
    await context.route('https://servicos.receitafederal.gov.br/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><app-root><mf-portal-layout><portal-main-layout><main>
        <ng-component><ng-component><app-coleta-parametros-pj><form><div></div><div><div></div><button onclick="document.querySelector('main').innerHTML='Não foi possível concluir a ação para o contribuinte informado. Por favor, tente novamente dentro de alguns minutos. 023 - 03/11/2026 12:00:00'">Consultar Certidão</button></div><input name="niContribuinte"></form></app-coleta-parametros-pj></ng-component></ng-component>
        </main></portal-main-layout></mf-portal-layout></app-root>`
    }));
    const manager = {
      context,
      newPortalPage: () => context.newPage(),
      captchaState: async () => ({ captcha_active: false, blocking: false }),
      waitForCaptcha: async () => true,
      waitForHumanResume: async () => {}
    };
    const events = [];
    await assert.rejects(runPortal({
      portal, cnpj: '32161086000120', browser: manager, baseDir, emit: event => events.push(event)
    }), /código 023/);

    const diagnosticEvent = events.find(event => event.type === 'federal_portal_error_diagnostic');
    assert.ok(diagnosticEvent?.diagnosticPath);
    assert.ok(diagnosticEvent?.screenshotPath);
    assert.ok(fs.existsSync(diagnosticEvent.diagnosticPath));
    assert.ok(fs.existsSync(diagnosticEvent.screenshotPath));
    const diagnostic = JSON.parse(fs.readFileSync(diagnosticEvent.diagnosticPath, 'utf8'));
    assert.match(diagnostic.text, /código dentro de alguns minutos|dentro de alguns minutos/i);
    assert.equal(diagnostic.portalCode, '023');
    assert.ok(events.some(event => event.type === 'portal_response_error' && event.code === '023'));
    assert.equal(events.some(event => event.type === 'downloaded'), false);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
