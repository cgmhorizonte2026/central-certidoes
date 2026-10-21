module.exports=({app,express,fs,path,STORAGE_ROOT,STORAGE_CERTS,STORAGE_INDEX,readArchive,archivePath,parseCert,pdfParse})=>{
 const crypto=require('crypto');const keys=['federal','fgts','trabalhista','ceara','municipal'];
 app.post('/api/manual/:cnpj/:key',express.raw({type:'application/pdf',limit:'25mb'}),async(req,res)=>{
  const {cnpj,key}=req.params;if(!/^\d{14}$/.test(cnpj)||!keys.includes(key))return res.status(400).json({error:'Empresa ou certidão inválida.'});
  if(!Buffer.isBuffer(req.body)||req.body.subarray(0,5).toString()!=='%PDF-')return res.status(400).json({error:'Selecione um arquivo PDF válido.'});
  if(req.get('X-Official-Validation')!=='confirmed')return res.status(403).json({error:'Antes de anexar, faça a validação no portal oficial e confirme a conferência.'});
  const suppliedCode=String(req.get('X-Certificate-Code')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(suppliedCode.length<4)return res.status(400).json({error:'Informe o código de verificação da certidão.'});
  try{
   let parsed={},extractionWarning='',text='';try{const pdf=await pdfParse(req.body);text=String(pdf.text||'');parsed=parseCert(text);}catch(_){return res.status(422).json({error:'Não foi possível ler o PDF. Nenhum arquivo foi anexado.'});}
   const compact=text.toUpperCase().replace(/[^A-Z0-9]/g,'');
   if(!compact.includes(cnpj))return res.status(422).json({error:'O CNPJ do PDF não corresponde à empresa selecionada. Nenhum arquivo foi anexado.'});
   if(!compact.includes(suppliedCode))return res.status(422).json({error:'O código informado não foi encontrado no conteúdo do PDF. Confira o código e o documento; nada foi anexado.'});
   const issuerEvidence={federal:/receita federal|fazenda nacional|pgfn/i,fgts:/fgts/i,trabalhista:/trabalhista|tribunal superior do trabalho|justiça do trabalho/i,ceara:/ceará|ceara|estadual/i,municipal:/prefeitura|municipal|tributos municipais/i}[key];
   if(issuerEvidence&&!issuerEvidence.test(text))return res.status(422).json({error:'O conteúdo do PDF não confirma o órgão desta certidão. Nenhum arquivo foi anexado.'});
   const id=crypto.randomUUID(),dir=path.join(STORAGE_CERTS,cnpj,'manual',id);fs.mkdirSync(dir,{recursive:true});
   const fileName=key.toUpperCase()+'.pdf',filePath=path.join(dir,fileName);fs.writeFileSync(filePath,req.body);
   const validation={status:'conferida_pelo_responsavel',method:'confirmacao_no_portal_e_correspondencia_cnpj_codigo_no_pdf',code:suppliedCode,confirmedAt:new Date().toISOString(),note:'O responsável confirmou a conferência no site oficial. A Central confirmou que o CNPJ e o código informados estão no PDF; esta rotina não consulta automaticamente a base do órgão.'};
   const cert={...parsed,portal:key,filePath,fileName,fileUrl:'/archive-files/'+cnpj+'/manual/'+id+'/'+fileName,viewUrl:'/archive-files/'+cnpj+'/manual/'+id+'/'+fileName,downloadUrl:'/api/archive/'+cnpj+'/'+key+'/download',source:'manual_validated_by_operator',validation,archivedAt:new Date().toISOString(),sha256:crypto.createHash('sha256').update(req.body).digest('hex'),extractionWarning};
   const archive=readArchive(cnpj);archive.history=archive.history||[];if(archive.certificates[key])archive.history.push(archive.certificates[key]);archive.certificates[key]=cert;archive.updatedAt=cert.archivedAt;
   const tmp=archivePath(cnpj)+'.tmp';fs.writeFileSync(tmp,JSON.stringify(archive,null,2));fs.renameSync(tmp,archivePath(cnpj));res.json(cert);
  }catch(err){res.status(500).json({error:'Não foi possível salvar o PDF: '+err.message});}
 });
 app.get('/api/interface/archives',(_,res)=>{try{res.json(fs.readdirSync(STORAGE_INDEX).filter(n=>/^\d{14}\.json$/.test(n)).map(n=>readArchive(n.slice(0,14))));}catch(_){res.status(500).json({error:'Falha ao ler arquivo.'});}});
app.get('/api/interface/storage',(_,res)=>res.json({storage:STORAGE_ROOT,version:'2.9.3.11'}));
};
