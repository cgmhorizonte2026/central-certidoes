const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFederalPortalError } = require('../automation/portalRunner');

test('classifies the Receita Federal temporary error 106 and explains no certificate was issued', () => {
  const error = classifyFederalPortalError('Não foi possível concluir a ação para o contribuinte informado. Por favor, tente novamente dentro de alguns minutos. 106 - 26/10/2026 16:57:30');
  assert.deepEqual(error, {
    provider: 'Receita Federal',
    portalCode: '106',
    occurrence: '26/10/2026 16:57:30',
    category: 'PORTAL_TEMPORARIAMENTE_INDISPONIVEL',
    message: 'A Receita Federal respondeu com o código 106 e pediu para tentar novamente em alguns minutos. Nenhuma certidão foi emitida nesta tentativa.'
  });
});

test('does not classify ordinary federal form text as a terminal portal error', () => {
  assert.equal(classifyFederalPortalError('Certidão de Pessoa Jurídica. Informe o CNPJ e clique em Emitir Certidão.'), null);
});
