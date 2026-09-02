import type { SoftwareInfo } from '../templates/software';

/**
 * Everything a topic's render() is allowed to know about the server it's
 * answering about — deliberately a plain data snapshot, never a live
 * service. AssistantModule imports neither AgentClient nor FilesService
 * (see assistant.module.ts's doc comment): the assistant is consultative
 * by construction, not by code review, because there is structurally
 * nothing in this package that CAN mutate a server.
 */
export interface AssistantContext {
  serverName: string;
  memoryMb: number;
  diskMb: number;
  /** Server.status — 'active' | 'suspended' | 'installing' | 'install_failed' | 'deleting'. */
  status: string;
  /** DB snapshot, not the agent's live state (architecture doc: the agent never writes this back) — topics phrase around it as "provavelmente", never as certain fact. */
  powerState: string;
  software: SoftwareInfo;
  plan: {
    name: string;
    recommendedPlayersMin: number | null;
    recommendedPlayersMax: number | null;
    recommendedModsMin: number | null;
    recommendedModsMax: number | null;
    recommendedPluginsMin: number | null;
    recommendedPluginsMax: number | null;
  } | null;
  primaryAllocation: { ip: string; port: number } | null;
  /** Every permission key this caller actually holds — a topic can tailor its wording (never its correctness) around what the caller can actually click through to. */
  permissions: string[];
}

/**
 * A closed enum, never a raw URL/path — the API cannot point the panel at
 * an arbitrary destination, and the panel's `links.ts` maps every member
 * to a real, typed router `<Link>`. Adding a destination is a two-line
 * change (here + links.ts), not a security review.
 */
export type AssistantRoute =
  | 'server.console'
  | 'server.files'
  | 'server.addons'
  | 'server.backups'
  | 'server.variables'
  | 'server.databases'
  | 'server.schedules'
  | 'server.subusers'
  | 'server.activity'
  | 'client.plan'
  | 'client.support';

/**
 * A typed union, never markdown: no HTML-sanitization surface for
 * (eventually) untrusted LLM output, and `link` becomes a real in-app
 * navigation instead of a described destination — the actual usability
 * win over a plain text answer.
 */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'steps'; items: string[] }
  | { type: 'code'; language?: string; code: string }
  | { type: 'note'; tone: 'info' | 'warn'; text: string }
  | { type: 'link'; route: AssistantRoute; label: string }
  | { type: 'external'; url: string; label: string }
  | { type: 'kv'; items: { label: string; value: string }[] };

export interface AssistantMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantReply {
  blocks: AssistantBlock[];
  /** Which KB topic answered, if any — absent on a fallback/no-match reply. Not shown to the user; exists for the suggestions endpoint and tests. */
  topicId?: string;
  /** false on a fallback reply — the UI can style "not sure" differently without parsing block content to guess. */
  confident: boolean;
}

/**
 * The seam a future LLM adapter implements identically to the KB
 * provider — same request shape in, same typed block union out. Nothing
 * in the controller, the rate limiter, or the frontend needs to know
 * which one actually answered.
 */
export interface AssistantProvider {
  readonly id: 'kb' | 'llm';
  reply(message: string, history: AssistantMessage[], ctx: AssistantContext): Promise<AssistantReply>;
}

export interface AssistantSuggestion {
  topicId: string;
  title: string;
}
