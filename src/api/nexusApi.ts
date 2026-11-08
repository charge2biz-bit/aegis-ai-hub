/**
 * @file nexusApi.ts
 * @description フロントエンドからバックエンド（Electron IPC または HTTP API）へアクセスするための統合APIクライアント。
 * 環境（デスクトップアプリ版、Webブラウザ版、E2Eテスト環境）に応じて通信手段を自動的に切り替え、
 * UIコンポーネントに透過的なデータアクセスを提供する。
 * @dependencies
 * - React Hooks (useState, useEffect, useCallback)
 * - ../types: 共有型定義
 */

import { useState, useEffect, useCallback } from 'react';
import type { Article, NexusSettings, AgentStatus, InterestCategory, FeedConfig, UiSettings, TrendSuggestion, Interests, UsageStats, Credentials } from '../types';
import { DEFAULT_OBSIDIAN_VAULT_PATH } from '../models/vaultPath';
import { DEFAULT_MODEL } from '../models/AiModels';

/** 
 * ウィンドウの座標とサイズ情報を保持するインターフェース。
 * 永続化されたウィンドウ状態の復元に使用。
 */
export interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
}

/** 
 * E2Eテスト環境下であるかどうかを判定する内部関数。
 * テスト時はベースURLを空にし、モックサーバーへのリクエストを容易にする。
 */
/**
 * 内部 HTTP API のトークン。ブラウザ単体の開発時だけ使う（Electron の中では IPC を使う）。
 * main 側の NEXUS_API_TOKEN と同じ値を、Vite の VITE_NEXUS_API_TOKEN に入れる。
 */
const apiToken = (): string | undefined => (import.meta.env?.VITE_NEXUS_API_TOKEN as string | undefined) || undefined;

/** 内部 HTTP API への fetch。トークンがあれば Authorization ヘッダーを付ける。 */
const apiFetch = (url: string, init: RequestInit = {}): Promise<Response> => {
  const token = apiToken();
  if (!token) return fetch(url, init);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
};

const isE2E = () => (typeof window !== 'undefined' && (window as unknown as { isE2ETest?: boolean }).isE2ETest === true);

/**
 * nexusApiオブジェクト
 * 
 * 全てのAPI呼び出しを集約するシングルトンライクなオブジェクト。
 * ElectronのIPCブリッジ (window.nexusApi) が利用可能な場合はそれを優先し、
 * 利用不可（ブラウザ単体起動など）な場合は標準のfetch APIによるHTTP通信にフォールバックする。
 */
export const nexusApi = {
  /** 接続先バックエンドのベースURLを取得。開発環境ではFastifyのポート(3005)を指す。 */
  getBackendUrl(): string {
    // In dev mode, we use the Vite proxy or direct Fastify port
    return isE2E() ? '' : 'http://localhost:3005';
  },

  /** 
   * 最新の記事リストを取得。
   * HTTP経由の場合はカテゴリごとにグループ化されたデータを平坦化し、重要度（score）順にソートして返す。
   */
  async getArticles(): Promise<Article[]> {
    // 1. Electron IPC (Preferred)
    if (window.nexusApi?.getArticles && !isE2E()) {
      return await window.nexusApi.getArticles();
    }
    // 2. Browser Fallback (Fetch)
    try {
      const url = `${this.getBackendUrl()}/api/dashboard`;
      const res = await apiFetch(url);
      const data = await res.json();
      const allArticles: Article[] = [];
      // Flatten grouped dashboard data from HTTP API
      Object.values(data as Record<string, { articles: Article[] }>).forEach(group => {
        if (group?.articles) allArticles.push(...group.articles);
      });
      return allArticles.sort((a, b) => b.score - a.score);
    } catch (e) {
      console.error('[nexusApi] Fetch articles failed:', e);
      return [];
    }
  },

  /** 興味関心設定とフィード構成を同時に取得する。 */
  async getSettings(): Promise<NexusSettings> {
    if (window.nexusApi?.getSettings && !isE2E()) {
      return await window.nexusApi.getSettings();
    }
    try {
      const urlInterests = `${this.getBackendUrl()}/api/v5/interests`;
      const urlFeeds = `${this.getBackendUrl()}/api/v5/feeds`;
      const interests = await apiFetch(urlInterests).then(r => r.json());
      const feeds = await apiFetch(urlFeeds).then(r => r.json());
      return { interests, feedConfig: feeds };
    } catch (e) {
      console.error('[nexusApi] Fetch settings failed:', e);
      throw e;
    }
  },

  /** 設定内容をバックエンドに保存・同期する。 */
  async syncSettings(settings: NexusSettings): Promise<{ lastUpdated: number }> {
    if (window.nexusApi?.syncSettings && !isE2E()) {
      return await window.nexusApi.syncSettings(settings);
    }
    const res = await apiFetch(`${this.getBackendUrl()}/api/v5/sync-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    return await res.json();
  },

  /** AIエージェントによる自律的なワークフロー（オーケストレーション）を起動する。 */
  async triggerOrchestration(requirements?: string): Promise<{ success: boolean; newFeedsCount: number }> {
    if (window.nexusApi?.triggerOrchestration && !isE2E()) {
      return await window.nexusApi.triggerOrchestration(requirements);
    }
    const res = await apiFetch(`${this.getBackendUrl()}/api/v5/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirements })
    });
    return await res.json();
  },

  /** 指定されたカテゴリ名に関連するブランドやキーワード、絵文字をAIに提案させる。 */
  async suggestCategory(categoryName: string): Promise<{ brands: string[], keywords: string[], emoji: string, reason: string }> {
    if (window.nexusApi?.suggestCategory && !isE2E()) {
      return await window.nexusApi.suggestCategory(categoryName);
    }
    const res = await apiFetch(`${this.getBackendUrl()}/api/v5/suggest-category`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryName })
    });
    return await res.json();
  },

  /** カテゴリ構造全体の再編成（インテリジェント・リファクタリング）をAIに依頼する。 */
  async restructureCategories(count?: number, language: string = 'ja'): Promise<{ categories: Record<string, InterestCategory>, feedConfig: FeedConfig }> {
    if (window.nexusApi?.restructureCategories && !isE2E()) {
      return await window.nexusApi.restructureCategories(count, language);
    }
    const res = await apiFetch(`${this.getBackendUrl()}/api/v5/restructure-categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, language })
    });
    return await res.json();
  },

  /** 現在のニュースデータから最新のトレンドを分析・抽出する。 */
  async discoverTrends(): Promise<{ suggestions: TrendSuggestion[] }> {
    if (window.nexusApi?.discoverTrends && !isE2E()) {
      return await window.nexusApi.discoverTrends();
    }
    const res = await apiFetch(`${this.getBackendUrl()}/api/v5/discover-trends`, { method: 'POST' });
    return await res.json();
  },

  /** 既存の設定（興味関心）を別の言語へ変換・翻訳する。 */
  async translateInterests(settings: NexusSettings): Promise<{ interests: Interests, feedConfig: FeedConfig }> {
    if (window.nexusApi?.translateInterests && !isE2E()) {
      return await window.nexusApi.translateInterests(settings);
    }
    const res = await apiFetch(`${this.getBackendUrl()}/api/v5/translate-interests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    return await res.json();
  },

  /** プロファイルをデフォルト状態にリセットする。 */
  async resetToDefaults(): Promise<{ success: boolean }> {
    if (window.nexusApi?.resetToDefaults && !isE2E()) {
      return await window.nexusApi.resetToDefaults();
    }
    const res = await apiFetch(`${this.getBackendUrl()}/api/v5/reset-to-defaults`, {
      method: 'POST'
    });
    return await res.json();
  },

  /** 全カテゴリのフィード先をGeminiで再取得する。 */
  async reacquireAllFeeds(): Promise<{ success: boolean; feedConfig: FeedConfig }> {
    if (window.nexusApi?.reacquireAllFeeds && !isE2E()) {
      return await window.nexusApi.reacquireAllFeeds();
    }
    const res = await apiFetch(`${this.getBackendUrl()}/api/v5/reacquire-all-feeds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    return await res.json();
  },

  /** APIキーをセキュアに取得する（Electron環境のみ推奨）。 */
  async getApiKey(): Promise<string> {
    if (window.nexusApi?.getApiKey && !isE2E()) {
      return await window.nexusApi.getApiKey();
    }
    return '';
  },

  /** APIキーをバックエンドに安全に保存する。 */
  async saveApiKey(apiKey: string): Promise<{ success: boolean }> {
    if (window.nexusApi?.saveApiKey && !isE2E()) {
      return await window.nexusApi.saveApiKey(apiKey);
    }
    return { success: true };
  },

  /** 拡張された認証情報 (Credentials) を取得する。 */
  async getCredentials(): Promise<Credentials> {
    if (window.nexusApi?.getCredentials && !isE2E()) {
      return await window.nexusApi.getCredentials();
    }
    // Web環境やE2Eでのフォールバック
    return {
      activeProvider: 'google',
      activeModel: DEFAULT_MODEL,
      google: {},
      anthropic: {},
      openai: {},
      ollama: { baseUrl: 'http://localhost:11434' }
    };
  },

  /** 拡張された認証情報を保存する。 */
  async saveCredentials(creds: Credentials): Promise<{ success: boolean }> {
    if (window.nexusApi?.saveCredentials && !isE2E()) {
      return await window.nexusApi.saveCredentials(creds);
    }
    return { success: true };
  },

  /** UI固有の設定（表示モード、テーマ等）を取得する。 */
  async getUiSettings(): Promise<UiSettings> {
    if (window.nexusApi?.getUiSettings && !isE2E()) {
      return await window.nexusApi.getUiSettings();
    }
    try {
      const url = `${this.getBackendUrl()}/api/v5/ui-settings`;
      const res = await apiFetch(url);
      return await res.json();
    } catch {
      return {
        jaOnly: false,
        viewMode: 'grid',
        hideImages: false,
        isInitialized: true,
        theme: 'system',
        language: 'ja',
        autoLaunch: false,
        refreshInterval: 15,
        obsidianVaultPath: DEFAULT_OBSIDIAN_VAULT_PATH,
        enableObsidianAutoSync: true
      };
    }
  },

  /** UI設定を永続化する。 */
  async saveUiSettings(settings: UiSettings): Promise<{ success: boolean }> {
    if (window.nexusApi?.saveUiSettings && !isE2E()) {
      return await window.nexusApi.saveUiSettings(settings);
    }
    return { success: true };
  },

  /** AIの使用量統計が更新された際のイベント購読。 */
  onUsageUpdate(callback: (stats: UsageStats) => void): () => void {
    if (window.nexusApi?.onUsageUpdate && !isE2E()) {
      return window.nexusApi.onUsageUpdate(callback);
    }
    return () => {};
  },

  /** トークン消費量などの利用統計を取得する。 */
  async getUsageStats(): Promise<UsageStats> {
    if (window.nexusApi?.getUsageStats && !isE2E()) {
      return await window.nexusApi.getUsageStats();
    }
    try {
      const url = `${this.getBackendUrl()}/api/v5/usage-stats`;
      const res = await apiFetch(url);
      return await res.json();
    } catch {
      return {};
    }
  },

  /** ウィンドウの制御（最小化・最大化・閉じる）。 */
  windowControl(action: 'minimize' | 'maximize' | 'close' | 'quit'): void {
    if (window.nexusApi?.windowControl && !isE2E()) {
      window.nexusApi.windowControl(action as unknown as 'minimize' | 'maximize' | 'close');
    }
  },
  
  /** 外部URLをシステムのデフォルトブラウザで安全に開く。 */
  openExternal(url: string): void {
    if (window.nexusApi?.openExternal && !isE2E()) {
      window.nexusApi.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  },

  /** 記事をアプリ内の別ウィンドウ（Webビュー）で安全に開く。 */
  openArticle(url: string): void {
    if (window.nexusApi?.openArticle && !isE2E()) {
      window.nexusApi.openArticle(url);
    } else {
      window.open(url, '_blank');
    }
  }
};

/**
 * useNexusSync カスタムフック
 * 
 * アプリケーション全体のデータ（記事リストと設定）の同期状態を管理する。
 * 初回ロード時のデータ取得、ポーリング、および設定更新後の再取得を一元化し、
 * ローディング状態やエラーハンドリングを抽象化して提供する。
 */
export function useNexusSync(refreshInterval: number = 15) {
  const [settings, setSettings] = useState<NexusSettings | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  /** バックエンドから最新データをフェッチする共通ロジック。 */
  const fetchData = useCallback(async (showLoading: boolean | unknown = false) => {
    const shouldShowLoading = showLoading === true;
    try {
      if (shouldShowLoading) setLoading(true);
      else setIsSyncing(true);

      const [s, a] = await Promise.all([
        nexusApi.getSettings(),
        nexusApi.getArticles()
      ]);
      setSettings(s);
      setArticles(a);
      setLastRefreshed(new Date());
      setError(null);
    } catch (err: unknown) {
      console.error('[useNexusSync] Fetch failed:', err);
      setError(err instanceof Error ? err.message : 'Fetch error');
    } finally {
      setLoading(false);
      setIsSyncing(false);
    }
  }, []);

  /** コンポーネントのマウント時に初回データを取得し、設定された間隔で自動リフレッシュする。 */
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (active) await fetchData(true); // 初回ロード時は画面全体ローディングを表示
    };
    void load();

    // refreshInterval > 0 の場合、指定分（ミリ秒）ごとにバックグラウンドでフィードを定期更新
    let interval: NodeJS.Timeout | null = null;
    if (refreshInterval > 0) {
      interval = setInterval(() => {
        if (active) void fetchData(false);
      }, refreshInterval * 60 * 1000);
    }

    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, [fetchData, refreshInterval]);

  /** 設定の保存と、それに伴う記事データの自動リフレッシュを行う。 */
  const sync = useCallback(async (newSettings: NexusSettings) => {
    try {
      setIsSyncing(true);
      const result = await nexusApi.syncSettings(newSettings);
      setSettings({
        ...newSettings,
        interests: {
          ...newSettings.interests,
          lastUpdated: result.lastUpdated
        }
      });
      // 設定変更後に記事の内容が変化する可能性があるため、即座にリフレッシュ。
      const a = await nexusApi.getArticles();
      setArticles(a);
      setLastRefreshed(new Date());
      setError(null);
    } catch (err: unknown) {
      console.error('[useNexusSync] Sync failed:', err);
      setError(err instanceof Error ? err.message : 'Sync error');
    } finally {
      setIsSyncing(false);
    }
  }, []);

  return { settings, articles, loading, isSyncing, error, sync, refetch: fetchData, lastRefreshed };
}

/**
 * useAgentEvents カスタムフック
 * 
 * バックエンドから送出されるAIエージェントの活動イベントをリッスンする。
 * ブラウザ環境では SSE (Server-Sent Events) を、Electron環境では IPC イベントを使用し、
 * エージェントのステータス更新やデータリフレッシュ要求をリアクティブにUIへ反映する。
 * 
 * @param {Function} onRefresh - バックエンドからリフレッシュ要求があった際のコールバック
 */
export function useAgentEvents(onRefresh?: () => void) {
  const [events, setEvents] = useState<AgentStatus[]>([
    { id: 'architect', name: 'Architect', status: 'idle', lastMessage: '', timestamp: '' },
    { id: 'curator', name: 'Curator', status: 'idle', lastMessage: '', timestamp: '' },
    { id: 'discovery', name: 'Discovery', status: 'idle', lastMessage: '', timestamp: '' },
    { id: 'archivist', name: 'Archivist', status: 'idle', lastMessage: '', timestamp: '' },
  ]);

  useEffect(() => {
    const backendUrl = isE2E() ? '' : 'http://localhost:3005';
    // ブラウザ版またはE2E環境では SSE (Server-Sent Events) でイベントを受信する。
    if (!window.nexusApi || isE2E()) {
      const token = apiToken();
      const eventSource = new EventSource(`${backendUrl}/api/v5/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.status === 'refresh') {
            onRefresh?.();
          } else if (data.agentId) {
            setEvents(prev => prev.map(a => a.id === data.agentId ? { ...a, ...data } : a));
          }
        } catch (err) {
          console.error('[SSE] Event parse error:', err);
        }
      };
      return () => eventSource.close();
    }
    
    // Electron環境では IPC (Inter-Process Communication) を介してイベントを受信する。
    window.nexusApi.onAgentEvent((data) => {
      if (data.status === 'refresh') {
        onRefresh?.();
      } else if (data.agentId) {
        setEvents(prev => prev.map(a => a.id === data.agentId ? { ...a, ...data } : a));
      }
    });
    
    return () => { 
      // クリーンアップ処理：リスナーの解除
      window.nexusApi?.removeAgentEventListener?.(); 
    };
  }, [onRefresh]);

  return events;
}
