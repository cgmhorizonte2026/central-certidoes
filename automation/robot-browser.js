const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const runtime=path.join(__dirname,'..','.runtime');
// Keep the robot and its extensions separate from the operator's personal browser.
if(!process.env.PLAYWRIGHT_BROWSERS_PATH)process.env.PLAYWRIGHT_BROWSERS_PATH=path.join(runtime,'browsers');
const {chromium}=require('playwright');
const {launchBrowser}=require('./launch');
async function openRobotBrowser({root,actor,cnpj,portalKey,headless=true,log=()=>{}}){
 const extension=path.resolve(process.env.BUSTER_EXTENSION_PATH||path.join(runtime,'buster-3.4.0'));
 const enabled=portalKey!=='federal'&&process.env.CAPTCHA_METHOD!=='manual';
 if(!enabled||!fs.existsSync(path.join(extension,'manifest.json'))||!fs.existsSync(chromium.executablePath())){
   const browser=await launchBrowser(headless);const context=await browser.newContext({acceptDownloads:true});
   return {browser,context,busterAvailable:false,browserMethod:'assistido',browserNote:enabled?'Buster/Chromium ausente. Execute Instalar-Robo.ps1.':'Resolução automática de CAPTCHA desativada.'};
 }
 const userKey=crypto.createHash('sha256').update(actor).digest('hex').slice(0,24);
 const profile=path.join(root,'robot-profiles',userKey);
 const downloadPath=path.join(root,'downloads',cnpj,portalKey.replace(/[^a-z0-9_-]/gi,'_'));
 fs.mkdirSync(downloadPath,{recursive:true});fs.mkdirSync(path.join(profile,'Default'),{recursive:true});
 const preferences=path.join(profile,'Default','Preferences');let prefs={};
 if(fs.existsSync(preferences))prefs=JSON.parse(fs.readFileSync(preferences,'utf8'));
 prefs.download={...prefs.download,default_directory:downloadPath,prompt_for_download:false,directory_upgrade:true};
 prefs.plugins={...prefs.plugins,always_open_pdf_externally:true};
 fs.writeFileSync(preferences,JSON.stringify(prefs));
 const context=await chromium.launchPersistentContext(profile,{
   channel:'chromium',headless,acceptDownloads:true,downloadsPath:downloadPath,
   args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
 });
 // Loading a directory alone is not evidence that the extension started.
 let worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://'));
 if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:w=>w.url().startsWith('chrome-extension://'),timeout:10000}).catch(()=>null);
 const installed=worker?await worker.evaluate(()=>chrome.runtime.getManifest().version).catch(()=>null):null;
 let localReady=false;
 if(installed){
   const settings=await context.newPage();
   try{
     await settings.goto(`chrome-extension://${new URL(worker.url()).hostname}/src/options/index.html`,{timeout:10000});
     // Configure through the extension's own options, without copying API keys
     // or changing its source. Local Whisper is the default free speech layer.
     await settings.getByLabel('Local services',{exact:true}).check({timeout:5000});
     await settings.getByLabel('Remote services',{exact:true}).uncheck({timeout:5000});
     const download=settings.getByRole('button',{name:'Download model',exact:true});
     if(await download.isVisible()){
       log('buster_modelo','Baixando o modelo local Whisper; aguarde a preparação inicial.');
       await download.click({timeout:5000});
     }
     await settings.getByText('Status: ready to use',{exact:false}).waitFor({timeout:45000});localReady=true;
   }catch(e){log('buster_configuracao_pendente',e.message.split('\n')[0]);}
   finally{await settings.close().catch(()=>{});}
 }
 return {browser:context.browser(),context,busterAvailable:Boolean(installed)&&localReady,browserMethod:'chromium_buster',browserNote:localReady?`Buster ${installed} com Whisper local pronto; sem serviço pago.`:installed?'Buster instalado, mas o reconhecimento local não ficou pronto. Tente novamente para concluir a preparação.':'Buster não iniciou. A sessão continua com intervenção manual.'};
}
module.exports={openRobotBrowser};
