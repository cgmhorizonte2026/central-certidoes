// Prepare only the form. Cookie consent belongs after the first issuance click.
async function waitForFederalForm(job,audit=()=>{},timing={}) {
 const minimum=timing.minimum??8000,deadline=timing.deadline??30000,quiet=timing.quiet??1500;
 const started=Date.now();let stableSince=0;
 while(Date.now()-started<deadline){
  if(['cancelled','error','finished'].includes(job.status))return false;
  const frame=job.page;
  if(new URL(frame.url()).hostname!=='servicos.receitafederal.gov.br')return false;
  const ready=await frame.evaluate(()=>{
   const field=document.querySelector('input[name="niContribuinte"]');
   const emit=[...document.querySelectorAll('button')].find(b=>/^Emitir(?: Certid[aã]o)?$/i.test(b.textContent.trim()));
   return document.readyState==='complete'&&Boolean(field&&field.getClientRects().length&&!field.disabled&&emit&&emit.getClientRects().length&&!emit.disabled)&&!document.querySelector('[aria-busy="true"]');
  }).catch(()=>false);
  if(!ready)stableSince=0;else stableSince ||= Date.now();
  if(stableSince&&Date.now()-started>=minimum&&Date.now()-stableSince>=quiet){
   audit({type:'federal_form_ready',jobId:job.id,portal:'federal',action:'Formulário disponível para preencher CNPJ e emitir',elapsedMs:Date.now()-started});return true;
  }
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 return false;
}
module.exports={waitForFederalForm};
