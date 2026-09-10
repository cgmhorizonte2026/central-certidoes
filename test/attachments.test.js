const test=require('node:test'),assert=require('node:assert/strict');
const {validity}=require('../lib/domain');
const {Certificates}=require('../lib/certificates');
test('expiry uses calendar days, flags renewal without dropping attachment, and rejects invalid dates',()=>{
 const p={issuedAt:'2026-09-01',expiresAt:'2026-09-15'};
 assert.equal(validity(p,'2026-09-10').status,'current');
 assert.equal(validity(p,'2026-09-11').status,'expiring');
 assert.equal(validity(p,'2026-09-15').remainingDays,0);
 assert.equal(validity(p,'2026-09-16').status,'expired');
 assert.equal(validity({expiresAt:'2026-02-30'},'2026-02-01').status,'unknown');
 assert.equal(validity({expiresAt:null}).remainingDays,null);
 assert.equal(validity({...p,issuedAt:'2026-09-16'},'2026-09-10').status,'inconsistent');
});
test('saved attachment survives pending authentication, expiry and a new verification reference',()=>{
 const base={id:'saved',cnpj:'00000000000191',portalKey:'federal',uploadedAt:'2026-09-01',file:{},parsed:{cnpjMatches:true,kindMatches:true,classification:'negativa',expiresAt:'2020-01-01'},validation:{status:'pending',officialCertificateId:'reference'}};
 const reference={...base,id:'reference',uploadedAt:'2026-09-10',validation:{status:'pending'}};
 const service=new Certificates({all:()=>[base,reference],intact:()=>true});
 assert.equal(service.latest(base.cnpj,base.portalKey).id,'saved');
 const presented=service.present(service.latest(base.cnpj,base.portalKey));
 assert.equal(presented.integrity,true);assert.equal(presented.validity.status,'expired');
 const newer={...base,id:'newer',uploadedAt:'2026-09-09',validation:{status:'pending'}};
 assert.equal(service.latest(base.cnpj,base.portalKey,[base,newer]).id,'newer');
});
