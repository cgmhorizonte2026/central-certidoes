const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {launchBrowser}=require('../automation/launch');
const {MunicipalLearning,readFlow,saveFlow}=require('../automation/municipal-learning');
const {finalMunicipalDocument,DOCUMENT_POLICY}=require('../automation/municipal-print');
const {extractPdf}=require('../lib/certificates');
const rootBase=path.resolve(__dirname,'..','tmp');fs.mkdirSync(rootBase,{recursive:true});
const waitFor=async fn=>{const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Print fixture timed out');};
const cert=cnpj=>`<h1>Prefeitura Municipal - Certidão Negativa</h1><p>CNPJ ${cnpj}</p><p>Certificamos que não constam débitos municipais para o contribuinte.</p><p>Validade: 31/12/2026</p><p>Chave de consulta: ABCD-1234-5678</p>`;
async function setup(mode='same'){
  const root=fs.mkdtempSync(path.join(rootBase,'municipal-print-')),browser=await launchBrowser(true),context=await browser.newContext();
  const events=[],learners=[],saved=[];
  await context.route('https://print.example/**',route=>{
    const url=new URL(route.request().url()),cnpj=url.searchParams.get('cnpj')||'00.000.000/0001-91';
    if(url.pathname==='/print')return route.fulfill({contentType:'text/html; charset=utf-8',body:cert(cnpj)+`<script>window.print();window.close();</script>`});
    const start=`<input id="cnpj"><button id="query" onclick="document.getElementById('summary').hidden=false;document.getElementById('certificate').innerHTML=${JSON.stringify(cert('REPLACE_CNPJ')).replaceAll('"','&quot;')}.replace('REPLACE_CNPJ',document.getElementById('cnpj').value)">Consultar</button>`;
    let action="window.print();document.getElementById('certificate').innerHTML=''";
    if(mode==='popup')action="window.open('/print?cnpj='+encodeURIComponent(document.getElementById('cnpj').value))";
    if(mode==='frame')action="document.getElementById('target').contentWindow.print()";
    const frame=mode==='frame'?`<iframe id="target" srcdoc="${cert(cnpj).replaceAll('"','&quot;')}"></iframe>`:'';
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<style>#certificate{display:none}@media print{body>*:not(#certificate){display:none}#certificate{display:block}}</style>${start}<section id="summary" hidden><h1>Resultado da consulta</h1>Certidão disponível. <button id="print" onclick="${action}">Imprimir</button></section><div id="certificate"></div>${frame}`});
  });
  return {root,browser,context,events,saved,learner:options=>{
    const learner=new MunicipalLearning({root,browser:{context,newPortalPage:()=>context.newPage()},portal:{url:'https://print.example/start'},company:{municipio_codigo_ibge:'2304285'},cnpj:'00000000000191',emit:e=>events.push(e),timeoutMs:45000,replayWaitMs:1000,onCapture:async record=>{saved.push(record);return {filePath:record.filePath};},...options});
    learners.push(learner);return learner;
  },close:async()=>{for(const learner of learners)await learner.dispose();await browser.close();assert.ok(path.resolve(root).startsWith(rootBase+path.sep));fs.rmSync(root,{recursive:true,force:true});}};
}
test('document finality rejects a result list even with CNPJ, status, validity and code',()=>{
  const result=finalMunicipalDocument('Prefeitura Municipal Resultado da consulta Certidão Negativa CNPJ 00.000.000/0001-91 Validade:31/12/2026 Código de controle: ABC123456','00000000000191');assert.equal(result.valid,false);
  assert.equal(finalMunicipalDocument(cert('00.000.000/0001-91').replace(/<[^>]*>/g,' '),'00000000000191').valid,true);
});
test('same-page print respects print CSS, snapshots before DOM cleanup, saves final PDF and learns replay for another company',async()=>{
  const f=await setup();try{
    const l=f.learner();const running=l.run();running.catch(()=>{});await waitFor(()=>l.state==='awaiting_manual');
    await l.page.locator('#cnpj').fill('00.000.000/0001-91');await l.page.locator('#query').click();
    assert.equal(l.pdfs.size,0);
    await l.page.locator('#print').click();await waitFor(()=>l.state==='document_ready');
    const received=[...l.pdfs.values()][0];assert.equal(received.method,'official_print_view');assert.equal(received.documentValidation,DOCUMENT_POLICY);assert.equal(received.officialPortal,true);
    assert.equal(/resultado da consulta/i.test(received.text),false);assert.match(received.text,/Certificamos/);
    assert.equal(await l.page.locator('#certificate').innerHTML(),'');
    await l.continue();await running;assert.equal(readFlow(f.root,l.key).version,3);
    const next=f.learner({cnpj:'11222333000181'});const result=await next.run();assert.equal(result.parsed.cnpjMatches,true);assert.match(result.text,/11.222.333\/0001-81/);
  }finally{await f.close();}
});
test('popup print with immediate window.close is captured before closing',async()=>{
  const f=await setup('popup');try{
    const l=f.learner();const running=l.run();running.catch(()=>{});await waitFor(()=>l.state==='awaiting_manual');
    await l.page.locator('#cnpj').fill('00.000.000/0001-91');await l.page.locator('#query').click();await l.page.locator('#print').click();
    await waitFor(()=>l.pdfs.size>0);await l.continue();const result=await running;assert.equal(result.method,'official_print_view');assert.ok(result.url.includes('/print?cnpj='));
  }finally{await f.close();}
});
test('printing an iframe captures the frame certificate rather than the parent results screen',async()=>{
  const f=await setup('frame');try{
    const l=f.learner();const running=l.run();running.catch(()=>{});await waitFor(()=>l.state==='awaiting_manual');
    await l.page.locator('#cnpj').fill('00.000.000/0001-91');await l.page.locator('#query').click();await l.page.locator('#print').click();
    await waitFor(()=>l.pdfs.size>0);await l.continue();const result=await running;assert.equal(result.method,'official_print_view');assert.match(result.text,/Certificamos/);assert.equal(/resultado da consulta/i.test(result.text),false);
  }finally{await f.close();}
});
test('printing a summary and native summary PDF both stay pending, never archived or learned',async()=>{
  const f=await setup();try{
    const l=f.learner();await l.start();
    const summary='<h1>Prefeitura Municipal Resultado da consulta</h1><p>Certidão Negativa CNPJ 00.000.000/0001-91 Validade:31/12/2026 Código de controle:ABC123456</p>';
    await l.page.evaluate(html=>{document.body.innerHTML=html;window.print();},summary);
    await waitFor(()=>f.events.some(e=>e.type==='municipal_print_rejected'));assert.equal(l.pdfs.size,0);assert.equal(f.saved.length,0);
    const page=await f.browser.newPage();await page.setContent(summary);const bytes=await page.pdf();
    await assert.rejects(l.capture(bytes,'https://print.example/list.pdf','official_response'),/consulta|listagem/);
    assert.equal((await l.continue()).pending,true);assert.equal(readFlow(f.root,l.key),null);
  }finally{await f.close();}
});
test('legacy workflow missing the final print step finds Imprimir and upgrades only after a final document',async()=>{
  const f=await setup();try{
    const l=f.learner();saveFlow(f.root,l.key,{version:2,steps:[{action:'fill',selector:'#cnpj',frame:'https://print.example/start',formatted:true},{action:'click',selector:'#query',frame:'https://print.example/start'}]});
    const result=await l.run();assert.equal(result.method,'official_print_view');const flow=readFlow(f.root,l.key);assert.equal(flow.version,3);assert.equal(flow.steps.at(-1).selector,'#print');
  }finally{await f.close();}
});
test('native PDF takes precedence over rendered printing and preserves original bytes',async()=>{
  const f=await setup();try{
    const l=f.learner();await l.start();const page=await f.browser.newPage();await page.setContent(cert('00.000.000/0001-91'));const bytes=await page.pdf();
    await l.capture(bytes,'https://print.example/original.pdf','official_response');
    await l.page.evaluate(()=>window.print());await new Promise(r=>setTimeout(r,1000));
    assert.equal(f.saved.length,1);assert.equal([...l.pdfs.values()][0].method,'official_response');assert.deepEqual([...l.pdfs.values()][0].buffer,bytes);assert.equal(f.events.some(e=>e.type==='municipal_print_started'),false);
  }finally{await f.close();}
});
