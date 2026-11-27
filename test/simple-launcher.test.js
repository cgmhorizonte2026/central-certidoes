'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {spawn}=require('node:child_process');
const {portOwners,processOwnsServer}=require('../scripts/iniciar-oculto.cjs');
const source=path.resolve(__dirname,'..');
const run=(exe,args,options={})=>new Promise((resolve,reject)=>{
 const child=spawn(exe,args,{windowsHide:true,...options});let output='';
 child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
 child.once('error',reject);child.once('exit',code=>resolve({code,output}));
});
async function freePort(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
test('port and process identity reject unrelated listeners and similar paths',()=>{
 assert.deepEqual(portOwners(' TCP  0.0.0.0:3030  0.0.0.0:0 LISTENING 123\n TCP [::]:3030 [::]:0 LISTENING 123\n TCP 127.0.0.1:13030 0.0.0.0:0 LISTENING 999',3030),[123]);
 const exe='C:\\Program Files\\nodejs\\node.exe', script='C:\\Certidões A\\server.js';
 const row=`123\t${exe}\t"${exe}" "${script}"`;
 assert.equal(processOwnsServer(row,123,exe,script),true);
 assert.equal(processOwnsServer(row,124,exe,script),false);
 assert.equal(processOwnsServer(row,123,exe,script+'.fake'),false);
 assert.equal(processOwnsServer('123\t'+exe+'\tnode server.js',123,exe,script),false);
});
test('Windows hidden entry starts once, concurrent clicks reuse it, survives launcher exit, rejects third party', {skip:process.platform!=='win32',timeout:90000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'Central Certidões inicializador '));
 fs.mkdirSync(path.join(root,'scripts'));
 for(const file of ['iniciar-oculto.cjs','processos-node.vbs'])fs.copyFileSync(path.join(source,'scripts',file),path.join(root,'scripts',file));
 fs.copyFileSync(path.join(source,'Abrir-Central.vbs'),path.join(root,'Abrir-Central.vbs'));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'fixture'}));
 for(const mod of ['express','playwright','pdf-parse']){const dir=path.join(root,'node_modules',mod);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.js'),'');}
 fs.writeFileSync(path.join(root,'server.js'),`require('node:http').createServer((q,s)=>{if(q.url==='/stop'){s.end();setTimeout(()=>process.exit(0),50);return;}s.setHeader('Content-Type','application/json');s.end(JSON.stringify({ok:true,version:'fixture',pid:process.pid}));}).listen(process.env.PORT,'127.0.0.1');`);
 const port=await freePort(),url='http://localhost:'+port;
 const env={...process.env,PORT:String(port)};
 const cscript=path.join(process.env.SystemRoot,'System32','cscript.exe');
 const open=()=>run(cscript,['//nologo','//B',path.join(root,'Abrir-Central.vbs')],{env});
 try{
  const first=await open();assert.equal(first.code,0,first.output+JSON.stringify(fs.readdirSync(path.join(root,'.runtime','inicializador'))));
  const before=await (await fetch(url+'/api/health')).json();assert.ok(before.pid);
  const repeat=await Promise.all([open(),open()]);for(const item of repeat)assert.equal(item.code,0,item.output);
  const after=await (await fetch(url+'/api/health')).json();assert.equal(after.pid,before.pid);
  assert.equal(fs.existsSync(path.join(root,'.runtime','inicializador','abrindo.lock')),false);
  await fetch(url+'/stop');await new Promise(r=>setTimeout(r,500));
  const other=net.createServer(s=>s.destroy());await new Promise(r=>other.listen(port,'127.0.0.1',r));
  try{
   const errorFile=path.join(root,'error.txt');const blocked=await run(process.execPath,[path.join(root,'scripts','iniciar-oculto.cjs'),errorFile],{env});
   assert.equal(blocked.code,1);assert.match(fs.readFileSync(errorFile,'utf8'),/ocupada/);assert.ok(other.listening);
  }finally{await new Promise(r=>other.close(r));}
 }finally{try{await fetch(url+'/stop',{signal:AbortSignal.timeout(1000)});}catch{} }
});
