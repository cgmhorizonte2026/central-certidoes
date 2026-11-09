const crypto = require('node:crypto');
const { trustedUrl } = require('../config/registry');
const {isoDate,today}=require('../lib/domain');
const {federalSecurityError}=require('./federal-support');
const {handleFederalCookies}=require('./federal-cookies');
const {existingFederalCertificate}=require('./federal-existing');
const {navigateMunicipal}=require('./municipal-navigation');
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

const federalCnpjField = `${editable}[name="niContribuinte"],${editable}[name="cnpj" i],${editable}[id*="cnpj" i],${editable}[placeholder*="CNPJ" i]`;
const federalParameterXPath = 'xpath=/html/body/app-root/mf-portal-layout/portal-main-layout/div/main/ng-component/ng-component/ng-component/app-informar-parametro-pj/app-informar-parametro/form/div[2]/button';
async function clickUsable(locator, timeout=4500) {
  if(!locator)return false;
  if (!await visible(locator) || !await locator.isEnabled().catch(()=>false)) return false;
  await locator.click({timeout});
  return true;
}
async function federalRoleButton(frame, names, {excludeModal=false}={}) {
  for (const name of names) {
    const items=frame.getByRole('button',{name});
    for(let i=0;i<await items.count();i++){
      const item=items.nth(i);if(!await visible(item)||!await item.isEnabled().catch(()=>false))continue;
      if(excludeModal&&await item.locator('xpath=ancestor::*[@role="dialog" or @aria-modal="true"]').count().catch(()=>0))continue;
      return item;
    }
  }
  return null;
}
async function selectFederalJuridica(frame, state, audit, job) {
  const field=frame.locator(federalCnpjField).first();
  if(await visible(field)) { state.federalPersonTypeSelected=true; return false; }
  const radio=frame.getByRole('radio',{name:/pessoa\s+jur[ií]dica/i}).first();
  if(await visible(radio)){
    if(await radio.isChecked().catch(()=>false)){state.federalPersonTypeSelected=true;return false;}
    await radio.check({timeout:4500});
    state.federalPersonTypeSelected=true;
    audit({type:'federal_person_type_selected',jobId:job.id,portal:'federal',action:'Pessoa Jurídica'});
    return true;
  }
  const label=frame.getByText(/^Pessoa\s+Jur[ií]dica$/i).first();
  if(await visible(label)){
    const clickable=label.locator('xpath=ancestor-or-self::*[self::label or self::button or @role="radio" or contains(@class,"radio") or contains(@class,"card")][1]');
    const clickableCount=await clickable.count().catch(()=>0);
    await clickUsable(clickableCount?clickable:label);
    state.federalPersonTypeSelected=true;
    audit({type:'federal_person_type_selected',jobId:job.id,portal:'federal',action:'Pessoa Jurídica'});
    return true;
  }
  return false;
}
function federalDates(text) { return [...String(text||'').matchAll(/\b(\d{2}\/\d{2}\/\d{4})\b/g)].map(m=>m[1]).map(value=>{const [,d,m,y]=value.match(/(\d{2})\/(\d{2})\/(\d{4})/),date=new Date(Date.UTC(Number(y),Number(m)-1,Number(d)));if(date.getUTCDate()!==Number(d)||date.getUTCMonth()!==Number(m)-1||date.getUTCFullYear()!==Number(y))return null;return {label:value,iso:`${y}-${m}-${d}`};}).filter(Boolean); }
async function clickNewestFederalCertificate(frame, job, state, audit) {
  const body=await frame.locator('body').innerText({timeout:2000}).catch(()=>''),normalized=body.replace(/[.\-/\s]/g,'');
  if(!normalized.includes(job.cnpj))return null;
  const rows=frame.locator('table tbody tr:visible');
  const candidates=[];
  for(let i=0;i<await rows.count();i++){
    const row=rows.nth(i),text=await row.innerText().catch(()=>''),dates=federalDates(text);
    if(/vencida|expirada|cancelada|inv[aá]lida|sem\s+validade/i.test(text))continue;
    if(!text.replace(/[.\-/\s]/g,'').includes(job.cnpj)||!dates.length)continue;
    let action=row.getByRole('button',{name:/segunda\s+via|baixar|download|emitir|visualizar|pdf/i}).first();
    let link=row.getByRole('link',{name:/segunda\s+via|baixar|download|emitir|visualizar|pdf/i}).first();
    if(!await visible(action).catch(()=>false))action=row.locator('button[title*="segunda via" i],button[aria-label*="segunda via" i],button[title*="pdf" i]').first();
    if(!await visible(link).catch(()=>false))link=row.locator('a[title*="segunda via" i],a[aria-label*="segunda via" i],a[title*="pdf" i]').first();
    const control=await visible(action)&&await action.isEnabled().catch(()=>false)?action:await visible(link)&&await link.isEnabled().catch(()=>false)?link:null;
    if(!control)continue;
    // The first date is the issue date in the Receita history table. Fall back
    // to the last date only when the row presents a single date.
    const issueDate=dates[0]; candidates.push({index:i,control,issueDate,text:text.slice(0,300)});
  }
  if(!candidates.length)return null;
  candidates.sort((a,b)=>b.issueDate.iso.localeCompare(a.issueDate.iso));
  const chosen=candidates[0],key=`federal_latest_copy:${chosen.index}:${chosen.issueDate.iso}`;
  if(state.actions.has(key))return {status:'awaiting_response',message:'A certidão federal mais recente foi solicitada; aguardando o PDF oficial.'};
  audit({type:'federal_latest_certificate_selected',jobId:job.id,cnpj:job.cnpj,portal:'federal',issuedAt:chosen.issueDate.label,row:chosen.index+1,action:'Solicitar segunda via da certidão mais recente'});
  const captured = typeof job.captureFederalAction === 'function'
    ? await job.captureFederalAction(chosen.control)
    : (await clickUsable(chosen.control), null);
  if(!captured?.captchaRequired)state.actions.add(key);
  return {status:'awaiting_response',captured,message:`Certidão federal mais recente (${chosen.issueDate.label}) selecionada. Aguardando o PDF oficial.`};
}
async function clickGeneratedFederalDocument(frame, job, state, audit) {
  if (!state.federalIssueSubmitted) return null;
  const body=await frame.locator('body').innerText({timeout:2000}).catch(()=>''), normalized=body.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if (!/certidao.{0,50}(emitida|gerada)|(?:emitida|gerada).{0,50}certidao|emissao.{0,30}concluida/.test(normalized)) return null;
  const nodes=frame.locator('button,a,[role="button"],input[type="button"],input[type="submit"]');
  const candidates=[];
  for(let i=0;i<Math.min(await nodes.count(),120);i++){
    const element=nodes.nth(i);if(!await visible(element)||!await element.isEnabled().catch(()=>false))continue;
    const info=await element.evaluate(el=>({text:(el.innerText||el.value||el.getAttribute('aria-label')||'').trim(),title:el.title||'',href:el.href||'',context:(el.closest('tr,section,main,[role="dialog"]')||el.parentElement)?.innerText||''})).catch(()=>null);
    if(!info)continue;
    const label=`${info.text} ${info.title} ${info.href}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const context=info.context.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    if(!/pdf|baixar|download|imprimir|visualizar/.test(label)||!(/certidao|documento/.test(context)||/\.pdf(?:$|[?#])/.test(info.href)))continue;
    candidates.push({element,label});
  }
  if(!candidates.length)return {status:'awaiting_response',message:'A Receita confirmou a emissão. Aguardando o botão ou arquivo PDF do documento.'};
  const key=`federal_new_document:${frame.url()}:${candidates[0].label}`;
  if(state.actions.has(key))return {status:'awaiting_response',message:'A certidão foi emitida; aguardando a resposta de download oficial.'};
  audit({type:'federal_generated_certificate_detected',jobId:job.id,cnpj:job.cnpj,portal:'federal',action:'Capturar PDF da certidão recém-emitida'});
  const captured=typeof job.captureFederalAction==='function'?await job.captureFederalAction(candidates[0].element):((await clickUsable(candidates[0].element)),null);
  if(captured?.download||captured?.pdfBuffer)return {status:'awaiting_response',captured,message:'PDF da certidão recém-emitida recebido da Receita.'};
  state.actions.add(key);
  return {status:'awaiting_response',message:'Certidão emitida; aguardando o PDF oficial.'};
}
async function advanceFederal(frame,job,state,audit) {
  if(new URL(frame.url()).hostname!=='servicos.receitafederal.gov.br')return null;
  // The current Receita SPA starts on a person-type choice. Do not infer that
  // the generic CNPJ field is ready until the PJ selection has been applied.
  const selected=await selectFederalJuridica(frame,state,audit,job);
  if(selected)return {status:'awaiting_response',message:'Pessoa Jurídica selecionada. Aguardando o formulário federal para informar o CNPJ.'};
  const cookies=await handleFederalCookies(frame,job,audit);
  if(cookies)return cookies;

  const validNotice=frame.getByText(/Certidão\s+Válida\s+Encontrada/i).first();
  if(await visible(validNotice)){
    const dialog=frame.locator('[role="dialog"],[aria-modal="true"],dialog').filter({hasText:/Certidão\s+Válida\s+Encontrada/i}).first();
    const scope=await visible(dialog)?dialog:frame;
    const consult=await federalRoleButton(scope,[/^Consultar Certidão$/i]);
    const key='federal_consult_existing';
    if(!state.actions.has(key)&&await clickUsable(consult)){
      state.actions.add(key);state.federalPhase='existing-history';state.federalExistingHistoryOpened=true;
      audit({type:'federal_existing_certificates_opened',jobId:job.id,cnpj:job.cnpj,portal:'federal',action:'Consultar Certidão'});
      return {status:'awaiting_response',message:'A Receita encontrou uma certidão existente. Abrindo o histórico para selecionar a mais recente.'};
    }
    // A valid-certificate prompt is a strict decision point. Never fall through
    // to the generic "Emitir nova certidão" button if history is still loading.
    return {status:'awaiting_response',message:'A Receita encontrou uma certidão válida. Aguardando a opção oficial para consultar a segunda via.'};
  }

  if(state.federalExistingHistoryOpened){
    const existing=await existingFederalCertificate(frame,job,state,audit);
    if(existing){
      if(existing.captured?.captchaRequired)return existing;
      return existing;
    }
  }

  const generated=await clickGeneratedFederalDocument(frame,job,state,audit);
  if(generated)return generated;
  const latest=await clickNewestFederalCertificate(frame,job,state,audit);
  if(latest)return latest;

  const filled=await fillFirst(frame,[federalCnpjField],job.cnpj);
  if(filled){state.filled=true;state.federalCnpjConfirmed=true;}
  if(!state.filled)return null;

  // The first control in the real action row is “Consultar Certidão”; it can
  // return portal response 023 without issuing. The intended new-issuance CTA
  // is the distinct semantic button “Emitir Certidão”. Never select the
  // unrelated “Consulte certidões mais antigas” link.
  const collection=frame.locator('app-coleta-parametros-pj');
  const collectionVisible=await visible(collection);
  if(!state.actions.has('federal_issue_request')){
    const issue=await federalRoleButton(collectionVisible?collection:frame,[/^Emitir Certidão$/i]);
    if(issue&&await visible(issue)&&await issue.isEnabled().catch(()=>false)){
      const controlEvidence=await issue.evaluate(el=>({tag:el.tagName.toLowerCase(),id:el.id||'',className:typeof el.className==='string'?el.className:'',type:el.getAttribute('type')||'',text:(el.innerText||el.value||el.getAttribute('aria-label')||'').trim()})).catch(()=>({}));
      const actionLabel=String(controlEvidence.text||'').replace(/\s+/g,' ').trim();
      if(!/^Emitir Certidão$/i.test(actionLabel))return null;
      state.actions.add('federal_issue_request');state.federalPhase='issue-requested';state.federalSubmitted=true;state.federalIssueSubmitted=true;state.federalSubmittedAt=Date.now();
      audit({type:'federal_action_selected',jobId:job.id,portal:'federal',action:actionLabel,selector:'role=button[name="Emitir Certidão", exact=true]',element:controlEvidence,url:frame.url()});
      let postEmitSnapshotLogged=false;
      const captured=typeof job.captureFederalAction==='function'
        ? await job.captureFederalAction(issue,{stopWhen:async()=>{
          const text=await frame.locator('body').innerText().catch(()=>''),terminal=/Certidão\s+Válida\s+Encontrada|certid[aã]o.{0,50}(?:emitida|gerada)|(?:emitida|gerada).{0,50}certid[aã]o/i.test(text);
          if(!postEmitSnapshotLogged&&Date.now()-state.federalSubmittedAt>750){postEmitSnapshotLogged=true;audit({type:'federal_post_emit_page_state',jobId:job.id,portal:'federal',url:frame.url(),text:text.slice(0,1200),terminal});}
          return terminal;
        }})
        : (await clickUsable(issue), null);
      audit({type:'federal_issue_requested',jobId:job.id,cnpj:job.cnpj,portal:'federal',action:actionLabel});
      return {status:'awaiting_response',captured,message:`${actionLabel} solicitado. Verificando se a Receita encontrou uma certidão válida ou gerou um novo documento.`};
    }
  }

  // Stage 2: the Receita SPA can ask for a parameter in a separate component.
  // Restrict the second click to that component and to an enabled, meaningful
  // action. The same XPath is reevaluated after every DOM transition.
  const parameter=frame.locator('app-informar-parametro-pj');
  if(await visible(parameter)){
    const body=await parameter.innerText().catch(()=>''),fingerprint=crypto.createHash('sha1').update(body).digest('hex').slice(0,12),key=`federal_parameter:${fingerprint}`;
    if(!state.actions.has(key)){
      let next=frame.locator(federalParameterXPath);
      if(!await visible(next)||!await next.isEnabled().catch(()=>false))next=await federalRoleButton(parameter,[/consultar|continuar|prosseguir|emitir|gerar/i]);
      if(next&&await clickUsable(next)){
        state.actions.add(key);state.federalPhase='parameter-submitted';state.federalSubmittedAt=Date.now();
        audit({type:'federal_parameter_submitted',jobId:job.id,cnpj:job.cnpj,portal:'federal',action:'Prosseguir com o parâmetro informado'});
        return {status:'awaiting_response',message:'Parâmetro informado à Receita. Analisando a lista de certidões disponíveis.'};
      }
    }
  }

  return null;
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
      if(job.portal.key==='federal'){
        const federal=await advanceFederal(frame,job,state,audit);
        if(federal)return federal;
      }
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
      const navigation=await navigateMunicipal(frame,job,state,audit);
      if(navigation)return navigation;
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
            if(host==='servicos.receitafederal.gov.br'){state.federalSubmitted=true;state.federalSubmittedAt=Date.now();}
            await button.click({timeout:5000});
            audit({type:'automatic_issuance_attempt',cnpj:job.cnpj,jobId:job.id,portal:job.portal.key,action:label});
            return {status:'awaiting_response',message:host==='servicos.receitafederal.gov.br'?'Clique em Emitir realizado. Aguardando a verificação de segurança e a resposta da Receita.':'CNPJ preenchido e solicitação enviada ao órgão. A Central acompanha o resultado e captura o PDF automaticamente.'};
          }
        }
      }
    }
    if(blocked&&state.filled)return {status:'captcha_required',message:'CNPJ e opções disponíveis preenchidos. Clique em Abrir janela interativa e resolva a verificação de segurança no painel da Central. A Central continuará automaticamente.'};
    if(!trusted)return {status:'awaiting_user',message:'O órgão abriu uma verificação de acesso ou página externa. Clique em Abrir janela interativa. A automação retomará quando o formulário oficial estiver disponível.'};
    if(Date.now()-state.started<20000||state.actions.size)return {status:'awaiting_response',message:state.actions.size?'Solicitação enviada. Aguardando o PDF ou a próxima etapa do órgão. Se houver mensagem de erro, consulte Abrir janela interativa.':'Aguardando o formulário do órgão carregar para preencher o CNPJ automaticamente.'};
    return {status:'awaiting_user',message:'Não foi identificado um formulário de emissão compatível nesta página. Abra Abrir janela interativa para verificar a navegação ou os dados adicionais solicitados.'};
  }finally{state.busy=false;}
}
module.exports={advance,prepare,challenge,advanceFederal,clickNewestFederalCertificate};
