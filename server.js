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
const { SessionRegistry, runBoundedStep } = require('./lib/session-lifecycle');
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

const sessionRegistry = new SessionRegistry();
const sessions = sessionRegistry.sessions;
let browserManager;

function log(sessionId, event) {
  const line = JSON.stringify({ time: new Date().toISOString(), sessionId, ...event }) + '\n';
  fs.appendFileSync(path.join(DATA, 'logs', `${sessionId}.jsonl`), line);
}

function emit(sessionId, event) {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.events.push({ time: new Date().toISOString(), ...event });
  try { log(sessionId, event); }
  catch (error) { console.error(`[SESSION_LOG] sessionId=${sessionId} stage=${event.stage || ''} cause=${error.code || error.message}`); }
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

function runBoundedOperation(stage, timeoutMs, operation) {
  return runBoundedStep({ abortController: new AbortController() }, stage, timeoutMs, operation);
}

app.get('/api/health', (_, res) => res.json({ ok: true, version: '2.9.3.11' }));
app.get('/api/portals', (_, res) => res.json(portals));
app.get('/api/portal/:cnpj/:key', async (req,res,next) => {
  try {
    const cnpj=onlyDigits(req.params.cnpj),key=String(req.params.key||'');
    if(cnpj.length!==14)return res.status(400).json({error:'CNPJ inválido.'});
    const fixed=portals.find(item=>item.key===key);
    if(fixed&&key!=='estadual-ce')return res.json({url:fixed.url,name:fixed.name,provider:'oficial'});
    const company=await runBoundedOperation('company_lookup',22000,signal=>lookupCompany(cnpj,{signal,strict:true}));
    if(key==='ceara'||key.startsWith('estadual')){
      if(!company.uf)return res.status(422).json({error:'Não foi possível identificar a UF do CNPJ para abrir o portal estadual correto.'});
      const portal=portalsForCompany(company).find(item=>item.key.startsWith('estadual-')||item.key==='estadual');
      if(!portal?.url)return res.status(404).json({error:'Portal estadual não configurado para a UF identificada.'});
      return res.json({url:portal.url,name:portal.name,provider:'oficial',municipio:company.municipio,uf:company.uf});
    }
    if(key!=='municipal')return res.status(400).json({error:'Tipo de certidão inválido.'});
    if(!company.uf||!company.municipio)return res.status(422).json({error:'Não foi possível identificar município e UF para localizar o portal oficial.'});
    const resolution=await runBoundedOperation('municipal_discovery',65000,signal=>resolvePortalsForCompany(company,{municipalResolver:municipalPortalResolver,signal}));
    const portal=resolution.portals.find(item=>(item.key.startsWith('estadual-')?'ceara':item.key)===key);
    if(!portal?.url){
      const status=resolution.municipalResolution?.status;
      const httpStatus=status==='PORTAL_INACESSIVEL'?503:status==='ERRO_TECNICO'?502:404;
      return res.status(httpStatus).json({status:status||'PORTAL_NAO_ENCONTRADO',diagnostico:resolution.municipalResolution?.diagnostico||null,error:'O portal municipal não foi localizado ou validado para a empresa.'});
    }
    res.json({url:portal.url,name:portal.name,provider:portal.provider||'',municipio:company.municipio,uf:company.uf});
  }catch(error){if(error.code==='STEP_TIMEOUT')error.status=504;else if(error.code==='COMPANY_LOOKUP_FAILED')error.status=502;else if(!error.status)error.status=502;next(error);}
});

const cnpjCache = new Map();

async function fetchJsonWithTimeout(url, timeoutMs = 9000, parentSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason || new Error('Consulta cancelada.'));
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Timeout após ${timeoutMs} ms: ${url}`)), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

async function lookupCompany(cnpj, { signal, strict = false } = {}) {
  const cached = cnpjCache.get(cnpj);
  if (cached && Date.now() - cached.time < 6 * 60 * 60 * 1000) return cached.data;

  const providers = [
    async () => {
      const r = await fetchJsonWithTimeout(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, 9000, signal);
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
      const r = await fetchJsonWithTimeout(`https://www.receitaws.com.br/v1/cnpj/${cnpj}`, 9000, signal);
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

  const failures = [];
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
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      failures.push(error);
    }
  }
  if (strict) {
    const error = new Error(failures.length
      ? `Falha ao consultar os dados cadastrais nas fontes disponíveis: ${failures.map(item => item.message).join('; ')}`
      : 'CNPJ não localizado nas fontes cadastrais disponíveis.');
    error.code = failures.length ? 'COMPANY_LOOKUP_FAILED' : 'COMPANY_NOT_FOUND';
    throw error;
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

const sessionPortalNames = {
  federal: 'Certidão Federal', fgts: 'Certificado FGTS', trabalhista: 'Certidão Trabalhista',
  ceara: 'Certidão Estadual', municipal: 'Certidão Municipal'
};

function sessionPortalSummary(certificateKey) {
  const keys = certificateKey ? [certificateKey] : Object.keys(sessionPortalNames);
  return keys.map(key => ({ key, name: sessionPortalNames[key] || key }));
}

async function runSessionStage(session, stage, timeoutMs, operation) {
  const startedAt = Date.now();
  session.currentStage = stage;
  emit(session.id, { type: 'stage_started', stage, timeoutMs, durationMs: 0, message: stage });
  try {
    const result = await runBoundedStep(session, stage, timeoutMs, operation);
    emit(session.id, { type: 'stage_completed', stage, durationMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    emit(session.id, {
      type: session.abortController.signal.aborted ? 'stage_cancelled' : 'stage_failed',
      stage,
      durationMs: Date.now() - startedAt,
      cause: error.code || error.name || 'ERROR',
      message: error.message
    });
    throw error;
  }
}

app.post('/api/session', (req, res) => {
  const cnpj = onlyDigits(req.body.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ error: 'CNPJ deve conter 14 dígitos.' });
  if (sessionRegistry.activeId) {
    const active = sessions.get(sessionRegistry.activeId);
    if (!active || ['done', 'partial', 'error', 'stopped'].includes(active.status)) sessionRegistry.release(sessionRegistry.activeId);
    else return res.status(409).json({ error: 'Já existe uma consulta em andamento. Aguarde ou cancele a sessão ativa.' });
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const certificateKey = String(req.body.certificateKey || '');
  if (certificateKey && !sessionPortalNames[certificateKey]) return res.status(400).json({ error: 'Tipo de certidão inválido.' });
  const session = {
    id, cnpj, certificateKey,
    razaoSocial: String(req.body.razaoSocial || ''),
    company: null, status: 'running', startedAt: new Date().toISOString(),
    currentStage: 'identificando_empresa', events: [], failures: [],
    abortController: new AbortController(), browserManager: null
  };
  if (!sessionRegistry.reserve(session)) return res.status(409).json({ error: 'Já existe uma consulta em andamento.' });
  emit(id, { type: 'company_lookup_started', stage: 'identificando_empresa', durationMs: 0, message: 'Identificando município e dados cadastrais do CNPJ.' });

  // Responde antes do lookup e da descoberta: a interface já conhece o ID da
  // sessão e pode exibir progresso ou cancelar a consulta enquanto isso ocorre.
  res.status(202).json({
    sessionId: id,
    company: null,
    municipalResolution: { status: 'EM_PROCESSAMENTO' },
    portals: sessionPortalSummary(certificateKey)
  });
  setImmediate(() => {
    runSession(id).catch(error => finalizeSessionFailure(id, error));
  });
});

async function finalizeSessionFailure(id, error) {
  const session = sessions.get(id);
  if (!session) return;
  if (session.status !== 'stopped' && !session.abortController.signal.aborted) {
    session.status = 'error';
    session.failures ||= [];
    session.failures.push({ portal: session.currentPortal || '', stage: session.currentStage || '', message: error.message, code: error.code || '' });
    emit(id, { type: 'error', stage: session.currentStage || '', cause: error.code || error.name || 'ERROR', message: error.message });
  }
  if (!session.completeEventSent) {
    session.completeEventSent = true;
    emit(id, { type: 'complete', status: session.status, failures: session.failures || [] });
  }
  session.completedAt ||= new Date().toISOString();
  sessionRegistry.release(id);
  const manager = session.browserManager;
  if (browserManager === manager) browserManager = null;
  await manager?.close().catch(closeError => console.warn(`[SESSION] close after failure: ${closeError.message}`));
}

app.post('/api/session/:id/resume', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
  if (session.status !== 'running' || sessionRegistry.activeId !== req.params.id || !session.browserManager?.resumeResolver) {
    return res.status(409).json({ error: 'A sessão não está aguardando uma interação manual.' });
  }
  session.browserManager.resume();
  emit(req.params.id, { type: 'user_resumed' });
  res.json({ ok: true });
});

app.post('/api/session/:id/focus', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada.' });
  if (sessionRegistry.activeId !== req.params.id || s.status !== 'running' || !s.browserManager?.page) {
    return res.status(409).json({ error: 'Não há uma janela ativa desta consulta para abrir.' });
  }
  try {
    await s.browserManager.focusInteractiveWindow(s.browserManager.page);
    emit(req.params.id, { type: 'interactive_window_focused', url: s.browserManager.page.url() });
    res.json({ ok: true, url: s.browserManager.page.url() });
  } catch (error) {
    res.status(500).json({ error: `Não foi possível trazer a janela do órgão para a frente: ${error.message}` });
  }
});

app.post('/api/session/:id/stop', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sessão não encontrada.' });
  if (!sessionRegistry.cancel(req.params.id)) return res.status(409).json({ error: 'A consulta já foi encerrada.' });
  emit(req.params.id, { type: 'stopped', stage: s.currentStage || '', cause: 'USER_CANCELLED', message: 'Consulta interrompida pelo usuário.' });
  s.completeEventSent = true;
  emit(req.params.id, { type: 'complete', status: 'stopped', failures: s.failures || [] });
  s.completedAt = new Date().toISOString();
  res.json({ ok: true });
  const manager = s.browserManager;
  manager?.resume();
  if (manager) {
    if (browserManager === manager) browserManager = null;
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
  if (!s || sessionRegistry.activeId !== id || s.status !== 'running') return;
  s.failures ||= [];
  let archive;
  try {
    emit(id, { type: 'company_lookup_started', stage: 'identificando_empresa', message: 'Identificando município e dados cadastrais do CNPJ.' });
    s.company = await runSessionStage(s, 'company_lookup', 22000, signal => lookupCompany(s.cnpj, { signal, strict: true }));
    s.razaoSocial ||= s.company.razao_social || s.company.nome_fantasia || '';
    const uf = String(s.company.uf || '').toUpperCase();
    emit(id, {
      type: 'company_lookup_completed', stage: 'identificando_empresa', durationMs: Date.now() - Date.parse(s.startedAt),
      municipio: s.company.municipio || '', uf, codigoIbge: s.company.municipio_codigo_ibge || '', razaoSocial: s.razaoSocial,
      message: s.company.municipio ? `Município identificado: ${s.company.municipio}/${uf}.` : 'CNPJ consultado; município não disponível nas fontes cadastrais.'
    });
    emit(id, {
      type: 'company_state_detected', uf, municipio: s.company.municipio || '',
      message: uf ? `UF cadastral identificada: ${uf}` : 'Não foi possível identificar a UF cadastral automaticamente.'
    });
    if (s.abortController.signal.aborted) return;

    let sessionPortals = portalsForCompany(s.company);
    const knownMunicipal = sessionPortals.find(portal => portal.key === 'municipal');
    if (s.certificateKey === 'municipal') {
      sessionPortals = [{ key: 'municipal', name: `Municipal · ${s.company.municipio || 'município não identificado'}`, shortName: 'Municipal', deferredDiscovery: true }];
    } else if (s.certificateKey) {
      const selected = sessionPortals.find(portal => (portal.key.startsWith('estadual-') ? 'ceara' : portal.key) === s.certificateKey);
      if (!selected) {
        const error = new Error(`A certidão ${s.certificateKey} não está configurada para a UF identificada (${uf || 'desconhecida'}).`);
        error.code = 'PORTAL_NAO_CONFIGURADO';
        throw error;
      }
      sessionPortals = [selected];
    } else if (!knownMunicipal) {
      sessionPortals.push({ key: 'municipal', name: `Municipal · ${s.company.municipio || 'município não identificado'}`, shortName: 'Municipal', deferredDiscovery: true });
    }
    s.portals = sessionPortals;
    s.municipalResolution = knownMunicipal
      ? { status: 'PORTAL_ENCONTRADO', certidao_url: knownMunicipal.url, provider: knownMunicipal.provider || 'registry' }
      : { status: 'DESCOBERTA_MUNICIPAL_ADIADA' };
    emit(id, {
      type: 'municipal_resolution', status: s.municipalResolution.status,
      portal: s.municipalResolution.certidao_url || '', provider: s.municipalResolution.provider || '',
      message: knownMunicipal ? `Portal municipal disponível para ${s.company.municipio}.` : 'Portal municipal será procurado nesta consulta.'
    });
    archive = readArchive(s.cnpj);

    for (let portalIndex = 0; portalIndex < s.portals.length; portalIndex++) {
      if (s.abortController.signal.aborted || s.status === 'stopped') break;
      let configuredPortal = s.portals[portalIndex];
      if (configuredPortal.key === 'municipal' && (!configuredPortal.url || configuredPortal.deferredDiscovery)) {
        if (!s.company.municipio || !s.company.uf || !/^\d{7}$/.test(String(s.company.municipio_codigo_ibge || ''))) {
          s.municipalResolution = { status: 'MUNICIPIO_NAO_IDENTIFICADO' };
          const message = 'Município/UF/código IBGE não foram confirmados; a busca do portal municipal não foi iniciada.';
          s.failures.push({ portal: 'municipal', kind: 'MUNICIPIO_NAO_IDENTIFICADO', message });
          emit(id, { type: 'municipal_resolution', portal: 'municipal', status: 'MUNICIPIO_NAO_IDENTIFICADO', message });
          emit(id, { type: 'portal_error', portal: 'municipal', kind: 'MUNICIPIO_NAO_IDENTIFICADO', message });
          emit(id, { type: 'portal_skipped', portal: 'municipal', message });
          continue;
        }
        emit(id, { type: 'municipal_discovery_started', stage: 'municipal_discovery', portal: 'municipal', message: `Procurando portal municipal de ${s.company.municipio}/${s.company.uf}…` });
        const discoveryStarted = Date.now();
        try {
          const resolution = await runSessionStage(s, 'municipal_discovery', 65000, signal => resolvePortalsForCompany(s.company, {
            municipalResolver: municipalPortalResolver,
            signal,
            onProgress: progress => emit(id, { type: 'municipal_discovery_progress', stage: 'municipal_discovery', durationMs: Date.now() - discoveryStarted, ...progress })
          }));
          s.municipalResolution = resolution.municipalResolution;
          configuredPortal = resolution.portals.find(item => item.key === 'municipal');
          if (configuredPortal) {
            s.portals[portalIndex] = configuredPortal;
            emit(id, { type: 'municipal_resolution', portal: 'municipal', status: 'PORTAL_ENCONTRADO', provider: resolution.municipalResolution?.provider || '', url: configuredPortal.url, durationMs: Date.now() - discoveryStarted, message: `Portal municipal encontrado: ${configuredPortal.name}.` });
          } else {
            const status = resolution.municipalResolution?.status || 'PORTAL_NAO_ENCONTRADO';
            const reason = status === 'PORTAL_INACESSIVEL' ? 'O portal da prefeitura ou os serviços municipais estão inacessíveis.'
              : status === 'MUNICIPIO_NAO_IDENTIFICADO' ? 'O município não foi identificado para procurar o portal.'
                : 'A busca terminou sem encontrar um portal municipal de certidões validado.';
            const message = `${reason} (${s.company.municipio}/${s.company.uf}).`;
            s.failures.push({ portal: 'municipal', kind: status, message, diagnostic: resolution.municipalResolution?.diagnostico });
            emit(id, { type: 'municipal_resolution', portal: 'municipal', status, durationMs: Date.now() - discoveryStarted, diagnostic: resolution.municipalResolution?.diagnostico, message });
            emit(id, { type: 'portal_error', portal: 'municipal', kind: status, message });
            emit(id, { type: 'portal_skipped', portal: 'municipal', message });
            continue;
          }
        } catch (error) {
          if (s.abortController.signal.aborted || s.status === 'stopped') break;
          const kind = error.code === 'STEP_TIMEOUT' ? 'ERRO_TECNICO' : (error.code === 'HTTP_TIMEOUT' ? 'PORTAL_INACESSIVEL' : 'ERRO_TECNICO');
          s.municipalResolution = { status: kind, diagnostico: { stage: 'municipal_discovery', cause: error.code || error.name, message: error.message } };
          const message = kind === 'PORTAL_INACESSIVEL'
            ? `A validação dos portais municipais excedeu o tempo de resposta: ${error.message}`
            : `Erro técnico durante a descoberta municipal: ${error.message}`;
          s.failures.push({ portal: 'municipal', kind, message, stage: 'municipal_discovery' });
          emit(id, { type: 'municipal_resolution', portal: 'municipal', status: kind, durationMs: Date.now() - discoveryStarted, cause: error.code || error.name, message });
          emit(id, { type: 'portal_error', portal: 'municipal', kind, message });
          emit(id, { type: 'portal_skipped', portal: 'municipal', message: 'Consulta municipal encerrada com falha; outras consultas e novas sessões continuam disponíveis.' });
          continue;
        }
      }

      if (!configuredPortal) continue;
      const portal = configuredPortal.key === 'federal' ? { ...configuredPortal, captchaTimeout: 120000 } : configuredPortal;
      s.currentPortal = portal.key;
      emit(id, { type: 'portal_start', portal: portal.key, name: portal.name, message: `Iniciando consulta: ${portal.name}.` });
      const archiveKey = archiveKeyForPortal(portal.key);
      const existing = archive.certificates?.[archiveKey];
      if (isCertificateCurrent(existing) && (portal.key !== 'fgts' || existing.source === 'manual' || existing.captureStage === 'fgts-print-view')) {
        emit(id, { type: 'portal_reused', portal: portal.key, name: portal.name, validade: existing.validade, message: `${portal.name} já está válida no arquivo até ${existing.validade}.` });
        emit(id, { type: 'portal_done', portal: portal.key, filePath: existing.filePath, fileUrl: existing.fileUrl, reused: true });
        emit(id, reuseEventForCertificate(portal, existing));
        emit(id, { type: 'pdf_parsed', portal: portal.key, parsed: { status: existing.status || '', validade: existing.validade || '', numero: existing.numero || '' }, filePath: existing.filePath, fileUrl: existing.fileUrl, viewUrl: existing.viewUrl || existing.fileUrl, downloadUrl: existing.downloadUrl || existing.fileUrl, fileName: existing.fileName });
        continue;
      }
      if (portal.key === 'estadual-ce' && uf !== 'CE') {
        const message = uf ? `CNPJ cadastrado na UF ${uf}. A automação estadual do Ceará foi ignorada para não emitir certidão do estado errado.` : 'UF cadastral não identificada. A automação estadual do Ceará foi ignorada para não emitir certidão do estado errado.';
        s.failures.push({ portal: portal.key, message });
        emit(id, { type: 'portal_error', portal: portal.key, message });
        emit(id, { type: 'portal_skipped', portal: portal.key, message });
        continue;
      }
      try {
        if (!s.browserManager) {
          s.browserManager = new BrowserManager(e => emit(id, e));
          if (sessionRegistry.activeId === id) browserManager = s.browserManager;
        }
        emit(id, { type: 'browser_starting', stage: 'browser_start', portal: portal.key, message: 'Iniciando navegador para o portal do órgão.' });
        const result = await runPortal({ portal, cnpj: s.cnpj, browser: s.browserManager, baseDir: BASE, emit: e => emit(id, e) });
        if (s.abortController.signal.aborted || s.status === 'stopped') break;
        if (!result?.filePath) throw new Error('Nenhum PDF foi capturado nesta etapa.');
        try {
          const buffer = fs.readFileSync(result.filePath);
          const parsed = parseCert((await pdfParse(buffer)).text);
          const archived = writeArchive(s.cnpj, portal.key, result.filePath, parsed, result.captureStage);
          emit(id, { type: 'portal_done', portal: portal.key, filePath: archived.filePath, fileUrl: archived.fileUrl });
          emit(id, { type: 'pdf_archived', portal: portal.key, ...archived });
          emit(id, { type: 'pdf_parsed', portal: portal.key, parsed, filePath: archived.filePath, fileUrl: archived.fileUrl, viewUrl: archived.viewUrl, downloadUrl: archived.downloadUrl, fileName: archived.fileName });
        } catch (error) {
          throw new Error('PDF capturado, mas não foi possível ler/arquivar: ' + error.message);
        }
      } catch (error) {
        if (s.abortController.signal.aborted || s.status === 'stopped') break;
        s.failures.push({ portal: portal.key, message: error.message, code: error.code || '' });
        emit(id, { type: 'portal_error', portal: portal.key, cause: error.code || error.name || 'ERROR', message: error.message });
        emit(id, { type: 'portal_skipped', portal: portal.key, message: 'Certidão pendente nesta consulta. A Central seguirá para a próxima etapa.' });
      }
    }
  } catch (error) {
    if (!s.abortController.signal.aborted && s.status !== 'stopped') {
      s.status = 'error';
      s.failures.push({ portal: s.currentPortal || '', stage: s.currentStage || '', message: error.message, code: error.code || '' });
      emit(id, { type: 'error', stage: s.currentStage || '', cause: error.code || error.name || 'ERROR', message: error.message });
    }
  } finally {
    if (s.status === 'running') s.status = s.failures.length ? 'partial' : 'done';
    if (!s.completeEventSent) {
      s.completeEventSent = true;
      emit(id, { type: 'complete', status: s.status, failures: s.failures });
    }
    s.completedAt ||= new Date().toISOString();
    s.currentPortal = null;
    sessionRegistry.release(id);
    const manager = s.browserManager;
    if (browserManager === manager) browserManager = null;
    await manager?.close().catch(error => console.warn(`[SESSION] close after completion: ${error.message}`));
  }
}

app.get('*', (_, res) => res.sendFile(path.join(BASE, 'public', 'central-certidoes.html')));
app.use((error,req,res,next)=>{
  console.error(`[API] ${req.method} ${req.originalUrl}: ${error.stack||error.message}`);
  if(res.headersSent)return next(error);
  res.status(error.status||500).json({error:error.status?error.message:'A Central encontrou uma falha ao falar com o portal. A API permaneceu ativa; consulte o log do servidor.'});
});
if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () => console.log(`Central de Certidões V2: http://127.0.0.1:${PORT}`));
}

module.exports = { app, sessions, sessionRegistry, municipalPortalResolver, cnpjCache };
