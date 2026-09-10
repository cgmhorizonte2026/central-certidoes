const {trustedUrl}=require('../config/registry');
const attempts=new WeakMap();
const busy=new WeakSet();
const filledFields=new WeakMap();
async function advanceVerification(job){
 if(busy.has(job))return {status:'awaiting_response',message:'A validação do TST já está em andamento.'};
 busy.add(job);try{return await performVerification(job);}finally{busy.delete(job);}
}
async function performVerification(job){
 if(job.portal.key!=='trabalhista')return fillVerification(job);
 const target=job.verificationTarget,number=target?.number?.match(/^(\d+)\/(\d{4})$/);
 if(!number)return {status:'awaiting_user',message:'Número e ano da CNDT não identificados no PDF. Confira o documento antes de validar.'};
 const page=job.context.pages().find(p=>trustedUrl(p.url(),job.portal)&&new URL(p.url()).hostname==='cndt-certidao.tst.jus.br'&&new URL(p.url()).pathname==='/consultarCertidao');
 if(!page)return {status:'awaiting_user',message:'Aguardando a página oficial de validação da CNDT.'};
 const state=attempts.get(job),text=await page.locator('body').innerText({timeout:3000});
 if(state){
   if(/Não existe Certidão Nacional de Débitos Trabalhistas com os valores informados/i.test(text))return {status:'awaiting_user',message:'O TST não encontrou certidão com este CNPJ, número e ano. A autenticidade continua pendente.'};
   if(/Operação efetuada com sucesso\./i.test(text))return {confirmed:true,page,query:state,status:'verification_confirmed',message:'O TST confirmou a consulta de autenticidade para o CNPJ, número e ano informados.'};
   return {status:'awaiting_response',message:'Consulta de autenticidade enviada ao TST. Aguardando a resposta oficial.'};
 }
 for(const [selector,value] of [['#cpfCnpj',job.cnpj],['#numCertidao',number[1]],['#anoCertidao',number[2]]]){
   const input=page.locator(selector);if(!await input.isVisible())return {status:'awaiting_response',message:'Carregando o formulário de validação do TST.'};
   await input.fill('');await input.pressSequentially(value,{delay:50});await input.press('Tab');
   if((await input.inputValue()).replace(/\D/g,'')!==value)throw new Error('O campo de validação não recebeu o valor completo. Confira a janela do TST.');
 }
 const query={cnpj:job.cnpj,number:target.number,sha256:target.sha256,submittedAt:new Date().toISOString()};
 attempts.set(job,query);await page.getByRole('button',{name:'Validar Certidão',exact:true}).click({timeout:5000});
 return {status:'awaiting_response',message:'CNPJ, número e ano preenchidos. Validação enviada ao TST.'};
}
async function fillVerification(job){
 const target=job.verificationTarget||{},filled=[],missing=[];
 let history=filledFields.get(job);if(!history){history=new Set();filledFields.set(job,history);}
 const normal=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
 for(const page of job.context.pages())for(const frame of page.frames()){
  if(!trustedUrl(frame.url(),job.portal))continue;
  const fields=frame.locator('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=radio]):not([type=checkbox]):not([type=password])');
  for(let i=0;i<await fields.count();i++){
   const field=fields.nth(i);if(!await field.isVisible()||!await field.isEditable())continue;
   const info=await field.evaluate(e=>({hint:[...(e.labels||[])].map(l=>l.textContent).join(' ')+' '+[e.name,e.id,e.placeholder,e.getAttribute('aria-label')].join(' '),type:e.type,name:e.name}));
   const federal=new URL(frame.url()).hostname==='solucoes.receita.fazenda.gov.br';
   const mapped=federal?{NI:'cnpj',Controle:'controle',Data:'emissao',Hora:'hora'}[info.name]:null;
   const hint=normal(mapped||info.hint);if(/captcha|seguranca|caracteres|pesquis/.test(hint))continue;
   let key,value;
   if(/cnpj|cpfcnpj|ni contribuinte|nicontribuinte/.test(hint)){key='CNPJ';value=job.cnpj;}
   else if(/controle|autentic|verific|codcert/.test(hint)){key='Código de controle';value=target.controlCode;}
   else if(/validade|vencimento/.test(hint)){key='Validade';value=target.expiresAt;}
   else if(/hora/.test(hint)){key='Hora da emissão';value=target.issuedTime;}
   else if(/emissao|expedicao|dataemiss/.test(hint)){key='Data da emissão';value=target.issuedAt;}
   else if(/ano/.test(hint)){key='Ano';value=target.number?.match(/\/(\d{4})$/)?.[1];}
   else if(/certidao|certificado/.test(hint)&&/num|numero/.test(hint)){key='Número da certidão';value=target.number;}
   else continue;
   if(!value){missing.push(key);continue;}
   if(/^\d{4}-\d{2}-\d{2}$/.test(value)&&info.type!=='date')value=value.split('-').reverse().join('/');
   const normalized=v=>String(v).toUpperCase().replace(/[^A-Z0-9]/g,'');
   const fieldKey=JSON.stringify([frame.url(),info.name,i,value]);
   if(!history.has(fieldKey)){
     // Preserve operator edits and never type again on every monitoring tick.
     history.add(fieldKey);
     if(normalized(await field.inputValue())!==normalized(value)){
       // Legacy Receita key handlers insert separators themselves. Fill the complete value
       // atomically, then blur normally so its own validation runs without doubled separators.
       await field.fill(value);await field.press('Tab');
     }
   }
   if(normalized(await field.inputValue())!==normalized(value)){missing.push(key);continue;}
   filled.push(key);
  }
 }
 job.verificationFields={filled:[...new Set(filled)],missing:[...new Set(missing)]};
 return {status:'awaiting_user',message:filled.length?'Dados do PDF preenchidos: '+[...new Set(filled)].join(', ')+'. '+(missing.length?'Não identificados: '+[...new Set(missing)].join(', ')+'. ':'')+'Confira a tela e conclua a validação no órgão.':'Nenhum campo compatível identificado nesta tela de validação. Confira a janela interativa.'};
}
module.exports={advanceVerification,fillVerification};
