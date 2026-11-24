const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseCertificate } = require('../lib/domain');
const {MunicipalPrintCapture,finalMunicipalDocument,DOCUMENT_POLICY}=require('./municipal-print');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function flowKey(company, url) {
  const municipality = company.municipio_codigo_ibge || company.codigo_municipio_ibge || `${company.uf}:${company.municipio}`;
  if (!municipality || municipality === 'undefined:undefined') throw Error('Município não identificado.');
  return hash(Buffer.from(`${municipality}|${new URL(url).href}`));
}
function saveFlow(root, key, value) {
  const dir = path.join(root, 'municipal-flows'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file);
}
function readFlow(root, key) {
  try { const f = JSON.parse(fs.readFileSync(path.join(root, 'municipal-flows', key + '.json'))); return [1,2,3].includes(f.version) && Array.isArray(f.steps) && f.steps.length > 0 && f.steps.length <= 300 ? f : null; } catch { return null; }
}
// Runs inside the controlled browser, including frames and newly opened pages.
function recorder({ binding, origin }) {
  if (location.origin !== origin || window[binding + 'ready']) return;
  window[binding + 'ready'] = true;
  const selector = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name=' + JSON.stringify(el.name) + ']';
    const parts = []; while (el && el.nodeType === 1 && parts.length < 10) {
      const tag = el.tagName.toLowerCase(), siblings = [...(el.parentElement?.children || [])].filter(x => x.tagName === el.tagName);
      parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')'); el = el.parentElement;
    } return parts.join(' > ');
  };
  const send = (event, action) => {
    if (!event.isTrusted) return;
    const el = action === 'click' ? event.target.closest('a,button,input[type=submit],input[type=radio],input[type=checkbox]') : event.target;
    if (!el || !el.matches('input,select,textarea,button,a')) return;
    const sensitive = /password|captcha|token|senha|secret|otp/i.test([el.type, el.name, el.id, el.autocomplete].join(' '));
    window[binding]({ action: sensitive ? 'manual' : action, selector: selector(el), frame: location.origin + location.pathname,
      value: action === 'change' && !sensitive ? el.value : '', tag: el.tagName, type: el.type, checked: !!el.checked }).catch(() => {});
  };
  document.addEventListener('click', e => send(e, 'click'), true);
  document.addEventListener('change', e => send(e, 'change'), true);
  document.addEventListener('input', e => { if (e.target.matches('input,textarea')) send(e, 'change'); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Enter') send(e, 'enter'); }, true);
}
function sanitizeStep(step, cnpj) {
  if (!step || !['click','change','enter','manual'].includes(step.action) || typeof step.selector !== 'string' || step.selector.length > 1000) return null;
  const value = String(step.value || '');
  if (step.action === 'manual') return { action: 'manual' };
  if (step.action === 'change' && !['SELECT'].includes(step.tag)) {
    if (value.replace(/\D/g, '') !== cnpj) {
      if (cnpj.startsWith(value.replace(/\D/g,'')) && /^[\d.\/\-]*$/.test(value)) return null;
      return { action: 'manual' };
    }
    return { action: 'fill', selector: step.selector, frame: step.frame, formatted: value.includes('.') };
  }
  if (step.type === 'checkbox' || step.type === 'radio') return { action: 'check', selector: step.selector, frame: step.frame, checked: step.checked };
  return { action: step.action === 'change' ? 'select' : step.action, selector: step.selector, frame: step.frame, ...(step.tag === 'SELECT' ? { value: value.slice(0, 100) } : {}) };
}
class MunicipalLearning {
  constructor({ root, browser, portal, company, cnpj, emit, onCapture = async () => null, timeoutMs = 30*60*1000, replayWaitMs = 15000 }) {
    Object.assign(this, { root, browser, portal, company, cnpj, emit, onCapture, timeoutMs, replayWaitMs });
    this.key = flowKey(company, portal.url);
    this.steps = []; this.pdfs = new Map(); this.pending = new Set(); this.pages = new Set();
    this.downloadSources = new Map(); this.observed = new Map(); this.processing = new Map(); this.listeners = [];
    this.state = 'opening'; this.manual = false; this.sessionId = crypto.randomUUID();
    this.downloadDir = path.join(root, 'municipal-downloads', this.sessionId);
    this.completion = new Promise((resolve,reject) => { this.resolve = resolve; this.reject = reject; });
    this.completion.catch(() => {});
  }
  trusted(url) { try { const u=new URL(url); return ['https:','http:'].includes(u.protocol) && u.origin === new URL(this.portal.url).origin; } catch { return false; } }
  notify(state, message) {
    this.state = state;
    this.emit({type:'municipal_state',portal:'municipal',state,message});
  }
  track(promise) {
    this.pending.add(promise);
    promise.catch(error => {
      if (!this.cancelled) this.emit({type:'municipal_capture_warning',portal:'municipal',message:error.message});
    }).finally(() => this.pending.delete(promise));
    return promise;
  }
  listen(target, event, callback) { target.on(event, callback); this.listeners.push(() => target.off(event,callback)); }
  async configureDownloads(page) {
    try {
      const cdp = await this.context.newCDPSession(page);
      await cdp.send('Page.enable');
      this.listen(cdp,'Page.downloadWillBegin',event=>{if(this.trusted(event.url))this.downloadSources.set(event.suggestedFilename,event.url);});
      await cdp.send('Page.setDownloadBehavior', {behavior:'allow',downloadPath:this.downloadDir});
      this.downloadSessions ||= []; this.downloadSessions.push(cdp);
    } catch (error) {
      this.emit({type:'municipal_download_warning',portal:'municipal',message:'Monitoramento de pasta indisponível; usando captura do navegador. '+error.message.split('\n')[0]});
    }
  }
  attach(page) {
    if (this.pages.has(page)) return;
    this.pages.add(page);
    this.listen(page,'popup',popup=>{this.attach(popup);this.track(this.configureDownloads(popup));});
    this.listen(page,'download',download=>this.track((async()=>{
      const raw=download.url();
      const url=raw.startsWith('blob:')?raw.slice(5):raw.startsWith('data:application/pdf')?page.url():raw;
      if(this.trusted(url))this.downloadSources.set(download.suggestedFilename(),url);
      // Dedicated CDP folder is a fallback when Chrome does not emit this event.
      const stream=await download.createReadStream();if(!stream)return;
      const chunks=[];let size=0;
      for await(const chunk of stream){size+=chunk.length;if(size>25*1024*1024){stream.destroy();throw Error('PDF municipal excede 25 MB.');}chunks.push(chunk);}
      await this.capture(Buffer.concat(chunks),this.trusted(url)?url:'','browser_download');
    })()));
    this.listen(page,'response',r=>{
      if(r.status()===200 && this.trusted(r.url()) && (/application\/(?:pdf|octet-stream)/i.test(r.headers()['content-type']||'')||/\.pdf\b/i.test(r.headers()['content-disposition']||'')) && !/^attachment/i.test(r.headers()['content-disposition']||'') && Number(r.headers()['content-length']||0)<=25*1024*1024)
        this.track(r.body().then(bytes=>this.capture(bytes,r.url(),'official_response')));
    });
  }
  async capture(buffer, url, method) {
    if(this.cancelled || buffer.length>25*1024*1024 || buffer.subarray(0,5).toString()!=='%PDF-')return null;
    const digest=hash(buffer);
    if(this.processing.has(digest))await this.processing.get(digest);
    if(this.pdfs.has(digest)){
      const existing=this.pdfs.get(digest);
      if(!existing.officialPortal&&this.trusted(url)&&!this.cancelled){
        existing.url=url;existing.officialPortal=true;existing.method=method;
        existing.archived=await this.onCapture(existing);
      }
      return existing;
    }
    const work=(async()=>{
      const text=(await require('../lib/certificates').extractPdf(buffer)).text;
      const validation=finalMunicipalDocument(text,this.cnpj),parsed=validation.parsed;
      if(!parsed.cnpjMatches||!parsed.kindMatches)throw Error('Download recebido, mas o PDF não identifica o CNPJ consultado e uma certidão municipal. Emita o documento correto e clique em Continuar.');
      if(!validation.valid)throw Error(validation.reason);
      if(this.cancelled)return null;
      const filePath=path.join(this.downloadDir,digest+'.pdf');
      fs.writeFileSync(filePath+'.part',buffer);fs.renameSync(filePath+'.part',filePath);
      const record={buffer,url,method,text,parsed,filePath,documentValidation:DOCUMENT_POLICY,sha256:digest,officialPortal:!!url&&this.trusted(url)};
      record.archived=await this.onCapture(record);
      if(this.cancelled)return null;
      this.pdfs.set(digest,record);
      this.emit({type:'municipal_pdf_saved',portal:'municipal',message:'PDF municipal salvo na pasta de destino.'});
      if(this.manual)this.notify('document_ready','PDF municipal salvo. Clique em Continuar para concluir e guardar o roteiro.');
      return record;
    })();
    this.processing.set(digest,work);
    try{const result=await work;this.lastCaptureError=null;return result;}catch(error){this.lastCaptureError='PDF recebido, mas não arquivado: '+error.message+' Pasta do download: '+this.downloadDir;throw error;}finally{this.processing.delete(digest);}
  }
  async scanDownloads() {
    if(this.cancelled||this.scanning||!fs.existsSync(this.downloadDir))return;
    this.scanning=true;
    try{
      for(const name of fs.readdirSync(this.downloadDir)){
        if(/\.(crdownload|tmp|part)$/i.test(name))continue;
        const file=path.join(this.downloadDir,name);let stat;try{stat=fs.statSync(file);}catch{continue;}
        if(!stat.isFile()||!stat.size||stat.size>25*1024*1024)continue;
        const signature=stat.size+':'+stat.mtimeMs,previous=this.observed.get(name);
        if(previous?.done===signature)continue;
        if(previous?.signature!==signature){this.observed.set(name,{signature});continue;}
        try{
          // A controlled folder proves a session download, but alone cannot prove
          // the response's official host. Do not manufacture official provenance.
          await this.capture(fs.readFileSync(file),this.downloadSources.get(name)||'','controlled_download');
          this.observed.set(name,{signature,done:signature});
        }catch(error){this.observed.set(name,{signature,done:signature});throw error;}
      }
    }finally{this.scanning=false;}
  }
  async scanEmbedded() {
    for(const page of this.pages){
      if(this.cancelled||page.isClosed())continue;
      const blobPage=page.url().startsWith('blob:')&&this.trusted(page.url().slice(5));
      const owner=blobPage?await page.opener():page;
      if(!owner||!this.trusted(owner.url()))continue;
      const sources=blobPage?[page.url()]:await page.locator('iframe[src],embed[src],object[data],a[download][href]').evaluateAll(nodes=>nodes.map(e=>e.getAttribute('src')||e.getAttribute('data')||e.getAttribute('href'))).catch(()=>[]);
      for(const source of sources){
        if(!source?.startsWith('blob:')&&!source?.startsWith('data:application/pdf'))continue;
        if(source.startsWith('blob:')&&!this.trusted(source.slice(5)))continue;
        const encoded=await owner.evaluate(async url=>{const response=await fetch(url);const blob=await response.blob();if(blob.size>25*1024*1024)return null;return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>resolve(null);reader.readAsDataURL(blob);});},source).catch(()=>null);
        if(encoded)await this.capture(Buffer.from(encoded.split(',')[1]||'','base64'),owner.url(),'official_embedded');
      }
    }
  }
  async settleCapture() {
    await this.scanDownloads();
    await this.scanEmbedded();
    await Promise.race([Promise.allSettled([...this.pending,...this.processing.values(),...(this.printer?.pending||[])]),new Promise(resolve=>setTimeout(resolve,3000))]);
    await new Promise(resolve=>setTimeout(resolve,400));
    await this.scanDownloads();
    return [...this.pdfs.values()].at(-1)||null;
  }
  async pause(message) {
    if(this.cancelled)throw Error('Consulta cancelada.');
    this.notify('awaiting_checkpoint',message);
    await new Promise(resolve=>{this.checkpoint=resolve;});
    this.checkpoint=null;
    if(this.cancelled)throw Error('Consulta cancelada.');
    if(this.result)return;
    this.notify('replaying','Retomando o roteiro na mesma página, sem reiniciar o CAPTCHA.');
  }
  async captchaBlocking(page) {
    return page.evaluate(()=>{
      const visible=e=>!!(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
      if([...document.querySelectorAll('[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]')].some(e=>e.value?.trim()))return false;
      const textFields=[...document.querySelectorAll('input[name*="captcha" i],input[id*="captcha" i]')].filter(e=>e.type!=='hidden'&&visible(e));
      if(textFields.length)return textFields.some(e=>!e.value.trim());
      return [...document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha')].some(visible);
    }).catch(()=>false);
  }
  async locate(step) {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline&&!this.cancelled){
      const matches=[];
      for(const page of [...this.pages].reverse()){
        if(page.isClosed())continue;
        for(const frame of page.frames()){
          if(!this.trusted(frame.url()))continue;
          const u=new URL(frame.url());if(u.origin+u.pathname!==step.frame)continue;
          const loc=frame.locator(step.selector);
          if(await loc.count()===1&&await loc.isVisible())matches.push({loc,page});
        }
      }
      if(matches.length===1)return matches[0];
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw Error('O campo do roteiro mudou ou não ficou disponível. Continue a emissão manualmente nesta mesma janela.');
  }
  async start() {
    fs.mkdirSync(this.downloadDir,{recursive:true});
    this.page=await this.browser.newPortalPage();this.context=this.browser.context;
    if(this.cancelled)return null;
    const binding='centralLearn'+crypto.randomBytes(8).toString('hex');
    await this.context.exposeBinding(binding,({page,frame},raw)=>{
      if(!this.manual||this.cancelled||!this.pages.has(page)||!this.trusted(frame.url()))return;
      if(this.steps.length>=300){this.recordingOverflow=true;return;}
      const step=sanitizeStep(raw,this.cnpj);if(!step)return;
      const previous=this.steps.at(-1);
      // input/change can describe the same fill; preserve ordering without duplicates.
      if(JSON.stringify(previous)!==JSON.stringify(step))this.steps.push(step);
    });
    await this.context.addInitScript(recorder,{binding,origin:new URL(this.portal.url).origin});
    this.printer=new MunicipalPrintCapture({context:this.context,portal:this.portal,isCancelled:()=>this.cancelled,
      ownsPage:async page=>{
        if(this.pages.has(page))return true;
        const opener=await page.opener();
        if(opener&&this.pages.has(opener)){this.attach(page);this.browser.own?.(page);return true;}
        return false;
      },
      originalPdf:async()=>{await this.scanEmbedded();await Promise.allSettled([...this.processing.values()]);return [...this.pdfs.values()].find(record=>record.method!=='official_print_view');},
      onPdf:(bytes,url,method)=>{const original=[...this.pdfs.values()].find(record=>record.method!=='official_print_view');return original||this.capture(bytes,url,method);},
      emit:event=>{
        this.emit(event);
        if(this.manual&&event.type==='municipal_print_started')this.notify('printing','Gerando o PDF da certidão a partir da impressão do portal. Aguarde.');
        if(this.manual&&!this.pdfs.size&&event.type==='municipal_print_rejected')this.notify('awaiting_manual',event.message);
      }
    });
    await this.printer.install();
    this.attach(this.page);await this.configureDownloads(this.page);
    this.monitor=setInterval(()=>this.track(this.scanDownloads()),500);this.monitor.unref?.();
    const flow=readFlow(this.root,this.key);this.manual=!flow;
    await this.page.goto(this.portal.url,{waitUntil:'domcontentloaded',timeout:60000});
    if(this.cancelled)return null;
    if(flow){
      this.notify('replaying','Executando o roteiro aprendido para este município.');
      try{
        for(const step of flow.steps){
          if(this.cancelled)throw Error('Consulta cancelada.');
          if(this.pdfs.size)break;
          if(step.action==='manual'){
            await this.pause('O portal exige CAPTCHA ou um dado particular. Preencha na janela já aberta e clique em Continuar.');
          }else{
            const {loc,page}=await this.locate(step);
            if(['click','enter'].includes(step.action)&&await this.captchaBlocking(page)){
              await this.pause('Resolva o CAPTCHA na janela aberta e clique em Continuar. A Central retomará exatamente desta etapa.');
              if(this.pdfs.size)break;
            }
            if(step.action==='fill')await loc.fill(step.formatted?this.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,'$1.$2.$3/$4-$5'):this.cnpj,{timeout:10000});
            else if(step.action==='select')await loc.selectOption(step.value,{timeout:10000});
            else if(step.action==='check')await loc.setChecked(step.checked,{timeout:10000});
            else if(step.action==='enter')await loc.press('Enter',{timeout:10000});
            else if(step.action==='click')await loc.click({timeout:10000});
            else throw Error('Etapa de roteiro não reconhecida.');
          }
          this.steps.push(step);
          await new Promise(resolve=>setTimeout(resolve,300));
        }
        if(!this.pdfs.size&&!this.printer.pending.size)await this.tryPrintAction();
        const deadline=Date.now()+Math.max(this.replayWaitMs,this.printer.pending.size?30000:0);
        while(!this.pdfs.size&&Date.now()<deadline&&!this.cancelled){await this.settleCapture();await new Promise(resolve=>setTimeout(resolve,200));}
        if(this.cancelled)return null;
        if(this.pdfs.size)return [...this.pdfs.values()].at(-1);
      }catch(error){
        if(this.cancelled)return null;
        this.emit({type:'municipal_replay_failed',portal:'municipal',message:error.message});
      }
      // Preserve the page, cookies, completed CAPTCHA and successful prefix.
      // Never reload the portal merely because a PDF has not arrived yet.
    }
    this.manual=true;
    this.notify('awaiting_manual','Realize a emissão e use Baixar ou Imprimir na janela do município aberta pela Central. O PDF será salvo automaticamente. Depois clique em Continuar.');
    return null;
  }
  async tryPrintAction() {
    if(this.cancelled)return;
    const matches=[];
    for(const page of [...this.pages].reverse())for(const frame of page.frames()){
      if(!this.trusted(frame.url()))continue;
      const buttons=frame.getByRole('button',{name:/^(?:imprimir|reimprimir)(?:\s+(?:a\s+)?certid[aã]o)?$/i}).or(frame.getByRole('link',{name:/^(?:imprimir|reimprimir)(?:\s+(?:a\s+)?certid[aã]o)?$/i}));
      for(let i=0;i<await buttons.count();i++)if(await buttons.nth(i).isVisible())matches.push({loc:buttons.nth(i),frame});
    }
    if(matches.length!==1)return;
    const {loc,frame}=matches[0];
    const selector=await loc.evaluate(el=>el.id?'#'+CSS.escape(el.id):el.name?el.tagName.toLowerCase()+'[name='+JSON.stringify(el.name)+']':null);
    if(!selector)return; // Do not guess among dynamic print controls.
    await loc.click({timeout:7000});
    const u=new URL(frame.url());this.steps.push({action:'click',selector,frame:u.origin+u.pathname});
  }
  async complete(buffer) {
    const capture=this.pdfs.get(hash(buffer));
    const parsed=capture?.parsed||parseCertificate((await require('../lib/certificates').extractPdf(buffer)).text,this.cnpj,'municipal');
    if(!parsed.cnpjMatches||!parsed.kindMatches)throw Object.assign(Error('O PDF deve identificar o CNPJ consultado e uma certidão municipal. Confira o documento.'),{status:422});
    const reusable=!!capture&&!this.recordingOverflow&&this.steps.some(s=>s.action==='fill');
    if(reusable&&!this.cancelled)saveFlow(this.root,this.key,{version:3,documentValidation:DOCUMENT_POLICY,portal:this.portal.url,steps:this.steps,learnedAt:new Date().toISOString(),sampleSha256:hash(buffer)});
    return {officialPortal:!!capture?.officialPortal,sourceUrl:capture?.url||'',learningStatus:reusable?'saved':'manual_required',parsed};
  }
  async finish(record) {
    if(this.result)return this.result;
    if(this.cancelled)throw Error('Consulta cancelada.');
    const learned=await this.complete(record.buffer);
    this.manual=false;this.result={...record,learned};
    this.notify('finished',learned.learningStatus==='saved'?'Certidão salva e roteiro do município registrado.':'Certidão salva. O roteiro ainda exige uma nova demonstração para automatizar o CNPJ.');
    this.resolve(this.result);return this.result;
  }
  async continue() {
    if(this.cancelled)throw Object.assign(Error('Consulta municipal encerrada.'),{status:409});
    if(this.result)return {ok:true,completed:true};
    if(this.continuing)return this.continuing;
    this.continuing=(async()=>{
      const record=await this.settleCapture();
      if(record){await this.finish(record);this.checkpoint?.();return {ok:true,completed:true};}
      if(this.lastCaptureError){this.notify('awaiting_manual',this.lastCaptureError);return {ok:true,pending:true,message:this.lastCaptureError};}
      if(this.checkpoint){this.checkpoint();return {ok:true,continued:true};}
      if(['opening','replaying','printing'].includes(this.state))return {ok:true,pending:true,message:'Aguarde a execução do roteiro.'};
      this.notify('awaiting_manual','O PDF ainda não foi recebido. Conclua a emissão e use Baixar ou Imprimir na mesma janela; depois clique em Continuar. A página não será reiniciada.');
      return {ok:true,pending:true,message:'Aguardando o download do PDF municipal.'};
    })();
    try{return await this.continuing;}finally{this.continuing=null;}
  }
  async run() {
    this.timer=setTimeout(()=>this.stop('Tempo da consulta municipal esgotado. O PDF já salvo permanece na pasta de destino.'),this.timeoutMs);this.timer.unref?.();
    try{
      const record=await Promise.race([this.start(),this.completion.then(()=>null)]);
      if(record&&!this.result)await this.finish(record);
      return await this.completion;
    }finally{await this.dispose();}
  }
  stop(message='Consulta municipal cancelada.') {
    if(this.cancelled)return;
    this.cancelled=true;this.manual=false;clearInterval(this.monitor);clearTimeout(this.timer);
    this.checkpoint?.();this.reject(new Error(message));
    for(const remove of this.listeners.splice(0))remove();
  }
  async dispose() {
    const wasCancelled=this.cancelled;
    this.stop();
    await this.printer?.dispose(this.pages);
    for(const cdp of this.downloadSessions||[]){if(!wasCancelled)await cdp.send('Page.setDownloadBehavior',{behavior:'default'}).catch(()=>{});await cdp.detach().catch(()=>{});}
  }
}
module.exports={MunicipalLearning,flowKey,sanitizeStep,readFlow,saveFlow};
