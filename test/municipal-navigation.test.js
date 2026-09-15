const test=require('node:test'),assert=require('node:assert/strict');
const {launchBrowser}=require('../automation/launch');
const {advance}=require('../automation/issuer-engine');
const {routesFor,trustedUrl}=require('../config/registry');
const {municipalLinkScore}=require('../automation/municipal-navigation');
const {PortalSessions}=require('../automation/sessions');

test('Horizonte routes by IBGE to the officially linked supplier despite stale discovery',()=>{
 const routes=routesFor({uf:'CE',municipality:'Horizonte',municipalityCode:'2305233'},{get:kind=>kind==='portal'?{registeredBy:'descoberta_por_ibge',url:'https://www.horizonte.ce.gov.br/'}:null});
 const p=routes.find(p=>p.key==='municipal');
 assert.equal(p.url,'https://tributario.speedgov.com.br/horizonte/servicos/certidoes');
 assert.equal(p.coverage,'portal_identificado');
 assert.ok(trustedUrl(p.url,p));assert.ok(trustedUrl(p.verifyUrl,p));
 assert.ok(!trustedUrl('https://tributario.speedgov.com.br.attacker.test/horizonte',p));
 assert.ok(!trustedUrl('https://unreviewed.example/cnd',p));
 assert.match(routes.find(p=>p.key==='estadual').name,/Ceará/);
});
test('Eusebio reviewed portal replaces cached discovery and only permits reviewed hosts',()=>{
 const p=routesFor({uf:'CE',municipality:'Eusébio',municipalityCode:'2304285'},{get:kind=>kind==='portal'?{registeredBy:'descoberta_por_ibge',url:'https://www.eusebio.ce.gov.br/'}:null}).find(p=>p.key==='municipal');
 assert.equal(new URL(p.url).hostname,'gpi.eusebio.ce.gov.br');
 assert.ok(trustedUrl(p.url,p));
 assert.ok(!trustedUrl('https://gpi.eusebio.ce.gov.br.attacker.test/print',p));
 assert.ok(!trustedUrl('https://unreviewed.example/print',p));
 assert.ok(!trustedUrl(p.url.replace('https:','http:'),p));
});
test('municipal navigation prioritizes tax certificates, excludes property and authentication',()=>{
 assert.equal(municipalLinkScore('Certidões negativas de tributos'),3);
 assert.equal(municipalLinkScore('Portal do Contribuinte Atendimento Sefin'),2);
 for(const s of ['Emitir certidões','Emissão de certidão','Certidões','Emitir CND','Portal de Serviços Tributários'])assert.equal(municipalLinkScore(s),2);
 for(const s of ['Certidão negativa de imóvel','Certidão de nascimento','Validar certidão negativa','IPTU','Entrar'])assert.equal(municipalLinkScore(s),0);
});
test('municipal flow follows directory, taxpayer portal and certificate menu then submits once',async()=>{
 const browser=await launchBrowser(true);
 try{
  const context=await browser.newContext();
  const p=routesFor({uf:'CE',municipality:'Eusébio',municipalityCode:'2304285'}).find(p=>p.key==='municipal');
  await context.route('https://**/*',r=>{
   const u=new URL(r.request().url());
   const body=u.hostname==='eusebio.ce.gov.br'?'<a href="https://unreviewed.example/">Certidão negativa</a><a href="https://gpi.eusebio.ce.gov.br/portal">Portal do Contribuinte</a>':u.pathname==='/portal'?'<a href="/imovel">Certidão negativa de imóvel</a><button onclick="location.href=\'/form\'">Emitir certidões</button>':'<input name="cnpj"><button onclick="window.sent=(window.sent||0)+1">Imprimir</button>';
   return r.fulfill({contentType:'text/html; charset=utf-8',body});
  });
  const page=await context.newPage();await page.goto('https://eusebio.ce.gov.br/');
  const job={mode:'issue',status:'awaiting_user',context,cnpj:'00000000000191',portal:p};
  await advance(job);assert.equal(page.url(),'https://gpi.eusebio.ce.gov.br/portal');
  await advance(job);assert.equal(page.url(),'https://gpi.eusebio.ce.gov.br/form');
  await advance(job);await advance(job);
  assert.equal(await page.locator('input').inputValue(),job.cnpj);
  assert.equal(await page.evaluate(()=>window.sent),1);
 }finally{await browser.close();}
});
test('municipal embedded PDF is captured from the registered portal without a download event',async()=>{
 const browser=await launchBrowser(true);
 try{
  const context=await browser.newContext(),page=await context.newPage();
  await page.setContent('<h1>CERTIDÃO MUNICIPAL FICTÍCIA PARA TESTE</h1>');const pdf=await page.pdf();
  await context.route('https://gpi.eusebio.ce.gov.br/**',r=>r.fulfill({contentType:'text/html',body:`<object type="application/pdf" data="data:application/pdf;base64,${pdf.toString('base64')}"></object>`}));
  await page.goto('https://gpi.eusebio.ce.gov.br/print');
  let received;
  const manager=new PortalSessions({store:{put:()=>{},audit:()=>{}},onPdf:async p=>{received=p;return {id:'fixture'};}});
  const portal=routesFor({uf:'CE',municipality:'Eusébio',municipalityCode:'2304285'}).find(p=>p.key==='municipal');
  const job={id:'fixture-job',mode:'issue',status:'awaiting_user',context,page,cnpj:'00000000000191',portal,files:[],seen:new Set(),actor:'teste'};
  await manager.guide(job);
  assert.deepEqual(received.buffer,pdf);assert.equal(received.provenance.method,'official_browser_download');assert.deepEqual(job.files,['fixture']);
 }finally{await browser.close();}
});
