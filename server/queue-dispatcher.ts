import type { DatabaseSync } from "node:sqlite";

export interface QueueConfig {
  maxConcurrentTasks: number;
  autoDispatch: boolean;
}

export interface QueueStatus {
  activeCount: number;
  maxConcurrentTasks: number;
  autoDispatch: boolean;
  plannedCount: number;
  inboxCount: number;
  activeCardIds: string[];
}

let queueConfig: QueueConfig = {
  maxConcurrentTasks: 2,
  autoDispatch: false, // Start paused so user controls gradual start
};

// Callback to start card run in server/index.ts
let executeRunCallback: ((cardId: string) => Promise<any>) | null = null;

export function registerRunExecutor(executor: (cardId: string) => Promise<any>): void {
  executeRunCallback = executor;
}

export function getQueueConfig(db: DatabaseSync): QueueConfig {
  try {
    const row = db.prepare("SELECT data FROM settings WHERE id = 'queue'").get() as { data: string } | undefined;
    if (row) {
      queueConfig = { ...queueConfig, ...JSON.parse(row.data) };
    }
  } catch (e) {
    /* use default */
  }
  return queueConfig;
}

export function saveQueueConfig(db: DatabaseSync, config: Partial<QueueConfig>): QueueConfig {
  queueConfig = {
    ...queueConfig,
    ...config,
    maxConcurrentTasks: Math.max(1, Math.min(10, Number(config.maxConcurrentTasks ?? queueConfig.maxConcurrentTasks))),
  };

  try {
    const existing = db.prepare("SELECT id FROM settings WHERE id = 'queue'").get();
    if (existing) {
      db.prepare("UPDATE settings SET data = ?, updated_at = ? WHERE id = 'queue'").run(
        JSON.stringify(queueConfig),
        Date.now(),
      );
    } else {
      db.prepare("INSERT INTO settings (id, data, updated_at) VALUES ('queue', ?, ?)").run(
        JSON.stringify(queueConfig),
        Date.now(),
      );
    }
  } catch (e) {
    console.error("[Queue Dispatcher] Failed to persist queue config:", e);
  }

  return queueConfig;
}

// WIP-limit gating must treat "In Progress" and "Review/Test" as one active pool —
// a card still consumes an agent slot while it's being reviewed. Counting only
// "In Progress" let cards race through into Review/Test uncapped (see AUT/DEV
// harness-sync flood incident: 22 epics stuck in Review/Test with zero real runs).
const ACTIVE_STATUSES = "('In Progress', 'Review/Test')";

export function moveActiveToBacklog(db: DatabaseSync): { count: number } {
  const activeRows = db.prepare(`SELECT id, title FROM cards WHERE status IN ${ACTIVE_STATUSES}`).all() as Array<{ id: string; title: string }>;
  const now = Date.now();

  const updateStmt = db.prepare("UPDATE cards SET status = 'Planned', updated_at = ? WHERE id = ?");
  const logStmt = db.prepare("INSERT INTO card_logs (card_id, created_at, kind, message) VALUES (?, ?, 'system', 'Moved back to Planned (WIP limit reset)')");

  for (const row of activeRows) {
    updateStmt.run(now, row.id);
    logStmt.run(row.id, now);
  }

  console.log(`[Queue Dispatcher] Moved ${activeRows.length} tickets from In Progress/Review-Test back to Planned`);
  return { count: activeRows.length };
}

export function getQueueStatus(db: DatabaseSync): QueueStatus {
  const config = getQueueConfig(db);
  const activeRows = db.prepare(`SELECT id FROM cards WHERE status IN ${ACTIVE_STATUSES}`).all() as Array<{ id: string }>;
  const plannedRow = db.prepare("SELECT count(*) as c FROM cards WHERE status = 'Planned'").get() as { c: number };
  const inboxRow = db.prepare("SELECT count(*) as c FROM cards WHERE status = 'Inbox'").get() as { c: number };

  return {
    activeCount: activeRows.length,
    maxConcurrentTasks: config.maxConcurrentTasks,
    autoDispatch: config.autoDispatch,
    plannedCount: plannedRow?.c ?? 0,
    inboxCount: inboxRow?.c ?? 0,
    activeCardIds: activeRows.map((r) => r.id),
  };
}

export async function dispatchNextTask(db: DatabaseSync): Promise<{ dispatched: boolean; card?: any; reason?: string }> {
  const config = getQueueConfig(db);
  const activeRows = db.prepare(`SELECT id FROM cards WHERE status IN ${ACTIVE_STATUSES}`).all() as Array<{ id: string }>;

  if (activeRows.length >= config.maxConcurrentTasks) {
    return {
      dispatched: false,
      reason: `WIP limit reached (${activeRows.length}/${config.maxConcurrentTasks} active)`,
    };
  }

  // Find next actionable card from Planned
  const nextCard = db.prepare(`
    SELECT * FROM cards
    WHERE status = 'Planned'
    ORDER BY priority DESC, updated_at ASC
    LIMIT 1
  `).get() as any;

  if (!nextCard) {
    return { dispatched: false, reason: "No pending cards in Planned" };
  }

  if (executeRunCallback) {
    try {
      console.log(`[Queue Dispatcher] Gradually dispatching next task: ${nextCard.id} (${nextCard.title})`);
      await executeRunCallback(nextCard.id);
      return { dispatched: true, card: nextCard };
    } catch (e: any) {
      console.error(`[Queue Dispatcher] Failed to dispatch task ${nextCard.id}:`, e);
      return { dispatched: false, reason: e.message };
    }
  }

  return { dispatched: false, reason: "No execution callback registered" };
}

export function startQueueWorker(db: DatabaseSync): void {
  // Initialize queue config
  getQueueConfig(db);

  // Background gradual dispatcher loop every 4 seconds
  setInterval(async () => {
    try {
      const config = getQueueConfig(db);
      if (!config.autoDispatch) return;

      const activeRows = db.prepare(`SELECT count(*) as c FROM cards WHERE status IN ${ACTIVE_STATUSES}`).get() as { c: number };
      if ((activeRows?.c ?? 0) < config.maxConcurrentTasks) {
        await dispatchNextTask(db);
      }
    } catch (e) {
      console.error("[Queue Dispatcher] Worker loop error:", e);
    }
  }, 4_000);
}
