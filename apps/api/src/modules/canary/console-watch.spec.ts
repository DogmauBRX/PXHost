import { ConsoleWatch } from './console-watch';

class FakeWebSocket {
  static last: FakeWebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) {
    this.sent.push(data);
    if (JSON.parse(data).event === 'auth') {
      setTimeout(() => {
        this.emit('auth:ok', {});
        this.emit('console:output', '[00:00:01 INFO]: Done (3.2s)! For help, type "help"');
      }, 0);
    }
  }
  close() {
    this.onclose?.();
  }
  emit(event: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ event, data }) });
  }
}

const realWebSocket = globalThis.WebSocket;

describe('ConsoleWatch', () => {
  beforeAll(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });
  afterAll(() => {
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  it('authenticates with the capability token', async () => {
    const watch = await ConsoleWatch.open('wss://node/ws', 'tok');
    expect(JSON.parse(FakeWebSocket.last.sent[0])).toEqual({ event: 'auth', data: { token: 'tok' } });
    watch.close();
  });

  it('ignores the replayed scrollback once armed and waits for a new boot', async () => {
    const watch = await ConsoleWatch.open('wss://node/ws', 'tok');
    watch.arm();
    const waiting = watch.waitFor(/Done \(/, 2000);
    let settled = false;
    void waiting.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    FakeWebSocket.last.emit('console:output', '[00:01:00 INFO]: Done (5.1s)! For help, type "help"');
    await expect(waiting).resolves.toContain('5.1s');
    watch.close();
  });

  it('fails fast when the server crashes after being armed', async () => {
    const watch = await ConsoleWatch.open('wss://node/ws', 'tok');
    watch.arm();
    const waiting = watch.waitFor(/Done \(/, 5000);
    FakeWebSocket.last.emit('console:output', 'Exception in thread "main"');
    FakeWebSocket.last.emit('stats', { state: 'crashed' });
    await expect(waiting).rejects.toThrow('crashed');
    expect(watch.tail(5)).toContain('Exception in thread "main"');
    watch.close();
  });

  it('times out with a readable message', async () => {
    const watch = await ConsoleWatch.open('wss://node/ws', 'tok');
    watch.arm();
    await expect(watch.waitFor(/Done \(/, 100)).rejects.toThrow('não terminou em 0s');
    watch.close();
  });
});
