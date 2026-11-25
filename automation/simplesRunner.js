const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {parseSimples}=require('../lib/simples');
const {checkCancelled}=require('./cancellation');
async function runSimples({portal,cnpj,browser,baseDir,emit}){
 const page=await browser.newPortalPage();
 emit({type:'portal_opening',portal:'simples',name:portal.name,url:portal.url});
 await page.goto(portal.url,{waitUntil:'domcontentloaded',timeout:60000});
 await page.locator('#Cnpj').fill(cnpj);await page.getByRole('button',{name:'Consultar',exact:true}).click();
 let parsed;
 for(let attempt=0;attempt<4;attempt++){
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){checkCancelled();const text=await page.locator('body').innerText();parsed=parseSimples(text,cnpj);if(parsed.valid)break;await browser.abortable(new Promise(r=>setTimeout(r,500)));}
  if(parsed?.valid)break;
  await browser.waitForHumanResume('Simples Nacional: conclua a consulta ou a verificação humana na página aberta. Quando aparecerem as situações do Simples Nacional e SIMEI, clique em Continuar.');
 }
 checkCancelled();if(!parsed?.valid)throw Error('O portal não apresentou um comprovante completo para o CNPJ consultado.');
 if(!require('./capture-provenance').officialUrl(page.url(),portal))throw Error('O resultado não está no portal oficial do Simples Nacional.');
 const cdp=await page.context().newCDPSession(page);let bytes;
 try{await page.emulateMedia({media:'print'});const result=await cdp.send('Page.printToPDF',{printBackground:true,preferCSSPageSize:true,generateTaggedPDF:false,generateDocumentOutline:false,paperWidth:8.27,paperHeight:11.69});bytes=Buffer.from(result.data,'base64');}finally{await cdp.detach();}
 const extracted=await require('../lib/certificates').extractPdf(bytes);if(!parseSimples(extracted.text,cnpj).valid)throw Error('O PDF não contém o resultado completo do Simples Nacional e SIMEI para este CNPJ.');
 checkCancelled();const dir=path.join(baseDir,'data','certidoes',cnpj);fs.mkdirSync(dir,{recursive:true});const filePath=path.join(dir,'SIMPLES-'+crypto.randomUUID()+'.pdf');fs.writeFileSync(filePath,bytes);
 return {filePath,captureStage:'simples-result',provenance:{source:'controlled_browser',officialPortal:true,sourceUrl:page.url(),captureMethod:'official_print_view',capturedAt:new Date().toISOString()}};
}
module.exports={runSimples};
