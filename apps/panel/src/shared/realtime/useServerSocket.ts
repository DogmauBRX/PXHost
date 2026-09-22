import { useCallback, useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { mintConsoleToken } from '@/features/servers/servers.api';
import {
  EventAuth,
  EventAuthOK,
  EventConsoleOutput,
  EventConsoleSend,
  EventConsoleTruncated,
  EventError,
  EventPowerSet,
  EventStats,
  EventStatus,
  EventTokenExpired,
  EventTokenExpiring,
  type AuthOKData,
  type ConsoleOutputData,
  type Envelope,
  type ErrorData,
  type StatsFrame,
  type StatusData,
} from './protocol';
import type { PowerAction } from '@/shared/api/types';

export type ConnectionState = 'idle' | 'connecting' | 'authenticating' | 'open' | 'reconnecting' | 'failed';

const MAX_BACKOFF_MS = 15_000;
const HIDDEN_SUPPRESS_MS = 60_000;
const REAUTH_MARGIN_S = 30;

// The agent's own error `message` is a raw internal string meant for logs
// (e.g. "srv: server b0fd0c32-...-7f6cc5ef9a93 is not running") — found
// live, shown straight to a customer as a scary-looking, UUID-bearing
// error banner. `code` is the stable, finite part of the contract (see
// agent/internal/api/ws.go's own sendError call sites for the full set);
// this maps it to something a customer can actually make sense of, and
// the real message still reaches the browser console for support/
// debugging instead of just being thrown away.
const FRIENDLY_WS_ERROR_MESSAGES: Record<string, string> = {
  E_PERMISSION_DENIED: 'Você não tem permissão para fazer isso.',
  RATE_LIMITED: 'Muitos comandos em pouco tempo — espere um instante e tente de novo.',
  SERVER_OFFLINE: 'O servidor está desligado no momento.',
  POWER_ACTION_FAILED: 'Não foi possível concluir essa ação agora. Tente novamente em instantes.',
  BAD_REQUEST: 'Não foi possível processar essa ação.',
  REAUTH_FAILED: 'Sua sessão do console expirou.',
  UNKNOWN_EVENT: 'Ocorreu um erro inesperado.',
};

function friendlyWsErrorMessage(data: ErrorData): string {
  return FRIENDLY_WS_ERROR_MESSAGES[data.code] ?? 'Ocorreu um erro inesperado. Tente novamente em instantes.';
}

function backoffDelay(attempt: number): number {
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return base / 2 + Math.random() * (base / 2); // full-range jitter around the midpoint
}

interface UseServerSocketOptions {
  serverId: string;
  terminal: Terminal | null;
  onStats: (frame: StatsFrame) => void;
  onStatus?: (data: StatusData) => void;
}

export function useServerSocket({ serverId, terminal, onStats, onStatus }: UseServerSocketOptions) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const reauthTimerRef = useRef<number | null>(null);
  const hiddenSinceRef = useRef<number | null>(null);
  const closedByUsRef = useRef(false);
  // Bumped on every connect() call and on unmount. A connect() invocation
  // captures its own value at start and checks it again after the async
  // token mint — if it no longer matches, this call is stale (StrictMode's
  // dev-mode mount→unmount→remount is the reliable way to hit this: the
  // FIRST connect() is still awaiting mintConsoleToken when cleanup fires,
  // then resolves and would otherwise open a second, orphaned WebSocket
  // nothing ever tracks or closes — subscribed to the same console Hub,
  // so every line of output arrived twice). Found live: scrollback and a
  // sent command both visibly duplicated in the terminal.
  const generationRef = useRef(0);
  const terminalRef = useRef(terminal);
  terminalRef.current = terminal;
  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

  const writeLine = useCallback((line: string, stream: string) => {
    const term = terminalRef.current;
    if (!term) return;
    // stderr gets a dim-red prefix so a customer can tell it apart from
    // stdout at a glance, without xterm having to parse anything —
    // console output otherwise reaches the DOM only via xterm's own cell
    // rendering, never dangerouslySetInnerHTML (architecture doc 5.3).
    const prefix = stream === 'stderr' ? '\x1b[31m' : '';
    const suffix = stream === 'stderr' ? '\x1b[0m' : '';
    term.writeln(`${prefix}${line}${suffix}`);
  }, []);

  const clearTimers = () => {
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    if (reauthTimerRef.current) window.clearTimeout(reauthTimerRef.current);
    reconnectTimerRef.current = null;
    reauthTimerRef.current = null;
  };

  const scheduleReconnect = useCallback(() => {
    if (hiddenSinceRef.current && Date.now() - hiddenSinceRef.current > HIDDEN_SUPPRESS_MS) {
      // Tab has been hidden a while — wait for visibilitychange instead of
      // burning reconnect attempts (and the server's rate limit) in the
      // background.
      return;
    }
    setConnectionState('reconnecting');
    const delay = backoffDelay(attemptRef.current);
    attemptRef.current += 1;
    reconnectTimerRef.current = window.setTimeout(() => void connect(), delay);
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
  }, []);

  const connect = useCallback(async () => {
    clearTimers();
    closedByUsRef.current = false;
    setConnectionState('connecting');
    setLastError(null);
    const myGeneration = generationRef.current;

    let minted;
    try {
      minted = await mintConsoleToken(serverId);
    } catch {
      if (myGeneration !== generationRef.current) return; // superseded while awaiting
      setLastError('Não foi possível obter autorização para o console.');
      scheduleReconnect();
      return;
    }
    if (myGeneration !== generationRef.current) return; // superseded while awaiting — never open the socket

    const ws = new WebSocket(minted.wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionState('authenticating');
      ws.send(JSON.stringify({ event: EventAuth, data: { token: minted.token } } satisfies Envelope));
    };

    ws.onmessage = (msg) => {
      const env = JSON.parse(msg.data as string) as Envelope;
      switch (env.event) {
        case EventAuthOK: {
          const data = env.data as AuthOKData;
          attemptRef.current = 0;
          setConnectionState('open');
          setPermissions(data.permissions);
          const remainingMs = data.expiresAt * 1000 - Date.now();
          reauthTimerRef.current = window.setTimeout(
            () => void reauth(),
            Math.max(remainingMs - REAUTH_MARGIN_S * 1000, 1000),
          );
          break;
        }
        case EventConsoleOutput: {
          const data = env.data as ConsoleOutputData;
          writeLine(data.line, data.stream);
          break;
        }
        case EventConsoleTruncated:
          writeLine('[console truncated — output was arriving faster than it could be displayed]', 'stdout');
          break;
        case EventStats:
          statsRef.current(env.data as StatsFrame);
          break;
        case EventStatus:
          statusRef.current?.(env.data as StatusData);
          break;
        case EventTokenExpiring:
          void reauth();
          break;
        case EventTokenExpired:
          // The agent closes right after this; the onclose handler drives
          // the actual reconnect.
          break;
        case EventError: {
          const data = env.data as ErrorData;
          // eslint-disable-next-line no-console -- the raw detail is worth keeping for support, just never shown to the customer
          console.error(`[console] ${data.code}: ${data.message}`);
          setLastError(friendlyWsErrorMessage(data));
          break;
        }
        default:
          break;
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      clearTimers();
      if (closedByUsRef.current) return;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows onerror for a WebSocket; the actual
      // reconnect logic lives there to avoid double-scheduling.
    };

    async function reauth() {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      try {
        const fresh = await mintConsoleToken(serverId);
        wsRef.current.send(JSON.stringify({ event: EventAuth, data: { token: fresh.token } } satisfies Envelope));
      } catch {
        // The hard-expiry close (token:expired) is the fallback if this
        // fails — the connection will drop and reconnect cleanly.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, scheduleReconnect, writeLine]);

  useEffect(() => {
    void connect();

    const onVisibility = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
        return;
      }
      hiddenSinceRef.current = null;
      if (connectionState === 'reconnecting' || connectionState === 'failed') {
        attemptRef.current = 0;
        clearTimers();
        void connect();
      }
    };
    const onOnline = () => {
      if (connectionState === 'reconnecting' || connectionState === 'failed') {
        attemptRef.current = 0;
        clearTimers();
        void connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      generationRef.current += 1; // invalidates any connect() still awaiting mintConsoleToken
      closedByUsRef.current = true;
      clearTimers();
      wsRef.current?.close(1000, 'unmount');
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const sendCommand = useCallback((command: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ event: EventConsoleSend, data: { command } } satisfies Envelope));
  }, []);

  const sendPower = useCallback((action: PowerAction) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ event: EventPowerSet, data: { action } } satisfies Envelope));
  }, []);

  // Manual escape hatch for a socket that's gone quietly dead without
  // firing `onclose` — some networks/proxies never deliver the TCP
  // teardown, so `connectionState` keeps reading "open" while nothing a
  // customer sends actually reaches the agent. Same teardown as the
  // unmount cleanup (bump generation, mark closedByUs, drop the socket)
  // but immediately followed by a fresh connect() instead of leaving it
  // closed, and reset attemptRef so this doesn't inherit backoff from
  // whatever the connection was doing before.
  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    generationRef.current += 1;
    closedByUsRef.current = true;
    clearTimers();
    wsRef.current?.close(1000, 'manual-refresh');
    wsRef.current = null;
    void connect();
  }, [connect]);

  return { connectionState, permissions, lastError, sendCommand, sendPower, reconnect };
}
