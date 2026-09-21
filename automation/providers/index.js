// Provider pipeline for discovered municipal portals. Provider behavior is
// shared by municipalities; municipality records only supply the URL/source.
function detectProvider({ url = '', html = '', scripts = '' } = {}) {
  const haystack = `${url}\n${html}\n${scripts}`.toLowerCase();
  if (/speedgov/.test(haystack)) return 'speedgov';
  if (/trimap|servicostrimap/.test(haystack)) return 'trimap';
  if (/ssinformatica|ss informática/.test(haystack)) return 'ss-informatica';
  if (/fisco-web|fiscoweb/.test(haystack)) return 'fisco-web';
  return 'unknown';
}

function speedGovAdapter(common, selectors) {
  return {
    ...common,
    adapter: 'SpeedGovAdapter',
    selectors: { cnpj: ['#dados_documento', 'input[name="dados[documento]"]', ...selectors.cnpj] },
    humanCaptcha: 'required',
    preActions: [
      { name: 'Emitir CND', selectors: ['a:has-text("Emitir CND")', 'button:has-text("Emitir CND")'], required: true, waitMs: 1200 },
      { name: 'Selecionar Contribuinte', selectors: ['a:has-text("Contribuinte")', 'button:has-text("Contribuinte")'], required: true, waitMs: 1200 }
    ],
    beforeCaptchaActions: [],
    afterCaptchaActions: [{
      name: 'Consultar certidão',
      selectors: ['#gerar_certidao', 'input[type="submit"][name="commit"][value*="Consultar" i]', 'button:has-text("Consultar")'],
      captureDownload: true,
      downloadTimeout: 30000,
      waitMs: 2200
    }],
    downloadButtons: ['a[href*="impressao" i]', 'a:has-text("Imprimir")', 'text=Imprimir', 'text=Emitir Certidão', 'text=Emitir CND', 'text=Baixar', 'text=PDF']
  };
}

function adapterFor(provider, common, selectors) {
  if (provider === 'speedgov') return speedGovAdapter(common, selectors);
  return null;
}

module.exports = { detectProvider, adapterFor, speedGovAdapter };
