const fs = require('fs');
const path = require('path');

function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

function looksLikePdf(buffer) {
  if (!buffer || !buffer.length) return false;
  // PDFs válidos normalmente iniciam com %PDF-. Toleramos alguns bytes de
  // prefixo para respostas que venham com BOM/whitespace.
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('latin1');
  return head.includes('%PDF-');
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
      const loc = scope.locator(selector).first();
      if (!(await loc.count()) || !(await loc.isVisible())) continue;
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
    } catch (_) {}
  }
  }
  return false;
}

async function clickFirstVisible(page, selectors) {
  for (const scope of page.frames()) {
  for (const selector of selectors || []) {
    try {
      const loc = scope.locator(selector).first();
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

async function capturePdfFromClick(page, context, selectors, timeout = 30000) {
  for (const scope of page.frames()) {
  for (const selector of selectors || []) {
    try {
      const loc = scope.locator(selector).first();
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

      // O Fisco Web navega para uma URL assinada /imprimir/ exibida pelo
      // leitor de PDF do Chrome, sem disparar um download tradicional.
      for (let attempt = 0; attempt < 32; attempt++) {
        const printPage = context.pages().find(candidate => /\/imprimir\//i.test(candidate.url()));
        if (printPage) {
          try {
            const response = await fetch(printPage.url(), { signal: AbortSignal.timeout(12000) });
            const body = Buffer.from(await response.arrayBuffer());
            if (response.ok && looksLikePdf(body)) return { download: null, page: printPage, pdfBuffer: body };
          } catch (_) {}
        }
        await page.waitForTimeout(250).catch(() => {});
      }

      const winner = await Promise.race([
        downloadPromise.then(download => download ? ({ kind: 'download', download }) : null),
        popupPromise.then(popup => popup ? ({ kind: 'popup', popup }) : null),
        navigationPromise.then(response => response ? ({ kind: 'navigation', response }) : null),
        pdfResponsePromise.then(response => response ? ({ kind: 'response', response }) : null),
        page.waitForTimeout(timeout).then(() => null)
      ]);
      if (winner?.kind === 'download') return { download: winner.download, page: null };

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
      const pageText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      if (/Certid[aã]o Negativa de D[eé]bitos Estaduais/i.test(pageText)) {
        const printed = await printPageToPdf(page);
        if (printed) return { download: null, page, pdfBuffer: printed };
      }
    } catch (_) {}
  }
  }
  return null;
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
        const positive=pdfAction||/^(confirmar(?: certidao)?|continuar|prosseguir|gerar(?: certidao)?|emitir(?: certidao)?|visualizar(?: certidao)?|consultar)$/.test(text);
        const negative=/cancelar|sair|voltar|fechar|limpar|nova emissao|novo/.test(text);
        const issuance=/certidao|certificado|debitos?|emissao|geracao/.test(contextText);
        const modal=/confirm|deseja|prosseguir|continuar|emitir|gerar/.test(contextText)&&/certidao|documento/.test(contextText);
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
    const nodes=frame.locator('a,button,[role="button"],[onclick],.card,.service,.servico,.tile');
    const count=Math.min(await nodes.count().catch(()=>0),160);
    for(let i=0;i<count;i++) {
      const el=nodes.nth(i); if(!await el.isVisible().catch(()=>false)||!await el.isEnabled().catch(()=>true)) continue;
      const info=await el.evaluate(e=>({text:(e.innerText||e.getAttribute('aria-label')||e.title||'').replace(/\s+/g,' ').trim(),href:e.href||'',tag:e.tagName,id:e.id||'',className:String(e.className||'')})).catch(()=>null); if(!info||!info.text) continue;
      const t=normalText(info.text); if(seen.has(t+'|'+info.href)) continue;
      if(!/certidao|cnd|debito|tribut/.test(t)||/\b(iptu|itbi|alvara|acordo|tllf)\b/.test(t)&&!/certidao|cnd/.test(t)) continue;
      const score=(/certidao|cnd/.test(t)?6:0)+(/negativ|tribut|debito|contribuinte|fiscal/.test(t)?3:0);
      if(score>=7)candidates.push({element:el,page,frame,info,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score); return candidates[0]||null;
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

async function continueIssuanceFlow({page,context,browser,portal,baseDir,emit,maxSteps=8}) {
  const history=[];const seenServices=new Set();let previousAction='emissão inicial';
  for(let step=1;step<=maxSteps;step++) {
    await page.waitForTimeout(800).catch(()=>{});
    const pdfBuffer=await recoverPdfFromPrintPages(context,8000);if(pdfBuffer)return {pdfBuffer,history,status:'DOCUMENTO_GERADO'};
    for(const candidate of [...context.pages()].reverse()){const directPdf=await extractPdfResponse(candidate,5000);if(directPdf)return {pdfBuffer:directPdf,history,status:'DOCUMENTO_GERADO'};}
    const livePages=[...context.pages()].filter(p=>!p.isClosed());
    let captchaPage=null;for(const candidate of livePages){const captcha=await browser.captchaState(candidate);if(captcha.captcha_active&&captcha.blocking){captchaPage=candidate;break;}}
    if(captchaPage){emit({type:'human_action_required',status:'AGUARDANDO_INTERACAO_USUARIO',portal:portal.key,message:'O órgão exige uma verificação humana. Resolva o CAPTCHA na mesma janela; a Central continuará desta etapa.'});await browser.waitForCaptcha(captchaPage,'Conclua a verificação humana na janela do órgão. A sessão, os cookies e os dados preenchidos serão mantidos.',600000,true);page=captchaPage;history.push({step,type:'captcha_resolvido',url:page.url()});continue;}
    if (portal.key === 'municipal') {
      const service=await findMunicipalCertificateService(context,seenServices);
      if (service) { const action=service.info.text; seenServices.add(normalText(action)+'|'+service.info.href); emit({type:'service_catalog_detected',status:'CATALOGO_SERVICOS',portal:portal.key,action,url:service.page.url(),message:`Serviço de certidão identificado: ${action}`}); await service.element.click({timeout:7000}); history.push({step,action,url:service.page.url(),at:new Date().toISOString(),type:'service_navigation'}); previousAction=action; page=service.page; continue; }
    }
    const next=await findSafeContinuation(context);
    if(!next){await saveUnknownState({page:livePages.at(-1)||page,portal,baseDir,previousAction,emit,history});return {history,status:'ESTADO_DESCONHECIDO'};}
    if(next.pdfAction){return {history,status:'PDF_ACTION_AVAILABLE'};}
    const beforeUrl=next.page.url(),action=next.info.text;emit({type:'continuation_action',portal:portal.key,step,action,url:beforeUrl,message:`Etapa ${step}: ${action}`});
    await next.element.click({timeout:7000});history.push({step,action,url:beforeUrl,at:new Date().toISOString()});previousAction=action;page=next.page;
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


async function clickFederalValidCertificateModal(page) {
  // IMPORTANTE: a página por trás do modal também possui um botão
  // "Consultar Certidão". Portanto, nunca devemos procurar esse texto
  // globalmente enquanto o modal estiver aberto. O clique precisa ficar
  // restrito ao contêiner do modal/overlay.
  const titles = page.getByText('Certidão Válida Encontrada', { exact: false });
  const titleCount = await titles.count();

  for (let i = 0; i < titleCount; i++) {
    const title = titles.nth(i);
    if (!(await title.isVisible().catch(() => false))) continue;

    const containers = [
      title.locator('xpath=ancestor::*[@role="dialog"][1]'),
      title.locator('xpath=ancestor::*[contains(@class,"p-dialog")][1]'),
      title.locator('xpath=ancestor::*[contains(@class,"modal")][1]'),
      title.locator('xpath=ancestor::*[contains(@class,"cdk-overlay-pane")][1]'),
      title.locator('xpath=ancestor::*[contains(@class,"dialog")][1]')
    ];

    for (const container of containers) {
      if (!(await container.count())) continue;
      if (!(await container.isVisible().catch(() => false))) continue;

      // Primeiro tenta por papel/nome acessível; depois cai para seletores de texto.
      const byRole = container.getByRole('button', { name: /Consultar Certidão/i });
      const roleCount = await byRole.count();
      for (let j = 0; j < roleCount; j++) {
        const btn = byRole.nth(j);
        if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => true)) {
          await btn.click({ timeout: 10000 });
          return true;
        }
      }

      const candidates = container.locator('button, a, [role="button"]').filter({ hasText: 'Consultar Certidão' });
      const candidateCount = await candidates.count();
      for (let j = 0; j < candidateCount; j++) {
        const btn = candidates.nth(j);
        if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => true)) {
          await btn.click({ timeout: 10000 });
          return true;
        }
      }
    }
  }

  return false;
}

async function federalExistingCertificateFlow(page, emit, baseDir, cnpj) {
  // A Receita pode impedir uma nova emissão quando já existe certidão válida.
  // Nesse caso, recuperamos a 2ª via da certidão válida mais recente.
  const modalText = page.getByText('Certidão Válida Encontrada', { exact: false });
  let hasModal = false;
  const modalCount = await modalText.count();
  for (let i = 0; i < modalCount; i++) {
    if (await modalText.nth(i).isVisible().catch(() => false)) {
      hasModal = true;
      break;
    }
  }
  if (!hasModal) {
    hasModal = await modalText.first().waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
  }
  if (!hasModal) return null;

  emit({ type: 'federal_valid_certificate_found', portal: 'federal' });

  const consulted = await clickFederalValidCertificateModal(page);
  if (!consulted) throw new Error('A Receita informou que existe certidão válida, mas o botão "Consultar Certidão" DENTRO DO MODAL não foi localizado.');

  // A Receita é SPA; a mudança acontece no hash (#/home/cnpj/consultar).
  const movedToConsult = await page.waitForFunction(() => {
    return String(window.location.hash || '').toLowerCase().includes('/cnpj/consultar');
  }, { timeout: 20000 }).then(() => true).catch(() => false);
  if (!movedToConsult) {
    throw new Error('O botão do modal foi acionado, mas a Receita não avançou para a tela de consulta de certidões.');
  }
  await page.waitForTimeout(1800);

  // A tela já vem com "Data de Emissão" e período de um ano preenchidos.
  const searched = await clickFirstVisible(page, [
    'button:has-text("Consultar Certidão")',
    'a:has-text("Consultar Certidão")',
    'text=Consultar Certidão'
  ]);
  if (!searched) throw new Error('Não foi possível executar a consulta das certidões existentes na Receita Federal.');

  await page.waitForURL(/consultar\/resultado/i, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1800);

  // A página da Receita usa ngx-datatable (DIVs), não uma <table> HTML.
  // Portanto, trabalhamos diretamente com as linhas reais do componente.
  const rows = page.locator('.ngx-datatable .datatable-body-row');
  await rows.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

  const count = await rows.count();
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = String(await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (!/\bVálida\b/i.test(text)) continue;

    // Ex.: 10/09/2026 - 10:39:41
    const m = text.match(/(\d{2})\/(\d{2})\/(\d{4})\s*-?\s*(\d{2}):(\d{2}):(\d{2})/);
    let stamp = 0;
    if (m) stamp = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();

    // O botão real foi confirmado no DevTools da Receita:
    // <button type="button" title="Segunda via" class="br-button small circle">...</button>
    // O valor do atributo title tem S maiúsculo. Usamos o modificador CSS "i"
    // para tornar a comparação case-insensitive e evitar nova quebra se o portal mudar a capitalização.
    const btn = row.locator('.row-actions button[title="Segunda via" i]');
    if (await btn.count()) candidates.push({ i, stamp });
  }

  if (!candidates.length) {
    // Fallback: caso o texto da situação seja renderizado fora da linha por alguma
    // mudança visual, usa o primeiro botão visível de 2ª via encontrado no grid.
    const allButtons = page.locator('.ngx-datatable .row-actions button[title="Segunda via" i]');
    const n = await allButtons.count();
    for (let i = 0; i < n; i++) {
      const b = allButtons.nth(i);
      if (await b.isVisible().catch(() => false)) {
        candidates.push({ directButton: b, stamp: 0, i });
        break;
      }
    }
  }

  if (!candidates.length) throw new Error('A Receita abriu a consulta, mas nenhum botão de 2ª Via foi localizado no ngx-datatable.');
  candidates.sort((a, b) => b.stamp - a.stamp || a.i - b.i);

  let secondCopyButton;
  if (candidates[0].directButton) {
    secondCopyButton = candidates[0].directButton;
  } else {
    const row = rows.nth(candidates[0].i);
    await row.scrollIntoViewIfNeeded().catch(() => {});
    secondCopyButton = row.locator('.row-actions button[title="Segunda via" i]').first();
  }

  await page.bringToFront().catch(() => {});
  await secondCopyButton.waitFor({ state: 'visible', timeout: 15000 });
  await secondCopyButton.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);

  emit({ type: 'federal_second_copy_button_found', portal: 'federal', selector: '.row-actions button[title="Segunda via" i]' });

  // Cria uma pasta exclusiva para ESTE download e informa ao Chrome via CDP.
  // Assim não dependemos do nome UUID nem do evento de download do Playwright.
  const controlledDownloadDir = await prepareControlledDownloadDir(page, baseDir, cnpj, emit, 'federal');
  const fileSystemPdfPromise = waitForPdfInDirectory(controlledDownloadDir, 60000);

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
  const pdfResponsePromise = page.waitForResponse(r => {
    const ct = String(r.headers()['content-type'] || '').toLowerCase();
    return ct.includes('application/pdf') || ct.includes('application/x-pdf');
  }, { timeout: 60000 }).catch(() => null);

  // Primeiro: clique Playwright diretamente no <button> real.
  let clicked = false;
  try {
    await secondCopyButton.click({ timeout: 10000 });
    clicked = true;
    emit({ type: 'federal_second_copy_click_try', portal: 'federal', method: 'direct-button' });
  } catch (err) {
    emit({ type: 'federal_second_copy_click_try', portal: 'federal', method: 'direct-button-failed', message: String(err?.message || err) });
  }

  // Fallback: invoca o click() nativo no próprio BUTTON, nunca no ícone <i>.
  if (!clicked) {
    try {
      await secondCopyButton.evaluate(el => el.click());
      clicked = true;
      emit({ type: 'federal_second_copy_click_try', portal: 'federal', method: 'native-button-click' });
    } catch (err) {
      emit({ type: 'federal_second_copy_click_try', portal: 'federal', method: 'native-button-click-failed', message: String(err?.message || err) });
    }
  }

  if (!clicked) throw new Error('O botão HTML da 2ª Via foi localizado, mas não pôde ser acionado.');

  // Aguarda download ou resposta PDF. A Receita pode baixar o arquivo com nome
  // UUID e sem extensão; a etapa posterior valida o conteúdo %PDF- e salva .pdf.
  const winner = await Promise.race([
    downloadPromise.then(d => d ? ({ kind: 'download', value: d }) : null),
    pdfResponsePromise.then(r => r ? ({ kind: 'pdf', value: r }) : null),
    fileSystemPdfPromise.then(r => r ? ({ kind: 'filesystem', value: r }) : null),
    page.waitForTimeout(20000).then(() => null)
  ]);

  if (winner?.kind === 'download') {
    const d = winner.value;
    emit({ type: 'federal_second_copy_downloaded', portal: 'federal', suggestedFilename: d.suggestedFilename() });
    return { download: d, controlledDownloadDir };
  }
  if (winner?.kind === 'pdf') {
    try {
      const pdfBuffer = await winner.value.body();
      emit({ type: 'federal_second_copy_downloaded', portal: 'federal', mode: 'response-body' });
      return { pdfBuffer };
    } catch (_) {}
  }
  if (winner?.kind === 'filesystem') {
    emit({
      type: 'federal_second_copy_downloaded',
      portal: 'federal',
      mode: 'controlled-download-folder',
      sourcePath: winner.value.sourcePath
    });
    return { pdfBuffer: winner.value.pdfBuffer };
  }

  // Se a página confirmou a emissão, aguarda mais um pouco. Primeiro tenta o
  // evento Playwright e, em paralelo, verifica a pasta controlada do Chrome.
  const success = await page.getByText(/segunda via da certidão foi emitida com sucesso/i).isVisible().catch(() => false);
  if (success) {
    const late = await Promise.race([
      page.waitForEvent('download', { timeout: 20000 }).then(d => d ? ({ kind: 'download', value: d }) : null).catch(() => null),
      waitForPdfInDirectory(controlledDownloadDir, 20000).then(r => r ? ({ kind: 'filesystem', value: r }) : null)
    ]);
    if (late?.kind === 'download') return { download: late.value, controlledDownloadDir };
    if (late?.kind === 'filesystem') {
      emit({ type: 'federal_second_copy_downloaded', portal: 'federal', mode: 'controlled-download-folder-late', sourcePath: late.value.sourcePath });
      return { pdfBuffer: late.value.pdfBuffer };
    }
  }

  throw new Error(`O botão de 2ª Via foi acionado e a Receita confirmou a emissão, mas a Central não encontrou um PDF. Pasta monitorada: ${controlledDownloadDir}`);
}

async function runPortal({ portal, cnpj, browser, baseDir, emit }) {
  if (portal.key === 'fgts') return require('./fgtsRunner').runFgts({portal,cnpj,browser,baseDir,emit});
  // Cada portal usa uma única aba e só a abre quando o portal anterior terminou.
  const page = await browser.newPortalPage();
  emit({ type: 'portal_opening', portal: portal.key, name: portal.name, url: portal.url });
  await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(1800);

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
    }
  }

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

  // A Receita pode concluir a navegação com uma mensagem informando que os
  // dados são insuficientes para emissão online. Isso é uma pendência apenas
  // da certidão federal; não deve bloquear as demais etapas da fila.
  if (portal.key === 'federal') {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (/informa(?:ç|c)[õo]es dispon[ií]veis.*insuficientes para emitir/i.test(bodyText) ||
        /dados.*insuficientes para emitir a certid[aã]o/i.test(bodyText)) {
      throw new Error('A Receita Federal informou que os dados são insuficientes para emitir a certidão pela Internet. A Central seguirá para a próxima certidão.');
    }
  }

  // A Receita pode abrir o modal "Certidão Válida Encontrada" antes do CAPTCHA.
  // Se isso ocorrer, recupera a 2ª via e não entra na espera do CAPTCHA.
  let download = null;
  let pdfBuffer = null;
  let controlledDownloadDir = null;
  if (portal.key === 'federal') {
    const existing = await federalExistingCertificateFlow(page, emit, baseDir, cnpj);
    if (existing?.download) download = existing.download;
    controlledDownloadDir = existing?.controlledDownloadDir || null;
    if (existing?.pdfBuffer) pdfBuffer = existing.pdfBuffer;
  }

  // Cada portal é concluído antes de iniciar o próximo. Para a Receita,
  // a etapa humana é obrigatória somente quando o fluxo realmente chegou ao CAPTCHA.
  if (!download && !pdfBuffer && portal.key === 'trabalhista') {
    await browser.waitForHumanResume('Na aba Trabalhista, digite os caracteres da imagem. Não clique em Emitir ainda; depois clique em Continuar aqui na Central para capturar o PDF.');
    if(page.isClosed()) throw new Error('A aba Trabalhista foi fechada.');
  } else if (!download && !pdfBuffer && portal.humanCaptcha !== false) {
    await browser.waitForCaptcha(
      page,
      `Resolva o CAPTCHA na janela do portal ${portal.name}. Depois de marcar o CAPTCHA, aguarde: a Central continuará automaticamente.`,
      portal.captchaTimeout || 300000,
      false
    );
  }

  for (const action of ((download || pdfBuffer) ? [] : (portal.afterCaptchaActions || []))) {
    if (action.waitBeforeMs) await page.waitForTimeout(action.waitBeforeMs);
    let clicked = false;
    if (action.captureDownload) {
      if (!controlledDownloadDir) {
        controlledDownloadDir = await prepareControlledDownloadDir(page, baseDir, cnpj, emit, portal.key);
      }
      const result = await capturePdfFromClick(page, browser.context, action.selectors || [], action.downloadTimeout || 30000);
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
      clicked = await clickFirstVisible(page, action.selectors || []);
    }
    emit({ type: 'after_captcha_action', portal: portal.key, action: action.name || 'ação pós-CAPTCHA', clicked });
    if (clicked) await page.waitForTimeout(action.waitMs || 2200);
  }

  // A emissão pode abrir uma ou mais confirmações intermediárias depois da
  // ação inicial. Reavalia o DOM, modais, CAPTCHA e novas páginas até chegar a
  // um estado terminal, sem clicar em elementos fora do contexto da emissão.
  if (!download && !pdfBuffer) {
    const continuation = await continueIssuanceFlow({
      page, context: browser.context, browser, portal, baseDir, emit, maxSteps: 8
    });
    if (continuation.pdfBuffer) pdfBuffer = continuation.pdfBuffer;
    if (continuation.status === 'ESTADO_DESCONHECIDO') {
      throw new Error('ESTADO_DESCONHECIDO: o portal apresentou uma etapa não interpretada com segurança.');
    }
  }

  if (!download && !pdfBuffer && portal.existingCertificate) {
    const existing = await captureExistingCertificate(page, browser.context, portal.existingCertificate, emit);
    if (existing?.download) download = existing.download;
    if (existing?.pdfBuffer) pdfBuffer = existing.pdfBuffer;
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

module.exports = { runPortal, findSafeContinuation, findMunicipalCertificateService, continueIssuanceFlow };
