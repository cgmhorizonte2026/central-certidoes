const { normalizeCnpj, validCnpj, plain } = require('./domain');
async function jsonFetch(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json', 'User-Agent': 'CentralCertidoes/3.0' } });
  if (!r.ok) throw new Error(`Fonte cadastral indisponível (HTTP ${r.status}). Tente novamente.`);
  return r.json();
}
async function lookupCompany(input, store) {
  const cnpj = normalizeCnpj(input);
  if (!validCnpj(cnpj)) throw Object.assign(new Error('CNPJ inválido: confira os caracteres e os dígitos verificadores.'), { status: 400 });
  const sources = [
    {name:'BrasilAPI',url:`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, map:x=>x},
    {name:'Minha Receita',url:`https://minhareceita.org/${cnpj}`,map:x=>x},
    {name:'ReceitaWS (cache público)',url:`https://www.receitaws.com.br/v1/cnpj/${cnpj}`,map:x=>({...x,razao_social:x.nome,nome_fantasia:x.fantasia,descricao_situacao_cadastral:x.situacao})}
  ];
  let data, selected; const failures=[];
  for(const source of sources){try{const raw=await jsonFetch(source.url);const mapped=source.map(raw);if(normalizeCnpj(mapped.cnpj)!==cnpj||!mapped.uf||!mapped.razao_social)throw new Error('Cadastro não localizado na fonte.');data=mapped;selected=source;break;}catch(e){failures.push(`${source.name}: ${e.message}`);}}
  if(!data) throw new Error('Nenhuma fonte cadastral respondeu com dados válidos. '+failures.join(' '));
  const sourceUrl=selected.url;
  if (normalizeCnpj(data.cnpj) !== cnpj || !/^[A-Z]{2}$/.test(data.uf) || !data.razao_social) throw new Error('Resposta cadastral incompleta ou divergente. Consulta interrompida.');
  let municipalityCode = data.codigo_municipio_ibge ? String(data.codigo_municipio_ibge) : null;
  if (!municipalityCode || municipalityCode.length !== 7) {
    let municipalities = store.get('geography', data.uf);
    if (!municipalities) { municipalities = await jsonFetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${data.uf}/municipios`); store.put('geography', data.uf, municipalities); }
    municipalityCode = String(municipalities.find(m => plain(m.nome) === plain(data.municipio))?.id || '');
  }
  if (!/^\d{7}$/.test(municipalityCode)) throw new Error('Não foi possível confirmar o código IBGE do município. Nenhum portal municipal foi selecionado.');
  const geography=require('../config/municipalities.json').municipalities.find(m=>m.code===municipalityCode);
  if(!geography||geography.uf!==data.uf||plain(geography.name)!==plain(data.municipio)) throw new Error('Município ou UF divergem da base IBGE. Consulta interrompida para evitar selecionar o órgão errado.');
  const company = { cnpj, name: data.razao_social, tradeName: data.nome_fantasia || '', uf: data.uf, municipality: data.municipio, municipalityCode, address: [data.descricao_tipo_de_logradouro, data.logradouro, data.numero, data.bairro].filter(Boolean).join(' '), registrationStatus: data.descricao_situacao_cadastral || '', sourceUrl, sourceName:selected.name, source: selected.name+' (fonte cadastral intermediária; não valida certidões)', sourceUpdatedAt:data.ultima_atualizacao||null, fetchedAt: new Date().toISOString() };
  store.put('company', cnpj, company); store.audit({ type: 'company_lookup', cnpj, sourceUrl, uf: company.uf, municipalityCode });
  return company;
}
module.exports = { lookupCompany };
