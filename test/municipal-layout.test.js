const test=require('node:test'),assert=require('node:assert/strict');const {finalMunicipalDocument}=require('../automation/municipal-print');
test('Horizonte CPEN title without de remains a final positive certificate with negative effects',()=>{
 const text='PREFEITURA MUNICIPAL DE HORIZONTE\nCERTIDÃO POSITIVA COM\nEFEITO NEGATIVA\nNº 0000101/2026\nCNPJ 00.000.000/0001-91\nCertificamos que existem pendências de tributos municipais com exigibilidade suspensa. A presente Certidão produz os mesmos efeitos da Certidão Negativa.\nVALIDA ATÉ: 07/12/2026\nCOD. VALIDAÇÃO: 724bfd6a-2134-402c-9a5b-4a8d19f32451';
 for(const title of ['EFEITO NEGATIVA','EFEITO NEGATIVO','EFEITOS DE NEGATIVA']){
  const value=text.replace('EFEITO NEGATIVA',title),result=finalMunicipalDocument(value,'00000000000191');
  assert.equal(result.valid,true);assert.equal(result.parsed.classification,'positiva_efeitos_negativa');assert.equal(result.parsed.expiresAt,'2026-12-07');
  assert.equal(finalMunicipalDocument(value,'11222333000181').valid,false);
  assert.equal(finalMunicipalDocument('Resultado da consulta '+value,'00000000000191').valid,false);
 }
 const positive=finalMunicipalDocument(text.replace('CERTIDÃO POSITIVA COM\nEFEITO NEGATIVA','CERTIDÃO POSITIVA').replace('A presente Certidão produz os mesmos efeitos da Certidão Negativa.',''),'00000000000191');
 assert.equal(positive.parsed.classification,'positiva');
});
test('municipal multi-column PDF with values before labels is accepted without confusing expiry and issue dates',()=>{
 const text='PREFEITURA MUNICIPAL\nCERTIDÃO NEGATIVA DE DÉBITOS MUNICIPAIS\nNº\n00006503727\nCNPJ 00.000.000/0001-91\nCertificamos que não há pendências.\nIGUATU-CE, 18 DE NOVEMBRO DE 2026\nEsta certidão é válida por 090 dias contados da data de emissão\n15/02/2027\nCOD. VALIDAÇÃO:\nVALIDA ATÉ:\n0122C013A00000035495';
 const result=finalMunicipalDocument(text,'00000000000191');assert.equal(result.valid,true);assert.equal(result.parsed.expiresAt,'2027-02-15');assert.equal(result.parsed.issuedAt,'2026-11-18');assert.equal(result.parsed.number,'00006503727');assert.equal(result.parsed.controlCode,'0122C013A00000035495');assert.equal(finalMunicipalDocument(text,'11222333000181').valid,false);assert.equal(finalMunicipalDocument('Resultado da consulta '+text,'00000000000191').valid,false);
});
