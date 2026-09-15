const test=require('node:test'),assert=require('node:assert/strict');
const {launchBrowser}=require('../automation/launch');
const {waitForFederalForm}=require('../automation/federal-readiness');
const {PortalSessions}=require('../automation/sessions');
test('federal preparation waits for the form without accepting cookies before issuance',async()=>{
 const browser=await launchBrowser(true);
 try{
  const page=await browser.newPage();await page.route('https://servicos.receitafederal.gov.br/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<input name="niContribuinte"><button onclick="window.issued=true">Emitir Certidão</button><script>setTimeout(()=>{const c=document.createElement('div');c.id='card0';c.innerHTML='utilizamos cookies <button onclick="window.accepted=true;this.parentElement.remove()">Aceitar</button>';document.body.append(c)},300)</script>`}));
  await page.goto('https://servicos.receitafederal.gov.br/form');const job={page,status:'opening',portal:{key:'federal'}};
  const events=[];assert.equal(await waitForFederalForm(job,e=>events.push(e),{minimum:1000,quiet:400,deadline:5000}),true);
  assert.equal(await page.evaluate(()=>Boolean(window.accepted)),false);assert.equal(await page.evaluate(()=>Boolean(window.issued)),false);
  assert.equal(events.at(-1).type,'federal_form_ready');
  await page.getByRole('button',{name:'Emitir Certidão'}).evaluate(e=>{e.disabled=true;});
  assert.equal(await waitForFederalForm(job,()=>{},{minimum:0,quiet:0,deadline:500}),false);
 }finally{await browser.close();}
});
test('Caixa block suspends the job, refuses interaction and never captures a document',async()=>{
 let writes=0;
 const manager=new PortalSessions({store:{put:()=>writes++,audit:()=>{}},onPdf:()=>{throw Error('Must not ingest block');}});
 const page={url:()=> 'https://blocked.example/',locator:()=>({innerText:async()=> 'Estamos detectando comportamento malicioso no acesso. Para proteção do site, não podemos processar sua requisição neste momento.'})};
 const job={id:'blocked-test',portal:{key:'fgts'},status:'awaiting_user',context:{pages:()=>[page]},page,files:[]};manager.jobs.set(job.id,job);
 await manager.guide(job);assert.equal(job.accessBlocked,true);assert.match(job.message,/Caixa bloqueou/);await manager.guide(job);assert.equal(writes,1);
 await assert.rejects(manager.interact(job.id,{action:'click',x:0,y:0}),/Caixa bloqueou/);assert.deepEqual(job.files,[]);
});
