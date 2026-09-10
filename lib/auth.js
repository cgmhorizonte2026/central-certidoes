const crypto=require('node:crypto');
const digest=(password,salt)=>crypto.scryptSync(password,salt,64).toString('hex');
function credentials(username,password){
 username=String(username||'').trim();password=String(password||'');
 if(!/^[\p{L}\p{N}_. -]{3,60}$/u.test(username)||password.length<12||password.length>200)throw Object.assign(new Error('Nome: 3 a 60 caracteres. Senha: 12 a 200 caracteres.'),{status:400});
 const salt=crypto.randomBytes(16).toString('hex');return {username,salt,hash:digest(password,salt)};
}
const publicUser=u=>({username:u.username,role:u.role,active:u.active!==false});
function createAuth(store){
 const sessions=new Map(),attempts=new Map();
 // The previous version had exactly one owner account, created during local setup.
 for(const u of store.all('user'))if(!u.role){u.role='admin';u.active=true;store.put('user',u.username,u);store.audit({type:'owner_role_migrated'},u.username);}
 function token(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('central_session='))?.slice(16);}
 function current(req){const s=sessions.get(token(req));if(!s||s.expires<Date.now())return null;const u=store.get('user',s.username);if(!u||u.active===false)return null;return {...s,role:u.role};}
 function revoke(username){for(const [id,s] of sessions)if(s.username===username)sessions.delete(id);}
 function requireUser(req,res,next){const s=current(req);if(!s)return res.status(401).json({error:'Entre para acessar a Central.'});if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==s.csrf)return res.status(403).json({error:'Sessão de segurança inválida. Atualize a página.'});req.user=s;next();}
 function requireAdmin(req,res,next){if(req.user?.role!=='admin')return res.status(403).json({error:'Somente administradores podem gerenciar cadastros.'});next();}
 function routes(app){
  app.get('/api/auth',(req,res)=>{const s=current(req);res.json({setupRequired:false,administratorRequired:!store.all('user').length,user:s?{username:s.username,role:s.role,csrf:s.csrf}:null});});
  app.post('/api/setup',(_req,res)=>res.status(403).json({error:'Cadastro público desativado. Solicite acesso ao administrador.'}));
  app.post('/api/login',(req,res)=>{
   const key=req.ip;let limit=attempts.get(key);if(!limit||limit.until<Date.now()){limit={count:0,until:Date.now()+300000};attempts.set(key,limit);}if(++limit.count>10)return res.status(429).json({error:'Muitas tentativas. Aguarde 5 minutos.'});
   const u=store.get('user',String(req.body.username||'').trim());const hash=digest(String(req.body.password||'').slice(0,200),u?.salt||'invalid-user-salt');
   if(!u||u.active===false||!crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(u.hash)))return res.status(401).json({error:'Usuário ou senha inválidos.'});
   attempts.delete(key);const id=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');sessions.set(id,{username:u.username,csrf,expires:Date.now()+28800000});res.cookie('central_session',id,{httpOnly:true,sameSite:'strict',path:'/',maxAge:28800000});store.audit({type:'login'},u.username);res.json({...publicUser(u),csrf});
  });
  app.post('/api/logout',(req,res)=>{sessions.delete(token(req));res.clearCookie('central_session',{path:'/'});res.json({ok:true});});
 }
 function adminRoutes(app){
  app.get('/api/admin/users',requireAdmin,(_req,res)=>res.json(store.all('user').map(publicUser)));
  app.post('/api/admin/users',requireAdmin,(req,res)=>{
   const u=credentials(req.body.username,req.body.password);if(store.all('user').some(x=>x.username.toLowerCase()===u.username.toLowerCase()))return res.status(409).json({error:'Usuário já cadastrado.'});
   if(!['admin','operator'].includes(req.body.role))return res.status(400).json({error:'Perfil inválido.'});
   Object.assign(u,{role:req.body.role,active:req.body.active!==false});store.audit({type:'user_created',user:publicUser(u)},req.user.username);store.put('user',u.username,u);res.status(201).json(publicUser(u));
  });
  app.patch('/api/admin/users/:username',requireAdmin,(req,res)=>{
   const u=store.get('user',req.params.username);if(!u)return res.status(404).json({error:'Usuário não encontrado.'});
   const role=req.body.role??u.role,active=req.body.active??(u.active!==false);
   if(!['admin','operator'].includes(role)||typeof active!=='boolean')return res.status(400).json({error:'Perfil ou situação inválida.'});
   if(u.role==='admin'&&u.active!==false&&(role!=='admin'||!active)&&store.all('user').filter(x=>x.role==='admin'&&x.active!==false).length<=1)return res.status(409).json({error:'Mantenha pelo menos um administrador ativo.'});
   if(req.body.password){const c=credentials(u.username,req.body.password);u.salt=c.salt;u.hash=c.hash;}
   Object.assign(u,{role,active});store.audit({type:'user_updated',user:publicUser(u),passwordReset:!!req.body.password},req.user.username);store.put('user',u.username,u);revoke(u.username);res.json(publicUser(u));
  });
 }
 return {routes,adminRoutes,requireUser,requireAdmin};
}
module.exports={createAuth,credentials};
