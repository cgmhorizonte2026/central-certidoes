const { chromium } = require('playwright');
async function launchBrowser(headless = false) {
  try { return await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless }); }
  catch (error) {
    try { return await chromium.launch({ headless }); }
    catch { throw new Error(`Não foi possível abrir o navegador. Instale Edge/Chromium ou configure BROWSER_CHANNEL. ${error.message.split('\n')[0]}`); }
  }
}
module.exports = { launchBrowser };
