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
test('printed and recovered PDFs retain provenance only for the observed page and matching bytes',async()=>{
 const {recordPageCapture}=require('../automation/capture-provenance');
 const page=new EventEmitter(),other=new EventEmitter(),capture=observeCapture(page,portal),bytes=Buffer.from('%PDF-rendered');
 recordPageCapture(other,bytes,portal.url,'official_print_view');assert.equal((await capture.provenance(bytes)).officialPortal,false);
 recordPageCapture(page,bytes,'https://external.invalid/document','official_print_view');assert.equal((await capture.provenance(bytes)).officialPortal,false);
 recordPageCapture(page,bytes,portal.url,'official_print_view');assert.equal((await capture.provenance(bytes)).captureMethod,'official_print_view');
 const download=Buffer.from('%PDF-recovered');recordPageCapture(page,download,'blob:'+portal.url,'controlled_download');assert.equal((await capture.provenance(download)).officialPortal,true);
 capture.dispose();const later=Buffer.from('%PDF-later');recordPageCapture(page,later,portal.url,'official_print_view');assert.equal((await capture.provenance(later)).officialPortal,false);
});
test('JSON PDF response supplies evidence without accepting a different file',async()=>{
 const page=new EventEmitter(),capture=observeCapture(page,portal),bytes=Buffer.from('%PDF-json');
 page.emit('response',{status:()=>200,url:()=>portal.url,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from(JSON.stringify({pdf:bytes.toString('base64')}))});
 assert.equal((await capture.provenance(bytes)).officialPortal,true);assert.equal((await capture.provenance(Buffer.from('%PDF-unrelated'))).officialPortal,false);capture.dispose();
});
