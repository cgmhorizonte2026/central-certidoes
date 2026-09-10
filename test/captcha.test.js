const test=require('node:test'),assert=require('node:assert/strict');
const {launchBrowser}=require('../automation/launch');
const {resolveCaptcha,recaptchaFrame}=require('../automation/captcha');
test('Buster clicks its injected control once while waiting, then falls back at the limit',async()=>{
 const browser=await launchBrowser(true);try{const context=await browser.newContext();
 await context.route('https://org.gov.br/**',r=>r.fulfill({contentType:'text/html',body:'<iframe src="https://www.google.com/recaptcha/api2/bframe"></iframe>'}));
 await context.route('https://www.google.com/**',r=>r.fulfill({contentType:'text/html',body:`<div class="help-button-holder" style="width:50px;height:50px"></div><script>const root=document.querySelector('div').attachShadow({mode:'closed'});root.innerHTML='<button style="width:50px;height:50px">Solve</button>';root.querySelector('button').onclick=()=>{window.clicks=(window.clicks||0)+1};</script>`}));
 const page=await context.newPage();await page.goto('https://org.gov.br/form');const job={context,busterAvailable:true,portal:{allowedHosts:['org.gov.br']}};const events=[];
 assert.equal((await resolveCaptcha(job,(...e)=>events.push(e),1000)).status,'captcha_solving');await resolveCaptcha(job,()=>{},2000);
 const frame=page.frames()[1];assert.equal(await frame.evaluate(()=>window.clicks),1);await resolveCaptcha(job,()=>{},32000);assert.equal(await frame.evaluate(()=>window.clicks),2);assert.equal((await resolveCaptcha(job,()=>{},64000)).status,'captcha_required');assert.equal(events[0][0],'buster_audio');
 }finally{await browser.close();}
});
test('unsupported challenges and lookalike hosts do not run Buster',async()=>{
 assert.equal(recaptchaFrame('https://www.google.com/recaptcha/api2/bframe?k=test'),true);assert.equal(recaptchaFrame('https://www.google.com.evil.test/recaptcha/api2/bframe'),false);
 const job={busterAvailable:true,context:{pages:()=>[]},portal:{allowedHosts:[]}};assert.match((await resolveCaptcha(job)).message,/não é compatível/);
 assert.match((await resolveCaptcha({busterAvailable:false})).message,/não está disponível/);
});
