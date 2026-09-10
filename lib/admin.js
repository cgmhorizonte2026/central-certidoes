const crypto=require('node:crypto');
const {validCnpj,normalizeCnpj}=require('./domain');
const {states}=require('../config/registry');
function adminOrgRoutes(app,store,requireAdmin){
 app.get('/api/admin/orgs',requireAdmin,(_req,res)=>res.json(store.all('org')));
 function save(req,res){
  const old=req.params.id?store.get('org',req.params.id):null;if(req.params.id&&!old)return res.status(404).json({error:'Órgão não encontrado.'});
  const b=req.body;const name=String(b.name||'').trim(),scope=b.scope||'institucional';
  if(name.length<3||name.length>160||!['institucional','federal','fgts','trabalhista','estadual','municipal'].includes(scope))return res.status(400).json({error:'Informe nome e tipo de órgão válidos.'});
  const cnpj=normalizeCnpj(b.cnpj);if(cnpj&&!validCnpj(cnpj))return res.status(400).json({error:'CNPJ do órgão inválido.'});
  const uf=String(b.uf||'').toUpperCase(),municipalityCode=String(b.municipalityCode||'');
  if(['estadual','municipal'].includes(scope)&&!states[uf])return res.status(400).json({error:'Informe a UF.'});
  if(scope==='municipal'&&!require('../config/municipalities.json').municipalities.some(m=>m.code===municipalityCode&&m.uf===uf))return res.status(400).json({error:'Código IBGE incompatível com a UF.'});
  const urls={};if(scope!=='institucional')for(const field of ['url','verifyUrl','sourceUrl']){try{const u=new URL(b[field]);if(u.protocol!=='https:'||u.username||u.password||u.port||!(/\.(gov|jus)\.br$/.test(u.hostname)||u.hostname==='consulta-crf.caixa.gov.br'))throw Error();urls[field]=u.href;}catch{return res.status(400).json({error:'Use endereços oficiais HTTPS (.gov.br ou .jus.br), sem porta personalizada.'});}}
  const target=scope==='municipal'?`municipal:${municipalityCode}`:scope==='estadual'?`estadual:${uf}`:scope;
  if(scope!=='institucional'&&store.all('org').some(o=>o.id!==old?.id&&o.target===target))return res.status(409).json({error:'Já existe um órgão cadastrado para esse tipo e localidade. Edite o registro existente.'});
  if(old&&old.target!==target)return res.status(409).json({error:'O tipo e a jurisdição não podem mudar. Cadastre outro órgão.'});
  const org={id:old?.id||crypto.randomUUID(),name,scope,target,cnpj,uf,municipalityCode,...urls,updatedAt:new Date().toISOString(),updatedBy:req.user.username};
  store.audit({type:old?'org_updated':'org_created',org},req.user.username);store.put('org',org.id,org);
  if(scope!=='institucional'){
   const portal={...urls,name,allowedHosts:[...new Set(Object.values(urls).map(u=>new URL(u).hostname))],coverage:'portal_identificado',mode:'assistido',review:'cadastrado_por_administrador',orgId:org.id};
   store.put(scope==='municipal'?'portal':'portal_override',scope==='municipal'?municipalityCode:target,portal);
  }
  res.status(old?200:201).json(org);
 }
 app.post('/api/admin/orgs',requireAdmin,save);app.patch('/api/admin/orgs/:id',requireAdmin,save);
}
module.exports={adminOrgRoutes};
