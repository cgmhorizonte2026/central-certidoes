const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchBrowser } = require('../automation/launch');
const { runPortal } = require('../automation/portalRunner');
const federalPortal = require('../config/portals').find(portal => portal.key === 'federal');

async function makePdf(context) {
  const page = await context.newPage();
  await page.setContent('<h1>Documento Federal de teste</h1>');
  const pdf = await page.pdf({ format: 'A4' });
  await page.close();
  return pdf;
}

function manager(context) {
  return {
    context,
    newPortalPage: () => context.newPage(),
    captchaState: async () => ({ captcha_active: false, blocking: false }),
    waitForCaptcha: async () => true,
    waitForHumanResume: async () => {}
  };
}

test('valid federal certificate flow emits first, consults history twice, then downloads the first valid row', async () => {
  const browser = await launchBrowser(true);
  const context = await browser.newContext({ acceptDownloads: true });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-federal-existing-'));
  try {
    const pdf = await makePdf(context);
    await context.route('https://servicos.receitafederal.gov.br/**', async route => {
      if (route.request().url().endsWith('/certidao.pdf')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
        <div id="card0" hidden>Utilizamos cookies para melhorar sua experiência.<button type="button" onclick="window.steps.push('cookies');this.parentElement.hidden=true">Aceitar</button></div>
        <app-root><mf-portal-layout><portal-main-layout><div><main id="app"><ng-component><ng-component><app-coleta-parametros-pj><app-coleta-parametros-template><form>
          <div class="br-card"><div class="card-content"><input name="niContribuinte"><a id="old-link" href="#antigas" onclick="window.steps.push('old-link')">Consulte certidões mais antigas</a></div></div>
          <div class="acoes-card"><div class="left-position"><button type="button">Voltar</button></div><div class="right-position"><button type="button" id="initial-consult" onclick="window.steps.push('wrong-initial-consult')">Consultar Certidão</button><button type="button" id="issue" onclick="showValidModal()">Emitir Certidão</button></div></div>
        </form></app-coleta-parametros-template></app-coleta-parametros-pj></ng-component></ng-component></main></div></portal-main-layout></mf-portal-layout></app-root>
        <script>
          window.steps=[];
          setTimeout(()=>document.querySelector('#card0').hidden=false,2500);
          function showValidModal(){window.steps.push('issue');document.querySelector('#app').insertAdjacentHTML('beforeend',
            '<div role="dialog"><h2>Certidão Válida Encontrada</h2><p>Já existe uma certidão válida para o CNPJ 32.161.086/0001-20.</p><button type="button" onclick="openHistory()">Consultar Certidão</button></div>');}
          function openHistory(){window.steps.push('modal-consult');location.hash='/home/cnpj/consultar';document.querySelector('#app').innerHTML=
            '<p>CNPJ: 32.161.086/0001-20</p><label>Data Inicial<input aria-label="Data Inicial" value="01/09/2026"></label><label>Data Final<input aria-label="Data Final" value="03/11/2026"></label><button type="button" onclick="searchHistory()">Consultar Certidão</button>';}
          function searchHistory(){window.steps.push('history-consult');location.hash='/home/cnpj/consultar/resultado';document.querySelector('#app').innerHTML='<p>CNPJ: 32.161.086/0001-20</p><table><tbody>'+
            '<tr><td>32.161.086/0001-20</td><td>Válida</td><td>15/10/2026</td><td>20/11/2026</td><td><button type="button" id="first" title="Segunda via">Download</button></td></tr>'+
            '<tr><td>32.161.086/0001-20</td><td>Válida</td><td>20/10/2026</td><td>20/12/2026</td><td><button type="button" id="second" title="Segunda via">Download</button></td></tr>'+
            '</tbody></table>';document.querySelector('#first').onclick=()=>{window.steps.push('first-valid');fetch('/certidao.pdf')};document.querySelector('#second').onclick=()=>window.steps.push('wrong-newer-row');}
        </script></body></html>` });
    });

    const events = [];
    const result = await runPortal({ portal: federalPortal, cnpj: '32161086000120', browser: manager(context), baseDir, emit: event => events.push(event) });
    const page = context.pages().at(-1);
    assert.deepEqual(await page.evaluate(() => window.steps), ['cookies', 'issue', 'modal-consult', 'history-consult', 'first-valid']);
    assert.equal(fs.readFileSync(result.filePath).subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(events.some(event => event.type === 'federal_issue_requested'));
    const selectedAction=events.find(event=>event.type==='federal_action_selected');
    assert.equal(selectedAction?.element?.text,'Emitir Certidão');
    assert.match(selectedAction?.selector||'',/Emitir Certidão/);
    assert.ok(events.some(event => event.type === 'federal_existing_certificates_opened'));
    assert.ok(events.some(event => event.type === 'downloaded' && event.portal === 'federal'));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('when no valid federal certificate exists, the initial Receita action leads to the generated PDF', async () => {
  const browser = await launchBrowser(true);
  const context = await browser.newContext({ acceptDownloads: true });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'central-federal-new-'));
  try {
    const pdf = await makePdf(context);
    await context.route('https://servicos.receitafederal.gov.br/**', async route => {
      if (route.request().url().endsWith('/certidao.pdf')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
        <app-root><mf-portal-layout><portal-main-layout><div><main id="app"><ng-component><ng-component><app-coleta-parametros-pj><app-coleta-parametros-template><form>
          <div class="br-card"><div class="card-content"><input name="niContribuinte"><a href="#antigas" onclick="window.steps.push('wrong-old-link')">Consulte certidões mais antigas</a></div></div>
          <div class="acoes-card"><div class="left-position"><button type="button">Voltar</button></div><div class="right-position"><button type="button" onclick="window.steps.push('wrong-initial-consult')">Consultar Certidão</button><button type="button" onclick="emitNewCertificate()">Emitir Certidão</button></div></div>
        </form></app-coleta-parametros-template></app-coleta-parametros-pj></ng-component></ng-component></main></div></portal-main-layout></mf-portal-layout></app-root>
        <script>window.steps=[];function emitNewCertificate(){window.steps.push('issue');document.querySelector('#app').innerHTML='<p>Certidão emitida com sucesso para o CNPJ 32.161.086/0001-20.</p><section><a href="/certidao.pdf" title="Baixar PDF">Baixar PDF</a></section>';document.querySelector('a').onclick=event=>{event.preventDefault();fetch('/certidao.pdf')};}</script>
        </body></html>` });
    });
    const result = await runPortal({ portal: federalPortal, cnpj: '32161086000120', browser: manager(context), baseDir, emit: () => {} });
    const page = context.pages().at(-1);
    assert.deepEqual(await page.evaluate(() => window.steps), ['issue']);
    assert.equal(fs.readFileSync(result.filePath).subarray(0, 5).toString('ascii'), '%PDF-');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
