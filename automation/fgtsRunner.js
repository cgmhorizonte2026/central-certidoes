const fs = require('fs');
const path = require('path');

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function looksLikePdf(buffer) {
  if (!buffer || !buffer.length) return false;
  return buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1').includes('%PDF-');
}

async function prepareDownloadDir(page, baseDir, cnpj, emit) {
  const dir = path.join(
    baseDir,
    'data',
    'tmp-downloads',
    `${onlyDigits(cnpj)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    emit({ type: 'download_dir_ready', portal: 'fgts', downloadDir: dir, mode: 'cdp-page' });
  } catch (err) {
    emit({ type: 'download_dir_warning', portal: 'fgts', downloadDir: dir, message: String(err?.message || err) });
  }
  return dir;
}

async function waitForPdfInDirectory(dir, timeout = 60000) {
  const started = Date.now();
  const observed = new Map();
  while (Date.now() - started < timeout) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) {}
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
        if (!previous || previous.size !== stat.size) continue;
        const pdfBuffer = fs.readFileSync(file);
        if (looksLikePdf(pdfBuffer)) return { pdfBuffer, sourcePath: file };
      } catch (_) {}
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  return null;
}

async function pdfFromPageUrl(page, timeout = 15000) {
  const url = page.url();
  if (!/\.pdf(?:$|[?#])/i.test(url)) return null;
  try {
    const response = await page.request.get(url, { timeout });
    const ct = String(response.headers()['content-type'] || '').toLowerCase();
    const body = await response.body();
    if ((ct.includes('pdf') || looksLikePdf(body)) && looksLikePdf(body)) return body;
  } catch (_) {}
  return null;
}

async function printVisiblePageToPdf(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const result = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      paperWidth: 8.27,
      paperHeight: 11.69
    });
    return Buffer.from(result.data, 'base64');
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function clickVisible(page, selectors, namePattern = /Visualizar|Imprimir/i) {
  for (const role of ['button', 'link']) {
    try {
      const loc = page.getByRole(role, { name: namePattern }).first();
      if (await loc.count() && await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 7000 });
        return true;
      }
    } catch (_) {}
  }
  for (const scope of page.frames()) {
    for (const selector of selectors) {
      try {
        const loc = scope.locator(selector).first();
        await loc.waitFor({ state: 'visible', timeout: 2500 }).catch(() => {});
        if (!(await loc.count()) || !(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: 7000 });
        return true;
      } catch (_) {}
    }
  }
  return false;
}

async function captureFgtsFinalPdf(page, downloadDir, cnpj) {
  // O resumo também contém número e validade. Só a tela após Visualizar
  // possui o botão de impressão e o layout final do CRF.
  const visualize = page.locator('input[id="mainForm:btnVisualizar"]');
  await visualize.waitFor({ state: 'visible', timeout: 20000 });
  await visualize.click({ timeout: 10000 });
  await visualize.waitFor({ state: 'hidden', timeout: 20000 });
  await page.locator('input[id="mainForm:btImprimir4"]').waitFor({ state: 'visible', timeout: 20000 });
  const text = await page.locator('body').innerText();
  if (!onlyDigits(text).includes(onlyDigits(cnpj)) ||
      !/Certificado de Regularidade do FGTS\s*-\s*CRF/i.test(text) ||
      !/Certifica(?:do|ção)\s+N[úu]mero\s*:/i.test(text) ||
      !/Validade\s*:/i.test(text)) {
    throw new Error('A tela de impressão do FGTS não confirmou os dados do certificado. Nenhuma página foi arquivada.');
  }
  const pdf = await printVisiblePageToPdf(page);
  if (!looksLikePdf(pdf)) throw new Error('A tela final do FGTS não gerou um PDF válido.');
  return pdf;
}

async function runFgts({ portal, cnpj, browser, baseDir, emit }) {
  const digits = onlyDigits(cnpj);
  const page = await browser.newPortalPage();
  emit({ type: 'portal_opening', portal: portal.key, name: portal.name, url: portal.url });
  await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const input = page.locator('[id="mainForm:txtInscricao1"]');
  await input.waitFor({ state: 'visible', timeout: 20000 });
  await input.fill(digits);
  await input.press('Tab');
  if (onlyDigits(await input.inputValue()) !== digits) throw new Error('O CNPJ não foi confirmado no FGTS.');
  emit({ type: 'cnpj_fill', portal: 'fgts', filled: true });

  await page.locator('[id="mainForm:btnConsultar"]').click();
  const certificate = page.getByRole('link', { name: 'Certificado de Regularidade do FGTS - CRF', exact: true });
  try {
    await certificate.waitFor({ state: 'visible', timeout: 30000 });
  } catch (_) {
    emit({ type: 'fgts_intervention', portal: 'fgts', message: 'Resultado do FGTS ainda não disponível.' });
    await browser.waitForHumanResume('O FGTS não apresentou o link do certificado. Confira a mensagem na aba do portal e conclua a consulta, se necessário. Depois clique em Continuar.');
    if (page.isClosed()) throw new Error('A aba FGTS foi fechada.');
    await certificate.waitFor({ state: 'visible', timeout: 10000 });
  }

  await certificate.click();
  await page.getByRole('heading', { name: 'Certificado de Regularidade do FGTS - CRF', exact: true }).waitFor({ state: 'visible', timeout: 20000 });

  const text = await page.locator('body').innerText();
  if (!onlyDigits(text).includes(digits) || !text.includes('Certificado Número:') || !text.includes('Validade:')) {
    throw new Error('O FGTS não apresentou um certificado completo para o CNPJ informado.');
  }

  const downloadDir = await prepareDownloadDir(page, baseDir, cnpj, emit);
  const pdf = await captureFgtsFinalPdf(page, downloadDir, cnpj);
  if (!looksLikePdf(pdf)) throw new Error('A impressão do FGTS não retornou um PDF válido.');

  const dir = path.join(baseDir, 'data', 'certidoes', digits, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'CRF FGTS.pdf');
  fs.writeFileSync(filePath, pdf);
  emit({
    type: 'downloaded',
    portal: 'fgts',
    filePath,
    fileUrl: '/files/' + path.relative(path.join(baseDir, 'data'), filePath).split(path.sep).join('/'),
    message: 'PDF oficial capturado pela impressão do CRF FGTS.'
  });
  return { filePath, captureStage: 'fgts-print-view' };
}

module.exports = { runFgts };
