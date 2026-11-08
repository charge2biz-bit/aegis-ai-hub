import path from 'path';
import { ElectronSettingsManager } from '../ElectronSettingsManager';
import { GeminiService } from '../../src/services/GeminiService';
import { FeedManager } from '../../src/services/FeedManager';
import { DiscoveryService } from '../../src/services/DiscoveryService';
import { EnrichmentService } from '../../src/services/EnrichmentService';
import { RSSFetcher } from '../../src/services/RSSFetcher';
import { ScraperFacade } from '../../src/ScraperFacade';
import { NexusOrchestrator } from '../../src/core/NexusOrchestrator';
import { ObsidianVaultService } from '../../src/services/ObsidianVaultService';
import { resolveObsidianVaultPath } from '../../src/models/vaultPath';
import type { FeedConfig } from '../../src/models/Schemas';
import { sendToRenderer } from './mainWindowState';

/** main プロセスで共有するバックエンドのサービス一式。 */
export interface Services {
  settingsManager: ElectronSettingsManager;
  geminiService: GeminiService;
  feedManager: FeedManager;
  rssFetcher: RSSFetcher;
  discoveryService: DiscoveryService;
  enrichmentService: EnrichmentService;
  scraper: ScraperFacade;
  orchestrator: NexusOrchestrator;
}

/** ScraperFacade は自前でサービスを作るので、共有インスタンスに差し替えるための書き込み口。 */
interface ScraperSharedServices {
  rssFetcher: RSSFetcher;
  geminiService: GeminiService;
  enrichmentService: EnrichmentService;
  feedManager: FeedManager;
  obsidianVaultService: ObsidianVaultService;
}

/**
 * NexusOrchestrator の進捗通知を、レンダラーへの IPC `agent-event` に中継する。
 * Phase 3 で承認された差分: 旧版では main がこのイベントを一度も送っていなかった。
 */
function bridgeAgentEventsToRenderer(orchestrator: NexusOrchestrator): void {
  orchestrator.onEvent((notification) => sendToRenderer('agent-event', notification));
}

/**
 * バックエンドのサービスを組み立てる（旧 startBackend の前半。順序は契約テストで固定）。
 * 利用統計の更新はレンダラーへ `usage-update` で送る。
 */
export async function createServices(dataDir: string, isDev: boolean): Promise<Services> {
  console.log('[Main] Starting backend services...');

  const settingsManager = new ElectronSettingsManager({ dataDir, isDev });
  await settingsManager.init();

  settingsManager.usageManager.onUpdate = (stats) => sendToRenderer('usage-update', stats);

  const credentials = await settingsManager.getCredentials();
  const geminiService = new GeminiService(credentials);
  geminiService.setUsageManager(settingsManager.usageManager);

  const feedConfigPath = path.join(dataDir, 'feed_config.json');
  const feedManager = new FeedManager(feedConfigPath);
  // SettingsManager の安全な書き込みを共有する
  feedManager.setSaveHandler(async (config: FeedConfig) => {
    await settingsManager.saveFeedConfig(config);
  });
  await feedManager.loadConfig();

  const rssFetcher = new RSSFetcher();
  const discoveryService = new DiscoveryService(geminiService, rssFetcher, feedManager);
  const enrichmentService = new EnrichmentService(geminiService, dataDir);
  const scraper = new ScraperFacade('', feedConfigPath, dataDir);
  const shared = scraper as unknown as ScraperSharedServices;
  shared.rssFetcher = rssFetcher;
  shared.geminiService = geminiService;
  shared.enrichmentService = enrichmentService;
  shared.feedManager = feedManager;

  const uiSettings = await settingsManager.getUiSettings();
  shared.obsidianVaultService = new ObsidianVaultService(
    resolveObsidianVaultPath(uiSettings.obsidianVaultPath),
    geminiService
  );

  const orchestrator = new NexusOrchestrator(geminiService);
  bridgeAgentEventsToRenderer(orchestrator);

  return { settingsManager, geminiService, feedManager, rssFetcher, discoveryService, enrichmentService, scraper, orchestrator };
}
