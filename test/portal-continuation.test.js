const test=require('node:test');
const assert=require('node:assert/strict');
const {launchBrowser}=require('../automation/launch');
const {findSafeContinuation}=require('../automation/portalRunner');

test('selects a contextual certificate confirmation instead of unrelated buttons',async()=>{
  const browser=await launchBrowser(true);
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await page.setContent(`<main><button>Continuar</button><p>Notícias da prefeitura</p></main><div role="dialog" aria-modal="true"><h2>Confirmar geração da Certidão</h2><p>Não encontramos débitos. Deseja emitir uma certidão negativa de débitos?</p><button>Cancelar</button><button id="safe">Confirmar Certidão</button></div>`);
    const choice=await findSafeContinuation(context);
    assert.ok(choice);assert.equal(choice.info.text,'Confirmar Certidão');
  }finally{await browser.close();}
});

test('does not choose a generic action without issuance context',async()=>{
  const browser=await launchBrowser(true);
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await page.setContent('<main><p>Portal de notícias</p><button>Continuar</button><button>Confirmar</button></main>');
    assert.equal(await findSafeContinuation(context),null);
  }finally{await browser.close();}
});

test('visible modal blocks certificate buttons behind it',async()=>{const browser=await launchBrowser(true);try{const context=await browser.newContext(),page=await context.newPage();await page.setContent('<main><h2>Confirmar emissão de certidão</h2><button id="behind">Confirmar Certidão</button></main><div role="dialog" aria-modal="true"><p>Serviço indisponível</p><button>Fechar</button></div>');assert.equal(await findSafeContinuation(context),null);}finally{await browser.close();}});
