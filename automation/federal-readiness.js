// Wait for the PJ CNPJ consultation form. Cookie consent is handled by the
// session guide before it submits the CNPJ.
async function waitForFederalForm(job,audit=()=>{},timing={}) {
 const minimum=timing.minimum??8000,deadline=timing.deadline??30000,quiet=timing.quiet??1500;
 const started=Date.now();let stableSince=0;
 while(Date.now()-started<deadline){
  if(['cancelled','error','finished'].includes(job.status))return false;
  const frame=job.page;
  if(new URL(frame.url()).hostname!=='servicos.receitafederal.gov.br')return false;
  const ready=await frame.evaluate(()=>{
   const field=document.querySelector('input[name="niContribuinte"]');
   const action=[...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].find(b=>/^(?:Consultar(?: Certid[aã]o)?|Emitir(?: Certid[aã]o)?)$/i.test((b.textContent||b.value||'').trim()));
   return document.readyState==='complete'&&Boolean(field&&field.getClientRects().length&&!field.disabled&&action&&action.getClientRects().length&&!action.disabled)&&!document.querySelector('[aria-busy="true"]');
  }).catch(()=>false);
  if(!ready)stableSince=0;else stableSince ||= Date.now();
  if(stableSince&&Date.now()-started>=minimum&&Date.now()-stableSince>=quiet){
   audit({type:'federal_form_ready',jobId:job.id,portal:'federal',action:'Formulário de Pessoa Jurídica disponível para informar o CNPJ e consultar',elapsedMs:Date.now()-started});return true;
  }
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 return false;
}
module.exports={waitForFederalForm};
