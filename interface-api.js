module.exports=({app,express,fs,path,STORAGE_ROOT,STORAGE_CERTS,STORAGE_INDEX,readArchive,archivePath,parseCert,pdfParse})=>{
 const crypto=require('crypto');const keys=['federal','fgts','trabalhista','ceara','municipal'];
 app.post('/api/manual/:cnpj/:key',express.raw({type:'application/pdf',limit:'25mb'}),async(req,res)=>{
  const {cnpj,key}=req.params;if(!/^\d{14}$/.test(cnpj)||!keys.includes(key))return res.status(400).json({error:'Empresa ou certidão inválida.'});
  if(!Buffer.isBuffer(req.body)||req.body.subarray(0,5).toString()!=='%PDF-')return res.status(400).json({error:'Selecione um arquivo PDF válido.'});
  try{
   let parsed={},extractionWarning='';try{const pdf=await pdfParse(req.body);parsed=parseCert(pdf.text);}catch(_){extractionWarning='PDF arquivado. Não foi possível extrair o texto; confira e preencha os dados.';}
   const id=crypto.randomUUID(),dir=path.join(STORAGE_CERTS,cnpj,'manual',id);fs.mkdirSync(dir,{recursive:true});
   const fileName=key.toUpperCase()+'.pdf',filePath=path.join(dir,fileName);fs.writeFileSync(filePath,req.body);
   const cert={...parsed,portal:key,filePath,fileName,fileUrl:'/archive-files/'+cnpj+'/manual/'+id+'/'+fileName,viewUrl:'/archive-files/'+cnpj+'/manual/'+id+'/'+fileName,downloadUrl:'/api/archive/'+cnpj+'/'+key+'/download',source:'manual',archivedAt:new Date().toISOString(),sha256:crypto.createHash('sha256').update(req.body).digest('hex'),extractionWarning};
   const archive=readArchive(cnpj);archive.history=archive.history||[];if(archive.certificates[key])archive.history.push(archive.certificates[key]);archive.certificates[key]=cert;archive.updatedAt=cert.archivedAt;
   const tmp=archivePath(cnpj)+'.tmp';fs.writeFileSync(tmp,JSON.stringify(archive,null,2));fs.renameSync(tmp,archivePath(cnpj));res.json(cert);
  }catch(err){res.status(500).json({error:'Não foi possível salvar o PDF: '+err.message});}
 });
 app.get('/api/interface/archives',(_,res)=>{try{res.json(fs.readdirSync(STORAGE_INDEX).filter(n=>/^\d{14}\.json$/.test(n)).map(n=>readArchive(n.slice(0,14))));}catch(_){res.status(500).json({error:'Falha ao ler arquivo.'});}});
app.get('/api/interface/storage',(_,res)=>res.json({storage:STORAGE_ROOT,version:'2.9.3.11'}));
};
