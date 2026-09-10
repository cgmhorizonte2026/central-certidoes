const {userError}=require('./errors');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { Store } = require('./store');
const { Certificates } = require('./certificates');
const { createAuth } = require('./auth');
const { lookupCompany } = require('./company');
const { normalizeCnpj } = require('./domain');
const { routesFor, states } = require('../config/registry');
const { resolveMunicipalPortal } = require('./discovery');
const { PortalSessions } = require('../automation/sessions');
const { createReport } = require('./report');
function createApp(options = {}) {
  const store = options.store || new Store(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const certificates = new Certificates(store); const app = express(); app.disable('x-powered-by');
  const jobs = new PortalSessions({ store, onPdf: payload => certificates.ingest(payload),onVerification:payload=>certificates.confirmOfficialRecord(payload) });
  for (const job of store.all('job')) if (!['finished','cancelled','error'].includes(job.status)) store.put('job', job.id, { ...job, status: 'error', message: 'Consulta interrompida por reinício. Inicie uma nova consulta.' });
  const port = options.port || Number(process.env.PORT || 3030);
  app.use((req,res,next) => {
    res.set('X-Content-Type-Options','nosniff'); res.set('Referrer-Policy','no-referrer'); res.set('X-Frame-Options','DENY');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!options.testing && ![`localhost:${port}`,`127.0.0.1:${port}`].includes(req.headers.host)) return res.status(403).json({ error: 'Host não permitido.' });
    if (req.headers.origin && ![`http://localhost:${port}`,`http://127.0.0.1:${port}`].includes(req.headers.origin)) return res.status(403).json({ error: 'Origem não permitida.' });
    if (req.path.startsWith('/api/')) res.set('Cache-Control','no-store'); next();
  });
  app.use(express.json({ limit: '1mb' }));
  const auth = createAuth(store); auth.routes(app);
  app.get('/api/health', (_req,res) => res.json({ ok: true, version: '3.0.0', deployment: 'local' }));
  app.use('/api', auth.requireUser);
  auth.adminRoutes(app);
  require('./admin').adminOrgRoutes(app,store,auth.requireAdmin);
  const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
  function company(cnpj) { const c = store.get('company', normalizeCnpj(cnpj)); if (!c) throw Object.assign(new Error('Consulte o CNPJ antes de continuar.'), { status: 404 }); return c; }
  function detail(cnpj) {
    if(!store.checkAudit().ok)throw new Error('A trilha de auditoria não está íntegra. Conferência bloqueada.');
    const c = company(cnpj); const routes = routesFor(c, store);
    const all=store.all('certificate').filter(v=>v.cnpj===c.cnpj);
    const rows = routes.map(portal => ({ portal, certificate: certificates.present(certificates.latest(c.cnpj, portal.key, all)) }));
    return { company: c, rows, certificates: all.map(v => certificates.present(v)), reports: store.all('report').filter(v => v.cnpj === c.cnpj), events: store.events(c.cnpj).slice(0,100), jobs: store.all('job').filter(v => v.cnpj === c.cnpj).slice(0,20) };
  }
  app.get('/api/companies', (_req,res) => res.json(store.all('company').map(c => { const d = detail(c.cnpj); return { ...c, pending: d.rows.filter(r => r.portal.required && !r.certificate?.assessment.ready).length, nextExpiry: d.rows.map(r => r.certificate?.parsed.expiresAt).filter(Boolean).sort()[0] || null }; })));
  app.post('/api/companies/lookup', asyncRoute(async (req,res) => { const c = await (options.lookupCompany || lookupCompany)(req.body.cnpj,store); let discoveryError; if(routesFor(c,store).some(p=>p.coverage==='nao_cadastrado'))try{await resolveMunicipalPortal(c,store);}catch(e){discoveryError=e.message;} res.json({...detail(c.cnpj),discoveryError}); }));
  app.get('/api/companies/:cnpj', (req,res,next) => { try { res.json(detail(req.params.cnpj)); } catch(e) { next(e); } });
  app.post('/api/companies/:cnpj/discover', asyncRoute(async (req,res) => { const c = company(req.params.cnpj); res.json(await resolveMunicipalPortal(c,store)); }));
  app.get('/api/registry', (_req,res) => res.json({ states, municipalities: store.all('portal') }));
  app.post('/api/companies/:cnpj/municipal-portal', auth.requireAdmin, asyncRoute(async (req,res) => {
    const c = company(req.params.cnpj); if (c.uf === 'DF') return res.status(400).json({ error: 'Use o fluxo distrital.' });
    const fields = ['url','verifyUrl','sourceUrl']; const urls = {};
    for (const field of fields) { const u = new URL(String(req.body[field] || '')); if (u.protocol !== 'https:' || !u.hostname.endsWith('.gov.br') || u.username || u.password || (u.port && u.port !== '443')) throw Object.assign(new Error('Cadastre URLs HTTPS oficiais terminadas em .gov.br. Portais terceirizados precisam de integração técnica específica.'), { status: 400 }); urls[field] = u.href; }
    const value = { ...urls, municipalityCode: c.municipalityCode, name: `Municipal · ${c.municipality}/${c.uf}`, allowedHosts: [...new Set(Object.values(urls).map(u => new URL(u).hostname))], registeredAt: new Date().toISOString(), registeredBy: req.user.username, review: 'cadastrado_por_operador' };
    store.put('portal', c.municipalityCode, value); store.audit({ type: 'municipal_portal_registered', cnpj:c.cnpj, portal:value },req.user.username); res.json(detail(c.cnpj));
  }));
  app.post('/api/companies/:cnpj/certificates/:portal', express.raw({ type: 'application/pdf', limit: '15mb' }), asyncRoute(async (req,res) => {
    const c = company(req.params.cnpj); const portal = routesFor(c,store).find(p => p.key === req.params.portal && p.required); if (!portal) return res.status(400).json({ error:'Tipo de certidão inválido.' });
    const value = await certificates.ingest({ buffer: req.body, cnpj:c.cnpj, portal, actor:req.user.username }); res.status(201).json(value);
  }));
  app.get('/api/certificates/:id/pdf', (req,res,next) => { const c = store.get('certificate',req.params.id); if (!c) return res.status(404).json({error:'PDF não encontrado.'}); if (!store.intact(c.file)) return res.status(409).json({error:'Falha de integridade: PDF alterado ou ausente.'}); res.type('pdf'); res.set('Content-Disposition',`${req.query.view==='1'?'inline':'attachment'}; filename="${c.portalKey==='federal'?`certidao_federal_${c.cnpj}_${(c.parsed.issuedAt||c.uploadedAt.slice(0,10)).replace(/-/g,'')}`:`${c.cnpj}-${c.portalKey}`}.pdf"`); res.sendFile(store.resolve(c.file.path), e => e && next(e)); });
  app.post('/api/companies/:cnpj/jobs', asyncRoute(async (req,res) => {
    const c = company(req.params.cnpj); let portal = routesFor(c,store).find(p => p.key === req.body.portal && p.required);
    if(portal?.key==='municipal'&&['nao_cadastrado','diretorio_descoberto','diretorio_oficial'].includes(portal.coverage)){await resolveMunicipalPortal(c,store);portal=routesFor(c,store).find(p=>p.key==='municipal');} if (!portal) return res.status(400).json({error:'Portal inválido.'});
    const mode = req.body.mode === 'verify' ? 'verify' : 'issue'; let id = req.body.certificateId || null;
    if(mode==='issue'){
      const cached=certificates.reusable(c.cnpj,portal);
      if(cached){console.info(JSON.stringify({at:new Date().toISOString(),method:'cache_local',portal:portal.key,expiresAt:cached.parsed.expiresAt,remainingDays:cached.remainingDays}));store.audit({type:'certificate_reused',cnpj:c.cnpj,certificateId:cached.id,remainingDays:cached.remainingDays},req.user.username);return res.json({reused:true,certificate:cached,message:`Certidão válida até ${cached.parsed.expiresAt.split('-').reverse().join('/')}: ${cached.remainingDays} dias restantes. Use Abrir PDF / imprimir no anexo do card.`});}
    }
    if (mode === 'verify') { const cert = store.get('certificate',id || ''); if (!cert || cert.cnpj !== c.cnpj || cert.portalKey !== portal.key) return res.status(400).json({error:'Selecione o PDF desta empresa para conferir.'}); }
    res.status(202).json(await jobs.start(c,portal,req.user.username,mode,id));
  }));
  app.use('/api/jobs/:id',(req,res,next)=>{const j=store.get('job',req.params.id);if(j&&j.actor!==req.user.username&&req.user.role!=='admin')return res.status(403).json({error:'Esta consulta pertence a outro usuário.'});next();});
  app.get('/api/jobs/:id', (req,res) => { const j = store.get('job',req.params.id); res.status(j ? 200 : 404).json(j || {error:'Consulta não encontrada.'}); });
  app.post('/api/jobs/:id/focus',asyncRoute(async(req,res)=>res.json(await jobs.focus(req.params.id))));
  app.post('/api/jobs/:id/interaction',asyncRoute(async(req,res)=>res.json(await jobs.interact(req.params.id,req.body))));
  app.get('/api/jobs/:id/preview',asyncRoute(async(req,res)=>{res.type('png').send(await jobs.preview(req.params.id));}));
  app.post('/api/jobs/:id/continue',asyncRoute(async(req,res)=>res.json(await jobs.continue(req.params.id))));
  app.post('/api/jobs/:id/finish', asyncRoute(async (req,res) => res.json(await jobs.finish(req.params.id,req.body.observation))));
  app.post('/api/jobs/:id/cancel', asyncRoute(async (req,res) => res.json(await jobs.cancel(req.params.id))));
  app.get('/api/evidence/:jobId/:index/:kind', (req,res,next) => { const job = store.get('job',req.params.jobId); const evidence = job?.evidence?.[Number(req.params.index)]; const file = req.params.kind === 'image' ? evidence?.screenshot : req.params.kind === 'text' ? evidence?.pageText : null; if (!file) return res.status(404).json({error:'Evidência não encontrada.'}); if (!store.intact(file)) return res.status(409).json({error:'Evidência alterada.'}); res.type(req.params.kind === 'image' ? 'png' : 'text'); res.sendFile(store.resolve(file.path), e => e && next(e)); });
  app.post('/api/companies/:cnpj/reports', asyncRoute(async (req,res) => { const d = detail(req.params.cnpj); res.status(201).json(await createReport({ company:d.company,rows:d.rows,store,actor:req.user.username })); }));
  app.get('/api/reports/:id/:format', (req,res,next) => {
    const report = store.get('report',req.params.id); if (!report) return res.status(404).json({error:'Relatório não encontrado.'});
    if (req.params.format === 'check') return res.json({id:report.id,pdfIntact:store.intact(report.file),receiptIntact:store.intact(report.receipt),audit:store.checkAudit(),sha256:report.file.sha256});
    const file = req.params.format === 'pdf' ? report.file : req.params.format === 'json' ? report.receipt : null; if (!file) return res.status(404).json({error:'Formato inválido.'}); if (!store.intact(file)) return res.status(409).json({error:'Relatório alterado ou ausente.'});
    res.type(req.params.format); res.set('Content-Disposition',`attachment; filename="relatorio-${report.cnpj}-${report.id}.${req.params.format}"`); res.sendFile(store.resolve(file.path), e => e && next(e));
  });
  app.get('/api/audit/check', (_req,res) => res.json(store.checkAudit()));
  app.use('/api', (_req,res) => res.status(404).json({error:'Recurso não encontrado.'}));
  app.get('/', (_req,res) => res.sendFile(path.join(__dirname,'..','public','index.html')));
  app.get('/central-certidoes.html',(_req,res)=>res.redirect('/'));
  app.use(express.static(path.join(__dirname,'..','public'), { index:false, dotfiles:'deny' }));
  app.use((error,_req,res,_next) => { const status = error.status || (error.type === 'entity.too.large' ? 413 : 500); res.status(status).json({error: status === 413 ? 'Arquivo excede o limite permitido.' : userError(error)}); });
  return { app,store,jobs,certificates,detail };
}
function start() {
  const {app,store,jobs} = createApp();
  const organized=store.organizeCertificates();
  if(organized)console.info(JSON.stringify({at:new Date().toISOString(),method:'organizacao_local',documents:organized}));
  for(const job of store.all('job'))if(!['finished','cancelled','error'].includes(job.status)){
    store.put('job',job.id,{...job,status:'cancelled',updatedAt:new Date().toISOString(),message:'O servidor foi reiniciado. Inicie uma nova emissão para abrir a janela do órgão.'});
    store.audit({type:'portal_cancelled',jobId:job.id,cnpj:job.cnpj,reason:'server_restart'},'sistema');
  }
  const port = Number(process.env.PORT || 3030);
  const server=app.listen(port,'127.0.0.1',() => console.log(`Central de Certidões: http://127.0.0.1:${port}`));
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await Promise.allSettled([...jobs.jobs.values()].filter(j=>!['finished','cancelled','error'].includes(j.status)).map(j=>jobs.cancel(j.id,'Sessão encerrada para reiniciar o servidor.')));server.close(()=>process.exit(0));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
module.exports = { createApp,start };
