const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'..','tmp');fs.mkdirSync(base,{recursive:true});
const root=fs.mkdtempSync(path.join(base,'municipal-storage-'));process.env.CENTRAL_CERTIDOES_STORAGE=root;
const {app,parseCert,writeArchive,readArchive}=require('../server');
test.after(()=>{assert.ok(path.resolve(root).startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
test('municipal certificate fields and consultation key remain separate',()=>{
  const parsed=parseCert('Prefeitura Municipal Certidão Negativa Nº 12345678 Validade: 31/12/2026 Chave de consulta: ABCD-1234-EFGH');
  assert.equal(parsed.status,'negativa');assert.equal(parsed.validade,'2026-12-31');assert.equal(parsed.numero,'12345678');assert.equal(parsed.chaveConsulta,'ABCD-1234-EFGH');
});
test('archive atomically preserves old PDFs, provenance and metadata; failed copy never destroys previous version',async()=>{
  const cnpj='00000000000191',source=path.join(root,'synthetic.pdf');fs.writeFileSync(source,'%PDF-1.7 SYNTHETIC TEST ONLY');
  const parsed={status:'negativa',validade:'2026-12-31',numero:'12345678',chaveConsulta:'ABCD-1234'};
  const a=writeArchive(cnpj,'municipal',source,parsed,'municipal-captured',{sha256:'1'.repeat(64),officialPortal:true,sourceUrl:'https://municipal.example/pdf'});
  const b=writeArchive(cnpj,'municipal',source,parsed,'municipal-captured',{sha256:'2'.repeat(64),officialPortal:false,sourceUrl:''});
  assert.notEqual(a.filePath,b.filePath);assert.ok(fs.existsSync(a.filePath));assert.ok(fs.existsSync(b.filePath));
  const archive=readArchive(cnpj);assert.equal(archive.history.length,1);assert.equal(archive.certificates.municipal.chaveConsulta,'ABCD-1234');
  fs.writeFileSync(source,'not a pdf');assert.throws(()=>writeArchive(cnpj,'municipal',source,parsed,'municipal-captured',{sha256:'2'.repeat(64)}),/PDF/);
  assert.equal(readArchive(cnpj).certificates.municipal.filePath,b.filePath);assert.equal(fs.readFileSync(b.filePath).subarray(0,5).toString(),'%PDF-');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{
    const url='http://127.0.0.1:'+server.address().port;
    const health=await (await fetch(url+'/api/health')).json();assert.equal(health.version,require('../package.json').version);
    const pdf=await fetch(url+'/api/archive/'+cnpj+'/municipal/pdf');assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
    const record=await (await fetch(url+'/api/archive/'+cnpj)).json();assert.equal(record.certificates.municipal.officialPortal,false);
    const page=await (await fetch(url+'/central-certidoes.html')).text();assert.ok(page.includes('window.municipalInteraction(recent)'));assert.equal(page.includes('showMunicipalUpload'),false);
  }finally{await new Promise(r=>server.close(r));}
});
test('real web interface completes municipal Continue without an attachment dialog and renders provenance in report',async()=>{
  const {launchBrowser}=require('../automation/launch');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const baseUrl='http://127.0.0.1:'+server.address().port;const browser=await launchBrowser(true);
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let resumed=0;const session={id:'test-municipal',status:'running',portals:[{key:'municipal',name:'Municipal teste'}],events:[{time:new Date().toISOString(),type:'portal_start',portal:'municipal'},{time:new Date().toISOString(),type:'municipal_state',portal:'municipal',state:'document_ready',message:'PDF municipal salvo. Clique em Continuar para concluir.'}]};
    await page.route('**/*',async route=>{
      const u=new URL(route.request().url());if(u.origin!==baseUrl)return route.abort();
      if(u.pathname==='/api/session')return route.fulfill({json:{sessionId:session.id,portals:session.portals}});
      if(u.pathname==='/api/session/'+session.id+'/resume'){
        resumed++;session.status='done';session.events.push({time:new Date().toISOString(),type:'portal_done',portal:'municipal'},{time:new Date().toISOString(),type:'complete'});
        return route.fulfill({json:{ok:true,completed:true}});
      }
      if(u.pathname==='/api/session/'+session.id)return route.fulfill({json:session});
      if(u.pathname.startsWith('/api/cnpj/'))return route.fulfill({json:{razao_social:'EMPRESA FICTÍCIA DE TESTE',municipio:'Fortaleza',uf:'CE'}});
      return route.continue();
    });
    await page.goto(baseUrl+'/central-certidoes.html');
    await page.evaluate(()=>{document.getElementById('cnpj').value='00.000.000/0001-91';document.getElementById('razaoSocial').value='EMPRESA FICTÍCIA';});
    await page.evaluate(()=>window.startSingleCertificate('municipal'));
    await page.waitForFunction(()=>document.getElementById('dashResume')?.disabled===false);
    await page.locator('#dashResume').click();await page.waitForFunction(()=>document.getElementById('btnConsultarTodas').disabled===false);
    assert.equal(resumed,1);assert.equal(await page.locator('dialog[open]').count(),0);
    await page.locator('.side-link').filter({hasText:'Relatórios'}).click();
    await page.waitForFunction(()=>document.getElementById('printReport')?.textContent.includes('Chave de verificação'));
    const report=await page.locator('#printReport').innerText();assert.match(report,/ABCD-1234/);assert.match(report,/Origem não registrada/);assert.match(report,/Data de emissão/);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await new Promise(r=>server.close(r));}
});
