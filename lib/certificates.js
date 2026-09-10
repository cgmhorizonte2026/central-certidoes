const crypto = require('node:crypto');
const fs=require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { parseCertificate, assessment, sha256, today, validity } = require('./domain');
const { trustedUrl } = require('../config/registry');
function extractPdf(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'pdf-worker.js'), { workerData: buffer, resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Tempo de leitura do PDF excedido.')); }, 20000);
    worker.once('message', message => { clearTimeout(timer); worker.terminate(); message.error ? reject(new Error(message.error)) : resolve(message); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Não foi possível ler o PDF.')); });
  });
}
class Certificates {
  constructor(store) { this.store = store; }
  present(cert) {
    if (!cert) return null;
    const integrity = this.store.intact(cert.file);
    let validation = cert.validation;
    if (validation?.evidenceFile && !this.store.intact(validation.evidenceFile)) validation = { ...validation, status: 'evidence_integrity_failed' };
    if(validation?.evidence&&(!this.store.intact(validation.evidence.screenshot)||!this.store.intact(validation.evidence.pageText)))validation={...validation,status:'evidence_integrity_failed'};
    const captureMethods=['official_browser_download','official_response','official_download','official_print_view'];
    const officialCapture=captureMethods.includes(cert.provenance?.method)&&!!cert.provenance?.url&&!!cert.provenance?.jobId;
    const value = { ...cert, integrity, validation, officialCapture }; return { ...value, assessment: assessment(value), validity: validity(cert.parsed) };
  }
  async ingest({ buffer, cnpj, portal, actor, provenance = { method: 'upload' }, mode = 'issue', certificateId = null }) {
    if (!Buffer.isBuffer(buffer) || buffer.length > 15 * 1024 * 1024 || !buffer.subarray(0,5).equals(Buffer.from('%PDF-'))) throw Object.assign(new Error('Envie um PDF de até 15 MB.'), { status: 400 });
    const result = await extractPdf(buffer).catch(e => { throw Object.assign(e, { status: 422 }); });
    const parsed = parseCertificate(result.text, cnpj, portal.kind);
    if(portal.key==='federal'&&provenance.method!=='upload'){
      if(/nao foi possivel|acesso negado|servico indisponivel|access denied/i.test(require('./domain').plain(result.text))||provenance.method==='official_html_print'||provenance.method==='official_print_view'||!parsed.cnpjMatches||!parsed.kindMatches||!['negativa','positiva','positiva_efeitos_negativa'].includes(parsed.classification))throw Object.assign(new Error('PDF federal rejeitado: o conteúdo não confirma a certidão e o identificador consultado. Nenhum documento foi anexado.'),{status:422});
    }
    const duplicate=this.store.all('certificate').find(c=>c.file.sha256===sha256(buffer)&&this.store.intact(c.file));
    const file = this.store.saveCertificateFile(cnpj,portal.key,buffer,duplicate?.file);
    const official = provenance.method !== 'upload' && trustedUrl(provenance.url, portal);
    const cert = { id: crypto.randomUUID(), cnpj, portalKey: portal.key, portalName: portal.name, kind: portal.kind, file, parsed, pages: result.pages, uploadedAt: new Date().toISOString(), actor, provenance: official ? provenance : { method: 'upload' }, validation: { status: 'pending' } };
    this.store.put('certificate', cert.id, cert);
    this.store.audit({ type: official ? 'official_pdf_captured' : 'pdf_uploaded', cnpj, certificateId: cert.id, portal: portal.key, file, parsed, provenance: cert.provenance }, actor);
    if (official && mode === 'verify' && certificateId) {
      const previous = this.store.get('certificate', certificateId);
      if (previous && previous.cnpj === cnpj && previous.portalKey === portal.key) {
        const exact = portal.review !== 'descoberto_nao_homologado' && previous.file.sha256 === file.sha256 && this.store.intact(previous.file) && parsed.cnpjMatches && parsed.kindMatches;
        previous.validation = { status: exact ? 'confirmed_exact_official_pdf' : 'different_official_pdf', checkedAt: new Date().toISOString(), method: 'sha256_exact_match', evidenceFile: file, officialCertificateId: cert.id, sourceUrl: provenance.url, jobId: provenance.jobId, actor, note: exact ? 'Arquivo idêntico ao PDF capturado nesta consulta ao portal. Não inclui verificação criptográfica de assinatura nem decisão de pagamento.' : 'O PDF obtido é diferente. Isso pode decorrer de nova emissão; não comprova falsificação nem valida o PDF anterior.' };
        this.store.put('certificate', previous.id, previous);
        this.store.audit({ type: 'official_pdf_comparison', cnpj, certificateId: previous.id, result: previous.validation }, actor);
      }
    }
    return this.present(cert);
  }
  latest(cnpj, portalKey, all = this.store.all('certificate')) {
    const values = all.filter(c => c.cnpj === cnpj && c.portalKey === portalKey).sort((a,b)=>(b.uploadedAt||'').localeCompare(a.uploadedAt||''));
    const references=new Set(all.map(c=>c.validation?.officialCertificateId).filter(Boolean));
    // A verification reference must not displace the document being verified.
    return values.find(c => !references.has(c.id)) || values[0] || null;
  }
  confirmOfficialRecord({certificateId,portal,query,evidence,jobId,actor}){
    const cert=this.store.get('certificate',certificateId);
    if(!cert||portal.key!=='trabalhista'||cert.portalKey!==portal.key||cert.cnpj!==query.cnpj||cert.parsed.number!==query.number||cert.file.sha256!==query.sha256||!this.store.intact(cert.file)||!trustedUrl(evidence.url,portal)||new URL(evidence.url).pathname!=='/consultarCertidao'||new URL(evidence.url).hostname!=='cndt-certidao.tst.jus.br'||!this.store.intact(evidence.screenshot)||!this.store.intact(evidence.pageText))throw new Error('Não foi possível vincular a confirmação oficial ao PDF selecionado.');
    const original=cert.provenance.method!=='upload'&&trustedUrl(cert.provenance.url,portal);
    const response=fs.readFileSync(this.store.resolve(evidence.pageText.path),'utf8');
    if(!/Operação efetuada com sucesso\./i.test(response)||/Não existe Certidão Nacional/i.test(response))throw new Error('A evidência não contém uma confirmação positiva do TST.');
    cert.validation={officialCertificateId:cert.validation?.officialCertificateId,evidenceFile:cert.validation?.evidenceFile,status:original?'confirmed_official_record':'record_found_content_unverified',checkedAt:evidence.capturedAt,method:'tst_cnpj_number_year',query,evidence,sourceUrl:evidence.url,jobId,actor,note:original?'O TST confirmou o CNPJ, número e ano da CNDT. PDF capturado do órgão e íntegro desde a captura. Não inclui verificação criptográfica de assinatura.':'O TST confirmou a existência do número informado. O conteúdo do PDF anexado não foi comparado com o documento original.'};
    this.store.put('certificate',cert.id,cert);this.store.audit({type:'official_record_validation',cnpj:cert.cnpj,certificateId:cert.id,validation:cert.validation},actor);return this.present(cert);
  }
  reusable(cnpj,portal,date=today()){
    const all=this.store.all('certificate'),references=new Set(all.map(c=>c.validation?.officialCertificateId).filter(Boolean));
    const recent=all.filter(c=>c.cnpj===cnpj&&c.portalKey===portal.key&&!references.has(c.id)).sort((a,b)=>(b.uploadedAt||'').localeCompare(a.uploadedAt||''));
    const c=recent[0];
    if(!c||c.provenance.method==='upload'||(portal.key==='fgts'&&c.provenance.method==='official_html_print')||!trustedUrl(c.provenance.url,portal)||c.parsed.issuedAt>date)return null;
    if(!c||!this.store.intact(c.file)||!c.parsed.cnpjMatches||!c.parsed.kindMatches||!['negativa','positiva','positiva_efeitos_negativa','regular_fgts'].includes(c.parsed.classification))return null;
    const term=validity(c.parsed,date),days=term.remainingDays;
    if(term.status!=='current')return null;
    return {...this.present(c),remainingDays:days};
  }
}
module.exports = { Certificates, extractPdf };
