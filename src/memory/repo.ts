import { randomUUID } from "node:crypto";
import type { SourceRef, TurnTrace, UserScope } from "@/core/types";
import { localDate, safeTimeZone } from "@/lib/time";
import { transaction, type Db } from "./db";

export type Profile = { id: string; name: string; isDemo: boolean; tz: string };
export type ProfileRow = Profile & { deviceId: string | null };
export type ThreadSummary = { id: string; title: string; createdAt: string; updatedAt: string };
export type StoredSource = SourceRef & { excerpt: string };
export type MessageStatus = "done" | "stopped" | "error";
export type StoredMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  createdAt: string;
  tz: string;
  localDate: string;
  sources: StoredSource[];
  trace?: TurnTrace;
};

export type ClaimInput = {
  entity: string;
  plan?: string | null;
  attribute: string;
  value: string;
  previousValue?: string | null;
  sourceLabel?: string | null;
  observedAt: string;
  effectiveFrom?: string | null;
  confidence: "high" | "low";
};

export type StoredClaim = ClaimInput & {
  id: string;
  messageId: string;
  threadId: string;
  confirmedAt: string | null;
  supersededBy: { id: string; value: string; observedAt: string; effectiveFrom: string | null } | null;
};

type Row = Record<string, unknown>;
const opt = (v: unknown) => (v as string | null) ?? null;
const toClaim = (r: Row): StoredClaim => ({
  id: str(r.id),
  messageId: str(r.message_id),
  threadId: str(r.thread_id),
  entity: str(r.entity),
  plan: opt(r.plan),
  attribute: str(r.attribute),
  value: str(r.value),
  previousValue: opt(r.previous_value),
  sourceLabel: opt(r.source_label),
  observedAt: str(r.observed_at),
  effectiveFrom: opt(r.effective_from),
  confidence: r.confidence as "high" | "low",
  confirmedAt: opt(r.confirmed_at),
  supersededBy: r.s_id ? { id: str(r.s_id), value: str(r.s_value), observedAt: str(r.s_observed), effectiveFrom: opt(r.s_effective) } : null,
});
const str = (v: unknown) => v as string;
const toProfile = (r: Row): ProfileRow => ({
  id: str(r.id),
  name: str(r.display_name),
  isDemo: r.is_demo === 1,
  tz: str(r.tz),
  deviceId: (r.device_id as string | null) ?? null,
});
const toThread = (r: Row): ThreadSummary => ({
  id: str(r.id),
  title: str(r.title),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});

export type Repo = ReturnType<typeof createRepo>;

export function createRepo(db: Db, now: () => Date = () => new Date()) {
  const iso = () => now().toISOString();

  function createDevice(): string {
    const id = randomUUID();
    db.prepare("INSERT INTO devices (id, created_at) VALUES (?, ?)").run(id, iso());
    return id;
  }

  const deviceExists = (id: string) => db.prepare("SELECT 1 FROM devices WHERE id = ?").get(id) !== undefined;

  function createProfile(deviceId: string | null, name: string, opts: { isDemo?: boolean; tz?: string } = {}): Profile {
    const id = randomUUID();
    const tz = safeTimeZone(opts.tz);
    db.prepare("INSERT INTO users (id, device_id, display_name, tz, is_demo, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      deviceId,
      name,
      tz,
      opts.isDemo ? 1 : 0,
      iso(),
    );
    return { id, name, isDemo: !!opts.isDemo, tz };
  }

  function getProfile(id: string): ProfileRow | undefined {
    const r = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return r ? toProfile(r) : undefined;
  }

  function listProfiles(deviceId: string): ProfileRow[] {
    return (
      db
        .prepare("SELECT * FROM users WHERE device_id = ? OR is_demo = 1 ORDER BY is_demo, created_at")
        .all(deviceId) as Row[]
    ).map(toProfile);
  }

  function findDemoProfile(name: string): ProfileRow | undefined {
    const r = db.prepare("SELECT * FROM users WHERE is_demo = 1 AND display_name = ?").get(name) as Row | undefined;
    return r ? toProfile(r) : undefined;
  }

  function renameProfile(deviceId: string, profileId: string, name: string): boolean {
    return (
      db.prepare("UPDATE users SET display_name = ? WHERE id = ? AND device_id = ? AND is_demo = 0").run(name, profileId, deviceId)
        .changes === 1
    );
  }

  function deleteProfile(deviceId: string, profileId: string): boolean {
    return db.prepare("DELETE FROM users WHERE id = ? AND device_id = ? AND is_demo = 0").run(profileId, deviceId).changes === 1;
  }

  function setTimeZone(scope: UserScope, tz: string): void {
    db.prepare("UPDATE users SET tz = ? WHERE id = ? AND tz <> ?").run(safeTimeZone(tz), scope.userId, safeTimeZone(tz));
  }

  function createThread(scope: UserScope, title: string): ThreadSummary {
    const t = { id: randomUUID(), title: title.trim().slice(0, 120) || "New chat", createdAt: iso(), updatedAt: iso() };
    db.prepare("INSERT INTO threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      t.id,
      scope.userId,
      t.title,
      t.createdAt,
      t.updatedAt,
    );
    return t;
  }

  function listThreads(scope: UserScope, limit = 200): ThreadSummary[] {
    return (
      db.prepare("SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?").all(scope.userId, limit) as Row[]
    ).map(toThread);
  }

  function getThread(scope: UserScope, threadId: string): ThreadSummary | undefined {
    const r = db.prepare("SELECT * FROM threads WHERE id = ? AND user_id = ?").get(threadId, scope.userId) as Row | undefined;
    return r ? toThread(r) : undefined;
  }

  function deleteThread(scope: UserScope, threadId: string): boolean {
    return db.prepare("DELETE FROM threads WHERE id = ? AND user_id = ?").run(threadId, scope.userId).changes === 1;
  }

  function addMessage(
    scope: UserScope,
    m: { threadId: string; role: "user" | "assistant"; content: string; status?: MessageStatus; tz: string; createdAt?: string },
  ): { id: string; createdAt: string; localDate: string } {
    const id = randomUUID();
    const createdAt = m.createdAt ?? iso();
    const tz = safeTimeZone(m.tz);
    const day = localDate(new Date(createdAt), tz);
    transaction(db, () => {
      const touched = db
        .prepare("UPDATE threads SET updated_at = ? WHERE id = ? AND user_id = ?")
        .run(createdAt, m.threadId, scope.userId).changes;
      if (touched !== 1) throw new Error("Thread not found for this user");
      db.prepare(
        "INSERT INTO messages (id, user_id, thread_id, role, content, status, created_at, tz, local_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, scope.userId, m.threadId, m.role, m.content, m.status ?? "done", createdAt, tz, day);
    });
    return { id, createdAt, localDate: day };
  }

  function saveSources(scope: UserScope, messageId: string, sources: StoredSource[]): void {
    if (!ownsMessage(scope, messageId)) throw new Error("Message not found for this user");
    const insert = db.prepare(
      "INSERT OR REPLACE INTO message_sources (message_id, user_id, label, url, domain, title, published_at, retrieved_at, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    transaction(db, () => {
      for (const s of sources) {
        insert.run(messageId, scope.userId, s.id, s.url, s.domain, s.title, s.publishedAt ?? null, s.retrievedAt, s.excerpt);
      }
    });
  }

  function saveTrace(scope: UserScope, messageId: string, trace: TurnTrace): void {
    if (!ownsMessage(scope, messageId)) throw new Error("Message not found for this user");
    db.prepare("INSERT OR REPLACE INTO turn_traces (message_id, user_id, trace, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)").run(
      messageId,
      scope.userId,
      JSON.stringify(trace),
      trace.costUsd,
      iso(),
    );
  }

  const ownsMessage = (scope: UserScope, messageId: string) =>
    db.prepare("SELECT 1 FROM messages WHERE id = ? AND user_id = ?").get(messageId, scope.userId) !== undefined;

  function listMessages(scope: UserScope, threadId: string): StoredMessage[] {
    const rows = db
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY created_at, rowid")
      .all(threadId, scope.userId) as Row[];
    if (rows.length === 0) return [];

    const sourceRows = db
      .prepare(
        `SELECT s.* FROM message_sources s JOIN messages m ON m.id = s.message_id
         WHERE m.thread_id = ? AND s.user_id = ? ORDER BY s.message_id, CAST(substr(s.label, 2) AS INTEGER)`,
      )
      .all(threadId, scope.userId) as Row[];
    const sourcesBy = new Map<string, StoredSource[]>();
    for (const r of sourceRows) {
      const list = sourcesBy.get(str(r.message_id)) ?? [];
      list.push({
        id: str(r.label),
        url: str(r.url),
        domain: str(r.domain),
        title: str(r.title),
        retrievedAt: str(r.retrieved_at),
        excerpt: str(r.excerpt),
        ...(r.published_at ? { publishedAt: str(r.published_at) } : {}),
      });
      sourcesBy.set(str(r.message_id), list);
    }

    const traceRows = db
      .prepare(
        "SELECT t.message_id, t.trace FROM turn_traces t JOIN messages m ON m.id = t.message_id WHERE m.thread_id = ? AND t.user_id = ?",
      )
      .all(threadId, scope.userId) as Row[];
    const traceBy = new Map(traceRows.map((r) => [str(r.message_id), JSON.parse(str(r.trace)) as TurnTrace]));

    return rows.map((r) => ({
      id: str(r.id),
      threadId: str(r.thread_id),
      role: r.role as "user" | "assistant",
      content: str(r.content),
      status: r.status as MessageStatus,
      createdAt: str(r.created_at),
      tz: str(r.tz),
      localDate: str(r.local_date),
      sources: sourcesBy.get(str(r.id)) ?? [],
      ...(traceBy.has(str(r.id)) ? { trace: traceBy.get(str(r.id))! } : {}),
    }));
  }

  function recentHistory(scope: UserScope, threadId: string, limit = 20): Array<{ role: "user" | "assistant"; content: string }> {
    const rows = (
      db
        .prepare(
          "SELECT role, content, status FROM messages WHERE thread_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        )
        .all(threadId, scope.userId, limit) as Row[]
    ).reverse();
    const out: Array<{ role: "user" | "assistant"; content: string }> = [];
    rows.forEach((r, i) => {
      if (r.status === "error") return;
      if (r.role === "user") {
        const next = rows[i + 1];
        if (!next || next.status === "error") return;
      }
      out.push({ role: r.role as "user" | "assistant", content: str(r.content) });
    });
    return out;
  }

  function searchMessages(
    scope: UserScope,
    text: string,
    opts: { limit?: number; start?: string; end?: string; excludeThreadId?: string } = {},
  ): Array<{ id: string; threadId: string; content: string; localDate: string }> {
    const query = toFtsQuery(text);
    if (!query) return [];
    return (
      db
        .prepare(
          `SELECT m.id, m.thread_id, m.content, m.local_date FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
           WHERE messages_fts MATCH ? AND m.user_id = ? AND m.status <> 'error'
             AND m.local_date >= ? AND m.local_date <= ? AND m.thread_id <> ?
           ORDER BY bm25(messages_fts) LIMIT ?`,
        )
        .all(query, scope.userId, opts.start ?? "0000-00-00", opts.end ?? "9999-99-99", opts.excludeThreadId ?? "", opts.limit ?? 20) as Row[]
    ).map((r) => ({ id: str(r.id), threadId: str(r.thread_id), content: str(r.content), localDate: str(r.local_date) }));
  }

  function threadsInRange(scope: UserScope, start: string, end: string, excludeThreadId = ""): string[] {
    return (
      db
        .prepare(
          `SELECT thread_id, max(created_at) AS last FROM messages
           WHERE user_id = ? AND local_date >= ? AND local_date <= ? AND thread_id <> ? AND status <> 'error'
           GROUP BY thread_id ORDER BY last DESC`,
        )
        .all(scope.userId, start, end, excludeThreadId) as Row[]
    ).map((r) => str(r.thread_id));
  }

  function nearestActiveDays(scope: UserScope, date: string, excludeThreadId = "") {
    const pick = (op: "<" | ">", order: "DESC" | "ASC") => {
      const r = db
        .prepare(
          `SELECT m.local_date, t.title FROM messages m JOIN threads t ON t.id = m.thread_id
           WHERE m.user_id = ? AND m.local_date ${op} ? AND m.thread_id <> ? AND m.role = 'user'
           ORDER BY m.local_date ${order}, m.created_at ${order} LIMIT 1`,
        )
        .get(scope.userId, date, excludeThreadId) as Row | undefined;
      return r ? { localDate: str(r.local_date), title: str(r.title) } : undefined;
    };
    return { before: pick("<", "DESC"), after: pick(">", "ASC") };
  }

  function threadIndex(scope: UserScope, limit = 8, excludeThreadId = "") {
    return (
      db
        .prepare(
          `SELECT t.id, t.title, min(m.local_date) AS first_date, max(m.local_date) AS last_date,
                  sum(CASE WHEN m.role = 'user' THEN 1 ELSE 0 END) AS questions
           FROM threads t JOIN messages m ON m.thread_id = t.id
           WHERE t.user_id = ? AND t.id <> ?
           GROUP BY t.id ORDER BY max(m.created_at) DESC LIMIT ?`,
        )
        .all(scope.userId, excludeThreadId, limit) as Row[]
    ).map((r) => ({
      threadId: str(r.id),
      title: str(r.title),
      firstDate: str(r.first_date),
      lastDate: str(r.last_date),
      questions: Number(r.questions),
    }));
  }

  function clearThreads(scope: UserScope): void {
    db.prepare("DELETE FROM threads WHERE user_id = ?").run(scope.userId);
  }

  function messageIds(scope: UserScope, threadId: string, role: "user" | "assistant"): string[] {
    return (
      db.prepare("SELECT id FROM messages WHERE thread_id = ? AND user_id = ? AND role = ? ORDER BY created_at").all(threadId, scope.userId, role) as Row[]
    ).map((x) => str(x.id));
  }

  function renameThread(scope: UserScope, threadId: string, title: string): boolean {
    return db.prepare("UPDATE threads SET title = ? WHERE id = ? AND user_id = ?").run(title.trim().slice(0, 120), threadId, scope.userId).changes === 1;
  }

  function saveClaims(scope: UserScope, at: { messageId: string; threadId: string }, claims: ClaimInput[]): string[] {
    if (!ownsMessage(scope, at.messageId)) throw new Error("Message not found for this user");
    const insert = db.prepare(
      `INSERT INTO claims (id, user_id, thread_id, message_id, entity, plan, attribute, value, previous_value, source_label,
                           observed_at, effective_from, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return transaction(db, () =>
      claims.map((c) => {
        const id = randomUUID();
        insert.run(
          id,
          scope.userId,
          at.threadId,
          at.messageId,
          c.entity,
          c.plan ?? null,
          c.attribute,
          c.value,
          c.previousValue ?? null,
          c.sourceLabel ?? null,
          c.observedAt,
          c.effectiveFrom ?? null,
          c.confidence,
          iso(),
        );
        return id;
      }),
    );
  }

  function supersede(scope: UserScope, oldId: string, newId: string): boolean {
    return (
      db
        .prepare(
          `UPDATE claims SET superseded_by = ?
           WHERE id = ? AND user_id = ? AND superseded_by IS NULL AND id <> ?
             AND EXISTS (SELECT 1 FROM claims WHERE id = ? AND user_id = ?)`,
        )
        .run(newId, oldId, scope.userId, newId, newId, scope.userId).changes === 1
    );
  }

  function confirmClaim(scope: UserScope, id: string, onDate: string): boolean {
    return db.prepare("UPDATE claims SET confirmed_at = ? WHERE id = ? AND user_id = ?").run(onDate, id, scope.userId).changes === 1;
  }

  function claimsForMessages(scope: UserScope, messageIds: string[]): StoredClaim[] {
    if (messageIds.length === 0) return [];
    const marks = messageIds.map(() => "?").join(",");
    return (
      db
        .prepare(
          `SELECT c.*, s.value AS s_value, s.observed_at AS s_observed, s.effective_from AS s_effective, s.id AS s_id
           FROM claims c LEFT JOIN claims s ON s.id = c.superseded_by AND s.user_id = c.user_id
           WHERE c.user_id = ? AND c.message_id IN (${marks})
           ORDER BY c.created_at, c.rowid`,
        )
        .all(scope.userId, ...messageIds) as Row[]
    ).map(toClaim);
  }

  function claimsForThreads(scope: UserScope, threadIds: string[]): StoredClaim[] {
    if (threadIds.length === 0) return [];
    const marks = threadIds.map(() => "?").join(",");
    return (
      db
        .prepare(
          `SELECT c.*, s.value AS s_value, s.observed_at AS s_observed, s.effective_from AS s_effective, s.id AS s_id
           FROM claims c LEFT JOIN claims s ON s.id = c.superseded_by AND s.user_id = c.user_id
           WHERE c.user_id = ? AND c.thread_id IN (${marks})
           ORDER BY c.created_at, c.rowid`,
        )
        .all(scope.userId, ...threadIds) as Row[]
    ).map(toClaim);
  }

  function saveEntities(scope: UserScope, messageId: string, entities: Array<{ name: string; domain: string | null }>): void {
    if (!ownsMessage(scope, messageId)) throw new Error("Message not found for this user");
    const insert = db.prepare("INSERT OR REPLACE INTO entities (message_id, user_id, name, domain) VALUES (?, ?, ?, ?)");
    transaction(db, () => {
      for (const e of entities) insert.run(messageId, scope.userId, e.name, e.domain);
    });
  }

  function entitiesForMessages(scope: UserScope, messageIds: string[]): Array<{ messageId: string; name: string; domain: string | null }> {
    if (messageIds.length === 0) return [];
    const marks = messageIds.map(() => "?").join(",");
    return (
      db.prepare(`SELECT * FROM entities WHERE user_id = ? AND message_id IN (${marks}) ORDER BY rowid`).all(scope.userId, ...messageIds) as Row[]
    ).map((r) => ({ messageId: str(r.message_id), name: str(r.name), domain: (r.domain as string | null) ?? null }));
  }

  function logSpend(kind: string, model: string, costUsd: number): void {
    db.prepare("INSERT INTO spend_log (kind, model, cost_usd, created_at) VALUES (?, ?, ?, ?)").run(kind, model, costUsd, iso());
  }

  function totalSpend(): number {
    const r = db
      .prepare("SELECT (SELECT coalesce(sum(cost_usd), 0) FROM turn_traces) + (SELECT coalesce(sum(cost_usd), 0) FROM spend_log) AS total")
      .get() as { total: number };
    return r.total;
  }

  return {
    createDevice,
    deviceExists,
    createProfile,
    getProfile,
    findDemoProfile,
    listProfiles,
    renameProfile,
    deleteProfile,
    setTimeZone,
    createThread,
    listThreads,
    getThread,
    deleteThread,
    addMessage,
    saveSources,
    saveTrace,
    listMessages,
    recentHistory,
    searchMessages,
    threadsInRange,
    nearestActiveDays,
    threadIndex,
    clearThreads,
    renameThread,
    messageIds,
    saveClaims,
    supersede,
    confirmClaim,
    claimsForMessages,
    claimsForThreads,
    saveEntities,
    entitiesForMessages,
    logSpend,
    totalSpend,
  };
}

export function toFtsQuery(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, 12).map((w) => `"${w}"`).join(" OR ");
}
