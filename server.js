const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pdfParse = require('pdf-parse');
const { prepareArchiveStorage, defaultArchiveRoots, ensureCompanyArchiveDirectory } = require('./lib/archive-storage');
const { BrowserManager } = require('./automation/browser');
const { runPortal } = require('./automation/portalRunner');
const portals = require('./config/portals');
const { portalsForCompany, resolvePortalsForCompany } = require('./config/portalResolver');
const { MunicipalPortalResolver, normalize: normalizeMunicipality } = require('./lib/municipal-portal-resolver');
const municipalities = require('./config/municipalities.json').municipalities;

const app = express();
const PORT = process.env.PORT || 3031;
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
const municipalPortalResolver = new MunicipalPortalResolver({
  cacheFile: path.join(DATA, 'municipal-portals.json')
});
const municipalityCodeByName = new Map(municipalities.map(item => [
  `${normalizeMunicipality(item.name)}:${String(item.uf).toUpperCase()}`,
  String(item.code)
]));

fs.mkdirSync(path.join(DATA, 'certidoes'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'logs'), { recursive: true });
const archiveStorage = prepareArchiveStorage(STORAGE_ROOT, defaultArchiveRoots(STORAGE_ROOT));
let STORAGE_CERTS = archiveStorage.certs;
let STORAGE_INDEX = archiveStorage.index;
const ACTIVE_STORAGE_ROOT = archiveStorage.root;
if (ACTIVE_STORAGE_ROOT !== STORAGE_ROOT) {
  console.warn(`[STORAGE] Pasta principal sem permissão (${STORAGE_ROOT}); usando armazenamento gravável: ${ACTIVE_STORAGE_ROOT}`);
}
console.log(`[STORAGE] PDFs e índice: ${ACTIVE_STORAGE_ROOT}`);
app.use(express.json({ limit: '2mb' }));
app.get('/', (_,res)=>res.redirect('/central-certidoes.html'));
app.use(express.static(path.join(BASE, 'public')));
app.use('/files', express.static(DATA));
app.use('/archive-files', (req, res, next) => {
  let relative;
  try { relative = decodeURIComponent(req.path).replace(/^[/\\]+/, ''); } catch (_) { return res.sendStatus(400); }
  const roots = [STORAGE_CERTS, path.join(STORAGE_ROOT, 'certidoes'), ...defaultArchiveRoots(STORAGE_ROOT).map(root => path.join(root, 'certidoes'))];
  for (const root of [...new Set(roots)]) {
    const resolvedRoot = path.resolve(root);
    const candidate = path.resolve(resolvedRoot, relative);
    const relation = path.relative(resolvedRoot, candidate);
    if (!relation || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) continue;
    try { if (fs.statSync(candidate).isFile()) return res.sendFile(candidate); } catch (_) {}
  }
  next();
});
app.use('/archive-files', express.static(STORAGE_CERTS, { fallthrough: false }));

const sessions = new Map();
let browserManager;
let activeSessionId = null;

function log(sessionId, event) {
  const line = JSON.stringify({ time: new Date().toISOString(), sessionId, ...event }) + '\n';
  fs.appendFileSync(path.join(DATA, 'logs', `${sessionId}.jsonl`), line);
}

function emit(sessionId, event) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.events.push({ time: new Date().toISOString(), ...event });
  log(sessionId, event);
}

function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

function toIsoDate(br) {
  const m = String(br || '').replace(/\s+/g, '').match(/^(\d{2})[\/.\-](\d{2})[\/.\-](\d{4})$/);
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

  const allDates = [...upper.matchAll(/\b(\d{2}\s*[\/.\-]\s*\d{2}\s*[\/.\-]\s*\d{4})\b/g)].map(m => m[1]);
  let validade = '';
  const validityPatterns = [
    /V[ÁA]LID[AO]?\s+(?:AT[ÉE]|ATÉ|ATE|DE)?\s*[:\-]?\s*(\d{2}\s*[\/.\-]\s*\d{2}\s*[\/.\-]\s*\d{4})/,
    /VALIDADE\s*[:\-]?\s*(\d{2}\s*[\/.\-]\s*\d{2}\s*[\/.\-]\s*\d{4})/,
    /V[ÁA]LIDA\s+AT[ÉE]\s+(\d{2}\s*[\/.\-]\s*\d{2}\s*[\/.\-]\s*\d{4})/
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
  let numero = '';
  const numPatterns = [
    /CERTID[ÃA]O\s+NEGATIVA\s+DE\s+D[ÉE]BITOS\s+ESTADUAIS\s+([0-9]{10,20})\b/,
    /CERTIFICA[ÇC][ÃA]O\s+N[ÚU]MERO\s*:?\s*([0-9]{10,30})/,
    /CERTIFICADO\s+N[ÚU]MERO\s*:?\s*([0-9]{10,30})/,
    /C[ÓO]DIGO\s*DE\s*CONTROLE(?:\s*DA\s*CERTID[ÃA]O)?\s*[:\-]?\s*([0-9A-Z]{2,8}(?:[.\-][0-9A-Z]{2,8}){1,6})/,
    /CERTID[ÃA]O\s*N[ºO°]\s*[:.]?\s*([0-9A-Z.\/-]{4,30})/,
    /N[ºO°]\s*DA\s*CERTID[ÃA]O\s*[:.]?\s*([0-9A-Z.\/-]{4,30})/
  ];
  for (const re of numPatterns) {
    const m = upper.match(re);
    if (m) { numero = m[1].trim(); break; }
  }

  return {
    status,
    validade,
    numero,
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

app.get('/api/health', (_, res) => res.json({ ok: true, version: '2.9.3.11' }));
app.get('/api/portals', (_, res) => res.json(portals));
app.get('/api/portal/:cnpj/:key', async (req,res,next) => {
  try {
    const cnpj=onlyDigits(req.params.cnpj),key=String(req.params.key||'');
    if(cnpj.length!==14)return res.status(400).json({error:'CNPJ inválido.'});
    const fixed=portals.find(item=>item.key===key);
    if(fixed&&key!=='estadual-ce')return res.json({url:fixed.url,name:fixed.name,provider:'oficial'});
    const company=await lookupCompany(cnpj);
    if(key==='ceara'||key.startsWith('estadual')){
      if(!company.uf)return res.status(422).json({error:'Não foi possível identificar a UF do CNPJ para abrir o portal estadual correto.'});
      const portal=portalsForCompany(company).find(item=>item.key.startsWith('estadual-')||item.key==='estadual');
      if(!portal?.url)return res.status(404).json({error:'Portal estadual não configurado para a UF identificada.'});
      return res.json({url:portal.url,name:portal.name,provider:'oficial',municipio:company.municipio,uf:company.uf});
    }
    if(key!=='municipal')return res.status(400).json({error:'Tipo de certidão inválido.'});
    if(!company.uf||!company.municipio)return res.status(422).json({error:'Não foi possível identificar município e UF para localizar o portal oficial.'});
    const resolution=await resolvePortalsForCompany(company,{municipalResolver:municipalPortalResolver});
    const portal=resolution.portals.find(item=>(item.key.startsWith('estadual-')?'ceara':item.key)===key);
    if(!portal?.url)return res.status(404).json({error:'O endereço oficial desta certidão não está disponível para a empresa.'});
    res.json({url:portal.url,name:portal.name,provider:portal.provider||'',municipio:company.municipio,uf:company.uf});
  }catch(error){next(error);}
});

const cnpjCache = new Map();

async function fetchJsonWithTimeout(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
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
  const digits = onlyDigits(cnpj);
  const candidateIndexes = [
    STORAGE_INDEX,
    path.join(STORAGE_ROOT, 'archive'),
    ...defaultArchiveRoots(STORAGE_ROOT).map(root => path.join(root, 'archive'))
  ];
  for (const index of [...new Set(candidateIndexes)]) {
    try { return JSON.parse(fs.readFileSync(path.join(index, `${digits}.json`), 'utf8')); } catch (_) {}
  }
  return { cnpj: digits, updatedAt: null, certificates: {} };
}

const canonicalArchiveNames = {
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

function writeArchive(cnpj, portalKey, sourceFilePath, parsed, captureStage) {
  const digits = onlyDigits(cnpj);
  const dateDir = new Date().toISOString().slice(0, 10);
  const selectedStorage = ensureCompanyArchiveDirectory(archiveStorage.root, defaultArchiveRoots(STORAGE_ROOT), digits, dateDir);
  STORAGE_CERTS = selectedStorage.certs;
  STORAGE_INDEX = selectedStorage.index;
  const archive = readArchive(cnpj);
  const key = String(portalKey).startsWith('estadual-') ? 'ceara' : portalKey;
  const destDir = selectedStorage.destination;
  const fileName = canonicalArchiveNames[key] || path.basename(sourceFilePath || 'CERTIDAO.pdf');
  const persistentPath = path.join(destDir, fileName);

  if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
    throw new Error('O PDF capturado não foi encontrado para arquivamento permanente.');
  }
  // Copia, em vez de mover, para não interferir no fluxo já estabilizado do portal.
  fs.copyFileSync(sourceFilePath, persistentPath);
  const head = fs.readFileSync(persistentPath).subarray(0, 5).toString('ascii');
  if (head !== '%PDF-') {
    try { fs.unlinkSync(persistentPath); } catch (_) {}
    throw new Error('O arquivo capturado não possui estrutura de PDF válida.');
  }

  archive.updatedAt = new Date().toISOString();
  archive.certificates[key] = {
    portal: key,
    captureStage: captureStage || '',
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
  const indexFile = archivePath(cnpj);
  const temporaryIndex = `${indexFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryIndex, JSON.stringify(archive, null, 2));
  fs.renameSync(temporaryIndex, indexFile);
  return archive.certificates[key];
}

app.get('/api/archive/:cnpj', async (req, res) => {
  const cnpj = onlyDigits(req.params.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido.' });
  const archive = readArchive(cnpj);
  // Recupera metadados ausentes sem alterar o PDF ou sobrescrever correções manuais.
  for (const cert of Object.values(archive.certificates || {})) {
    if (!cert.numero && cert.filePath && fs.existsSync(cert.filePath)) {
      try {
        cert.numero = parseCert((await pdfParse(fs.readFileSync(cert.filePath))).text).numero || '';
      } catch (_) {}
    }
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

app.get('/api/cnpj/:cnpj', (req, res, next) => Promise.resolve().then(async () => {
  const cnpj = onlyDigits(req.params.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ inválido.' });
  const data = await lookupCompany(cnpj);
  if (data.razao_social || data.nome_fantasia) return res.json(data);
  res.status(502).json({ error: 'Não foi possível consultar os dados cadastrais agora. Você pode continuar e informar a razão social manualmente.' });
}).catch(next));

app.post('/api/session', (req, res, next) => { Promise.resolve().then(async () => {
  const cnpj = onlyDigits(req.body.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ deve conter 14 dígitos.' });
  if (activeSessionId) {
    const active = sessions.get(activeSessionId);
    const lastEvent = active?.events?.length ? active.events[active.events.length - 1] : null;
    const lastAt = Date.parse(lastEvent?.time || active?.startedAt || 0);
    // Recupera sessões abandonadas por fechamento do navegador/terminal.
    // Uma consulta ativa normal sempre produz eventos em menos de cinco minutos.
    if (active && active.status === 'running' && (!lastAt || Date.now() - lastAt > 5 * 60 * 1000)) {
      active.status = 'stopped';
      activeSessionId = null;
      await browserManager?.close().catch(() => {});
      browserManager = null;
    } else {
      return res.status(409).json({ error: 'Já existe uma consulta em andamento. Aguarde sua conclusão.' });
    }
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const company = await lookupCompany(cnpj).catch(() => ({ uf: '', municipio: '' }));
  sessions.set(id, {
    id,
    cnpj,
    razaoSocial: req.body.razaoSocial || company.razao_social || '',
    company,
    status: 'running',
    startedAt: new Date().toISOString(),
    events: []
  });
  const certificateKey = String(req.body.certificateKey || '');
  activeSessionId = id;
  let portalResolution;
  let sessionPortals;
  if (certificateKey && certificateKey !== 'municipal') {
    // Consultas individuais de órgãos não municipais começam sem esperar a
    // descoberta de prefeitura, que pode depender de vários sites externos.
    sessionPortals = portalsForCompany(company);
    portalResolution = { municipalResolution: { status: 'DESCOBERTA_MUNICIPAL_ADIADA' } };
  } else if (certificateKey === 'municipal') {
    portalResolution = await resolvePortalsForCompany(company, { municipalResolver: municipalPortalResolver });
    sessionPortals = portalResolution.portals;
  } else {
    sessionPortals = portalsForCompany(company);
    portalResolution = { municipalResolution: { status: 'DESCOBERTA_MUNICIPAL_ADIADA' } };
    if (!sessionPortals.some(portal => portal.key === 'municipal')) {
      sessionPortals.push({ key: 'municipal', name: 'Certidão Municipal', shortName: 'Municipal', deferredDiscovery: true });
    }
  }
  if (certificateKey) {
    const selectedPortal = sessionPortals.find(portal => (portal.key.startsWith('estadual-') ? 'ceara' : portal.key) === certificateKey);
    if (!selectedPortal) {
      activeSessionId = null; sessions.delete(id);
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
  runSession(id).catch(async err => {
    const session = sessions.get(id);
    if (session) {
      session.failures ||= [];
      session.failures.push({ portal: session.currentPortal || '', message: err.message });
      if (session.status !== 'stopped') session.status = 'error';
      emit(id, { type: 'error', portal: session.currentPortal || '', message: err.message });
      emit(id, { type: 'complete', status: session.status, failures: session.failures });
    }
    if (activeSessionId === id) activeSessionId = null;
    await browserManager?.close().catch(() => {});
    browserManager = null;
  });
}).catch(error => {
  const pendingId = activeSessionId;
  const pending = pendingId && sessions.get(pendingId);
  if (pending && !pending.portals) {
    pending.status = 'error';
    pending.failures = [{ portal: '', message: error.message }];
    emit(pendingId, { type: 'error', message: error.message });
    emit(pendingId, { type: 'complete', status: 'error', failures: pending.failures });
    sessions.delete(pendingId);
  }
  activeSessionId = null;
  next(error);
}); });

app.post('/api/session/:id/resume', (req, res) => {
  if (!sessions.has(req.params.id)) return res.status(404).json({ error: 'Sessão não encontrada.' });
  browserManager?.resume();
  emit(req.params.id, { type: 'user_resumed' });
  res.json({ ok: true });
});

app.post('/api/session/:id/stop', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada.' });
  s.status = 'stopped';
  emit(req.params.id, { type: 'stopped' });
  res.json({ ok: true });
  const manager = browserManager;
  manager?.resume();
  if (manager) {
    browserManager = null;
    manager.close().catch(error => console.warn(`[SESSION] close after stop: ${error.message}`));
  }
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada.' });
  res.json(s);
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
  if (activeSessionId !== id) return;
  browserManager = new BrowserManager(e => emit(id, e));
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
  for (let portalIndex = 0; portalIndex < (s.portals || portalsForCompany(s.company)).length; portalIndex++) {
    let configuredPortal = s.portals[portalIndex];
    if (configuredPortal.key === 'municipal' && (!configuredPortal.url || configuredPortal.deferredDiscovery)) {
      emit(id, { type: 'municipal_discovery_started', portal: 'municipal', message: 'As demais certidões foram consultadas. Localizando o portal municipal…' });
      const resolution = await resolvePortalsForCompany(s.company, { municipalResolver: municipalPortalResolver });
      s.municipalResolution = resolution.municipalResolution;
      configuredPortal = resolution.portals.find(item => item.key === 'municipal');
      emit(id, {
        type: 'municipal_resolution',
        portal: 'municipal',
        status: resolution.municipalResolution?.status || 'PORTAL_NAO_IDENTIFICADO',
        provider: resolution.municipalResolution?.provider || '',
        url: resolution.municipalResolution?.certidao_url || '',
        message: configuredPortal ? `Portal municipal localizado: ${configuredPortal.name}.` : 'Não foi possível validar um portal municipal para esta empresa.'
      });
      if (!configuredPortal) {
        const message = 'O portal desta certidão não foi identificado para a empresa consultada.';
        s.failures.push({ portal: 'municipal', message });
        emit(id, { type: 'portal_error', portal: 'municipal', message });
        emit(id, { type: 'portal_skipped', portal: 'municipal', message });
        continue;
      }
      s.portals[portalIndex] = configuredPortal;
    }
    if (!configuredPortal) continue;
    const portal = configuredPortal.key === 'federal' ? {...configuredPortal, captchaTimeout: 120000} : configuredPortal;
    s.currentPortal = portal.key;
    if (s.status === 'stopped') break;
    emit(id, { type: 'portal_start', portal: portal.key, name: portal.name });
    const archiveKey = archiveKeyForPortal(portal.key);
    const existing = archive.certificates?.[archiveKey];
    if (isCertificateCurrent(existing) && (portal.key !== 'fgts' || existing.source === 'manual' || existing.captureStage === 'fgts-print-view')) {
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
      const result = await runPortal({ portal, cnpj: s.cnpj, browser: browserManager, baseDir: BASE, emit: e => emit(id, e) });
      if (s.status === 'stopped') break;
      if (!result?.filePath) throw new Error('Nenhum PDF foi capturado nesta etapa.');
      const fileUrl = fileUrlForPath(result.filePath);

      if (result.filePath) {
        try {
          const buffer = fs.readFileSync(result.filePath);
          const parsed = parseCert((await pdfParse(buffer)).text);
          const archived = writeArchive(s.cnpj, portal.key, result.filePath, parsed, result.captureStage);
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
  if (activeSessionId === id) activeSessionId = null;
  s.currentPortal = null;
}

app.get('*', (_, res) => res.sendFile(path.join(BASE, 'public', 'central-certidoes.html')));
app.use((error,req,res,next)=>{
  console.error(`[API] ${req.method} ${req.originalUrl}: ${error.stack||error.message}`);
  if(res.headersSent)return next(error);
  res.status(error.status||500).json({error:error.status?error.message:'A Central encontrou uma falha ao falar com o portal. A API permaneceu ativa; consulte o log do servidor.'});
});
app.listen(PORT, '127.0.0.1', () => console.log(`Central de Certidões V2: http://127.0.0.1:${PORT}`));
