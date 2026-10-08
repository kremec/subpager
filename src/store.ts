import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeContent, type Page } from "./radio/decoder";

export interface Message extends Page {
  id: number;
  duplicateOf: number | null;
  location?: string | null;
}

export interface RicUnit {
  ric: number;
  unitName: string;
}

export interface Device {
  id: string;
  name: string;
  expoPushToken: string | null;
}

export interface PushJob {
  id: number;
  deviceId: string;
  messageId: number;
  receivedAt: string;
  ric: number;
  content: string;
  expoPushToken: string;
  attempts: number;
  ticketId: string | null;
  expiresAt: number;
  deviceUpdateTime?: string | null;
}

export interface ListOptions {
  before?: number;
  limit: number;
  ric?: number;
  q?: string;
  includeRepeats?: boolean;
}

const messageColumns = `id, received_at AS receivedAt, ric, function, type, content,
  duplicate_of AS duplicateOf`;
const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export class Store {
  readonly db: Database;
  constructor(
    path: string,
    private cloudOnly = false,
    private extractLocations = false,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT NOT NULL,
        ric INTEGER NOT NULL, function INTEGER NOT NULL, type TEXT NOT NULL,
        content TEXT NOT NULL, duplicate_of INTEGER REFERENCES messages(id),
        wav BLOB
      );
      CREATE INDEX IF NOT EXISTS message_dedupe ON messages(ric, function, type, received_at);
      CREATE TABLE IF NOT EXISTS ric_units (
        ric INTEGER PRIMARY KEY CHECK (ric BETWEEN 0 AND 2097151),
        unit_name TEXT NOT NULL CHECK (length(trim(unit_name)) > 0)
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        expo_push_token TEXT,
        rejected_push_token TEXT, rejected_update_time TEXT
      );
      CREATE TABLE IF NOT EXISTS push_jobs (
        id INTEGER PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id),
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        ticket_id TEXT, ticket_at INTEGER, sent_token TEXT, sent_device_update_time TEXT, error TEXT,
        UNIQUE(device_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS push_due ON push_jobs(state, next_attempt);
      CREATE TABLE IF NOT EXISTS cloud_cursors (
        deployment TEXT PRIMARY KEY, message_id INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS location_jobs (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id),
        state TEXT NOT NULL DEFAULT 'pending', location TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        error TEXT
      );
    `);
    if (
      this.db
        .query<{ name: string }, []>("PRAGMA table_info(devices)")
        .all()
        .some(({ name }) => name === "rics")
    )
      this.db.exec("ALTER TABLE devices DROP COLUMN rics");
    for (const [table, columns] of [
      ["devices", ["rejected_push_token TEXT", "rejected_update_time TEXT"]],
      ["push_jobs", ["ticket_at INTEGER", "sent_device_update_time TEXT"]],
    ] as const) {
      const existing = this.db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all();
      for (const column of columns)
        if (!existing.some(({ name }) => name === column.split(" ")[0]))
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    }
  }

  addDevice(name: string) {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.db
      .query("INSERT INTO devices (id, name, token_hash) VALUES (?, ?, ?)")
      .run(id, name, tokenHash(token));
    return { id, token };
  }

  authenticate(token: string): Device | null {
    return this.db
      .query<Device, [string]>(
        `SELECT id, name, expo_push_token AS expoPushToken FROM devices WHERE token_hash = ?`,
      )
      .get(tokenHash(token));
  }

  revokeDevice(id: string) {
    return this.db.query("DELETE FROM devices WHERE id = ?").run(id).changes;
  }

  registerDevice(id: string, token: string) {
    this.db.transaction(() => {
      const changed = this.db
        .query(`
          UPDATE devices SET expo_push_token = ?
          WHERE id = ? AND expo_push_token IS NOT ?
        `)
        .run(token, id, token).changes;
      // Pending work reflects the subscription when a call was received. Do not
      // replay old calls when a phone registers or changes its token.
      if (changed)
        this.db
          .query(
            "DELETE FROM push_jobs WHERE device_id = ? AND state = 'pending'",
          )
          .run(id);
    })();
  }

  disablePush(id: string, token?: string, _updateTime?: string | null) {
    this.db.transaction(() => {
      const changed = this.db
        .query(
          "UPDATE devices SET expo_push_token = NULL WHERE id = ? AND (? IS NULL OR expo_push_token = ?)",
        )
        .run(id, token ?? null, token ?? null).changes;
      if (changed)
        this.db
          .query(
            "DELETE FROM push_jobs WHERE device_id = ? AND state = 'pending'",
          )
          .run(id);
    })();
  }

  cloudMessages(afterId: number): Message[] {
    return this.db
      .query<Message, [number]>(`
        SELECT ${messageColumns} FROM messages WHERE id > ? ORDER BY id LIMIT 100
      `)
      .all(afterId)
      .map((message) => {
        const result = this.db
          .query<{ location: string | null }, [number]>(
            "SELECT location FROM location_jobs WHERE message_id = ? AND state IN ('ready', 'uploaded')",
          )
          .get(message.id);
        return result ? { ...message, location: result.location } : message;
      });
  }

  ricUnits(): RicUnit[] {
    return this.db
      .query<RicUnit, []>(
        "SELECT ric, unit_name AS unitName FROM ric_units ORDER BY ric",
      )
      .all();
  }

  save(page: Page, dedupeSeconds: number, pushMaxAgeSeconds: number): Message {
    const timestamp = Date.parse(page.receivedAt);
    if (!Number.isFinite(timestamp))
      throw new Error("Invalid receive timestamp");
    const content = normalizeContent(page.content);
    return this.db.transaction(() => {
      const match =
        dedupeSeconds > 0
          ? this.db
              .query<
                { id: number },
                [number, number, string, string, string, string]
              >(`
                SELECT id FROM messages WHERE ric = ? AND function = ? AND type = ? AND content = ?
                AND duplicate_of IS NULL AND received_at >= ? AND received_at <= ? ORDER BY id DESC LIMIT 1
              `)
              .get(
                page.ric,
                page.function,
                page.type,
                content,
                new Date(timestamp - dedupeSeconds * 1000).toISOString(),
                page.receivedAt,
              )
          : null;
      const message = this.db
        .query<Message, (string | number | null)[]>(`
          INSERT INTO messages
          (received_at, ric, function, type, content, duplicate_of)
          VALUES (?, ?, ?, ?, ?, ?) RETURNING ${messageColumns}
        `)
        .get(
          page.receivedAt,
          page.ric,
          page.function,
          page.type,
          content,
          match?.id ?? null,
        )!;
      if (!match && !this.cloudOnly)
        this.db
          .query(`
            INSERT INTO push_jobs (device_id, message_id, next_attempt, expires_at)
            SELECT id, ?, ?, ? FROM devices
            WHERE expo_push_token IS NOT NULL
          `)
          .run(message.id, Date.now(), timestamp + pushMaxAgeSeconds * 1000);
      if (
        this.extractLocations &&
        message.content.trim() &&
        message.type !== "tone"
      )
        this.db
          .query(
            "INSERT INTO location_jobs (message_id, next_attempt) VALUES (?, ?)",
          )
          .run(message.id, Date.now());
      return message;
    })();
  }

  saveRecording(wav: Uint8Array, pages: Page[]): number[] {
    return this.db.transaction(() => {
      const matched = new Set<number>();
      const find = this.db.query<
        { id: number },
        [string, number, number, string, string]
      >(
        `SELECT id FROM messages WHERE received_at = ? AND ric = ? AND function = ? AND type = ? AND content = ? ORDER BY id`,
      );
      const attach = this.db.query(
        "UPDATE messages SET wav = ? WHERE id = ? AND wav IS NULL",
      );
      for (const page of pages) {
        for (const message of find.all(
          page.receivedAt,
          page.ric,
          page.function,
          page.type,
          normalizeContent(page.content),
        )) {
          matched.add(message.id);
          attach.run(wav, message.id);
        }
      }
      return [...matched];
    })();
  }

  getRecording(messageId: number): { wav: Uint8Array<ArrayBuffer> } | null {
    return this.db
      .query<{ wav: Uint8Array<ArrayBuffer> }, [number]>(
        "SELECT wav FROM messages WHERE id = ? AND wav IS NOT NULL",
      )
      .get(messageId);
  }

  list(options: ListOptions) {
    const messages = this.db
      .query<
        Message,
        [number, number, number | null, number | null, string, number]
      >(`
      SELECT ${messageColumns} FROM messages WHERE
      (? = 1 OR duplicate_of IS NULL) AND id < ? AND (? IS NULL OR ric = ?)
      AND instr(lower(content), lower(?)) > 0 ORDER BY id DESC LIMIT ?
    `)
      .all(
        options.includeRepeats ? 1 : 0,
        options.before ?? Number.MAX_SAFE_INTEGER,
        options.ric ?? null,
        options.ric ?? null,
        options.q ?? "",
        options.limit + 1,
      );
    const hasMore = messages.length > options.limit;
    if (hasMore) messages.pop();
    return { messages, nextCursor: hasMore ? messages.at(-1)!.id : null };
  }

  getMessage(id: number) {
    return this.db
      .query<Message, [number]>(
        `SELECT ${messageColumns} FROM messages WHERE id = ?`,
      )
      .get(id);
  }

  pendingCount() {
    return this.db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM push_jobs WHERE state = 'pending'",
      )
      .get()!.count;
  }

  isSubscribed(job: PushJob) {
    return (
      this.db
        .query<{ id: string }, [string, string]>(`
        SELECT id FROM devices WHERE id = ? AND expo_push_token = ?
      `)
        .get(job.deviceId, job.expoPushToken) !== null
    );
  }

  dueJobs(state: "pending" | "receipt", now: number): PushJob[] {
    if (state === "pending")
      this.db
        .query(
          "UPDATE push_jobs SET state = 'expired' WHERE state = 'pending' AND expires_at <= ?",
        )
        .run(now);
    if (state === "receipt")
      this.db
        .query(`UPDATE push_jobs SET state = 'expired' WHERE state = 'receipt'
          AND coalesce(ticket_at, (SELECT round(unixepoch(received_at, 'subsec') * 1000)
            FROM messages WHERE id = push_jobs.message_id)) + 86400000 <= ?`)
        .run(now);
    this.db.exec(`DELETE FROM push_jobs WHERE id IN
      (SELECT id FROM push_jobs WHERE state IN ('sent', 'failed', 'expired') ORDER BY id DESC LIMIT -1 OFFSET 1000)`);
    return this.db
      .query<PushJob, [string, number]>(`
      SELECT j.id, j.device_id AS deviceId, j.message_id AS messageId, j.attempts,
        j.ticket_id AS ticketId, j.expires_at AS expiresAt,
        m.received_at AS receivedAt, m.ric, m.content,
        coalesce(j.sent_token, d.expo_push_token) AS expoPushToken,
        j.sent_device_update_time AS deviceUpdateTime
      FROM push_jobs j JOIN messages m ON m.id = j.message_id JOIN devices d ON d.id = j.device_id
      WHERE j.state = ? AND j.next_attempt <= ? AND (j.sent_token IS NOT NULL OR d.expo_push_token IS NOT NULL) ORDER BY j.id LIMIT 100
    `)
      .all(state, now);
  }

  setJob(
    job: PushJob,
    state: string,
    nextAttempt: number,
    error: string | null,
    ticketId: string | null = null,
    sentToken: string | null = null,
    ticketAt: number | null = null,
  ) {
    this.db
      .query(`
        UPDATE push_jobs SET state = ?, next_attempt = ?, error = ?,
          ticket_id = coalesce(?, ticket_id), sent_token = coalesce(?, sent_token),
          ticket_at = coalesce(?, ticket_at),
          sent_device_update_time = coalesce(?, sent_device_update_time),
          attempts = attempts + 1
        WHERE id = ? AND device_id = ? AND message_id = ?
      `)
      .run(
        state,
        nextAttempt,
        error,
        ticketId,
        sentToken,
        ticketAt,
        sentToken === null ? null : (job.deviceUpdateTime ?? null),
        job.id,
        job.deviceId,
        job.messageId,
      );
  }

  backup(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db.query("VACUUM INTO ?").run(path);
  }

  close() {
    this.db.close();
  }
}
