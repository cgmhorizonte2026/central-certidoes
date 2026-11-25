const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MunicipalPortalResolver, detectProvider } = require('../lib/municipal-portal-resolver');

const company = { municipio_codigo_ibge:'2312403', municipio:'São Gonçalo do Amarante', uf:'CE' };

test('requires canonical municipality identity', async () => {
  const resolver = new MunicipalPortalResolver({ fetchImpl: async () => { throw new Error('unexpected'); } });
  assert.equal((await resolver.resolve({municipio:'X',uf:'CE'})).status, 'MUNICIPIO_NAO_IDENTIFICADO');
});

test('discovers a certificate service linked by the official municipality site and caches it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'municipal-resolver-'));
  const cacheFile = path.join(dir,'portals.json');
  let calls = 0;
  const pages = new Map([
    ['https://saogoncalodoamarante.ce.gov.br/', '<title>Prefeitura de São Gonçalo do Amarante</title><a href="https://tributos.example.com/certidao">Certidão Negativa de Débitos</a>'],
    ['https://tributos.example.com/certidao', '<h1>Certidão</h1><input name="cpf_cnpj" placeholder="CPF/CNPJ"><button>Emitir Certidão</button>']
  ]);
  const fetchImpl = async url => {
    calls++;
    const href=String(url);
    if (href.includes('wikidata.org')) return {ok:true,json:async()=>({results:{bindings:[{website:{value:'https://saogoncalodoamarante.ce.gov.br/'}}]}})};
    if (!pages.has(href)) return {ok:false,status:404,url:href,text:async()=>''};
    return {ok:true,status:200,url:href,text:async()=>pages.get(href)};
  };
  const resolver = new MunicipalPortalResolver({cacheFile,fetchImpl});
  const result = await resolver.resolve(company);
  assert.equal(result.status,'PORTAL_ENCONTRADO');
  assert.equal(result.provider,'generic-cnpj');
  assert.equal(result.confianca,'link_oficial');
  const firstCalls=calls;
  assert.equal((await resolver.resolve(company)).cache,true);
  assert.equal(calls,firstCalls);
});

test('detects reusable fisco provider by page mechanism', () => {
  assert.equal(detectProvider('https://fisco.exemplo.ce.gov.br/certidao','<label>Tipo Certidão</label><input placeholder="CPF/CNPJ"><button>Emitir Certidão</button>'),'fisco-web');
});

test('follows contributor portals and chooses business certificate in nested menus', async () => {
  const home='https://pacajus.ce.gov.br/';
  const portal='https://servicos2.speedgov.com.br/pacajus/';
  const business=portal+'pages/certidao_economico';
  const pages=new Map([
    [home,'Prefeitura de Pacajus <a href="'+portal+'">Portal do Contribuinte</a>'],
    [portal,'Emitir CND <a href="pages/certidao_imovel">Imóvel</a><a href="pages/certidao_contribuinte">Contribuinte</a><a href="pages/certidao_economico">Econômico</a>'],
    [business,'Emitir Certidão da Empresa <input name="cnpj">']
  ]);
  const resolver=new MunicipalPortalResolver({fetchImpl:async url=>({ok:pages.has(url),status:pages.has(url)?200:404,url,text:async()=>pages.get(url)||''})});
  resolver.officialCandidates=async()=>[home];
  const result=await resolver.resolve({municipio_codigo_ibge:'2309607',municipio:'PACAJUS',uf:'CE'});
  assert.equal(result.status,'PORTAL_ENCONTRADO');
  assert.equal(result.certidao_url,business);
  assert.equal(result.fonte,portal);
});

test('continues after a missing service page and preserves diagnostic errors', async () => {
  const home='https://example.ce.gov.br/';
  const pages=new Map([[home,'Prefeitura de Pacajus'],[home+'cartaservicos.php','<a href="/certidao">Certidão Negativa</a>'],[home+'certidao','Certidão CNPJ']]);
  const resolver=new MunicipalPortalResolver({fetchImpl:async url=>({ok:pages.has(url),status:pages.has(url)?200:404,url,text:async()=>pages.get(url)||''})});
  resolver.officialCandidates=async()=>[home];
  const result=await resolver.resolve({municipio_codigo_ibge:'2309607',municipio:'PACAJUS',uf:'CE'});
  assert.equal(result.status,'PORTAL_ENCONTRADO');
  assert.ok(result.diagnostico.rejeicoes.some(r=>r.reason==='HTTP 404'));
});
