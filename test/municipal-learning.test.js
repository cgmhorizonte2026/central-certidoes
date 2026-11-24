const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {MunicipalLearning,flowKey,sanitizeStep,readFlow,saveFlow}=require('../automation/municipal-learning');
const {launchBrowser}=require('../automation/launch');
const tempRoot=path.resolve(__dirname,'..','tmp');
const waitFor=async predicate=>{const deadline=Date.now()+12000;while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out waiting for fixture state');};
function cleanup(root){const resolved=path.resolve(root);assert.ok(resolved.startsWith(tempRoot+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
async function fixture(options={}){
  fs.mkdirSync(tempRoot,{recursive:true});const root=fs.mkdtempSync(path.join(tempRoot,'municipal-'));
  const browser=await launchBrowser(true);const context=await browser.newContext();
  const pdfPage=await browser.newPage();
  const pdf=async cnpj=>{await pdfPage.setContent(`<h1>Prefeitura - ${options.positiveEffects?"Certidão Positiva de Débitos de Tributos Municipais com Efeito de Negativa":"Certidão Negativa"} - TESTE SEM VALOR</h1><p>CNPJ ${cnpj}</p><p>Certificamos que não constam débitos municipais para este contribuinte.</p><p>Validade: 31/12/2026</p><p>Chave de consulta: ABC123456</p>${options.positiveEffects?"<p>Este documento produz os mesmos efeitos da Certidão Negativa de Débitos de Tributos Municipais.</p>":""}`);return pdfPage.pdf();};
  const first=await pdf('00.000.000/0001-91'),second=await pdf('11.222.333/0001-81');
  const requests=[];let visits=0;const events=[],saved=[];
  await context.route('https://municipal.example/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/pdf'){
      requests.push(url.searchParams.get('cnpj'));
      return route.fulfill({contentType:'application/pdf',headers:options.download?{'content-disposition':'attachment; filename="certidao.pdf"'}:{},body:requests.at(-1).replace(/\D/g,'')==='00000000000191'?first:second});
    }
    visits++;
    const action=options.download?"location.href=target":"fetch(target)";
    return route.fulfill({contentType:'text/html',body:`<input id="cnpj">${options.captcha?'<input id="captcha" placeholder="CAPTCHA">':''}<button id="emit" onclick="const target='/pdf?cnpj='+encodeURIComponent(document.getElementById('cnpj').value);${action}">Emitir</button>`});
  });
  const manager={context,newPortalPage:async()=>{
    const page=await context.newPage();
    if(options.suppressDownload){const on=page.on.bind(page);page.on=(event,listener)=>event==='download'?page:on(event,listener);}
    return page;
  }};
  const defaults={root,browser:manager,portal:{url:'https://municipal.example/start'},company:{municipio_codigo_ibge:'2304400'},cnpj:'00000000000191',emit:e=>events.push(e),replayWaitMs:1000,onCapture:async record=>{
    const dest=path.join(root,'saved-'+record.sha256+'.pdf');fs.writeFileSync(dest,record.buffer);saved.push(dest);return {filePath:dest};
  }};
  const learners=[];
  return {root,context,first,second,events,saved,requests,visits:()=>visits,
    learner:changes=>{const l=new MunicipalLearning({...defaults,...changes});learners.push(l);return l;},
    close:async()=>{for(const l of learners)await l.dispose();await browser.close();cleanup(root);}};
}
test('municipality and portal isolate workflows; CNPJ is parameterized, secrets excluded',()=>{
  assert.notEqual(flowKey({municipio_codigo_ibge:'1'},'https://example.org/a'),flowKey({municipio_codigo_ibge:'2'},'https://example.org/a'));
  assert.notEqual(flowKey({municipio_codigo_ibge:'1'},'https://example.org/a'),flowKey({municipio_codigo_ibge:'1'},'https://example.org/b'));
  const step=sanitizeStep({action:'change',selector:'#cnpj',frame:'https://example.org/a',tag:'INPUT',value:'00.000.000/0001-91'},'00000000000191');
  assert.equal(step.action,'fill');assert.equal(step.formatted,true);assert.equal(JSON.stringify(step).includes('0001'),false);
  assert.deepEqual(sanitizeStep({action:'manual',selector:'#captcha',value:'secret'},'00000000000191'),{action:'manual'});
});
test('first municipality is manual, saves before Continue, rejects premature completion, then replays another CNPJ',async()=>{
  const f=await fixture();try{
    const learner=f.learner();const running=learner.run();
    await waitFor(()=>learner.state==='awaiting_manual');
    assert.equal(f.requests.length,0);
    assert.equal((await learner.continue()).pending,true);assert.equal(f.visits(),1);
    await learner.page.locator('#cnpj').fill('00.000.000/0001-91');await learner.page.locator('#emit').click();
    await waitFor(()=>learner.state==='document_ready');
    assert.ok(fs.existsSync(f.saved[0]));assert.equal(readFlow(f.root,learner.key),null);
    const results=await Promise.all([learner.continue(),learner.continue()]);assert.ok(results.every(r=>r.completed));
    const result=await running;assert.equal(result.learned.learningStatus,'saved');assert.equal(result.learned.officialPortal,true);
    assert.ok(readFlow(f.root,learner.key));
    const next=f.learner({cnpj:'11222333000181'});const repeated=await next.run();
    assert.ok(repeated.archived.filePath);assert.equal(f.requests.at(-1),'11.222.333/0001-81');
    await assert.rejects(next.complete(f.first),/CNPJ/);
  }finally{await f.close();}
});
test('real attachment download is recovered from the controlled CDP directory without Playwright download event',async()=>{
  const f=await fixture({download:true,suppressDownload:true});try{
    const learner=f.learner();const running=learner.run();await waitFor(()=>learner.state==='awaiting_manual');
    await learner.page.locator('#cnpj').fill('00.000.000/0001-91');await learner.page.locator('#emit').click();
    await waitFor(()=>learner.pdfs.size>0);assert.ok(fs.existsSync(f.saved[0]));
    await learner.continue();const result=await running;assert.equal(result.method,'controlled_download');assert.equal(result.officialPortal,true);
    assert.equal(result.learned.learningStatus,'saved');assert.equal(f.visits(),1);
  }finally{await f.close();}
});
test('CAPTCHA checkpoint resumes on the same page and secret response never enters saved workflow',async()=>{
  const f=await fixture({captcha:true});try{
    const first=f.learner();const firstRun=first.run();await waitFor(()=>first.state==='awaiting_manual');
    await first.page.locator('#cnpj').fill('00.000.000/0001-91');await first.page.locator('#captcha').fill('RESPOSTA-SECRETA');await first.page.locator('#emit').click();
    await waitFor(()=>first.pdfs.size>0);await first.continue();await firstRun;
    const flow=readFlow(f.root,first.key);assert.ok(flow.steps.some(s=>s.action==='manual'));assert.equal(JSON.stringify(flow).includes('RESPOSTA'),false);
    const next=f.learner({cnpj:'11222333000181'});const running=next.run();await waitFor(()=>next.state==='awaiting_checkpoint');
    const visits=f.visits();await next.page.locator('#captcha').fill('NOVO-CAPTCHA');await next.continue();
    const result=await running;assert.ok(result.archived);assert.equal(f.visits(),visits);assert.equal(f.requests.at(-1),'11.222.333/0001-81');
  }finally{await f.close();}
});
test('changed layout falls back in place, cancellation and timeout release waits',async()=>{
  const f=await fixture();try{
    const l=f.learner();saveFlow(f.root,l.key,{version:2,steps:[{action:'manual'},{action:'fill',selector:'#missing',frame:'https://municipal.example/start'}]});
    const running=l.run();await waitFor(()=>l.state==='awaiting_checkpoint');l.stop();await assert.rejects(running,/cancelada/);assert.equal(f.visits(),1);
    const timeout=f.learner({timeoutMs:300});await assert.rejects(timeout.run(),/esgotado/);
    const broken=f.learner({replayWaitMs:100});const brokenRun=broken.run();await waitFor(()=>broken.state==='awaiting_checkpoint');await broken.continue();await waitFor(()=>broken.state==='awaiting_manual');
    assert.equal(f.visits(),3);assert.equal((await broken.continue()).pending,true);assert.equal(f.visits(),3);broken.stop();await assert.rejects(brokenRun,/cancelada/);
  }finally{await f.close();}
});
test('a different company PDF is never saved or used to train; duplicate capture is idempotent',async()=>{
  const f=await fixture();try{
    const l=f.learner();assert.equal(await l.start(),null);
    await assert.rejects(l.capture(f.second,'https://municipal.example/pdf','test'),/CNPJ/);assert.equal(f.saved.length,0);
    const rejected=await l.continue();assert.equal(rejected.pending,true);assert.match(rejected.message,/PDF recebido, mas não arquivado/);
    await Promise.all([l.capture(f.first,'https://municipal.example/pdf','test'),l.capture(f.first,'https://municipal.example/pdf','test')]);
    assert.equal(f.saved.length,1);assert.equal(l.pdfs.size,1);
  }finally{await f.close();}
});
test('UI municipal states enable Continue only for manual work, checkpoint or saved PDF',()=>{
  const sandbox={window:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','public','municipal-learning.js'),'utf8'),sandbox);
  for(const state of ['awaiting_manual','awaiting_checkpoint','document_ready'])assert.equal(sandbox.window.municipalInteraction([{type:'municipal_state',state}]).canContinue,true);
  assert.equal(sandbox.window.municipalInteraction([{type:'municipal_state',state:'replaying'}]).canContinue,false);
  assert.equal(sandbox.window.municipalInteraction([{type:'municipal_state',state:'finished'}]),null);
});

 test('positive certificate with negative effects downloads, archives and completes on Continue',async()=>{
 const f=await fixture({download:true,positiveEffects:true});try{
 const learner=f.learner();const running=learner.run();await waitFor(()=>learner.state==='awaiting_manual');
 await learner.page.locator('#cnpj').fill('00.000.000/0001-91');await learner.page.locator('#emit').click();
 await waitFor(()=>learner.pdfs.size>0);assert.ok(fs.existsSync(f.saved[0]));
 assert.equal((await learner.continue()).completed,true);const result=await running;
 assert.equal(result.parsed.classification,'positiva_efeitos_negativa');assert.deepEqual(fs.readFileSync(f.saved[0]),f.first);
 }finally{await f.close();}
 });
