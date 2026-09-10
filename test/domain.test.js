const test = require('node:test');
const assert = require('node:assert/strict');
const { validCnpj,parseCertificate,assessment,isoDate } = require('../lib/domain');
const { routesFor,trustedUrl,states } = require('../config/registry');
test('validates numeric and official alphanumeric CNPJ, rejects malformed inputs',()=>{
  assert.equal(validCnpj('00.000.000/0001-91'),true); assert.equal(validCnpj('00.000.000/E08G-12'),true);
  for(const c of ['00000000000000','00000000000192','<00000000000191>','00000000E08G13']) assert.equal(validCnpj(c),false);
});
test('irregular is never classified as regular; ambiguous text fails closed',()=>{
  assert.equal(parseCertificate('Certificado de Regularidade: empresa irregular','00000000000191','fgts').classification,'irregular');
  assert.equal(parseCertificate('Certidão positiva','00000000000191','federal').classification,'positiva');
  assert.equal(parseCertificate('Certidão positiva com efeitos de negativa','00000000000191','federal').classification,'positiva_efeitos_negativa');
  assert.equal(parseCertificate('Regularização de certidão: consulte o órgão','00000000000191','federal').classification,'indeterminada');
});
test('extracts only explicitly labelled dates and detects wrong company',()=>{
  assert.equal(isoDate('31/02/2026'),null);
  const p=parseCertificate('CERTIDÃO NEGATIVA CNPJ 00.000.000/0001-91 Emitida em: 09/09/2026 Validade: 31/12/2026','11222333000181','federal');
  assert.equal(p.expiresAt,'2026-12-31');assert.equal(p.issuedAt,'2026-09-09');assert.equal(p.cnpjMatches,false);
  assert.equal(parseCertificate('Lei de 31/12/2026','00000000000191','federal').expiresAt,null);
});
test('uploaded, expired, altered or mismatched documents are not ready',()=>{
  const c={parsed:{classification:'negativa',expiresAt:'2026-12-31',cnpjMatches:true},validation:{status:'pending'},integrity:true};
  assert.equal(assessment(c,'2026-09-09').ready,false);
  assert.equal(assessment({...c,integrity:false},'2026-09-09').code,'integridade_falhou');
  assert.equal(assessment(c,'2027-01-01').code,'vencida');
  assert.equal(assessment({...c,parsed:{...c.parsed,cnpjMatches:false}},'2026-09-09').code,'cnpj_divergente');
});
test('first-time company routes by UF and IBGE, SP has both scopes, DF has no separate municipality',()=>{
  assert.equal(Object.keys(states).length,27);
  const sp=routesFor({uf:'SP',municipality:'São Paulo',municipalityCode:'3550308'});
  assert.ok(sp.find(r=>r.key==='estadual').url.includes('sp.gov.br'));
  assert.ok(sp.find(r=>r.key==='estadual-divida-ativa'));
  assert.ok(sp.find(r=>r.key==='municipal').url);
  const df=routesFor({uf:'DF',municipality:'Brasília',municipalityCode:'5300108'});
  assert.equal(df.find(r=>r.key==='municipal').required,false);
  const ce=routesFor({uf:'CE',municipality:'Fortaleza',municipalityCode:'2304401'});
  assert.ok(ce.find(r=>r.key==='estadual').url.includes('ce.gov.br'));
});
test('official origin is exact and HTTPS-only',()=>{
  const p={allowedHosts:['www.tst.jus.br']};assert.equal(trustedUrl('https://www.tst.jus.br/certidao',p),true);
  for(const url of ['https://www.tst.jus.br.attacker.test/x','http://www.tst.jus.br/x','https://x@www.tst.jus.br/x','https://www.tst.jus.br:8443/x']) assert.equal(trustedUrl(url,p),false);
});
