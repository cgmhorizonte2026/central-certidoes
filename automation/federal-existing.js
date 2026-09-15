const {isoDate,today}=require('../lib/domain');
async function existingFederalCertificate(frame,job,state,audit){
 const url=new URL(frame.url());
 if(job.portal.key!=='federal'||url.hostname!=='servicos.receitafederal.gov.br'||!state.filled)return null;
 if(state.federalSubmittedAt&&Date.now()-state.federalSubmittedAt>60000)return null;
 const body=await frame.locator('body').innerText({timeout:2500});
 const act=async(control,key,message)=>{
  if(!state.actions.has(key)){
   state.actions.add(key);state.federalSubmittedAt=Date.now();await control.click({timeout:5000});
   audit({type:'federal_existing_certificate',jobId:job.id,portal:'federal',action:message});
  }
  return {status:'awaiting_response',message};
 };
 if(/Certidão Válida Encontrada/i.test(body)){
  const query=frame.getByRole('button',{name:'Consultar Certidão',exact:true});
  // A modal and the underlying form can both have this label; prefer its dialog.
  const modal=frame.locator('[role="dialog"],.br-modal').filter({hasText:'Certidão Válida Encontrada'});
  const button=await modal.count()?modal.getByRole('button',{name:'Consultar Certidão',exact:true}):query.last();
  if(await button.isVisible().catch(()=>false)&&await button.isEnabled())return act(button,'federal_existing_open','Certidão válida encontrada. Consultando a segunda via antes de solicitar nova emissão.');
 }
 if(url.hash.endsWith('/cnpj/consultar')){
  if(!body.replace(/[.\/\-\s]/g,'').includes(job.cnpj))return {status:'awaiting_user',message:'A consulta da Receita não confirmou o CNPJ esperado. Confira o painel antes de continuar.'};
  const from=frame.getByRole('textbox',{name:'Data Inicial',exact:true}),to=frame.getByRole('textbox',{name:'Data Final',exact:true});
  if(!await from.isVisible().catch(()=>false)||!await to.isVisible().catch(()=>false))return {status:'awaiting_response',message:'Aguardando os filtros da consulta da Receita.'};
  const start=isoDate(await from.inputValue()),end=isoDate(await to.inputValue());
  if(!start||!end||start>end)return {status:'awaiting_user',message:'Confira o período de consulta da Receita no painel interativo.'};
  const button=frame.getByRole('button',{name:'Consultar Certidão',exact:true});
  if(await button.isEnabled())return act(button,'federal_existing_search','Pesquisando as certidões já emitidas no período apresentado pela Receita.');
 }
 if(url.hash.endsWith('/cnpj/consultar/resultado')){
  if(!body.replace(/[.\/\-\s]/g,'').includes(job.cnpj))return {status:'awaiting_user',message:'O resultado da Receita não identifica o CNPJ esperado.'};
  const rows=frame.getByRole('row'),candidates=[];
  for(let i=0;i<await rows.count();i++){
   const row=rows.nth(i),cells=await row.getByRole('cell').allTextContents();
   if(!cells.some(t=>/^Válida$/i.test(t.trim())))continue;
   const expiry=cells.map(t=>t.trim()).filter(t=>/^\d{2}\/\d{2}\/\d{4}$/.test(t)).map(isoDate).filter(Boolean).at(-1);
   if(!expiry||(Date.parse(expiry)-Date.parse(today()))/86400000<5)continue;
   const button=row.locator('button[title="Segunda via"]');
   if(await button.isVisible().catch(()=>false)&&await button.isEnabled())candidates.push({expiry,button});
  }
  candidates.sort((a,b)=>b.expiry.localeCompare(a.expiry));
  if(candidates.length)return act(candidates[0].button,'federal_existing_download',`Solicitando segunda via válida até ${candidates[0].expiry.split('-').reverse().join('/')}. Aguardando o PDF da Receita.`);
  return {status:'awaiting_user',message:'Nenhuma certidão com pelo menos 5 dias de validade foi identificada nesta página. Confira os demais resultados ou solicite nova emissão pelo painel.'};
 }
 return null;
}
module.exports={existingFederalCertificate};
