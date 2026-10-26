class StepTimeoutError extends Error {
  constructor(stage, timeoutMs) {
    super(`A etapa ${stage} excedeu o limite de ${timeoutMs} ms.`);
    this.name = 'StepTimeoutError';
    this.code = 'STEP_TIMEOUT';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

class SessionRegistry {
  constructor() {
    this.sessions = new Map();
    this.activeId = null;
  }

  reserve(session) {
    if (this.activeId) return false;
    this.sessions.set(session.id, session);
    this.activeId = session.id;
    return true;
  }

  release(id) {
    if (this.activeId !== id) return false;
    this.activeId = null;
    return true;
  }

  cancel(id, reason = 'Consulta cancelada pelo usuário.') {
    const session = this.sessions.get(id);
    if (!session || ['done', 'partial', 'error', 'stopped'].includes(session.status)) return false;
    session.status = 'stopped';
    session.cancelReason = reason;
    session.abortController?.abort(new Error(reason));
    this.release(id);
    return true;
  }
}

function runBoundedStep(session, stage, timeoutMs, operation) {
  if (session.abortController?.signal.aborted) {
    return Promise.reject(session.abortController.signal.reason || new Error('Consulta cancelada.'));
  }
  const controller = new AbortController();
  const parentSignal = session.abortController?.signal;
  const abortFromParent = () => controller.abort(parentSignal.reason || new Error('Consulta cancelada.'));
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  let timer;
  const cancelled = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('Etapa cancelada.')), { once: true });
    timer = setTimeout(() => controller.abort(new StepTimeoutError(stage, timeoutMs)), timeoutMs);
  });
  const work = Promise.resolve().then(() => operation(controller.signal));
  return Promise.race([work, cancelled]).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  });
}

module.exports = { SessionRegistry, StepTimeoutError, runBoundedStep };
