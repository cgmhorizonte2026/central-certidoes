'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const {spawn, execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'inicializador');
const serverFile = path.join(root, 'server.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function portOwners(output, port) {
  return [...new Set(output.split(/\r?\n/).flatMap(line => {
    const f = line.trim().split(/\s+/);
    return f[0] === 'TCP' && f[1]?.endsWith(':' + port) && f[3] === 'LISTENING' ? [Number(f[4])] : [];
  }))];
}
function processOwnsServer(output, pid, executable, script) {
  return output.split(/\r?\n/).some(line => {
    const [id, exe, ...rest] = line.split('\t');
    const command = rest.join('\t').trim().toLowerCase();
    const expectedExe = executable.toLowerCase(), expectedScript = script.toLowerCase();
    return Number(id) === pid && exe?.toLowerCase() === expectedExe &&
      (command === `"${expectedExe}" "${expectedScript}"` || command === `${expectedExe} "${expectedScript}"`);
  });
}
function occupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}
function healthy(port) {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${port}/api/health`, {timeout: 1200}, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
      res.on('end', () => { try { const data = JSON.parse(body); resolve(res.statusCode === 200 && data.ok === true && data.version === require('../package.json').version); } catch { resolve(false); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}
function ownsPort(port) {
  const system = path.join(process.env.SystemRoot, 'System32');
  const pids = portOwners(execFileSync(path.join(system, 'netstat.exe'), ['-ano', '-p', 'tcp'], {encoding: 'utf8', windowsHide: true}), port);
  if (!pids.length) return false;
  const processes = execFileSync(path.join(system, 'cscript.exe'), ['//nologo', path.join(__dirname, 'processos-node.vbs')], {encoding: 'ascii', windowsHide: true});
  const decode = value => (value.match(/[a-f0-9]{4}/gi) || []).map(unit => String.fromCharCode(parseInt(unit, 16))).join('');
  const decoded = processes.split(/\r?\n/).map(line => {
    const [pid, exe = '', command = ''] = line.split('\t');
    return [pid, decode(exe), decode(command)].join('\t');
  }).join('\n');
  return pids.every(pid => processOwnsServer(decoded, pid, process.execPath, serverFile));
}
async function acquireLock(lock) {
  for (let i = 0; i < 100; i++) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) {
            if (e.code === 'ESRCH') { fs.unlinkSync(path.join(lock, 'pid')); fs.rmdirSync(lock); continue; }
          }
        }
      } catch { /* Outro inicializador pode estar criando/removendo o bloqueio. */ }
      await pause(500);
    }
  }
  throw new Error('Outro inicializador ainda esta ocupado. Aguarde e tente novamente.');
}
async function main() {
  const port = Number(process.env.PORT || 3030);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalida.');
  fs.mkdirSync(runtime, {recursive: true});
  const lock = path.join(runtime, 'abrindo.lock');
  await acquireLock(lock);
  try {
    if (await occupied(port)) {
      if (!ownsPort(port)) throw new Error(`A porta ${port} esta ocupada por uma instancia que este atalho nao reconhece. Se for a Central antiga, encerre-a no terminal original. Nenhum processo foi encerrado.`);
    } else {
      for (const dependency of ['express', 'playwright', 'pdf-parse']) {
        try { require.resolve(dependency, {paths: [root]}); } catch { throw new Error('Dependencias ausentes. Execute PREPARAR-CENTRAL.cmd uma vez antes de usar o atalho.'); }
      }
      const fd = fs.openSync(path.join(runtime, 'servidor.log'), 'a');
      try {
        const child = spawn(process.execPath, [serverFile], {cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd]});
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
      } finally { fs.closeSync(fd); }
    }
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (await healthy(port)) { ready = true; break; }
      await pause(500);
    }
    if (!ready || !ownsPort(port)) throw new Error('A Central nao confirmou a inicializacao. Consulte .runtime\\inicializador\\servidor.log.');
    const browser = spawn(path.join(process.env.SystemRoot, 'explorer.exe'), [`http://localhost:${port}`], {detached: true, windowsHide: true, stdio: 'ignore'});
    await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject); });
    browser.unref();
  } finally {
    fs.unlinkSync(path.join(lock, 'pid'));
    fs.rmdirSync(lock);
  }
}
if (require.main === module) main().catch(error => {
  fs.mkdirSync(runtime, {recursive: true});
  fs.appendFileSync(path.join(runtime, 'inicializador.log'), `${new Date().toISOString()} ${error.message}\n`);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], error.message, 'utf8');
  process.exitCode = 1;
});
module.exports = {portOwners, processOwnsServer, acquireLock};
