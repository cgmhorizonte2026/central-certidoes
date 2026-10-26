const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

class BrowserManager {
  constructor(emit, { chromiumImpl = chromium, launchTimeoutMs = 30000 } = {}) {
    this.emit = emit;
    this.chromiumImpl = chromiumImpl;
    this.launchTimeoutMs = launchTimeoutMs;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.resumeResolver = null;
    this.connectedToExistingChrome = false;
    this.closed = false;
  }

  async startManagedChrome() {
    // A instalação para os usuários não pode depender do Chrome pessoal de
    // cada máquina. Playwright mantém um Chromium próprio que também permite
    // a intervenção manual em CAPTCHA, na mesma janela e sessão.
    this.browser = await this.launchBrowser({ headless: false, args: ['--start-maximized'] });
    this.connectedToExistingChrome = false;
    this.emit({ type: 'browser_started', stage: 'browser_start', durationMs: this.lastLaunchDurationMs, message: 'Chromium da Central iniciado em janela própria.' });
  }

  async launchBrowser(options) {
    const startedAt = Date.now();
    const launch = this.chromiumImpl.launch(options);
    let timer;
    try {
      const browser = await Promise.race([
        launch,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`O Chromium não iniciou em ${this.launchTimeoutMs} ms.`);
            error.code = 'BROWSER_LAUNCH_TIMEOUT';
            reject(error);
          }, this.launchTimeoutMs);
        })
      ]);
      this.lastLaunchDurationMs = Date.now() - startedAt;
      if (this.closed) {
        await browser.close().catch(() => {});
        throw new Error('A inicialização do Chromium foi cancelada junto com a consulta.');
      }
      return browser;
    } catch (error) {
      // Se o Playwright concluir a inicialização depois do limite, fecha a
      // instância atrasada para não deixar um Chromium órfão no computador.
      if (error.code === 'BROWSER_LAUNCH_TIMEOUT') launch.then(browser => browser.close()).catch(() => {});
      this.lastLaunchDurationMs = Date.now() - startedAt;
      this.emit({ type: 'browser_start_failed', stage: 'browser_start', durationMs: this.lastLaunchDurationMs, cause: error.code || error.name || 'ERROR', message: error.message });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async focusInteractiveWindow(page = this.page) {
    await page?.bringToFront().catch(() => {});
    if (process.platform !== 'win32') return;
    const title = await page?.title().catch(() => '');
    if (!title) return;
    const safeTitle = title.replace(/'/g, "''");
    const script = [
      `$needle='${safeTitle}'; $p=Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*\\.runtime\\browsers\\chromium-*' -and $_.MainWindowTitle.StartsWith($needle,[StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1;`,
      "if($p){ Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CentralWindowFocus { [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }' -ErrorAction SilentlyContinue; [void][CentralWindowFocus]::ShowWindowAsync($p.MainWindowHandle,9); [void][CentralWindowFocus]::SetForegroundWindow($p.MainWindowHandle) }"
    ].join(' ');
    await new Promise(resolve => execFile('powershell.exe', ['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',script], { windowsHide:true, timeout:3000 }, () => resolve()));
  }

  async ensure() {
    if (this.closed) throw new Error('A sessão do navegador foi encerrada.');
    if (this.browser && !this.browser.isConnected()) this.browser=this.context=this.page=null;
    if (!this.browser) {
      // On Linux/VPS use headless Chromium. On Windows use the managed,
      // visible window so the operator can complete any human challenge.
      if (process.platform !== 'win32') {
        this.browser = await this.launchBrowser({ headless: true });
        this.connectedToExistingChrome = false;
        this.emit({ type: 'browser_started', stage: 'browser_start', durationMs: this.lastLaunchDurationMs, message: 'Chromium gerenciado pelo Playwright iniciado no ambiente Linux.' });
      }
    }
    if (!this.browser) {
      // Use sempre o navegador empacotado e controlado pela Central. Além de
      // funcionar em máquinas sem Chrome, evita conexão CDP pendurada e mantém
      // a mesma janela disponível para resolver CAPTCHA e retomar a sessão.
      await this.startManagedChrome();
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
    this.closed = true;
    this.resumeResolver?.();
    this.resumeResolver = null;
    // Nunca fecha o Chrome do usuário. Apenas desconecta a automação.
    try { await this.browser?.close(); } catch (_) {}
    this.browser = this.context = this.page = null;
    this.connectedToExistingChrome = false;
  }

  async waitForHumanResume(message) {
    await this.focusInteractiveWindow();
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

  async waitForCaptcha(page, message, timeoutMs = 600000, force = false, waitForCentralResume = true) {
    let seenCaptcha = (await this.captchaState(page)).captcha_active;
    if (!seenCaptcha && !force) {
      this.emit({ type: 'no_captcha_detected' });
      return true;
    }

    await this.focusInteractiveWindow(page);
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
        if (!waitForCentralResume) { this.resumeResolver = null; return true; }
        const resumeMessage = 'CAPTCHA validado. Clique em Continuar na Central para retomar a consulta.';
        // Re-emit the actionable event after the challenge is solved. The UI
        // uses the latest CAPTCHA boundary, so the original prompt is no
        // longer sufficient to keep the Continue button enabled.
        this.emit({ type:'waiting_for_central_resume', status:'AGUARDANDO_INTERACAO_USUARIO', message:resumeMessage });
        this.emit({ type:'human_action_required', status:'AGUARDANDO_INTERACAO_USUARIO', message:resumeMessage });
        await manualPromise;
        const recheck = await this.captchaState(page);
        this.emit({ type:'CAPTCHA_RECHECK', ...recheck, message:'Reavaliação após o usuário clicar em Continuar.' });
        this.resumeResolver = null;
        if (recheck.captcha_active && recheck.blocking) return false;
        this.emit({ type:'manual_resume' });
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
