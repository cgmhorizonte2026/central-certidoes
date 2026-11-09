// Only the cookie notice observed on the Receita issuance portal, never general agreements.
async function handleFederalCookies(frame, job, audit = () => {}) {
  if (new URL(frame.url()).hostname !== 'servicos.receitafederal.gov.br') return null;
  // The consent banner may be shown before the CNPJ form or after the first
  // consultation. Restrict the click to a visible container that explicitly
  // describes cookies; never click an unrelated "Aceitar" control.
  const candidates = frame.locator('#card0,[role="dialog"],[aria-modal="true"],.modal,.br-modal,section,div');
  let card = null, cardTextLength = Infinity;
  for (let i = 0, n = await candidates.count(); i < n; i++) {
    const candidate = candidates.nth(i);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const text = await candidate.innerText().catch(() => '');
    if (!/cookies?/i.test(text) || !/aceit|prefer[eê]ncias|privacidade/i.test(text)) continue;
    const accept = candidate.getByRole('button', { name: /^(?:aceitar|aceitar todos|aceitar cookies)$/i }).first();
    if (!await accept.isVisible().catch(() => false)) continue;
    // Choose the smallest matching container to avoid an unrelated "Aceitar"
    // button elsewhere on a page that also mentions cookie preferences.
    if(text.length<cardTextLength){card=candidate;cardTextLength=text.length;}
  }
  if (!card) return null;
  const accept = card.getByRole('button', { name: /^(?:aceitar|aceitar todos|aceitar cookies)$/i }).first();
  const pending = { status: 'awaiting_user', message: 'O aviso de cookies da Receita está aberto. Aceite os cookies na janela do órgão para continuar.' };
  if (!await accept.isVisible().catch(() => false) || !await accept.isEnabled()) return pending;
  try {
    await accept.click({ timeout: 2500 });
    await card.waitFor({ state: 'hidden', timeout: 2500 });
  } catch { return pending; }
  audit({ type: 'federal_cookie_notice_accepted', jobId: job.id, portal: job.portal.key, action: 'Aceitar aviso de cookies da Receita' });
  return { status: 'awaiting_response', message: 'Aviso de cookies da Receita aceito. Continuando a consulta automaticamente.' };
}
module.exports = { handleFederalCookies };
