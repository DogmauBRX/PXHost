// Mirrors agent/internal/api/protocol.go exactly — one wire format shared
// by the browser and the agent, no translation layer in between
// (architecture doc 4.5/5.2).

export interface Envelope<T = unknown> {
  event: string;
  seq?: number;
  data?: T;
  ts?: number;
}

export const EventAuth = 'auth';
export const EventConsoleSend = 'console:send';
export const EventPowerSet = 'power:set';
export const EventPing = 'ping';

export const EventAuthOK = 'auth:ok';
export const EventConsoleOutput = 'console:output';
export const EventConsoleTruncated = 'console:truncated';
export const EventStatus = 'status';
export const EventStats = 'stats';
export const EventTokenExpiring = 'token:expiring';
export const EventTokenExpired = 'token:expired';
export const EventError = 'error';
export const EventPong = 'pong';

export const StatusAuthFailed = 4000;
export const StatusTokenExpired = 4001;
export const StatusPermissionDenied = 4003;
export const StatusServerNotFound = 4004;
export const StatusServerSuspended = 4009;

export interface AuthData {
  token: string;
}
export interface ConsoleSendData {
  command: string;
}
export interface PowerSetData {
  action: string;
}
export interface AuthOKData {
  permissions: string[];
  expiresAt: number;
}
export interface ConsoleOutputData {
  line: string;
  stream: string;
}
export interface StatusData {
  state: string;
  previous?: string;
}
export interface ErrorData {
  code: string;
  message: string;
  fatal: boolean;
}
export interface StatsFrame {
  state: string;
  cpu_percent: number;
  cpu_limit_percent: number;
  memory_bytes: number;
  memory_limit_bytes: number;
  disk_bytes: number;
  disk_limit_bytes: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  uptime_ms: number;
}
