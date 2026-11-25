const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {remainingDays}=require('../lib/consultation-policy');
const {portalsForCompany,resolvePortalsForCompany}=require('../config/portalResolver');
test('validity uses local calendar days with a strict five-day boundary',()=>{
  const now=new Date('2026-11-26T01:30:00Z'); // Still November 25 in Ceará.
  assert.equal(remainingDays('2026-12-01',now),6);
  assert.equal(remainingDays('30/11/2026',now),5);
  assert.equal(remainingDays('2026-11-25',now),0);
  assert.equal(remainingDays('2026-11-24',now),-1);
  assert.equal(remainingDays('2026-02-30',now),null);
  assert.equal(remainingDays('',now),null);
});
test('known and discovered municipalities precede Simples, which is always last',async()=>{
  const company={uf:'CE',municipio:'Fortaleza',municipio_codigo_ibge:'2304400'};
  for(const list of [portalsForCompany(company),(await resolvePortalsForCompany(company,{municipalResolver:{resolve:async()=>({status:'PORTAL_NAO_VALIDADO'})}})).portals]){
    assert.equal(list.at(-1).key,'simples');assert.equal(list.at(-2).key,'municipal');
    assert.deepEqual(list.map(p=>p.key),['federal','fgts','trabalhista','estadual-ce','municipal','simples']);
  }
});
test('HTTP reuse, individual confirmation and new query respect validity, identity and integrity',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'consultation-policy-'));process.env.CENTRAL_CERTIDOES_STORAGE=root;
  const {app,sessionServices,sessionControl}=require('../server');
  const original={...sessionServices},browser=await require('../automation/launch').launchBrowser(true);
  let runs=0,lookups=0;
  sessionServices.lookupCompany=async()=>{lookups++;return {uf:'CE',municipio:'Fortaleza',municipio_codigo_ibge:'2304400'};};
  let key='federal';
  sessionServices.resolvePortals=async()=>({portals:[{key,name:'Certidão teste',url:'https://example.invalid'}],municipalResolution:{}});
  sessionServices.createBrowser=()=>({close:async()=>{},abortable:p=>p});
  sessionServices.runPortal=async()=>{runs++;throw Error('TEST_NEW_QUERY');};
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port,cnpj='00000000000191';
  const post=body=>fetch(url+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cnpj,...body})});
  const finish=async id=>{const until=Date.now()+10000;while(sessionControl.sessions.get(id)?.status==='running'){if(Date.now()>until)throw Error('Session timeout');await new Promise(r=>setTimeout(r,25));}return sessionControl.sessions.get(id);};
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Fortaleza',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const date=n=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  let cert;
  const archive=()=>fs.writeFileSync(path.join(root,'archive',cnpj+'.json'),JSON.stringify({certificates:{[key]:cert}}));
  try{
    const page=await browser.newPage();await page.setContent('<h1>Receita Federal Certidão Negativa</h1><p>CNPJ 00.000.000/0001-91</p>');
    const pdf=await page.pdf(),filePath=path.join(root,'federal.pdf');fs.writeFileSync(filePath,pdf);
    cert={filePath,validade:date(6),sha256:require('../automation/capture-provenance').hash(pdf)};archive();
    const all=await post({});assert.equal(all.status,200);const s=await finish((await all.json()).sessionId);assert.equal(runs,0);assert.ok(s.events.some(e=>e.type==='portal_reused'));
    const before=lookups,request=await post({certificateKey:key});assert.equal(request.status,409);const warning=await request.json();assert.equal(warning.code,'VALID_CERTIFICATE_CONFIRMATION');assert.equal(warning.remainingDays,6);assert.equal(lookups,before);assert.equal(sessionControl.activeId,null);
    const individual=await post({certificateKey:key,confirmValidCertificate:true});assert.equal(individual.status,200);await finish((await individual.json()).sessionId);assert.equal(runs,1);
    cert.validade=date(5);archive();const due=await post({});await finish((await due.json()).sessionId);assert.equal(runs,2);
    cert.validade=date(6);cert.sha256='altered';archive();const changed=await post({certificateKey:key});assert.equal(changed.status,200);await finish((await changed.json()).sessionId);assert.equal(runs,3);
    key='municipal';await page.setContent('<h1>Prefeitura Municipal Certidão Negativa de Débitos Municipais</h1><p>CNPJ 00.000.000/0001-91</p>');const municipal=await page.pdf();fs.writeFileSync(filePath,municipal);cert={filePath,validade:date(6)};archive();
    const municipalRequest=await post({});const ms=await finish((await municipalRequest.json()).sessionId);assert.equal(runs,3);assert.ok(ms.events.some(e=>e.type==='portal_reused'));
    key='federal';fs.writeFileSync(filePath,pdf);cert={filePath,validade:date(6)};archive();
    const ui=await browser.newPage();await ui.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());await ui.goto(url+'/central-certidoes.html',{waitUntil:'domcontentloaded'});
    await ui.evaluate(()=>{document.getElementById('cnpj').value='00.000.000/0001-91';});
    ui.once('dialog',async dialog=>{assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),/6 dias/);await dialog.dismiss();});
    await ui.evaluate(()=>window.startSingleCertificate('federal'));assert.equal(runs,3);assert.equal(await ui.locator('#btnConsultarTodas').isEnabled(),true);
    ui.once('dialog',dialog=>dialog.accept());await ui.evaluate(()=>window.startSingleCertificate('federal'));
    const deadline=Date.now()+5000;while(runs<4&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));assert.equal(runs,4);await ui.close();
  }finally{
    for(const id of sessionControl.sessions.keys()){await sessionControl.stop(id);const log=path.join(__dirname,'..','data','logs',id+'.jsonl');if(fs.existsSync(log))fs.unlinkSync(log);}
    Object.assign(sessionServices,original);await new Promise(r=>server.close(r));await browser.close();fs.rmSync(root,{recursive:true,force:true});
  }
});
