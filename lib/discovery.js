// Discovery is deliberately separate from trust: Wikidata can suggest a municipality's
// website, but cannot certify that a tax service or a certificate is authentic.
async function discoverMunicipality(code, store) {
  if (!/^\d{7}$/.test(code)) throw new Error('Código IBGE inválido.');
  const cached = store.get('discovery', code);
  if (cached?.candidates?.length && Date.now() - Date.parse(cached.at) < 7 * 86400000) return cached;
  const query = `SELECT ?item ?website WHERE { ?item wdt:P1585 "${code}"; wdt:P856 ?website. } LIMIT 5`;
  const response = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'CentralCertidoes/3.0 (municipal portal discovery)' }, signal: AbortSignal.timeout(18000) });
  if (!response.ok) throw new Error('Serviço de descoberta indisponível. Cadastre o portal municipal na base.');
  const data = await response.json();
  const candidates = (data.results?.bindings || []).flatMap(b => {
    try { const u = new URL(b.website.value); if (!['https:','http:'].includes(u.protocol) || !u.hostname.endsWith('.gov.br')) return []; return [{ url: u.href, sourceUrl: b.item.value, status: 'candidato_nao_homologado' }]; } catch { return []; }
  });
  const result = { code, at: new Date().toISOString(), candidates, note: 'Sites localizados por código IBGE. A descoberta não confirma a autenticidade de nenhuma certidão.' };
  store.put('discovery', code, result); return result;
}
async function resolveMunicipalPortal(company,store){
  const result=await discoverMunicipality(company.municipalityCode,store);
  const candidate=result.candidates[0];if(!candidate)return result;
  const home=new URL(candidate.url);home.protocol='https:';
  // Only navigate HTTPS government URLs in the same municipal domain. No arbitrary
  // user URLs, private hosts or third-party websites are fetched by discovery.
  const root=home.hostname.split('.').slice(-4).join('.');
  let url=home.href;let sourceUrl=home.href;let coverage='diretorio_descoberto';
  const queue=[home.href],visited=new Set();
  try{
   while(queue.length&&visited.size<4){
    const current=queue.shift();if(visited.has(current))continue;visited.add(current);
    const response=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(10000)});
    if(response.ok){
      let html='',size=0;for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)break;html+=Buffer.from(chunk).toString('utf8');}
      const matches=[...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap(m=>{
        const label=m[2].replace(/<[^>]+>/g,' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        if(!/certid|\bcnd\b|servicos|contribuinte/.test(label)||/nascimento|obito|imovel|iptu|casamento|imobili/.test(label))return [];
        try{const u=new URL(m[1].replace(/&amp;/g,'&'),current);if(u.protocol!=='https:'||!(u.hostname===root||u.hostname.endsWith('.'+root))||u.username||u.password||u.port)return [];return [{url:u.href,service:/certid|\bcnd\b/.test(label),score:/negativa|tribut|debito/.test(label)?3:/certid|\bcnd\b/.test(label)?2:1}];}catch{return [];}
      }).sort((a,b)=>b.score-a.score);
      if(matches[0]?.service){url=matches[0].url;sourceUrl=current;coverage='servico_descoberto';break;}
      queue.push(...matches.map(m=>m.url).filter(u=>!visited.has(u)));
    }
   }
  }catch{ /* Keep the discovered official directory without claiming it was inspected. */ }
  const portal={municipalityCode:company.municipalityCode,url,verifyUrl:null,sourceUrl,discoverySource:candidate.sourceUrl,coverage,mode:'assistido',allowedHosts:[...new Set([home.hostname,new URL(url).hostname])],registeredAt:new Date().toISOString(),registeredBy:'descoberta_por_ibge',review:'descoberto_nao_homologado'};
  store.put('portal',company.municipalityCode,portal);store.audit({type:'municipal_portal_discovered',cnpj:company.cnpj,portal});
  return {...result,portal};
}
module.exports = { discoverMunicipality,resolveMunicipalPortal };
