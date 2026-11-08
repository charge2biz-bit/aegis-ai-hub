/**
 * Electron main process 契約テスト用の記録型フェイク一式。
 *
 * - すべてのフェイクメソッドは `fakes.calls` に {target, method, args} を追記する。
 * - 戻り値は `set('target.method', 値 | 関数)`、例外は `setThrow('target.method', err)` で設定する。
 * - 実ネットワーク・実 Electron・実サーバーは一切使わない (fastify.listen も記録のみ)。
 * - 認証情報風の値は 'test-key' 形式のダミーのみ。
 */

export interface RecordedCall {
  target: string;
  method: string;
  args: unknown[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Impl = (...args: Any[]) => unknown;

/** 既定の戻り値。値が関数なら呼び出し引数を受けて評価される。 */
const DEFAULTS: Record<string, unknown> = {
  'settingsManager.getInterests': { categories: [{ id: 'tech', name: 'Tech' }] },
  'settingsManager.getFeedConfig': { feeds: { tech: ['https://example.com/rss'] } },
  'settingsManager.getCredentials': { google: { apiKey: 'test-key' } },
  'settingsManager.getUiSettings': { theme: 'dark', autoLaunch: true, obsidianVaultPath: '/fake/vault' },
  'settingsManager.getApiKey': 'test-key',
  'settingsManager.getUsageStats': { totalTokens: 42 },
  'settingsManager.resetToDefaults': true,
  'settingsManager.syncSettings': { lastUpdated: 1700000000000, validatedFeedConfig: { feeds: { tech: [] } } },
  'geminiService.suggestCategoryDetails': { brands: ['BrandA'], keywords: ['kw1'] },
  'discoveryService.getRestructureProposal': { proposals: [{ from: 'a', to: 'b' }] },
  'discoveryService.translateInterests': { categories: [{ id: 'tech', name: 'テクノロジー' }] },
  'discoveryService.reacquireAllFeeds': { feeds: { tech: ['https://example.com/new.xml'] } },
  'scraper.getDashboard': {},
  'scraper.discoverTrends': [{ keyword: 'trend-1' }],
  'scraper.fetchAndProcessArticlesWithFallback': [],
  'licenseManager.activate': { success: true },
  'licenseManager.getFeatureGates': { aiSummary: true, maxFeeds: 10 },
  'resolveObsidianVaultPath.call': (p: unknown) => `resolved:${String(p)}`,
};

export class FakeWebContents {
  handlers = new Map<string, Impl[]>();
  windowOpenHandler: Impl | undefined;
  constructor(private readonly fakes: Fakes, private readonly win: FakeWindow) {}
  private t() { return `window[${this.win.id}].webContents`; }
  toJSON() { return `[WebContents#${this.win.id}]`; }
  send(channel: string, ...args: unknown[]) {
    this.fakes.calls.push({ target: this.t(), method: 'send', args: [channel, ...args] });
    this.fakes.rendererSends.push({ channel, args });
  }
  setWindowOpenHandler(fn: Impl) {
    this.fakes.calls.push({ target: this.t(), method: 'setWindowOpenHandler', args: [fn] });
    this.windowOpenHandler = fn;
  }
  on(event: string, fn: Impl) {
    this.fakes.calls.push({ target: this.t(), method: 'on', args: [event, fn] });
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  openDevTools() { this.fakes.calls.push({ target: this.t(), method: 'openDevTools', args: [] }); }
  toggleDevTools() { this.fakes.calls.push({ target: this.t(), method: 'toggleDevTools', args: [] }); }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

export class FakeWindow {
  id: number;
  options: Any;
  webContents: FakeWebContents;
  handlers = new Map<string, Impl[]>();
  maximized = false;
  destroyed = false;
  closed = false;
  constructor(private readonly fakes: Fakes, options: unknown) {
    this.id = fakes.windows.length;
    this.options = options;
    this.webContents = new FakeWebContents(fakes, this);
  }
  private t() { return `window[${this.id}]`; }
  private rec(method: string, args: unknown[]) { this.fakes.calls.push({ target: this.t(), method, args }); }
  toJSON() { return `[BrowserWindow#${this.id}]`; }
  loadURL(url: string) { this.rec('loadURL', [url]); return Promise.resolve(); }
  loadFile(p: string) { this.rec('loadFile', [p]); return Promise.resolve(); }
  once(event: string, fn: Impl) { this.rec('once', [event, fn]); this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); }
  show() { this.rec('show', []); }
  minimize() { this.rec('minimize', []); }
  maximize() { this.rec('maximize', []); this.maximized = true; }
  unmaximize() { this.rec('unmaximize', []); this.maximized = false; }
  isMaximized() { return this.maximized; }
  isDestroyed() { return this.destroyed; }
  close() { this.rec('close', []); this.closed = true; this.destroyed = true; }
  setMenu(m: unknown) { this.rec('setMenu', [m]); }
  /** once/on で登録されたウィンドウイベントを発火する (例: 'ready-to-show') */
  emit(event: string, ...args: unknown[]) {
    const hs = this.handlers.get(event) ?? [];
    this.handlers.delete(event);
    for (const h of hs) h(...args);
  }
}

export class Fakes {
  calls: RecordedCall[] = [];
  rendererSends: Array<{ channel: string; args: unknown[] }> = [];
  windows: FakeWindow[] = [];
  instances: Record<string, Any> = {};
  ipcHandlers = new Map<string, Impl>();
  ipcListeners = new Map<string, Impl>();
  appHandlers = new Map<string, Impl[]>();
  processHandlers = new Map<string, Impl[]>();
  updaterHandlers = new Map<string, Impl[]>();
  shortcuts = new Map<string, Impl>();
  timers: Array<{ delay: number; fn: Impl }> = [];
  consoleLines: string[] = [];
  serverRegistrations: Array<{ plugin: Impl; opts: Any }> = [];
  routes = new Map<string, Impl>();
  fastifyCalls: unknown[] = [];

  isPackaged = false;
  platform = 'win32';
  tmpRoot = '';
  userData = '';
  exePath = '';
  resourcesPath = '';

  private overrides = new Map<string, Impl>();
  private throws = new Map<string, unknown>();

  // 公開フェイクオブジェクト (require() で返す)
  app: Any;
  BrowserWindow: Any;
  ipcMain: Any;
  shell: Any;
  globalShortcut: Any;
  nativeImage: Any;
  Tray: Any;
  Menu: Any;
  safeStorage: Any;
  autoUpdater: Any;
  log: Any;
  fastify: Any;
  cors: Any;
  nexusRouter: Any;
  resolveObsidianVaultPath: Any;
  process: Any;
  console: Any;
  setTimeoutFake: Any;
  server: Any;

  private readyResolve!: () => void;
  private readyPromise: Promise<void>;
  startupPromise: Promise<unknown> | undefined;

  constructor() {
    this.readyPromise = new Promise<void>((r) => { this.readyResolve = r; });
    this.build();
  }

  // ---- 設定 API -------------------------------------------------------
  /** 戻り値 (または引数を受ける関数) を差し替える */
  set(key: string, valueOrFn: unknown) {
    this.overrides.set(key, typeof valueOrFn === 'function' ? (valueOrFn as Impl) : () => valueOrFn);
    this.throws.delete(key);
  }
  /** 呼び出し時に同期 throw させる (async メソッドでは呼び出し側で reject になる) */
  setThrow(key: string, err: unknown) { this.throws.set(key, err); }

  // ---- 検査 API -------------------------------------------------------
  /** 'target.method' の呼び出し引数列 */
  callsTo(key: string): unknown[][] {
    const [target, method] = splitKey(key);
    return this.calls.filter((c) => c.target === target && c.method === method).map((c) => c.args);
  }
  /** CORS プラグインに渡された origin 関数の判定結果 */
  corsDecision(origin: string | undefined): { allowed: boolean; error?: string } {
    const reg = this.serverRegistrations.find((r) => r.plugin === this.cors);
    if (!reg) throw new Error('cors plugin was not registered');
    let out: { allowed: boolean; error?: string } | undefined;
    reg.opts.origin(origin, (err: Error | null, allow: boolean) => {
      out = err ? { allowed: allow, error: err.message } : { allowed: allow };
    });
    if (!out) throw new Error('cors origin callback was not invoked');
    return out;
  }
  /** 登録済みルートのハンドラを呼ぶ (例: callRoute('GET', '/api/dashboard')) */
  async callRoute(method: string, url: string): Promise<unknown> {
    const h = this.routes.get(`${method} ${url}`);
    if (!h) throw new Error(`route not registered: ${method} ${url}`);
    return await h({}, {});
  }
  /** Electron の whenReady を解決し、起動チェーン完了まで待つ */
  async start() {
    this.readyResolve();
    if (!this.startupPromise) throw new Error('app.whenReady().then() was never called by main');
    await this.startupPromise;
  }

  // ---- 内部 -----------------------------------------------------------
  fn(target: string, method: string, opts: { async?: boolean; def?: unknown } = {}): Impl {
    const key = `${target}.${method}`;
    return (...args: unknown[]) => {
      this.calls.push({ target, method, args });
      if (this.throws.has(key)) throw this.throws.get(key);
      const ov = this.overrides.get(key);
      const dv = opts.def !== undefined ? opts.def : DEFAULTS[key];
      const v = ov ? ov(...args) : typeof dv === 'function' ? (dv as Impl)(...args) : dv;
      return opts.async ? Promise.resolve(v) : v;
    };
  }

  private makeClass(ctorName: string, target: string, instKey: string, asyncNames: string[], syncNames: string[], init?: (self: Any) => void) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fakes = this;
    return class {
      constructor(...args: unknown[]) {
        fakes.calls.push({ target: ctorName, method: 'constructor', args });
        for (const m of asyncNames) (this as Any)[m] = fakes.fn(target, m, { async: true });
        for (const m of syncNames) (this as Any)[m] = fakes.fn(target, m);
        Object.defineProperty(this, 'toJSON', { value: () => `[${ctorName}]`, enumerable: false });
        init?.(this);
        fakes.instances[instKey] = this;
      }
    };
  }

  private on(map: Map<string, Impl[]>, event: string, fn: Impl) {
    map.set(event, [...(map.get(event) ?? []), fn]);
  }

  private build() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fakes = this;

    this.process = {
      get platform() { return fakes.platform; },
      get resourcesPath() { return fakes.resourcesPath; },
      env: {} as Record<string, string>,
      on: (event: string, fn: Impl) => { this.calls.push({ target: 'process', method: 'on', args: [event, fn] }); this.on(this.processHandlers, event, fn); },
    };
    this.console = {
      log: (...a: unknown[]) => { this.consoleLines.push(`log ${a.map(String).join(' ')}`); },
      warn: (...a: unknown[]) => { this.consoleLines.push(`warn ${a.map(String).join(' ')}`); },
      error: (...a: unknown[]) => { this.consoleLines.push(`error ${a.map(String).join(' ')}`); },
    };
    this.setTimeoutFake = (fn: Impl, delay: number) => {
      this.calls.push({ target: 'timers', method: 'setTimeout', args: [fn, delay] });
      this.timers.push({ delay, fn });
      return this.timers.length;
    };

    this.app = {
      get isPackaged() { return fakes.isPackaged; },
      setName: this.fn('app', 'setName'),
      getPath: (name: string) => {
        this.calls.push({ target: 'app', method: 'getPath', args: [name] });
        if (name === 'userData') return this.userData;
        if (name === 'exe') return this.exePath;
        return `${this.tmpRoot}/${name}`;
      },
      whenReady: () => ({
        then: (cb: Impl) => {
          this.calls.push({ target: 'app', method: 'whenReady', args: [] });
          this.startupPromise = this.readyPromise.then(() => cb());
          return this.startupPromise;
        },
      }),
      on: (event: string, fn: Impl) => { this.calls.push({ target: 'app', method: 'on', args: [event, fn] }); this.on(this.appHandlers, event, fn); },
      quit: this.fn('app', 'quit'),
      exit: this.fn('app', 'exit'),
      setLoginItemSettings: this.fn('app', 'setLoginItemSettings'),
    };

    this.BrowserWindow = class {
      constructor(opts: unknown) {
        fakes.calls.push({ target: 'BrowserWindow', method: 'constructor', args: [opts] });
        const w = new FakeWindow(fakes, opts);
        fakes.windows.push(w);
        return w as Any;
      }
      static getAllWindows() { return fakes.windows.filter((w) => !w.closed); }
    };

    this.ipcMain = {
      handle: (channel: string, fn: Impl) => {
        this.calls.push({ target: 'ipcMain', method: 'handle', args: [channel, fn] });
        if (this.ipcHandlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
        this.ipcHandlers.set(channel, fn);
      },
      on: (channel: string, fn: Impl) => {
        this.calls.push({ target: 'ipcMain', method: 'on', args: [channel, fn] });
        this.ipcListeners.set(channel, fn);
      },
    };

    this.shell = { openExternal: this.fn('shell', 'openExternal', { async: true }) };
    this.globalShortcut = {
      register: (accel: string, fn: Impl) => { this.calls.push({ target: 'globalShortcut', method: 'register', args: [accel, fn] }); this.shortcuts.set(accel, fn); return true; },
    };
    this.nativeImage = {
      createFromPath: (p: string) => {
        this.calls.push({ target: 'nativeImage', method: 'createFromPath', args: [p] });
        return { path: p, toJSON: () => `[NativeImage ${p}]` };
      },
    };
    this.Tray = this.makeClass('Tray', 'tray', 'tray', [], ['setToolTip', 'setContextMenu', 'on']);
    this.Menu = { buildFromTemplate: this.fn('Menu', 'buildFromTemplate', { def: {} }) };
    this.safeStorage = {
      isEncryptionAvailable: this.fn('safeStorage', 'isEncryptionAvailable', { def: true }),
      encryptString: this.fn('safeStorage', 'encryptString', { def: Buffer.from('enc') }),
      decryptString: this.fn('safeStorage', 'decryptString', { def: 'decrypted' }),
    };

    this.autoUpdater = {
      logger: undefined,
      on: (event: string, fn: Impl) => { this.calls.push({ target: 'autoUpdater', method: 'on', args: [event, fn] }); this.on(this.updaterHandlers, event, fn); },
      checkForUpdates: this.fn('autoUpdater', 'checkForUpdates', { async: true, def: null }),
      quitAndInstall: this.fn('autoUpdater', 'quitAndInstall'),
    };
    this.log = {
      transports: { file: { level: 'debug' } },
      info: this.fn('log', 'info'),
      warn: this.fn('log', 'warn'),
      error: this.fn('log', 'error'),
    };

    // fastify
    this.server = {
      register: (plugin: Impl, opts: unknown) => {
        this.calls.push({ target: 'server', method: 'register', args: [plugin, opts] });
        this.serverRegistrations.push({ plugin, opts });
        return Promise.resolve();
      },
      get: (url: string, h: Impl) => { this.calls.push({ target: 'server', method: 'get', args: [url, h] }); this.routes.set(`GET ${url}`, h); },
      post: (url: string, h: Impl) => { this.calls.push({ target: 'server', method: 'post', args: [url, h] }); this.routes.set(`POST ${url}`, h); },
      addHook: this.fn('server', 'addHook'),
      listen: this.fn('server', 'listen', { async: true }),
    };
    this.fastify = (opts: unknown) => {
      this.calls.push({ target: 'fastify', method: 'call', args: [opts] });
      this.fastifyCalls.push(opts);
      return this.server;
    };
    this.cors = Object.assign(() => undefined, { fakeName: 'cors' });
    this.nexusRouter = Object.assign(() => undefined, { fakeName: 'nexusRouter' });
    this.resolveObsidianVaultPath = this.fn('resolveObsidianVaultPath', 'call');
  }

  /** require() が返すクラス群 (main が new する対象) */
  serviceModules(): Record<string, Any> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fakes = this;
    const ElectronSettingsManager = this.makeClass('ElectronSettingsManager', 'settingsManager', 'settingsManager',
      ['init', 'getInterests', 'getFeedConfig', 'syncSettings', 'saveFeedConfig', 'getApiKey', 'saveApiKey', 'getCredentials', 'saveCredentials', 'getUiSettings', 'saveUiSettings', 'getUsageStats', 'resetToDefaults'],
      [], (self) => { self.usageManager = { onUpdate: undefined }; });
    const GeminiService = this.makeClass('GeminiService', 'geminiService', 'geminiService',
      ['suggestCategoryDetails'], ['setUsageManager', 'updateApiKey', 'updateCredentials']);
    const FeedManager = this.makeClass('FeedManager', 'feedManager', 'feedManager', ['loadConfig'], ['setSaveHandler']);
    const DiscoveryService = this.makeClass('DiscoveryService', 'discoveryService', 'discoveryService',
      ['getRestructureProposal', 'translateInterests', 'reacquireAllFeeds'], []);
    const EnrichmentService = this.makeClass('EnrichmentService', 'enrichmentService', 'enrichmentService', [], []);
    const RSSFetcher = this.makeClass('RSSFetcher', 'rssFetcher', 'rssFetcher', [], []);
    const ScoringService = this.makeClass('ScoringService', 'scoringService', 'scoringService', [], []);
    const ScraperFacade = this.makeClass('ScraperFacade', 'scraper', 'scraper',
      ['getDashboard', 'discoverTrends', 'fetchAndProcessArticlesWithFallback'], []);
    const NexusOrchestrator = this.makeClass('NexusOrchestrator', 'orchestrator', 'orchestrator',
      [], ['runAutonomousLoop', 'subscribe', 'onEvent']);
    const ObsidianVaultService = this.makeClass('ObsidianVaultService', 'obsidianVaultService', 'obsidianVaultService', [], []);

    const LMClass = this.makeClass('LicenseManager', 'licenseManager', 'licenseManager',
      ['load', 'verify', 'activate', 'deactivate'], ['getFeatureGates'], (self) => { self.state = { tier: 'free' }; });
    let lm: Any;
    const LicenseManager = {
      getInstance: (dir: string) => {
        fakes.calls.push({ target: 'LicenseManager', method: 'getInstance', args: [dir] });
        if (!lm) lm = new LMClass();
        return lm;
      },
    };

    return {
      './ElectronSettingsManager': { ElectronSettingsManager },
      '../src/services/GeminiService': { GeminiService },
      '../src/services/FeedManager': { FeedManager },
      '../src/services/DiscoveryService': { DiscoveryService },
      '../src/services/EnrichmentService': { EnrichmentService },
      '../src/services/RSSFetcher': { RSSFetcher },
      '../src/services/ScoringService': { ScoringService },
      '../src/api/server/NexusRouter': { nexusRouter: this.nexusRouter },
      '../src/ScraperFacade': { ScraperFacade },
      '../src/core/NexusOrchestrator': { NexusOrchestrator },
      '../src/services/ObsidianVaultService': { ObsidianVaultService },
      '../src/models/vaultPath': { resolveObsidianVaultPath: this.resolveObsidianVaultPath },
      '../src/services/LicenseManager': { LicenseManager },
    };
  }
}

function splitKey(key: string): [string, string] {
  const i = key.lastIndexOf('.');
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * 記録用の正規化: キーをソート、関数/インスタンスをマーカー化、tmp パスを <TMP> に置換、Error をメッセージ化。
 */
export function normalizeForRecord(value: unknown, tmpRoot: string): unknown {
  const root = tmpRoot.replace(/\\/g, '/');
  const seen = new WeakSet<object>();
  const walk = (v: Any): Any => {
    if (v === undefined) return '[undefined]';
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.replace(/\\/g, '/').split(root).join('<TMP>');
    if (typeof v === 'function') return v.fakeName ? `[Function ${v.fakeName}]` : '[Function]';
    if (v instanceof Error) return { error: v.message };
    if (typeof v.toJSON === 'function') return walk(v.toJSON());
    if (Buffer.isBuffer(v)) return '[Buffer]';
    if (v instanceof Set) return [...v].map(walk);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
      seen.delete(v);
      return out;
    }
    return String(v);
  };
  return walk(value);
}
