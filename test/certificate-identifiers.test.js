const test=require('node:test'),assert=require('node:assert/strict');const {certificateIdentifiers:read}=require('../lib/certificate-identifiers');
test('certificate identifiers stay separate across agency layouts',()=>{for(const [text,number,code] of [
 ['Código de controle da certidão: BCA6.527B.61E0.B788','','BCA6.527B.61E0.B788'],
 ['Certificação Número: 2026102218331087576477','2026102218331087576477',''],
 ['Certidão nº: 77172082/2026','77172082/2026',''],
 ['Certidão Nº 2026/466971','2026/466971',''],
 ['Certidão Negativa de Débitos Estaduais 202612345678','202612345678',''],
 ['Certidão Nº 123456 Código de verificação: ABCD-1234','123456','ABCD-1234'],
 ['COD. VALIDAÇÃO:\nVALIDA ATÉ:\n0122C013A00000035495','','0122C013A00000035495']]){assert.equal(read(text).numero,number,text);assert.equal(read(text).chaveConsulta,code,text);}assert.equal(read('Certidão Nº 123456 Certidão Nº 654321').numero,'');assert.equal(read('Consulte a autenticidade no portal.').chaveConsulta,'');});
