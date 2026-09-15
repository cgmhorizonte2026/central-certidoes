// Only the cookie notice observed on the Receita issuance portal, never general agreements.
async function handleFederalCookies(frame, job, audit = () => {}) {
  if (new URL(frame.url()).hostname !== 'servicos.receitafederal.gov.br') return null;
  const card = frame.locator('#card0').filter({ hasText: /utilizamos cookies/i });
  if (!await card.isVisible().catch(() => false)) return null;
  const accept = card.getByRole('button', { name: 'Aceitar', exact: true });
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
