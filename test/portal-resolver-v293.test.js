const test = require('node:test');
const assert = require('node:assert/strict');
const { portalsForCompany } = require('../config/portalResolver');

test('São Paulo selects CNPJ before filling and emits only after CAPTCHA', () => {
  const portal = portalsForCompany({uf:'SP',municipio:'São Paulo',municipio_codigo_ibge:'3550308'}).find(p => p.key === 'estadual-sp');
  assert.equal(portal.preActions[0].selectors[0], '#MainContent_cnpjradio');
  assert.equal(portal.selectors.cnpj[0], '#MainContent_txtDocumento');
  assert.equal(portal.humanCaptcha, 'required');
  assert.equal(portal.afterCaptchaActions[0].selectors[0], '#MainContent_btnPesquisar');
});
