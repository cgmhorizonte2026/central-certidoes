const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store');
test('PDF folders use company/type, deduplicate bytes, preserve legacy audit paths and reject tampering',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'central-pdf-'));const store=new Store(root);
 try{const buffer=Buffer.from('%PDF-fixture');const legacy=store.saveFile('files',buffer,'pdf');const organized=store.saveCertificateFile('00000000000191','federal',buffer,legacy);
 assert.match(organized.path,/^files\/00000000000191\/federal\/[a-f0-9]{64}\.pdf$/);assert.equal(fs.statSync(store.resolve(organized.path)).ino,fs.statSync(store.resolve(legacy.path)).ino);assert.ok(store.intact(legacy));assert.deepEqual(store.saveCertificateFile('00000000000191','federal',buffer),organized);
 store.put('certificate','legacy',{id:'legacy',cnpj:'00000000000191',portalKey:'federal',file:legacy,validation:{status:'pending'}});
 assert.equal(store.organizeCertificates(),1);assert.equal(store.organizeCertificates(),0);assert.equal(store.get('certificate','legacy').file.path,organized.path);assert.equal(store.get('certificate','legacy').validation.status,'pending');assert.ok(store.checkAudit().ok);
 assert.throws(()=>store.saveCertificateFile('../outside','federal',buffer));assert.throws(()=>store.saveCertificateFile('00000000000191','../../outside',buffer));
 fs.writeFileSync(store.resolve(organized.path),'changed');assert.throws(()=>store.saveCertificateFile('00000000000191','federal',buffer),/alterado/);
 }finally{store.close();if(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(root,{recursive:true,force:true});}
});
