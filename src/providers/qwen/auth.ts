import { randomUUID } from 'node:crypto';
import type { BrowserContext, BrowserType as PlaywrightBrowserType, Page } from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import type { AgentProxyConfig } from '../../config.js';
import { getPaths } from '../../config.js';

interface SessionState {
  page: Page;
  chatId: string;
  model: string;
  lastActivity: number;
  headers: Record<string, string>;
}

class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => this.queue.push(() => resolve(() => this.release())));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

const sessionTtlMs = 30 * 60 * 1000;

export class QwenBrowserAuth {
  private context: BrowserContext | null = null;
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionLocks = new Map<string, Mutex>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AgentProxyConfig,
    private readonly accountId = 'main'
  ) {}

  async authenticate(force = false): Promise<void> {
    await this.close();
    const context = await this.launch(false);
    if (force) await context.clearCookies();
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    process.stdout.write(`\nConclua o login na janela do Qwen para a conta "${this.accountId}". A verificacao e automatica.\n`);

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (await this.hasSession(context, page)) {
        process.stdout.write(`Sessao do navegador Qwen confirmada para "${this.accountId}".\n`);
        await context.close();
        this.context = null;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    await context.close();
    this.context = null;
    throw new Error('Tempo limite de 10 minutos para login excedido.');
  }

  async status(): Promise<{ authenticated: boolean; detail: string }> {
    try {
      const context = await this.ensureContext();
      const cookies = await context.cookies('https://chat.qwen.ai/');
      const authenticated = this.hasAuthCookie(cookies.map((cookie) => cookie.name));
      return {
        authenticated,
        detail: authenticated ? `Sessao do navegador encontrada (${this.accountId})` : `Execute: proxy login qwen ${this.accountId}`
      };
    } catch (error) {
      return { authenticated: false, detail: (error as Error).message };
    }
  }

  async getBasicHeaders(): Promise<Record<string, string>> {
    const context = await this.ensureContext();
    const page = context.pages()[0] || await this.newPageWithRecovery();
    if (!page.url().includes('chat.qwen.ai')) {
      await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    return this.extractHeaders(page);
  }

  async acquireSession(sessionId: string, model: string): Promise<{ session: SessionState; release: () => void }> {
    const mutex = this.getLock(sessionId);
    const release = await mutex.acquire();
    try {
      const session = await this.ensureSession(sessionId, model);
      session.lastActivity = Date.now();
      return { session, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  async invalidateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      await session.page.close().catch(() => undefined);
    }
    this.sessionLocks.delete(sessionId);
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.sessions.clear();
    if (this.context) await this.context.close().catch(() => undefined);
    this.context = null;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context && this.isContextUsable(this.context)) return this.context;
    await this.resetContext();
    this.context = await this.launch(this.config.providers.qwen.headless);
    this.cleanupTimer = setInterval(() => void this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
    return this.context;
  }

  private async launch(headless: boolean): Promise<BrowserContext> {
    const choice = this.config.providers.qwen.browser;
    let browser: PlaywrightBrowserType = chromium;
    let channel: string | undefined;
    if (choice === 'firefox') browser = firefox;
    else if (choice === 'webkit') browser = webkit;
    else if (choice === 'chrome') channel = 'chrome';
    else if (choice === 'edge') channel = 'msedge';

    const context = await browser.launchPersistentContext(getPaths().qwenProfileFor(this.accountId), {
      headless,
      channel,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled']
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    context.once('close', () => {
      if (this.context === context) {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
        this.context = null;
        this.sessions.clear();
      }
    });
    this.context = context;
    return context;
  }

  private async ensureSession(sessionId: string, model: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing?.model === model && !existing.page.isClosed()) return existing;
    if (existing) {
      await existing.page.close().catch(() => undefined);
      this.sessions.delete(sessionId);
    }
    const page = await this.newPageWithRecovery();
    await page.goto('https://chat.qwen.ai/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (!(await this.hasSession(page.context(), page))) {
      await page.close();
      throw new Error('Sessao do Qwen expirada. Execute: proxy setup');
    }

    try {
      const headers = await this.extractHeaders(page);
      const chatId = await this.createChat(headers, model);
      const state: SessionState = {
        page,
        chatId,
        model,
        lastActivity: Date.now(),
        headers
      };
      this.sessions.set(sessionId, state);
      return state;
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  private async createChat(headers: Record<string, string>, model: string): Promise<string> {
    const response = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        cookie: headers.cookie,
        origin: 'https://chat.qwen.ai',
        referer: 'https://chat.qwen.ai/c/new-chat',
        'user-agent': headers['user-agent'],
        'x-request-id': randomUUID(),
        'bx-ua': headers['bx-ua'],
        'bx-umidtoken': headers['bx-umidtoken'] || '',
        'bx-v': headers['bx-v'] || '2.5.36'
      },
      body: JSON.stringify({
        chatId: '',
        models: [model],
        project_id: '',
        timestamp: Date.now(),
        chat_type: 't2t',
        chat_mode: 'normal'
      }),
      signal: AbortSignal.timeout(30_000)
    });
    const body = await response.json().catch(() => ({})) as {
      success?: boolean;
      data?: { id?: string; code?: string; details?: string };
      message?: string;
    };
    if (!response.ok || body.success === false || !body.data?.id) {
      const detail = body.data?.details || body.message || `HTTP ${response.status}`;
      throw Object.assign(new Error(`Qwen chat creation failed: ${detail}`), {
        statusCode: response.status >= 400 ? response.status : 502
      });
    }
    return body.data.id;
  }

  private async extractHeaders(page: Page): Promise<Record<string, string>> {
    const cookies = await page.context().cookies('https://chat.qwen.ai/');
    const userAgent = await page.evaluate(() => navigator.userAgent);
    return {
      cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      'user-agent': userAgent,
      'bx-ua': this.deriveBxUa(userAgent),
      'bx-umidtoken': '',
      'bx-v': '2.5.36',
      'x-request-id': randomUUID()
    };
  }

  private deriveBxUa(userAgent: string): string {
    return userAgent
      .replace(/^Mozilla\/\d\.\d\s*/, '')
      .replace(/AppleWebKit\/[\d.]+/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || 'Mozilla/5.0 Chrome';
  }

  private async hasSession(context: BrowserContext, page: Page): Promise<boolean> {
    const cookies = await context.cookies('https://chat.qwen.ai/');
    return !page.url().includes('/auth') && !page.url().includes('/login') &&
      this.hasAuthCookie(cookies.map((cookie) => cookie.name));
  }

  private hasAuthCookie(names: string[]): boolean {
    return names.some((name) => /token|session|auth/i.test(name));
  }

  private getLock(sessionId: string): Mutex {
    let lock = this.sessionLocks.get(sessionId);
    if (!lock) {
      lock = new Mutex();
      this.sessionLocks.set(sessionId, lock);
    }
    return lock;
  }

  private async newPageWithRecovery(): Promise<Page> {
    try {
      return await (await this.ensureContext()).newPage();
    } catch (error) {
      if (!this.isClosedContextError(error)) throw error;
      await this.resetContext();
      return (await this.ensureContext()).newPage();
    }
  }

  private isContextUsable(context: BrowserContext): boolean {
    try {
      context.pages();
      return true;
    } catch {
      return false;
    }
  }

  private isClosedContextError(error: unknown): boolean {
    return /has been closed|Target page, context or browser has been closed/i.test((error as Error).message || '');
  }

  private async resetContext(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.sessions.clear();
    if (this.context) await this.context.close().catch(() => undefined);
    this.context = null;
  }

  private async cleanup(): Promise<void> {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [id, state] of this.sessions) {
      if (state.lastActivity < cutoff) {
        await state.page.close().catch(() => undefined);
        this.sessions.delete(id);
        this.sessionLocks.delete(id);
      }
    }
  }
}

export type QwenSessionState = SessionState;
