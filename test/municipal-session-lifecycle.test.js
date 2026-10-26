const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRegistry, runBoundedStep } = require('../lib/session-lifecycle');
const { MunicipalPortalResolver } = require('../lib/municipal-portal-resolver');
const { BrowserManager } = require('../automation/browser');

function makeSession(id = 'session-test') {
  return { id, status: 'running', abortController: new AbortController() };
}

test('slow municipal discovery times out and releases the active session', async () => {
  const registry = new SessionRegistry();
  const session = makeSession();
  assert.equal(registry.reserve(session), true);
  try {
    await assert.rejects(
      runBoundedStep(session, 'municipal_discovery', 25, () => new Promise(() => {})),
      error => error.code === 'STEP_TIMEOUT' && error.stage === 'municipal_discovery'
    );
  } finally {
    registry.release(session.id);
  }
  assert.equal(registry.activeId, null);
  assert.equal(registry.reserve(makeSession('next')), true);
});

test('network failure during Pacajus discovery is classified as inaccessible', async () => {
  const resolver = new MunicipalPortalResolver({ fetchImpl: async () => { throw new TypeError('network down'); } });
  const result = await resolver.resolve({ municipio_codigo_ibge: '2309608', municipio: 'Pacajus', uf: 'CE' });
  assert.equal(result.status, 'PORTAL_INACESSIVEL');
  assert.ok(result.diagnostico.tentativas > 0);
  assert.ok(result.diagnostico.rejeicoes.length > 0);
});

test('resolver exception does not keep a session reserved', async () => {
  const registry = new SessionRegistry();
  const session = makeSession();
  registry.reserve(session);
  try {
    await assert.rejects(runBoundedStep(session, 'municipal_discovery', 1000, async () => {
      throw new Error('resolver fixture failure');
    }), /resolver fixture failure/);
  } finally {
    registry.release(session.id);
  }
  assert.equal(registry.activeId, null);
});

test('cancel aborts a pending discovery and makes the slot available immediately', async () => {
  const registry = new SessionRegistry();
  const session = makeSession();
  registry.reserve(session);
  const pending = runBoundedStep(session, 'municipal_discovery', 5000, signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registry.cancel(session.id), true);
  await assert.rejects(pending, /cancelada pelo usuário/);
  assert.equal(registry.activeId, null);
  assert.equal(registry.reserve(makeSession('after-cancel')), true);
});

test('Chromium startup failure propagates instead of leaving the session running', async () => {
  const registry = new SessionRegistry();
  const session = makeSession();
  registry.reserve(session);
  const manager = new BrowserManager(() => {}, {
    chromiumImpl: { launch: async () => { throw new Error('chromium fixture failure'); } },
    launchTimeoutMs: 50
  });
  try {
    await assert.rejects(manager.ensure(), /chromium fixture failure/);
  } finally {
    await manager.close();
    registry.release(session.id);
  }
  assert.equal(registry.activeId, null);
  assert.equal(manager.browser, null);
});

test('cancelling while Chromium is launching closes a late browser instead of resurrecting it', async () => {
  let resolveLaunch;
  let closedLateBrowser = false;
  const manager = new BrowserManager(() => {}, {
    chromiumImpl: { launch: () => new Promise(resolve => { resolveLaunch = resolve; }) },
    launchTimeoutMs: 1000
  });
  const opening = manager.ensure();
  await new Promise(resolve => setImmediate(resolve));
  await manager.close();
  resolveLaunch({ close: async () => { closedLateBrowser = true; } });
  await assert.rejects(opening, /cancelada junto com a consulta/);
  assert.equal(closedLateBrowser, true);
  assert.equal(manager.browser, null);
});
