// Real portal smoke check. Uses the supplied CNPJ; never solves security challenges.
const {launchBrowser}=require('../automation/launch');
const {advance}=require('../automation/issuer-engine');
const {national,states,municipal}=require('../config/registry');
const {validCnpj,normalizeCnpj}=require('../lib/domain');
(async()=>{
 const cnpj=normalizeCnpj(process.argv[2]||'');if(!validCnpj(cnpj))throw Error('Informe um CNPJ válido.');
 const key=process.argv[3]||'federal';
 const portal=key==='ce'?{key,url:states.CE[1],allowedHosts:['consultapublica.sefaz.ce.gov.br']}:key==='fortaleza'?{key,...municipal['2304400']}:national.find(p=>p.key===key);
 if(!portal)throw Error('Portal desconhecido.');const browser=await launchBrowser(true);
 try{const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();let pdf=false;page.on('download',()=>{pdf=true;});
 await page.goto(portal.url,{waitUntil:'domcontentloaded',timeout:45000});
 const job={mode:'issue',status:'awaiting_user',cnpj,portal,context};let result;
 for(let i=0;i<12;i++){result=await advance(job);if(pdf||result?.status==='captcha_required')break;await page.waitForTimeout(1000);}
 console.log(JSON.stringify({portal:key,result,pdfDownloadObserved:pdf,host:new URL(page.url()).hostname,text:(await page.locator('body').innerText()).slice(-5000)}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message.split('\n')[0]);process.exitCode=1;});
