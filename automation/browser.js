const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

class BrowserManager {
  constructor(emit) {
    this.emit = emit;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.resumeResolver = null;
    this.connectedToExistingChrome = false;
    this.debugPort = 9222;
  }

  chromePath() {
    const candidates = [
      process.env.CHROME_PATH,
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ].filter(Boolean);
    return candidates.find(fs.existsSync) || null;
  }

  async waitForCdp(timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.debugPort}`);
        this.connectedToExistingChrome = true;
        this.emit({ type: 'browser_connected', message: 'Conectado ao Google Chrome da Central.' });
        return true;
      } catch (_) {
        await new Promise(r => setTimeout(r, 350));
      }
    }
    return false;
  }

  async startChromeWithDebugging() {
    const exe = this.chromePath();
    if (!exe) throw new Error('Google Chrome não foi encontrado no Windows.');

    const profileDir = path.join(__dirname, '..', 'data', 'chrome-automation-profile');
    fs.mkdirSync(profileDir, { recursive: true });

    // Abre um Chrome separado, mas REAL, com perfil persistente e depuração remota.
    // Não usa Chromium do Playwright e não usa --no-sandbox.
    const args = [
      `--remote-debugging-port=${this.debugPort}`,
      `--user-data-dir=${profileDir}`,
      '--start-maximized',
      '--disable-popup-blocking',
      'about:blank'
    ];
    const child = execFile(exe, args, { windowsHide: false });
    child.on('error', err => this.emit({ type: 'browser_error', message: `Erro ao iniciar Chrome: ${err.message}` }));
    this.emit({ type: 'browser_started', message: 'Google Chrome iniciado em sessão própria da Central, sem --no-sandbox. A automação usará a mesma sessão durante toda a fila.' });

    if (!(await this.waitForCdp(20000))) {
      throw new Error('O Chrome foi iniciado, mas a Central não conseguiu conectar à porta 9222. Feche apenas a janela do Chrome da Central e tente novamente.');
    }
  }

  async ensure() {
    if (this.browser && !this.browser.isConnected()) this.browser=this.context=this.page=null;
    if (!this.browser) {
      // Primeiro tenta conectar a uma instância de Chrome já iniciada com CDP.
      if (!(await this.waitForCdp(1800))) {
        await this.startChromeWithDebugging();
      }
    }

    const contexts = this.browser.contexts();
    this.context = contexts[0] || await this.browser.newContext({ acceptDownloads: true, viewport: null });
    const pages = this.context.pages().filter(p => !p.isClosed());
    this.page = pages.find(p => /receitafederal|caixa\.gov\.br|tst\.jus\.br|sefaz\.ce\.gov\.br/i.test(p.url())) || pages[0] || await this.context.newPage();
    await this.page.bringToFront().catch(() => {});
    return this.page;
  }

  async newPortalPage() {
    await this.ensure();
    this.page = await this.context.newPage();
    await this.page.bringToFront().catch(() => {});
    return this.page;
  }

  async close() {
    this.resumeResolver?.();
    this.resumeResolver = null;
    // Nunca fecha o Chrome do usuário. Apenas desconecta a automação.
    try { await this.browser?.close(); } catch (_) {}
    this.browser = this.context = this.page = null;
    this.connectedToExistingChrome = false;
  }

  async waitForHumanResume(message) {
    this.emit({ type: 'human_action_required', message });
    await new Promise(resolve => { this.resumeResolver = resolve; });
    this.resumeResolver = null;
    this.emit({ type: 'resumed' });
  }

  async captchaPresent(page) {
    try {
      const selectors = [
        'iframe[src*="recaptcha"]', 'iframe[title*="reCAPTCHA" i]',
        'iframe[src*="hcaptcha"]', 'iframe[title*="hCaptcha" i]',
        '.g-recaptcha', '.h-captcha', '[data-sitekey]'
      ];
      for (const selector of selectors) if (await page.locator(selector).count()) return true;
      const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
      return /não sou um robô|nao sou um robo|i'm not a robot|captcha/.test(body);
    } catch (_) { return false; }
  }

  async captchaSolved(page) {
    try {
      for (const frame of page.frames()) {
        try {
          const checks = [
            frame.locator('#recaptcha-anchor'),
            frame.locator('[role="checkbox"][aria-checked="true"]'),
            frame.locator('.recaptcha-checkbox-checked')
          ];
          for (const loc of checks) {
            if (await loc.count()) {
              const checked = await loc.getAttribute('aria-checked').catch(() => null);
              if (checked === 'true' || await loc.evaluate(el => el.classList.contains('recaptcha-checkbox-checked')).catch(() => false)) return true;
            }
          }
        } catch (_) {}
      }
      return !(await this.captchaPresent(page));
    } catch (_) { return false; }
  }

  async waitForCaptcha(page, message, timeoutMs = 600000, force = false) {
    let seenCaptcha = await this.captchaPresent(page);
    if (!seenCaptcha && !force) {
      this.emit({ type: 'no_captcha_detected' });
      return true;
    }

    this.emit({ type: 'human_action_required', message });
    let resumedManually = false;
    const manualPromise = new Promise(resolve => {
      this.resumeResolver = () => { resumedManually = true; resolve(true); };
    });
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const presentNow = await this.captchaPresent(page);
      if (presentNow) seenCaptcha = true;

      if (seenCaptcha && await this.captchaSolved(page)) {
        this.emit({ type: 'captcha_solved' });
        await page.waitForTimeout(1200);
        await page.bringToFront().catch(() => {});
        this.resumeResolver = null;
        return true;
      }

      if (resumedManually) {
        this.emit({ type: 'manual_resume' });
        this.resumeResolver = null;
        return true;
      }
      await Promise.race([new Promise(r => setTimeout(r, 700)), manualPromise]);
    }

    this.resumeResolver = null;
    throw new Error('Tempo limite aguardando a conclusão manual do CAPTCHA.');
  }

  resume() { if (this.resumeResolver) this.resumeResolver(); }
}

module.exports = { BrowserManager };
