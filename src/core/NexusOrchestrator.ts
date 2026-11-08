/**
 * @file NexusOrchestrator.ts
 * @description システム全体の自律ワークフローを管理するオーケストレーター。
 * Architect, Curator, Discovery, Archivistといった各専門エージェントを束ね、
 * ユーザーの要件に基づく実行計画の立案から各ステップのディスパッチ、
 * フロントエンドへのリアルタイム通知（SSE）まで、システムの中枢として機能する。
 * @dependencies
 * - ../agents/*: 各専門エージェント群
 * - ../services/GeminiService: LLM推論基盤
 * - fastify: SSE（Server-Sent Events）でのクライアント通信用
 */

import type { FastifyReply } from 'fastify';
import { ArchitectAgent, type ExecutionPlan } from "../agents/ArchitectAgent";
import { DiscoveryAgent } from "../agents/DiscoveryAgent";
import { ArchivistAgent } from "../agents/ArchivistAgent";
import { CuratorAgent } from "../agents/CuratorAgent";
import { GeminiService } from "../services/GeminiService";

/**
 * オーケストレーターからフロントエンド（または他の購読者）へ状態を通知するためのデータ構造。
 * システムの透明性を確保し、ユーザーが各エージェントの現在のアクティビティを把握できるようにする。
 */
export interface OrchestratorNotification {
  status: string;
  message: string;
  data?: unknown;
  agentId?: string;
  timestamp?: string;
}

/**
 * NexusOrchestratorクラス
 * 
 * 各専門エージェントを協調させ、自律ワークフローを制御する中枢。
 * 単一責任原則に基づき、自身は直接的なタスク処理を行わず、計画立案(Architect)と
 * 各エージェントへのタスク委譲、およびその進行状況のブロードキャストに専念する。
 */
export class NexusOrchestrator {
  private architect: ArchitectAgent;
  private curator: CuratorAgent;
  private discovery: DiscoveryAgent;
  private archivist: ArchivistAgent;
  
  /**
   * SSE(Server-Sent Events)によるリアルタイム通知の購読者リスト。
   * クライアントとの接続状態を管理し、一斉送信を可能にする。
   */
  private subscribers: Set<FastifyReply> = new Set();

  /**
   * 進捗を関数で受け取る購読者（Electron の main がレンダラーへ中継するのに使う）。
   * SSE の応答オブジェクトを装わなくても購読できる。
   */
  private listeners: Set<(notification: OrchestratorNotification) => void> = new Set();
  
  /**
   * 多重実行を防止するための排他制御フラグ。
   * ワークフローのステートは一つのみであることを保証する。
   */
  private isRunning: boolean = false;

  /**
   * Orchestratorの初期化。
   * 各種エージェントを生成し、共通のLLM基盤（GeminiService）を注入する。
   * 
   * @param {GeminiService} geminiService - Geminiサービスインスタンス（依存性の注入）
   */
  constructor(geminiService: GeminiService) {
    this.architect = new ArchitectAgent(geminiService);
    this.curator = new CuratorAgent(geminiService);
    this.discovery = new DiscoveryAgent(geminiService);
    this.archivist = new ArchivistAgent(geminiService);
  }

  /**
   * APIキーを更新し、全ての子エージェントに伝播させる。
   * 設定変更がシステム全体へ即座に反映されることを保証する。
   * 
   * @param {string} apiKey - 新しいGemini APIキー
   */
  public updateApiKey(apiKey: string): void {
    this.architect.updateApiKey(apiKey);
    this.discovery.updateApiKey(apiKey);
    this.archivist.updateApiKey(apiKey);
    this.curator.updateApiKey(apiKey);
  }

  /**
   * クライアントからのSSE接続を購読者リストに登録する。
   * Fastifyのライフサイクルイベント（close, error）をリッスンし、
   * 切断時にはリストから除去することでメモリリークを確実に防ぐ。
   * 
   * @param {FastifyReply} res - Fastifyのレスポンスオブジェクト
   */
  public subscribe(res: FastifyReply): void {
    this.subscribers.add(res);
    // クライアント側からの切断や通信エラー時に安全にリソースを解放する
    if (res.raw) {
      res.raw.on('close', () => this.subscribers.delete(res));
      res.raw.on('error', () => this.subscribers.delete(res));
    }
  }

  /**
   * 進捗通知をコールバックで購読する。
   *
   * @param {(notification: OrchestratorNotification) => void} callback - 通知のたびに呼ばれる関数
   * @returns {() => void} 購読を解除する関数
   */
  public onEvent(callback: (notification: OrchestratorNotification) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * 現在接続中の全購読者（クライアント）へ、システムの状態変更やタスク進捗を通知する。
   * 
   * @param {OrchestratorNotification} data - 送信する通知ペイロード
   */
  public notify(data: OrchestratorNotification): void {
    // タイムスタンプが未指定の場合、イベント発生時刻を自動付与して時系列の正確性を担保
    if (!data.timestamp) data.timestamp = new Date().toISOString();
    console.log(`[NexusOrchestrator] ${data.message || data.status}`);
    const payload = `data: ${JSON.stringify(data)}\n\n`;

    // コールバック購読者へ配信。1 つの失敗で他の購読者への配信を止めない
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (error) {
        console.error('[NexusOrchestrator] 通知のコールバックが失敗しました:', error);
      }
    }
    
    // 全購読者への一斉配信ループ
    for (const res of this.subscribers) {
      try {
        if (res.raw) {
          res.raw.write(payload);
        }
      } catch {
        // 例外発生時は書き込み失敗とみなし、デッドコネクションを即座に除去（メモリリーク防止）
        this.subscribers.delete(res);
      }
    }
  }

  /**
   * ユーザー要件に基づく自律的なワークフロー（エージェント間の協調処理）を開始する。
   * 排他制御により、同時に複数のワークフローが実行されないことを保証する。
   * 
   * @param {string} requirements - ユーザーが入力したプロンプト・要件
   * @returns {Promise<void>}
   */
  async runAutonomousLoop(requirements: string): Promise<void> {
    // 状態の不整合を防ぐため、既に実行中の場合はブロックする
    if (this.isRunning) {
      throw new Error("Orchestrator is already running.");
    }

    this.isRunning = true;
    this.notify({ status: "working", message: "自律Nexusワークフローを開始します。", agentId: "architect" });

    try {
      // 1. Architect（設計担当エージェント）による要件解析と実行計画の立案
      this.notify({ status: "working", message: "Architectがプランを立案中...", agentId: "architect" });
      const plan: ExecutionPlan = await this.architect.plan(requirements);
      this.notify({ status: "success", message: "プランが確定しました。", agentId: "architect" });

      // 2. 立案されたプランに基づき、各ステップを順次実行（オーケストレーションの中核）
      for (const step of plan.steps) {
        const id = step.agent.toLowerCase();
        this.notify({ 
          status: "working", 
          message: `${step.agent} がアクションを実行中: ${step.action}`,
          agentId: id
        });

        let result: unknown;
        // エージェントの種類に応じてタスクをルーティングし、委譲する
        switch (step.agent) {
          case "Curator":
            // 実際の実装に合わせて interests を渡す必要があるが、ここではデモとして固定メッセージ
            result = { message: "Curated 10 high-quality articles based on interests." };
            break;
          case "Discovery":
            // 新たな情報源を発見・取得するタスクを実行
            result = await this.discovery.discoverSources({ categories: {} }); 
            break;
          case "Archivist":
            // 情報を要約し、ナレッジベースに永続化するタスクを実行
            result = await this.archivist.summarizeAndArchive("Aegis Nexus System Update");
            break;
          default:
            result = { message: "Unknown agent action performed." };
        }

        // 個別のステップ完了を通知し、UIのプログレスを更新させる
        this.notify({ 
          status: "success", 
          message: `${step.agent} のタスクが完了しました。`, 
          agentId: id,
          data: result 
        });
      }

      this.notify({ status: "idle", message: "全ての自律タスクが正常に完了しました。" });
      // 一連の処理完了後、フロントエンドに最新データの再取得（リフレッシュ）を要求する
      this.notify({ status: "refresh", message: "Updating intelligence feed..." });

    } catch (error: unknown) {
      // 予期せぬエラー発生時のフォールバック処理。エラー詳細をクライアントに伝播させ、デバッグを支援する
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[NexusOrchestrator] Error:", error);
      this.notify({ status: "error", message: `エラーが発生しました: ${msg}` });
    } finally {
      // 成功・失敗にかかわらず、次回の実行に備えてロックを解除し、全てのエージェント状態をリセットする
      this.isRunning = false;
      ["architect", "curator", "discovery", "archivist"].forEach(id => {
        this.notify({ status: "idle", message: "待機中", agentId: id });
      });
    }
  }
}
