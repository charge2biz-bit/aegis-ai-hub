/**
 * NexusOrchestrator.onEvent（P-267 レビュー指摘）。偽の FastifyReply を使わずに進捗を受け取れることを確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NexusOrchestrator } from '../../../src/core/NexusOrchestrator';
import type { GeminiService } from '../../../src/services/GeminiService';

function create() {
  return new NexusOrchestrator({} as unknown as GeminiService);
}

describe('NexusOrchestrator.onEvent', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('notify のたびにコールバックが呼ばれ、タイムスタンプが付く', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const o = create();
    const cb = vi.fn();
    o.onEvent(cb);
    o.notify({ status: 'working', message: 'm', agentId: 'architect' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ status: 'working', message: 'm', agentId: 'architect' });
    expect(typeof cb.mock.calls[0][0].timestamp).toBe('string');
  });

  it('戻り値の関数で購読を解除できる', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const o = create();
    const cb = vi.fn();
    const off = o.onEvent(cb);
    off();
    o.notify({ status: 'idle', message: 'x' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('コールバックが例外を投げても、他の購読者と SSE への配信は続く', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = create();
    o.onEvent(() => { throw new Error('boom'); });
    const second = vi.fn();
    o.onEvent(second);
    const write = vi.fn();
    o.subscribe({ raw: { write, on: vi.fn() } } as never);
    expect(() => o.notify({ status: 'idle', message: 'x' })).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
