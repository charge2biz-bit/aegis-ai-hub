/**
 * electron/main の部品の単体テスト（P-267 レビュー指摘）。electron はフェイクに差し替える。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { exit: vi.fn(), quit: vi.fn() } }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const appendFileSync = vi.fn();
  return { ...actual, default: { ...actual, appendFileSync }, appendFileSync };
});

import { app } from 'electron';
import { getMainWindow, sendToRenderer, setMainWindow } from '../../../electron/main/mainWindowState';
import { DEV_LOGGER_OPTIONS, MIN_API_TOKEN_LENGTH, redactTokenInUrl, resolveApiToken, startInternalServer } from '../../../electron/main/internalServer';
import { installCrashHandlers } from '../../../electron/main/crashLog';

function fakeWindow(destroyed = false) {
  const send = vi.fn();
  const window = { isDestroyed: () => destroyed, webContents: { send } };
  return { window: window as never, send };
}

describe('mainWindowState（破棄済みのウィンドウ）', () => {
  it('生きているウィンドウは返し、送信できる', () => {
    const { window, send } = fakeWindow(false);
    setMainWindow(window);
    expect(getMainWindow()).toBe(window);
    sendToRenderer('license-changed', { tier: 'pro' });
    expect(send).toHaveBeenCalledWith('license-changed', { tier: 'pro' });
  });

  it('破棄済みのウィンドウは getMainWindow が返さず、送信しても例外にならない', () => {
    const { window, send } = fakeWindow(true);
    setMainWindow(window);
    expect(getMainWindow()).toBeUndefined();
    expect(() => sendToRenderer('license-changed', {})).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('resolveApiToken（トークンの強度）', () => {
  const original = process.env.NEXUS_API_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXUS_API_TOKEN;
    else process.env.NEXUS_API_TOKEN = original;
    vi.restoreAllMocks();
  });

  it('開発中の 32 文字以上の NEXUS_API_TOKEN はそのまま使う', () => {
    const token = 'a'.repeat(MIN_API_TOKEN_LENGTH);
    process.env.NEXUS_API_TOKEN = token;
    expect(resolveApiToken(true)).toBe(token);
  });

  it('32 文字未満は警告して捨て、ランダムな 64 文字の値にする（値そのものは警告に出さない）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NEXUS_API_TOKEN = 'short-token';
    const token = resolveApiToken(true);
    expect(token).not.toBe('short-token');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('short-token');
  });

  it('パッケージ版は環境変数を無視してランダムに作る', () => {
    process.env.NEXUS_API_TOKEN = 'a'.repeat(40);
    expect(resolveApiToken(false)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ログからのトークン除去', () => {
  it('?token= と &token= の値を伏せ、他のクエリは残す', () => {
    expect(redactTokenInUrl('/api/v5/events?token=abc123')).toBe('/api/v5/events?token=[REDACTED]');
    expect(redactTokenInUrl('/x?a=1&token=abc&b=2')).toBe('/x?a=1&token=[REDACTED]&b=2');
    expect(redactTokenInUrl('/api/v5/interests')).toBe('/api/v5/interests');
  });

  it('Fastify の req シリアライザーが URL のトークンを伏せる', () => {
    const logged = DEV_LOGGER_OPTIONS.serializers.req({
      method: 'GET', url: '/api/v5/events?token=SECRET', host: 'localhost:3005', ip: '127.0.0.1', socket: { remotePort: 5555 },
    } as never);
    expect(JSON.stringify(logged)).not.toContain('SECRET');
    expect(logged.url).toBe('/api/v5/events?token=[REDACTED]');
  });
});

describe('startInternalServer', () => {
  it('パッケージ版は何も待ち受けず、サービスにも触れない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const services = new Proxy({}, { get: () => { throw new Error('サービスに触れてはいけない'); } });
    await expect(startInternalServer(services as never, false, 'x'.repeat(64))).resolves.toBeUndefined();
  });
});

describe('installCrashHandlers', () => {
  const handlers = new Map<string, (arg: unknown) => void>();
  beforeEach(() => {
    handlers.clear();
    vi.spyOn(process, 'on').mockImplementation(((event: string, fn: (arg: unknown) => void) => {
      handlers.set(event, fn);
      return process;
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(app.exit).mockClear();
    vi.mocked(app.quit).mockClear();
  });

  it('uncaughtException / unhandledRejection は app.exit(1) で終了し、app.quit は使わない', () => {
    installCrashHandlers();
    handlers.get('uncaughtException')!(new Error('boom'));
    handlers.get('unhandledRejection')!('why');
    expect(vi.mocked(app.exit).mock.calls).toEqual([[1], [1]]);
    expect(app.quit).not.toHaveBeenCalled();
  });
});
