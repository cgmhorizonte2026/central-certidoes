const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkCancelled } = require('./cancellation');
const { officialUrl } = require('./capture-provenance');
const { decodePdfPayload } = require('./federal-support');
const { existingFederalCertificate } = require('./federal-existing');

// Never click behind an overlay, including the Receita cookie notice. Inspecting
// the hit target does not scroll; Playwright's repeated click retries do.
async function unobstructed(control) {
  if (!await control.isVisible().catch(() => false) || !await control.isEnabled().catch(() => false)) return false;
  return control.evaluate(el => {
    const dialogs = [...document.querySelectorAll('[role="dialog"],dialog[open],.modal.show,[aria-modal="true"]')]
      .filter(d => d.getClientRects().length && getComputedStyle(d).visibility !== 'hidden');
    if (dialogs.length && !dialogs.some(d => d.contains(el))) return false;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return true;
    const hit = document.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, r.x + r.width / 2)), Math.max(0, Math.min(innerHeight - 1, r.y + r.height / 2)));
    return !!hit && (hit === el || el.contains(hit));
  }).catch(() => false);
}

async function runFederal({ portal, cnpj, browser, baseDir, emit, timing = {} }) {
  const page = await browser.newPortalPage();
  const listeners = [], pending = new Set(), seen = new Set(), queue = [];
  let disposed = false, actionAt = Date.now(), filled = false, submitted = false, formPrepared = false;
  const actions = new Set();
  const state = { actions, filled: false }; // Existing-certificate decisions remain shared.
  const listen = (p, event, fn) => { p.on(event, fn); listeners.push(() => p.off(event, fn)); };
  const track = fn => {
    const task = Promise.resolve().then(fn).catch(() => {});
    pending.add(task); task.finally(() => pending.delete(task));
  };
  const accept = (bytes, url, method) => {
    if (disposed || !bytes || bytes.length > 15 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-' || !officialUrl(url, portal)) return;
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!seen.has(hash)) {
      seen.add(hash); queue.push({ bytes, url, method });
      // A PDF received during CAPTCHA/manual assistance wakes the loop; its
      // CNPJ and issuer are still validated before any file can be saved.
      browser.resume?.();
    }
  };
  const attach = p => {
    listen(p, 'popup', attach);
    listen(p, 'response', r => {
      if (r.status() !== 200 || !officialUrl(r.url(), portal)) return;
      const type = r.headers()['content-type'] || '';
      if (!/pdf|octet-stream|json/i.test(type) || Number(r.headers()['content-length'] || 0) > 20 * 1024 * 1024) return;
      track(async () => {
        const body = await r.body();
        accept(/json/i.test(type) ? decodePdfPayload(JSON.parse(body.toString())) : body, r.url(), 'official_response');
      });
    });
    listen(p, 'download', d => track(async () => {
      const stream = await d.createReadStream(); if (!stream) return;
      const chunks = []; let size = 0;
      for await (const chunk of stream) { size += chunk.length; if (size > 15 * 1024 * 1024) { stream.destroy(); return; } chunks.push(chunk); }
      accept(Buffer.concat(chunks), d.url().replace(/^blob:/, ''), 'browser_download');
    }));
  };
  attach(page); // Capture must exist before the first emission, including human clicks.
  const pause = async message => {
    await browser.waitForHumanResume('Receita Federal: ' + message + ' Conclua na janela do órgão e clique em Continuar na Central.');
    checkCancelled(); actionAt = Date.now();
  };
  const clickOnce = async (control, key) => {
    if (actions.has(key) || !await unobstructed(control)) return false;
    // An uncertain click must never be replayed: its request may have succeeded.
    actions.add(key); actionAt = Date.now();
    try { await control.click({ timeout: 1500 }); }
    catch { await pause('O clique não pôde ser confirmado. A repetição automática foi suspensa.'); }
    emit({ type: 'federal_action', portal: 'federal', action: key });
    return true;
  };
  try {
    emit({ type: 'portal_opening', portal: 'federal', name: portal.name, url: portal.url });
    await page.goto(new URL('#/home/cnpj', portal.url).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.bringToFront();
    for (;;) {
      checkCancelled();
      if (page.isClosed()) throw Error('A janela da Receita Federal foi fechada.');
      // Continue may arrive while the download stream is still being read.
      if (pending.size) await browser.abortable(Promise.race([
        Promise.allSettled([...pending]), new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref?.(); })
      ]));
      while (queue.length) {
        const record = queue.shift();
        try {
          const text = (await require('../lib/certificates').extractPdf(record.bytes)).text;
          require('../lib/capture-validation').validateCapture(text, cnpj, 'federal');
        } catch (error) {
          emit({ type: 'capture_rejected', portal: 'federal', message: error.message });
          continue;
        }
        checkCancelled();
        const dir = path.join(baseDir, 'data', 'certidoes', cnpj);
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, 'CND FEDERAL-' + crypto.randomUUID() + '.pdf');
        fs.writeFileSync(filePath, record.bytes);
        return { filePath, provenance: { source: 'controlled_browser', officialPortal: true, sourceUrl: record.url, captureMethod: record.method, capturedAt: new Date().toISOString() } };
      }
      if (!officialUrl(page.url(), portal)) { await pause('A página atual não é um endereço oficial reconhecido.'); continue; }
      const body = await page.locator('body').innerText({ timeout: 3000 });
      if (/informa(?:ç|c)[õo]es dispon[ií]veis.*insuficientes para emitir|dados.*insuficientes para emitir a certid[aã]o/i.test(body))
        throw Error('A Receita Federal informou que os dados são insuficientes para emissão pela Internet.');
      if (/Mensagem de Erro|Não foi possível concluir|Serviço (?:temporariamente )?indisponível|\b(?:105|106)\s*-\s*\d{2}\//i.test(body)) {
        const dialogText = (await page.locator('[role="dialog"]:visible,dialog[open]:visible').allTextContents()).join(' ');
        const detail = require('./federal-support').safeLog(dialogText || body.match(/(?:Mensagem de Erro|Não foi possível concluir)[^\n]*/i)?.[0] || 'Erro sem texto disponível', cnpj).slice(0, 800);
        const code = detail.match(/\b(?:023|016|105|106)\b/)?.[0] || '';
        emit({ type: 'federal_portal_error', portal: 'federal', code, message: detail });
        await pause(`O portal apresentou um erro ou uma verificação de segurança${code ? ' (código ' + code + ')' : ''}. Nenhuma nova emissão será disparada automaticamente.`); continue;
      }
      const cookies = page.locator('#card0').filter({ hasText: /utilizamos cookies/i });
      if (await cookies.isVisible().catch(() => false)) {
        if (!await clickOnce(cookies.getByRole('button', { name: 'Aceitar', exact: true }), 'cookies'))
          await pause('Confira o aviso de cookies antes de prosseguir.');
      } else {
        const dialogs = page.locator('[role="dialog"]:visible,dialog[open]:visible,.modal.show:visible,[aria-modal="true"]:visible');
        if (await dialogs.count()) {
          const modal = dialogs.last(), text = await modal.innerText();
          if (/Certidão Válida Encontrada/i.test(text)) {
            if (!await clickOnce(modal.getByRole('button', { name: 'Consultar Certidão', exact: true }), 'existing'))
              if (Date.now() - actionAt > (timing.responseMs ?? 30000)) await pause('A consulta da certidão existente não avançou.');
          } else if (/certid[aã]o.*v[aá]lida/i.test(text) && await modal.getByRole('button', { name: /^Emitir nova certid[aã]o$/i }).count()) {
            if (!await clickOnce(modal.getByRole('button', { name: /^Emitir nova certid[aã]o$/i }), 'renew') && Date.now() - actionAt > (timing.responseMs ?? 30000))
              await pause('A confirmação da nova emissão não avançou.');
          } else await pause('Uma janela do portal exige conferência. Os botões atrás dela não serão acionados.');
        } else if (/\/cnpj\/consultar(?:\/resultado)?$/.test(new URL(page.url()).hash)) {
          state.filled = filled; state.federalSubmittedAt = 0;
          const result = await existingFederalCertificate(page, { portal, cnpj }, state, emit);
          if (result?.status === 'awaiting_user') await pause(result.message);
          else if (Date.now() - actionAt > (timing.responseMs ?? 30000)) await pause('Aguardando a segunda via da Receita.');
        } else if (!submitted) {
          const field = page.locator('input[name="niContribuinte"]');
          if (await unobstructed(field)) {
            if (!formPrepared) {
              const ready = await browser.abortable(require('./federal-readiness').waitForFederalForm(
                { page, status: 'running' }, emit, timing.readiness || {}));
              checkCancelled();
              if (!ready) { await pause('O formulário ainda não estabilizou para iniciar a emissão.'); continue; }
              formPrepared = true; actionAt = Date.now();
              continue; // Recheck overlays after waiting, before touching the form.
            }
            if (!filled) {
              await field.click({ timeout: 1500 });
              await field.press('Control+A');
              await field.press('Backspace');
              await field.pressSequentially(cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'), { delay: 25, timeout: 10000 });
              await field.press('Tab');
              await browser.abortable(new Promise(resolve => setTimeout(resolve, timing.fieldSettleMs ?? 1200)));
              filled = (await field.inputValue()).replace(/\D/g, '') === cnpj;
            }
            if (filled) submitted = await clickOnce(page.getByRole('button', { name: /^Emitir(?: Certidão)?$/i }), 'emit');
          }
        }
      }
      if (Date.now() - actionAt > (timing.responseMs ?? 30000))
        await pause('A resposta não foi concluída. Resolva eventual CAPTCHA ou confira a mensagem exibida.');
      await browser.abortable(new Promise(resolve => setTimeout(resolve, timing.pollMs ?? 400)));
    }
  } finally { disposed = true; listeners.forEach(remove => remove()); }
}
module.exports = { runFederal, unobstructed };
