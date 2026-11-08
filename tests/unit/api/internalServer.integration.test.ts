/**
 * 内部 HTTP API を、本物の Fastify と @fastify/cors で組み立てて確かめる統合テスト（Phase 3 のレビュー指摘への対応）。
 * 契約テストはフェイクの Fastify を使うので、ここでは本番と同じ buildInternalServer（CORS → トークン確認 → ルーター）を通す。
 * 待ち受け（listen）はせず、inject で呼ぶ。サービスは呼び出しを記録するだけの偽物。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildInternalServer } from '../../../electron/main/internalServer';
import type { Services } from '../../../electron/main/services';

const TOKEN = 'integration-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const ALLOWED = 'http://localhost:5173';

function fakeServices() {
  return {
    settingsManager: {
      getInterests: vi.fn(async () => ({ categories: { tech: {} } })),
      getFeedConfig: vi.fn(async () => ({})),
      resetToDefaults: vi.fn(async () => true),
      getUiSettings: vi.fn(async () => ({})),
      getUsageStats: vi.fn(async () => ({})),
    },
    scraper: { getDashboard: vi.fn(async () => ({ tech: { articles: [] } })) },
    discoveryService: { translateInterests: vi.fn(async () => ({})) },
    geminiService: { suggestCategoryDetails: vi.fn(async () => ({ brands: [], keywords: [], emoji: 'x', reason: '' })) },
    orchestrator: {
      subscribe: vi.fn((reply: { raw: { write: (s: string) => void; end: () => void } }) => {
        reply.raw.write('data: {"status":"idle"}\n\n');
        reply.raw.end();
      }),
    },
  } as unknown as Services;
}

let server: FastifyInstance | undefined;
async function build(services = fakeServices()) {
  server = await buildInternalServer(services, false, TOKEN);
  await server.ready();
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('内部 HTTP API（本物の Fastify + CORS）', () => {
  it('トークン無しは /api/v5 も /api/dashboard も 401、正しいトークンなら 200', async () => {
    const s = await build();
    expect((await s.inject({ method: 'GET', url: '/api/v5/interests' })).statusCode).toBe(401);
    expect((await s.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(401);
    expect((await s.inject({ method: 'GET', url: '/api/v5/interests', headers: auth })).statusCode).toBe(200);
    expect((await s.inject({ method: 'GET', url: '/api/dashboard', headers: auth })).json()).toEqual({ tech: { articles: [] } });
  });

  it('許可したオリジンからの CORS の事前確認（OPTIONS）は、トークン無しでも通る', async () => {
    const s = await build();
    const res = await s.inject({
      method: 'OPTIONS',
      url: '/api/v5/sync-settings',
      headers: { origin: ALLOWED, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('401 の応答にも CORS のヘッダーが付く（ブラウザが理由を読める）', async () => {
    const s = await build();
    const res = await s.inject({ method: 'GET', url: '/api/v5/interests', headers: { origin: ALLOWED } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
  });

  it('許可していないオリジンは、トークンがあっても CORS で断る', async () => {
    const s = await build();
    const res = await s.inject({ method: 'GET', url: '/api/v5/interests', headers: { ...auth, origin: 'http://evil.example' } });
    expect(res.statusCode).toBe(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('/events は ?token= で SSE を返し、CORS のヘッダーも引き継ぐ', async () => {
    const services = fakeServices();
    const s = await build(services);
    const res = await s.inject({ method: 'GET', url: `/api/v5/events?token=${TOKEN}`, headers: { origin: ALLOWED } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    // 最初のコメント行（接続成立の合図）のあとに、通常のイベントが続く
    expect(res.body).toBe(': connected\n\ndata: {"status":"idle"}\n\n');
    expect((services.orchestrator as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe).toHaveBeenCalledTimes(1);
  });
});
