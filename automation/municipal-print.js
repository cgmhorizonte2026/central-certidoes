const crypto = require('node:crypto');
const {parseCertificate,plain} = require('../lib/domain');
const {launchBrowser} = require('./launch');

const DOCUMENT_POLICY = 'municipal-final-v1';
function finalMunicipalDocument(text, cnpj) {
  const parsed=parseCertificate(text,cnpj,'municipal'), t=plain(text).replace(/\s+/g,' ');
  const preliminary=/resultado (?:da|de) consulta|listagem de certidoes|certidoes disponiveis|selecione.{0,50}certidao.{0,40}imprimir|esta pagina nao (?:e|constitui) uma certidao/.test(t);
  const declaration=/certificamos|certifico|certifica-se|certifica que|fica certificado|ressalvad[oa]|nada consta|nao (?:constam|existem|possui).{0,60}debitos|constam.{0,60}debitos|declara(?:mos)? que/.test(t);
  const identity=parsed.number||parsed.controlCode||parsed.expiresAt||/chave (?:de consulta|de autenticidade|de validacao)\s*[:\-]?\s*[a-z0-9.-]{5,}/.test(t);
  const valid=parsed.cnpjMatches&&parsed.kindMatches&&parsed.classification!=='indeterminada'&&declaration&&!!identity&&!preliminary;
  return {valid,parsed,reason:valid?'':'O arquivo parece ser uma consulta, listagem ou documento incompleto. Abra a certidão e use Imprimir; a página de resultados não será arquivada como certidão.'};
}

// Installed before portal scripts, also in popups and frames. Snapshot at the
// instant print() is called: some portals restore the DOM or close immediately.
function installPrintHook({binding,origin}) {
  let sameOrigin=location.origin===origin;
  try { if(location.href==='about:blank'||location.href==='about:srcdoc')sameOrigin=parent.location.origin===origin||opener?.location.origin===origin; } catch {}
  if(!sameOrigin||window[binding+'restore'])return;
  const nativePrint=window.print,nativeClose=window.close;
  let busy=false,closeRequested=false;
  const snapshot=doc=>{
    const clone=doc.documentElement.cloneNode(true);
    [...doc.querySelectorAll('style')].forEach((style,i)=>{try{clone.querySelectorAll('style')[i].textContent=[...style.sheet.cssRules].map(rule=>rule.cssText).join('\n');}catch{}});
    const originals=doc.querySelectorAll('input,textarea,select,canvas,iframe');
    const copies=clone.querySelectorAll('input,textarea,select,canvas,iframe');
    originals.forEach((el,i)=>{
      const copy=copies[i];if(!copy)return;
      if(el.tagName==='CANVAS'){try{const img=doc.createElement('img');img.src=el.toDataURL();img.style.cssText=el.style.cssText;copy.replaceWith(img);}catch{copy.remove();}}
      else if(el.tagName==='IFRAME'){try{if(el.contentDocument?.documentElement){copy.removeAttribute('src');copy.srcdoc=snapshot(el.contentDocument);}else copy.remove();}catch{copy.remove();}}
      else if(el.tagName==='TEXTAREA')copy.textContent=el.value;
      else if(el.tagName==='SELECT')[...copy.options].forEach((option,n)=>{if(el.options[n].selected)option.setAttribute('selected','');else option.removeAttribute('selected');});
      else if(el.type==='password'||/captcha|token|senha|secret/i.test(el.name+' '+el.id))copy.remove();
      else{copy.setAttribute('value',el.value);if(el.checked)copy.setAttribute('checked','');else copy.removeAttribute('checked');}
    });
    clone.querySelectorAll('script,base,meta[http-equiv],object,embed').forEach(el=>el.remove());
    clone.querySelectorAll('*').forEach(el=>{for(const attribute of [...el.attributes])if(/^on/i.test(attribute.name)||/^javascript:/i.test(attribute.value))el.removeAttribute(attribute.name);});
    const base=doc.createElement('base');base.href=doc.baseURI;clone.querySelector('head')?.prepend(base);
    return '<!doctype html>'+clone.outerHTML;
  };
  const print=function(){
    if(busy)return;
    busy=true;window.dispatchEvent(new Event('beforeprint'));
    let html;
    try{html=snapshot(document);}catch{busy=false;return nativePrint.call(window);}
    window[binding]({html}).then(result=>{
      if(result?.handled===false)nativePrint.call(window);
      // Keep failed print views open so the user can correct or retry.
      if(result?.ok&&closeRequested)nativeClose.call(window);
    }).catch(()=>{}).finally(()=>{busy=false;window.dispatchEvent(new Event('afterprint'));});
  };
  const close=function(){if(busy){closeRequested=true;return;}return nativeClose.call(window);};
  window.print=print;window.close=close;
  window[binding+'restore']=()=>{if(window.print===print)window.print=nativePrint;if(window.close===close)window.close=nativeClose;};
}

class MunicipalPrintCapture {
  constructor({context,portal,ownsPage,isCancelled,onPdf,originalPdf=async()=>null,emit}) {
    Object.assign(this,{context,portal,ownsPage,isCancelled,onPdf,originalPdf,emit});
    this.binding='centralPrint'+crypto.randomBytes(8).toString('hex');
    this.pending=new Set();this.renderers=new Set();this.disposed=false;
  }
  async install() {
    await this.context.exposeBinding(this.binding,({page,frame},payload)=>{
      const work=this.handle(page,frame,payload);
      this.pending.add(work);work.finally(()=>this.pending.delete(work)).catch(()=>{});
      return work;
    });
    await this.context.addInitScript(installPrintHook,{binding:this.binding,origin:new URL(this.portal.url).origin});
  }
  async handle(page,frame,payload) {
    if(this.disposed||this.isCancelled()||!await this.ownsPage(page))return {handled:false};
    let source=frame.url();
    if(['about:blank','about:srcdoc',''].includes(source))source=frame.parentFrame()?.url()||(await page.opener())?.url()||'';
    try{if(new URL(source).origin!==new URL(this.portal.url).origin)return {handled:false};}catch{return {handled:false};}
    if(typeof payload?.html!=='string'||Buffer.byteLength(payload.html)>8*1024*1024)return {handled:true,ok:false};
    let renderer;
    try{
      if(await this.originalPdf())return {handled:true,ok:true};
      this.emit({type:'municipal_print_started',portal:'municipal',message:'Preparando o PDF da versão de impressão do portal.'});
      renderer=await launchBrowser(true);this.renderers.add(renderer);
      if(this.disposed||this.isCancelled())return {handled:true,ok:false};
      const context=await renderer.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
      await context.addCookies(await this.context.cookies(source));
      // Static print rendering: never execute portal scripts or submit requests.
      await context.route('**/*',route=>{
        const req=route.request();let allowed=false;
        try{allowed=new URL(req.url()).origin===new URL(source).origin;}catch{}
        return allowed&&['GET','HEAD'].includes(req.method())?route.continue():route.abort();
      });
      const target=await context.newPage();
      await target.emulateMedia({media:'print'});
      await target.setContent(payload.html,{waitUntil:'load',timeout:15000});
      const bytes=await target.pdf({format:'A4',preferCSSPageSize:true,printBackground:true,timeout:15000});
      if(this.disposed||this.isCancelled())return {handled:true,ok:false};
      const captured=await this.onPdf(bytes,source,'official_print_view');
      return {handled:true,ok:!!captured&&!this.isCancelled()};
    }catch(error){
      if(!this.isCancelled())this.emit({type:'municipal_print_rejected',portal:'municipal',message:error.message});
      return {handled:true,ok:false};
    }finally{if(renderer){this.renderers.delete(renderer);await renderer.close().catch(()=>{});}}
  }
  async dispose(pages) {
    this.disposed=true;
    await Promise.allSettled([...this.renderers].map(browser=>browser.close()));
    await Promise.allSettled([...pages].filter(page=>!page.isClosed()).flatMap(page=>page.frames().map(frame=>frame.evaluate(binding=>window[binding+'restore']?.(),this.binding))));
  }
}
module.exports={MunicipalPrintCapture,finalMunicipalDocument,DOCUMENT_POLICY};
