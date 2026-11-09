const test = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser } = require('../automation/launch');
const { advance } = require('../automation/issuer-engine');

test('Receita accepts cookies and consults the existing certificate history instead of issuing a duplicate', async () => {
  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext();
    await context.route('https://servicos.receitafederal.gov.br/**', r => r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<script>window.steps=[]</script><div id="card0" hidden style="position:fixed;inset:0;z-index:10;background:white">Para melhorar sua experiência, utilizamos cookies.
        <button aria-label="Aceitar" onclick="window.steps.push('cookies');window.accepted=(window.accepted||0)+1;this.parentElement.hidden=true;document.querySelector('#renew').disabled=false">Aceitar</button></div>
        <input name="niContribuinte"><button onclick="window.steps.push('emit');window.issued=(window.issued||0)+1;document.querySelector('#card0').hidden=false;document.querySelector('#modal').hidden=false">Emitir Certidão</button>
        <div id="modal" hidden><h4>Certidão Válida Encontrada</h4><button onclick="window.queried=true;window.steps.push('consult');this.parentElement.hidden=true;document.querySelector('#query').hidden=false">Consultar Certidão</button><button id="renew" disabled onclick="window.steps.push('renew')">Emitir Nova Certidão</button></div>
        <section id="query" hidden><p>CNPJ: 00.000.000/0001-91</p><button onclick="window.steps.push('search');document.querySelector('#rows').hidden=false">Consultar Certidão</button><table id="rows" hidden><tbody><tr><td>00.000.000/0001-91</td><td>Válida</td><td>31/12/2026</td><td><button title="Segunda via" onclick="window.steps.push('second-copy')">Segunda via</button></td></tr></tbody></table></section>
        <button onclick="window.agreement=true">Aceitar</button>`
    }));
    const page = await context.newPage();
    await page.goto('https://servicos.receitafederal.gov.br/form');
    const job = { mode: 'issue', status: 'awaiting_user', cnpj: '00000000000191', context,
      portal: { key: 'federal', allowedHosts: ['servicos.receitafederal.gov.br'] } };
    const events = [];
    await advance(job);
    assert.equal(await page.locator('input').inputValue(), job.cnpj);
    assert.equal(await page.evaluate(() => window.issued), 1);
    assert.equal(await page.evaluate(() => window.accepted || 0), 0);
    assert.match((await advance(job, e => events.push(e))).message, /cookies.*aceito/i);
    await advance(job);await advance(job);await advance(job);
    assert.deepEqual(await page.evaluate(() => window.steps), ['emit','cookies','consult','search','second-copy']);
    assert.equal(await page.evaluate(() => Boolean(window.queried)), true);
    assert.equal(await page.evaluate(() => window.accepted), 1);
    assert.equal(await page.evaluate(() => window.issued), 1);
    assert.equal(await page.evaluate(() => Boolean(window.agreement)), false);
    assert.equal(events[0].type, 'federal_cookie_notice_accepted');
  } finally { await browser.close(); }
});

test('cookie-like controls on other hosts are not accepted', async () => {
  const browser = await launchBrowser(true);
  try {
    const context = await browser.newContext();
    await context.route('https://example.com/**', r => r.fulfill({ contentType: 'text/html',
      body: '<div id="card0">utilizamos cookies<button onclick="window.accepted=true">Aceitar</button></div>' }));
    const page = await context.newPage();
    await page.goto('https://example.com/form');
    await advance({ mode: 'issue', status: 'awaiting_user', cnpj: '00000000000191', context,
      portal: { key: 'federal', allowedHosts: ['example.com'] } });
    assert.equal(await page.evaluate(() => Boolean(window.accepted)), false);
  } finally { await browser.close(); }
});
