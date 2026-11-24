class SessionControl {
  constructor(sessions, emit) {
    this.sessions = sessions;
    this.emit = emit;
    this.activeId = null;
    this.browsers = new Map();
    this.tasks = new Map();
    this.controllers = new Map();
  }
  release(id) { if (this.activeId === id) this.activeId = null; }
  async stop(id) {
    const session = this.sessions.get(id);
    if (!session) throw Object.assign(new Error('Sessão não encontrada.'), {status:404});
    // Release synchronously, before waiting for any browser/network operation.
    this.release(id);
    this.controllers.get(id)?.abort(Object.assign(new Error('Consulta cancelada.'),{code:'SESSION_CANCELLED'}));
    this.controllers.delete(id);
    if (session.status === 'running') {
      session.status = 'stopped';
      this.emit(id, {type:'stopped',message:'Consulta interrompida. Você já pode iniciar uma nova consulta.'});
    }
    const task = this.tasks.get(id), browser = this.browsers.get(id);
    this.tasks.delete(id); this.browsers.delete(id);
    task?.learner.stop();
    const closing = Promise.resolve().then(() => browser?.close()).catch(() => {});
    // Broken CDP connections must not leave Stop pending indefinitely.
    let timer;
    await Promise.race([closing, new Promise(resolve => {timer=setTimeout(resolve,1500);})]);
    clearTimeout(timer);
    return {ok:true,status:session.status};
  }
}
module.exports = {SessionControl};
