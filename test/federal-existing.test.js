const test=require('node:test'),assert=require('node:assert/strict');
const {launchBrowser}=require('../automation/launch');
const {existingFederalCertificate}=require('../automation/federal-existing');
test('existing federal certificate opens search and downloads only a valid matching result once',async()=>{
 const browser=await launchBrowser(true);
 try{
  const page=await browser.newPage();await page.route('https://servicos.receitafederal.gov.br/**',r=>r.fulfill({contentType:'text/html',body:'<body></body>'}));
  const root='https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj';
  await page.goto(root);await page.setContent('<button>Consultar Certidão</button><div role="dialog"><h4>Certidão Válida Encontrada</h4><button onclick="window.opened=true">Consultar Certidão</button></div>');
  const job={portal:{key:'federal'},cnpj:'00000000000191'},state={filled:true,actions:new Set()};
  await existingFederalCertificate(page,job,state,()=>{});assert.equal(await page.evaluate(()=>window.opened),true);
  await page.goto(root+'/consultar');await page.setContent('<p>CNPJ 00.000.000/0001-91</p><label>Data Inicial<input value="11/09/2025"></label><label>Data Final<input value="11/09/2026"></label><button onclick="window.queries=(window.queries||0)+1">Consultar Certidão</button>');
  await existingFederalCertificate(page,job,state,()=>{});await existingFederalCertificate(page,job,state,()=>{});assert.equal(await page.evaluate(()=>window.queries),1);
  await page.goto(root+'/consultar/resultado');await page.setContent('<p>CNPJ 00.000.000/0001-91</p><table><tr><td>Expirada</td><td>01/01/2020</td><td><button title="Segunda via" onclick="window.wrong=true">Download</button></td></tr><tr><td>Válida</td><td>31/12/2099</td><td><button title="Segunda via" onclick="window.downloads=(window.downloads||0)+1">Download</button></td></tr></table>');
  await existingFederalCertificate(page,job,state,()=>{});await existingFederalCertificate(page,job,state,()=>{});
  assert.equal(await page.evaluate(()=>window.downloads),1);assert.equal(await page.evaluate(()=>Boolean(window.wrong)),false);
  state.actions.clear();job.cnpj='11222333000181';assert.equal((await existingFederalCertificate(page,job,state,()=>{})).status,'awaiting_user');assert.equal(await page.evaluate(()=>window.downloads),1);
 }finally{await browser.close();}
});
