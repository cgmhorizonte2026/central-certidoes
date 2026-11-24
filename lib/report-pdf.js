const fs=require('node:fs'),path=require('node:path');
const {launchBrowser}=require('../automation/launch');
async function renderReportPdf(html){
 const root=path.resolve(__dirname,'../public');
 const css=fs.readFileSync(path.join(root,'certificate-report.css'),'utf8');
 for(const [name,mime] of [['horizonte.jpg','image/jpeg'],['cgm.png','image/png']])html=html.replaceAll('/brand/'+name,'data:'+mime+';base64,'+fs.readFileSync(path.join(root,'brand',name)).toString('base64'));
 const browser=await launchBrowser(true);
 try{
 const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
 await context.route('**/*',route=>route.abort());
 const page=await context.newPage();await page.emulateMedia({media:'print'});
 await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>'+css+'\n@page{size:A4 landscape;margin:8mm}html,body{margin:0;padding:0;background:white}#printReport{box-sizing:border-box;width:281mm;padding:0;border:0;border-radius:0}'+ '</style></head><body><div id="printReport">'+html+'</div></body></html>',{waitUntil:'load'});
 await page.evaluate(()=>document.fonts.ready);
 const height=await page.locator('#printReport').evaluate(el=>el.getBoundingClientRect().height);
 const available=193*96/25.4;
 if(height>available)await page.locator('#printReport').evaluate((el,zoom)=>el.style.zoom=String(zoom),(available-3)/height);
 return await page.pdf({format:'A4',landscape:true,preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
 }finally{await browser.close();}
}
module.exports={renderReportPdf};
