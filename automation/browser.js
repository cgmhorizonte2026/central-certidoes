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

  async captchaState(page) {
    const state={captcha_provider:'none',element_found:false,element_visible:false,iframe_visible:false,challenge_visible:false,user_input_visible:false,blocking_message_visible:false,captcha_active:false,detection_reason:''};
    try {
      const selectors=[['iframe[src*="recaptcha"]','recaptcha'],['iframe[title*="reCAPTCHA" i]','recaptcha'],['iframe[src*="hcaptcha"]','hcaptcha'],['iframe[title*="hCaptcha" i]','hcaptcha'],['iframe[src*="challenges.cloudflare.com"]','turnstile'],['.g-recaptcha','recaptcha'],['.h-captcha','hcaptcha'],['.cf-turnstile','turnstile'],['[data-sitekey]','captcha'],['input[name*="captcha" i]:not([type="hidden"])','image/text'],['input[id*="captcha" i]:not([type="hidden"])','image/text']];
      for(const [selector,provider] of selectors){const loc=page.locator(selector),count=await loc.count().catch(()=>0);if(!count)continue;state.element_found=true;for(let i=0;i<count;i++){const item=loc.nth(i),visible=await item.isVisible().catch(()=>false),box=await item.boundingBox().catch(()=>null),hidden=await item.getAttribute('aria-hidden').catch(()=>null),passive=await item.evaluate(el=>!!el.closest('.grecaptcha-badge,[aria-hidden="true"]')).catch(()=>false);if(visible&&!!box&&box.width>8&&box.height>8&&hidden!=='true'&&!passive){state.element_visible=true;state.captcha_provider=provider;if(selector.startsWith('iframe'))state.iframe_visible=true;if(/input/.test(selector))state.user_input_visible=true;}}}
      const challenge=page.locator('[class*="challenge" i], [id*="challenge" i], [class*="captcha" i]');state.challenge_visible=await challenge.count().catch(()=>0)>0&&await challenge.first().isVisible().catch(()=>false);
      const message=page.getByText(/não sou um robô|nao sou um robo|verifique que você é humano|verifique que voce e humano|verify you are human|captcha/i).first();state.blocking_message_visible=await message.isVisible().catch(()=>false);
      state.captcha_active=state.element_visible||state.iframe_visible||state.user_input_visible||(state.challenge_visible&&state.blocking_message_visible);state.blocking=state.captcha_active&&(state.blocking_message_visible||state.challenge_visible||state.user_input_visible||state.iframe_visible);state.detection_reason=state.captcha_active?(state.blocking?'controle/desafio visível bloqueando a emissão':'controle CAPTCHA visível, sem evidência de bloqueio'):state.element_found?'componente CAPTCHA presente apenas no DOM, sem interação visível':'';if(state.element_found||state.blocking_message_visible)this.emit({type:'captcha_detection',...state});return state;
    } catch (_) { return state; }
  }
  async captchaPresent(page) { return (await this.captchaState(page)).captcha_active; }

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
    let seenCaptcha = (await this.captchaState(page)).captcha_active;
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
      const presentState = await this.captchaState(page);
      const presentNow = presentState.captcha_active && presentState.blocking;
      if (presentNow) seenCaptcha = true;

      if (seenCaptcha && await this.captchaSolved(page)) {
        this.emit({ type: 'captcha_solved' });
        await page.waitForTimeout(1200);
        await page.bringToFront().catch(() => {});
        this.resumeResolver = null;
        return true;
      }

      if (resumedManually) {
        const recheck = await this.captchaState(page);
        this.emit({ type:'CAPTCHA_RECHECK', ...recheck, message:'Reavaliação completa após Continuar.' });
        if (!recheck.captcha_active || !recheck.blocking) {
          this.emit({ type:'captcha_false_positive_avoided', message:'Nenhum CAPTCHA visível e bloqueante permanece; retomando o fluxo.' });
        }
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
