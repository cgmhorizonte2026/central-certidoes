const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../lib/store'),{createApp}=require('../lib/app'),{credentials}=require('../lib/auth');
test('no public signup; only administrators create users and organs; blocking revokes sessions',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'central-admin-')),store=new Store(dir);const {app}=createApp({store,testing:true});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function req(url,method='GET',body,auth={}){return fetch(base+url,{method,headers:{'Content-Type':'application/json',Cookie:auth.cookie||'','X-CSRF-Token':auth.csrf||''},body:body?JSON.stringify(body):undefined});}
 async function login(username){const r=await req('/api/login','POST',{username,password:'Teste seguro 1234'});return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:(await r.json()).csrf};}
 try{
 assert.equal((await req('/api/setup','POST',{username:'Invasor',password:'Teste seguro 1234'})).status,403);assert.equal(store.all('user').length,0);
 store.put('user','Gestor',{...credentials('Gestor','Teste seguro 1234'),role:'admin',active:true});const admin=await login('Gestor');
 assert.equal((await req('/api/admin/users','POST',{username:'Operador',password:'Teste seguro 1234',role:'operator'},admin)).status,201);const operator=await login('Operador');
 assert.equal((await req('/api/admin/users','POST',{username:'Outro',password:'Teste seguro 1234',role:'admin'},operator)).status,403);
 assert.equal((await req('/api/admin/orgs','POST',{name:'Controladoria',scope:'institucional'},operator)).status,403);
 assert.equal((await req('/api/admin/orgs','POST',{name:'Controladoria',scope:'institucional'},admin)).status,201);
 assert.equal((await req('/api/admin/users/Gestor','PATCH',{active:false},admin)).status,409);
 const listed=await(await req('/api/admin/users','GET',undefined,admin)).json();assert.equal(listed.some(u=>'hash'in u||'salt'in u),false);
 assert.equal((await req('/api/admin/users/Operador','PATCH',{active:false},admin)).status,200);
 assert.equal((await req('/api/companies','GET',undefined,operator)).status,401);
 assert.equal((await req('/api/login','POST',{username:'Operador',password:'Teste seguro 1234'})).status,401);
 }finally{await new Promise(r=>server.close(r));store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
