/**
 * @file NexusRouter.ts
 * @description Fastifyベースのバックエンドサーバー用ルーティング定義。
 * 主にWebブラウザ版のUIや、Electron外のプロセスからのデータアクセスを
 * サポートするためのAPIエンドポイント群を提供する。
 * 内部的には ScraperFacade や SettingsManager に処理を委譲する。
 * @dependencies
 * - fastify: 高速なNode.js用Webフレームワーク
 */

import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { startSseHeartbeat } from './sse';

/**
 * nexusRouter プラグイン
 * 
 * システムの設定管理、トレンド分析、統計情報などの機能への
 * HTTP(S)アクセスポイントを定義する。
 * 
 * @param {FastifyInstance} fastify - Fastifyインスタンス
 * @param {FastifyPluginOptions} options - scraper, settingsManager などの依存インスタンスを含むオプション
 */
export const nexusRouter = async (fastify: FastifyInstance, options: FastifyPluginOptions) => {
  const { scraper, settingsManager, orchestrator } = options;

  /**
   * GET /interests
   * 現在のユーザーの興味関心カテゴリ（および関連キーワード等）を取得する。
   */
  fastify.get('/interests', async (_request, reply) => {
    try {
      return await settingsManager.getInterests();
    } catch (error) {
      reply.status(500).send({ error: 'Failed to retrieve interests', details: String(error) });
    }
  });

  /**
   * GET /feeds
   * 現在登録されているフィード（ニュースソース）の設定情報を取得する。
   */
  fastify.get('/feeds', async (_request, reply) => {
    try {
      return await settingsManager.getFeedConfig();
    } catch (error) {
      reply.status(500).send({ error: 'Failed to retrieve feed config', details: String(error) });
    }
  });

  /**
   * POST /sync-settings
   * フロントエンドから送られてきた設定情報を永続化ストレージと同期する。
   */
  fastify.post('/sync-settings', async (request, reply) => {
    try {
      const result = await settingsManager.syncSettings(request.body);
      return result;
    } catch (error) {
      console.error('[NexusRouter] Sync Settings Error:', error);
      reply.status(500).send({ error: 'Failed to sync settings', details: String(error) });
    }
  });

  /**
   * POST /orchestrate
   * AIエージェントによる自律的なワークフロー（オーケストレーション）を手動で起動する。
   */
  fastify.post('/orchestrate', async (request, reply) => {
    try {
      const { requirements } = request.body as { requirements?: string };
      if (orchestrator) {
        void orchestrator.runAutonomousLoop(requirements || '');
        return { success: true, newFeedsCount: 0 };
      }
      return { success: false, newFeedsCount: 0 };
    } catch (error) {
      console.error('[NexusRouter] Orchestrate Error:', error);
      reply.status(500).send({ error: 'Failed to trigger orchestration', details: String(error) });
    }
  });

  /**
   * POST /discover-trends
   * AIを用いて現在のトレンドや新興キーワードの分析・抽出を実行する。
   */
  fastify.post('/discover-trends', async (_request, reply) => {
    try {
      const interests = await settingsManager.getInterests();
      const suggestions = await scraper.discoverTrends(interests);
      return { suggestions };
    } catch (error) {
      reply.status(500).send({ error: 'Failed to discover trends', details: String(error) });
    }
  });

  /**
   * POST /restructure-categories
   * AIによるカテゴリ構造の最適化（リファクタリング）をトリガーする。
   * (現在はプレースホルダー的な実装)
   */
  fastify.post('/restructure-categories', async (_request, reply) => {
    try {
      // 既存のメインプロセス側ロジックと重複するため簡略化。
      // 将来的には、Web版単体でも再編成を完結させるためのロジックをここに集約予定。
      return { categories: {}, feedConfig: {} };
    } catch (error) {
      reply.status(500).send({ error: 'Failed to restructure categories', details: String(error) });
    }
  });

  /**
   * POST /reacquire-all-feeds
   * 全カテゴリのフィード取得先をGeminiで再取得し、有効なRSSを確認して追加する。
   */
  fastify.post('/reacquire-all-feeds', async (_request, reply) => {
    try {
      const interests = await settingsManager.getInterests();
      const evolution = options.evolution;
      if (!evolution) {
        throw new Error('Evolution service (DiscoveryService) is not available');
      }
      const updatedFeedConfig = await evolution.reacquireAllFeeds(interests);
      return { success: true, feedConfig: updatedFeedConfig };
    } catch (error) {
      console.error('[NexusRouter] Reacquire All Feeds Error:', error);
      reply.status(500).send({ error: 'Failed to reacquire all feeds', details: String(error) });
    }
  });

  /**
   * GET /ui-settings
   * 表示モードやテーマ設定などのUI固有設定を取得する。
   */
  fastify.get('/ui-settings', async () => {
    return await settingsManager.getUiSettings();
  });

  /**
   * POST /save-ui-settings
   * UI設定（テーマ、言語、表示モードなど）を保存する。
   */
  fastify.post('/save-ui-settings', async (request) => {
    return await settingsManager.saveUiSettings(request.body);
  });

  /**
   * GET /usage-stats
   * AI（Gemini）のトークン消費量やコール数などの利用統計を取得する。
   */
  fastify.get('/usage-stats', async () => {
    return await settingsManager.getUsageStats();
  });

  // ── Phase 3 で追加（nexusApi が呼んでいたが、ここに無かった 4 ルート）──────────

  /**
   * POST /suggest-category
   * カテゴリ名から、ブランド・キーワード・絵文字の提案を AI に出させる（IPC の suggest-category と同じ処理）。
   */
  fastify.post('/suggest-category', async (request, reply) => {
    try {
      const { categoryName } = (request.body ?? {}) as { categoryName?: string };
      return await options.gemini.suggestCategoryDetails(categoryName ?? '');
    } catch (error) {
      console.error('[NexusRouter] Suggest Category Error:', error);
      reply.status(500).send({ error: 'Failed to suggest category details' });
    }
  });

  /**
   * POST /translate-interests
   * 興味関心の設定を、別の言語に翻訳する（IPC の translate-interests と同じ処理）。
   */
  fastify.post('/translate-interests', async (request, reply) => {
    try {
      return await options.evolution.translateInterests(request.body);
    } catch (error) {
      console.error('[NexusRouter] Translate Interests Error:', error);
      reply.status(500).send({ error: 'Failed to translate interests' });
    }
  });

  /**
   * POST /reset-to-defaults
   * 設定を初期状態に戻す（IPC の reset-to-defaults と同じ処理）。
   * 引数は取らない。互換のため、余分な本文・クエリの language は無視する（エラーにしない）。
   */
  fastify.post('/reset-to-defaults', async (_request, reply) => {
    try {
      const success = await settingsManager.resetToDefaults();
      return { success };
    } catch (error) {
      console.error('[NexusRouter] Reset To Defaults Error:', error);
      reply.status(500).send({ error: 'Failed to reset settings' });
    }
  });

  /**
   * GET /events
   * エージェントの進捗を SSE（Server-Sent Events）で配信する。
   * CORS プラグインが付けたヘッダーを引き継いでから、応答を Fastify の管理から外して書き続ける。
   */
  fastify.get('/events', async (_request, reply) => {
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value as string | number | string[]);
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // 最初のコメント行で接続の成立を知らせ、以後は heartbeat で無通信切断を防ぐ
    startSseHeartbeat(reply.raw);
    orchestrator.subscribe(reply);
  });
};

export default nexusRouter;
