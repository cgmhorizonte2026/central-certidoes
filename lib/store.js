const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256 } = require('./domain');
class Store {
  constructor(root) {
    this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true });
    for (const folder of ['files', 'evidence', 'reports']) fs.mkdirSync(path.join(this.root, folder), { recursive: true });
    const keyPath = path.join(this.root, 'audit.key');
    if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    this.key = fs.readFileSync(keyPath);
    this.db = new DatabaseSync(path.join(this.root, 'central.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, previous TEXT NOT NULL, mac TEXT NOT NULL);');
    if (!this.db.prepare('PRAGMA table_info(records)').all().some(c=>c.name==='mac')) {
      this.db.exec('ALTER TABLE records ADD COLUMN mac TEXT');
      for(const r of this.db.prepare('SELECT kind,id,body FROM records').all()) this.db.prepare('UPDATE records SET mac=? WHERE kind=? AND id=?').run(this.recordMac(r.kind,r.id,r.body),r.kind,r.id);
    }
    this.anchorPath=path.join(this.root,'audit.anchor');
    if(!fs.existsSync(this.anchorPath)){
      if(this.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n || this.db.prepare('SELECT COUNT(*) AS n FROM records').get().n)throw new Error('Âncora da auditoria ausente. Restaure o backup completo antes de continuar.');
      this.saveAnchor(0,'genesis');
    }
  }
  saveAnchor(count,head){const body=JSON.stringify({count,head});const mac=crypto.createHmac('sha256',this.key).update(body).digest('hex');const temp=this.anchorPath+'.tmp';fs.writeFileSync(temp,JSON.stringify({body,mac}),{mode:0o600});fs.renameSync(temp,this.anchorPath);}
  recordMac(kind,id,body){return crypto.createHmac('sha256',this.key).update(JSON.stringify([kind,id,body])).digest('hex');}
  decode(kind,r){if(r.mac!==this.recordMac(kind,r.id,r.body))throw new Error('Falha de integridade de registro. Operação bloqueada.');return JSON.parse(r.body);}
  get(kind, id) { const r = this.db.prepare('SELECT id,body,mac FROM records WHERE kind=? AND id=?').get(kind, id); return r ? this.decode(kind,r) : null; }
  all(kind) { return this.db.prepare('SELECT id,body,mac FROM records WHERE kind=? ORDER BY rowid DESC').all(kind).map(r => this.decode(kind,r)); }
  put(kind, id, value) { const body=JSON.stringify(value);this.db.prepare('INSERT INTO records (kind,id,body,mac) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body,mac=excluded.mac').run(kind,id,body,this.recordMac(kind,id,body)); return value; }
  audit(event, actor = 'sistema') {
    if(!this.checkAudit().ok)throw new Error('Falha de integridade da trilha de auditoria. Escrita bloqueada.');
    const last = this.db.prepare('SELECT seq,mac FROM audit ORDER BY seq DESC LIMIT 1').get();
    const seq = (last?.seq || 0) + 1; const previous = last?.mac || 'genesis';
    const body = JSON.stringify({ seq, at: new Date().toISOString(), actor, ...event });
    const mac = crypto.createHmac('sha256', this.key).update(previous + body).digest('hex');
    this.db.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(seq, body, previous, mac);
    this.saveAnchor(seq,mac);
    return { ...JSON.parse(body), mac };
  }
  checkAudit() {
    let previous = 'genesis', count = 0;
    for (const r of this.db.prepare('SELECT * FROM audit ORDER BY seq').all()) {
      const mac = crypto.createHmac('sha256', this.key).update(previous + r.body).digest('hex');
      if (r.seq !== count + 1 || previous !== r.previous || mac !== r.mac) return { ok: false, count, failedAt: r.seq };
      previous = r.mac; count++;
    }
    try{const anchor=JSON.parse(fs.readFileSync(this.anchorPath,'utf8'));const mac=crypto.createHmac('sha256',this.key).update(anchor.body).digest('hex');const expected=JSON.parse(anchor.body);if(anchor.mac!==mac||expected.count!==count||expected.head!==previous)return {ok:false,count,reason:'Âncora da trilha divergente.'};}catch{return {ok:false,count,reason:'Âncora da trilha ausente ou inválida.'};}
    return { ok: true, count, head: previous };
  }
  events(cnpj) { return this.db.prepare('SELECT body,mac FROM audit ORDER BY seq DESC').all().map(r => ({ ...JSON.parse(r.body), mac: r.mac })).filter(r => !cnpj || r.cnpj === cnpj); }
  saveFile(folder, buffer, extension) {
    const id = crypto.randomUUID(); const relative = `${folder}/${id}.${extension}`;
    fs.writeFileSync(this.resolve(relative), buffer, { flag: 'wx' });
    return { path: relative, sha256: sha256(buffer), size: buffer.length };
  }
  saveCertificateFile(cnpj,portalKey,buffer,duplicate=null){
    if(!/^[A-Z0-9]{12}\d{2}$/.test(cnpj)||!/^[a-z0-9_-]{1,100}$/i.test(portalKey))throw new Error('Empresa ou tipo inválido para armazenamento.');
    const hash=sha256(buffer),relative=`files/${cnpj}/${portalKey}/${hash}.pdf`,destination=this.resolve(relative);
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    if(fs.existsSync(destination)){
      if(sha256(fs.readFileSync(destination))!==hash)throw new Error('PDF existente alterado. Restaure a integridade antes de salvar novamente.');
    }else if(duplicate&&this.intact(duplicate)){
      // Hard links preserve old audit references without another physical PDF copy.
      fs.linkSync(this.resolve(duplicate.path),destination);
    }else fs.writeFileSync(destination,buffer,{flag:'wx'});
    return {path:relative,sha256:hash,size:buffer.length};
  }
  organizeCertificates(){
    let count=0;
    for(const cert of this.all('certificate')){
      if(cert.file.path.startsWith(`files/${cert.cnpj}/${cert.portalKey}/`)||!this.intact(cert.file))continue;
      const previous=cert.file;
      cert.file=this.saveCertificateFile(cert.cnpj,cert.portalKey,fs.readFileSync(this.resolve(previous.path)),previous);
      this.put('certificate',cert.id,cert);
      this.audit({type:'pdf_organized',cnpj:cert.cnpj,certificateId:cert.id,previous,file:cert.file},'sistema');count++;
    }
    return count;
  }
  resolve(relative) {
    const dest = path.resolve(this.root, relative); const rel = path.relative(this.root, dest);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Caminho inválido.');
    return dest;
  }
  intact(file) { try { return sha256(fs.readFileSync(this.resolve(file.path))) === file.sha256; } catch { return false; } }
  close() { this.db.close(); }
}
module.exports = { Store };
