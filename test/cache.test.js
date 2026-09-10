const test=require('node:test'),assert=require('node:assert/strict');const {Certificates}=require('../lib/certificates');
test('reuse starts at exactly five days and never resets authentication timestamp',()=>{
 const cert={id:'one',cnpj:'00000000000191',portalKey:'federal',uploadedAt:'2026-09-01T12:00:00Z',file:{},parsed:{cnpjMatches:true,kindMatches:true,classification:'negativa',expiresAt:'2026-09-14'},provenance:{method:'official_download',url:'https://servicos.receitafederal.gov.br/doc.pdf'},validation:{status:'pending'}};
 let intact=true;const service=new Certificates({all:()=>[cert],intact:()=>intact});const portal={key:'federal',allowedHosts:['servicos.receitafederal.gov.br']};
 assert.equal(service.reusable(cert.cnpj,portal,'2026-09-09').remainingDays,5);assert.equal(service.reusable(cert.cnpj,portal,'2026-09-10'),null);
 assert.equal(cert.validation.status,'pending');intact=false;assert.equal(service.reusable(cert.cnpj,portal,'2026-09-09'),null);intact=true;cert.provenance.method='upload';assert.equal(service.reusable(cert.cnpj,portal,'2026-09-09'),null);
});
