import { BrowserWindow, nativeImage, shell } from 'electron';
import path from 'path';
import type { Services } from './services';
import { setMainWindow } from './mainWindowState';

/** 開発中にレンダラーを配信する Vite のアドレス。 */
const DEV_SERVER_URL = 'http://localhost:5173';

/**
 * システムブラウザへ渡してよい URL か（http/https だけ。大文字のスキームは旧版どおり対象外）。
 * window.open・リンクでの遷移・open-external・open-article で共通に使う。
 */
export function isWebUrl(url: unknown): url is string {
  return typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'));
}

/**
 * メインウィンドウを作る（RULE-044）。
 * - frame: false で独自のタイトルバー、thickFrame: true で Windows のスナップ（FancyZones）に対応する。
 * - sandbox・contextIsolation を有効にし、nodeIntegration は無効にする。
 * - 新しいウィンドウは作らせず、外部 URL はシステムブラウザで開く。
 */
export function createMainWindow(services: Services, isDev: boolean, electronDir: string): BrowserWindow {
  const iconPath = path.join(electronDir, '../public/app-icon-192.png');
  const icon = nativeImage.createFromPath(iconPath);

  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 400,
    minHeight: 300,
    useContentSize: true,
    frame: false,
    icon,
    transparent: false, // FancyZones 対応のため透明度はオフ
    backgroundColor: '#121214', // 読み込み中のちらつきを防ぐため、テーマの背景色に合わせる
    resizable: true,
    hasShadow: true,
    thickFrame: true, // Windows でのスナップ（FancyZones）に必須
    webPreferences: {
      preload: path.join(electronDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload.cjs は require('electron') だけを使うので sandbox 下でも動く
      sandbox: true,
    },
  });
  setMainWindow(mainWindow);

  // 古い連携口。NexusOrchestrator に定義されていれば webContents を渡す
  const orchestrator = services.orchestrator as unknown as { setWebContents?: (contents: unknown) => void };
  if (orchestrator && typeof orchestrator.setWebContents === 'function') {
    orchestrator.setWebContents(mainWindow.webContents);
  }

  // window.open() / <a target="_blank"> はシステムブラウザへ回し、子ウィンドウは作らない
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // メインウィンドウ自体の外部への遷移を止め、外部 URL はシステムブラウザで開く
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isAppUrl = isDev ? url.startsWith(DEV_SERVER_URL) : url.startsWith('file://');
    if (isAppUrl) return;
    event.preventDefault();
    if (isWebUrl(url)) shell.openExternal(url);
  });

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(electronDir, '../dist/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 起動直後に一度フェッチして、すぐに記事を表示する。
    // 拒否を放置すると unhandledRejection になり、crashLog が app.quit() する。
    services.settingsManager.getInterests().then((interests) => {
      return services.scraper.fetchAndProcessArticlesWithFallback(interests);
    }).then((articles) => {
      console.log(`[Main] Initial fetch completed: ${articles.length} articles.`);
    }).catch((error: unknown) => {
      console.error('[Main] Initial fetch failed:', error);
    });
  });

  return mainWindow;
}

/** 記事を、アプリ内の別ウィンドウで開く。http/https 以外は開かない。Ctrl+Q で閉じる。 */
export function openArticleWindow(url: unknown): void {
  if (!isWebUrl(url)) return;
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setMenu(null);
  win.loadURL(url);

  win.webContents.on('before-input-event', (inputEvent, input) => {
    if (input.control && input.key.toLowerCase() === 'q') {
      win.close();
      inputEvent.preventDefault();
    }
  });
}
