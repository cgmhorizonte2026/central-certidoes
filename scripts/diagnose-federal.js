// Visible, manual-security diagnostic. Never records identifiers, headers, cookies or tokens.
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('../lib/store'),{Certificates}=require('../lib/certificates');
const {PortalSessions}=require('../automation/sessions'),{launchBrowser}=require('../automation/launch');
const {routesFor}=require('../config/registry');const {safeUrl,safeLog}=require('../automation/federal-support');
(async()=>{
 const main=new Store(path.join(__dirname,'../data'));
 const company=main.all('company').find(c=>c.municipalityCode==='2313906');main.close();
 if(!company)throw Error('Empresa previamente autorizada não encontrada na base.');
 const root=path.resolve(__dirname,'../tmp/federal-audit-after'),store=new Store(root),certificates=new Certificates(store),events=[];
 const save=(stage,details={})=>{const event={at:new Date().toISOString(),stage,...details};events.push(event);fs.writeFileSync(path.join(root,'events.json'),JSON.stringify(events,null,2));console.log(JSON.stringify(event));};
 let resolvePage;const pageReady=new Promise(resolve=>resolvePage=resolve);let pending=[];
 const manager=new PortalSessions({store,onPdf:p=>certificates.ingest(p),openBrowser:async()=>{
  const browser=await launchBrowser(false),context=await browser.newContext({acceptDownloads:true});
  context.on('page',page=>{resolvePage(page);page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/servico/certidoes/api/'))save('request',{url:safeUrl(r.url()),method:r.method()});});page.on('response',r=>{if(new URL(r.url()).pathname.startsWith('/servico/certidoes/api/'))save('response',{url:safeUrl(r.url()),status:r.status(),contentType:r.headers()['content-type']});});});
  return {browser,context,busterAvailable:false,browserMethod:'visible_manual',browserNote:'Navegador visível, sem extensão de CAPTCHA.'};
 }});
 manager.log=(job,method,message)=>save(method,{url:safeUrl(job.currentUrl||job.portal.url),message:safeLog(message,company.cnpj)});
 let job;
 try{
  const started=await manager.start(company,routesFor(company).find(p=>p.key==='federal'),'diagnostico_manual','issue');job=manager.jobs.get(started.id);const page=await pageReady;
  await page.locator('input[name="niContribuinte"]').waitFor({state:'visible',timeout:45000});
  await page.screenshot({path:path.join(root,'01-form.png'),mask:[page.locator('input')],fullPage:true});save('form_visible',{url:safeUrl(page.url())});
  await page.waitForFunction(()=>/Mensagem de Erro|Certidão Válida Encontrada|Não foi possível|Emitir Nova Certidão/i.test(document.body.innerText),{},{timeout:60000}).catch(()=>save('response_wait_expired'));
  await manager.guide(job);
  await page.screenshot({path:path.join(root,'02-result.png'),mask:[page.locator('input')],fullPage:true});
  save('result',{url:safeUrl(page.url()),status:job.status,humanAction:job.status==='captcha_required',pdfCount:job.files.length});
  if(job.files.length){await manager.finish(job.id);save('pdf_verified',{count:job.files.length,valid:job.files.every(id=>store.intact(store.get('certificate',id).file))});}
  else save('no_pdf',{reason:'A etapa de segurança não foi concluída; não houve PDF para validar.'});
 }finally{if(job&&!['finished','cancelled'].includes(job.status))await manager.cancel(job.id,'Teste diagnóstico encerrado; a sessão de uso normal permanece manual enquanto houver bloqueio.');store.close();}
})().catch(e=>{console.error(safeLog(e.message.split('\n')[0]));process.exitCode=1;});
