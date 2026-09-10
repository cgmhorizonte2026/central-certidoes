const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {Store}=require('../lib/store');
test('persists records and detects file and audit tampering',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'central-store-'));let store=new Store(dir);
 try{store.put('company','one',{name:'Prestadora'});const f=store.saveFile('files',Buffer.from('original'),'pdf');assert.equal(store.intact(f),true);store.audit({type:'uploaded'});store.audit({type:'checked'});assert.equal(store.checkAudit().ok,true);
 store.close();store=new Store(dir);assert.equal(store.get('company','one').name,'Prestadora');assert.equal(store.checkAudit().ok,true);
 fs.writeFileSync(store.resolve(f.path),'changed');assert.equal(store.intact(f),false);
 store.db.prepare('UPDATE audit SET body=? WHERE seq=1').run('{"tampered":true}');assert.equal(store.checkAudit().ok,false);
 assert.throws(()=>store.resolve('../outside.txt'));assert.throws(()=>store.resolve('../central-store-sibling/file'));
 store.db.prepare('UPDATE records SET body=? WHERE kind=? AND id=?').run('{"name":"Alterada"}','company','one');assert.throws(()=>store.get('company','one'),/integridade/);
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('deleting the last audit event is detected by the external local anchor',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'central-anchor-'));const store=new Store(dir);try{store.audit({type:'one'});store.audit({type:'two'});store.db.prepare('DELETE FROM audit WHERE seq=2').run();assert.equal(store.checkAudit().ok,false);assert.throws(()=>store.audit({type:'three'}),/integridade/);}finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}});
