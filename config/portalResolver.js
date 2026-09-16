const basePortals = require('./portals');
const { states, municipal } = require('./registry');

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const municipalityCodes = new Map(Object.entries(municipal).map(([code, portal]) => [normalize(portal.name.replace(/^Municipal\s*·\s*/, '')), code]));
const selectors = { cnpj: ['input[name*="cnpj" i]','input[id*="cnpj" i]','input[placeholder*="CNPJ" i]','input[name*="cpfcnpj" i]','input[id*="cpfcnpj" i]','input[maxlength="14"]','input[maxlength="18"]'] };

function statePortal(company) {
  const uf = String(company?.uf || '').toUpperCase(), entry = states[uf];
  if (!entry) return null;
  if (uf === 'CE') return basePortals.find(portal => portal.key === 'estadual-ce');
  if (uf === 'SP') return {
    key:'estadual-sp', name:'Certidão Estadual — São Paulo', shortName:'Estadual SP', url:entry[1], verifyUrl:entry[1],
    selectors:{cnpj:['#MainContent_txtDocumento','input[name="ctl00$MainContent$txtDocumento"]']},
    preActions:[{name:'Selecionar CNPJ',selectors:['#MainContent_cnpjradio','input[value="cnpjradio"]'],waitMs:500,required:true}],
    humanCaptcha:'required', captchaTimeout:600000, beforeCaptchaActions:[],
    afterCaptchaActions:[{name:'Emitir eCND',selectors:['#MainContent_btnPesquisar','input[name="ctl00$MainContent$btnPesquisar"]','input[value*="Emitir" i]'],captureDownload:true,downloadTimeout:30000,waitMs:1800}],
    downloadButtons:['text=Baixar','text=Download','text=Imprimir','text=PDF']
  };
  return { key:`estadual-${uf.toLowerCase()}`, name:`Certidão Estadual — ${entry[0]}`, shortName:`Estadual ${uf}`, url:entry[1], verifyUrl:entry[1], selectors, humanCaptcha:false, beforeCaptchaActions:[], afterCaptchaActions:[], downloadButtons:['text=Emitir Certidão','text=Emitir CND','text=Certidão Negativa','text=Imprimir','text=Baixar','text=Download','text=PDF'] };
}

function municipalPortal(company) {
  const code = String(company?.municipio_codigo_ibge || company?.codigo_municipio_ibge || '') || municipalityCodes.get(normalize(company?.municipio));
  const entry = municipal[code];
  if (!entry) return null;
  if (code === '2300507') return {
    key:'municipal', name:'Municipal · Alcântaras', shortName:'Municipal', url:entry.url,
    verifyUrl:entry.verifyUrl, selectors:{cnpj:['input[name="cpfCnpj"]','input[id$="_cpfCnpj"]']},
    humanCaptcha:false, preActions:[], beforeCaptchaActions:[],
    afterCaptchaActions:[{name:'Realizar Consulta',selectors:['button[type="submit"]:has-text("Realizar Consulta")','button:has-text("Realizar Consulta")'],captureDownload:true,downloadTimeout:15000,waitMs:1800}],
    downloadButtons:['text=Reimprimir Certidão','text=Imprimir','text=Baixar','text=Download','text=PDF']
  };
  if (code === '2304400') return {
    key:'municipal', name:'Municipal · Fortaleza', shortName:'Municipal', url:entry.url,
    verifyUrl:entry.verifyUrl || entry.sourceUrl || entry.url,
    selectors:{cnpj:['#pesquisaForm\\:cnpjPessoaDec\\:cnpj','input[name="pesquisaForm:cnpjPessoaDec:cnpj"]','input[alt="cnpj" i]']},
    preActions:[{name:'Selecionar Pessoa Jurídica / CNPJ',selectors:['#pesquisaForm\\:tipoPessoaDecorate\\:j_id358\\:1','input[name="pesquisaForm:tipoPessoaDecorate:j_id358"][value="J"]','label:has-text("Jurídica")'],waitMs:1800,required:true}],
    humanCaptcha:'required', captchaTimeout:600000, beforeCaptchaActions:[],
    afterCaptchaActions:[{name:'Emitir Certidão Municipal',selectors:['#pesquisaForm\\:btnEmitir','input[name="pesquisaForm:btnEmitir"]','input[value="Emitir"]'],captureDownload:true,downloadTimeout:5000,waitMs:1200}],
    existingCertificate:{container:'form#modalReimpressaoForm',reprintSelectors:['form#modalReimpressaoForm input[value*="Reimprimir Certid" i]','form#modalReimpressaoForm input[type="submit"]','text=Reimprimir Certidão']},
    downloadButtons:['input[value*="Reimprimir Certid" i]','text=Reimprimir Certidão','text=Baixar','text=Download','text=Imprimir','text=PDF']
  };
  const preActions = code === '2305233' ? [{ name:'Abrir Certidão de Contribuinte', selectors:['a:has-text("Certidão de Contribuinte")','text=Certidão de Contribuinte'], waitMs:1500, required:true }] : [];
  return { key:'municipal', name:entry.name, shortName:'Municipal', url:entry.url, verifyUrl:entry.verifyUrl || entry.sourceUrl || entry.url, selectors, humanCaptcha:false, preActions, beforeCaptchaActions:[], afterCaptchaActions:[], downloadButtons:['text=Emitir certidões','text=Emitir CND','text=Certidão Negativa','text=Imprimir','text=Baixar','text=PDF'] };
}

function discoveredMunicipalPortal(company, record) {
  if (!record || record.status !== 'PORTAL_ENCONTRADO') return null;
  const common={key:'municipal',name:`Municipal · ${company.municipio}`,shortName:'Municipal',url:record.certidao_url,verifyUrl:record.certidao_url,provider:record.provider,resolutionStatus:record.status,sourceUrl:record.fonte};
  if(record.provider==='fisco-web')return {...common,selectors:{cnpj:['#cnpjcpf','input[name="cpf_cnpj"]','input[placeholder*="CPF/CNPJ" i]']},preActions:[{name:'Selecionar Certidão de Contribuinte',selectors:['input[name="tipo_certidao"][value="contribuinte"]','label:has-text("Certidão negativa/positiva de Contribuinte")'],required:true,waitMs:500}],humanCaptcha:false,beforeCaptchaActions:[],afterCaptchaActions:[{name:'Emitir Certidão',selectors:['button[type="submit"]:has-text("Emitir Certidão")','button:has-text("Emitir Certidão")'],captureDownload:true,downloadTimeout:20000,waitMs:1500}],downloadButtons:['text=Baixar','text=Imprimir','text=Download','text=PDF']};
  if(record.provider==='trimap')return {...common,selectors:{cnpj:['input[name="cpfCnpj"]','input[id$="_cpfCnpj"]']},humanCaptcha:false,preActions:[],beforeCaptchaActions:[],afterCaptchaActions:[{name:'Realizar Consulta',selectors:['button:has-text("Realizar Consulta")'],captureDownload:true,downloadTimeout:15000,waitMs:1800}],downloadButtons:['text=Reimprimir Certidão','text=Imprimir','text=Baixar','text=PDF']};
  return {...common,selectors,humanCaptcha:false,preActions:[],beforeCaptchaActions:[],afterCaptchaActions:[],downloadButtons:['text=Emitir Certidão','text=Emitir CND','text=Consultar','text=Imprimir','text=Baixar','text=PDF']};
}

function portalsForCompany(company) {
  return [...basePortals.filter(portal => !portal.key.startsWith('estadual-')), statePortal(company), municipalPortal(company)].filter(Boolean);
}

function portalForCertificate(company, certificateKey) {
  return portalsForCompany(company).find(portal => (portal.key.startsWith('estadual-') ? 'ceara' : portal.key) === certificateKey) || null;
}

async function resolvePortalsForCompany(company,{municipalResolver}={}){
  const known=municipalPortal(company);let municipalResolved=null,resolution={status:'PORTAL_EM_DESCOBERTA'};
  if(municipalResolver){resolution=await municipalResolver.resolve(company);municipalResolved=discoveredMunicipalPortal(company,resolution);}
  if(!municipalResolved&&known){municipalResolved=known;resolution={...resolution,status:'PORTAL_ENCONTRADO',provider:'registry',certidao_url:known.url,fonte:'cadastro legado',confianca:'cadastro_legado'};}
  return {portals:[...basePortals.filter(portal=>!portal.key.startsWith('estadual-')),statePortal(company),municipalResolved].filter(Boolean),municipalResolution:resolution};
}

module.exports = { portalsForCompany, portalForCertificate, resolvePortalsForCompany, discoveredMunicipalPortal, statePortal, municipalPortal };
