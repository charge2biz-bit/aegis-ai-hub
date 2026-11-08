/**
 * Electron main process の IPC / ライフサイクル契約テスト (特性化テスト)。
 *
 * 現行 electron/main.cjs の「実際の挙動」を固定する。アダプタ (MainUnderTest) だけに依存し、
 * main.cjs の内部には触れない。Phase 3 で electron/main/*.ts に書き換えた後は
 * LOADERS に ['new', loadNewMain] を足せば同じケースがそのまま流れる。
 *
 * `// KNOWN-DEFECT: approved to change in Phase 3` は現行の欠陥を意図的に固定している箇所。
 * 書き換え後に差分が出たらここが可視化される。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLegacyMain } from './harness/legacyMain';
import { loadNewMain } from './harness/newMain';
import { recordCase, recordStartup } from './harness/record';
import type { LoadOptions, MainLoader, MainUnderTest } from './harness/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const LOADERS: Array<[string, MainLoader]> = [['legacy', loadLegacyMain], ['new', loadNewMain]];
let executed = 0;

describe.each(LOADERS)('main process contract (%s)', (name, load) => {
  /**
   * Phase 3 で承認された差分（2026-11-07、MODERNIZATION_BRIEF.md §7）。旧版（legacy）と新版（new）で期待値が変わる:
   * 1. license-changed を preload が受け取れる  2. agent-event を main が送る
   * 3. 内部 HTTP API はトークンの無いリクエストを 401 で断る  4. get-proposals（中身の無いスタブ）を削除
   * 5. nexusApi が呼ぶ HTTP ルート 4 本を NexusRouter に追加（tests/unit/api/NexusRouter.phase3.test.ts で確認）
   *
   * 次の変更は Phase 3 の承認ではなく、Phase 3 のレビュー指摘への対応（P-267）で入れた差分:
   * 定義の無い setWebContents を呼ばない／致命エラーは app.quit でなく app.exit(1)／
   * パッケージ版は内部 HTTP API を待ち受けない／開発中の Fastify ログはクエリのトークンを伏せる
   */
  const isNew = name === 'new';
  const HANDLED_COUNT = isNew ? 23 : 24;
  const booted: MainUnderTest[] = [];
  afterEach(() => { while (booted.length) booted.pop()!.dispose(); });

  async function boot(opts?: LoadOptions) {
    const m = await load(opts);
    booted.push(m);
    return m;
  }

  /** アクションを実行し、戻り値/reject と追加の呼び出しを記録する */
  async function observe(id: string, main: MainUnderTest, action: () => unknown) {
    executed++;
    const base = main.fakes.calls.length;
    let observed: { value?: unknown; rejected?: string };
    try {
      observed = { value: await action() };
    } catch (e) {
      observed = { rejected: String((e as Error)?.message ?? e) };
    }
    recordCase(id, main, observed, base);
    return observed;
  }
  const calls = (m: MainUnderTest, key: string) => m.fakes.callsTo(key);
  const inst = (m: MainUnderTest, key: string): Any => m.fakes.instances[key];
  const win = (m: MainUnderTest, i = 0): Any => m.fakes.windows[i];
  const sends = (m: MainUnderTest) => m.rendererSends.map((s) => s.channel);
  const idx = (m: MainUnderTest, target: string, method: string) =>
    m.fakes.calls.findIndex((c) => c.target === target && c.method === method);

  // ======================================================================
  describe('チャンネル一覧とプリロードとの対応 (RULE-044)', () => {
    const INVOKE = [
      'activate-license', 'check-for-updates', 'deactivate-license', 'discover-trends', 'get-api-key',
      'get-articles', 'get-credentials', 'get-feature-gates', 'get-license-state', 'get-proposals',
      'get-settings', 'get-ui-settings', 'get-usage-stats', 'install-update', 'reacquire-all-feeds',
      'reset-to-defaults', 'restructure-categories', 'save-api-key', 'save-credentials', 'save-ui-settings',
      'suggest-category', 'sync-settings', 'translate-interests', 'trigger-orchestration',
    ];

    // 承認済みの差分 4: 新版では get-proposals を削除した
    const EXPECTED_INVOKE = isNew ? INVOKE.filter((c) => c !== 'get-proposals') : INVOKE;

    it('main が handle するチャンネルは（legacy 24 本 / new 23 本）で、プリロードの invoke と完全一致する', async () => {
      const m = await boot();
      await observe('channels-handled', m, () => ({ handled: m.handledChannels(), on: m.onChannels(), preload: m.preloadChannels() }));
      expect(m.handledChannels()).toEqual(EXPECTED_INVOKE);
      expect(m.preloadChannels().invoke).toEqual(EXPECTED_INVOKE);
    });

    it('main が on で受けるチャンネルは 3 本で、プリロードの send と完全一致する', async () => {
      const m = await boot();
      expect(m.onChannels()).toEqual(['open-article', 'open-external', 'window-control']);
      expect(m.preloadChannels().send).toEqual(['open-article', 'open-external', 'window-control']);
    });

    it('プリロードが購読する on チャンネル（new では license-changed が加わる）', async () => {
      const m = await boot();
      // 承認済みの差分 1: 新版の preload は license-changed を受け取れる
      const expected = isNew
        ? ['agent-event', 'license-changed', 'update-event', 'usage-update']
        : ['agent-event', 'update-event', 'usage-update'];
      expect(m.preloadChannels().on).toEqual(expected);
    });

    it('main がレンダラーへ送るチャンネルは license-changed / update-event / usage-update で、プリロード購読との差分が固定されている', async () => {
      const m = await boot({ packaged: true });
      m.fakes.instances.settingsManager.usageManager.onUpdate({ totalTokens: 1 });
      await m.invoke('activate-license', 'TEST-KEY', 'user@example.com');
      for (const h of m.fakes.updaterHandlers.get('update-available') ?? []) h({ version: '9.9.9' });
      const sent = [...new Set(sends(m))].sort();
      expect(sent).toEqual(['license-changed', 'update-event', 'usage-update']);
      const exposed = m.preloadChannels().on;
      // KNOWN-DEFECT: approved to change in Phase 3 -- 旧版では main は license-changed を送るがプリロードは公開していない
      expect(sent.filter((c) => !exposed.includes(c))).toEqual(isNew ? [] : ['license-changed']);
      // KNOWN-DEFECT: approved to change in Phase 3 -- 旧版ではプリロードは agent-event を購読するが main は一度も送らない
      // （新版の agent-event はエージェントの進捗が出たときに送る。下のケースで確かめる）
      expect(exposed.filter((c) => !sent.includes(c))).toEqual(['agent-event']);
    });

    it('承認済みの差分 2: new では エージェントの進捗を agent-event としてレンダラーへ送る（legacy は送らない）', async () => {
      const m = await boot();
      const subscribed = calls(m, 'orchestrator.onEvent');
      if (!isNew) {
        expect(subscribed).toEqual([]);
        expect(calls(m, 'orchestrator.subscribe')).toEqual([]);
        executed++;
        return;
      }
      // SSE の応答を装わず、onEvent のコールバックで受ける（偽の FastifyReply は渡さない）
      expect(calls(m, 'orchestrator.subscribe')).toEqual([]);
      expect(subscribed).toHaveLength(1);
      const callback = subscribed[0][0] as (n: unknown) => void;
      callback({ status: 'working', agentId: 'architect', message: 'm' });
      expect(m.rendererSends.filter((x) => x.channel === 'agent-event').map((x) => x.args)).toEqual([
        [{ status: 'working', agentId: 'architect', message: 'm' }],
      ]);
      executed++;
    });
  });

  // ======================================================================
  describe('起動シーケンス (RULE-044)', () => {
    it('dev 起動: ライセンス -> 設定 -> IPC -> ウィンドウ の順で初期化し、localhost:5173 を開く', async () => {
      const m = await boot();
      recordStartup('startup-dev', m);
      executed++;
      const order = [
        idx(m, 'LicenseManager', 'getInstance'),
        idx(m, 'licenseManager', 'load'),
        idx(m, 'licenseManager', 'verify'),
        idx(m, 'settingsManager', 'init'),
        idx(m, 'NexusOrchestrator', 'constructor'),
        idx(m, 'ipcMain', 'handle'),
        idx(m, 'BrowserWindow', 'constructor'),
        idx(m, 'globalShortcut', 'register'),
      ];
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      expect(calls(m, 'app.setName')).toEqual([['Aegis Nexus']]);
      expect(calls(m, 'LicenseManager.getInstance')).toEqual([[m.paths.dataDir]]);
      expect(calls(m, 'ElectronSettingsManager.constructor')).toEqual([[{ dataDir: m.paths.dataDir, isDev: true }]]);
      expect(calls(m, 'GeminiService.constructor')).toEqual([[{ google: { apiKey: 'test-key' } }]]);
      expect(calls(m, 'FeedManager.constructor')).toEqual([[path.join(m.paths.dataDir, 'feed_config.json')]]);
      expect(calls(m, 'ScraperFacade.constructor')).toEqual([['', path.join(m.paths.dataDir, 'feed_config.json'), m.paths.dataDir]]);
      expect(calls(m, 'EnrichmentService.constructor')).toEqual([[inst(m, 'geminiService'), m.paths.dataDir]]);
      expect(calls(m, 'DiscoveryService.constructor')).toEqual([[inst(m, 'geminiService'), inst(m, 'rssFetcher'), inst(m, 'feedManager')]]);
      expect(calls(m, 'NexusOrchestrator.constructor')).toEqual([[inst(m, 'geminiService')]]);
      expect(calls(m, 'geminiService.setUsageManager')).toEqual([[inst(m, 'settingsManager').usageManager]]);
      expect(calls(m, 'feedManager.loadConfig')).toHaveLength(1);

      expect(m.fakes.windows).toHaveLength(1);
      expect(calls(m, 'window[0].loadURL')).toEqual([['http://localhost:5173']]);
      expect(calls(m, 'window[0].loadFile')).toEqual([]);
      expect(calls(m, 'window[0].webContents.openDevTools')).toHaveLength(1);
      expect(calls(m, 'app.setLoginItemSettings')).toEqual([]);
      expect(calls(m, 'autoUpdater.on')).toEqual([]);
      expect(m.fakes.timers).toEqual([]);
      expect(m.fakes.shortcuts.has('CommandOrControl+Shift+I')).toBe(true);
    });

    it('メインウィンドウは frameless / sandbox / contextIsolation 有効 / nodeIntegration 無効で作られる', async () => {
      const m = await boot();
      const o = win(m).options;
      expect(o).toMatchObject({
        width: 1440, height: 900, minWidth: 400, minHeight: 300, useContentSize: true, frame: false,
        transparent: false, backgroundColor: '#121214', resizable: true, hasShadow: true, thickFrame: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      expect(path.basename(o.webPreferences.preload)).toBe('preload.cjs');
      expect(calls(m, 'nativeImage.createFromPath')).toHaveLength(1);
      expect(path.basename(String(calls(m, 'nativeImage.createFromPath')[0][0]))).toBe('app-icon-192.png');
      await observe('window-options', m, () => o);
    });

    it('起動時に obsidian vault パスを解決して ObsidianVaultService に渡し、scraper の共有サービスを差し替える', async () => {
      const m = await boot();
      expect(calls(m, 'resolveObsidianVaultPath.call')).toEqual([['/fake/vault']]);
      expect(calls(m, 'ObsidianVaultService.constructor')).toEqual([['resolved:/fake/vault', inst(m, 'geminiService')]]);
      const s = inst(m, 'scraper');
      expect(s.rssFetcher).toBe(inst(m, 'rssFetcher'));
      expect(s.geminiService).toBe(inst(m, 'geminiService'));
      expect(s.enrichmentService).toBe(inst(m, 'enrichmentService'));
      expect(s.feedManager).toBe(inst(m, 'feedManager'));
      expect(s.obsidianVaultService).toBe(inst(m, 'obsidianVaultService'));
      executed++;
    });

    it('P-267 の変更: new では 定義の無い orchestrator.setWebContents を呼ばない（フェイクに用意しても呼ばれない）', async () => {
      const m = await boot();
      expect(calls(m, 'orchestrator.setWebContents')).toEqual([]);
      executed++;
    });

    it('feedManager の保存ハンドラは settingsManager.saveFeedConfig に委譲する', async () => {
      const m = await boot();
      const handler = calls(m, 'feedManager.setSaveHandler')[0][0] as (c: unknown) => Promise<void>;
      await observe('feed-save-handler', m, () => handler({ feeds: { a: [] } }));
      expect(calls(m, 'settingsManager.saveFeedConfig')).toEqual([[{ feeds: { a: [] } }]]);
    });

    it('packaged 起動: loadFile(dist/index.html)・ログイン項目同期・updater リスナー・30 秒後チェックを設定する', async () => {
      const m = await boot({ packaged: true });
      recordStartup('startup-packaged', m);
      executed++;
      expect(calls(m, 'window[0].loadURL')).toEqual([]);
      const file = String(calls(m, 'window[0].loadFile')[0][0]).replace(/\\/g, '/');
      expect(file.endsWith('/dist/index.html')).toBe(true);
      expect(calls(m, 'window[0].webContents.openDevTools')).toEqual([]);
      expect(calls(m, 'ElectronSettingsManager.constructor')).toEqual([[{ dataDir: m.paths.dataDir, isDev: false }]]);
      expect(calls(m, 'app.setLoginItemSettings')).toEqual([[{ openAtLogin: true, path: m.paths.exe }]]);
      expect(calls(m, 'autoUpdater.on').map((a) => a[0])).toEqual(['update-available', 'update-downloaded', 'error']);
      expect(m.fakes.autoUpdater.logger).toBe(m.fakes.log);
      expect(m.fakes.log.transports.file.level).toBe('info');
      expect(m.fakes.timers.map((t) => t.delay)).toEqual([30000]);
      expect(calls(m, 'autoUpdater.checkForUpdates')).toEqual([]);
    });

    it('RULE-062: 30 秒タイマー発火で checkForUpdates を呼ぶ。"No published versions" は log.error しない', async () => {
      const m = await boot({ packaged: true, configure: (f) => f.set('autoUpdater.checkForUpdates', () => Promise.reject(new Error('No published versions on GitHub'))) });
      m.runTimers();
      await m.flush();
      expect(calls(m, 'autoUpdater.checkForUpdates')).toHaveLength(1);
      expect(calls(m, 'log.error')).toEqual([]);
      executed++;
    });

    it('RULE-062: 30 秒チェックのその他の失敗は log.error("Update check failed:", err) に残す', async () => {
      const err = new Error('network down');
      const m = await boot({ packaged: true, configure: (f) => f.set('autoUpdater.checkForUpdates', () => Promise.reject(err)) });
      m.runTimers();
      await m.flush();
      expect(calls(m, 'log.error')).toEqual([['Update check failed:', err]]);
      executed++;
    });

    it('RULE-062: updater の available / downloaded / error をレンダラーへ update-event として中継する', async () => {
      const m = await boot({ packaged: true });
      const h = (ev: string) => m.fakes.updaterHandlers.get(ev)![0];
      await observe('updater-events', m, () => {
        h('update-available')({ version: '1.2.3' });
        h('update-downloaded')({ version: '1.2.3' });
        h('error')(new Error('boom'));
        return m.rendererSends;
      });
      expect(m.rendererSends).toEqual([
        { channel: 'update-event', args: [{ type: 'available', info: { version: '1.2.3' } }] },
        { channel: 'update-event', args: [{ type: 'downloaded', info: { version: '1.2.3' } }] },
        { channel: 'update-event', args: [{ type: 'error', message: 'Error: boom' }] },
      ]);
    });

    it('RULE-062: "No published versions" の updater エラーはレンダラーへ通知せず log.info する', async () => {
      const m = await boot({ packaged: true });
      m.fakes.updaterHandlers.get('error')![0](new Error('No published versions'));
      expect(m.rendererSends).toEqual([]);
      expect(calls(m, 'log.info')).toEqual([['No GitHub releases found, skipping update check.']]);
      executed++;
    });

    it('RULE-044: ライセンス検証の失敗は起動を止めず log.warn に記録する', async () => {
      const err = new Error('net');
      const m = await boot({ configure: (f) => f.set('licenseManager.verify', () => Promise.reject(err)) });
      expect(calls(m, 'log.warn')).toEqual([['[Main] ライセンス検証に失敗しました:', err]]);
      expect(m.handledChannels()).toHaveLength(HANDLED_COUNT);
      executed++;
    });

    it('RULE-044: ready-to-show でウィンドウを表示し、興味設定を読んで初期フェッチを 1 回走らせる', async () => {
      const m = await boot();
      const before = m.fakes.calls.length;
      win(m).emit('ready-to-show');
      await m.flush();
      await observe('ready-to-show', m, () => null);
      expect(m.fakes.calls.length).toBeGreaterThan(before);
      expect(calls(m, 'window[0].show')).toHaveLength(1);
      const interests = { categories: [{ id: 'tech', name: 'Tech' }] };
      expect(calls(m, 'scraper.fetchAndProcessArticlesWithFallback')).toEqual([[interests]]);
    });

    it('RULE-044: ready-to-show の初期フェッチが失敗しても終了せず、失敗をログに残す', async () => {
      // legacy oracle は削除前の main.cjs を凍結した複製で、catch が無い。
      // 失敗を発火させるとテストプロセスの unhandledRejection になるため、new だけを確かめる。
      if (!isNew) {
        executed++;
        return;
      }
      const err = new Error('net-down');
      const assertKeptAlive = async (key: string, fetched: boolean) => {
        const m = await boot({ configure: (f) => f.set(key, () => Promise.reject(err)) });
        win(m).emit('ready-to-show');
        await m.flush();
        expect(calls(m, 'window[0].show')).toHaveLength(1);
        expect(calls(m, 'app.quit')).toEqual([]);
        expect(calls(m, 'scraper.fetchAndProcessArticlesWithFallback')).toHaveLength(fetched ? 1 : 0);
        expect(m.fakes.consoleLines.some((l) => l.includes('[Main] Initial fetch failed:') && l.includes('net-down'))).toBe(true);
        expect(fs.existsSync(m.paths.crashLog)).toBe(false);
      };
      await assertKeptAlive('settingsManager.getInterests', false);
      await assertKeptAlive('scraper.fetchAndProcessArticlesWithFallback', true);
      executed++;
    });

    it('RULE-044: window-all-closed は win32 では quit し、darwin では quit しない', async () => {
      const w = await boot({ platform: 'win32' });
      w.emitApp('window-all-closed');
      expect(calls(w, 'app.quit')).toHaveLength(1);
      const d = await boot({ platform: 'darwin' });
      d.emitApp('window-all-closed');
      expect(calls(d, 'app.quit')).toEqual([]);
      executed++;
    });

    it('RULE-044: activate はウィンドウが 1 枚でもあれば何もせず、全て閉じていれば新規作成する', async () => {
      const m = await boot();
      m.emitApp('activate');
      expect(m.fakes.windows).toHaveLength(1);
      win(m).close();
      m.emitApp('activate');
      expect(m.fakes.windows).toHaveLength(2);
      expect(calls(m, 'window[1].loadURL')).toEqual([['http://localhost:5173']]);
      // ipcMain.handle の再登録は起きない (二重登録は例外になるため)
      expect(m.handledChannels()).toHaveLength(HANDLED_COUNT);
      executed++;
    });

    /** P-267 の変更: new は before-quit で止められず終了コードも 1 になる app.exit(1)。legacy は app.quit。 */
    function expectFatalExit(m: MainUnderTest): void {
      if (isNew) {
        expect(calls(m, 'app.exit')).toEqual([[1]]);
        expect(calls(m, 'app.quit')).toEqual([]);
      } else {
        expect(calls(m, 'app.quit')).toHaveLength(1);
        expect(calls(m, 'app.exit')).toEqual([]);
      }
    }

    it('RULE-044: uncaughtException は <userData>/crash.log に追記して終了する（new は app.exit(1)）', async () => {
      const m = await boot();
      m.emitProcess('uncaughtException', new Error('boom-uncaught'));
      const text = fs.readFileSync(m.paths.crashLog, 'utf8');
      expect(text).toContain('Uncaught Exception: ');
      expect(text).toContain('boom-uncaught');
      expectFatalExit(m);
      m.emitProcess('uncaughtException', new Error('second'));
      expect(fs.readFileSync(m.paths.crashLog, 'utf8')).toContain('boom-uncaught'); // 追記であり上書きではない
      executed++;
    });

    it('RULE-044: unhandledRejection は理由を crash.log に書き app.quit する', async () => {
      const m = await boot();
      m.emitProcess('unhandledRejection', 'plain-reason');
      const text = fs.readFileSync(m.paths.crashLog, 'utf8');
      expect(text).toContain('Unhandled Rejection: ');
      expect(text).toContain('Reason: plain-reason');
      expectFatalExit(m);
      executed++;
    });

    it('RULE-044: ready 前の致命エラーは userData が使えず、ログ書き込みに失敗しても app.quit まで進む', async () => {
      const m = await boot({ autoStart: false });
      m.emitProcess('uncaughtException', new Error('early'));
      expectFatalExit(m);
      expect(fs.existsSync(m.paths.crashLog)).toBe(false);
      executed++;
    });
  });

  // ======================================================================
  describe('内部 HTTP サーバー (RULE-015)', () => {
    it('127.0.0.1:3005 で listen し、/api/v5 プレフィックスでルーターを登録する', async () => {
      const m = await boot();
      recordStartup('startup-server', m);
      executed++;
      // P-267 の変更: new の開発中ログは、リクエストのクエリのトークンを伏せるシリアライザーつき
      if (isNew) {
        expect(m.fakes.fastifyCalls).toHaveLength(1);
        const logger = (m.fakes.fastifyCalls[0] as { logger: { serializers: { req: (r: unknown) => { url: string } } } }).logger;
        expect(logger.serializers.req({ method: 'GET', url: '/api/v5/events?token=SECRET', host: 'h', ip: '127.0.0.1', socket: {} }).url)
          .toBe('/api/v5/events?token=[REDACTED]');
      } else {
        expect(m.fakes.fastifyCalls).toEqual([{ logger: true }]);
      }
      expect(calls(m, 'server.listen')).toEqual([[{ port: 3005, host: '127.0.0.1' }]]);
      const router = m.fakes.serverRegistrations.find((r) => r.plugin === m.fakes.nexusRouter)!;
      expect(router.opts.prefix).toBe('/api/v5');
      expect(router.opts.scraper).toBe(inst(m, 'scraper'));
      expect(router.opts.evolution).toBe(inst(m, 'discoveryService'));
      expect(router.opts.orchestrator).toBe(inst(m, 'orchestrator'));
      expect(router.opts.settingsManager).toBe(inst(m, 'settingsManager'));
      expect(m.fakes.serverRegistrations.map((r) => r.plugin)).toEqual([m.fakes.cors, m.fakes.nexusRouter]);
    });

    it('packaged: legacy は logger 無効で待ち受けるが、new は待ち受けない（Fastify も作らない）', async () => {
      const m = await boot({ packaged: true });
      if (isNew) {
        // P-267 の変更: レンダラーは IPC だけを使い、トークンも誰にも渡らない。ポートを開けない
        expect(m.fakes.fastifyCalls).toEqual([]);
        expect(calls(m, 'server.listen')).toEqual([]);
        // IPC とウィンドウは通常どおり
        expect(m.handledChannels()).toHaveLength(HANDLED_COUNT);
        expect(m.fakes.windows).toHaveLength(1);
      } else {
        expect(m.fakes.fastifyCalls).toEqual([{ logger: false }]);
        expect(calls(m, 'server.listen')).toEqual([[{ port: 3005, host: '127.0.0.1' }]]);
      }
      executed++;
    });

    it('CORS: http://localhost:5173 と http://127.0.0.1:5173 と origin 無しは許可する', async () => {
      const m = await boot();
      await observe('cors-decisions', m, () => ({
        localhost: m.fakes.corsDecision('http://localhost:5173'),
        loopback: m.fakes.corsDecision('http://127.0.0.1:5173'),
        none: m.fakes.corsDecision(undefined),
        evil: m.fakes.corsDecision('http://evil.example'),
      }));
      expect(m.fakes.corsDecision('http://localhost:5173')).toEqual({ allowed: true });
      expect(m.fakes.corsDecision('http://127.0.0.1:5173')).toEqual({ allowed: true });
      expect(m.fakes.corsDecision(undefined)).toEqual({ allowed: true });
    });

    it('CORS: 許可リスト外 (evil.example, 別ポート, https, file:// 由来の "null") は拒否する', async () => {
      const m = await boot();
      const denied = { allowed: false, error: 'CORS: origin not allowed' };
      expect(m.fakes.corsDecision('http://evil.example')).toEqual(denied);
      expect(m.fakes.corsDecision('http://localhost:3005')).toEqual(denied);
      expect(m.fakes.corsDecision('https://localhost:5173')).toEqual(denied);
      expect(m.fakes.corsDecision('null')).toEqual(denied);
      executed++;
    });

    it('/api/dashboard ルートは興味設定を読んで scraper.getDashboard の結果を返す', async () => {
      const m = await boot({ configure: (f) => f.set('scraper.getDashboard', { tech: { articles: [] } }) });
      const r = await observe('route-dashboard', m, () => m.fakes.callRoute('GET', '/api/dashboard'));
      expect(r.value).toEqual({ tech: { articles: [] } });
      expect(calls(m, 'scraper.getDashboard')).toEqual([[{ categories: [{ id: 'tech', name: 'Tech' }] }]]);
    });

    it('認証フック（legacy は無し / new は onRequest のトークン確認）と、main 側で直接登録するのは /api/dashboard の GET 1 本だけ', async () => {
      const m = await boot();
      // KNOWN-DEFECT: approved to change in Phase 3 -- 旧版の 127.0.0.1:3005 の内部 API には認証 (addHook) が無い
      const hooks = calls(m, 'server.addHook');
      if (isNew) {
        // 承認済みの差分 3: トークンの無いリクエストは 401
        expect(hooks.map((h) => h[0])).toEqual(['onRequest']);
        const guard = hooks[0][1] as (req: unknown, reply: unknown) => Promise<void>;
        const reply = () => {
          const r: Any = { statusCode: 200, body: undefined };
          r.code = (c: number) => { r.statusCode = c; return r; };
          r.send = async (b: unknown) => { r.body = b; return r; };
          return r;
        };
        const noToken = reply();
        await guard({ method: 'POST', url: '/api/v5/sync-settings', headers: {}, query: {} }, noToken);
        expect(noToken.statusCode).toBe(401);
        const wrong = reply();
        await guard({ method: 'GET', url: '/api/v5/interests', headers: { authorization: 'Bearer nope' }, query: {} }, wrong);
        expect(wrong.statusCode).toBe(401);
        const preflight = reply();
        await guard({ method: 'OPTIONS', url: '/api/v5/sync-settings', headers: {}, query: {} }, preflight);
        expect(preflight.statusCode).toBe(200);
      } else {
        expect(hooks).toEqual([]);
      }
      expect(calls(m, 'server.get').map((a) => a[0])).toEqual(['/api/dashboard']);
      expect(calls(m, 'server.post')).toEqual([]);
      executed++;
    });

    it('listen 失敗は握りつぶされ、IPC ハンドラとウィンドウは通常どおり作られる', async () => {
      const m = await boot({ configure: (f) => f.setThrow('server.listen', new Error('EADDRINUSE')) });
      expect(m.handledChannels()).toHaveLength(HANDLED_COUNT);
      expect(m.fakes.windows).toHaveLength(1);
      expect(m.fakes.consoleLines.some((l) => l.includes('Failed to start internal Fastify server'))).toBe(true);
      executed++;
    });
  });

  // ======================================================================
  describe('データディレクトリの復元 (RULE-072)', () => {
    const read = (m: MainUnderTest, f: string) => fs.readFileSync(path.join(m.paths.dataDir, f), 'utf8');

    it('ファイルが無ければ既定から interests.json / feed_config.json を復元する', async () => {
      const m = await boot({ seedDefaults: { 'interests.json': '{"default":"interests"}', 'feed_config.json': '{"default":"feeds"}' } });
      expect(read(m, 'interests.json')).toBe('{"default":"interests"}');
      expect(read(m, 'feed_config.json')).toBe('{"default":"feeds"}');
      await observe('datadir-missing', m, () => null);
    });

    it('4 バイト (<5) の壊れたファイルは既定で上書きする', async () => {
      const m = await boot({
        seedDefaults: { 'interests.json': '{"default":"interests"}', 'feed_config.json': '{"default":"feeds"}' },
        seedUserData: { 'interests.json': '{}  ', 'feed_config.json': '' },
      });
      expect(read(m, 'interests.json')).toBe('{"default":"interests"}');
      expect(read(m, 'feed_config.json')).toBe('{"default":"feeds"}');
      executed++;
    });

    it('ちょうど 5 バイトのファイルは境界値として残す (上書きしない)', async () => {
      const m = await boot({
        seedDefaults: { 'interests.json': '{"default":"interests"}', 'feed_config.json': '{"default":"feeds"}' },
        seedUserData: { 'interests.json': 'abcde', 'feed_config.json': '{"user":"custom-feed-config"}' },
      });
      expect(read(m, 'interests.json')).toBe('abcde');
      expect(read(m, 'feed_config.json')).toBe('{"user":"custom-feed-config"}');
      executed++;
    });

    it('既定側にファイルが無ければコピーしない / 要求された 2 ファイル以外はコピーしない', async () => {
      const m = await boot({ seedDefaults: { 'interests.json': '{"default":"interests"}', 'other.json': '{"x":1}' } });
      expect(fs.existsSync(path.join(m.paths.dataDir, 'feed_config.json'))).toBe(false);
      expect(fs.existsSync(path.join(m.paths.dataDir, 'other.json'))).toBe(false);
      expect(read(m, 'interests.json')).toBe('{"default":"interests"}');
      executed++;
    });

    it('既定ディレクトリ自体が無くても data ディレクトリは作られ、起動は続く', async () => {
      const m = await boot();
      expect(fs.statSync(m.paths.dataDir).isDirectory()).toBe(true);
      expect(m.handledChannels()).toHaveLength(HANDLED_COUNT);
      executed++;
    });

    it('packaged では resources/default-data から復元する', async () => {
      const m = await boot({ packaged: true, seedDefaults: { 'interests.json': '{"packaged":"yes"}' } });
      expect(read(m, 'interests.json')).toBe('{"packaged":"yes"}');
      executed++;
    });
  });

  // ======================================================================
  describe('IPC invoke ハンドラ', () => {
    it('RULE-001: get-articles は全グループを平坦化し score 降順で 500 件に切る (700 件入力)', async () => {
      const a = Array.from({ length: 400 }, (_, i) => ({ id: `a${i}`, score: i }));
      const b = Array.from({ length: 300 }, (_, i) => ({ id: `b${i}`, score: 400 + i }));
      const m = await boot({
        configure: (f) => f.set('scraper.getDashboard', { groupA: { articles: a }, empty: {}, nothing: null, groupB: { articles: b } }),
      });
      const r = await observe('get-articles-700', m, () => m.invoke('get-articles'));
      const out = r.value as Array<{ id: string; score: number }>;
      expect(out).toHaveLength(500);
      expect(out[0]).toEqual({ id: 'b299', score: 699 });
      expect(out[499]).toEqual({ id: 'a200', score: 200 });
      expect(out.map((x) => x.score)).toEqual([...out.map((x) => x.score)].sort((x, y) => y - x));
      expect(calls(m, 'scraper.getDashboard')).toEqual([[{ categories: [{ id: 'tech', name: 'Tech' }] }]]);
    });

    it('RULE-001: get-articles は 500 件未満ならそのまま返し、ダッシュボードが空なら []', async () => {
      const m = await boot({ configure: (f) => f.set('scraper.getDashboard', { g: { articles: [{ id: 'x', score: 1 }, { id: 'y', score: 3 }, { id: 'z', score: 2 }] } }) });
      const r = await observe('get-articles-small', m, () => m.invoke('get-articles', { ignored: true }));
      expect((r.value as Array<{ id: string }>).map((x) => x.id)).toEqual(['y', 'z', 'x']);
      const e = await boot();
      expect(await e.invoke('get-articles')).toEqual([]);
    });

    it('RULE-001: 同点の記事は入力順を保つ (安定ソート)', async () => {
      const m = await boot({ configure: (f) => f.set('scraper.getDashboard', { g: { articles: [{ id: 'p', score: 5 }, { id: 'q', score: 5 }, { id: 'r', score: 5 }] } }) });
      const r = await observe('get-articles-ties', m, () => m.invoke('get-articles'));
      expect((r.value as Array<{ id: string }>).map((x) => x.id)).toEqual(['p', 'q', 'r']);
    });

    it('get-articles: getDashboard の失敗はそのまま reject になる', async () => {
      const m = await boot({ configure: (f) => f.setThrow('scraper.getDashboard', new Error('dash-fail')) });
      const r = await observe('get-articles-error', m, () => m.invoke('get-articles'));
      expect(r.rejected).toBe('dash-fail');
    });

    it('get-settings は {interests, feedConfig} を返す', async () => {
      const m = await boot();
      const r = await observe('get-settings', m, () => m.invoke('get-settings'));
      expect(r.value).toEqual({
        interests: { categories: [{ id: 'tech', name: 'Tech' }] },
        feedConfig: { feeds: { tech: ['https://example.com/rss'] } },
      });
    });

    it('RULE-068: sync-settings は rssFetcher を添えて syncSettings を呼び、feedManager.config を検証済み設定へ更新する', async () => {
      const m = await boot();
      const settings = { interests: { categories: [] }, feedConfig: { feeds: {} } };
      const r = await observe('sync-settings', m, () => m.invoke('sync-settings', settings));
      expect(r.value).toEqual({ lastUpdated: 1700000000000, validatedFeedConfig: { feeds: { tech: [] } } });
      expect(calls(m, 'settingsManager.syncSettings')).toEqual([[settings, inst(m, 'rssFetcher')]]);
      expect(inst(m, 'feedManager').config).toEqual({ feeds: { tech: [] } });
    });

    it('RULE-068: sync-settings が失敗したら reject し feedManager.config は更新されない', async () => {
      const m = await boot({ configure: (f) => f.setThrow('settingsManager.syncSettings', new Error('invalid settings')) });
      const r = await observe('sync-settings-error', m, () => m.invoke('sync-settings', { bad: true }));
      expect(r.rejected).toBe('invalid settings');
      expect(inst(m, 'feedManager').config).toBeUndefined();
    });

    it('RULE-049: trigger-orchestration は要件を渡して即 {success:true,newFeedsCount:0} を返す', async () => {
      const m = await boot();
      const r = await observe('trigger-orchestration', m, () => m.invoke('trigger-orchestration', 'AI news'));
      expect(r.value).toEqual({ success: true, newFeedsCount: 0 });
      expect(calls(m, 'orchestrator.runAutonomousLoop')).toEqual([['AI news']]);
    });

    it('RULE-049: trigger-orchestration は要件未指定なら空文字を渡す', async () => {
      const m = await boot();
      const r = await observe('trigger-orchestration-empty', m, () => m.invoke('trigger-orchestration'));
      expect(r.value).toEqual({ success: true, newFeedsCount: 0 });
      expect(calls(m, 'orchestrator.runAutonomousLoop')).toEqual([['']]);
    });

    it('RULE-049: runAutonomousLoop が同期 throw したら {success:false,error:String(err)} を返す', async () => {
      const m = await boot({ configure: (f) => f.setThrow('orchestrator.runAutonomousLoop', new Error('loop-boom')) });
      const r = await observe('trigger-orchestration-error', m, () => m.invoke('trigger-orchestration', 'x'));
      expect(r.value).toEqual({ success: false, error: 'Error: loop-boom' });
    });

    it('suggest-category はカテゴリ名を gemini に渡し結果をそのまま返す', async () => {
      const m = await boot();
      const r = await observe('suggest-category', m, () => m.invoke('suggest-category', 'Cloud'));
      expect(r.value).toEqual({ brands: ['BrandA'], keywords: ['kw1'] });
      expect(calls(m, 'geminiService.suggestCategoryDetails')).toEqual([['Cloud']]);
    });

    it('suggest-category の失敗は reject として伝わる', async () => {
      const m = await boot({ configure: (f) => f.setThrow('geminiService.suggestCategoryDetails', new Error('quota')) });
      const r = await observe('suggest-category-error', m, () => m.invoke('suggest-category', 'Cloud'));
      expect(r.rejected).toBe('quota');
    });

    it('discover-trends は {suggestions} に包んで返す', async () => {
      const m = await boot();
      const r = await observe('discover-trends', m, () => m.invoke('discover-trends'));
      expect(r.value).toEqual({ suggestions: [{ keyword: 'trend-1' }] });
      expect(calls(m, 'scraper.discoverTrends')).toEqual([[{ categories: [{ id: 'tech', name: 'Tech' }] }]]);
    });

    it('restructure-categories は件数と言語を渡す', async () => {
      const m = await boot();
      const r = await observe('restructure-categories', m, () => m.invoke('restructure-categories', 5, 'en'));
      expect(r.value).toEqual({ proposals: [{ from: 'a', to: 'b' }] });
      expect(calls(m, 'discoveryService.getRestructureProposal')).toEqual([[{ categories: [{ id: 'tech', name: 'Tech' }] }, 5, 'en']]);
    });

    it('restructure-categories は言語が未指定・空文字なら "ja" にフォールバックする', async () => {
      const m = await boot();
      await observe('restructure-categories-default-lang', m, () => m.invoke('restructure-categories', 3));
      await m.invoke('restructure-categories', 4, '');
      expect(calls(m, 'discoveryService.getRestructureProposal').map((a) => [a[1], a[2]])).toEqual([[3, 'ja'], [4, 'ja']]);
    });

    it('translate-interests は設定をそのまま discoveryService に渡す', async () => {
      const m = await boot();
      const settings = { categories: [{ id: 'tech', name: 'Tech' }], language: 'ja' };
      const r = await observe('translate-interests', m, () => m.invoke('translate-interests', settings));
      expect(r.value).toEqual({ categories: [{ id: 'tech', name: 'テクノロジー' }] });
      expect(calls(m, 'discoveryService.translateInterests')).toEqual([[settings]]);
    });

    it('reacquire-all-feeds は {success:true, feedConfig} を返す', async () => {
      const m = await boot();
      const r = await observe('reacquire-all-feeds', m, () => m.invoke('reacquire-all-feeds'));
      expect(r.value).toEqual({ success: true, feedConfig: { feeds: { tech: ['https://example.com/new.xml'] } } });
      expect(calls(m, 'discoveryService.reacquireAllFeeds')).toEqual([[{ categories: [{ id: 'tech', name: 'Tech' }] }]]);
    });

    it('RULE-069/070: get-api-key は settingsManager の値をそのまま返す', async () => {
      const m = await boot();
      const r = await observe('get-api-key', m, () => m.invoke('get-api-key'));
      expect(r.value).toBe('test-key');
    });

    it('RULE-069: save-api-key は保存してから gemini に反映し {success:true} を返す', async () => {
      const m = await boot();
      const r = await observe('save-api-key', m, () => m.invoke('save-api-key', 'test-key-2'));
      expect(r.value).toEqual({ success: true });
      expect(calls(m, 'settingsManager.saveApiKey')).toEqual([['test-key-2']]);
      expect(calls(m, 'geminiService.updateApiKey')).toEqual([['test-key-2']]);
      expect(idx(m, 'settingsManager', 'saveApiKey')).toBeLessThan(idx(m, 'geminiService', 'updateApiKey'));
    });

    it('RULE-069: save-api-key の保存が失敗したら gemini は更新されず reject する', async () => {
      const m = await boot({ configure: (f) => f.setThrow('settingsManager.saveApiKey', new Error('disk full')) });
      const r = await observe('save-api-key-error', m, () => m.invoke('save-api-key', 'test-key-2'));
      expect(r.rejected).toBe('disk full');
      expect(calls(m, 'geminiService.updateApiKey')).toEqual([]);
    });

    it('RULE-070: get-credentials は復号済み認証情報をそのまま返す', async () => {
      const m = await boot();
      const r = await observe('get-credentials', m, () => m.invoke('get-credentials'));
      expect(r.value).toEqual({ google: { apiKey: 'test-key' } });
    });

    it('RULE-069: save-credentials は保存してから gemini.updateCredentials に反映する', async () => {
      const m = await boot();
      const creds = { google: { apiKey: 'test-key-3' }, openai: { apiKey: 'test-key-4' } };
      const r = await observe('save-credentials', m, () => m.invoke('save-credentials', creds));
      expect(r.value).toEqual({ success: true });
      expect(calls(m, 'settingsManager.saveCredentials')).toEqual([[creds]]);
      expect(calls(m, 'geminiService.updateCredentials')).toEqual([[creds]]);
      expect(idx(m, 'settingsManager', 'saveCredentials')).toBeLessThan(idx(m, 'geminiService', 'updateCredentials'));
    });

    it('RULE-069: save-credentials の保存失敗では gemini は更新されない', async () => {
      const m = await boot({ configure: (f) => f.setThrow('settingsManager.saveCredentials', new Error('encrypt fail')) });
      const r = await observe('save-credentials-error', m, () => m.invoke('save-credentials', { google: { apiKey: 'test-key' } }));
      expect(r.rejected).toBe('encrypt fail');
      expect(calls(m, 'geminiService.updateCredentials')).toEqual([]);
    });

    it('get-ui-settings は UI 設定を返す', async () => {
      const m = await boot();
      const r = await observe('get-ui-settings', m, () => m.invoke('get-ui-settings'));
      expect(r.value).toEqual({ theme: 'dark', autoLaunch: true, obsidianVaultPath: '/fake/vault' });
    });

    it('RULE-119: save-ui-settings (dev) は保存のみで OS のログイン項目は触らない', async () => {
      const m = await boot();
      const settings = { theme: 'light', autoLaunch: true };
      const r = await observe('save-ui-settings-dev', m, () => m.invoke('save-ui-settings', settings));
      expect(r.value).toEqual({ success: true });
      expect(calls(m, 'settingsManager.saveUiSettings')).toEqual([[settings]]);
      expect(calls(m, 'app.setLoginItemSettings')).toEqual([]);
    });

    it('RULE-119: save-ui-settings (packaged) は autoLaunch を setLoginItemSettings に反映する', async () => {
      const m = await boot({ packaged: true });
      const base = calls(m, 'app.setLoginItemSettings').length;
      const r = await observe('save-ui-settings-packaged', m, () => m.invoke('save-ui-settings', { autoLaunch: false }));
      expect(r.value).toEqual({ success: true });
      expect(calls(m, 'app.setLoginItemSettings').slice(base)).toEqual([[{ openAtLogin: false, path: m.paths.exe }]]);
    });

    it('RULE-119: save-ui-settings (packaged) で autoLaunch が未指定なら openAtLogin は undefined のまま渡る', async () => {
      const m = await boot({ packaged: true });
      const base = calls(m, 'app.setLoginItemSettings').length;
      await observe('save-ui-settings-packaged-undefined', m, () => m.invoke('save-ui-settings', { theme: 'dark' }));
      expect(calls(m, 'app.setLoginItemSettings').slice(base)).toEqual([[{ openAtLogin: undefined, path: m.paths.exe }]]);
    });

    it('save-ui-settings は obsidian vault パスを保存するだけで、稼働中の ObsidianVaultService は再構築しない', async () => {
      const m = await boot();
      const resolveBefore = calls(m, 'resolveObsidianVaultPath.call').length;
      const ctorBefore = calls(m, 'ObsidianVaultService.constructor').length;
      const settings = { obsidianVaultPath: '/new/vault' };
      await observe('save-ui-settings-vault', m, () => m.invoke('save-ui-settings', settings));
      expect(calls(m, 'settingsManager.saveUiSettings')).toEqual([[settings]]);
      // KNOWN-DEFECT: approved to change in Phase 3 -- 保存しても vault パスは次回起動まで反映されない
      expect(calls(m, 'resolveObsidianVaultPath.call')).toHaveLength(resolveBefore);
      expect(calls(m, 'ObsidianVaultService.constructor')).toHaveLength(ctorBefore);
    });

    it('get-usage-stats は使用統計を返す', async () => {
      const m = await boot();
      const r = await observe('get-usage-stats', m, () => m.invoke('get-usage-stats'));
      expect(r.value).toEqual({ totalTokens: 42 });
    });

    it('usage-update: UsageManager の更新通知をメインウィンドウへ送る', async () => {
      const m = await boot();
      const stats = { totalTokens: 7 };
      await observe('usage-update', m, () => { inst(m, 'settingsManager').usageManager.onUpdate(stats); return null; });
      expect(m.rendererSends).toEqual([{ channel: 'usage-update', args: [stats] }]);
    });

    it('usage-update: ウィンドウが破棄済みなら送らない', async () => {
      const m = await boot();
      win(m).destroyed = true;
      await observe('usage-update-destroyed', m, () => { inst(m, 'settingsManager').usageManager.onUpdate({ totalTokens: 7 }); return null; });
      expect(m.rendererSends).toEqual([]);
    });

    it('reset-to-defaults は言語を渡し {success} に包む (未指定は "ja")', async () => {
      const m = await boot();
      const r = await observe('reset-to-defaults', m, () => m.invoke('reset-to-defaults', 'en'));
      expect(r.value).toEqual({ success: true });
      const r2 = await observe('reset-to-defaults-default-lang', m, () => m.invoke('reset-to-defaults'));
      expect(r2.value).toEqual({ success: true });
      expect(calls(m, 'settingsManager.resetToDefaults')).toEqual([['en'], ['ja']]);
    });

    it('reset-to-defaults は失敗の真偽値をそのまま {success:false} にして返す', async () => {
      const m = await boot({ configure: (f) => f.set('settingsManager.resetToDefaults', false) });
      const r = await observe('reset-to-defaults-false', m, () => m.invoke('reset-to-defaults', 'en'));
      expect(r.value).toEqual({ success: false });
    });

    it('get-proposals（legacy は常に {proposals:[]} を返すスタブ / new では削除）', async () => {
      const m = await boot();
      const r = await observe('get-proposals', m, () => m.invoke('get-proposals'));
      if (isNew) {
        // 承認済みの差分 4: 画面から使われていなかったスタブを削除した
        expect(r.rejected).toBe("No handler registered for 'get-proposals'");
      } else {
        expect(r.value).toEqual({ proposals: [] });
      }
      expect(m.fakes.calls.slice(m.startupCallCount)).toEqual([]);
    });

    it('RULE-071: get-license-state は licenseManager.state をそのまま返す', async () => {
      const m = await boot();
      inst(m, 'licenseManager').state = { tier: 'pro', email: 'user@example.com' };
      const r = await observe('get-license-state', m, () => m.invoke('get-license-state'));
      expect(r.value).toEqual({ tier: 'pro', email: 'user@example.com' });
    });

    it('RULE-043/071: activate-license 成功時は license-changed に最新 state を送る', async () => {
      const m = await boot({
        configure: (f) => f.set('licenseManager.activate', () => {
          f.instances.licenseManager.state = { tier: 'pro' };
          return { success: true };
        }),
      });
      const r = await observe('activate-license', m, () => m.invoke('activate-license', 'TEST-LICENSE-KEY', 'user@example.com'));
      expect(r.value).toEqual({ success: true });
      expect(calls(m, 'licenseManager.activate')).toEqual([['TEST-LICENSE-KEY', 'user@example.com']]);
      expect(m.rendererSends).toEqual([{ channel: 'license-changed', args: [{ tier: 'pro' }] }]);
    });

    it('RULE-043/071: activate-license 失敗時は結果を返すだけで license-changed は送らない', async () => {
      const m = await boot({ configure: (f) => f.set('licenseManager.activate', { success: false, error: 'invalid key' }) });
      const r = await observe('activate-license-failure', m, () => m.invoke('activate-license', 'BAD', 'user@example.com'));
      expect(r.value).toEqual({ success: false, error: 'invalid key' });
      expect(m.rendererSends).toEqual([]);
    });

    it('RULE-043: deactivate-license は無効化して license-changed を送り {success:true} を返す', async () => {
      const m = await boot();
      const r = await observe('deactivate-license', m, () => m.invoke('deactivate-license'));
      expect(r.value).toEqual({ success: true });
      expect(calls(m, 'licenseManager.deactivate')).toHaveLength(1);
      expect(m.rendererSends).toEqual([{ channel: 'license-changed', args: [{ tier: 'free' }] }]);
    });

    it('RULE-071: get-feature-gates は licenseManager.getFeatureGates の結果を返す', async () => {
      const m = await boot();
      const r = await observe('get-feature-gates', m, () => m.invoke('get-feature-gates'));
      expect(r.value).toEqual({ aiSummary: true, maxFeeds: 10 });
    });

    it('RULE-062: check-for-updates (dev) は {status:"dev"} でチェックしない', async () => {
      const m = await boot();
      const r = await observe('check-for-updates-dev', m, () => m.invoke('check-for-updates'));
      expect(r.value).toEqual({ status: 'dev' });
      expect(calls(m, 'autoUpdater.checkForUpdates')).toEqual([]);
    });

    it('RULE-062: check-for-updates (packaged) は checkForUpdates を呼び {status:"checking"} を返す', async () => {
      const m = await boot({ packaged: true });
      const r = await observe('check-for-updates-packaged', m, () => m.invoke('check-for-updates'));
      expect(r.value).toEqual({ status: 'checking' });
      expect(calls(m, 'autoUpdater.checkForUpdates')).toHaveLength(1);
    });

    it('RULE-062: install-update は dev でも quitAndInstall を呼び undefined を返す', async () => {
      const m = await boot();
      const r = await observe('install-update', m, () => m.invoke('install-update'));
      expect(r.value).toBeUndefined();
      expect(calls(m, 'autoUpdater.quitAndInstall')).toHaveLength(1);
    });

    it('未登録チャンネルの invoke は reject する', async () => {
      const m = await boot();
      await expect(m.invoke('no-such-channel')).rejects.toThrow();
      executed++;
    });
  });

  // ======================================================================
  describe('IPC send ハンドラ', () => {
    it('window-control: minimize / close', async () => {
      const m = await boot();
      await observe('window-control-minimize', m, () => m.send('window-control', 'minimize'));
      expect(calls(m, 'window[0].minimize')).toHaveLength(1);
      await observe('window-control-close', m, () => m.send('window-control', 'close'));
      expect(calls(m, 'window[0].close')).toHaveLength(1);
    });

    it('window-control: maximize は最大化していなければ maximize、していれば unmaximize', async () => {
      const m = await boot();
      await observe('window-control-maximize', m, () => m.send('window-control', 'maximize'));
      expect(calls(m, 'window[0].maximize')).toHaveLength(1);
      expect(calls(m, 'window[0].unmaximize')).toHaveLength(0);
      await observe('window-control-unmaximize', m, () => m.send('window-control', 'maximize'));
      expect(calls(m, 'window[0].unmaximize')).toHaveLength(1);
    });

    it('window-control: quit は app.quit、未知のアクションは何もしない', async () => {
      const m = await boot();
      await observe('window-control-quit', m, () => m.send('window-control', 'quit'));
      expect(calls(m, 'app.quit')).toHaveLength(1);
      const before = m.fakes.calls.length;
      await observe('window-control-unknown', m, () => m.send('window-control', 'explode'));
      expect(m.fakes.calls.length).toBe(before);
    });

    it.each([
      ['https', 'https://example.com/a?b=1', true],
      ['http', 'http://example.com/', true],
      ['javascript', 'javascript:alert(1)', false],
      ['file', 'file:///C:/Windows/system32/calc.exe', false],
      ['ftp', 'ftp://example.com/x', false],
      ['uppercase-scheme', 'HTTPS://example.com/', false],
      ['no-scheme', 'example.com', false],
    ])('RULE-016: open-external %s -> shell.openExternal は %s の場合のみ', async (label, url, opened) => {
      const m = await boot();
      await observe(`open-external-${label}`, m, () => m.send('open-external', url));
      expect(calls(m, 'shell.openExternal')).toEqual(opened ? [[url]] : []);
    });

    it('RULE-016: open-external は文字列以外 (数値・null・オブジェクト) を無視する', async () => {
      const m = await boot();
      await observe('open-external-non-string', m, () => { m.send('open-external', 123); m.send('open-external', null); m.send('open-external', { startsWith: () => true }); });
      expect(calls(m, 'shell.openExternal')).toEqual([]);
    });

    it.each([
      ['https', 'https://example.com/post', true],
      ['http', 'http://example.com/post', true],
      ['javascript', 'javascript:alert(1)', false],
      ['file', 'file:///etc/passwd', false],
    ])('RULE-016: open-article %s -> 新規ウィンドウを作るのは %s の場合のみ', async (label, url, opened) => {
      const m = await boot();
      await observe(`open-article-${label}`, m, () => m.send('open-article', url));
      expect(m.fakes.windows).toHaveLength(opened ? 2 : 1);
      if (opened) {
        expect(calls(m, 'window[1].loadURL')).toEqual([[url]]);
        expect(win(m, 1).options).toEqual({
          width: 1200, height: 800, autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        expect(calls(m, 'window[1].setMenu')).toEqual([[null]]);
      } else {
        expect(calls(m, 'window[1].loadURL')).toEqual([]);
      }
      expect(calls(m, 'shell.openExternal')).toEqual([]);
    });

    it('open-article: Ctrl+Q (大文字 Q も) で記事ウィンドウを閉じ既定動作を止める。他のキーは無視する', async () => {
      const m = await boot();
      m.send('open-article', 'https://example.com/post');
      const handler = win(m, 1).webContents.handlers.get('before-input-event')[0] as Any;
      const mk = () => ({ preventDefault: () => { prevented++; } });
      let prevented = 0;
      await observe('open-article-ctrl-q', m, () => {
        handler(mk(), { control: true, key: 'Q' });
        handler(mk(), { control: true, key: 'w' });
        handler(mk(), { control: false, key: 'q' });
        return prevented;
      });
      expect(prevented).toBe(1);
      expect(calls(m, 'window[1].close')).toHaveLength(1);
    });

    it('open-article: 文字列以外は無視する', async () => {
      const m = await boot();
      m.send('open-article', undefined);
      m.send('open-article', 42);
      expect(m.fakes.windows).toHaveLength(1);
      executed++;
    });
  });

  // ======================================================================
  describe('ナビゲーション制限 (RULE-016)', () => {
    const navigate = async (m: MainUnderTest, url: string) => {
      let prevented = false;
      const before = calls(m, 'shell.openExternal').length;
      win(m).webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url);
      return { prevented, opened: calls(m, 'shell.openExternal').slice(before).map((a) => a[0]) };
    };

    it('dev: アプリ URL (localhost:5173) への遷移は許可し、外部 https は止めてブラウザへ、file/javascript は止めるだけ', async () => {
      const m = await boot();
      const out = await observe('will-navigate-dev', m, async () => ({
        app: await navigate(m, 'http://localhost:5173/#/settings'),
        https: await navigate(m, 'https://example.com/'),
        http: await navigate(m, 'http://example.com/'),
        file: await navigate(m, 'file:///C:/x.html'),
        js: await navigate(m, 'javascript:alert(1)'),
      }));
      expect(out.value).toEqual({
        app: { prevented: false, opened: [] },
        https: { prevented: true, opened: ['https://example.com/'] },
        http: { prevented: true, opened: ['http://example.com/'] },
        file: { prevented: true, opened: [] },
        js: { prevented: true, opened: [] },
      });
    });

    it('packaged: file:// への遷移は許可し、localhost:5173 を含め http(s) は止めてブラウザへ送る', async () => {
      const m = await boot({ packaged: true });
      expect(await navigate(m, 'file:///C:/app/dist/index.html')).toEqual({ prevented: false, opened: [] });
      expect(await navigate(m, 'http://localhost:5173/')).toEqual({ prevented: true, opened: ['http://localhost:5173/'] });
      expect(await navigate(m, 'https://example.com/')).toEqual({ prevented: true, opened: ['https://example.com/'] });
      executed++;
    });

    it.each([
      ['https', 'https://example.com/', true],
      ['http', 'http://example.com/', true],
      ['javascript', 'javascript:alert(1)', false],
      ['file', 'file:///C:/x', false],
    ])('window.open / target=_blank (%s) は常に deny し、システムブラウザへ送るのは %s の場合のみ', async (label, url, opened) => {
      const m = await boot();
      const out = await observe(`window-open-${label}`, m, () => win(m).webContents.windowOpenHandler({ url }));
      expect(out.value).toEqual({ action: 'deny' });
      expect(calls(m, 'shell.openExternal')).toEqual(opened ? [[url]] : []);
    });
  });

  it('equivalence cases executed (参考出力)', () => {
    // 0 件なら何も証明されていない
    expect(executed).toBeGreaterThan(0);
    console.log(`equivalence cases executed: ${executed}`);
  });
});
