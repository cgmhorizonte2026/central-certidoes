const fs = require('fs');
const path = require('path');
const { trustedUrl } = require('../config/registry');
const { handleFederalCookies } = require('./federal-cookies');
const { advance: advanceIssuer } = require('./issuer-engine');

function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

function looksLikePdf(buffer) {
  if (!buffer || !buffer.length) return false;
  // PDFs válidos normalmente iniciam com %PDF-. Toleramos alguns bytes de
  // prefixo para respostas que venham com BOM/whitespace.
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

function classifyFederalPortalError(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const match = source.match(/n[aã]o foi poss[ií]vel concluir a a[cç][aã]o para o contribuinte informado\.?\s*por favor, tente novamente dentro de alguns minutos\.?\s*(\d{2,4})(?:\s*[-–]\s*(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}:\d{2})?))?/i);
  if (!match) return null;
  return {
    provider: 'Receita Federal',
    portalCode: match[1],
    occurrence: match[2] || '',
    category: 'PORTAL_TEMPORARIAMENTE_INDISPONIVEL',
    message: `A Receita Federal respondeu com o código ${match[1]} e pediu para tentar novamente em alguns minutos. Nenhuma certidão foi emitida nesta tentativa.`
  };
}

function classifyStateCePortalError(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!/n[aã]o foi poss[ií]vel emitir o documento solicitado[\s\S]{0,240}consultar pend[eê]ncias no site/i.test(source)) return null;
  return {
    category: 'PORTAL_SOLICITA_CONSULTA_DE_PENDENCIAS',
    provider: 'SEFAZ Ceará / PGE Ceará',
    message: 'A SEFAZ do Ceará informou que não foi possível emitir o documento pela consulta online e orientou verificar pendências no Portal do Contribuinte da PGE. Nenhum PDF estadual foi emitido nesta tentativa.'
  };
}

async function saveDownloadAsPdf(download, finalPath) {
  const tempPath = finalPath + '.part';
  await download.saveAs(tempPath);
  const data = fs.readFileSync(tempPath);
  if (!looksLikePdf(data)) {
    const rawPath = finalPath.replace(/\.pdf$/i, '') + '-RESPOSTA-NAO-PDF.bin';
    fs.renameSync(tempPath, rawPath);
    const err = new Error('O arquivo retornado pela Receita não possui conteúdo PDF. A resposta bruta foi preservada para diagnóstico.');
    err.rawPath = rawPath;
    throw err;
  }
  fs.renameSync(tempPath, finalPath);
}


async function prepareControlledDownloadDir(page, baseDir, cnpj, emit, portalKey = 'download') {
  const dir = path.join(
    baseDir, 'data', 'tmp-downloads',
    `${onlyDigits(cnpj)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(dir, { recursive: true });

  // Como a Central se conecta a um Chrome real por CDP, o evento Playwright
  // de download nem sempre é entregue, embora o Chrome baixe o arquivo.
  // Forçamos esta página a baixar em uma pasta controlada e, se necessário,
  // capturamos o PDF diretamente do sistema de arquivos.
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    emit({ type: 'download_dir_ready', portal: portalKey, downloadDir: dir, mode: 'cdp-page' });
  } catch (err) {
    emit({ type: 'download_dir_warning', portal: portalKey, downloadDir: dir, message: String(err?.message || err) });
  }
  return dir;
}

async function waitForPdfInDirectory(dir, timeout = 60000) {
  const started = Date.now();
  const observed = new Map();

  while (Date.now() - started < timeout) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) {}

    // Ignora arquivos temporários do Chrome enquanto o download não concluiu.
    const candidates = names
      .filter(name => !/\.(crdownload|tmp|part)$/i.test(name))
      .map(name => path.join(dir, name))
      .filter(file => {
        try { return fs.statSync(file).isFile(); } catch (_) { return false; }
      });

    for (const file of candidates) {
      try {
        const stat = fs.statSync(file);
        if (stat.size <= 0) continue;

        const previous = observed.get(file);
        observed.set(file, { size: stat.size, at: Date.now() });

        // Exige tamanho estável por ao menos uma iteração para evitar leitura
        // enquanto o Chrome ainda está terminando de gravar o arquivo.
        if (!previous || previous.size !== stat.size) continue;

        const data = fs.readFileSync(file);
        if (looksLikePdf(data)) return { pdfBuffer: data, sourcePath: file };
      } catch (_) {}
    }

    await new Promise(resolve => setTimeout(resolve, 350));
  }
  return null;
}

function municipalCertificatePath(baseDir, cnpj) {
  const dir = path.join(baseDir, 'data', 'certidoes', onlyDigits(cnpj), new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'CND MUNICIPAL.pdf');
}

function safeMunicipalUrl(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; }
  catch { return ''; }
}

async function waitForManualMunicipalCertificate({ page, browser, portal, cnpj, baseDir, emit }) {
  // Managed Playwright downloads must remain under Playwright control so its
  // Download.saveAs API can safely copy the file. CDP folders are only needed
  // when attached to an externally managed Chrome session.
  const downloadDir = browser.connectedToExistingChrome
    ? await prepareControlledDownloadDir(page, baseDir, cnpj, emit, portal.key)
    : null;
  const context = browser.context;
  const downloadDirs = new Set(downloadDir ? [downloadDir] : []);
  const filePath = municipalCertificatePath(baseDir, cnpj);
  try { fs.rmSync(filePath, { force: true }); } catch (_) {}
  let settled = false;
  let downloadCaptureStarted = false;
  let resolveResult;
  const resultPromise = new Promise(resolve => { resolveResult = resolve; });
  const listeners = [];
  const printBinding = `__centralMunicipalPrint_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const finish = result => {
    if (settled) return;
    settled = true;
    resolveResult(result);
  };
  const previousManualHandler = browser.acceptManualMunicipalPdf;
  const persistPdf = (data, captureStage, sourceUrl, manualValidation = null) => {
    if (settled || !Buffer.isBuffer(data) || data.length > 15 * 1024 * 1024 || !looksLikePdf(data)) return false;
    fs.writeFileSync(filePath, data);
    emit({ type: 'municipal_pdf_captured', portal: portal.key, sourceUrl: safeMunicipalUrl(sourceUrl), captureStage, bytes: data.length, manualValidation: Boolean(manualValidation), message: manualValidation ? 'PDF recebido após conferência humana do código e CNPJ; encaminhado ao arquivo da Central.' : 'PDF recebido do portal oficial e salvo no armazenamento da Central.' });
    finish({ filePath, captureStage, ...(manualValidation ? { manualValidation } : {}) });
    return true;
  };
  browser.acceptManualMunicipalPdf = async ({ buffer, code }) => {
    if (settled || !Buffer.isBuffer(buffer) || !looksLikePdf(buffer)) return false;
    const manualValidation = {
      status: 'conferida_pelo_responsavel',
      method: 'confirmacao_no_portal_e_correspondencia_cnpj_codigo_no_pdf',
      code: String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
      confirmedAt: new Date().toISOString(),
      note: 'O responsável confirmou a conferência no portal oficial. A Central confirmou a presença do CNPJ e do código no PDF; não consultou automaticamente a base do órgão.'
    };
    return persistPdf(buffer, 'municipal-manual-validated-upload', page.url(), manualValidation);
  };
  const capturePrintPreview = async source => {
    const target = source?.page;
    if (settled || !target || target.isClosed?.() || !trustedUrl(target.url(), portal)) return false;
    const text = await target.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    const hasCnpj = onlyDigits(text).includes(onlyDigits(cnpj));
    const isCertificate = /certid[aã]o/i.test(text)
      && /v[aá]lida\s+at[eé]|valida\s+por|\bvalidade\b|c[oó]d\.?\s+de\s+valida[cç][aã]o|c[oó]digo\s+de\s+(?:autentica[cç][aã]o|valida[cç][aã]o)|n[º°]\s*\d+/i.test(text);
    if (!hasCnpj || !isCertificate) {
      emit({ type: 'municipal_print_ignored', portal: portal.key, sourceUrl: safeMunicipalUrl(target.url()), hasCnpj, isCertificate, message: 'A ação de impressão não parece mostrar a certidão final deste CNPJ; nenhum documento foi arquivado.' });
      return false;
    }
    const pdf = await printPageToPdf(target).catch(() => null);
    if (!pdf || !looksLikePdf(pdf)) {
      emit({ type: 'municipal_print_capture_failed', portal: portal.key, sourceUrl: safeMunicipalUrl(target.url()), message: 'O navegador abriu a impressão, mas não foi possível renderizar a página oficial como PDF. A consulta continua aberta para anexar o PDF manualmente.' });
      return false;
    }
    return persistPdf(pdf, 'municipal-print-preview', target.url());
  };
  if (typeof browser.context.exposeBinding === 'function') {
    try {
      await browser.context.exposeBinding(printBinding, capturePrintPreview);
      await browser.context.addInitScript(name => {
        window.addEventListener('beforeprint', () => {
          try { Promise.resolve(window[name]()).catch(() => {}); } catch (_) {}
        });
      }, printBinding);
    } catch (error) {
      emit({ type: 'municipal_print_monitor_warning', portal: portal.key, message: `Monitor da impressão indisponível: ${error.message}` });
    }
  }
  const attachPage = target => {
    if (!target || target.isClosed?.()) return;
    const installPrintListener = () => target.evaluate(name => {
      if (window.__centralMunicipalBeforePrintInstalled) return;
      window.__centralMunicipalBeforePrintInstalled = true;
      window.addEventListener('beforeprint', () => {
        try { Promise.resolve(window[name]()).catch(() => {}); } catch (_) {}
      });
    }, printBinding).catch(() => {});
    target.on('domcontentloaded', installPrintListener);
    listeners.push(() => target.off('domcontentloaded', installPrintListener));
    installPrintListener();
    const onDownload = download => {
      if (settled || downloadCaptureStarted) return;
      const sourceUrl = target.url();
      const downloadUrl = download.url();
      const officialSource = trustedUrl(sourceUrl, portal);
      const officialDownload = trustedUrl(downloadUrl, portal);
      if (!officialSource || (!officialDownload && !/^(blob:|data:application\/pdf)/i.test(downloadUrl))) {
        emit({ type: 'municipal_download_rejected', portal: portal.key, sourceUrl: safeMunicipalUrl(sourceUrl), downloadUrl: safeMunicipalUrl(downloadUrl), message: 'Download ignorado porque não veio da sessão oficial da prefeitura.' });
        return;
      }
      downloadCaptureStarted = true;
      (async () => {
        const stream = await download.createReadStream();
        if (!stream) throw new Error('O navegador não disponibilizou o arquivo baixado.');
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > 15 * 1024 * 1024) { stream.destroy(); throw new Error('O PDF excede o limite de 15 MB.'); }
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);
        if (!looksLikePdf(data)) throw new Error('O arquivo baixado não contém um PDF válido.');
        fs.writeFileSync(filePath, data);
        emit({ type: 'municipal_pdf_captured', portal: portal.key, sourceUrl: safeMunicipalUrl(sourceUrl), captureStage: 'municipal-manual-official-download', bytes: data.length, message: 'PDF recebido do portal oficial e salvo no armazenamento da Central.' });
        finish({ filePath, captureStage: 'municipal-manual-official-download' });
      })().catch(error => {
        downloadCaptureStarted = false;
        Promise.resolve(download.failure()).catch(() => null).then(failure => {
          if (!settled && !downloadCaptureStarted) emit({ type: 'municipal_download_invalid', portal: portal.key, sourceUrl: safeMunicipalUrl(sourceUrl), downloadUrl: safeMunicipalUrl(downloadUrl), failure: failure || '', message: `Arquivo baixado não foi arquivado como PDF: ${error.message}` });
        });
      });
    };
    const onResponse = response => {
      if (settled) return;
      const headers = response.headers();
      const disposition = headers['content-disposition'] || '';
      const isPdf = /application\/pdf/i.test(headers['content-type'] || '') || (/\.pdf(?:[";?]|$)/i.test(disposition) && /^attachment\b/i.test(disposition)) || /\.pdf(?:[?#]|$)/i.test(response.url());
      if (!trustedUrl(response.url(), portal) || !isPdf) return;
      (async () => {
        const data = await response.body();
        if (data.length > 15 * 1024 * 1024 || !looksLikePdf(data)) {
          emit({ type: 'municipal_download_invalid', portal: portal.key, sourceUrl: safeMunicipalUrl(response.url()), message: 'O portal respondeu à ação, mas o conteúdo recebido não é um PDF válido.' });
          return;
        }
        persistPdf(data, 'municipal-manual-official-pdf-view', response.url());
      })().catch(error => { if (!settled && !downloadCaptureStarted) emit({ type: 'municipal_download_invalid', portal: portal.key, sourceUrl: safeMunicipalUrl(response.url()), message: `Não foi possível capturar o PDF oficial: ${error.message}` }); });
    };
    target.on('download', onDownload);
    target.on('response', onResponse);
    listeners.push(() => { target.off('download', onDownload); target.off('response', onResponse); });
    // Preserve the PDF response before Chromium navigates to its native PDF
    // viewer, which can invalidate Playwright's later response.body() call.
    context.newCDPSession(target).then(async session => {
      const pdfRequests = new Map();
      const responseReceived = event => {
        if (trustedUrl(event.response.url, portal) && /application\/pdf/i.test(event.response.mimeType || '')) {
          pdfRequests.set(event.requestId, event.response.url);
        }
      };
      const loadingFinished = event => {
        const sourceUrl = pdfRequests.get(event.requestId);
        if (!sourceUrl) return;
        pdfRequests.delete(event.requestId);
        session.send('Network.getResponseBody', { requestId: event.requestId }).then(body => {
          const data = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body, 'utf8');
          persistPdf(data, 'municipal-manual-official-pdf-response', sourceUrl);
        }).catch(error => { if (!settled && !downloadCaptureStarted) emit({ type: 'municipal_download_invalid', portal: portal.key, sourceUrl: safeMunicipalUrl(sourceUrl), message: `Não foi possível obter o corpo PDF da resposta oficial: ${error.message}` }); });
      };
      await session.send('Network.enable');
      session.on('Network.responseReceived', responseReceived);
      session.on('Network.loadingFinished', loadingFinished);
      listeners.push(() => { session.off('Network.responseReceived', responseReceived); session.off('Network.loadingFinished', loadingFinished); session.detach().catch(() => {}); });
    }).catch(error => emit({ type: 'municipal_pdf_monitor_warning', portal: portal.key, message: `Monitor de resposta PDF indisponível nesta aba: ${error.message}` }));
    // Alguns portais abrem um relatório em uma nova aba antes do download.
    if (browser.connectedToExistingChrome) {
      prepareControlledDownloadDir(target, baseDir, cnpj, emit, portal.key).then(dir => downloadDirs.add(dir)).catch(() => {});
    }
  };

  for (const target of context.pages()) attachPage(target);
  const onNewPage = target => attachPage(target);
  context.on('page', onNewPage);
  listeners.push(() => context.off('page', onNewPage));
  let stopDirectoryWatch = false;
  const directoryWatch = downloadDirs.size ? (async () => {
    while (!stopDirectoryWatch && !settled && !browser.closed) {
      for (const dir of downloadDirs) {
        const recovered = await waitForPdfInDirectory(dir, 500);
        if (!recovered) continue;
        fs.writeFileSync(filePath, recovered.pdfBuffer);
        finish({ filePath, captureStage: 'municipal-manual-controlled-download' });
        return;
      }
    }
  })() : Promise.resolve();

  const message = 'Conclua a emissão manualmente no portal oficial aberto. Quando baixar ou abrir o PDF da certidão, a Central vai capturá-lo e arquivá-lo automaticamente nesta empresa. Use Parar para cancelar.';
  emit({ type: 'municipal_manual_issuance', portal: portal.key, url: page.url(), message: 'Portal municipal oficial aberto; aguardando a emissão e o download manual do documento.' });
  if (typeof browser.focusInteractiveWindow === 'function') await browser.focusInteractiveWindow(page);
  else await page.bringToFront?.().catch(() => {});
  emit({ type: 'human_action_required', portal: portal.key, manualDownloadRequired: true, message });

  let activeResumeResolver = null;
  try {
    while (!browser.closed) {
      const resumePromise = new Promise(resolve => {
        activeResumeResolver = () => resolve('resume');
        browser.resumeResolver = activeResumeResolver;
      });
      const result = await Promise.race([resultPromise, resumePromise]);
      if (result && typeof result === 'object') return result;
      if (browser.closed) return null;

      emit({ type: 'manual_resume', portal: portal.key, message: 'Usuário pediu para verificar se o PDF municipal foi baixado.' });
      const recovered = downloadDir ? await waitForPdfInDirectory(downloadDir, 2500) : null;
      if (recovered) {
        fs.writeFileSync(filePath, recovered.pdfBuffer);
        return { filePath, captureStage: 'municipal-manual-controlled-download' };
      }
      emit({ type: 'human_action_required', portal: portal.key, manualDownloadRequired: true, manualUploadRequired: true, message: 'Não consegui capturar o arquivo do navegador. Baixe o PDF emitido no portal e clique em “Anexar PDF municipal” para enviá-lo, informar o código de autenticação e confirmar a conferência no site oficial. A consulta permanecerá aberta.' });
    }
    return null;
  } finally {
    stopDirectoryWatch = true;
    await directoryWatch.catch(() => {});
    if (browser.resumeResolver === activeResumeResolver) browser.resumeResolver = null;
    if (browser.acceptManualMunicipalPdf !== previousManualHandler) browser.acceptManualMunicipalPdf = previousManualHandler || null;
    for (const cleanup of listeners) cleanup();
  }
}

async function fillCnpj(page, selectors, cnpj, portalKey = '') {
  const digits = onlyDigits(cnpj);
  const formatted = digits.length === 14
    ? digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : digits;

  // A Receita Federal passou a exigir/validar a apresentação do CNPJ
  // no formato da máscara no campo visual. Os demais portais podem aceitar
  // somente os 14 dígitos; por isso testamos o formato adequado ao campo.
  const candidates = portalKey === 'federal' ? [formatted, digits] : [digits, formatted];

  for (const scope of page.frames()) {
  for (const selector of (selectors?.cnpj || [])) {
    try {
      const matches = scope.locator(selector); const matchCount = await matches.count();
      if (!matchCount) continue;
      for (let matchIndex=0; matchIndex<matchCount; matchIndex++) {
      const loc = matches.nth(matchIndex);
      if (!(await loc.isVisible())) continue;
      if (['radio','checkbox','hidden','submit','button'].includes(await loc.getAttribute('type'))) continue;

      const maxLength = Number(await loc.getAttribute('maxlength').catch(() => '')) || 0;
      const placeholder = String(await loc.getAttribute('placeholder').catch(() => '') || '').toLowerCase();
      const pattern = String(await loc.getAttribute('pattern').catch(() => '') || '').toLowerCase();
      const prefersFormatted = portalKey === 'federal' || maxLength >= 18 || /[.\/-]/.test(placeholder) || /[.\/-]/.test(pattern);
      const ordered = prefersFormatted ? [formatted, digits] : candidates;

      for (const value of ordered) {
        await loc.click({ timeout: 5000 }).catch(() => {});
        await loc.press('Control+A').catch(() => {});
        await loc.press('Backspace').catch(() => {});
        // Usa digitação real para disparar as rotinas de validação do portal.
        await loc.pressSequentially(value, { delay: 25, timeout: 10000 }).catch(async () => {
          await loc.fill(value, { timeout: 5000 });
        });
        await loc.press('Tab').catch(() => {});
        await page.waitForTimeout(1200);

        const raw = String(await loc.inputValue().catch(() => ''));
        const normalized = raw.replace(/\D/g, '');
        if (normalized === digits) {
          return true;
        }

        // Fallback para inputs controlados por framework.
        await loc.evaluate((el, value) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(el, value); else el.value = value;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, value).catch(() => {});
        await page.waitForTimeout(800);
        const raw2 = String(await loc.inputValue().catch(() => ''));
        if (raw2.replace(/\D/g, '') === digits) return true;
    }
    }
    } catch (_) {}
  }
  }
  return false;
}

async function clickFirstVisible(page, selectors) {
  for (const scope of page.frames()) {
  for (const selector of selectors || []) {
    try {
      const loc = typeof selector === 'string' ? scope.locator(selector).first() : selector;
      if (!(await loc.count())) continue;
      const type = String(await loc.getAttribute('type').catch(() => '') || '').toLowerCase();
      if (['radio', 'checkbox'].includes(type)) {
        await loc.check({ force: true, timeout: 7000 }).catch(async () => {
          const id = await loc.getAttribute('id').catch(() => '');
          if (id) await scope.locator(`label[for="${id}"]`).first().click({ timeout: 7000 });
        });
        if (await loc.isChecked().catch(() => false)) return true;
      }
      if (await loc.isVisible() && await loc.isEnabled().catch(() => true)) {
        await loc.click({ timeout: 7000 });
        return true;
      }
    } catch (_) {}
  }
  }
  return false;
}

// Submission barrier: never send a form action while a visible, blocking
// human verification is present. The check is intentionally generic and is
// performed immediately before every submit-like action.
async function ensureCaptchaClearBeforeSubmit({ page, browser, emit, portal, stage }) {
  let current = page;
  const state = await browser.captchaState(current).catch(() => ({ captcha_active:false, blocking:false }));
  emit({ type: 'captcha_before_submit', portal: portal.key, stage, detected: state.detected !== undefined ? !!state.detected : !!state.captcha_active,
    active: !!state.captcha_active, blocking: !!state.blocking, provider: state.provider || null,
    evidence: state.evidence || [], submitAttempted: false, submitBlockedByCaptcha: !!(state.captcha_active && state.blocking) });
  if (!(state.captcha_active && state.blocking)) return { page: current, allowed: true };
  emit({ type: 'submit_blocked_by_captcha', portal: portal.key, stage, submitAttempted: false,
    submitBlockedByCaptcha: true, captcha: state });
  const resumed = await browser.waitForCaptcha(current, 'Conclua a verificação humana na janela do órgão. Depois clique em Continuar na Central para retomar a consulta.', 600000, true, true);
  emit({ type: 'captcha_after_user_interaction', portal: portal.key, stage });
  const after = await browser.captchaState(current).catch(() => ({ captcha_active:false, blocking:false }));
  const solved = after.solved || await Promise.resolve(browser.captchaSolved ? browser.captchaSolved(current) : false).catch(() => false);
  if ((!resumed || after.captcha_active && after.blocking) && !solved) return { page: current, allowed: false, captcha: after };
  return { page: current, allowed: true, captcha: after };
}

async function capturePdfFromClick(page, context, selectors, timeout = 30000, browser = null, stopWhen = null) {
  for (const scope of page.frames()) {
  for (const selector of selectors || []) {
    try {
      const loc = typeof selector === 'string' ? scope.locator(selector).first() : selector;
      if (!(await loc.count())) {
        await loc.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
      }
      if (!(await loc.count()) || !(await loc.isVisible().catch(() => false))) continue;

      const downloadPromise = page.waitForEvent('download', { timeout }).catch(() => null);
      const popupPromise = page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
      const navigationPromise = page.waitForNavigation({ timeout }).catch(() => null);
      const pdfResponsePromise = page.waitForResponse(r => {
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        return ct.includes('application/pdf') || ct.includes('application/x-pdf');
      }, { timeout: timeout }).catch(() => null);
      await loc.click({ timeout: 7000 });

      // Alguns portais exibem uma tela/formulário intermediário e só depois
      // abrem o documento real. Não capture a página atual imediatamente ao
      // clicar em Imprimir; primeiro aguarde popup, navegação ou resposta PDF.

      // O Fisco Web navega para uma URL assinada /imprimir/ exibida pelo
      // leitor de PDF do Chrome, sem disparar um download tradicional.
      const eventSignals = [
        downloadPromise.then(download => download ? ({ kind: 'download', download }) : null),
        popupPromise.then(popup => popup ? ({ kind: 'popup', popup }) : null),
        navigationPromise.then(response => response ? ({ kind: 'navigation', response }) : null),
        pdfResponsePromise.then(response => response ? ({ kind: 'response', response }) : null)
      ];
      let winner = null;
      for (let attempt = 0; attempt < 32; attempt++) {
        winner = await Promise.race([...eventSignals, page.waitForTimeout(250).then(() => null)]);
        if (winner) break;
        if (stopWhen && await Promise.resolve(stopWhen()).catch(() => false)) return { intermediate: true, page };
        const printPage = context.pages().find(candidate => /\/imprimir\//i.test(candidate.url()));
        if (printPage) {
          try {
            const response = await fetch(printPage.url(), { signal: AbortSignal.timeout(12000) });
            const body = Buffer.from(await response.arrayBuffer());
            if (response.ok && looksLikePdf(body)) return { download: null, page: printPage, pdfBuffer: body };
          } catch (_) {}
        }
        const captcha = await browser?.captchaState(page).catch(() => null);
        if (captcha?.captcha_active && captcha?.blocking) return { captchaRequired: true };
      }

      if (!winner) {
        if (stopWhen) return null;
        winner = await Promise.race([...eventSignals, page.waitForTimeout(timeout).then(() => null)]);
      }
      if (winner?.kind === 'download') return { download: winner.download, page: null };
      if (stopWhen && await Promise.resolve(stopWhen()).catch(() => false)) return { intermediate: true, page };

      const popup = winner?.kind === 'popup' ? winner.popup : null;
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        const pdf = await extractPdfResponse(popup, timeout);
        if (pdf) return { download: null, page: popup, pdfBuffer: pdf };
        const popupText = await popup.locator('body').innerText({ timeout: 3000 }).catch(() => '');
        if (/Certid[aã]o Negativa de D[eé]bitos Estaduais/i.test(popupText)) {
          const printed = await printPageToPdf(popup);
          if (printed) return { download: null, page: popup, pdfBuffer: printed };
        }
      }

      const pdfResponse = ['response','navigation'].includes(winner?.kind) ? winner.response : null;
      if (pdfResponse) {
        try {
          const contentType = String(pdfResponse.headers()['content-type'] || '').toLowerCase();
          const body = await pdfResponse.body();
          if (contentType.includes('pdf') || looksLikePdf(body)) return { download: null, page, pdfBuffer: body };
        } catch (_) {}
      }

      // Alguns portais abrem o PDF no visualizador interno do Chrome. Nesse
      // caso o popup pode surgir depois de outra espera da corrida terminar.
      // Inspeciona todas as páginas da sessão e confirma o conteúdo pelo MIME.
      for (const candidate of [...context.pages()].reverse()) {
        if (candidate.isClosed()) continue;
        const candidatePdf = await extractPdfResponse(candidate, 12000);
        if (candidatePdf) return { download: null, page: candidate, pdfBuffer: candidatePdf };
        // URLs assinadas de impressão costumam ser públicas e o visualizador
        // do Chrome pode ocultar a resposta da sessão CDP. Recupera a mesma
        // URL diretamente e só aceita o resultado quando ele é de fato PDF.
        if (/\/imprimir\//i.test(candidate.url())) {
          try {
            const response = await fetch(candidate.url(), { signal: AbortSignal.timeout(12000) });
            const body = Buffer.from(await response.arrayBuffer());
            if (response.ok && looksLikePdf(body)) return { download: null, page: candidate, pdfBuffer: body };
          } catch (_) {}
        }
      }

      const pdf = await extractPdfResponse(page, 12000);
      if (pdf) return { download: null, page, pdfBuffer: pdf };
      // Eusébio navigates to a rendered certificate and then opens the
      // browser print preview. Wait for the certificate content behind that
      // preview before generating our own PDF from the page.
      await page.locator('body').waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
      await page.waitForFunction(() => {
        const t = document.body?.innerText || '';
        return /v[aá]lida\s+at[eé]|c[oó]d\.?\s+de\s+valida[cç][aã]o|certid[aã]o negativa/i.test(t)
          && /documento|cnpj|contribuinte/i.test(t);
      }, { timeout: 10000 }).catch(() => {});
      const pageText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      const intermediateForm = /dados\s+para\s+emiss[aã]o|tipo\s+de\s+filtro|certid[aã]o negativa contribuinte/i.test(pageText)
        && !/v[aá]lida\s+at[eé]|certid[aã]o emitida|data de validade|vencimento/i.test(pageText);
      if (!intermediateForm && /Certid[aã]o Negativa|certid[aã]o emitida|data de validade|vencimento/i.test(pageText)) {
        const printed = await printPageToPdf(page);
        if (printed) return { download: null, page, pdfBuffer: printed };
      }
    } catch (_) {}
  }
  }
  return null;
}

function federalDate(value) {
  const match = String(value || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
}

// When Receita reports an existing valid certificate, consult the issued
// records and retrieve its second copy. Issuing another certificate can fail
// for a company that already has a valid document, even though the official
// second-copy route works.
async function captureExistingFederalSecondCopy(page, context, cnpj, browser, emit) {
  const notice = page.getByText(/Certidão Válida Encontrada/i).first();
  const noticeVisible = await notice.isVisible().catch(() => false);
  if (!noticeVisible) return null;
  const dialog = page.locator('[role="dialog"],dialog,.br-modal,[aria-modal="true"]').filter({ hasText: /Certidão Válida Encontrada/i }).first();
  const scope = await dialog.isVisible().catch(() => false) ? dialog : page;
  const consult = scope.getByRole('button', { name: 'Consultar Certidão', exact: true }).last();
  if (!await consult.isVisible().catch(() => false) || !await consult.isEnabled().catch(() => false)) {
    throw new Error('A Receita informou que há certidão válida, mas a opção oficial “Consultar Certidão” não está disponível. Nenhuma nova emissão foi solicitada.');
  }
  emit({ type: 'federal_valid_certificate_found', portal: 'federal', message: 'A Receita encontrou uma certidão válida. Consultando o histórico oficial para emitir a segunda via.' });
  await consult.click({ timeout: 7000 });

  const results = page.locator('table tbody tr:visible');
  const search = page.getByRole('button', { name: 'Consultar Certidão', exact: true }).last();
  const queryForm = page.getByRole('textbox', { name: 'Data Inicial', exact: true });
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (await results.count().catch(() => 0)) break;
    if (await queryForm.isVisible().catch(() => false) && await search.isVisible().catch(() => false)) {
      const body = await page.locator('body').innerText().catch(() => '');
      if (!body.replace(/[.\/\-\s]/g, '').includes(onlyDigits(cnpj))) {
        throw new Error('A consulta de certidões existentes da Receita não confirmou o CNPJ informado.');
      }
      const from = queryForm;
      const to = page.getByRole('textbox', { name: 'Data Final', exact: true });
      const fromValue = String(await from.inputValue().catch(() => '')).trim();
      const toValue = String(await to.inputValue().catch(() => '')).trim();
      // Do not submit an incomplete or ambiguous search range. Keep the
      // session open with an explicit diagnostic instead of guessing dates.
      if (!federalDate(fromValue) || !federalDate(toValue) || federalDate(fromValue) > federalDate(toValue)) {
        throw new Error('A Receita abriu a consulta de certidões existentes, mas o período de pesquisa está vazio ou inválido. Confira a janela do órgão; nenhuma nova emissão foi solicitada.');
      }
      emit({ type: 'federal_existing_search', portal: 'federal', message: 'Pesquisando certidões anteriores no período exibido pela Receita.' });
      await search.click({ timeout: 7000 });
      await page.waitForTimeout(200);
      continue;
    }
    await page.waitForTimeout(250);
  }

  const body = await page.locator('body').innerText().catch(() => '');
  if (!body.replace(/[.\/\-\s]/g, '').includes(onlyDigits(cnpj))) throw new Error('O resultado da consulta de certidões da Receita não confirma o CNPJ esperado.');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const candidates = [];
  const rows = page.locator('table tbody tr:visible');
  for (let i = 0; i < await rows.count(); i++) {
    const row = rows.nth(i), cells = await row.locator('td').allTextContents().catch(() => []);
    if (!cells.some(value => /^\s*Válida\s*$/i.test(value))) continue;
    const expiry = cells.map(federalDate).filter(Boolean).at(-1);
    if (!expiry || (Date.parse(`${expiry}T00:00:00`) - today.getTime()) / 86400000 < 0) continue;
    const secondCopy = row.locator('button[title="Segunda via"],a[title="Segunda via"],[aria-label="Segunda via"]');
    if (await secondCopy.isVisible().catch(() => false) && await secondCopy.isEnabled().catch(() => false)) candidates.push({ expiry, rowIndex: i });
  }
  candidates.sort((a, b) => b.expiry.localeCompare(a.expiry));
  if (!candidates.length) {
    throw new Error('A Receita confirmou uma certidão existente, mas a pesquisa não apresentou segunda via válida para o CNPJ. Confira os filtros na janela do órgão; a Central não enviou uma emissão duplicada.');
  }
  const chosen = candidates[0], selector = `table tbody tr:nth-of-type(${chosen.rowIndex + 1}) button[title="Segunda via"], table tbody tr:nth-of-type(${chosen.rowIndex + 1}) a[title="Segunda via"], table tbody tr:nth-of-type(${chosen.rowIndex + 1}) [aria-label="Segunda via"]`;
  emit({ type: 'federal_existing_second_copy', portal: 'federal', validade: chosen.expiry, message: `Certidão válida encontrada até ${chosen.expiry.split('-').reverse().join('/')}. Solicitando a segunda via oficial.` });
  const captured = await capturePdfFromClick(page, context, [selector], 30000, browser);
  if (!captured?.download && !captured?.pdfBuffer) throw new Error('A Receita listou uma certidão válida, mas não foi possível capturar a resposta da segunda via. A consulta permanece pendente; nenhum PDF foi arquivado.');
  return captured;
}

// The Receita SPA can render its cookie notice several seconds after the
// document and CNPJ form. Do not submit the CNPJ until the landing screen has
// settled and any late consent notice has been handled.
async function waitForFederalLanding({ page, job, emit, minimumMs = 8500, timeoutMs = 25000 }) {
  const started = Date.now();
  let lastSnapshot = '';
  let stableSince = 0;
  let lastCookieCheck = 0;
  emit({ type: 'federal_loading_wait', portal: 'federal', message: 'Aguardando o portal da Receita carregar antes de enviar o CNPJ.' });

  while (Date.now() - started < timeoutMs) {
    if (page.isClosed()) throw new Error('A aba da Receita Federal foi fechada durante o carregamento inicial.');
    if (Date.now() - lastCookieCheck >= 500) {
      lastCookieCheck = Date.now();
      const cookies = await handleFederalCookies(page, job, event => emit({ ...event, portal: 'federal' }));
      if (cookies?.status === 'awaiting_response') {
        emit({ type: 'federal_flow_progress', portal: 'federal', stage: 'cookies', message: cookies.message });
      } else if (cookies?.status === 'awaiting_user') {
        return { ready: false, interactionRequired: true, message: cookies.message };
      }
    }

    const snapshot = await page.evaluate(() => {
      const visible = el => !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
      const controls = [...document.querySelectorAll('input,button,[role="radio"],a')]
        .filter(visible)
        .map(el => `${el.tagName}:${el.getAttribute('name') || el.id || el.getAttribute('aria-label') || el.value || el.innerText || ''}:${el.disabled ? 'disabled' : 'enabled'}`)
        .join('|');
      return JSON.stringify({ ready: document.readyState, busy: !!document.querySelector('[aria-busy="true"]'), text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 3000), controls });
    }).catch(() => '');
    if (snapshot && snapshot === lastSnapshot) stableSince ||= Date.now();
    else stableSince = 0;
    lastSnapshot = snapshot;

    const pageState = snapshot ? JSON.parse(snapshot) : null;
    const ready = pageState && Date.now() - started >= minimumMs && stableSince && Date.now() - stableSince >= 1200
      && !pageState.busy && pageState.ready === 'complete';
    if (ready) return { ready: true };
    await page.waitForTimeout(250);
  }
  return { ready: false, interactionRequired: false, message: 'A página da Receita não estabilizou dentro do prazo inicial; o CNPJ não foi enviado.' };
}

async function saveFederalErrorDiagnostic({ page, baseDir, cnpj, portalError }) {
  const dir = path.join(baseDir, 'data', 'diagnostics');
  fs.mkdirSync(dir, { recursive: true });
  const stem = `federal-${onlyDigits(cnpj)}-${Date.now()}-${portalError.portalCode}`;
  const screenshotPath = path.join(dir, `${stem}.png`);
  const jsonPath = path.join(dir, `${stem}.json`);
  const dom = await page.evaluate(() => {
    const visible = el => !!el.getClientRects().length && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
    const interactive = [...document.querySelectorAll('button,input,select,textarea,a,[role="button"],[role="radio"]')]
      .filter(visible).slice(0, 100).map(el => ({
        tag: el.tagName, type: el.type || '', id: el.id || '', name: el.getAttribute('name') || '',
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 160),
        disabled: !!el.disabled
      }));
    return { title: document.title, text: (document.body?.innerText || '').slice(0, 12000), interactive };
  }).catch(error => ({ title: '', text: '', interactive: [], domError: String(error?.message || error) }));
  await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 10000 }).catch(() => {});
  const diagnostic = {
    capturedAt: new Date().toISOString(), portal: 'federal', url: page.url(),
    portalCode: portalError.portalCode, occurrence: portalError.occurrence,
    screenshotPath: fs.existsSync(screenshotPath) ? screenshotPath : null,
    ...dom
  };
  fs.writeFileSync(jsonPath, JSON.stringify(diagnostic, null, 2), 'utf8');
  return { diagnosticPath: jsonPath, screenshotPath: diagnostic.screenshotPath, url: diagnostic.url };
}

// Follow the Receita PJ flow: select Pessoa Jurídica, accept cookies, enter
// the CNPJ, click Emitir Certidão, and handle either the valid-copy history
// or the newly generated document.
async function runFederalReceitaFlow({ page, browser, portal, cnpj, baseDir, emit }) {
  const context = browser.context;
  const downloadDir = await prepareControlledDownloadDir(page, baseDir, cnpj, emit, 'federal');
  const federalPortal = {
    ...portal,
    allowedHosts: portal.allowedHosts?.length ? portal.allowedHosts : ['servicos.receitafederal.gov.br']
  };
  const job = {
    id: 'central-federal-session', mode: 'issue', status: 'running',
    cnpj: onlyDigits(cnpj), portal: federalPortal, context,
    captureFederalAction: async (locator, options = {}) => {
      const captured = await capturePdfFromClick(page, context, [locator], 30000, browser, options.stopWhen || null);
      if (captured?.intermediate) return { ...captured, downloadDir };
      if (captured?.download || captured?.pdfBuffer || captured?.captchaRequired) return { ...captured, downloadDir };
      const recovered = await waitForPdfInDirectory(downloadDir, 5000);
      return recovered ? { ...recovered, downloadDir } : null;
    }
  };
  const landing = await waitForFederalLanding({ page, job, emit });
  if (!landing.ready && landing.interactionRequired) {
    emit({ type: 'human_action_required', portal: 'federal', message: landing.message });
    await browser.waitForHumanResume(landing.message);
  } else if (!landing.ready) {
    throw new Error(landing.message);
  }
  const startedAt = Date.now();
  const deadline = startedAt + 150000;
  let newestCopyRequested = false;

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('A aba da Receita Federal foi fechada antes da emissão.');

    const bodyBefore = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
    const portalError = classifyFederalPortalError(bodyBefore);
    if (portalError) {
      const diagnostic = await saveFederalErrorDiagnostic({ page, baseDir, cnpj, portalError });
      emit({ type: 'portal_response_error', portal: 'federal', status: portalError.category, code: portalError.portalCode, occurrence: portalError.occurrence, message: portalError.message });
      emit({ type: 'federal_portal_error_diagnostic', portal: 'federal', ...diagnostic, message: `Diagnóstico da resposta ${portalError.portalCode} salvo para análise.` });
      const error = new Error(portalError.message);
      error.code = portalError.category;
      error.portalCode = portalError.portalCode;
      throw error;
    }

    const captcha = await browser.captchaState(page).catch(() => ({ captcha_active: false, blocking: false }));
    if (captcha.captcha_active && captcha.blocking) {
      emit({ type: 'federal_captcha_wait', portal: 'federal', message: 'A consulta federal aguarda a validação humana no portal oficial.' });
      const resumed = await browser.waitForCaptcha(
        page,
        'Resolva a verificação na página oficial da Receita e clique em Continuar na Central.',
        federalPortal.captchaTimeout || 600000,
        false,
        true
      );
      if (!resumed) throw new Error('A verificação da Receita continua bloqueando a consulta.');
      continue;
    }

    const emitted = [];
    const result = await advanceIssuer(job, event => {
      emitted.push(event);
      emit({ ...event, portal: 'federal' });
    });
    if (result?.message) emit({ type: 'federal_flow_progress', portal: 'federal', stage: result.status || 'analisando', message: result.message });

    if (result?.captured?.captchaRequired) continue;
    if (result?.captured?.download || result?.captured?.pdfBuffer) {
      const buffer = result.captured.pdfBuffer;
      emit({ type: 'federal_pdf_capture_detected', portal: 'federal', method: result.captured.download ? 'download' : 'response', bytes: buffer?.length || 0, pdfHeader: buffer?.subarray(0, 8).toString('latin1') || '' });
      return result.captured;
    }
    if (emitted.some(event => event.type === 'federal_latest_certificate_selected')) {
      newestCopyRequested = true;
      throw new Error('A Receita apresentou a certidão válida mais recente, mas não entregou um PDF após a solicitação da segunda via. Nenhum documento foi arquivado.');
    }

    if (result?.status === 'awaiting_user') {
      emit({ type: 'human_action_required', portal: 'federal', message: result.message });
      await browser.waitForHumanResume(result.message);
      continue;
    }

    // The SPA updates the Angular component after each exact action. Give that
    // transition a short window before asking the resolver for the next step.
    await page.waitForTimeout(600);
  }

  if (newestCopyRequested) throw new Error('A Receita não concluiu o download da segunda via mais recente.');
  throw new Error('A consulta federal excedeu o limite aguardando uma etapa da Receita. Confira a janela do portal; a certidão não foi marcada como emitida.');
}

async function saveFederalCapture({ capture, cnpj, baseDir, emit }) {
  if (!capture?.download && !capture?.pdfBuffer) throw new Error('A Receita não forneceu o PDF da certidão.');
  const dir = path.join(baseDir, 'data', 'certidoes', onlyDigits(cnpj), new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'CND FEDERAL.pdf');
  if (capture.download) {
    try {
      await saveDownloadAsPdf(capture.download, filePath);
    } catch (saveError) {
      const recovered = capture.downloadDir ? await waitForPdfInDirectory(capture.downloadDir, 10000) : null;
      if (!recovered) throw saveError;
      fs.writeFileSync(filePath, recovered.pdfBuffer);
      emit({ type: 'download_recovered', portal: 'federal', sourcePath: recovered.sourcePath, message: 'PDF recuperado da pasta controlada do Chrome após a captura normal do download falhar.' });
    }
  }
  else if (looksLikePdf(capture.pdfBuffer)) fs.writeFileSync(filePath, capture.pdfBuffer);
  else throw new Error('A resposta da Receita não é um PDF válido; nenhum arquivo foi arquivado.');
  const rel = path.relative(path.join(baseDir, 'data'), filePath).split(path.sep).join('/');
  emit({ type: 'downloaded', portal: 'federal', filePath, fileUrl: '/files/' + rel, message: 'PDF oficial da Receita capturado e salvo.' });
  return { filePath };
}

async function captureExistingCertificate(page, context, config, emit) {
  if (!config?.container) return null;
  let modal = null;
  for (const scope of page.frames()) {
    const candidate = scope.locator(config.container).first();
    if (await candidate.isVisible().catch(() => false)) { modal = candidate; break; }
  }
  if (!modal) {
    await page.waitForTimeout(1200);
    for (const scope of page.frames()) {
      const candidate = scope.locator(config.container).first();
      if (await candidate.isVisible().catch(() => false)) { modal = candidate; break; }
    }
  }
  if (!modal) return null;
  const text = await modal.innerText().catch(() => '');
  const validity = text.match(/v[aá]lida\s+at[eé]\s+(\d{2}\/\d{2}\/\d{4})/i)?.[1] || '';
  emit({type:'existing_certificate_found',portal:'municipal',validade:validity,message:`Certidão municipal válida já existente${validity ? ` até ${validity}` : ''}. Reimprimindo o documento oficial.`});
  return capturePdfFromClick(page, context, config.reprintSelectors || [], 30000);
}

async function extractPdfResponse(page, timeout = 12000) {
  const url = page.url();
  if (/^https?:/i.test(url)) {
    try {
      const response = await page.request.get(url, { timeout });
      const ct = String(response.headers()['content-type'] || '').toLowerCase();
      const body = await response.body();
      if (ct.includes('pdf') || looksLikePdf(body)) return body;
    } catch (_) {}
  }
  return null;
}

async function recoverPdfFromPrintPages(context, timeout = 12000) {
  for (const candidate of [...context.pages()].reverse()) {
    const url = candidate.url();
    if (!/\/imprimir\//i.test(url)) continue;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
      const body = Buffer.from(await response.arrayBuffer());
      if (response.ok && looksLikePdf(body)) return body;
    } catch (_) {}
  }
  return null;
}

const normalText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();

async function findSafeContinuation(context) {
  const choices=[];
  for(const candidatePage of [...context.pages()].reverse()) {
    if(candidatePage.isClosed()) continue;
    for(const frame of candidatePage.frames()) {
      const elements=frame.locator('button, input[type="submit"], input[type="button"], [role="button"], a.btn, a[role="button"], a:has(img[src*="pdf" i]), a[href*="pdf" i]');
      const count=Math.min(await elements.count().catch(()=>0),80);
      for(let i=0;i<count;i++) {
        const element=elements.nth(i);
        if(!await element.isVisible().catch(()=>false) || !await element.isEnabled().catch(()=>false)) continue;
        const info=await element.evaluate(el=>{
          const container=el.closest('[role="dialog"],dialog,.modal,[aria-modal="true"],form,section,main')||el.parentElement;
          return {text:(el.innerText||el.value||el.getAttribute('aria-label')||el.title||'').trim(),context:(container?.innerText||'').trim().slice(0,1600),tag:el.tagName,role:el.getAttribute('role')||'',name:el.getAttribute('name')||'',id:el.id||''};
        }).catch(()=>null);
        if(!info)continue;
        const text=normalText(info.text),contextText=normalText(info.context);
        const pdfAction=await element.locator('img[src*="pdf" i]').count().catch(()=>0)>0||/pdf/i.test(info.name+' '+info.id+' '+info.text);
        const positive=pdfAction||/^(confirmar(?: certidao)?|continuar|prosseguir|gerar(?: certidao)?|emitir(?: nova)? certidao|emitir|visualizar(?: certidao)?|consultar(?: certidao)?)$/.test(text);
        const negative=/cancelar|sair|voltar|fechar|limpar|nova emissao|novo/.test(text);
        const issuance=/certidao|certificado|debitos?|emissao|geracao/.test(contextText);
        // A página de emissão costuma conter texto como "Emitir Certidão".
        // Isso sozinho não é uma confirmação intermediária. Exija uma pergunta
        // ou declaração de confirmação para não reenviar o formulário inicial.
        const modal=/confirm|deseja|tem certeza|ja existe|valida encontrada|válida encontrada|solicita.*emissao|prosseguir com/.test(contextText)&&/certidao|documento/.test(contextText);
        if(positive&&!negative&&issuance&&(pdfAction||modal||/dialog|modal/.test(normalText(`${info.role} ${info.id} ${info.name}`)))) choices.push({element,page:candidatePage,frame,info,pdfAction,score:(pdfAction?8:0)+(modal?5:0)+(text.includes('certidao')?3:0)+(text.startsWith('confirmar')?2:0)});
      }
    }
  }
  choices.sort((a,b)=>b.score-a.score);
  if(!choices.length)return null;
  if(choices.length>1&&choices[0].score===choices[1].score&&normalText(choices[0].info.text)!==normalText(choices[1].info.text))return null;
  return choices[0];
}

async function findMunicipalCertificateService(context, seen=new Set()) {
  const candidates=[];
  for (const page of [...context.pages()].reverse()) for (const frame of page.frames()) {
    const nodes=frame.locator('a,button,[role="button"],[onclick],.card,.service,.servico,.tile,.gpi-fav-card,[class*="service-card" i]');
    const count=Math.min(await nodes.count().catch(()=>0),160);
    for(let i=0;i<count;i++) {
      const el=nodes.nth(i); if(!await el.isVisible().catch(()=>false)||!await el.isEnabled().catch(()=>true)) continue;
      const info=await el.evaluate(e=>{const raw=(e.innerText||e.getAttribute('aria-label')||e.title||'').split(/\n/).map(x=>x.trim()).filter(Boolean);return {text:(raw[0]||'').replace(/\s+/g,' ').trim(),href:e.href||'',tag:e.tagName,id:e.id||'',className:String(e.className||'')}}).catch(()=>null); if(!info||!info.text) continue;
      const t=normalText(info.text); if([...seen].some(key=>key.includes(t+'|'+info.href)|| (t+'|'+info.href).includes(key))) continue;
      if (info.tag === 'IMG' && !info.href) continue;
      if(!/certidao|cnd|debito|tribut/.test(t)||/\b(iptu|itbi|alvara|acordo|tllf)\b/.test(t)&&!/certidao|cnd/.test(t)) continue;
      const score=(/certidao|cnd/.test(t)?6:0)+(/negativ|tribut|debito|contribuinte|fiscal/.test(t)?3:0);
      if(score>=7)candidates.push({element:el,page,frame,info,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score || a.info.text.length-b.info.text.length); return candidates[0]||null;
}

async function selectCnpjOption(page) {
  for (const frame of page.frames()) {
    const radios=frame.locator('input[type="radio"]'); const count=await radios.count().catch(()=>0);
    for(let i=0;i<count;i++){const radio=radios.nth(i);if(!await radio.isVisible().catch(()=>false))continue;const context=normalText(await radio.evaluate(e=>(e.closest('label,fieldset,div')||e.parentElement)?.innerText||'').catch(()=>''));if(/cnpj|pessoa juridica/.test(context)&&!(/cpf/.test(context)&&!/cnpj/.test(context))){await radio.check({force:true}).catch(()=>radio.click({force:true}));return true;}}
  }
  return false;
}

async function saveUnknownState({page,portal,baseDir,previousAction,emit,history}) {
  const dir=path.join(baseDir,'data','diagnostics',`${portal.key}-${Date.now()}`);fs.mkdirSync(dir,{recursive:true});
  const screenshot=path.join(dir,'screen.png'),htmlFile=path.join(dir,'page.html'),jsonFile=path.join(dir,'state.json');
  await page.screenshot({path:screenshot,fullPage:true}).catch(()=>{});
  const html=await page.content().catch(()=>'');fs.writeFileSync(htmlFile,html.slice(0,2_000_000));
  const interactive=await page.locator('button,input,select,a,[role="button"]').evaluateAll(nodes=>nodes.slice(0,100).map(el=>({tag:el.tagName,text:(el.innerText||el.value||el.getAttribute('aria-label')||'').trim(),id:el.id||'',name:el.getAttribute('name')||'',type:el.getAttribute('type')||''}))).catch(()=>[]);
  const diagnostic={status:'ESTADO_DESCONHECIDO',municipio:portal.name,url:page.url(),etapaAnterior:previousAction,history,interactive};fs.writeFileSync(jsonFile,JSON.stringify(diagnostic,null,2));
  emit({type:'unknown_state',status:'ESTADO_DESCONHECIDO',portal:portal.key,url:page.url(),diagnosticDir:dir,message:'O portal apresentou uma etapa que não pôde ser interpretada com segurança.'});
  return diagnostic;
}

async function continueIssuanceFlow({page,context,browser,portal,baseDir,emit,maxSteps=8,priorActionLabels=[]}) {
  const history=[];const seenServices=new Set();const attemptedActions=new Set();const priorLabels=new Set(priorActionLabels.map(normalText));let previousAction='emissão inicial';
  for(let step=1;step<=maxSteps;step++) {
    await page.waitForTimeout(800).catch(()=>{});
    if (portal.key === 'estadual-ce') {
      const responseError = classifyStateCePortalError(await page.locator('body').innerText().catch(() => ''));
      if (responseError) {
        emit({ type: 'portal_response_error', portal: portal.key, status: responseError.category, message: responseError.message });
        return { history, status: 'PORTAL_RESPONSE_ERROR', responseError };
      }
    }
    // Aguarda respostas assíncronas do portal antes de classificar a etapa.
    const loading=await page.locator('text=/Aguarde|Carregando|Processando/i').count().catch(()=>0);
    if(loading){ await page.waitForTimeout(4000).catch(()=>{}); }
    const pdfBuffer=await recoverPdfFromPrintPages(context,8000);if(pdfBuffer)return {pdfBuffer,history,status:'DOCUMENTO_GERADO'};
    for(const candidate of [...context.pages()].reverse()){const directPdf=await extractPdfResponse(candidate,5000);if(directPdf)return {pdfBuffer:directPdf,history,status:'DOCUMENTO_GERADO'};}
    const livePages=[...context.pages()].filter(p=>!p.isClosed());
    let captchaPage=null;for(const candidate of livePages){const captcha=await browser.captchaState(candidate);if(captcha.captcha_active&&captcha.blocking){captchaPage=candidate;break;}}
    if(captchaPage){emit({type:'human_action_required',status:'AGUARDANDO_INTERACAO_USUARIO',portal:portal.key,message:'Resolva o CAPTCHA e clique em Continuar na Central para retomar.'});const resumed=await browser.waitForCaptcha(captchaPage,'Conclua a verificação humana e depois clique em Continuar na Central.',600000,true,true);if(!resumed) continue;page=captchaPage;history.push({step,type:'captcha_resolvido',url:page.url()});continue;}
    if (portal.key === 'municipal') {
      const formVisible=await (async()=>{for(const frame of context.pages().flatMap(p=>p.frames()))for(const selector of (portal.selectors?.cnpj||[])){const loc=frame.locator(selector);const n=await loc.count().catch(()=>0);for(let i=0;i<n;i++)if(await loc.nth(i).isVisible().catch(()=>false))return true;}return false;})();
      if(formVisible) { /* já estamos no formulário; não reabrir o catálogo pelo breadcrumb */ }
      else {
      const service=await findMunicipalCertificateService(context,seenServices);
      if (service) { const action=service.info.text; seenServices.add(normalText(action)+'|'+service.info.href); emit({type:'service_catalog_detected',status:'CATALOGO_SERVICOS',portal:portal.key,action,url:service.page.url(),message:`Serviço de certidão identificado: ${action}`}); await service.element.click({timeout:7000}); history.push({step,action,url:service.page.url(),at:new Date().toISOString(),type:'service_navigation'}); previousAction=action; page=service.page; continue; }
      }
    }
    const next=await findSafeContinuation(context);
    if(!next){
      const documentAction=await (async()=>{
        for(const candidate of livePages){
          const selectors=['a[href*="impressao_documentos" i]','a:has-text("Imprimir")','button:has-text("Imprimir")','a:has-text("Visualizar")','button:has-text("Visualizar")'];
          for(const selector of selectors){const loc=candidate.locator(selector),n=await loc.count().catch(()=>0);for(let i=0;i<n;i++)if(await loc.nth(i).isVisible().catch(()=>false))return {page:candidate,selector};}
        } return null;
      })();
      if(documentAction){return {history,status:'DOCUMENTO_ACTION_AVAILABLE',documentAction};}
      const formReady=portal.key==='municipal'&&await (async()=>{for(const frame of livePages.flatMap(p=>p.frames()))for(const selector of (portal.selectors?.cnpj||[])){const loc=frame.locator(selector),n=await loc.count().catch(()=>0);for(let i=0;i<n;i++)if(await loc.nth(i).isVisible().catch(()=>false))return true;}return false;})();
      if(formReady)return {history,status:'FORMULARIO_CERTIDAO_ENCONTRADO'};
      await saveUnknownState({page:livePages.at(-1)||page,portal,baseDir,previousAction,emit,history});return {history,status:'ESTADO_DESCONHECIDO'};
    }
    if(next.pdfAction){return {history,status:'PDF_ACTION_AVAILABLE'};}
    const beforeUrl=next.page.url(),action=next.info.text;emit({type:'continuation_action',portal:portal.key,step,action,url:beforeUrl,message:`Etapa ${step}: ${action}`});
    const actionIdentity=[beforeUrl,next.info.tag,next.info.id,next.info.name,normalText(action)].join('|');
    const normalizedAction=normalText(action);
    const priorActionRepeated=priorLabels.has(normalizedAction)||([...priorLabels].includes('emitir certidao')&&normalizedAction==='emitir nova certidao');
    if(attemptedActions.has(actionIdentity)||priorActionRepeated) {
      emit({type:'continuation_duplicate_blocked',status:'ESTADO_DESCONHECIDO',portal:portal.key,action,url:beforeUrl,message:'A mesma ação permaneceu visível após o clique anterior; bloqueada para evitar reenvio ou loop.'});
      await saveUnknownState({page:next.page,portal,baseDir,previousAction:action,emit,history});
      return {history,status:'ESTADO_DESCONHECIDO'};
    }
    const gate = await ensureCaptchaClearBeforeSubmit({page: next.page, browser, emit, portal, stage: action});
    if (!gate.allowed) { history.push({step,action,type:'captcha_blocked'}); continue; }
    attemptedActions.add(actionIdentity);
    await next.element.click({timeout:7000});
    await next.page.waitForTimeout(1800).catch(()=>{});
    history.push({step,action,url:beforeUrl,at:new Date().toISOString()});previousAction=action;page=next.page;
  }
  emit({type:'continuation_limit',status:'ESTADO_DESCONHECIDO',portal:portal.key,history,message:`Limite de ${maxSteps} etapas atingido para evitar repetição.`});
  return {history,status:'ESTADO_DESCONHECIDO'};
}

async function waitForPdfNavigation(page, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (/\.pdf(?:$|[?#])/i.test(page.url())) {
      try {
        const response = await page.request.get(page.url(), { timeout: 10000 });
        const ct = response.headers()['content-type'] || '';
        if (ct.includes('pdf')) return await response.body();
      } catch (_) {}
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function printPageToPdf(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const result = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: 8.27,
      paperHeight: 11.69
    });
    const pdf = Buffer.from(result.data, 'base64');
    return looksLikePdf(pdf) ? pdf : null;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function printCertificatePageFromContext(context, cnpj, portalKey, timeout = 15000) {
  const digits = onlyDigits(cnpj);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const pages = context.pages().filter(p => !p.isClosed()).reverse();
    for (const candidate of pages) {
      try {
        const url = candidate.url();
        const body = await candidate.locator('body').innerText({ timeout: 1500 }).catch(() => '');
        const normalized = onlyDigits(body + ' ' + url);
        if (portalKey === 'estadual-ce') {
          const isStateCert = /consultarPdf/i.test(url) || /Certid[aã]o Negativa de D[eé]bitos Estaduais/i.test(body);
          if (isStateCert && normalized.includes(digits)) return await printPageToPdf(candidate);
        }
        if (portalKey === 'estadual-sp') {
          const isStateCert = /certid[aã]o negativa de d[eé]bitos tribut[aá]rios/i.test(body) && !/emiss[aã]o da certid[aã]o/i.test(body);
          if (isStateCert && normalized.includes(digits)) return await printPageToPdf(candidate);
        }
      } catch (_) {}
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
}


async function runPortal({ portal, cnpj, browser, baseDir, emit }) {
  if (portal.key === 'fgts') return require('./fgtsRunner').runFgts({portal,cnpj,browser,baseDir,emit});
  // Cada portal usa uma única aba e só a abre quando o portal anterior terminou.
  const page = await browser.newPortalPage();
  emit({ type: 'portal_opening', portal: portal.key, name: portal.name, url: portal.url });
  await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront().catch(() => {});
  if (portal.key === 'federal') {
    emit({ type: 'federal_flow_started', portal: 'federal', message: 'Executando o fluxo oficial da Receita: Pessoa Jurídica, cookies, CNPJ e Emitir Certidão.' });
    const capture = await runFederalReceitaFlow({ page, browser, portal, cnpj, baseDir, emit });
    return saveFederalCapture({ capture, cnpj, baseDir, emit });
  }
  if (portal.key === 'municipal') {
    const manual = await waitForManualMunicipalCertificate({ page, browser, portal, cnpj, baseDir, emit });
    if (!manual?.filePath) return null;
    emit({ type: 'downloaded', portal: portal.key, filePath: manual.filePath, fileUrl: '/files/' + path.relative(path.join(baseDir, 'data'), manual.filePath).split(path.sep).join('/'), captureStage: manual.captureStage, message: 'Certidão municipal baixada pelo usuário e capturada pela Central.' });
    return manual;
  }
  await page.waitForTimeout(portal.key === 'municipal' ? 6000 : 1800);
  if (portal.key === 'municipal') {
    await page.getByText(/certid[aã]o\s+negativa.*tributos|certid[aã]o.*d[eé]bitos/i).first().waitFor({state:'visible',timeout:20000}).catch(() => {});
  }

  for (const action of (portal.preActions || [])) {
    const clicked = await clickFirstVisible(page, action.selectors || []);
    emit({ type: 'pre_action', portal: portal.key, action: action.name || 'navegação', clicked });
    if (!clicked && action.required) {
      throw new Error(`O portal ${portal.name} não confirmou a etapa obrigatória: ${action.name || 'navegação'}.`);
    }
    if (clicked) await page.waitForTimeout(action.waitMs || 1800);
  }

  // Portais municipais como o GPI podem abrir primeiro um catálogo de
  // serviços. Navega até o serviço de certidão antes de procurar o CNPJ.
  if (portal.key === 'municipal') {
    const catalogSeen = new Set();
    for (let step = 1; step <= 5; step++) {
      const service = await findMunicipalCertificateService(browser.context, catalogSeen);
      if (!service) break;
      const label = service.info.text;
      catalogSeen.add(normalText(label) + '|' + service.info.href);
      emit({ type:'service_catalog_detected', status:'CATALOGO_SERVICOS', portal:portal.key, step, action:label, url:service.page.url(), message:`Serviço municipal localizado: ${label}` });
      await service.element.click({ timeout:7000 });
      await service.page.waitForTimeout(1800).catch(() => {});
      await service.page.waitForFunction(() => /dados para emiss[aã]o|cpf\/cnpj|tipo de filtro/i.test(document.body?.innerText||'') || [...document.querySelectorAll('input')].some(e => /__/.test(e.value||'')), {timeout:15000}).catch(() => {});
    }
  }

  if (portal.key === 'municipal') await selectCnpjOption(page);

  const captchaBeforeFill = await browser.captchaState(page).catch(() => ({captcha_active:false,blocking:false}));
  emit({type:'captcha_before_fill', portal:portal.key, detected:captchaBeforeFill.detected !== undefined ? !!captchaBeforeFill.detected : !!captchaBeforeFill.captcha_active, active:!!captchaBeforeFill.captcha_active, blocking:!!captchaBeforeFill.blocking, evidence:captchaBeforeFill.evidence||[]});
  let filled = await fillCnpj(page, portal.selectors, cnpj, portal.key);
  emit({ type: 'cnpj_fill', portal: portal.key, filled });
  if (!filled && ['fgts','trabalhista'].includes(portal.key)) {
    await browser.waitForHumanResume('Não localizei o campo CNPJ de '+portal.name+'. Preencha o CNPJ na aba do portal e clique em Continuar na Central.');
    if(page.isClosed()) throw new Error('A aba do portal foi fechada.');
    for(const frame of page.frames()) {
      const values=await frame.locator('input').evaluateAll(nodes=>nodes.map(n=>n.value)).catch(()=>[]);
      if(values.some(v=>onlyDigits(v)===onlyDigits(cnpj))) filled=true;
    }
  }
  if (!filled) {
    if (portal.key === 'municipal') {
      await saveUnknownState({page,portal,baseDir,previousAction:'catálogo/serviço municipal',emit,history:[]});
      throw new Error('ESTADO_DESCONHECIDO: portal municipal aberto, mas o formulário da certidão não foi localizado.');
    }
    throw new Error('CNPJ não confirmado no formulário de '+portal.name+'.');
  }
  if (filled) emit({ type:'form_detected', status:'FORMULARIO_CERTIDAO_ENCONTRADO', portal:portal.key, url:page.url(), message:'Formulário da certidão localizado e CNPJ preenchido.' });
  const captchaAfterFill = await browser.captchaState(page).catch(() => ({captcha_active:false,blocking:false}));
  emit({type:'captcha_after_fill', portal:portal.key, detected:captchaAfterFill.detected !== undefined ? !!captchaAfterFill.detected : !!captchaAfterFill.captcha_active, active:!!captchaAfterFill.captcha_active, blocking:!!captchaAfterFill.blocking, evidence:captchaAfterFill.evidence||[]});
  if (portal.key === 'municipal' && !(portal.afterCaptchaActions || []).length) {
    const gate = await ensureCaptchaClearBeforeSubmit({page, browser, emit, portal, stage:'municipal_form_enter'});
    if (!gate.allowed) throw new Error('AGUARDANDO_INTERACAO_USUARIO: CAPTCHA ainda bloqueia o envio.');
    for (const frame of page.frames()) {
      const inputs=frame.locator('input'); const n=await inputs.count().catch(()=>0);
      for(let i=n-1;i>=0;i--){const input=inputs.nth(i);const value=String(await input.inputValue().catch(()=>''));if(onlyDigits(value)===onlyDigits(cnpj)){await input.press('Enter').catch(()=>{});emit({type:'form_submit_attempt',portal:portal.key,method:'enter',message:'Formulário municipal sem botão explícito; consulta acionada pelo campo preenchido.'});break;}}
    }
    await page.waitForTimeout(3500).catch(()=>{});
  }

  // Alguns portais só apresentam o CAPTCHA depois que o usuário inicia a emissão.
  // A Receita Federal, em particular, precisa receber o comando de "Nova Certidão"
  // antes da validação humana.
  for (const action of (portal.beforeCaptchaActions || [])) {
    const clicked = await clickFirstVisible(page, action.selectors || []);
    emit({ type: 'before_captcha_action', portal: portal.key, action: action.name || 'iniciar emissão', clicked });
    if (!clicked) {
      throw new Error(`O portal ${portal.name} não apresentou a ação necessária para iniciar a emissão (${action.name || 'ação'}). O fluxo foi pausado para não avançar.`);
    }
    await page.waitForTimeout(action.waitMs || 2200);
  }

  // The Receita's cookie notice appears after the initial issuance click. The
  // active session runner must accept that exact official notice before
  // interpreting the valid-certificate modal or the temporary response 023.
  if (portal.key === 'federal') {
    let cookieResult = await handleFederalCookies(page, { id: 'central-session', portal }, event => emit({ ...event, portal: 'federal' }));
    if (cookieResult?.status === 'awaiting_user') {
      if (typeof browser.waitForHumanResume !== 'function') throw new Error(cookieResult.message);
      emit({ type: 'human_action_required', portal: 'federal', message: cookieResult.message });
      await browser.waitForHumanResume(cookieResult.message);
      if (page.isClosed()) throw new Error('A aba da Receita foi fechada durante a confirmação do aviso de cookies.');
      cookieResult = await handleFederalCookies(page, { id: 'central-session', portal }, event => emit({ ...event, portal: 'federal' }));
      if (cookieResult?.status === 'awaiting_user') throw new Error(cookieResult.message);
    }
  }

  let download = null;
  let pdfBuffer = null;
  let controlledDownloadDir = null;
  let federalCaptchaWasBlocking = false;
  const completedActionLabels = [];

  // A Receita pode concluir a navegação com uma mensagem informando que os
  // dados são insuficientes para emissão online. Isso é uma pendência apenas
  // da certidão federal; não deve bloquear as demais etapas da fila.
  if (portal.key === 'federal') {
    const existingCopy = await captureExistingFederalSecondCopy(page, browser.context, cnpj, browser, emit);
    if (existingCopy?.download) download = existingCopy.download;
    if (existingCopy?.pdfBuffer) pdfBuffer = existingCopy.pdfBuffer;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (!download && !pdfBuffer && (/informa(?:ç|c)[õo]es dispon[ií]veis.*insuficientes para emitir/i.test(bodyText) ||
        /dados.*insuficientes para emitir a certid[aã]o/i.test(bodyText))) {
      throw new Error('A Receita Federal informou que os dados são insuficientes para emitir a certidão pela Internet. A Central seguirá para a próxima certidão.');
    }
    const responseError = !download && !pdfBuffer ? classifyFederalPortalError(bodyText) : null;
    if (responseError) {
      emit({ type: 'portal_response_error', portal: 'federal', status: responseError.category, code: responseError.portalCode, occurrence: responseError.occurrence, message: responseError.message });
      const error = new Error(responseError.message);
      error.code = responseError.category;
      error.portalCode = responseError.portalCode;
      throw error;
    }
  }

  // A Receita pode abrir o modal "Certidão Válida Encontrada" antes do CAPTCHA.
  // Se isso ocorrer, recupera a 2ª via e não entra na espera do CAPTCHA.
  // Cada portal é concluído antes de iniciar o próximo. Para a Receita,
  // a etapa humana é obrigatória somente quando o fluxo realmente chegou ao CAPTCHA.
  if (!download && !pdfBuffer && portal.key === 'trabalhista') {
    await browser.waitForHumanResume('Na aba Trabalhista, digite os caracteres da imagem. Não clique em Emitir ainda; depois clique em Continuar aqui na Central para capturar o PDF.');
    if(page.isClosed()) throw new Error('A aba Trabalhista foi fechada.');
  } else if (!download && !pdfBuffer && portal.humanCaptcha !== false) {
    if (portal.key === 'federal') {
      const captchaState = await browser.captchaState(page).catch(() => ({captcha_active:false,blocking:false}));
      federalCaptchaWasBlocking = !!(captchaState.captcha_active && captchaState.blocking);
    }
    const captchaReady = await browser.waitForCaptcha(
      page,
      `Resolva o CAPTCHA na janela do portal ${portal.name}. Depois clique em Continuar na Central para retomar.`,
      portal.captchaTimeout || 300000,
      false,
      true
    );
    if (!captchaReady) {
      const state = await browser.captchaState(page).catch(() => ({ captcha_active:true, blocking:true }));
      if (state.captcha_active && state.blocking && !state.solved) {
        throw new Error('AGUARDANDO_INTERACAO_USUARIO: o CAPTCHA continua ativo depois de Continuar. Resolva-o na mesma aba e tente novamente.');
      }
    }
  }

  for (const action of ((download || pdfBuffer) ? [] : (portal.afterCaptchaActions || []))) {
    if (action.waitBeforeMs) await page.waitForTimeout(action.waitBeforeMs);
    let clicked = false;
    if (action.captureDownload) {
      if (!controlledDownloadDir) {
        controlledDownloadDir = await prepareControlledDownloadDir(page, baseDir, cnpj, emit, portal.key);
      }
      const result = await capturePdfFromClick(page, browser.context, action.selectors || [], action.downloadTimeout || 30000, browser);
      clicked = !!result;
      if (result?.download) download = result.download;
      if (result?.pdfBuffer) pdfBuffer = result.pdfBuffer;
      if (!download && !pdfBuffer) {
        await page.waitForTimeout(1500).catch(() => {});
        pdfBuffer = await recoverPdfFromPrintPages(browser.context);
        if (pdfBuffer) clicked = true;
      }
      if (!download && !pdfBuffer && controlledDownloadDir) {
        const recovered = await waitForPdfInDirectory(controlledDownloadDir, 5000);
        if (recovered) {
          pdfBuffer = recovered.pdfBuffer;
          clicked = true;
          emit({ type: 'download_recovered', portal: portal.key, message: 'PDF recuperado da pasta controlada desta emissão.' });
        }
      }
      if (pdfBuffer && !looksLikePdf(pdfBuffer) && controlledDownloadDir) {
        const recovered = await waitForPdfInDirectory(controlledDownloadDir, 10000);
        if (recovered) {
          pdfBuffer = recovered.pdfBuffer;
          emit({ type: 'download_recovered', portal: portal.key, message: 'PDF recuperado da pasta controlada desta emissão.' });
        }
      }
    } else {
      const gate = await ensureCaptchaClearBeforeSubmit({page, browser, emit, portal, stage: action.name || 'after_captcha_action'});
      if (gate.allowed) clicked = await clickFirstVisible(page, action.selectors || []);
    }
    // A standard CAPTCHA form needs one submit after the operator completes
    // it. Re-send the initial "Emitir Certidão" control only when an actual
    // blocking challenge was observed. Without that evidence, keep the button
    // from being clicked a second time just because it remains on screen.
    if (!clicked && portal.key === 'federal' && federalCaptchaWasBlocking && /emitir nova certidao/i.test((action.selectors||[]).join(' '))) {
      const gate = await ensureCaptchaClearBeforeSubmit({page,browser,emit,portal,stage:'federal_submit_after_captcha'});
      if (gate.allowed) clicked = await clickFirstVisible(page,[
        'button:has-text("Emitir Certidão")','a:has-text("Emitir Certidão")',
        'input[type=button][value*="Emitir Certidão" i]','input[type=submit][value*="Emitir Certidão" i]'
      ]);
    }
    emit({ type: 'after_captcha_action', portal: portal.key, action: action.name || 'ação pós-CAPTCHA', clicked });
    if (clicked) { completedActionLabels.push(action.name || ''); await page.waitForTimeout(action.waitMs || 2200); }
  }

  // GRPFOR de Fortaleza apresenta uma confirmação de reimpressão depois do
  // CAPTCHA. Capture essa etapa antes do resolvedor genérico: "Reimprimir
  // Certidão" é a ação legítima para obter a cópia oficial existente.
  if (!download && !pdfBuffer && portal.existingCertificate) {
    const existing = await captureExistingCertificate(page, browser.context, portal.existingCertificate, emit);
    if (existing?.download) download = existing.download;
    if (existing?.pdfBuffer) pdfBuffer = existing.pdfBuffer;
  }

  // A emissão pode abrir uma ou mais confirmações intermediárias depois da
  // ação inicial. Reavalia o DOM, modais, CAPTCHA e novas páginas até chegar a
  // um estado terminal, sem clicar em elementos fora do contexto da emissão.
  if (!download && !pdfBuffer) {
    const continuation = await continueIssuanceFlow({
      page, context: browser.context, browser, portal, baseDir, emit, maxSteps: 8, priorActionLabels:completedActionLabels
    });
    if (continuation.pdfBuffer) pdfBuffer = continuation.pdfBuffer;
    if (continuation.download) download = continuation.download;
    if (continuation.status === 'PORTAL_RESPONSE_ERROR') {
      const error = new Error(continuation.responseError.message);
      error.code = continuation.responseError.category;
      throw error;
    }
    if (continuation.status === 'ESTADO_DESCONHECIDO') {
      throw new Error('ESTADO_DESCONHECIDO: o portal apresentou uma etapa não interpretada com segurança.');
    }
  }

  if (!download && !pdfBuffer) {
    if ((portal.downloadButtons || []).length && !controlledDownloadDir) {
      controlledDownloadDir = await prepareControlledDownloadDir(page, baseDir, cnpj, emit, portal.key);
    }
    const result = await capturePdfFromClick(page, browser.context, portal.downloadButtons || [], 20000);
    if (result?.download) download = result.download;
    if (result?.pdfBuffer) pdfBuffer = result.pdfBuffer;
    if (!download && !pdfBuffer && controlledDownloadDir) {
      const recovered = await waitForPdfInDirectory(controlledDownloadDir, 10000);
      if (recovered) {
        pdfBuffer = recovered.pdfBuffer;
        emit({ type: 'download_recovered', portal: portal.key, message: 'PDF recuperado da pasta controlada desta emissão.' });
      }
    }
    if (pdfBuffer && !looksLikePdf(pdfBuffer) && controlledDownloadDir) {
      const recovered = await waitForPdfInDirectory(controlledDownloadDir, 10000);
      if (recovered) {
        pdfBuffer = recovered.pdfBuffer;
        emit({ type: 'download_recovered', portal: portal.key, message: 'PDF recuperado da pasta controlada desta emissão.' });
      }
    }
  }

  if (!download && !pdfBuffer && portal.provider === 'fisco-web') {
    pdfBuffer = await recoverPdfFromPrintPages(browser.context);
    if (pdfBuffer) emit({ type:'pdf_print_route_recovered', portal:portal.key, message:'PDF recuperado da rota oficial de impressão.' });
  }

  if (!download && !pdfBuffer) {
    pdfBuffer = await waitForPdfNavigation(page, 15000);
  }
  if (!download && !pdfBuffer && ['estadual-ce','estadual-sp'].includes(portal.key)) {
    pdfBuffer = await printCertificatePageFromContext(browser.context, cnpj, portal.key, 20000);
    if (pdfBuffer) {
      emit({ type: 'page_printed_to_pdf', portal: portal.key, message: 'PDF gerado a partir da página oficial da certidão.' });
    }
  }

  const dir = path.join(baseDir, 'data', 'certidoes', onlyDigits(cnpj), new Date().toISOString().slice(0,10));
  fs.mkdirSync(dir, { recursive: true });
  let filePath = null;
  if (download || pdfBuffer) {
    const canonicalNames = { federal: 'CND FEDERAL.pdf', fgts: 'CRF FGTS.pdf', trabalhista: 'CND TRABALHISTA.pdf', municipal: 'CND MUNICIPAL.pdf' };
    const canonicalName = portal.key.startsWith('estadual-') ? 'CND ESTADUAL.pdf' : canonicalNames[portal.key];
    filePath = path.join(dir, canonicalName || `${portal.shortName.replace(/[^a-z0-9]+/gi,'-')}.pdf`);
    if (download) {
      // Não confia no nome/extensão sugeridos pelo portal. O arquivo é salvo
      // temporariamente, validado pelo cabeçalho %PDF- e então recebe .pdf.
      try { await saveDownloadAsPdf(download, filePath); }
      catch(error) {
        const recovered = controlledDownloadDir ? await waitForPdfInDirectory(controlledDownloadDir, 20000) : null;
        if (!recovered) throw error;
        fs.writeFileSync(filePath, recovered.pdfBuffer);
        emit({type:'download_recovered',portal:portal.key,message:'PDF recuperado da pasta controlada desta emissão.'});
      }
    } else {
      if (!looksLikePdf(pdfBuffer)) {
        const recovered = controlledDownloadDir ? await waitForPdfInDirectory(controlledDownloadDir, 10000) : null;
        if (recovered) {
          fs.writeFileSync(filePath, recovered.pdfBuffer);
          emit({type:'download_recovered',portal:portal.key,message:'PDF recuperado da pasta controlada desta emissão.'});
        } else {
          throw new Error('O portal respondeu ao clique, mas o conteúdo capturado não é um PDF válido.');
        }
      } else {
        fs.writeFileSync(filePath, pdfBuffer);
      }
    }
    const rel = path.relative(path.join(baseDir, 'data'), filePath).split(path.sep).join('/');
    emit({ type: 'downloaded', portal: portal.key, filePath, fileUrl: '/files/' + rel });
  } else {
    // NÃO avança silenciosamente para o próximo portal. O portal atual precisa
    // ser resolvido para a sessão poder continuar.
    throw new Error('A certidão não foi capturada em PDF. O portal permanece aberto para conferência.');
  }

  return { filePath };
}

module.exports = { runPortal, findSafeContinuation, findMunicipalCertificateService, continueIssuanceFlow, classifyFederalPortalError, classifyStateCePortalError, captureExistingCertificate, waitForManualMunicipalCertificate };
