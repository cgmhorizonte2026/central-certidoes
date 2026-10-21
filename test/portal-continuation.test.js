const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {findSafeContinuation,continueIssuanceFlow}=require('../automation/portalRunner');
const portals=require('../config/portals');

test('Federal post-CAPTCHA action only targets the explicit new-certificate choice',()=>{
  const action=portals.find(p=>p.key==='federal').afterCaptchaActions[0];
  assert.ok(action.selectors.every(selector=>/Emitir Nova Certidão/i.test(selector)));
});

test('selects a contextual certificate confirmation instead of unrelated buttons',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await page.setContent(`<main><button>Continuar</button><p>Notícias da prefeitura</p></main><div role="dialog" aria-modal="true"><h2>Confirmar geração da Certidão</h2><p>Não encontramos débitos. Deseja emitir uma certidão negativa de débitos?</p><button>Cancelar</button><button id="safe">Confirmar Certidão</button></div>`);
    const choice=await findSafeContinuation(context);
    assert.ok(choice);assert.equal(choice.info.text,'Confirmar Certidão');
  }finally{await browser.close();}
});

test('does not choose a generic action without issuance context',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await page.setContent('<main><p>Portal de notícias</p><button>Continuar</button><button>Confirmar</button></main>');
    assert.equal(await findSafeContinuation(context),null);
  }finally{await browser.close();}
});

test('does not classify the ordinary federal issue form button as a confirmation dialog',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await page.setContent('<form><h1>Certidão de Regularidade Fiscal</h1><label>CNPJ<input value="00.000.000/0001-91"></label><button>Emitir Certidão</button></form>');
    assert.equal(await findSafeContinuation(context),null);
  }finally{await browser.close();}
});

test('does not click the same contextual confirmation twice when the portal leaves it visible',async()=>{
  const browser=await chromium.launch({headless:true});
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'central-continuation-'));
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await page.setContent('<div role="dialog" aria-modal="true"><h2>Confirmar geração da Certidão</h2><p>Deseja emitir uma certidão negativa de débitos?</p><button id="confirm" onclick="window.clicks=(window.clicks||0)+1">Confirmar Certidão</button></div>');
    const events=[];
    const result=await continueIssuanceFlow({page,context,browser:{captchaState:async()=>({captcha_active:false,blocking:false})},portal:{key:'federal',name:'Federal'},baseDir:root,emit:e=>events.push(e),maxSteps:5});
    assert.equal(await page.evaluate(()=>window.clicks),1);
    assert.equal(result.status,'ESTADO_DESCONHECIDO');
    assert.ok(events.some(e=>e.type==='continuation_duplicate_blocked'));
  }finally{await browser.close();fs.rmSync(root,{recursive:true,force:true});}
});
