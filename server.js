const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pdfParse = require('pdf-parse');
const { BrowserManager } = require('./automation/browser');
const { runPortal } = require('./automation/portalRunner');
const portals = require('./config/portals');
const { portalsForCompany, resolvePortalsForCompany } = require('./config/portalResolver');
const { MunicipalPortalResolver, normalize: normalizeMunicipality } = require('./lib/municipal-portal-resolver');
const municipalities = require('./config/municipalities.json').municipalities;

const app = express();
const PORT = process.env.PORT || 3030;
const BASE = __dirname;
const DATA = path.join(BASE, 'data');
// Dados temporários/perfil do navegador continuam dentro da versão para não
// alterar o fluxo de automação já estabilizado. Os PDFs e o índice do arquivo,
// porém, ficam em uma pasta persistente fora da pasta da versão, para não serem
// perdidos ao atualizar/extrair uma nova versão da Central.
const STORAGE_ROOT = process.env.CENTRAL_CERTIDOES_STORAGE || path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'CentralCertidoes'
);
const STORAGE_CERTS = path.join(STORAGE_ROOT, 'certidoes');
const STORAGE_INDEX = path.join(STORAGE_ROOT, 'archive');
const municipalPortalResolver = new MunicipalPortalResolver({
  cacheFile: path.join(STORAGE_ROOT, 'municipal-portals.json')
});
const municipalityCodeByName = new Map(municipalities.map(item => [
  `${normalizeMunicipality(item.name)}:${String(item.uf).toUpperCase()}`,
  String(item.code)
]));

fs.mkdirSync(path.join(DATA, 'certidoes'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
fs.mkdirSync(STORAGE_CERTS, { recursive: true });
fs.mkdirSync(STORAGE_INDEX, { recursive: true });
app.use(express.json({ limit: '2mb' }));
app.get('/', (_,res)=>res.redirect('/central-certidoes.html'));
app.use(express.static(path.join(BASE, 'public')));
app.use('/files', express.static(DATA));
app.use('/archive-files', express.static(STORAGE_CERTS, { fallthrough: false }));

const sessions = new Map();
const { withCancellation, checkCancelled, requestSignal } = require('./automation/cancellation');
const { SessionControl } = require('./automation/session-control');
const sessionControl = new SessionControl(sessions, emit);
const municipalTasks = sessionControl.tasks;
const {DOCUMENT_POLICY}=require('./automation/municipal-print');
const { MunicipalLearning, readFlow, flowKey } = require('./automation/municipal-learning');
const sessionServices = {lookupCompany:cnpj=>lookupCompany(cnpj),resolvePortals:company=>resolvePortalsForCompany(company,{municipalResolver:municipalPortalResolver}),createBrowser:emit=>new BrowserManager(emit),runPortal};

function log(sessionId, event) {
  const line = JSON.stringify({ time: new Date().toISOString(), sessionId, ...event }) + '\n';
  fs.appendFileSync(path.join(DATA, 'logs', `${sessionId}.jsonl`), line);
}

function emit(sessionId, event) {
  const s = sessions.get(sessionId);
  if (!s || (s.status==='stopped' && event.type!=='stopped')) return;
  s.events.push({ time: new Date().toISOString(), ...event });
  log(sessionId, event);
}

function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

function toIsoDate(br) {
  const m = String(br || '').match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function parseCert(text) {
  const raw = String(text || '');
  const upper = raw.toUpperCase().replace(/\s+/g, ' ');

  let status = '';
  if (/POSITIVA\s+COM\s+EFEITOS?\s+DE\s+NEGATIVA/.test(upper)) {
    status = 'positiva_efeito_negativa';
  } else if (/CERTID[ÃA]O\s+NEGATIVA/.test(upper) || /\bNEGATIVA\b/.test(upper)) {
    status = 'negativa';
  } else if (/CERTID[ÃA]O\s+POSITIVA/.test(upper) || /\bPOSITIVA\b/.test(upper)) {
    status = 'positiva';
  } else if (/N[ÃA]O\s+SE\s+ENCONTRA\s+(?:EM\s+)?SITUA[ÇC][ÃA]O\s+REGULAR/.test(upper) || /SITUA[ÇC][ÃA]O\s+IRREGULAR/.test(upper)) {
    status = 'positiva';
  } else if (/EM\s+SITUA[ÇC][ÃA]O\s+REGULAR/.test(upper) || /ENCONTRA-SE\s+REGULAR/.test(upper)) {
    status = 'negativa';
  }

  const allDates = [...upper.matchAll(/\b(\d{2}[\/-]\d{2}[\/-]\d{4})\b/g)].map(m => m[1]);
  let validade = '';
  const validityPatterns = [
    /V[ÁA]LID[AO]?\s+(?:AT[ÉE]|ATÉ|ATE|DE)?\s*[:\-]?\s*(\d{2}[\/-]\d{2}[\/-]\d{4})/,
    /VALIDADE\s*[:\-]?\s*(\d{2}[\/-]\d{2}[\/-]\d{4})/,
    /V[ÁA]LIDA\s+AT[ÉE]\s+(\d{2}[\/-]\d{2}[\/-]\d{4})/
  ];
  for (const re of validityPatterns) {
    const m = upper.match(re);
    if (m) { validade = toIsoDate(m[1]); break; }
  }
  if (!validade && allDates.length) {
    const iso = allDates.map(toIsoDate).filter(Boolean).sort();
    validade = iso[iso.length - 1] || '';
  }

  const interval=upper.match(/VALIDADE\s*:?\s*(\d{2}\/\d{2}\/\d{4})\s+A\s+(\d{2}\/\d{2}\/\d{4})/);
  if(interval) validade=toIsoDate(interval[2]);
  const identifiers=require('./lib/certificate-identifiers').certificateIdentifiers(raw);
  const monthNames=['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const dated=raw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/(?:^|\n)[a-z .'-]+,\s*(\d{1,2}) de (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro) de (\d{4})/);
  const writtenDate=dated?require('./lib/domain').isoDate(dated[1].padStart(2,'0')+'/'+String(monthNames.indexOf(dated[2])+1).padStart(2,'0')+'/'+dated[3]):'';
  return {
    status,
    validade,
    ...identifiers,
    dataEmissao: require('./lib/domain').parseCertificate(raw,'','municipal').issuedAt || writtenDate || '',
    dates: [...new Set(allDates)].slice(0, 12)
  };
}

function fileUrlForPath(filePath) {
  if (!filePath) return '';
  const resolved = path.resolve(filePath);
  const dataRoot = path.resolve(DATA);
  if (!resolved.startsWith(dataRoot + path.sep) && resolved !== dataRoot) return '';
  const rel = path.relative(DATA, resolved).split(path.sep).join('/');
  return '/files/' + rel;
}

app.get('/api/health', (_, res) => res.json({ ok: true, version: require('./package.json').version }));
app.get('/api/portals', (_, res) => res.json(portals));

const cnpjCache = new Map();

async function fetchJsonWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: requestSignal(controller.signal) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function lookupCompany(cnpj) {
  const cached = cnpjCache.get(cnpj);
  if (cached && Date.now() - cached.time < 6 * 60 * 60 * 1000) return cached.data;

  const providers = [
    async () => {
      const r = await fetchJsonWithTimeout(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      if (!r.ok || !r.data?.razao_social) throw new Error(`BrasilAPI ${r.status}`);
      return {
        razao_social: r.data.razao_social || '',
        nome_fantasia: r.data.nome_fantasia || '',
        uf: String(r.data.uf || '').toUpperCase(),
        municipio: r.data.municipio || '',
        municipio_codigo_ibge: String(r.data.codigo_municipio_ibge || ''),
        logradouro: String(r.data.logradouro || '').replace(/^\s*MATRIZ\s+/i, ''),
        numero: r.data.numero || '', complemento: r.data.complemento || '', bairro: r.data.bairro || '', cep: String(r.data.cep || ''),
        fonte: 'BrasilAPI'
      };
    },
    async () => {
      const r = await fetchJsonWithTimeout(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`);
      if (!r.ok || !r.data?.nome) throw new Error(`ReceitaWS ${r.status}`);
      return {
        razao_social: r.data.nome || '',
        nome_fantasia: r.data.fantasia || '',
        uf: String(r.data.uf || '').toUpperCase(),
        municipio: r.data.municipio || '',
        logradouro: String(r.data.logradouro || '').replace(/^\s*MATRIZ\s+/i, ''),
        numero: r.data.numero || '', complemento: r.data.complemento || '', bairro: r.data.bairro || '', cep: String(r.data.cep || ''),
        fonte: 'ReceitaWS'
      };
    }
  ];

  for (const provider of providers) {
    checkCancelled();
    try {
      const data = await provider();
      if (!/^\d{7}$/.test(String(data.municipio_codigo_ibge || ''))) {
        data.municipio_codigo_ibge = municipalityCodeByName.get(
          `${normalizeMunicipality(data.municipio)}:${String(data.uf || '').toUpperCase()}`
        ) || '';
      }
      data.codigo_ibge = data.municipio_codigo_ibge;
      cnpjCache.set(cnpj, { time: Date.now(), data });
      return data;
    } catch (_) {}
  }
  return { razao_social: '', nome_fantasia: '', uf: '', municipio: '', logradouro:'', numero:'', complemento:'', bairro:'', cep:'', fonte: '' };
}


function archivePath(cnpj) { return path.join(STORAGE_INDEX, `${onlyDigits(cnpj)}.json`); }
function readArchive(cnpj) {
  try { return JSON.parse(fs.readFileSync(archivePath(cnpj), 'utf8')); } catch (_) { return { cnpj: onlyDigits(cnpj), updatedAt: null, certificates: {} }; }
}

const canonicalArchiveNames = {
  simples: 'SIMPLES NACIONAL.pdf',
  federal: 'CND FEDERAL.pdf',
  fgts: 'CRF FGTS.pdf',
  trabalhista: 'CND TRABALHISTA.pdf',
  ceara: 'CND ESTADUAL.pdf',
  municipal: 'CND MUNICIPAL.pdf'
};

function persistentPdfUrl(cnpj, relativePath) {
  const safe = String(relativePath || '').split(path.sep).join('/');
  return `/archive-files/${onlyDigits(cnpj)}/${safe}`;
}

function writeArchive(cnpj, portalKey, sourceFilePath, parsed, captureStage, provenance = {}) {
  const archive = readArchive(cnpj);
  const key = String(portalKey).startsWith('estadual-') ? 'ceara' : portalKey;
  const digits = onlyDigits(cnpj);
  const dateDir = new Date().toISOString().slice(0, 10);
  const destDir = path.join(STORAGE_CERTS, digits, dateDir);
  fs.mkdirSync(destDir, { recursive: true });
  const captureId=require('node:crypto').randomUUID();
  const canonicalName = canonicalArchiveNames[key] || path.basename(sourceFilePath || 'CERTIDAO.pdf');
  const fileName = canonicalName.replace(/\.pdf$/i, '-' + captureId + '.pdf');
  const persistentPath = path.join(destDir, fileName);

  if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
    throw new Error('O PDF capturado não foi encontrado para arquivamento permanente.');
  }
  // Copia, em vez de mover, para não interferir no fluxo já estabilizado do portal.
  const temporaryPath = persistentPath + '.part';
  fs.copyFileSync(sourceFilePath, temporaryPath);
  const head = fs.readFileSync(temporaryPath).subarray(0, 5).toString('ascii');
  if (head !== '%PDF-') {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    throw new Error('O arquivo capturado não possui estrutura de PDF válida.');
  }

  fs.renameSync(temporaryPath, persistentPath);
  archive.history ||= [];
  if (archive.certificates[key] && archive.certificates[key].filePath !== persistentPath) archive.history.push(archive.certificates[key]);
  archive.updatedAt = new Date().toISOString();
  archive.certificates[key] = {
    portal: key,
    captureStage: captureStage || '',
    ...provenance,
    captureId,
    source: provenance.source || 'controlled_browser',
    officialPortal: provenance.officialPortal === true,
    sha256: require('./automation/capture-provenance').hash(fs.readFileSync(persistentPath)),
    dataEmissao: parsed?.dataEmissao || '',
    simei: parsed?.simei || '',
    dataConsulta: parsed?.dataConsulta || '',
    chaveConsulta: parsed?.chaveConsulta || '',
    status: parsed?.status || '',
    validade: parsed?.validade || '',
    numero: parsed?.numero || '',
    filePath: persistentPath,
    fileUrl: persistentPdfUrl(digits, path.join(dateDir, fileName)),
    viewUrl: `/api/archive/${digits}/${key}/pdf`,
    downloadUrl: `/api/archive/${digits}/${key}/download`,
    fileName,
    archivedAt: new Date().toISOString()
  };
  fs.writeFileSync(persistentPath+'.capture.json',JSON.stringify(archive.certificates[key],null,2),{flag:'wx'});
  fs.writeFileSync(archivePath(cnpj) + '.tmp', JSON.stringify(archive, null, 2));
  fs.renameSync(archivePath(cnpj) + '.tmp', archivePath(cnpj));
  return archive.certificates[key];
}

app.get('/api/archive/:cnpj', async (req, res) => {
  const cnpj = onlyDigits(req.params.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido.' });
  const archive = readArchive(cnpj);
  // Recupera metadados ausentes sem alterar o PDF ou sobrescrever correções manuais.
  for (const cert of Object.values(archive.certificates || {})) {
    if (cert.portal!=='simples' && cert.filePath && fs.existsSync(cert.filePath)) {
      try {
        const extracted=parseCert((await pdfParse(fs.readFileSync(cert.filePath))).text);
        for(const field of ['numero','chaveConsulta'])cert[field]=extracted[field]||'';
        if(!cert.dataEmissao)cert.dataEmissao=extracted.dataEmissao||'';
      } catch (_) {}
    }
  }
  for(const cert of Object.values(archive.certificates||{})){
    cert.integrity=cert.sha256&&cert.filePath&&fs.existsSync(cert.filePath)?require('./automation/capture-provenance').hash(fs.readFileSync(cert.filePath))===cert.sha256:null;
  }
  res.json(archive);
});


function getArchivedCertificate(cnpj, portal) {
  const archive = readArchive(cnpj);
  const key = String(portal).startsWith('estadual-') ? 'ceara' : portal;
  const cert = archive.certificates?.[key];
  if (!cert?.filePath || !fs.existsSync(cert.filePath)) return null;
  return cert;
}

function archiveKeyForPortal(portalKey) {
  return String(portalKey).startsWith('estadual-') ? 'ceara' : portalKey;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isCertificateCurrent(cert) {
  if (!cert?.filePath || !fs.existsSync(cert.filePath)) return false;
  if (!cert.validade) return false;
  const raw = String(cert.validade).trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? raw
    : (raw.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/) || []).slice(1).reverse().join('-');
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) && normalized >= todayIso();
}

function reuseEventForCertificate(portal, cert) {
  return {
    type: 'pdf_archived',
    portal: portal.key,
    status: cert.status || '',
    validade: cert.validade || '',
    numero: cert.numero || '',
    filePath: cert.filePath,
    fileUrl: cert.fileUrl || '',
    viewUrl: cert.viewUrl || cert.fileUrl || '',
    downloadUrl: cert.downloadUrl || cert.fileUrl || '',
    fileName: cert.fileName || '',
    archivedAt: cert.archivedAt || '',
    source: cert.source || '',
    chaveConsulta: cert.chaveConsulta || '',
    officialPortal: cert.officialPortal ?? null,
    sourceUrl: cert.sourceUrl || '',
    reused: true
  };
}

app.get('/api/archive/:cnpj/:portal/pdf', (req, res) => {
  const cnpj = onlyDigits(req.params.cnpj);
  if (cnpj.length !== 14) return res.status(400).send('CNPJ inválido.');
  const cert = getArchivedCertificate(cnpj, req.params.portal);
  if (!cert) return res.status(404).send('PDF arquivado não encontrado.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${String(cert.fileName || 'CERTIDAO.pdf').replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.resolve(cert.filePath));
});

app.get('/api/archive/:cnpj/:portal/download', (req, res) => {
  const cnpj = onlyDigits(req.params.cnpj);
  if (cnpj.length !== 14) return res.status(400).send('CNPJ inválido.');
  const cert = getArchivedCertificate(cnpj, req.params.portal);
  if (!cert) return res.status(404).send('PDF arquivado não encontrado.');
  res.download(path.resolve(cert.filePath), cert.fileName || 'CERTIDAO.pdf');
});

require('./interface-api')({app,express,fs,path,STORAGE_ROOT,STORAGE_CERTS,STORAGE_INDEX,readArchive,archivePath,parseCert,pdfParse});

app.get('/api/cnpj/:cnpj', async (req, res) => {
  const cnpj = onlyDigits(req.params.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido.' });
  const data = await lookupCompany(cnpj);
  if (data.razao_social || data.nome_fantasia) return res.json(data);
  res.status(502).json({ error: 'Não foi possível consultar os dados cadastrais agora. Você pode continuar e informar a razão social manualmente.' });
});

app.post('/api/session', async (req, res) => {
  const cnpj = onlyDigits(req.body.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ deve conter 14 dígitos.' });
  if (sessionControl.activeId) {
    const active = sessions.get(sessionControl.activeId);
    const lastEvent = active?.events?.length ? active.events[active.events.length - 1] : null;
    const lastAt = Date.parse(lastEvent?.time || active?.startedAt || 0);
    // Recupera sessões abandonadas por fechamento do navegador/terminal.
    // Uma consulta ativa normal sempre produz eventos em menos de cinco minutos.
    if (!active || active.status !== 'running') {
      sessionControl.release(sessionControl.activeId);
    } else if (!municipalTasks.has(sessionControl.activeId) && (!lastAt || Date.now()-lastAt>5*60*1000)) {
      await sessionControl.stop(sessionControl.activeId);
    } else {
      return res.status(409).json({ error: 'Já existe uma consulta em andamento. Aguarde sua conclusão.' });
    }
  }
  if(sessionControl.activeId)return res.status(409).json({error:'Já existe uma consulta em andamento.'});
  const requestedId=String(req.body.sessionId||'');
  if(requestedId&&!/^[a-z0-9-]{10,100}$/i.test(requestedId))return res.status(400).json({error:'Identificador de consulta inválido.'});
  const id = requestedId || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  if(sessions.has(id))return res.status(409).json({error:'Esta consulta já foi iniciada.'});
  const company = {};
  sessions.set(id, {
    id,
    cnpj,
    razaoSocial: req.body.razaoSocial || company.razao_social || '',
    company,
    status: 'running',
    startedAt: new Date().toISOString(),
    events: []
  });
  sessionControl.activeId = id;
  const startupController=new AbortController();sessionControl.controllers.set(id,startupController);
  Object.assign(company,await withCancellation(startupController.signal,()=>sessionServices.lookupCompany(cnpj)).catch(()=>({uf:'',municipio:''})));
  if(sessions.get(id).status!=='running')return res.status(409).json({error:'Consulta cancelada.'});
  sessions.get(id).razaoSocial ||= company.razao_social || '';
  let portalResolution;
  try { portalResolution = await withCancellation(startupController.signal,()=>sessionServices.resolvePortals(company)); }
  catch(error) { if(sessions.get(id)?.status==='stopped')return res.status(409).json({error:'Consulta cancelada.'});sessions.delete(id);if(sessionControl.activeId===id)sessionControl.activeId=null;return res.status(502).json({error:'Não foi possível identificar os portais agora. Tente novamente. '+error.message}); }
  if(sessions.get(id)?.status!=='running')return res.status(409).json({error:'Consulta cancelada.'});
  let sessionPortals = portalResolution.portals;
  const certificateKey = String(req.body.certificateKey || '');
  if (certificateKey) {
    const selectedPortal = sessionPortals.find(portal => (portal.key.startsWith('estadual-') ? 'ceara' : portal.key) === certificateKey);
    if (!selectedPortal) {
      sessionControl.release(id); sessions.delete(id);
      return res.status(400).json({
        error:'O portal desta certidão não foi identificado para a empresa consultada.',
        status: certificateKey === 'municipal' ? portalResolution.municipalResolution.status : 'PORTAL_NAO_CADASTRADO',
        municipalResolution: portalResolution.municipalResolution
      });
    }
    sessionPortals = [selectedPortal];
  }
  sessions.get(id).portals = sessionPortals;
  sessions.get(id).municipalResolution = portalResolution.municipalResolution;
  res.json({ sessionId: id, company, municipalResolution: portalResolution.municipalResolution, portals: sessionPortals.map(p => ({ key: p.key, name: p.name })) });
  runSession(id).catch(err => {const session=sessions.get(id);if(session&&session.status!=='stopped')session.status='error';if(sessionControl.activeId===id)sessionControl.activeId=null;emit(id, { type: 'error', message: err.message });});
});

app.post('/api/session/:id/resume', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({error:'Sessão não encontrada.'});
  if (sessionControl.activeId !== req.params.id || session.status !== 'running') return res.status(409).json({error:'Esta sessão não está ativa.'});
  const task = municipalTasks.get(req.params.id);
  if (task) {
    try { return res.json(await task.learner.continue()); }
    catch (error) { return res.status(error.status || 409).json({error:error.message}); }
  }
  if(req.body?.portal==='municipal') return res.json({ok:true,completed:session.events.some(e=>e.type==='portal_done'&&e.portal==='municipal')});
  sessionControl.browsers.get(req.params.id)?.resume();
  emit(req.params.id, {type:'user_resumed'});
  res.json({ok:true});
});

app.post('/api/session/:id/stop', async (req,res) => {
  try { res.json(await sessionControl.stop(req.params.id)); }
  catch(error) { res.status(error.status || 500).json({error:error.message}); }
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada.' });
  res.json(s);
});

app.post('/api/report/pdf',async(req,res)=>{
  if(typeof req.body?.html!=='string'||req.body.html.length>200000)return res.status(400).json({error:'Relatório inválido.'});
  try{const pdf=await require('./lib/report-pdf').renderReportPdf(req.body.html);res.type('application/pdf').set('Content-Disposition','inline; filename="Central-de-certidoes-Horizonte.pdf"').send(pdf);}catch(error){res.status(500).json({error:'Não foi possível gerar o relatório em PDF.'});}
});

app.post('/api/parse-pdf', async (req, res) => {
  const file = req.body.filePath;
  if (!file || !path.resolve(file).startsWith(path.resolve(DATA))) return res.status(400).json({ error: 'Arquivo inválido.' });
  const buffer = fs.readFileSync(file);
  const data = await pdfParse(buffer);
  res.json({ text: data.text, parsed: parseCert(data.text) });
});

async function runSession(id) {
  const s = sessions.get(id);
  if (sessionControl.activeId !== id) return;
  const browserManager = sessionServices.createBrowser(e=>emit(id,e));
  sessionControl.browsers.set(id,browserManager);
  s.failures = [];
  const archive = readArchive(s.cnpj);
  const uf = String(s.company?.uf || '').toUpperCase();
  emit(id, {
    type: 'company_state_detected',
    uf,
    municipio: s.company?.municipio || '',
    message: uf ? `UF cadastral identificada: ${uf}` : 'Não foi possível identificar a UF cadastral automaticamente.'
  });
  emit(id, {
    type: 'municipal_resolution',
    status: s.municipalResolution?.status || 'PORTAL_NAO_CADASTRADO',
    portal: s.municipalResolution?.certidao_url || '',
    provider: s.municipalResolution?.provider || '',
    message: s.municipalResolution?.status === 'PORTAL_ENCONTRADO'
      ? `Portal municipal identificado para ${s.company?.municipio || 'o município cadastrado'}.`
      : `Portal municipal: ${s.municipalResolution?.status || 'PORTAL_NAO_CADASTRADO'}.`
  });
  for (const configuredPortal of (s.portals || portalsForCompany(s.company))) {
    const portal = configuredPortal.key === 'federal' ? {...configuredPortal, captchaTimeout: 120000} : configuredPortal;
    if (s.status === 'stopped') break;
    emit(id, { type: 'portal_start', portal: portal.key, name: portal.name });
    const archiveKey = archiveKeyForPortal(portal.key);
    const existing = archive.certificates?.[archiveKey];
    const municipalityLearned = portal.key !== 'municipal' || (existing?.documentValidation===DOCUMENT_POLICY && !!readFlow(STORAGE_ROOT,flowKey(s.company,portal.url)));
    let existingMatches=false;
    if(existing?.filePath&&fs.existsSync(existing.filePath)){try{const bytes=fs.readFileSync(existing.filePath);require('./lib/capture-validation').validateCapture((await pdfParse(bytes)).text,s.cnpj,portal.key);existingMatches=!existing.sha256||require('./automation/capture-provenance').hash(bytes)===existing.sha256;}catch(error){emit(id,{type:'archive_rejected',portal:portal.key,message:error.message});}}
    if (portal.key !== 'simples' && existingMatches && municipalityLearned && isCertificateCurrent(existing) && (portal.key !== 'fgts' || existing.source === 'manual' || existing.captureStage === 'fgts-print-view')) {
      emit(id, {
        type: 'portal_reused',
        portal: portal.key,
        name: portal.name,
        validade: existing.validade,
        message: `${portal.name} já está válida no arquivo até ${existing.validade}.`
      });
      emit(id, { type: 'portal_done', portal: portal.key, filePath: existing.filePath, fileUrl: existing.fileUrl, reused: true });
      emit(id, reuseEventForCertificate(portal, existing));
      emit(id, { type: 'pdf_parsed', portal: portal.key, parsed: { status: existing.status || '', validade: existing.validade || '', numero: existing.numero || '' }, filePath: existing.filePath, fileUrl: existing.fileUrl, viewUrl: existing.viewUrl || existing.fileUrl, downloadUrl: existing.downloadUrl || existing.fileUrl, fileName: existing.fileName });
      continue;
    }
    if (portal.key === 'estadual-ce' && uf !== 'CE') {
      const message = uf
        ? `CNPJ cadastrado na UF ${uf}. A automação estadual do Ceará foi ignorada para não emitir certidão do estado errado.`
        : 'UF cadastral não identificada. A automação estadual do Ceará foi ignorada para não emitir certidão do estado errado.';
      s.failures.push({ portal: portal.key, message });
      emit(id, { type: 'portal_error', portal: portal.key, message });
      emit(id, { type: 'portal_skipped', portal: portal.key, message });
      continue;
    }
    try {
      let result;
      if (portal.key === 'municipal') {
        // Only a successfully demonstrated municipal workflow may run automatically.
        // Install the task before opening Chrome so Continue/Stop target this session.
        const learner = new MunicipalLearning({
          root:STORAGE_ROOT,browser:browserManager,portal,company:s.company,cnpj:s.cnpj,
          emit:e=>{s.municipalState=e.state||s.municipalState;emit(id,e);},
          onCapture:async capture=>{
            if(s.status!=='running')throw Error('Consulta encerrada antes do arquivamento.');
            const parsed=parseCert(capture.text);
            parsed.status=({negativa:'negativa',positiva:'positiva',positiva_efeitos_negativa:'positiva_efeito_negativa'})[capture.parsed.classification]||'';
            parsed.validade=capture.parsed.expiresAt||'';
            parsed.numero=capture.parsed.number||parsed.numero;
            parsed.chaveConsulta=capture.parsed.controlCode||parsed.chaveConsulta;
            parsed.dataEmissao=capture.parsed.issuedAt||parsed.dataEmissao;
            const archived=writeArchive(s.cnpj,'municipal',capture.filePath,parsed,'municipal-captured',{
              officialPortal:capture.officialPortal,source:'controlled_browser',sourceUrl:capture.url,
              captureMethod:capture.method,documentValidation:capture.documentValidation,
              sessionId:id,capturedAt:new Date().toISOString(),sha256:capture.sha256,municipality:s.company.municipio,municipalityCode:s.company.municipio_codigo_ibge,
              extractionWarning:capture.parsed.warnings.join(' ')
            });
            emit(id,{type:'pdf_archived',...archived});
            emit(id,{type:'pdf_parsed',portal:'municipal',parsed,...archived});
            return archived;
          }
        });
        municipalTasks.set(id,{learner});
        try {
          const completed=await learner.run();
          if(s.status==='stopped')break;
          emit(id,{type:'portal_done',portal:'municipal',filePath:completed.archived.filePath,fileUrl:completed.archived.fileUrl,message:completed.learned.learningStatus==='saved'?'Consulta municipal concluída. PDF salvo e roteiro registrado.':'Consulta municipal concluída. PDF salvo; o roteiro ainda precisa de uma demonstração com preenchimento do CNPJ.'});
        } finally { municipalTasks.delete(id); }
        continue;
      } else result = await browserManager.abortable(withCancellation(browserManager.signal,()=>sessionServices.runPortal({ portal, cnpj: s.cnpj, browser: browserManager, baseDir: BASE, emit: e => emit(id, e) })));
      if (s.status === 'stopped') break;
      if (!result?.filePath) throw new Error('Nenhum PDF foi capturado nesta etapa.');
      const fileUrl = fileUrlForPath(result.filePath);

      if (result.filePath) {
        try {
          const buffer = fs.readFileSync(result.filePath);
          const text = (await require('./lib/certificates').extractPdf(buffer)).text;
          if(s.status==='stopped')break;
          require('./lib/capture-validation').validateCapture(text,s.cnpj,portal.key);
          const parsed = portal.key==='simples'?require('./lib/simples').parseSimples(text,s.cnpj):parseCert(text);
          if(portal.key==='simples'){parsed.dataConsulta=require('./lib/domain').today();parsed.dataEmissao=parsed.dataConsulta;}
          if(portal.key==='municipal'){const checked=require('./lib/domain').parseCertificate(text,s.cnpj,'municipal');parsed.status=({negativa:'negativa',positiva:'positiva',positiva_efeitos_negativa:'positiva_efeito_negativa'})[checked.classification]||'';parsed.validade=checked.expiresAt||'';}
          const archived = writeArchive(s.cnpj, portal.key, result.filePath, parsed, result.captureStage, {...result.provenance,sessionId:id});
          emit(id, { type: 'portal_done', portal: portal.key, filePath: archived.filePath, fileUrl: archived.fileUrl });
          emit(id, { type: 'pdf_archived', portal: portal.key, ...archived });
          emit(id, { type: 'pdf_parsed', portal: portal.key, parsed, filePath: archived.filePath, fileUrl: archived.fileUrl, viewUrl: archived.viewUrl, downloadUrl: archived.downloadUrl, fileName: archived.fileName });
        } catch (e) {
          throw new Error('PDF capturado, mas não foi possível ler/arquivar: ' + e.message);
        }
      }
    } catch (e) {
      if (s.status === 'stopped') break;
      s.failures.push({portal:portal.key, message:e.message});
      emit(id, { type: 'portal_error', portal: portal.key, message: e.message });
      emit(id, { type: 'portal_skipped', portal: portal.key, message: 'Certidão pendente nesta consulta. A Central seguirá para a próxima etapa.' });

    }
  }
  if (s.status !== 'stopped') s.status = s.failures.length ? 'partial' : 'done';
  emit(id, { type: 'complete', status:s.status, failures:s.failures });
  if (sessionControl.activeId === id) sessionControl.activeId = null;
}

app.get('*', (_, res) => res.sendFile(path.join(BASE, 'public', 'central-certidoes.html')));
if (require.main === module) {
  const server=app.listen(PORT, () => console.log(`Central de Certidões ${require('./package.json').version}: http://localhost:${PORT}`));
  let stopping=false;
  const shutdown=async()=>{
    if(stopping)return;stopping=true;
    for(const {learner} of municipalTasks.values())learner.stop('Servidor encerrado. Os PDFs já arquivados foram preservados.');
    await Promise.allSettled([...sessionControl.browsers.keys()].map(id=>sessionControl.stop(id)));
    server.close(()=>process.exit(0));
    setTimeout(()=>process.exit(0),5000).unref();
  };
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
module.exports={app,parseCert,writeArchive,readArchive,sessionControl,sessionServices};
