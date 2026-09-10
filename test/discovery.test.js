const test=require('node:test');const assert=require('node:assert/strict');const {resolveMunicipalPortal}=require('../lib/discovery');
test('discovers a municipal service on first lookup and rejects unrelated/external links',async()=>{
 const original=global.fetch;const records=new Map();const store={get:(kind,id)=>records.get(kind+id),put:(kind,id,value)=>records.set(kind+id,value),audit:()=>{}};
 global.fetch=async url=>{
   if(url.startsWith('https://query.wikidata.org/'))return Response.json({results:{bindings:[{website:{value:'https://www.fortaleza.ce.gov.br/'},item:{value:'https://www.wikidata.org/entity/Q43463'}}]}});
   assert.equal(url,'https://www.fortaleza.ce.gov.br/');return new Response('<a href="https://evil.example/cnd">Certidão negativa</a><a href="https://www.fortaleza.ce.gov.br/iptu">Certidão IPTU</a><a href="https://www.fortaleza.ce.gov.br/certidao">Certidão negativa de tributos municipais</a>');
 };
 try{const r=await resolveMunicipalPortal({cnpj:'00000000000191',municipalityCode:'2304400'},store);assert.equal(r.portal.url,'https://www.fortaleza.ce.gov.br/certidao');assert.equal(r.portal.review,'descoberto_nao_homologado');assert.ok(records.has('portal2304400'));}finally{global.fetch=original;}
});
