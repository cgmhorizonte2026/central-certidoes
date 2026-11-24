const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {hash,officialUrl,observeCapture}=require('../automation/capture-provenance');
const portal={key:'trabalhista',url:'https://cndt-certidao.tst.jus.br/inicio'};
test('official evidence requires exact HTTPS host and matching PDF bytes',async()=>{
 const page=new EventEmitter(),capture=observeCapture(page,portal),bytes=Buffer.from('%PDF-test-one');
 page.emit('response',{status:()=>200,url:()=>portal.url,headers:()=>({'content-type':'application/pdf'}),body:async()=>bytes});
 assert.equal((await capture.provenance(bytes)).officialPortal,true);
 assert.equal((await capture.provenance(Buffer.from('%PDF-other'))).officialPortal,false);
 assert.notEqual(hash(bytes),hash(Buffer.from('%PDF-other')));
 for(const url of ['https://cndt-certidao.tst.jus.br.evil.test/x','http://cndt-certidao.tst.jus.br/x','https://user@cndt-certidao.tst.jus.br/'])assert.equal(officialUrl(url,portal),false);
 capture.dispose();assert.equal(page.listenerCount('response'),0);
});
