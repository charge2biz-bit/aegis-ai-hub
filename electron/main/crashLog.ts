import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * 想定外の例外で落ちたときの記録（RULE-044）。
 * userData は app の準備ができるまで使えないので、記録先は whenReady の後で設定する。
 * それまでの例外はホームディレクトリの aegis_crash.log に書く。
 */
let crashLogPath: string | undefined;

export function setCrashLogPath(logPath: string): void {
  crashLogPath = logPath;
}

/** 直前のクラッシュ記録を消さないよう追記し、書き込み自体の失敗も stderr に残す。 */
function writeCrashLog(message: string): void {
  const logPath = crashLogPath || path.join(process.env.USERPROFILE || process.env.HOME || 'C:/Users/Public', 'aegis_crash.log');
  try {
    fs.appendFileSync(logPath, message);
  } catch (writeError) {
    console.error(`[Main] クラッシュログの書き込みに失敗しました (${logPath}):`, writeError);
    console.error(message);
  }
}

function describe(value: unknown): unknown {
  return (value as { stack?: unknown } | null | undefined)?.stack || value;
}

/**
 * 捕まえられなかった例外と Promise の拒否を記録し、アプリを終了する。
 * app.quit() は before-quit で止められうるうえ、終了コードが 0 になる。
 * 異常終了なので、イベントを経由せず終了コード 1 で即座に抜ける app.exit(1) を使う。
 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (error) => {
    writeCrashLog(`Uncaught Exception: ${new Date().toISOString()}\n${describe(error)}\n`);
    app.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    writeCrashLog(`Unhandled Rejection: ${new Date().toISOString()}\nReason: ${describe(reason)}\n`);
    app.exit(1);
  });
}
