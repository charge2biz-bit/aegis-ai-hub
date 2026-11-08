import fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { randomBytes, timingSafeEqual } from 'crypto';
import { nexusRouter } from '../../src/api/server/NexusRouter';
import type { Services } from './services';

/** 内部 HTTP API の待ち受け先（RULE-015）。外部からは届かないループバックだけにする。 */
const HOST = '127.0.0.1';
const PORT = 3005;

/** ブラウザ単体の開発（Vite）からの呼び出しだけを許可する（RULE-015）。 */
const ALLOWED_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

/** 開発用トークン（NEXUS_API_TOKEN）に求める最小の長さ。短い値は総当たりされうる。 */
export const MIN_API_TOKEN_LENGTH = 32;

/**
 * 内部 HTTP API のトークンを決める。
 * 開発中は環境変数 NEXUS_API_TOKEN を使える（Vite 側は VITE_NEXUS_API_TOKEN に同じ値を入れる）。
 * 32 文字未満の値は弱いので使わず、警告を出して起動ごとのランダムな値に切り替える。
 * パッケージ版は起動ごとにランダムに作る（そもそも待ち受けない。startInternalServer を参照）。
 */
export function resolveApiToken(isDev: boolean): string {
  const fromEnv = process.env.NEXUS_API_TOKEN;
  if (isDev && fromEnv) {
    if (fromEnv.length >= MIN_API_TOKEN_LENGTH) return fromEnv;
    console.warn(`[Main] NEXUS_API_TOKEN は ${MIN_API_TOKEN_LENGTH} 文字以上が必要です（現在 ${fromEnv.length} 文字）。無視してランダムなトークンを使います。`);
  }
  return randomBytes(32).toString('hex');
}

/** URL のクエリにある token の値を伏せる（EventSource は `?token=` で渡すため、ログに残さない）。 */
export function redactTokenInUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/gi, '$1[REDACTED]');
}

/** 開発中の Fastify のログ設定。リクエストの URL からトークンを伏せる。 */
export const DEV_LOGGER_OPTIONS = {
  serializers: {
    req(request: FastifyRequest) {
      return {
        method: request.method,
        url: redactTokenInUrl(request.url),
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      };
    },
  },
};

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * トークンの無いリクエストを 401 で断る（Phase 3 で承認された差分。旧版は無認証だった）。
 * `Authorization: Bearer <token>` を基本とし、ヘッダーを付けられない EventSource 用に
 * `/events` だけはクエリ `?token=` も受け付ける。CORS の事前確認（OPTIONS）は通す。
 */
export function createTokenGuard(token: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.method === 'OPTIONS') return;
    const header = request.headers.authorization;
    const fromHeader = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    const isEventStream = request.url.split('?')[0].endsWith('/events');
    const fromQuery = isEventStream ? (request.query as { token?: unknown } | undefined)?.token : undefined;
    const given = fromHeader ?? (typeof fromQuery === 'string' ? fromQuery : undefined);
    if (!given || !tokensMatch(given, token)) {
      await reply.code(401).send({ error: 'Unauthorized' });
    }
  };
}

/** 内部 HTTP API の部品だけを組み立てる（待ち受けはしない）。本物の Fastify での統合テストにも使う。 */
export async function buildInternalServer(services: Services, isDev: boolean, apiToken: string): Promise<FastifyInstance> {
  const { scraper, discoveryService, orchestrator, settingsManager, geminiService } = services;
  const server = fastify({ logger: isDev ? DEV_LOGGER_OPTIONS : false });
  await server.register(cors, {
    origin: (origin, cb) => {
      // file:// ロードや Electron からの呼び出しでは origin が未設定になるため許可
      if (!origin || ALLOWED_ORIGINS.has(origin)) cb(null, true);
      else cb(new Error('CORS: origin not allowed'), false);
    },
  });
  server.addHook('onRequest', createTokenGuard(apiToken));

  await server.register(nexusRouter, {
    prefix: '/api/v5',
    scraper,
    evolution: discoveryService,
    orchestrator,
    settingsManager,
    gemini: geminiService,
  });

  server.get('/api/dashboard', async () => {
    const interests = await settingsManager.getInterests();
    return await scraper.getDashboard(interests);
  });
  return server;
}

/**
 * ブラウザ実行・SSE 用の内部 HTTP API を起動する。失敗してもアプリは止めない（旧 startBackend の後半）。
 * パッケージ版ではレンダラーが IPC だけを使い、トークンも起動ごとのランダム値で誰にも渡らないため、
 * 待ち受けても使い道が無い。ポートを開けないよう、起動しない（P-267）。
 */
export async function startInternalServer(services: Services, isDev: boolean, apiToken: string): Promise<void> {
  if (!isDev) {
    console.log('[Main] パッケージ版のため内部 HTTP API は待ち受けません。');
    return;
  }
  const server = await buildInternalServer(services, isDev, apiToken);
  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`[Main] Internal Fastify server listening on http://${HOST}:${PORT}`);
  } catch (err) {
    console.error('[Main] Failed to start internal Fastify server:', err);
  }
}
