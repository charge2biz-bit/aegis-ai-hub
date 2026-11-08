import { app, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { LicenseManager } from '../../../src/services/LicenseManager';
import { getMainWindow, sendToRenderer } from '../mainWindowState';
import { isWebUrl, openArticleWindow } from '../windows';

/** カスタムタイトルバーのウィンドウ操作と、外部 URL・記事ウィンドウを開く IPC。 */
export function registerWindowIpc(): void {
  ipcMain.on('window-control', (_event, action: string) => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    switch (action) {
      case 'minimize': mainWindow.minimize(); break;
      case 'maximize': if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); break;
      case 'close': mainWindow.close(); break;
      case 'quit': app.quit(); break;
    }
  });

  // 外部リンクをシステムブラウザで開く（http/https のみ）
  ipcMain.on('open-external', (_event, url: unknown) => {
    if (isWebUrl(url)) shell.openExternal(url);
  });

  ipcMain.on('open-article', (_event, url: unknown) => {
    openArticleWindow(url);
  });
}

/** ライセンス（RULE-043/071）と自動更新（RULE-062）の IPC。 */
export function registerLicenseAndUpdateIpc(licenseManager: LicenseManager): void {
  ipcMain.handle('get-license-state', async () => {
    return licenseManager.state;
  });

  // 状態が変わったら画面へ license-changed を送る（Phase 3 で preload が受け取れるようにした）
  ipcMain.handle('activate-license', async (_event, key: string, email: string) => {
    const result = await licenseManager.activate(key, email);
    if (result.success) {
      sendToRenderer('license-changed', licenseManager.state);
    }
    return result;
  });

  ipcMain.handle('deactivate-license', async () => {
    await licenseManager.deactivate();
    sendToRenderer('license-changed', licenseManager.state);
    return { success: true };
  });

  ipcMain.handle('get-feature-gates', async () => {
    return licenseManager.getFeatureGates();
  });

  ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) return { status: 'dev' };
    autoUpdater.checkForUpdates();
    return { status: 'checking' };
  });

  ipcMain.handle('install-update', async () => {
    autoUpdater.quitAndInstall();
  });
}
