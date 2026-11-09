const test=require('node:test');
const assert=require('node:assert/strict');
const {launchBrowser}=require('../automation/launch');
const {advance}=require('../automation/issuer-engine');

test('Receita current SPA selects PJ, accepts cookies, and clicks the Emitir Certidão button',async()=>{
 const browser=await launchBrowser(true);
 try{
  const context=await browser.newContext();
  await context.route('https://servicos.receitafederal.gov.br/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html>
   <script>
    window.steps=[];
    function showForm(){
     window.pjSelected=true;document.querySelector('#choice').hidden=true;document.querySelector('#card0').hidden=false;
     document.querySelector('#stage').innerHTML='<app-coleta-parametros-pj><app-coleta-parametros-template><form><div><div><input name="niContribuinte"><a id="old-link">Consulte certidões mais antigas</a></div></div><div class="acoes-card"><div class="left-position"><button type="button">Voltar</button></div><div class="right-position"><button type="button" id="query">Consultar Certidão</button><button type="submit" id="issue">Emitir Certidão</button></div></div></form></app-coleta-parametros-template></app-coleta-parametros-pj>';
     document.querySelector('#query').onclick=()=>window.steps.push('wrong-initial-query');
     document.querySelector('#issue').onclick=event=>{event.preventDefault();window.steps.push('issue');window.issuedCnpj=document.querySelector('input[name="niContribuinte"]').value;document.querySelector('#stage').innerHTML='Certidão emitida com sucesso';};
    }
   </script>
   <div id="choice"><label><input type="radio" name="tipoPessoa" onchange="showForm()"> Pessoa Jurídica</label></div>
   <div id="card0" hidden>Para melhorar sua experiência, utilizamos cookies. <button onclick="window.steps.push('cookies');this.parentElement.hidden=true">Aceitar</button></div><main id="stage"></main>`}));
  const page=await context.newPage();await page.goto('https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj');
  const job={id:'federal-current-flow',mode:'issue',status:'opening',cnpj:'00000000000191',context,portal:{key:'federal',allowedHosts:['servicos.receitafederal.gov.br']}};
  const events=[];
  await advance(job,e=>events.push(e));
  assert.equal(await page.evaluate(()=>window.pjSelected),true);
  await advance(job,e=>events.push(e));
  assert.deepEqual(await page.evaluate(()=>window.steps),['cookies']);
  await advance(job,e=>events.push(e));
  assert.equal((await page.evaluate(()=>window.issuedCnpj)).replace(/\D/g,''),job.cnpj);
  assert.deepEqual(await page.evaluate(()=>window.steps),['cookies','issue']);
  assert.ok(events.some(e=>e.type==='federal_person_type_selected'));
  assert.ok(events.some(e=>e.type==='federal_issue_requested'));
  assert.equal(events.find(e=>e.type==='federal_action_selected')?.element?.text,'Emitir Certidão');
  await context.close();
 }finally{await browser.close();}
});
