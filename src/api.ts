// Modified by Angel Hermon (2026) from Claw-Kanban by GreenSheep01201; Apache-2.0 (see LICENSE).
export type CardStatus = "Inbox" | "Planned" | "In Progress" | "Review/Test" | "Done" | "Stopped";
export type Assignee = "claude" | "codex" | "gemini" | "opencode" | "copilot" | "antigravity" | "agy" | null;
export type Role = "devops" | "backend" | "frontend";
export type Provider = "claude" | "codex" | "gemini" | "opencode" | "copilot" | "antigravity" | "agy";
export type TaskType = "new" | "modify" | "bugfix";

export interface ProviderModelConfig {
  model: string;
}

export type ProviderModelConfigMap = Record<string, ProviderModelConfig>;

export interface ProviderSettings {
  roleProviders: {
    devops: Provider;
    backend: Provider;
    frontend: {
      new: Provider;
      modify: Provider;
      bugfix: Provider;
    };
  };
  stageProviders: {
    inProgress: Provider | null;
    reviewTest: Provider | null;
  };
  autoAssign: boolean;
  providerModelConfig?: ProviderModelConfigMap;
}

export interface Card {
  id: string;
  created_at: number;
  updated_at: number;
  source: string;
  source_message_id?: string | null;
  source_author?: string | null;
  source_chat?: string | null;
  title: string;
  description: string;
  status: CardStatus;
  assignee?: Assignee;
  priority: number;
  role?: Role;
  task_type?: TaskType;
  project_path?: string | null;
  run_started_at?: number | null;
  // Aggregated run stats, derived server-side from ALL of the card's card_runs rows (split by
  // whether the run was a review run). Present only when the card has at least one run - see
  // attachRunStats() in server/index.ts. Absent/undefined means "never run", not "zero".
  inProgressDurationMs?: number;
  reviewDurationMs?: number;
  totalDurationMs?: number;
  modelsUsed?: string[];
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
}

export interface CardLog {
  id: number;
  card_id: string;
  created_at: number;
  kind: string;
  message: string;
}

export interface CliToolStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authHint: string;
}

export type CliStatusMap = Record<Provider, CliToolStatus>;

export type OAuthConnectProvider = "github-copilot" | "antigravity";
export type OAuthSource = "github" | "copilot_pat" | "google_antigravity" | null;

export interface OAuthProviderStatus {
  provider: OAuthConnectProvider;
  connected: boolean;
  source: OAuthSource;
  email: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  expiresAt: number | null;
  scope: string | null;
  hasRefreshToken: boolean;
}

export type OAuthStatusMap = Record<OAuthConnectProvider, OAuthProviderStatus>;

const base = ""; // same origin (vite proxy)

export async function listCards(): Promise<Card[]> {
  const r = await fetch(`${base}/api/cards`);
  if (!r.ok) throw new Error(`listCards failed: ${r.status}`);
  const j = await r.json();
  return j.cards as Card[];
}

export async function createCard(input: {
  title: string;
  description: string;
  status?: CardStatus;
  assignee?: Exclude<Assignee, null>;
  priority?: number;
  role?: Role;
  task_type?: TaskType;
  project_path?: string;
}): Promise<string> {
  const r = await fetch(`${base}/api/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "manual", ...input }),
  });
  if (!r.ok) throw new Error(`createCard failed: ${r.status}`);
  const j = await r.json();
  return j.id as string;
}

export async function patchCard(
  id: string,
  patch: Partial<Pick<Card, "title" | "description" | "status" | "priority" | "assignee" | "role" | "task_type" | "project_path">>
): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patchCard failed: ${r.status}`);
}

export async function deleteCard(id: string): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`deleteCard failed: ${r.status}`);
}

export async function purgeByStatus(status: CardStatus): Promise<number> {
  const r = await fetch(`${base}/api/cards/purge?status=${encodeURIComponent(status)}`, { method: "POST" });
  if (!r.ok) throw new Error(`purgeByStatus failed: ${r.status}`);
  const j = await r.json();
  return j.deleted as number;
}

export async function getLogs(id: string): Promise<CardLog[]> {
  const r = await fetch(`${base}/api/cards/${id}/logs`);
  if (!r.ok) throw new Error(`getLogs failed: ${r.status}`);
  const j = await r.json();
  return j.logs as CardLog[];
}

export async function getTerminal(
  id: string,
  lines = 400,
  pretty = true
): Promise<{ exists: boolean; path: string; text: string }> {
  const r = await fetch(`${base}/api/cards/${id}/terminal?lines=${lines}&pretty=${pretty ? 1 : 0}`);
  if (!r.ok) throw new Error(`getTerminal failed: ${r.status}`);
  const j = await r.json();
  return { exists: j.exists as boolean, path: j.path as string, text: j.text as string };
}

export interface ParsedSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
}

export interface ParsedSessionModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export type SessionTimelineEntry =
  | { seq: number; kind: "assistant_text"; timestamp?: string; text: string }
  | {
      seq: number;
      kind: "tool_call";
      timestamp?: string;
      id: string;
      name: string;
      input: unknown;
      summary?: string;
      result?: string;
      isError?: boolean;
    }
  | { seq: number; kind: "notification"; timestamp?: string; text: string }
  | { seq: number; kind: "rate_limit"; timestamp?: string; status?: string };

export interface QuotaUtilizationSnapshot {
  fiveHourUtilization: number | null;
  sevenDayUtilization: number | null;
  timestamp?: string;
}

export interface ParsedSession {
  sessionId: string | null;
  model: string | null;
  isComplete: boolean;
  isError: boolean | null;
  stopReason: string | null;
  subtype: string | null;
  durationMs: number | null;
  apiDurationMs: number | null;
  numTurns: number | null;
  ttftMs: number | null;
  startedAt: string | null;
  usage: ParsedSessionUsage | null;
  totalCostUsd: number | null;
  modelUsage: Record<string, ParsedSessionModelUsage> | null;
  toolCallCount: number;
  rateLimitHit: boolean;
  finalResultText: string | null;
  unsupportedFormat?: boolean;
  timeline: SessionTimelineEntry[];
  latestQuotaUtilization: QuotaUtilizationSnapshot | null;
}

export interface CardSessionResponse {
  implementation: ParsedSession | null;
  review: ParsedSession | null;
}

export async function getCardSession(id: string): Promise<CardSessionResponse> {
  const r = await fetch(`${base}/api/cards/${id}/session`);
  if (!r.ok && r.status !== 404) throw new Error(`getCardSession failed: ${r.status}`);
  const j = await r.json();
  return { implementation: j.implementation ?? null, review: j.review ?? null };
}

export async function runCard(id: string): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}/run`, { method: "POST" });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.message ?? `runCard failed: ${r.status}`);
  }
}

export async function stopCard(id: string): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}/stop`, { method: "POST" });
  if (!r.ok) throw new Error(`stopCard failed: ${r.status}`);
}

export async function reviewCard(id: string): Promise<void> {
  const r = await fetch(`${base}/api/cards/${id}/review`, { method: "POST" });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.message ?? `reviewCard failed: ${r.status}`);
  }
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  roleProviders: {
    devops: "claude",
    backend: "codex",
    frontend: {
      new: "gemini",
      modify: "claude",
      bugfix: "claude",
    },
  },
  stageProviders: {
    inProgress: null,
    reviewTest: null,
  },
  autoAssign: true,
  providerModelConfig: {},
};

export type OAuthModelMap = Record<string, string[]>;

export async function getOAuthModels(): Promise<OAuthModelMap> {
  const r = await fetch(`${base}/api/oauth/models`);
  if (!r.ok) throw new Error(`getOAuthModels failed: ${r.status}`);
  const j = await r.json();
  return (j.models ?? {}) as OAuthModelMap;
}

export async function getSettings(): Promise<ProviderSettings> {
  const r = await fetch(`${base}/api/settings`);
  if (!r.ok) throw new Error(`getSettings failed: ${r.status}`);
  const j = await r.json();
  return j.settings as ProviderSettings;
}

export async function saveSettings(settings: ProviderSettings): Promise<void> {
  const r = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!r.ok) throw new Error(`saveSettings failed: ${r.status}`);
}

export async function getCliStatus(refresh?: boolean): Promise<CliStatusMap> {
  const q = refresh ? "?refresh=1" : "";
  const r = await fetch(`${base}/api/cli-status${q}`);
  if (!r.ok) throw new Error(`getCliStatus failed: ${r.status}`);
  const j = await r.json();
  return j.providers as CliStatusMap;
}

export async function getOAuthStatus(): Promise<{ storageReady: boolean; providers: OAuthStatusMap }> {
  const r = await fetch(`${base}/api/oauth/status`);
  if (!r.ok) throw new Error(`getOAuthStatus failed: ${r.status}`);
  const j = await r.json();
  return {
    storageReady: Boolean(j.storageReady),
    providers: j.providers as OAuthStatusMap,
  };
}

export async function disconnectOAuth(provider: OAuthConnectProvider): Promise<void> {
  const r = await fetch(`${base}/api/oauth/disconnect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  if (!r.ok) throw new Error(`disconnectOAuth failed: ${r.status}`);
}

export function getOAuthStartUrl(provider: OAuthConnectProvider, redirectTo: string): string {
  return `${base}/api/oauth/start?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(redirectTo)}`;
}

// --- GitHub Device Code Flow ---

export interface DeviceCodeStart {
  stateId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollStatus = "pending" | "slow_down" | "complete" | "expired" | "denied" | "error";

export interface DevicePollResult {
  status: DevicePollStatus;
  email?: string | null;
  error?: string;
}

export async function startGitHubDeviceFlow(): Promise<DeviceCodeStart> {
  const r = await fetch(`${base}/api/oauth/github-copilot/device-start`, { method: "POST" });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error ?? `device-start failed: ${r.status}`);
  }
  return (await r.json()) as DeviceCodeStart;
}

export async function pollGitHubDevice(stateId: string): Promise<DevicePollResult> {
  const r = await fetch(`${base}/api/oauth/github-copilot/device-poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stateId }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.error ?? `device-poll failed: ${r.status}`);
  }
  return (await r.json()) as DevicePollResult;
}

// --- OpenClaw Import ---

export interface ImportableProfile {
  profileKey: string;
  openclawProvider: string;
  kanbanProvider: "google_antigravity" | "github";
  label: string;
  email: string | null;
  expiresAt: number | null;
  hasRefreshToken: boolean;
  expired: boolean;
}

export interface OpenClawProfilesResponse {
  available: boolean;
  authProfilesPath: string | null;
  profiles: ImportableProfile[];
}

export interface ImportResult {
  ok: boolean;
  imported: string[];
  skipped: string[];
  errors: Array<{ provider: string; error: string }>;
}

export async function getOpenClawProfiles(): Promise<OpenClawProfilesResponse> {
  const r = await fetch(`${base}/api/oauth/openclaw/profiles`);
  if (!r.ok) throw new Error(`getOpenClawProfiles failed: ${r.status}`);
  return (await r.json()) as OpenClawProfilesResponse;
}

export async function importFromOpenClaw(
  providers?: Array<"google_antigravity" | "github">,
  overwrite?: boolean,
): Promise<ImportResult> {
  const r = await fetch(`${base}/api/oauth/openclaw/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providers, overwrite }),
  });
  if (!r.ok) throw new Error(`importFromOpenClaw failed: ${r.status}`);
  return (await r.json()) as ImportResult;
}

export interface HarnessSyncResponse {
  ok: boolean;
  totalSynced: number;
  epicsCount: number;
  internalCount: number;
  lastSyncedAt: number;
  harnessDir: string;
  error?: string;
}

export async function getHarnessStatus(): Promise<HarnessSyncResponse> {
  const r = await fetch(`${base}/api/harness/status`);
  if (!r.ok) throw new Error(`getHarnessStatus failed: ${r.status}`);
  return (await r.json()) as HarnessSyncResponse;
}

export async function syncHarness(): Promise<HarnessSyncResponse> {
  const r = await fetch(`${base}/api/harness/sync`, { method: "POST" });
  if (!r.ok) throw new Error(`syncHarness failed: ${r.status}`);
  return (await r.json()) as HarnessSyncResponse;
}

export interface QueueStatusResponse {
  activeCount: number;
  maxConcurrentTasks: number;
  autoDispatch: boolean;
  plannedCount: number;
  inboxCount: number;
  activeCardIds: string[];
}

export async function getQueueStatus(): Promise<QueueStatusResponse> {
  const r = await fetch(`${base}/api/queue/status`);
  if (!r.ok) throw new Error(`getQueueStatus failed: ${r.status}`);
  return (await r.json()) as QueueStatusResponse;
}

export async function saveQueueConfig(config: { maxConcurrentTasks?: number; autoDispatch?: boolean }): Promise<{ ok: boolean; config: any }> {
  const r = await fetch(`${base}/api/queue/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!r.ok) throw new Error(`saveQueueConfig failed: ${r.status}`);
  return (await r.json()) as { ok: boolean; config: any };
}

export async function moveActiveToBacklog(): Promise<{ ok: boolean; count: number }> {
  const r = await fetch(`${base}/api/queue/move-to-backlog`, { method: "POST" });
  if (!r.ok) throw new Error(`moveInProgressToBacklog failed: ${r.status}`);
  return (await r.json()) as { ok: boolean; count: number };
}

export async function dispatchNextTask(): Promise<{ dispatched: boolean; card?: any; reason?: string }> {
  const r = await fetch(`${base}/api/queue/dispatch-next`, { method: "POST" });
  if (!r.ok) throw new Error(`dispatchNextTask failed: ${r.status}`);
  return (await r.json()) as { dispatched: boolean; card?: any; reason?: string };
}


