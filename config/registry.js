// Routing data never proves authenticity. Generic connectors require assistance.
const states = {
  AC: ['Acre', 'https://sefaz.ac.gov.br/'], AL: ['Alagoas', 'https://contribuinte.sefaz.al.gov.br/certidao/'],
  AP: ['Amapá', 'https://www.sefaz.ap.gov.br/'], AM: ['Amazonas', 'https://www.sefaz.am.gov.br/portfolio-servicos/detalhes/541'],
  BA: ['Bahia', 'https://www.sefaz.ba.gov.br/'], CE: ['Ceará', 'https://consultapublica.sefaz.ce.gov.br/certidaonegativa/preparar-consultar'],
  DF: ['Distrito Federal', 'https://ww1.receita.fazenda.df.gov.br/cidadao/certidoes/Certidao'], ES: ['Espírito Santo', 'https://s2-internet.sefaz.es.gov.br/certidao/cnd'],
  GO: ['Goiás', 'https://goias.gov.br/economia/certidao-negativa-de-debito/'], MA: ['Maranhão', 'https://sistemas1.sefaz.ma.gov.br/portalsefaz/jsp/principal/principal.jsf'],
  MT: ['Mato Grosso', 'https://www.sefaz.mt.gov.br/'], MS: ['Mato Grosso do Sul', 'https://www.sefaz.ms.gov.br/'],
  MG: ['Minas Gerais', 'https://www.fazenda.mg.gov.br/'], PA: ['Pará', 'https://www.sefa.pa.gov.br/'],
  PB: ['Paraíba', 'https://www.sefaz.pb.gov.br/'], PR: ['Paraná', 'https://www.fazenda.pr.gov.br/'],
  PE: ['Pernambuco', 'https://www.sefaz.pe.gov.br/'], PI: ['Piauí', 'https://www.sefaz.pi.gov.br/'],
  RJ: ['Rio de Janeiro', 'https://portal.fazenda.rj.gov.br/'], RN: ['Rio Grande do Norte', 'https://www.sefaz.rn.gov.br/'],
  RS: ['Rio Grande do Sul', 'https://receita.fazenda.rs.gov.br/'], RO: ['Rondônia', 'https://portalcontribuinte.sefin.ro.gov.br/Publico/certidaoNegativa.jsp'],
  RR: ['Roraima', 'https://www.sefaz.rr.gov.br/'], SC: ['Santa Catarina', 'https://www.sef.sc.gov.br/'],
  SP: ['São Paulo', 'https://www10.fazenda.sp.gov.br/CertidaoNegativaDeb/Pages/EmissaoCertidaoNegativa.aspx'],
  SE: ['Sergipe', 'https://www.sefaz.se.gov.br/'], TO: ['Tocantins', 'https://www.to.gov.br/sefaz']
};
Object.assign(states,{
 AC:['Acre','https://sefaz.ac.gov.br/2021/?p=322'],
 AP:['Amapá','https://virtual.sefaz.ap.gov.br/portal/'],
 BA:['Bahia','https://www.sefaz.ba.gov.br/inspetoria-eletronica/icms/certidoes/informacoes/'],
 RR:['Roraima','https://www.sefaz.rr.gov.br/'],
 SC:['Santa Catarina','https://www.sef.sc.gov.br/servicos/assunto/25/Certid%C3%A3o_Negativa_de_D%C3%A9bitos'],
 TO:['Tocantins','https://portal.sefaz.to.gov.br/debitos-fiscais']
});
const directStates = new Set(['AC','AL','AM','BA','CE','DF','ES','GO','RO','SC','SP','TO']);
const national = [
  { key: 'federal', kind: 'federal', name: 'Federal · Receita Federal / PGFN', url: 'https://servicos.receitafederal.gov.br/servico/certidoes/#/home/cnpj', verifyUrl: 'https://solucoes.receita.fazenda.gov.br/Servicos/certidao/certaut/NIAutentic.asp?origem=pj', allowedHosts: ['servicos.receitafederal.gov.br','solucoes.receita.fazenda.gov.br','servicos.receita.fazenda.gov.br'], sourceUrl: 'https://www.gov.br/pt-br/servicos/emitir-certidao-de-regularidade-fiscal' },
  { key: 'fgts', kind: 'fgts', name: 'FGTS · Caixa Econômica Federal', url: 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf', verifyUrl: 'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf', allowedHosts: ['consulta-crf.caixa.gov.br'], sourceUrl: 'https://www.fgts.gov.br/Paginas/empregador/certificado-de-regularidade-do-fgts-crf.aspx' },
  { key: 'trabalhista', kind: 'trabalhista', name: 'Trabalhista · TST', url: 'https://cndt-certidao.tst.jus.br/', verifyUrl: 'https://cndt-certidao.tst.jus.br/consultarCertidao', allowedHosts: ['www.tst.jus.br','cndt-certidao.tst.jus.br'], sourceUrl: 'https://www.tst.jus.br/web/acesso-a-informacao/carta-de-servicos-a-cidadania/servicos-processuais/cndt' }
].map(p => ({ ...p, coverage: 'portal_identificado', mode: 'assistido', required: true }));
const municipal = {
  '2300507': { name:'Municipal · Alcântaras',municipalityCode:'2300507',url:'https://servicostrimap.com.br/alcantaras.ce/cnd/contribuinte/',verifyUrl:'https://servicostrimap.com.br/alcantaras.ce/validar-cnd/',sourceUrl:'https://www.alcantaras.ce.gov.br/cartadeservicos',allowedHosts:['www.alcantaras.ce.gov.br','alcantaras.ce.gov.br','servicostrimap.com.br'],coverage:'portal_identificado',reviewedAt:'2026-09-15',review:'Emissão de Certidão Municipal vinculada no site oficial da Prefeitura de Alcântaras.' },
  '2304285': { name:'Municipal · Eusébio', municipalityCode:'2304285', url:'https://gpi.eusebio.ce.gov.br/ServerExec/acessoBase/?idPortal=29b1b7da-7c90-43e3-8817-64373eedc7f1', sourceUrl:'https://eusebio.ce.gov.br/', allowedHosts:['eusebio.ce.gov.br','www.eusebio.ce.gov.br','gpi.eusebio.ce.gov.br'], coverage:'portal_identificado', reviewedAt:'2026-09-11', review:'Link Portal do Contribuinte publicado no site da prefeitura; emissão integral ainda não homologada.' },
  '2313906': { name:'Municipal · Uruoca', url:'https://uruoca.ssinformatica.net/portal/web/certidao/contribuinte/documento', verifyUrl:'https://uruoca.ssinformatica.net/portal/web/validar_documentos/certidao', sourceUrl:'https://www.uruoca.ce.gov.br/', allowedHosts:['www.uruoca.ce.gov.br','uruoca.ce.gov.br','uruoca.ssinformatica.net'], coverage:'portal_identificado', reviewedAt:'2026-09-10' },
  '3550308': { name: 'Municipal · São Paulo', url: 'https://www.prefeitura.sp.gov.br/web/fazenda/w/servicos/certidoes/2394', sourceUrl: 'https://www.prefeitura.sp.gov.br/web/fazenda/w/servicos/certidoes/2394', allowedHosts: ['www.prefeitura.sp.gov.br','www3.prefeitura.sp.gov.br','www2.prefeitura.sp.gov.br','capital.sp.gov.br'] },
  '2304400': { name:'Municipal · Fortaleza',url:'https://grpfordam.sefin.fortaleza.ce.gov.br/grpfor/pagesPublic/certidoes/emitirCertidao.seam',verifyUrl:'https://servicossite.sefin.fortaleza.ce.gov.br/validacao-de-certidao',sourceUrl:'https://cartadeservicos.sefin.fortaleza.ce.gov.br/',allowedHosts:['grpfordam.sefin.fortaleza.ce.gov.br','servicossite.sefin.fortaleza.ce.gov.br'] },
  '2305233': { name:'Municipal · Horizonte',municipalityCode:'2305233',url:'https://tributario.speedgov.com.br/horizonte/servicos/certidoes',verifyUrl:'https://servicos2.speedgov.com.br/horizonte/validacao/cnd',sourceUrl:'https://www.horizonte.ce.gov.br/servicos.php',allowedHosts:['www.horizonte.ce.gov.br','servicos2.speedgov.com.br','tributario.speedgov.com.br'],coverage:'portal_identificado',reviewedAt:'2026-09-15',review:'Fornecedor vinculado pela página oficial de serviços; redirecionamento para tributario.speedgov.com.br confirmado. Emissão integral ainda não homologada.' },
  '3509502': { name:'Municipal · Campinas',url:'https://portal-adm.campinas.sp.gov.br/servico/certidoes-secretaria-de-financas',sourceUrl:'https://portal-adm.campinas.sp.gov.br/servico/certidoes-secretaria-de-financas',allowedHosts:['portal-adm.campinas.sp.gov.br','novo.campinas.sp.gov.br'],coverage:'diretorio_oficial' }
};
function routesFor(company, store) {
  const result = national.map(p => ({ ...p })); const state = states[company.uf];
  if (!state) throw new Error('UF desconhecida no cadastro.');
  result.push({ key: 'estadual', kind: 'estadual', name: `Estadual · ${state[0]}`, url: state[1], verifyUrl: state[1], allowedHosts: [new URL(state[1]).hostname], coverage: directStates.has(company.uf) ? 'portal_identificado' : 'diretorio_oficial', mode: 'assistido', required: true, sourceUrl: state[1] });
  if (company.uf === 'SP') result.push({ key: 'estadual-divida-ativa', kind: 'estadual', name: 'Estadual SP · Dívida ativa (PGE)', url: 'https://www.dividaativa.pge.sp.gov.br/', verifyUrl: 'https://www.dividaativa.pge.sp.gov.br/', allowedHosts: ['www.dividaativa.pge.sp.gov.br'], coverage: 'diretorio_oficial', mode: 'assistido', required: true, sourceUrl: 'https://portal.fazenda.sp.gov.br/servicos/certidoes/Paginas/Sobre.aspx' });
  if (company.uf === 'DF') result.push({ key: 'municipal', kind: 'municipal', name: 'Municipal · Distrito Federal', required: false, coverage: 'nao_aplicavel_df', mode: 'dispensado', note: 'Fluxo distrital: certidão tributária do DF no cartão estadual.' });
  else {
    const saved = store?.get('portal', company.municipalityCode);
    const m = saved?.registeredBy==='descoberta_por_ibge' && municipal[company.municipalityCode] ? municipal[company.municipalityCode] : saved || municipal[company.municipalityCode];
    result.push({ key: 'municipal', kind: 'municipal', name: `Municipal · ${company.municipality}/${company.uf}`, required: true, mode: m ? 'assistido' : 'sem_integracao', coverage: m ? 'portal_identificado' : 'nao_cadastrado', ...m, verifyUrl: m?.verifyUrl || null });
  }
  return result.map(p=>{const target=p.key==='estadual'?`estadual:${company.uf}`:p.key;const override=store?.get('portal_override',target);return override?{...p,...override}:p;});
}
function trustedUrl(url, portal) { try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && portal.allowedHosts?.includes(u.hostname); } catch { return false; } }
module.exports = { states, national, municipal, routesFor, trustedUrl };
