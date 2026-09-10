const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {launchBrowser}=require('../automation/launch'),{advance}=require('../automation/issuer-engine'),{advanceVerification}=require('../automation/verification');
const {Store}=require('../lib/store'),{Certificates}=require('../lib/certificates'),{today}=require('../lib/domain');
const {PortalSessions}=require('../automation/sessions');
test('FGTS captures only the final print view even when its print button is hidden',async()=>{
 const browser=await launchBrowser(true);try{const context=await browser.newContext();
 const text='<h1>Certificado de Regularidade do FGTS</h1><p>CNPJ 00.000.000/0001-91 encontra-se em situação regular</p><p>Validade: 31/12/2026</p>';
 await context.route('https://consulta-crf.caixa.gov.br/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:text+'<input type="button" value="Visualizar">'}));const page=await context.newPage();await page.goto('https://consulta-crf.caixa.gov.br/test');
 let provenance;const manager=new PortalSessions({store:{put:()=>{},audit:()=>{}},onPdf:async p=>{provenance=p.provenance;return{id:'final'};}});const job={id:'fgts-test',cnpj:'00000000000191',mode:'issue',status:'awaiting_response',portal:{key:'fgts',allowedHosts:['consulta-crf.caixa.gov.br']},context,page,files:[],seen:new Set()};
 await manager.guide(job);assert.equal(job.files.length,0);
 await page.setContent(text+'<input type="submit" value="Imprimir" style="display:none">');await manager.guide(job);assert.deepEqual(job.files,['final']);assert.equal(provenance.method,'official_print_view');
 }finally{await browser.close();}
});
test('Fortaleza chooses reprint at five days and new emission at four days; unknown date stays pending',async()=>{
 const browser=await launchBrowser(true);try{
 for(const days of [5,4,null]){
  const context=await browser.newContext();const date=new Date(today()+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+(days||0));const label=days===null?'não informada':date.toISOString().slice(0,10).split('-').reverse().join('/');
  await context.route('https://grpfordam.sefin.fortaleza.ce.gov.br/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<form id="modalReimpressaoForm">Existe uma certidão válida até ${label}.<input type="button" value="Reimprimir Certidão" onclick="window.choice='reprint'"><input type="button" value="Solicitar Nova Emissão" onclick="window.choice='new'"></form><input type="button" value="Emitir" onclick="window.wrong=true">`}));
  const page=await context.newPage();await page.goto('https://grpfordam.sefin.fortaleza.ce.gov.br/form');const job={mode:'issue',status:'awaiting_user',cnpj:'00000000000191',context,portal:{key:'municipal',allowedHosts:['grpfordam.sefin.fortaleza.ce.gov.br']}};
  const result=await advance(job);await advance(job);assert.equal(await page.evaluate(()=>window.choice),days===null?undefined:days>=5?'reprint':'new');assert.equal(await page.evaluate(()=>window.wrong),undefined);if(days===null)assert.equal(result.status,'awaiting_user');await context.close();
 }
 }finally{await browser.close();}
});
test('TST validation fills identity and number/year, confirms only after its response and never issues',async()=>{
 const browser=await launchBrowser(true);try{const context=await browser.newContext();await context.route('https://cndt-certidao.tst.jus.br/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<input id="cpfCnpj"><input id="numCertidao"><input id="anoCertidao"><button onclick="window.calls=(window.calls||0)+1;document.querySelector('p').textContent='Operação efetuada com sucesso.'">Validar Certidão</button><button onclick="window.issue=true">Emitir Certidão</button><p></p>`}));const page=await context.newPage();await page.goto('https://cndt-certidao.tst.jus.br/consultarCertidao');const job={mode:'verify',context,cnpj:'00000000000191',portal:{key:'trabalhista',allowedHosts:['cndt-certidao.tst.jus.br']},verificationTarget:{number:'12345678/2026',sha256:'test'}};
 assert.notEqual((await advanceVerification(job)).confirmed,true);const result=await advanceVerification(job);assert.equal(result.confirmed,true);assert.equal(result.query.cnpj,job.cnpj);assert.equal(await page.locator('#numCertidao').inputValue(),'12345678');assert.equal(await page.locator('#anoCertidao').inputValue(),'2026');assert.equal(await page.evaluate(()=>window.calls),1);assert.equal(await page.evaluate(()=>window.issue),undefined);
 }finally{await browser.close();}
});
test('official record confirmation checks PDF identity/evidence and never authenticates uploaded contents',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'central-validation-')),store=new Store(root),service=new Certificates(store);try{
 const file=store.saveFile('files',Buffer.from('%PDF-test'),'pdf'),portal={key:'trabalhista',allowedHosts:['cndt-certidao.tst.jus.br']};const cert={id:'one',cnpj:'00000000000191',portalKey:'trabalhista',kind:'trabalhista',file,parsed:{number:'12345678/2026',classification:'negativa',cnpjMatches:true,kindMatches:true,expiresAt:'2027-03-08'},provenance:{method:'official_download',url:'https://cndt-certidao.tst.jus.br/doc.pdf'},validation:{status:'pending'}};store.put('certificate',cert.id,cert);
 const evidence={url:'https://cndt-certidao.tst.jus.br/consultarCertidao',capturedAt:new Date().toISOString(),screenshot:store.saveFile('evidence',Buffer.from('image'),'png'),pageText:store.saveFile('evidence',Buffer.from('Operação efetuada com sucesso.'),'txt')};const query={cnpj:cert.cnpj,number:cert.parsed.number,sha256:file.sha256};
 assert.throws(()=>service.confirmOfficialRecord({certificateId:cert.id,portal,query:{...query,number:'999/2026'},evidence}),/vincular/);
 assert.equal(service.confirmOfficialRecord({certificateId:cert.id,portal,query,evidence}).validation.status,'confirmed_official_record');
 const reference={...cert,id:'reference',validation:{status:'pending'}};store.put('certificate',reference.id,reference);
 cert.validation={officialCertificateId:reference.id,evidenceFile:file};store.put('certificate',cert.id,cert);
 service.confirmOfficialRecord({certificateId:cert.id,portal,query,evidence});assert.equal(service.latest(cert.cnpj,portal.key).id,cert.id);
 cert.provenance={method:'upload'};store.put('certificate',cert.id,cert);assert.equal(service.confirmOfficialRecord({certificateId:cert.id,portal,query,evidence}).validation.status,'record_found_content_unverified');
 fs.writeFileSync(store.resolve(evidence.pageText.path),'changed');assert.equal(service.present(store.get('certificate',cert.id)).validation.status,'evidence_integrity_failed');
 }finally{store.close();if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(root,{recursive:true,force:true});}
});
