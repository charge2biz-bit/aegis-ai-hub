import { 
  type InterestCategory as SchemaInterestCategory, 
  type Interests as SchemaInterests, 
  type FeedConfig as SchemaFeedConfig, 
  type Skill as SchemaSkill,
  type UiSettings as SchemaUiSettings,
  type UsageStats as SchemaUsageStats,
  type Credentials as SchemaCredentials
} from '../models/Schemas';

export interface Article {
  title: string;
  link: string;
  desc: string;
  brand: string;
  score: number;
  img: string | null;
  date: string;
  category: string;
  geminiReason?: string;
  language: string;
}

export type InterestCategory = SchemaInterestCategory;
export type Interests = SchemaInterests;
export type FeedConfig = SchemaFeedConfig;
export type Skill = SchemaSkill;
export type UiSettings = SchemaUiSettings;
export type UsageStats = SchemaUsageStats;
export type Credentials = SchemaCredentials;

export interface NexusSettings {
  interests: Interests;
  feedConfig: FeedConfig;
  lastUpdated?: string | number;
}

export interface AgentStatus {
  id: string;
  name: string;
  status: 'idle' | 'working' | 'error' | 'success' | 'refresh';
  lastMessage: string;
  timestamp: string;
}

export interface NexusState {
  settings: NexusSettings;
  draft: NexusSettings;
  isDirty: boolean;
  lastUpdated: string;
}

export interface AgentEventData {
  agentId: string;
  status: 'idle' | 'working' | 'error' | 'success' | 'refresh';
  message: string;
  timestamp?: string;
}

export interface TrendSuggestion {
  value: string;
  category: string;
  reason: string;
  type?: 'emerging' | 'breakthrough' | 'niche' | 'mainstream';
  confidence?: number;
  context?: string;
}

export type EditorTab = 'editor' | 'graph' | 'skills' | 'system' | 'insights' | 'usage';

export interface NexusApiBridge {
  getArticles: (options?: Record<string, unknown>) => Promise<Article[]>;
  getSettings: () => Promise<NexusSettings>;
  syncSettings: (settings: NexusSettings) => Promise<{ lastUpdated: number }>;
  triggerOrchestration: (requirements?: string) => Promise<{ success: boolean; newFeedsCount: number }>;
  onAgentEvent: (callback: (data: AgentEventData) => void) => void;
  removeAgentEventListener: () => void;
  suggestCategory: (categoryName: string) => Promise<{
    brands: string[];
    keywords: string[];
    emoji: string;
    reason: string;
  }>;
  getApiKey: () => Promise<string>;
  saveApiKey: (apiKey: string) => Promise<{ success: boolean }>;
  getCredentials: () => Promise<Credentials>;
  saveCredentials: (creds: Credentials) => Promise<{ success: boolean }>;
  restructureCategories: (count?: number, language?: string) => Promise<{ categories: Record<string, InterestCategory>; feedConfig: FeedConfig }>;
  discoverTrends: () => Promise<{ suggestions: TrendSuggestion[] }>;
  translateInterests: (settings: NexusSettings) => Promise<{ interests: Interests, feedConfig: FeedConfig }>;
  resetToDefaults: () => Promise<{ success: boolean }>;
  windowControl: (action: 'minimize' | 'maximize' | 'close' | 'quit') => void;
  getUiSettings: () => Promise<UiSettings>;
  saveUiSettings: (settings: UiSettings) => Promise<{ success: boolean }>;
  getUsageStats: () => Promise<UsageStats>;
  onUsageUpdate: (callback: (stats: UsageStats) => void) => () => void;
  openExternal: (url: string) => void;
  openArticle: (url: string) => void;
  reacquireAllFeeds: () => Promise<{ success: boolean; feedConfig: FeedConfig }>;
  // ライセンス管理
  getLicenseState: () => Promise<import('../services/LicenseManager').LicenseState>;
  activateLicense: (key: string, email: string) => Promise<{ success: boolean; message: string }>;
  deactivateLicense: () => Promise<{ success: boolean }>;
  getFeatureGates: () => Promise<import('../services/LicenseManager').FeatureGate>;
  // 自動アップデート
  checkForUpdates?: () => Promise<{ status: string }>;
  installUpdate?: () => Promise<void>;
  onLicenseChanged?: (callback: (state: import('../services/LicenseManager').LicenseState) => void) => () => void;
  onUpdateEvent?: (callback: (data: { type: 'available' | 'downloaded' | 'error'; info?: unknown; message?: string }) => void) => () => void;
}

declare global {
  interface Window {
    nexusApi: NexusApiBridge;
  }
}
