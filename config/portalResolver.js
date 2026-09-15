const basePortals = require('./portals');
const { states, municipal } = require('./registry');

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const municipalityCodes = new Map(Object.entries(municipal).map(([code, portal]) => [normalize(portal.name.replace(/^Municipal\s*·\s*/, '')), code]));
const selectors = { cnpj: ['input[name*="cnpj" i]','input[id*="cnpj" i]','input[placeholder*="CNPJ" i]','input[name*="cpfcnpj" i]','input[id*="cpfcnpj" i]','input[maxlength="14"]','input[maxlength="18"]'] };

function statePortal(company) {
  const uf = String(company?.uf || '').toUpperCase(), entry = states[uf];
  if (!entry) return null;
  if (uf === 'CE') return basePortals.find(portal => portal.key === 'estadual-ce');
  return { key:`estadual-${uf.toLowerCase()}`, name:`Certidão Estadual — ${entry[0]}`, shortName:`Estadual ${uf}`, url:entry[1], verifyUrl:entry[1], selectors, humanCaptcha:false, beforeCaptchaActions:[], afterCaptchaActions:[], downloadButtons:['text=Emitir Certidão','text=Emitir CND','text=Certidão Negativa','text=Imprimir','text=Baixar','text=Download','text=PDF'] };
}

function municipalPortal(company) {
  const code = String(company?.municipio_codigo_ibge || company?.codigo_municipio_ibge || '') || municipalityCodes.get(normalize(company?.municipio));
  const entry = municipal[code];
  if (!entry) return null;
  const preActions = code === '2305233' ? [{ name:'Abrir Certidão de Contribuinte', selectors:['a:has-text("Certidão de Contribuinte")','text=Certidão de Contribuinte'], waitMs:1500, required:true }] : [];
  return { key:'municipal', name:entry.name, shortName:'Municipal', url:entry.url, verifyUrl:entry.verifyUrl || entry.sourceUrl || entry.url, selectors, humanCaptcha:false, preActions, beforeCaptchaActions:[], afterCaptchaActions:[], downloadButtons:['text=Emitir certidões','text=Emitir CND','text=Certidão Negativa','text=Imprimir','text=Baixar','text=PDF'] };
}

function portalsForCompany(company) {
  return [...basePortals.filter(portal => !portal.key.startsWith('estadual-')), statePortal(company), municipalPortal(company)].filter(Boolean);
}

module.exports = { portalsForCompany, statePortal, municipalPortal };
