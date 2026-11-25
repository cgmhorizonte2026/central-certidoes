const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {parseSimples}=require('../lib/simples');
const result='Consulta Optantes CNPJ 00.000.000/0001-91 Situação no Simples Nacional: NÃO optante pelo Simples Nacional Situação no SIMEI: NÃO enquadrado no SIMEI';
const blocked='Impedido por proteção Captcha. Comportamento de Robô.';
test('Simples access block is never a tax result, even with old result text behind it',()=>{
 for(const text of [blocked,blocked.toUpperCase(),result+' '+blocked]){const p=parseSimples(text,'00000000000191');assert.equal(p.valid,false);assert.equal(p.accessBlocked,true);assert.equal(p.status,'');assert.equal(p.simei,'');}
 assert.equal(parseSimples(result+' Protegido por CAPTCHA','00000000000191').valid,true);
});
async function blockedFixture(t,html){
 const browser=await require('../automation/launch').launchBrowser(true),root=fs.mkdtempSync(path.join(os.tmpdir(),'simples-block-'));
 t.after(async()=>{await browser.close();fs.rmSync(root,{recursive:true,force:true});});
 const context=await browser.newContext(),portal={key:'simples',name:'Simples',url:'https://consopt.www8.receita.fazenda.gov.br/consultaoptantes'};
 await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
 return {context,portal,root};
}
test('Simples pauses immediately after denial, does not retry on Continue, then captures a manual result',async t=>{
 const f=await blockedFixture(t,'<input id="Cnpj"><button onclick="window.clicks=(window.clicks||0)+1;document.body.innerText='+JSON.stringify(blocked).replaceAll('"','&quot;')+'">Consultar</button>');
 let page,waits=0;const events=[];
 const manager={newPortalPage:async()=>page=await f.context.newPage(),abortable:p=>p,waitForHumanResume:async message=>{
  waits++;assert.match(message,/comportamento de robô/);assert.equal(fs.existsSync(path.join(f.root,'data','certidoes')),false);
  assert.equal(await page.evaluate(()=>window.clicks),1);
  if(waits===2)await page.evaluate(text=>document.body.innerText=text,result);else assert.equal(waits,1);
 }};
 const saved=await require('../automation/simplesRunner').runSimples({portal:f.portal,cnpj:'00000000000191',browser:manager,baseDir:f.root,emit:e=>events.push(e)});
 assert.equal(waits,2);assert.equal(events.filter(e=>e.type==='portal_access_blocked').length,2);assert.equal(saved.provenance.officialPortal,true);assert.ok(fs.existsSync(saved.filePath));
});
test('Simples visible CAPTCHA is left for the user before the initial consultation',async t=>{
 const f=await blockedFixture(t,'<input id="Cnpj"><button onclick="window.clicks=(window.clicks||0)+1;document.body.innerText='+JSON.stringify(result).replaceAll('"','&quot;')+'">Consultar</button>');
 let page,waits=0;const manager={newPortalPage:async()=>page=await f.context.newPage(),abortable:p=>p,captchaState:async()=>({blocking:true}),waitForHumanResume:async()=>{
  waits++;assert.equal(await page.evaluate(()=>window.clicks||0),0);await page.locator('#Cnpj').fill('00000000000191');await page.getByRole('button',{name:'Consultar'}).click();
 }};
 await require('../automation/simplesRunner').runSimples({portal:f.portal,cnpj:'00000000000191',browser:manager,baseDir:f.root,emit:()=>{}});assert.equal(waits,1);
});
test('Stop cancels a blocked Simples consultation without creating any PDF',async t=>{
 const f=await blockedFixture(t,blocked);
 const {BrowserManager}=require('../automation/browser');let ready;const waiting=new Promise(r=>ready=r);
 const manager=new BrowserManager(e=>{if(e.type==='human_action_required')ready();});
 manager.newPortalPage=async()=>{const page=await f.context.newPage();manager.own(page);return page;};
 const running=require('../automation/cancellation').withCancellation(manager.signal,()=>require('../automation/simplesRunner').runSimples({portal:f.portal,cnpj:'00000000000191',browser:manager,baseDir:f.root,emit:()=>{}}));
 const rejection=assert.rejects(running,e=>e.code==='SESSION_CANCELLED');await waiting;await manager.close();await rejection;
 assert.equal(fs.existsSync(path.join(f.root,'data','certidoes')),false);
});
test('Simples distinguishes current negative options, never invents expiry, and requires identity and both results',()=>{const p=parseSimples(result,'00000000000191');assert.equal(p.valid,true);assert.equal(p.status,'nao_optante');assert.equal(p.simei,'nao_enquadrado');assert.equal(p.validade,'');assert.equal(parseSimples(result,'11222333000181').valid,false);assert.equal(parseSimples('Consulta Optantes CNPJ 00.000.000/0001-91','00000000000191').valid,false);assert.equal(parseSimples(result.replaceAll('NÃO ',''),'00000000000191').status,'optante');});
test('Simples captures only its complete official result as a PDF',async()=>{const browser=await require('../automation/launch').launchBrowser(true),root=fs.mkdtempSync(path.join(os.tmpdir(),'simples-test-'));try{const context=await browser.newContext();const portal={key:'simples',name:'Simples',url:'https://consopt.www8.receita.fazenda.gov.br/consultaoptantes'};await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<input id="Cnpj"><button onclick="document.body.innerText='+JSON.stringify(result).replaceAll('"','&quot;')+'">Consultar</button>'}));const manager={newPortalPage:()=>context.newPage(),abortable:p=>p,waitForHumanResume:()=>{throw Error('unexpected manual wait')}};const r=await require('../automation/simplesRunner').runSimples({portal,cnpj:'00000000000191',browser:manager,baseDir:root,emit:()=>{}});assert.equal(r.provenance.officialPortal,true);assert.equal(r.captureStage,'simples-result');assert.ok(fs.existsSync(r.filePath));assert.equal(parseSimples((await require('../lib/certificates').extractPdf(fs.readFileSync(r.filePath))).text,'00000000000191').valid,true);}finally{await browser.close();fs.rmSync(root,{recursive:true,force:true});}});
