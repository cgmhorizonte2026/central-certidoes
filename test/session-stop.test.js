const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {BrowserManager}=require('../automation/browser');
const {withCancellation,checkCancelled}=require('../automation/cancellation');
const {launchBrowser}=require('../automation/launch');
const waitFor=async predicate=>{const until=Date.now()+5000;while(Date.now()<until){if(await predicate())return;await new Promise(r=>setTimeout(r,20));}throw Error('Fixture timed out');};
const base=path.resolve(__dirname,'..','tmp');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'stop-test-'));process.env.CENTRAL_CERTIDOES_STORAGE=root;
const {app,sessionControl,sessionServices}=require('../server');
const original={...sessionServices};
test.after(async()=>{Object.assign(sessionServices,original);for(const id of sessionControl.sessions.keys()){await sessionControl.stop(id);const log=path.join(__dirname,'..','data','logs',id+'.jsonl');if(fs.existsSync(log))fs.unlinkSync(log);}assert.ok(path.resolve(root).startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
test('Stop rejects manual and CAPTCHA waits instead of treating cancellation as Continue',async()=>{
  for(const kind of ['manual','captcha']){
    const events=[],browser=new BrowserManager(e=>events.push(e));
    browser.captchaState=async()=>({captcha_active:true,blocking:true});browser.captchaSolved=async()=>false;
    const waiting=kind==='manual'?browser.waitForHumanResume('teste'):browser.waitForCaptcha({},'teste',600000,true);
    const rejected=assert.rejects(waiting,e=>e.code==='SESSION_CANCELLED');
    await browser.close();await rejected;
    assert.equal(events.some(e=>['resumed','captcha_solved','manual_resume'].includes(e.type)),false);
    await assert.rejects(browser.newPortalPage(),/cancelada/);
  }
});
test('Stop closes only owned tabs and interrupts a pending page operation',async()=>{
  const real=await launchBrowser(true);
  try{
    const user=await real.newPage(),owned=await real.newPage();
    const manager=new BrowserManager(()=>{});manager.browser={close:async()=>{}};manager.own(owned);
    const waiting=owned.locator('#missing').waitFor({timeout:60000});const rejected=assert.rejects(waiting,/closed/i);
    await manager.close();await rejected;assert.equal(owned.isClosed(),true);assert.equal(user.isClosed(),false);
  }finally{await real.close();}
});
test('cancelled async execution cannot perform late filesystem work',async()=>{
  const controller=new AbortController();let release;
  const waiting=withCancellation(controller.signal,async()=>{await new Promise(r=>release=r);checkCancelled();throw Error('must not reach write');});
  controller.abort(Object.assign(new Error('cancelled'),{code:'SESSION_CANCELLED'}));release();
  await assert.rejects(waiting,e=>e.code==='SESSION_CANCELLED');
});
test('HTTP stop releases the queue while old browser closes, repeated old stop cannot cancel new query, late results are ignored',async()=>{
  const browsers=[],runs=[];
  sessionServices.lookupCompany=async()=>({uf:'DF',municipio:'Brasília',municipio_codigo_ibge:'5300108'});
  sessionServices.resolvePortals=async()=>({portals:[{key:'federal',name:'Teste Federal',url:'https://example.invalid'},{key:'fgts',name:'Teste FGTS'}],municipalResolution:{}});
  sessionServices.createBrowser=emit=>{const b=new BrowserManager(emit);b.browser={close:()=>new Promise(()=>{})};browsers.push(b);return b;};
  sessionServices.runPortal=payload=>new Promise(resolve=>runs.push({...payload,resolve}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
  const post=(route,body={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const a=await (await post('/api/session',{cnpj:'00000000000191'})).json();await waitFor(()=>runs.length===1);
    const stopping=post('/api/session/'+a.sessionId+'/stop');await waitFor(()=>sessionControl.activeId===null);
    const r=await post('/api/session',{cnpj:'11222333000181'});assert.equal(r.status,200);const b=await r.json();await waitFor(()=>runs.length===2);
    assert.equal((await stopping).status,200);assert.equal(browsers[0].cancelled,true);assert.equal(browsers[1].cancelled,undefined);
    assert.equal((await post('/api/session/'+a.sessionId+'/stop')).status,200);assert.equal(sessionControl.activeId,b.sessionId);
    runs[0].emit({type:'portal_done',portal:'federal'});runs[0].resolve({filePath:'must-never-be-read.pdf'});await new Promise(r=>setTimeout(r,50));
    const old=await (await fetch(url+'/api/session/'+a.sessionId)).json();assert.equal(old.status,'stopped');assert.equal(old.events.some(e=>e.type==='portal_done'||e.type==='error'),false);assert.equal(runs.length,2);
    assert.equal(sessionControl.activeId,b.sessionId);await post('/api/session/'+b.sessionId+'/stop');runs[1].resolve(null);
  }finally{await new Promise(r=>server.close(r));}
});
test('queue reservation is atomic during lookup and Stop cancels a starting query',async()=>{
  let release;sessionServices.lookupCompany=()=>new Promise(r=>release=r);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
  const post=(route,body={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    const first=post('/api/session',{cnpj:'00000000000191',sessionId:'starting-query-12345'});await waitFor(()=>release);
    assert.equal((await post('/api/session',{cnpj:'11222333000181'})).status,409);
    assert.equal((await post('/api/session/starting-query-12345/stop')).status,200);assert.equal(sessionControl.activeId,null);
    release({uf:'DF'});assert.equal((await first).status,409);assert.equal(sessionControl.sessions.get('starting-query-12345').status,'stopped');
  }finally{await new Promise(r=>server.close(r));}
});
test('real interface Stop enables a new consultation immediately',async()=>{
  const runs=[];
  sessionServices.lookupCompany=async()=>({uf:'DF',municipio:'Brasília',municipio_codigo_ibge:'5300108'});
  sessionServices.resolvePortals=async()=>({portals:[{key:'federal',name:'Federal teste',url:'https://example.invalid'}],municipalResolution:{}});
  sessionServices.createBrowser=emit=>new BrowserManager(emit);
  sessionServices.runPortal=payload=>new Promise(resolve=>runs.push({...payload,resolve}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
  const real=await launchBrowser(true);
  try{
    const page=await real.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    await page.goto(origin+'/central-certidoes.html');
    await page.evaluate(()=>{document.getElementById('cnpj').value='00.000.000/0001-91';});
    await page.evaluate(()=>window.startSingleCertificate('federal'));await waitFor(()=>runs.length===1);
    const first=sessionControl.activeId;
    await page.waitForFunction(()=>document.getElementById('dashStop')?.disabled===false);await page.locator('#dashStop').click();
    await page.waitForFunction(()=>document.getElementById('btnConsultarTodas').disabled===false);
    assert.equal(sessionControl.sessions.get(first).status,'stopped');assert.equal(sessionControl.activeId,null);
    await page.evaluate(()=>{document.getElementById('cnpj').value='11.222.333/0001-81';});
    await page.evaluate(()=>window.startSingleCertificate('federal'));await waitFor(()=>runs.length===2);
    const second=sessionControl.activeId;assert.notEqual(first,second);assert.equal(sessionControl.sessions.get(second).cnpj,'11222333000181');
    runs[0].emit({type:'error',message:'late old error'});runs[0].resolve(null);
    await page.waitForFunction(()=>document.getElementById('dashStop')?.disabled===false);await page.locator('#dashStop').click();
    await page.waitForFunction(()=>document.getElementById('btnConsultarTodas').disabled===false);runs[1].resolve(null);
    assert.deepEqual(errors,[]);
  }finally{await real.close();await new Promise(r=>server.close(r));}
});
test('Stop abort signal interrupts portal-discovery HTTP requests',async()=>{
  const {MunicipalPortalResolver}=require('../lib/municipal-portal-resolver');
  let requested=false;const controller=new AbortController();
  const resolver=new MunicipalPortalResolver({fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{requested=true;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const pending=withCancellation(controller.signal,()=>resolver.getText('https://example.invalid'));
  await waitFor(()=>requested);controller.abort(Object.assign(new Error('cancelled'),{code:'SESSION_CANCELLED'}));
  await assert.rejects(pending,e=>e.code==='SESSION_CANCELLED');
});
