const test = require('node:test');
const assert = require('node:assert/strict');
const { portalsForCompany, portalForCertificate } = require('../config/portalResolver');

test('São Paulo selects CNPJ before filling and emits only after CAPTCHA', () => {
  const portal = portalsForCompany({uf:'SP',municipio:'São Paulo',municipio_codigo_ibge:'3550308'}).find(p => p.key === 'estadual-sp');
  assert.equal(portal.preActions[0].selectors[0], '#MainContent_cnpjradio');
  assert.equal(portal.selectors.cnpj[0], '#MainContent_txtDocumento');
  assert.equal(portal.humanCaptcha, 'required');
  assert.equal(portal.afterCaptchaActions[0].selectors[0], '#MainContent_btnPesquisar');
});

test('Fortaleza selects legal entity before filling CNPJ and emitting', () => {
  const portal = portalsForCompany({uf:'CE',municipio:'Fortaleza',municipio_codigo_ibge:'2304400'}).find(p => p.key === 'municipal');
  assert.equal(portal.preActions[0].selectors[0], '#pesquisaForm\\:tipoPessoaDecorate\\:j_id358\\:1');
  assert.equal(portal.selectors.cnpj[0], '#pesquisaForm\\:cnpjPessoaDec\\:cnpj');
  assert.equal(portal.humanCaptcha, 'required');
  assert.equal(portal.afterCaptchaActions[0].selectors[0], '#pesquisaForm\\:btnEmitir');
});

test('individual consultation selects only the requested certificate', () => {
  const company={uf:'SP',municipio:'São Paulo',municipio_codigo_ibge:'3550308'};
  assert.equal(portalForCertificate(company,'federal').key,'federal');
  assert.equal(portalForCertificate(company,'ceara').key,'estadual-sp');
  assert.equal(portalForCertificate(company,'municipal').key,'municipal');
  assert.equal(portalForCertificate(company,'invalid'),null);
});
