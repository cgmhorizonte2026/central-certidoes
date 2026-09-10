const crypto = require('node:crypto');
const {safeUrl,safeLog,decodePdfPayload}=require('./federal-support');
const { openRobotBrowser } = require('./robot-browser');
const { resolveCaptcha } = require('./captcha');
const { trustedUrl } = require('../config/registry');
const { parseCertificate } = require('../lib/domain');
const { advance } = require('./issuer-engine');
const {advanceVerification}=require('./verification');
const {userError}=require('../lib/errors');
class PortalSessions {
  constructor({ store, onPdf,onVerification,openBrowser=openRobotBrowser }) { this.store = store; this.onPdf = onPdf;this.onVerification=onVerification; this.openBrowser=openBrowser;this.jobs = new Map(); }
  view(job) { const { browser, context, page, captures, seen, timer, monitor, monitoring, ...publicJob } = job; return publicJob; }
  log(job,method,message){console.info(JSON.stringify({at:new Date().toISOString(),jobId:job.id,portal:job.portal.key,method,message:safeLog(message,job.cnpj)}));}
  update(job, status, message) { if(job.status!==status||job.message!==message)this.log(job,status,message);job.status = status; job.message = message; job.updatedAt = new Date().toISOString(); this.store.put('job', job.id, this.view(job)); }
  async start(company, portal, actor, mode = 'issue', certificateId = null) {
    if (!portal.url) throw Object.assign(new Error('Portal desta localidade ainda não cadastrado.'), { status: 409 });
    if ([...this.jobs.values()].some(j => !['finished','cancelled','error'].includes(j.status))) throw Object.assign(new Error('Conclua ou cancele a consulta aberta antes de iniciar outra.'), { status: 409 });
    const job = { id: crypto.randomUUID(), cnpj: company.cnpj, portal, actor, mode, certificateId, status: 'opening', message: 'Abrindo órgão emissor…', createdAt: new Date().toISOString(), files: [], captures: new Set(), seen: new Set(), evidence: [] };
    if(mode==='verify'){
      if(!portal.verifyUrl)throw Object.assign(new Error('Endereço de autenticação não configurado para este órgão.'),{status:409});
      if(portal.verifyUrl===portal.url)throw Object.assign(new Error('O cadastro deste órgão ainda não possui um fluxo próprio de autenticação. Cadastre o endereço correto; o sistema não abrirá a emissão no lugar da validação.'),{status:409});
      const cert=this.store.get('certificate',certificateId);if(!cert||cert.cnpj!==company.cnpj||cert.portalKey!==portal.key||!this.store.intact(cert.file))throw Object.assign(new Error('Selecione um PDF íntegro desta empresa e órgão para validar.'),{status:409});
      const extracted=await require('../lib/certificates').extractPdf(require('node:fs').readFileSync(this.store.resolve(cert.file.path)));
      const parsed=parseCertificate(extracted.text,company.cnpj,portal.kind);
      if(!parsed.cnpjMatches||!parsed.kindMatches)throw Object.assign(new Error('O PDF não identifica o CNPJ e o tipo de certidão selecionados. Confira o documento antes de validar.'),{status:409});
      job.verificationTarget={...parsed,sha256:cert.file.sha256};
    }
    this.jobs.set(job.id, job); this.update(job, 'opening', 'Abrindo órgão emissor…');
    this.open(job).catch(async e => {
      this.log(job,'falha_tecnica',userError(e));
      if(job.status==='cancelled')return;
      if(job.context?.pages().some(p=>!p.isClosed())){this.update(job,'awaiting_user',userError(e));this.startMonitoring(job);}
      else{this.update(job,'error',userError(e));await this.close(job);}
    });
    return this.view(job);
  }
  track(job, promise) { job.captures.add(promise); promise.catch(e => {this.log(job,'pdf_falha',e.message.split('\n')[0]);if(!['finished','cancelled','error'].includes(job.status))this.update(job,'awaiting_user',`Falha ao capturar documento: ${e.message.split('\n')[0]}`);}).finally(() => job.captures.delete(promise)); }
  async receive(job, buffer, url, origin) {
    if (job.status === 'cancelled' || !trustedUrl(url, job.portal) || buffer.length > 15 * 1024 * 1024 || !buffer.subarray(0,5).equals(Buffer.from('%PDF-'))) return;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex'); if (job.seen.has(hash)) return; job.seen.add(hash);
    const cert = await this.onPdf({ buffer, cnpj: job.cnpj, portal: job.portal, actor: job.actor, provenance: { method: origin, url, capturedAt: new Date().toISOString(), jobId: job.id }, mode: job.mode, certificateId: job.certificateId });
    if(['finished','cancelled','error'].includes(job.status))return;
    this.log(job,'pdf_salvo',`${cert.file?.path||cert.id}; validade: ${cert.parsed?.expiresAt||'não identificada'}; situação: ${cert.parsed?.classification||'não identificada'}`);
    job.files.push(cert.id); if(job.status!=='capturing')this.update(job, 'document_captured', 'PDF capturado do órgão. Conclua a sessão para guardar a evidência da tela.');
  }
  async open(job) {
    Object.assign(job,await this.openBrowser({root:this.store.root,actor:job.actor,cnpj:job.cnpj,portalKey:job.portal.key,log:(method,message)=>this.log(job,method,message)}));
    if (job.status === 'cancelled') { await this.close(job); return; }
    this.log(job,job.browserMethod,job.browserNote);
    const attach = page => {
      if(job.portal.key==='federal'){
        page.on('request',r=>{if(trustedUrl(r.url(),job.portal)&&['xhr','fetch'].includes(r.resourceType()))this.log(job,'requisicao_oficial',r.method()+' '+safeUrl(r.url()));});
        page.on('requestfailed',r=>{if(trustedUrl(r.url(),job.portal))this.log(job,'requisicao_falhou',safeUrl(r.url())+' '+r.failure()?.errorText);});
        page.on('framenavigated',f=>{if(f===page.mainFrame())this.log(job,'navegacao',safeUrl(f.url()));});
      }
      page.on('download', d => {
        this.track(job, (async () => {
          const blob=d.url().startsWith('blob:')&&trustedUrl(d.url().slice(5),job.portal)&&trustedUrl(page.url(),job.portal);
          const dataPdf=job.portal.key==='federal'&&trustedUrl(page.url(),job.portal)&&d.url().startsWith('data:application/pdf');
          if(!blob&&!dataPdf&&!trustedUrl(d.url(),job.portal))return;
          const stream=await d.createReadStream();if(!stream)return;let n=0;const chunks=[];
          for await(const chunk of stream){n+=chunk.length;if(n>15*1024*1024){stream.destroy();throw new Error('PDF excede 15 MB.');}chunks.push(chunk);}
          await this.receive(job,Buffer.concat(chunks),blob||dataPdf?page.url():d.url(),blob||dataPdf?'official_browser_download':'official_download');
        })());
      });
      page.on('response', response => {
        if(job.portal.key==='federal'&&trustedUrl(response.url(),job.portal)&&['xhr','fetch'].includes(response.request().resourceType())){
          this.log(job,'resposta_oficial',response.status()+' '+safeUrl(response.url()));
          if(response.status()===200&&/application\/json/i.test(response.headers()['content-type']||'')&&Number(response.headers()['content-length']||0)<22*1024*1024){
            this.track(job,(async()=>{const raw=await response.body();if(raw.length>22*1024*1024)return;let json;try{json=JSON.parse(raw.toString('utf8'));}catch{return;}const pdf=decodePdfPayload(json);if(pdf)await this.receive(job,pdf,response.url(),'official_response');})());
          }
        }
        if (/^attachment\b/i.test(response.headers()['content-disposition'] || '')) return; // Download listener captures attachment bytes.
        if (response.status() !== 200 || !trustedUrl(response.url(), job.portal) || !/application\/pdf/i.test(response.headers()['content-type'] || '')) return;
        this.track(job, (async () => { if (Number(response.headers()['content-length'] || 0) > 15 * 1024 * 1024) return; await this.receive(job, await response.body(), response.url(), 'official_response'); })());
      });
    };
    job.context.on('page', attach); job.page = await job.context.newPage();
    await job.page.goto(job.mode === 'verify' ? job.portal.verifyUrl : job.portal.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if(job.portal.key==='federal'&&job.mode==='issue'){
      // Receita Federal is a SPA: DOMContentLoaded precedes the CNPJ form.
      const field=job.page.locator('input[name="niContribuinte"]');
      try{await field.waitFor({state:'visible',timeout:15000});}catch{
        const pj=job.page.getByText('Pessoa Jurídica',{exact:true}).first();
        if(await pj.isVisible()){await pj.click({timeout:5000});await field.waitFor({state:'visible',timeout:15000});}
      }
    }
    await this.guide(job);
    if(job.status==='cancelled')return;
    await this.guide(job);
    await job.page.bringToFront();
    this.store.audit({ type: 'portal_opened', cnpj: job.cnpj, jobId: job.id, portal: job.portal.key, mode: job.mode, url: job.page.url() }, job.actor);
    this.startMonitoring(job);
  }
  startMonitoring(job){
    if(job.monitor)return;
    job.timer=setTimeout(()=>this.cancel(job.id,'Sessão encerrada após 20 minutos.').catch(()=>{}),20*60*1000);job.timer.unref();
    job.monitor=setInterval(async()=>{
      if(job.monitoring||['finished','cancelled','error','capturing'].includes(job.status))return;
      job.monitoring=true;
      try{if(job.mode==='verify'&&job.portal.key==='trabalhista'&&!job.verificationComplete)await this.guide(job);else if(job.files.length||job.verificationComplete)await this.finish(job.id);else if(job.context?.pages().length)await this.guide(job);}catch(e){job.captureWarning=userError(e);if(!['finished','cancelled','error','capturing'].includes(job.status))this.update(job,'awaiting_user',userError(e));}finally{job.monitoring=false;}
    },3000);job.monitor.unref();
  }
  live(id){const j=this.jobs.get(id);if(!j?.context||['finished','cancelled','error'].includes(j.status))throw Object.assign(new Error('Consulta encerrada. Inicie uma nova emissão.'),{status:409});return j;}
  activePage(job){const pages=job.context.pages();return pages.filter(p=>trustedUrl(p.url(),job.portal)).at(-1)||pages.find(p=>p===job.page)||pages.at(-1);}
  async focus(id){const j=this.live(id);const page=this.activePage(j);await page.bringToFront();return {ok:true,message:'Janela do órgão selecionada. Procure o navegador aberto pela Central na barra de tarefas.'};}
  async preview(id){const j=this.live(id);return this.activePage(j).screenshot({timeout:10000});}
  async interact(id,input){
    const job=this.live(id),page=this.activePage(job);
    if(['opening','capturing'].includes(job.status))throw Object.assign(new Error('Aguarde o carregamento da consulta.'),{status:409});
    if(!trustedUrl(page.url(),job.portal))throw Object.assign(new Error('A página atual está fora do domínio oficial cadastrado. Interação bloqueada.'),{status:409});
    if(input.action==='click'){
      if(!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.x>1||input.y<0||input.y>1)throw Object.assign(new Error('Posição inválida.'),{status:400});
      const size=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));await page.mouse.click(input.x*size.width,input.y*size.height);
    }else if(input.action==='text'){
      if(typeof input.text!=='string'||input.text.length>500)throw Object.assign(new Error('Texto inválido.'),{status:400});
      await page.keyboard.insertText(input.text);
    }else if(input.action==='key'&&['Tab','Enter','Backspace','Escape','ArrowDown','ArrowUp'].includes(input.key))await page.keyboard.press(input.key);
    else if(input.action==='scroll'&&[-600,600].includes(input.delta))await page.mouse.wheel(0,input.delta);
    else throw Object.assign(new Error('Comando inválido.'),{status:400});
    return {ok:true};
  }
  async guide(job){
    if(['finished','cancelled','error','capturing'].includes(job.status))return;
    job.currentUrl=this.activePage(job)?.url();
    if(job.portal.key==='federal'&&!job.files.length){
      for(const page of job.context.pages()){
        const blobPage=page.url().startsWith('blob:')&&trustedUrl(page.url().slice(5),job.portal);
        const owner=trustedUrl(page.url(),job.portal)?page:blobPage?await page.opener():null;
        if(!owner||!trustedUrl(owner.url(),job.portal))continue;
        const sources=blobPage?[page.url()]:await page.locator('iframe[src],embed[src],object[data],a[download][href]').evaluateAll(es=>es.map(e=>e.getAttribute('src')||e.getAttribute('data')||e.getAttribute('href')));
        for(const source of sources){
          if(typeof source!=='string'||source.length>22*1024*1024)continue;
          let bytes=null;
          if(source.startsWith('data:application/pdf'))bytes=decodePdfPayload(source);
          else if(source.startsWith('blob:')&&trustedUrl(source.slice(5),job.portal)){
            const encoded=await owner.evaluate(async url=>{const r=await fetch(url),blob=await r.blob();if(blob.size>15*1024*1024)return null;return new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>resolve(null);reader.readAsDataURL(blob);});},source).catch(()=>null);
            if(encoded)bytes=decodePdfPayload(encoded);
          }
          if(bytes){await this.receive(job,bytes,owner.url(),'official_browser_download');return;}
        }
      }
    }
    if(job.mode==='issue'&&job.files.length){job.captchaDetected=false;return;}
    if(job.mode==='issue'&&job.portal.key==='estadual'){
      for(const page of job.context.pages()){
        if(!trustedUrl(page.url(),job.portal))continue;
        const url=new URL(page.url());
        if(url.hostname!=='consultapublica.sefaz.ce.gov.br'||url.pathname!=='/certidaonegativa/consultarPdf')continue;
        const text=await page.locator('body').innerText({timeout:2500}),parsed=parseCertificate(text,job.cnpj,'estadual');
        if(parsed.cnpjMatches&&parsed.kindMatches&&parsed.expiresAt&&/IDENTIFICAÇÃO DO\(A\) REQUERENTE/i.test(text)&&/EMITIDA VIA INTERNET/i.test(text)){
          await this.receive(job,await page.pdf({format:'A4',printBackground:true}),page.url(),'official_print_view');job.captchaDetected=false;return;
        }
      }
    }
    if(job.mode==='issue'&&job.portal.key==='fgts'&&!job.files.length){
      for(const page of job.context.pages())if(trustedUrl(page.url(),job.portal)){
        const parsed=parseCertificate(await page.locator('body').innerText({timeout:2500}),job.cnpj,'fgts');
        // Caixa hides the print controls in its final printable layout.
        const printView=await page.locator('input[value="Imprimir"]').count()>0;
        const preliminary=await page.locator('input[value="Visualizar"]').count()>0;
        if(printView&&!preliminary&&parsed.cnpjMatches&&parsed.kindMatches&&parsed.expiresAt&&parsed.classification==='regular_fgts'){
          await this.receive(job,await page.pdf({format:'A4',printBackground:true}),page.url(),'official_print_view');return;
        }
      }
    }
    let result=job.mode==='verify'?await advanceVerification(job):await advance(job,event=>{this.store.audit(event,job.actor);this.log(job,'formulario',event.action||'Solicitação enviada.');});
    if(result?.confirmed&&!job.verificationComplete){
      const page=result.page,evidence={url:page.url(),capturedAt:new Date().toISOString(),screenshot:this.store.saveFile('evidence',await page.screenshot({fullPage:true}),'png'),pageText:this.store.saveFile('evidence',Buffer.from(await page.locator('body').innerText()),'txt')};
      if(!this.onVerification)throw new Error('Serviço de validação não configurado.');
      await this.onVerification({certificateId:job.certificateId,portal:job.portal,query:result.query,evidence,jobId:job.id,actor:job.actor});
      job.evidence.push(evidence);job.verificationComplete=true;job.verifiedCertificateId=job.certificateId;
    }
    if(job.mode==='issue'&&job.files.length){job.captchaDetected=false;return;}
    if(result?.status==='captcha_required'&&job.mode==='issue'&&job.portal.key!=='federal')result=await resolveCaptcha(job,(method,message)=>{
      this.log(job,method,message);this.store.audit({type:'captcha_attempt',jobId:job.id,cnpj:job.cnpj,portal:job.portal.key,method,message},job.actor);
    });
    if(!result||['finished','cancelled','error','capturing'].includes(job.status))return;
    job.captchaDetected=['captcha_required','captcha_solving'].includes(result.status);
    this.update(job,result.status,result.message);
  }
  async continue(id){const j=this.live(id);if(['capturing','opening'].includes(j.status))throw Object.assign(new Error('Aguarde a operação atual.'),{status:409});await this.guide(j);return this.view(j);}
  async finish(id, observation = '') {
    const job = this.jobs.get(id); if (!job || !job.context || ['finished','cancelled','error','opening','capturing'].includes(job.status)) throw Object.assign(new Error('Sessão não está pronta para conclusão.'), { status: 409 });
    await Promise.allSettled([...job.captures]);
    if(job.mode==='verify'&&job.portal.key==='trabalhista'&&!job.verificationComplete)throw Object.assign(new Error('Aguarde a confirmação do TST. Receber uma segunda via não encerra a validação.'),{status:409});
    if(!job.files.length&&!job.verificationComplete)throw Object.assign(new Error(job.mode==='verify'?'O órgão ainda não confirmou a autenticação. A consulta permanece aberta.':'Nenhum PDF foi recebido do órgão. A consulta permanece aberta. Use a janela interativa para concluir a emissão ou cancele a consulta.'),{status:409});
    this.update(job, 'capturing', 'Guardando evidências…'); await Promise.allSettled([...job.captures]);
    for (const page of job.context.pages()) {
      if (!trustedUrl(page.url(), job.portal)) continue;
      if(job.evidence.some(e=>e.url===page.url()))continue;
      try {
        const text = await page.locator('body').innerText({ timeout: 5000 });
        const screenshot = this.store.saveFile('evidence', await page.screenshot({ fullPage: true, timeout: 10000 }), 'png');
        const pageText = this.store.saveFile('evidence', Buffer.from(text, 'utf8'), 'txt');
        job.evidence.push({ url: page.url(), capturedAt: new Date().toISOString(), screenshot, pageText });
      } catch (e) { job.captureWarning = `Evidência parcial: ${e.message.split('\n')[0]}`; }
    }
    job.observation = String(observation).slice(0,2000);
    await Promise.allSettled([...job.captures]);
    if(job.status==='cancelled')return this.view(job);
    this.store.audit({ type: 'portal_evidence', cnpj: job.cnpj, jobId: job.id, portal: job.portal.key, files: job.files, evidence: job.evidence, observation: job.observation, automaticValidation: Boolean(job.verificationComplete) }, job.actor);
    this.update(job, 'finished', job.verificationComplete?'Consulta de autenticidade concluída no TST. Resposta oficial e evidências registradas.':'PDF recebido. Sessão e evidências registradas.');
    await this.close(job); return this.view(job);
  }
  async close(job) { clearTimeout(job.timer);clearInterval(job.monitor); await job.context?.close().catch(() => {});await job.browser?.close().catch(() => {}); job.browser = job.context = job.page = null; }
  async cancel(id, message = 'Consulta cancelada.') { const job = this.jobs.get(id); if (!job) throw Object.assign(new Error('Sessão não encontrada.'), { status: 404 }); this.update(job, 'cancelled', message); await this.close(job); this.store.audit({ type: 'portal_cancelled', cnpj: job.cnpj, jobId: id }, job.actor); return this.view(job); }
}
module.exports = { PortalSessions };
