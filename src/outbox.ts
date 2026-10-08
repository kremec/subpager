import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isObject, isRic, type Page } from "./radio/decoder";
import { logError } from "./log";

export interface Reception extends Page {
  sourceId: string;
}

interface PendingReception {
  name: string;
  reception: Reception;
}

export class Outbox {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory).filter((name) =>
      name.endsWith(".tmp"),
    )) {
      try {
        this.read(name);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError))
          throw error;
        const retained = join(directory, `${name}.incomplete`);
        renameSync(join(directory, name), retained);
        this.syncDirectory();
        logError(`Incomplete outbox reception retained: ${retained}`);
        continue;
      }
      const descriptor = openSync(join(directory, name), "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(join(directory, name), join(directory, name.slice(0, -4)));
      this.syncDirectory();
    }
  }

  private syncDirectory() {
    // Windows cannot open directories with Node's file-descriptor API.
    if (process.platform === "win32") return;
    const descriptor = openSync(this.directory, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private read(name: string): Reception {
    const value: unknown = JSON.parse(
      readFileSync(join(this.directory, name), "utf8"),
    );
    if (!isObject(value))
      throw new TypeError(`Invalid outbox reception: ${name}`);
    const { sourceId, receivedAt, ric, function: fn, type, content } = value;
    if (
      typeof sourceId !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(sourceId) ||
      typeof receivedAt !== "string" ||
      !Number.isFinite(Date.parse(receivedAt)) ||
      !isRic(ric) ||
      typeof fn !== "number" ||
      !Number.isInteger(fn) ||
      fn < 0 ||
      fn > 3 ||
      (type !== "alpha" && type !== "numeric" && type !== "tone") ||
      typeof content !== "string"
    )
      throw new TypeError(`Invalid outbox reception: ${name}`);
    return { sourceId, receivedAt, ric, function: fn, type, content };
  }

  save(page: Page): Reception {
    const timestamp = Date.parse(page.receivedAt);
    if (!Number.isFinite(timestamp) || timestamp < 0)
      throw new Error("Invalid reception timestamp");
    const reception = { ...page, sourceId: randomUUID() };
    const name = `${String(timestamp).padStart(16, "0")}-${reception.sourceId}.json`;
    const temporary = join(this.directory, `${name}.tmp`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(reception)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, join(this.directory, name));
    this.syncDirectory();
    return reception;
  }

  pending(): PendingReception[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(0, 100)
      .map((name) => ({ name, reception: this.read(name) }));
  }

  acknowledge(pending: PendingReception[]) {
    for (const item of pending)
      rmSync(join(this.directory, item.name), { force: true });
    this.syncDirectory();
  }
}
