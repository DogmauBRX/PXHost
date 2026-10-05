const MAX_LINES = 400;
const REPLAY_SETTLE_MS = 1500;

/**
 * A short-lived console subscription to one server, opened the same way the
 * customer's browser opens it (capability token + WS straight to the node).
 *
 * The agent replays its scrollback right after auth, so a "Done (" from an
 * earlier boot would satisfy a naive wait. `arm()` marks where new output
 * begins; `waitFor` only looks past that mark.
 */
export class ConsoleWatch {
  private readonly lines: string[] = [];
  private armedAt = 0;
  private dropped = 0;
  private crashed = false;
  private closed = false;
  private notify: (() => void) | null = null;

  private constructor(private readonly ws: WebSocket) {}

  static async open(wsUrl: string, token: string, timeoutMs = 15_000): Promise<ConsoleWatch> {
    const ws = new WebSocket(wsUrl);
    const watch = new ConsoleWatch(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('console: autenticação no agente não respondeu')), timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ event: 'auth', data: { token } }));
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('console: não foi possível conectar ao agente'));
      };
      ws.onclose = () => {
        watch.closed = true;
        watch.notify?.();
      };
      ws.onmessage = (m) => {
        let e: { event: string; data: unknown };
        try {
          e = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (e.event === 'auth:ok') {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (e.event === 'console:output') watch.push(typeof e.data === 'string' ? e.data : String((e.data as { line?: string })?.line ?? ''));
        if (e.event === 'stats' && (e.data as { state?: string })?.state === 'crashed' && watch.lines.length + watch.dropped > watch.armedAt) {
          watch.crashed = true;
          watch.notify?.();
        }
      };
    });
    await new Promise((r) => setTimeout(r, REPLAY_SETTLE_MS));
    return watch;
  }

  private push(line: string) {
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      this.lines.shift();
      this.dropped++;
    }
    this.notify?.();
  }

  /** Everything received from now on is "new" for waitFor. */
  arm() {
    this.armedAt = this.dropped + this.lines.length;
    this.crashed = false;
  }

  waitFor(pattern: RegExp, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const start = Math.max(0, this.armedAt - this.dropped);
        const hit = this.lines.slice(start).find((l) => pattern.test(l));
        if (hit) return finish(() => resolve(hit));
        if (this.crashed) return finish(() => reject(new Error('o servidor caiu (crashed) antes de terminar de iniciar')));
        if (this.closed) return finish(() => reject(new Error('a conexão com o console caiu')));
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`não terminou em ${Math.round(timeoutMs / 1000)}s`))), timeoutMs);
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        this.notify = null;
        fn();
      };
      this.notify = check;
      check();
    });
  }

  tail(n = 30): string[] {
    return this.lines.slice(-n);
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
