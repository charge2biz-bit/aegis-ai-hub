/**
 * Phase 3 で承認された差分のうち、内部 HTTP API の分を本物の Fastify で確かめる。
 * - 差分 3: トークンの無いリクエストは 401（electron/main/internalServer.ts の createTokenGuard）
 * - 差分 5: nexusApi が呼んでいたのに無かった 4 ルート（/suggest-category・/translate-interests・/reset-to-defaults・/events）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { nexusRouter } from '../../../src/api/server/NexusRouter';
import { createTokenGuard } from '../../../electron/main/internalServer';

const TOKEN = 'test-token-0123456789';

function makeServices() {
  return {
    settingsManager: {
      getInterests: vi.fn(async () => ({ categories: {} })),
      resetToDefaults: vi.fn(async () => true),
    },
    evolution: { translateInterests: vi.fn(async (body: unknown) => ({ translated: body })) },
    gemini: { suggestCategoryDetails: vi.fn(async (name: string) => ({ brands: [name], keywords: [], emoji: '🧪', reason: 'r' })) },
    orchestrator: {
      subscribe: vi.fn((reply: { raw: { write: (s: string) => void; end: () => void } }) => {
        reply.raw.write('data: {"status":"idle"}\n\n');
        reply.raw.end();
      }),
    },
    scraper: {},
  };
}

let server: FastifyInstance | undefined;

async function start(services = makeServices()) {
  server = fastify();
  server.addHook('onRequest', createTokenGuard(TOKEN));
  await server.register(nexusRouter, { prefix: '/api/v5', ...services });
  await server.ready();
  return { server, services };
}

const auth = { authorization: `Bearer ${TOKEN}` };

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('内部 HTTP API のトークン認証（承認済みの差分 3）', () => {
  it('トークンが無い・違う・Bearer でないリクエストは 401', async () => {
    const { server } = await start();
    expect((await server.inject({ method: 'GET', url: '/api/v5/interests' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/api/v5/interests', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/api/v5/interests', headers: { authorization: TOKEN } })).statusCode).toBe(401);
  });

  it('正しいトークンなら通る', async () => {
    const { server, services } = await start();
    const res = await server.inject({ method: 'GET', url: '/api/v5/interests', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ categories: {} });
    expect(services.settingsManager.getInterests).toHaveBeenCalledTimes(1);
  });

  it('クエリのトークンは /events だけで受け付ける（EventSource はヘッダーを付けられないため）', async () => {
    const { server } = await start();
    expect((await server.inject({ method: 'GET', url: `/api/v5/interests?token=${TOKEN}` })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: `/api/v5/events?token=${TOKEN}` })).statusCode).toBe(200);
  });
});

describe('追加した 4 ルート（承認済みの差分 5）', () => {
  it('POST /suggest-category はカテゴリ名を AI に渡す', async () => {
    const { server, services } = await start();
    const res = await server.inject({ method: 'POST', url: '/api/v5/suggest-category', headers: auth, payload: { categoryName: 'Tech' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ brands: ['Tech'], keywords: [], emoji: '🧪', reason: 'r' });
    expect(services.gemini.suggestCategoryDetails).toHaveBeenCalledWith('Tech');
  });

  it('POST /translate-interests は本文をそのまま DiscoveryService に渡す', async () => {
    const { server, services } = await start();
    const body = { interests: { categories: {} }, feedConfig: {} };
    const res = await server.inject({ method: 'POST', url: '/api/v5/translate-interests', headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ translated: body });
    expect(services.evolution.translateInterests).toHaveBeenCalledWith(body);
  });

  it('POST /reset-to-defaults は言語を渡す（未指定なら ja）', async () => {
    const { server, services } = await start();
    const en = await server.inject({ method: 'POST', url: '/api/v5/reset-to-defaults', headers: auth, payload: { language: 'en' } });
    expect(en.json()).toEqual({ success: true });
    await server.inject({ method: 'POST', url: '/api/v5/reset-to-defaults', headers: auth, payload: {} });
    expect(services.settingsManager.resetToDefaults.mock.calls).toEqual([['en'], ['ja']]);
  });

  it('処理が失敗したら 500 を返し、例外の詳細は応答に含めない', async () => {
    const services = makeServices();
    services.gemini.suggestCategoryDetails.mockRejectedValueOnce(new Error('secret internal path C:/x'));
    const { server } = await start(services);
    const res = await server.inject({ method: 'POST', url: '/api/v5/suggest-category', headers: auth, payload: { categoryName: 'Tech' } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internal path');
  });

  it('GET /events は SSE としてオーケストレーターに購読させる', async () => {
    const { server, services } = await start();
    const res = await server.inject({ method: 'GET', url: '/api/v5/events', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    // 最初のコメント行（接続成立の合図）のあとに通常のイベントが続く
    expect(res.body).toBe(': connected\n\ndata: {"status":"idle"}\n\n');
    expect(services.orchestrator.subscribe).toHaveBeenCalledTimes(1);
  });
});
