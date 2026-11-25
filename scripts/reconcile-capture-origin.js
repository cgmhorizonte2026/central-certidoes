// Explicit maintenance only. Never infers official origin from PDF text alone.
const fs=require('node:fs'),path=require('node:path');
const {hash,officialUrl}=require('../automation/capture-provenance');
async function main(){
 const cnpj=process.argv[2];if(!/^\d{14}$/.test(cnpj||''))throw Error('Informe o CNPJ com 14 dígitos.');
 const root=path.resolve(__dirname,'..'),storage=process.env.CENTRAL_CERTIDOES_STORAGE||path.join(process.env.LOCALAPPDATA,'CentralCertidoes');
 const index=path.join(storage,'archive',cnpj+'.json'),original=fs.readFileSync(index,'utf8'),archive=JSON.parse(original);
 const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(root,'data/chrome-automation-profile/Default/History'),{readOnly:true});
 const plans=[];
 try{for(const [key,cert] of Object.entries(archive.certificates||{})){
  if(!['federal','ceara'].includes(key)||cert.officialPortal||cert.source!=='controlled_browser'||!cert.sessionId||!cert.sha256)continue;
  if(!/^[a-z0-9-]+$/i.test(cert.sessionId))continue;
  const bytes=fs.readFileSync(cert.filePath);if(hash(bytes)!==cert.sha256)throw Error('Integridade divergente: '+key);
  const parsed=await require('../lib/certificates').extractPdf(bytes);require('../lib/capture-validation').validateCapture(parsed.text,cnpj,key);
  const events=fs.readFileSync(path.join(root,'data/logs',cert.sessionId+'.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const portalKey=key==='ceara'?'estadual-ce':key,portal=require('../config/portals').find(p=>p.key===portalKey);
  const opened=events.find(e=>e.type==='portal_opening'&&e.portal===portalKey);
  const captured=events.find(e=>e.type==='downloaded'&&e.portal===portalKey);
  if(!opened||!captured||!officialUrl(opened.url,portal)||hash(fs.readFileSync(captured.filePath))!==cert.sha256)continue;
  const start=Date.parse(opened.time),end=Date.parse(cert.archivedAt),inSession=time=>Number(time)/1000-11644473600000>=start&&Number(time)/1000-11644473600000<=end;
  let evidence;
  if(key==='federal'){
   const dirs=events.filter(e=>e.type==='download_dir_ready'&&e.portal===portalKey).map(e=>path.resolve(e.downloadDir));
   const rows=db.prepare('select d.id,d.target_path,d.tab_url,cast(d.start_time as text) as time,u.url from downloads d join downloads_url_chains u on d.id=u.id where d.target_path like ?').all('%'+cnpj+'%');
   const found=rows.find(r=>inSession(r.time)&&dirs.includes(path.dirname(r.target_path))&&officialUrl(r.tab_url,portal)&&officialUrl(r.url.replace(/^blob:/,''),portal)&&fs.existsSync(r.target_path)&&hash(fs.readFileSync(r.target_path))===cert.sha256);
   if(found)evidence={sourceUrl:found.url.replace(/^blob:/,''),captureMethod:'reconciled_browser_download',browserDownloadId:found.id,tabUrl:found.tab_url};
  }else{
   const info=(await require('pdf-parse')(bytes)).info;
   const title=info?.Title||'',sourceUrl=title.startsWith('https://')?title:'https://'+title;
   if(!officialUrl(sourceUrl,portal))continue;
   const url=new URL(sourceUrl);if(url.searchParams.get('codigoDevedor')!==cnpj||url.searchParams.get('numCertificado')!==cert.numero)continue;
   const visit=db.prepare('select cast(v.visit_time as text) as time from visits v join urls u on u.id=v.url where u.url=?').all(sourceUrl).find(r=>inSession(r.time));
   if(visit&&/Skia\/PDF/.test(info.Producer||''))evidence={sourceUrl,captureMethod:'reconciled_official_print_view',browserVisitTime:visit.time,pdfProducer:info.Producer,pdfCreationDate:info.CreationDate};
  }
  if(evidence)plans.push({key,cert,evidence});
 }}finally{db.close();}
 console.log(JSON.stringify({cnpj,eligible:plans.map(p=>p.key),apply:process.argv.includes('--apply')}));
 if(!process.argv.includes('--apply')||!plans.length)return;
 // Guard against replacing metadata updated by another running consultation.
 if(fs.readFileSync(index,'utf8')!==original)throw Error('Arquivo mudou durante a conferência. Repita sem consultas em andamento.');
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');fs.writeFileSync(index+'.before-origin-'+stamp+'.bak',original,{flag:'wx'});
 for(const {cert,evidence} of plans){
  const sidecar=cert.filePath+'.capture.json';if(fs.existsSync(sidecar))fs.copyFileSync(sidecar,sidecar+'.before-origin-'+stamp+'.bak',fs.constants.COPYFILE_EXCL);
  const correction={at:new Date().toISOString(),previousOfficialPortal:cert.officialPortal,previousCaptureMethod:cert.captureMethod,evidence};
  Object.assign(cert,{officialPortal:true,sourceUrl:evidence.sourceUrl,captureMethod:evidence.captureMethod,originReconciliation:correction});
  fs.writeFileSync(sidecar+'.tmp',JSON.stringify(cert,null,2));fs.renameSync(sidecar+'.tmp',sidecar);
 }
 archive.updatedAt=new Date().toISOString();fs.writeFileSync(index+'.tmp',JSON.stringify(archive,null,2));fs.renameSync(index+'.tmp',index);
 console.log('Metadados reconciliados; PDFs preservados.');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
