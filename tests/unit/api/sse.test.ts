/**
 * SSE の heartbeat（P-267 レビュー指摘）。接続直後のコメント行と定期的な ping、切断での停止を確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { startSseHeartbeat } from '../../../src/api/server/sse';

function fakeResponse() {
  const emitter = new EventEmitter();
  const written: string[] = [];
  return Object.assign(emitter, {
    written,
    write: (chunk: string) => { written.push(chunk); return true; },
  });
}

describe('startSseHeartbeat', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('接続直後にコメント行を送り、間隔ごとに ping を送る', () => {
    const res = fakeResponse();
    startSseHeartbeat(res as never, 1000);
    expect(res.written).toEqual([': connected\n\n']);
    vi.advanceTimersByTime(2500);
    expect(res.written).toEqual([': connected\n\n', ': ping\n\n', ': ping\n\n']);
  });

  it('接続が閉じたら ping を止める', () => {
    const res = fakeResponse();
    startSseHeartbeat(res as never, 1000);
    res.emit('close');
    vi.advanceTimersByTime(5000);
    expect(res.written).toEqual([': connected\n\n']);
  });

  it('書き込みで例外が出たら止める（例外を外に出さない）', () => {
    const res = fakeResponse();
    startSseHeartbeat(res as never, 1000);
    res.write = () => { throw new Error('socket closed'); };
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('戻り値の関数で手動停止できる', () => {
    const res = fakeResponse();
    const stop = startSseHeartbeat(res as never, 1000);
    stop();
    vi.advanceTimersByTime(3000);
    expect(res.written).toEqual([': connected\n\n']);
  });
});
