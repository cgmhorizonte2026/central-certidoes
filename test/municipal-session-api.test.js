const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { app, sessions, sessionRegistry, municipalPortalResolver, cnpjCache } = require('../server');

const cnpj = '12345678000195';
const company = {
  razao_social: 'PACAJUS TESTE LTDA', nome_fantasia: '', uf: 'CE', municipio: 'Pacajus',
  municipio_codigo_ibge: '2309608', codigo_ibge: '2309608', logradouro: 'Rua de Teste',
  numero: '1', complemento: '', bairro: 'Centro', cep: '62870000'
};
let server;
let baseUrl;
let originalResolve;
let sessionIds = [];

test.before(async () => {
  cnpjCache.set(cnpj, { time: Date.now(), data: company });
  originalResolve = municipalPortalResolver.resolve;
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  municipalPortalResolver.resolve = originalResolve;
  cnpjCache.delete(cnpj);
  for (const id of sessionIds) sessions.delete(id);
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

async function startMunicipal() {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cnpj, certificateKey: 'municipal' })
  });
  const body = await response.json();
  if (body.sessionId) sessionIds.push(body.sessionId);
  return { response, body };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timeout aguardando estado esperado da sessão.');
}

test('session API responds before municipal discovery; cancel releases slot and a later query completes', async () => {
  let markResolverStarted;
  const resolverStarted = new Promise(resolve => { markResolverStarted = resolve; });
  municipalPortalResolver.resolve = async (_company, { signal }) => new Promise((resolve, reject) => {
    markResolverStarted();
    signal.addEventListener('abort', () => reject(signal.reason || new Error('cancelled')), { once: true });
  });

  const first = await startMunicipal();
  assert.equal(first.response.status, 202);
  assert.ok(first.body.sessionId);
  await resolverStarted;
  const firstSession = sessions.get(first.body.sessionId);
  assert.ok(firstSession.events.some(event => event.type === 'municipal_discovery_started'));
  assert.equal(sessionRegistry.activeId, first.body.sessionId);

  const stop = await fetch(`${baseUrl}/api/session/${first.body.sessionId}/stop`, { method: 'POST' });
  assert.equal(stop.status, 200);
  assert.equal(sessionRegistry.activeId, null);

  municipalPortalResolver.resolve = async () => ({
    codigo_ibge: '2309608', municipio: 'Pacajus', uf: 'CE', status: 'PORTAL_NAO_ENCONTRADO',
    diagnostico: { tentativas: 1, paginasAcessiveis: 1, candidatos: [], rejeicoes: [] }
  });
  const second = await startMunicipal();
  assert.equal(second.response.status, 202);
  await waitFor(() => ['partial', 'error', 'done', 'stopped'].includes(sessions.get(second.body.sessionId)?.status));
  assert.equal(sessions.get(second.body.sessionId).status, 'partial');
  assert.equal(sessionRegistry.activeId, null);
  assert.ok(sessions.get(second.body.sessionId).events.some(event => event.status === 'PORTAL_NAO_ENCONTRADO'));
});

test('resolver exception becomes a visible error and releases the next session', async () => {
  municipalPortalResolver.resolve = async () => { throw new Error('resolver test exception'); };
  const { response, body } = await startMunicipal();
  assert.equal(response.status, 202);
  await waitFor(() => ['partial', 'error', 'done', 'stopped'].includes(sessions.get(body.sessionId)?.status));
  const session = sessions.get(body.sessionId);
  assert.equal(session.status, 'partial');
  assert.ok(session.events.some(event => event.type === 'portal_error' && /Erro técnico/.test(event.message)));
  assert.equal(sessionRegistry.activeId, null);
});

test('active session can be recovered and stopped without the original browser session id', async () => {
  let markResolverStarted;
  const resolverStarted = new Promise(resolve => { markResolverStarted = resolve; });
  municipalPortalResolver.resolve = async (_company, { signal }) => new Promise((resolve, reject) => {
    markResolverStarted();
    signal.addEventListener('abort', () => reject(signal.reason || new Error('cancelled')), { once: true });
  });

  const started = await startMunicipal();
  await resolverStarted;
  const activeResponse = await fetch(`${baseUrl}/api/session/active`);
  assert.equal(activeResponse.status, 200);
  const active = await activeResponse.json();
  assert.equal(active.active, true);
  assert.equal(active.sessionId, started.body.sessionId);
  assert.equal(active.cnpj, cnpj);

  const stopResponse = await fetch(`${baseUrl}/api/session/active/stop`, { method: 'POST' });
  assert.equal(stopResponse.status, 200);
  assert.equal((await stopResponse.json()).stopped, true);
  assert.equal(sessionRegistry.activeId, null);

  const idleStop = await fetch(`${baseUrl}/api/session/active/stop`, { method: 'POST' });
  assert.equal(idleStop.status, 200);
  assert.equal((await idleStop.json()).stopped, false);
});
