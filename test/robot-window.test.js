const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store'),{createApp}=require('../lib/app'),{credentials}=require('../lib/auth'),{launchBrowser}=require('../automation/launch');
test('interactive panel sends clicks/text to the real robot session and captures its PDF',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'central-window-')),store=new Store(dir);
 store.put('user','Operador Teste',{...credentials('Operador Teste','Senha de teste 1234'),role:'operator',active:true});
 const company={cnpj:'00000000000191',name:'EMPRESA FICTÍCIA',uf:'DF',municipalityCode:'5300108'};store.put('company',company.cnpj,company);
 const application=createApp({store,port:3200}),server=application.app.listen(3200,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 let robot,ui;
 try{
   robot=await launchBrowser(true);const generator=await robot.newPage();await generator.setContent('<h1>Certidão Negativa - TESTE FICTÍCIO</h1><p>Receita Federal CNPJ 00.000.000/0001-91</p><p>Validade: 31/12/2026</p>');const pdf=await generator.pdf();await generator.close();
   const context=await robot.newContext();await context.route('https://servicos.receitafederal.gov.br/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<input name="niContribuinte"><button>Emitir Certidão</button><input id="captcha"><button id="download" onclick="window.downloadAttempt=true;const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob([Uint8Array.from(atob('${pdf.toString('base64')}'),c=>c.charCodeAt(0))],{type:'application/pdf'}));a.download='teste.pdf';a.click();">Receber PDF de teste</button>`}));
   application.jobs.openBrowser=async options=>{assert.equal(options.headless,true);return {browser:robot,context,busterAvailable:false,browserNote:'Fixture de teste.'};};
   const portal=application.detail(company.cnpj).rows[0].portal;
   const job=await application.jobs.start(company,portal,'Operador Teste');
   ui=await launchBrowser(true);const page=await ui.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:3200');await page.locator('#username').fill('Operador Teste');await page.locator('#password').fill('Senha de teste 1234');await page.locator('#auth-submit').click();await page.locator('[data-company]').click();await page.locator('#robot-window[open]').waitFor({state:'visible'});await page.locator('#robot-screen').waitFor({state:'visible'});
   const remote=application.jobs.jobs.get(job.id).page;
   remote.bringToFront=()=>{throw new Error('Não deve abrir uma janela paralela.');};
   assert.match((await application.jobs.focus(job.id)).message,/dentro da Central/);
   async function clickRemote(selector){const box=await remote.locator(selector).boundingBox();const screen=await page.locator('#robot-screen').boundingBox();const viewport=remote.viewportSize();await page.locator('#robot-screen').click({position:{x:(box.x+box.width/2)/viewport.width*screen.width,y:(box.y+box.height/2)/viewport.height*screen.height}});await page.getByText('Comando enviado. A página será atualizada.',{exact:true}).waitFor();}
   await clickRemote('#captcha');await page.locator('#robot-text').fill('RESPOSTA');await page.locator('#robot-text-form button').click();await page.waitForFunction(()=>document.querySelector('#robot-text').value==='');assert.equal(await remote.locator('#captcha').inputValue(),'RESPOSTA');
   assert.equal(await page.locator('#finish-job').isDisabled(),true);
   await clickRemote('#download');await remote.waitForFunction(()=>window.downloadAttempt,{},{timeout:5000});await page.getByRole('link',{name:'Abrir PDF recebido',exact:true}).waitFor({timeout:20000});
   const saved=store.all('certificate');assert.equal(saved.length,1);assert.ok(store.intact(saved[0].file));assert.equal(store.get('job',job.id).status,'finished');assert.deepEqual(errors,[]);
 }finally{for(const j of application.jobs.jobs.values())await application.jobs.close(j);await ui?.close();await robot?.close();await new Promise(r=>server.close(r));store.close();if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(dir,{recursive:true,force:true});}
});
