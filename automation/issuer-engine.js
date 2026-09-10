const crypto = require('node:crypto');
const { trustedUrl } = require('../config/registry');
const {isoDate,today}=require('../lib/domain');
const {federalSecurityError}=require('./federal-support');
const runtime = new WeakMap();
const terminal = job => ['finished','cancelled','error','capturing'].includes(job.status);
const editable = 'input:not([type=radio]):not([type=checkbox]):not([type=hidden]):not([type=submit]):not([type=button])';
async function visible(locator) { return locator.isVisible().catch(() => false); }
async function fillFirst(frame, selectors, value) {
  for (const selector of selectors) {
    const inputs = frame.locator(selector);
    for (let i=0;i<await inputs.count();i++) {
      const input=inputs.nth(i);
      if (!await visible(input) || !await input.isEditable()) continue;
      const invalidMask=await input.getAttribute('name')==='niContribuinte'&&await input.getAttribute('aria-invalid')==='true';
      if ((await input.inputValue()).replace(/[^a-z0-9]/gi,'') !== value||invalidMask) {
        // Official masked controls (notably Receita) update their model on key events.
        await input.fill('',{timeout:2500});
        await input.pressSequentially(value,{delay:70,timeout:5000});
        await input.press('Tab',{timeout:2000});
      }
      return (await input.inputValue()).replace(/[^a-z0-9]/gi,'') === value && await input.getAttribute('aria-invalid') !== 'true';
    }
  }
  return false;
}
async function challenge(frame) {
  // Read completion only. Never generate tokens or interact with challenge frames.
  const tokens = await frame.locator('[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]').evaluateAll(es=>es.map(e=>e.value||'').filter(Boolean));
  const inputs=frame.locator('input:not([type=hidden])[id*="captcha" i],input:not([type=hidden])[name*="captcha" i]');
  const values=[];let missing=false,detected=false;
  for(let i=0;i<await inputs.count();i++){const input=inputs.nth(i);if(await visible(input)){detected=true;const value=await input.inputValue();values.push(value);if(!value.trim())missing=true;}}
  for(const selector of ['iframe[src*="recaptcha"]','iframe[src*="hcaptcha"]','iframe[src*="challenges.cloudflare.com"]']) {
    const widgets=frame.locator(selector);for(let i=0;i<await widgets.count();i++)if(await visible(widgets.nth(i))){
      const widget=widgets.nth(i),src=await widget.getAttribute('src');
      // Invisible reCAPTCHA badges are not an interactive challenge; the site's submit runs them.
      if(src?.includes('recaptcha')&&new URL(src,frame.url()).searchParams.get('size')==='invisible')continue;
      detected=true;if(!tokens.length)missing=true;
    }
  }
  return { blocked:detected&&missing, completed:tokens.length>0||values.some(v=>v.trim()), fingerprint:crypto.createHash('sha256').update(JSON.stringify([...tokens,...values])).digest('hex') };
}
async function prepare(frame,job) {
  const host=new URL(frame.url()).hostname;
  if(host==='uruoca.ssinformatica.net'&&new URL(frame.url()).pathname.split(';')[0]==='/portal/web/certidao/contribuinte/documento'){
    return fillFirst(frame,['input[id$="inp-label"]'],job.cnpj);
  }
  if(host==='consultapublica.sefaz.ce.gov.br'){
    const radio=frame.locator('input#cnpj[type=radio]');if(await radio.count()&&!await radio.isChecked()){
      const label=frame.locator('label[for="cnpj"]');if(await visible(label))await label.click({timeout:2500});else await radio.check({timeout:2500});
    }
    return fillFirst(frame,['input#codigoDevedor'],job.cnpj);
  }
  if(host==='grpfordam.sefin.fortaleza.ce.gov.br'){
    const type=frame.locator('select[id$="tipoCertidao"]');
    if(await visible(type)){
      const label='Certidão Negativa de Débitos de Tributos Municipais';
      if((await type.locator('option:checked').textContent()).trim()!==label){await type.selectOption({label},{timeout:2500});return false;}
    }
    const juridica=frame.getByLabel('Jurídica',{exact:true});
    if(await visible(juridica)&&!await juridica.isChecked()){await juridica.check({timeout:2500});return false;}
  }
  if(host==='ww1.receita.fazenda.df.gov.br'){
    if(!await visible(frame.locator('input#documento'))){
      const tab=frame.getByText('Emissão de Certidão',{exact:true});if(await visible(tab)){await tab.click({timeout:2500});return false;}
    }
    const radio=frame.getByRole('radio',{name:/^(?:CNPJ|Pessoa Jurídica)$/i});
    if(await visible(radio)&&!await radio.isChecked()){
      const wrapper=frame.locator('mat-radio-button').filter({hasText:'Pessoa Jurídica'});
      if(await visible(wrapper))await wrapper.click({timeout:2500});else await radio.check({timeout:2500});return false;
    }
    // This is the issuance field, never the separate authentication form.
    return fillFirst(frame,['input#documento'],job.cnpj);
  }
  return fillFirst(frame,[`${editable}[name="niContribuinte"]`,`${editable}[name="NI"]`,`${editable}[id*="txtInscricao" i]`,`${editable}[name*="cnpj" i]`,`${editable}[id*="cnpj" i]`,`${editable}[placeholder*="CNPJ" i]`,`${editable}[name="documento"]`],job.cnpj);
}
async function advance(job,audit=()=>{}) {
  if(terminal(job))return null;
  if(job.mode!=='issue')return {status:'awaiting_user',message:'Portal de autenticação aberto. Confira os dados da certidão na janela do órgão e conclua a consulta.'};
  let state=runtime.get(job);if(!state){state={actions:new Set(),sent:new Map(),started:Date.now(),filled:false};runtime.set(job,state);}
  if(state.busy)return null;state.busy=true;
  try{
    let trusted=false,blocked=false,filled=false;
    for(const page of job.context.pages())for(const frame of page.frames()){
      if(!trustedUrl(frame.url(),job.portal))continue;trusted=true;
      const body=await frame.locator('body').innerText({timeout:2500});
      if(new URL(frame.url()).hostname==='grpfordam.sefin.fortaleza.ce.gov.br'){
        const modal=frame.locator('form#modalReimpressaoForm');
        if(await visible(modal)){
          const text=await modal.innerText(),match=text.match(/v[aá]lida\s+at[eé]\s+(\d{2}\/\d{2}\/\d{4})/i),expiry=match&&isoDate(match[1]);
          if(!expiry)return {status:'awaiting_user',message:'O município ofereceu reimpressão, mas não foi possível identificar a validade. Confira a data na janela interativa antes de escolher.'};
          const days=Math.round((Date.parse(expiry+'T00:00:00Z')-Date.parse(today()+'T00:00:00Z'))/86400000);
          const name=days>=5?'Reimprimir Certidão':'Solicitar Nova Emissão',key=`municipal:${expiry}:${name}`;
          if(!state.actions.has(key)){
            state.actions.add(key);job.reprintDecision={expiresAt:expiry,remainingDays:days,action:name};
            await modal.getByRole('button',{name,exact:true}).click({timeout:5000});
            audit({type:'municipal_reprint_decision',jobId:job.id,cnpj:job.cnpj,portal:job.portal.key,...job.reprintDecision});
          }
          return {status:'awaiting_response',message:`${name}: certidão anterior válida até ${match[1]} (${days} dias restantes). Aguardando o documento do município.`};
        }
        if(await visible(frame.locator('#gifAguarde')))return {status:'awaiting_response',message:'O município está processando a solicitação. Aguardando o término do carregamento.'};
      }
      if(new URL(frame.url()).hostname==='servicos.receitafederal.gov.br'&&state.filled){
        const renew=frame.getByRole('button',{name:/^Emitir nova certid[aã]o$/i});
        if(await visible(renew)){
          if(!await renew.isEnabled())return {status:'awaiting_response',message:'Aguardando a Receita habilitar a confirmação de nova emissão.'};
          const security=await challenge(frame);
          if(security.blocked)return {status:'captcha_required',message:'A Receita solicitou verificação de segurança antes da nova emissão.'};
          if(!state.actions.has('federal_new_certificate')){
            state.actions.add('federal_new_certificate');await renew.click({timeout:5000});
            audit({type:'automatic_issuance_attempt',cnpj:job.cnpj,jobId:job.id,portal:job.portal.key,action:'Emitir nova certidão'});
          }
          return {status:'awaiting_response',message:'Aviso de certidão existente identificado. Nova emissão solicitada à Receita; aguardando o PDF.'};
        }
      }
      if(job.portal.key==='federal'){const securityError=federalSecurityError(body);if(securityError)return securityError;}
      const failure=body.match(/(?:Não foi possível concluir a ação[^\n]*|CNPJ inválido[^\n]*|Serviço (?:temporariamente )?indisponível[^\n]*|Caracteres (?:inválidos|incorretos)[^\n]*)/i);
      if(failure&&state.sent.size){
        return {status:'awaiting_user',message:`O órgão informou: ${failure[0].slice(0,400)}. Confira a janela do órgão. Nenhuma certidão foi confirmada por essa mensagem.`};
      }
      if(new URL(frame.url()).hostname==='servicos.receitafederal.gov.br'&&state.federalSubmitted){
        const security=await challenge(frame);
        if(security.blocked)return {status:'captcha_required',message:'A Receita solicitou verificação de segurança. Conclua na janela interativa.'};
        return {status:'awaiting_response',message:state.actions.has('federal_new_certificate')?'Nova emissão confirmada. Aguardando o PDF da Receita.':'Primeiro clique enviado. Aguardando a janela da Receita para confirmar a nova emissão.'};
      }
      if(new URL(frame.url()).hostname==='cndt-certidao.tst.jus.br'&&!state.filled){
        const entry=frame.getByRole('link',{name:'Emitir Certidão',exact:true});
        if(await visible(entry)){
          const href=await entry.getAttribute('href');
          const key=`entry:${frame.url()}`;
          if(href&&trustedUrl(new URL(href,frame.url()).href,job.portal)&&!state.actions.has(key)){
            state.actions.add(key);await entry.click({timeout:5000});return {status:'awaiting_response',message:'Abrindo o formulário oficial de emissão da certidão trabalhista.'};
          }
        }
      }
      filled=await prepare(frame,job)||filled;state.filled ||= filled;
      if(terminal(job))return null;
      const security=await challenge(frame);if(security.blocked){blocked=true;continue;}
      const host=new URL(frame.url()).hostname;
      if(host==='consultapublica.sefaz.ce.gov.br'&&await visible(frame.locator('#loadingOverlay')))return {status:'awaiting_response',message:'Pesquisa enviada à Sefaz. Aguardando a relação de certidões.'};
      if(host==='uruoca.ssinformatica.net'&&/Captcha\s+Campo obrigat[oó]rio/i.test(body)&&!security.completed)return {status:'captcha_required',message:'Uruoca exige CAPTCHA para liberar o PDF. Abra a janela interativa, conclua a verificação e continue a emissão.'};
      if(host==='uruoca.ssinformatica.net'&&state.filled&&!state.actions.has('uruoca_print:'+security.fingerprint)){
        const print=frame.locator('form[id$="frm-cad"] button').filter({hasText:/^Imprimir$/}).first();
        if(await visible(print)&&await print.isEnabled()){
          state.actions.add('uruoca_print:'+security.fingerprint);await print.click({timeout:5000});
          audit({type:'automatic_issuance_attempt',cnpj:job.cnpj,jobId:job.id,portal:job.portal.key,action:'Imprimir certidão do contribuinte'});
          return {status:'awaiting_response',message:'CNPJ preenchido. Solicitando o PDF no Portal do Contribuinte de Uruoca.'};
        }
      }
      if(host==='consultapublica.sefaz.ce.gov.br'&&body.replace(/[.\/\-\s]/g,'').includes(job.cnpj)){
        const rows=frame.locator('tbody tr');let pdf=null;
        for(let i=0;i<await rows.count();i++){const row=rows.nth(i);if((await row.innerText()).replace(/[.\/\-\s]/g,'').includes(job.cnpj)){const candidate=row.locator('button#postButton,button:has([title=Pdf]),a[title=PDF]');if(await candidate.count()){pdf=candidate.first();break;}}}
        if(pdf&&await visible(pdf)&&!state.actions.has('ce_result_pdf')){
          state.actions.add('ce_result_pdf');await pdf.click({timeout:5000});
          return {status:'awaiting_response',message:'Resultado estadual localizado para o CNPJ. Solicitando o PDF da certidão.'};
        }
      }
      if(host==='consultapublica.sefaz.ce.gov.br'&&state.filled){
        const search=frame.getByRole('button',{name:/^(?:Pesquisar|Buscar)$/i});
        if(await visible(search)&&!state.actions.has('ce_search')){
          state.actions.add('ce_search');await search.click({timeout:5000});
          audit({type:'automatic_issuance_attempt',cnpj:job.cnpj,jobId:job.id,portal:job.portal.key,action:'Pesquisar'});
        }
        return {status:'awaiting_response',message:'Pesquisa enviada à Sefaz. Aguardando a certidão para salvar o PDF.'};
      }
      // Issuance and result controls only; no login, payment or consent actions.
      const names=host==='servicos.receitafederal.gov.br'
        ? [/^Emitir(?: Certid[aã]o)?$/i,/^(?:Baixar|Imprimir)(?: (?:PDF|Certid[aã]o))?$/i]
        : [/^(?:Obtenha o )?Certificado de Regularidade do FGTS\s*[-–—]\s*CRF$/i,/^Reimprimir Certid[aã]o$/i,/^Visualizar(?: (?:Certificado|Certid[aã]o))?$/i,/^(?:Baixar|Imprimir)(?: (?:PDF|Certid[aã]o|Certificado))?$/i,/^(?:Emitir|Emitir Certid[aã]o|Gerar Certid[aã]o|Gerar PDF|Buscar|Pesquisar|Consultar|Consultar Certid[aã]o)$/i];
      for(const name of names){
        for(const role of ['button','link']){
          const candidates=frame.getByRole(role,{name});
          for(let i=0;i<await candidates.count();i++){
            const button=candidates.nth(i);if(!await visible(button)||!await button.isEnabled())continue;
            if(!state.filled)continue;
            const href=await button.getAttribute('href');
            const caixaAction=host==='consulta-crf.caixa.gov.br'&&href?.startsWith('javascript:')&&/Obtenha|Certificado de Regularidade|Visualizar|Imprimir/.test(await button.innerText());
            if(href&&!href.startsWith('#')&&!caixaAction&&!trustedUrl(new URL(href,frame.url()).href,job.portal))continue;
            const label=(await button.innerText().catch(()=>''))||await button.getAttribute('value')||String(name);
            const base=JSON.stringify([frame.url(),label]);
            if(state.sent.has(base)&&(!security.completed||state.sent.get(base)===security.fingerprint))continue;
            const key=JSON.stringify([frame.url(),label,security.fingerprint]);
            if(state.actions.has(key))break;
            if(state.actions.size>=12)return {status:'awaiting_user',message:'O portal não concluiu a emissão após as etapas automáticas. Abra a janela do órgão para conferir a mensagem apresentada.'};
            state.actions.add(key); // A timeout can occur after a successful submission: never retry blindly.
            state.sent.set(base,security.fingerprint);
            if(host==='servicos.receitafederal.gov.br')state.federalSubmitted=true;
            await button.click({timeout:5000});
            audit({type:'automatic_issuance_attempt',cnpj:job.cnpj,jobId:job.id,portal:job.portal.key,action:label});
            return {status:'awaiting_response',message:host==='servicos.receitafederal.gov.br'?'Clique em Emitir realizado. Aguardando a verificação de segurança e a resposta da Receita.':'CNPJ preenchido e solicitação enviada ao órgão. A Central acompanha o resultado e captura o PDF automaticamente.'};
          }
        }
      }
    }
    if(blocked&&state.filled)return {status:'captcha_required',message:'CNPJ e opções disponíveis preenchidos. Clique em Mostrar janela do órgão e resolva a verificação de segurança nessa janela. A Central continuará automaticamente.'};
    if(!trusted)return {status:'awaiting_user',message:'O órgão abriu uma verificação de acesso ou página externa. Clique em Mostrar janela do órgão. A automação retomará quando o formulário oficial estiver disponível.'};
    if(Date.now()-state.started<20000||state.actions.size)return {status:'awaiting_response',message:state.actions.size?'Solicitação enviada. Aguardando o PDF ou a próxima etapa do órgão. Se houver mensagem de erro, consulte Mostrar janela do órgão.':'Aguardando o formulário do órgão carregar para preencher o CNPJ automaticamente.'};
    return {status:'awaiting_user',message:'Não foi identificado um formulário de emissão compatível nesta página. Abra Mostrar janela do órgão para verificar a navegação ou os dados adicionais solicitados.'};
  }finally{state.busy=false;}
}
module.exports={advance,prepare,challenge};
