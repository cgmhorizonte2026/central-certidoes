const { trustedUrl } = require('../config/registry');
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
function municipalLinkScore(label) {
  const text = normalize(label);
  if (/imobili|imovel|iptu|obra|nascimento|obito|casamento|autentic|validar/.test(text)) return 0;
  if (/certid(?:ao|oes)/.test(text) && /negativ|tribut|debito|contribuinte/.test(text)) return 3;
  if (/^(?:(?:emitir|emissao de)\s+)?(?:certidao|certidoes|cnd)[. →]*$/.test(text)) return 2;
  if (/portal\s*(?:do|de|\|)?\s*contribuinte|atendimento\s+sefin|servicos\s+(?:tributarios|sefin)/.test(text)) return 2;
  if (/^(?:mais )?servicos(?: online)?[. →]*$/.test(text)) return 1;
  return 0;
}
async function navigateMunicipal(frame, job, state, audit) {
  if (job.portal.key !== 'municipal' || state.filled) return null;
  const controls = frame.locator('a,button,[role="link"],[role="button"]');
  const candidates = [];
  for (let i=0;i<await controls.count();i++) {
    const control=controls.nth(i);
    if (!await control.isVisible() || !await control.isEnabled()) continue;
    const label=(await control.getAttribute('aria-label')) || await control.innerText();
    const score=municipalLinkScore(label);if(score)candidates.push({control,label,score});
  }
  candidates.sort((a,b)=>b.score-a.score);
  for (const {control,label} of candidates) {
    const href=await control.getAttribute('href');
    let target=null;
    if (href) {
      try { target=new URL(href,frame.url()); } catch { continue; }
      if (!trustedUrl(target.href,job.portal)) continue;
      if (target.href===frame.url()) continue;
    }
    const key=JSON.stringify(['municipal_navigation',frame.url(),label,target?.href]);
    if (state.actions.has(key)) continue;
    if ([...state.actions].filter(k=>k.includes('municipal_navigation')).length>=8) return {status:'awaiting_user',message:'O portal municipal exige uma etapa adicional. Confira a janela do órgão para continuar.'};
    const sourceUrl=frame.url();
    state.actions.add(key);
    await control.click({timeout:5000});
    audit({type:'municipal_navigation',jobId:job.id,portal:job.portal.key,action:label,sourceUrl,targetUrl:target?.href});
    return {status:'awaiting_response',message:`Abrindo ${label.trim()}. Acompanhando as etapas do portal municipal.`};
  }
  return null;
}
module.exports={navigateMunicipal,municipalLinkScore};
