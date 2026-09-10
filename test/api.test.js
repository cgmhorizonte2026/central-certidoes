const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {Store}=require('../lib/store');const {createApp}=require('../lib/app');const {launchBrowser}=require('../automation/launch');
test('authenticated lifecycle: upload, provenance comparison, report, restart-safe records and integrity failures',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'central-api-'));const store=new Store(dir);
 const company={cnpj:'00000000000191',name:'EMPRESA DE TESTE - DOCUMENTO FICTÍCIO',uf:'DF',municipality:'Brasília',municipalityCode:'5300108',address:'Ambiente de teste',source:'Fixture de teste, não consultada no governo',sourceUrl:'https://example.invalid/test',fetchedAt:new Date().toISOString()};
 const application=createApp({store,testing:true,lookupCompany:async()=>{store.put('company',company.cnpj,company);return company;}});
 const server=application.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 let cookie='',csrf='';
 const request=async(url,body,headers={})=>{const r=await fetch(base+url,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(csrf?{'X-CSRF-Token':csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});return r;};
 try{
  assert.equal((await request('/api/companies')).status,401);
  store.put('user','Teste Auditor',{...require('../lib/auth').credentials('Teste Auditor','Senha de testes 1234'),role:'admin',active:true});let r=await request('/api/login',{username:'Teste Auditor',password:'Senha de testes 1234'});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).csrf;
  assert.equal((await request('/api/setup',{username:'Segundo',password:'Senha de testes 999'})).status,403);
  assert.equal((await request('/api/companies/lookup',{cnpj:company.cnpj},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await request('/api/companies/lookup',{cnpj:company.cnpj},{Origin:'https://malicious.example'})).status,403);
  r=await request('/api/companies/lookup',{cnpj:company.cnpj});assert.equal(r.status,200);assert.equal((await r.json()).rows.find(r=>r.portal.key==='municipal').portal.required,false);
  let browser=await launchBrowser(true);let pdf;
  try{const page=await browser.newPage();await page.setContent('<h1>CERTIDÃO NEGATIVA - TESTE FICTÍCIO</h1><p>Receita Federal - EXEMPLO SINTÉTICO</p><p>CNPJ: 00.000.000/0001-91</p><p>Emitida em: 09/09/2026</p><p>Validade: 31/12/2026</p><p>Sem valor para pagamento.</p>');pdf=await page.pdf({format:'A4'});}finally{await browser.close();}
  r=await request('/api/companies/'+company.cnpj+'/certificates/federal',pdf,{'Content-Type':'application/pdf'});const uploaded=await r.json();assert.equal(r.status,201,JSON.stringify(uploaded));assert.equal(uploaded.parsed.cnpjMatches,true);assert.equal(uploaded.validation.status,'pending');assert.equal(uploaded.assessment.ready,false);
  assert.equal((await request('/api/certificates/'+uploaded.id+'/pdf')).status,200);
  const portal=application.detail(company.cnpj).rows[0].portal;
  // Injected test capture validates the comparison logic only, never a live government response.
  await application.certificates.ingest({buffer:pdf,cnpj:company.cnpj,portal,actor:'Teste Auditor',provenance:{method:'official_response',url:'https://servicos.receitafederal.gov.br/test-fixture.pdf',capturedAt:new Date().toISOString(),jobId:'test-fixture'},mode:'verify',certificateId:uploaded.id});
  assert.equal(store.get('certificate',uploaded.id).validation.status,'confirmed_exact_official_pdf');
  assert.equal(application.certificates.latest(company.cnpj,'federal').id,uploaded.id);
  r=await request('/api/companies/'+company.cnpj+'/reports',{});const report=await r.json();assert.equal(r.status,201,JSON.stringify(report));
  const reportBytes=Buffer.from(await (await request(`/api/reports/${report.id}/pdf`)).arrayBuffer());assert.equal(reportBytes.subarray(0,5).toString(),'%PDF-');
  fs.mkdirSync(path.join(__dirname,'..','tmp','pdfs'),{recursive:true});fs.writeFileSync(path.join(__dirname,'..','tmp','pdfs','relatorio-teste.pdf'),reportBytes);
  assert.equal((await (await request(`/api/reports/${report.id}/check`)).json()).pdfIntact,true);
  fs.writeFileSync(store.resolve(uploaded.file.path),'tampered');assert.equal((await request('/api/certificates/'+uploaded.id+'/pdf')).status,409);
  assert.equal((await request('/api/companies/'+company.cnpj+'/certificates/federal',Buffer.from('not pdf'),{'Content-Type':'application/pdf'})).status,400);
  assert.equal((await request('/api/parse-pdf',{filePath:'C:/Windows/win.ini'})).status,404);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
