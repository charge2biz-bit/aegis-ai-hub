import type { ServerResponse } from 'http';

/** SSE の接続を保つために、コメント行（`: ping`）を送る間隔。プロキシやブラウザの無通信切断より短くする。 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * SSE の応答に、接続直後のコメント行と定期的な heartbeat を流す。
 * コメント行（`:` で始まる行）は EventSource が無視するので、アプリの処理には影響しない。
 * 接続が閉じたら止まり、タイマーはプロセスの終了を妨げない。戻り値は手動で止める関数。
 */
export function startSseHeartbeat(raw: Pick<ServerResponse, 'write' | 'once'>, intervalMs: number = SSE_HEARTBEAT_INTERVAL_MS): () => void {
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  const write = (chunk: string): void => {
    try {
      raw.write(chunk);
    } catch {
      stop();
    }
  };
  write(': connected\n\n');
  timer = setInterval(() => write(': ping\n\n'), intervalMs);
  timer.unref();
  raw.once('close', stop);
  raw.once('error', stop);
  return stop;
}
