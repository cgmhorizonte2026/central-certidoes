const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const attach=require('../interface-api');

test('manual certificate upload is gated by official-check confirmation and matching CNPJ/code',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'central-manual-'));
 const certs=path.join(root,'certs'),index=path.join(root,'index');fs.mkdirSync(certs);fs.mkdirSync(index);
 const app=express(),archivePath=cnpj=>path.join(index,cnpj+'.json');
 const readArchive=cnpj=>{try{return JSON.parse(fs.readFileSync(archivePath(cnpj),'utf8'));}catch{return{cnpj,certificates:{}};}};
 attach({app,express,fs,path,STORAGE_ROOT:root,STORAGE_CERTS:certs,STORAGE_INDEX:index,readArchive,archivePath,parseCert:()=>({status:'negativa',validade:'2026-12-31',numero:'ABCD-1234'}),pdfParse:async()=>({text:'PREFEITURA CERTIDAO NEGATIVA MUNICIPAL CNPJ 00.000.000/0001-91 CODIGO ABCD-1234'})});
 const server=app.listen(0,'127.0.0.1');
 try{
  await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const pdf=Buffer.from('%PDF-1.7 fixture');
  let response=await fetch(`${base}/api/manual/00000000000191/municipal`,{method:'POST',headers:{'Content-Type':'application/pdf','X-Certificate-Code':'ABCD-1234'},body:pdf});assert.equal(response.status,403);
  response=await fetch(`${base}/api/manual/00000000000191/municipal`,{method:'POST',headers:{'Content-Type':'application/pdf','X-Certificate-Code':'WRONG-9999','X-Official-Validation':'confirmed'},body:pdf});assert.equal(response.status,422);
  response=await fetch(`${base}/api/manual/00000000000191/municipal`,{method:'POST',headers:{'Content-Type':'application/pdf','X-Certificate-Code':'ABCD-1234','X-Official-Validation':'confirmed'},body:pdf});assert.equal(response.status,200);
  const cert=await response.json();assert.equal(cert.validation.status,'conferida_pelo_responsavel');assert.equal(fs.existsSync(cert.filePath),true);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
