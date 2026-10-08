import type { Config } from "./config";
import type { Message, RicUnit, Store } from "./store";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    service: string,
  ) {
    super(`${service} HTTP ${status}`);
  }
}

export interface CloudDevice {
  uid: string;
  approved: boolean;
  expoPushToken?: string | null;
}

export class ConvexClient {
  constructor(
    readonly siteUrl: string,
    private secret: string,
    private transport: (
      url: string,
      options: RequestInit,
    ) => Promise<Response> = fetch,
  ) {}

  static async open(config: NonNullable<Config["convex"]>) {
    const secret = (await Bun.file(config.secretPath).text()).trim();
    if (!secret) throw new Error("Convex receiver secret is empty");
    return new ConvexClient(config.siteUrl, secret);
  }

  private async request(path: string, body?: object) {
    const response = await this.transport(`${this.siteUrl}/receiver/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${this.secret}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, "Convex");
    }
    return response;
  }

  async ingest(messages: Message[], notify = true) {
    await (await this.request("ingest", { messages, notify })).arrayBuffer();
  }

  async setLocation(id: number, location: string | null) {
    await (await this.request("location", { id, location })).arrayBuffer();
  }

  async syncRicUnits(units: RicUnit[]) {
    await (await this.request("ric-units", { units })).arrayBuffer();
  }

  async setMember(uid: string, approved: boolean) {
    await (await this.request("members", { uid, approved })).arrayBuffer();
  }

  async devices(): Promise<CloudDevice[]> {
    return (await this.request("devices")).json();
  }
}

export class ConvexWorker {
  lastError: string | null = null;
  private retryAt = 0;
  private failures = 0;
  private busy = false;

  constructor(
    private store: Store,
    private client: ConvexClient,
  ) {}

  get cursor() {
    return (
      this.store.db
        .query<{ id: number }, [string]>(
          "SELECT message_id AS id FROM cloud_cursors WHERE deployment = ?",
        )
        .get(this.client.siteUrl)?.id ?? 0
    );
  }

  async tick(now = Date.now(), notify = true) {
    if (this.busy || now < this.retryAt) return;
    this.busy = true;
    const startedAt = Date.now();
    try {
      const messages = this.store.cloudMessages(this.cursor);
      if (messages.length) {
        await this.client.ingest(messages, notify);
        this.store.db
          .query(`INSERT INTO cloud_cursors (deployment, message_id) VALUES (?, ?)
          ON CONFLICT(deployment) DO UPDATE SET message_id = excluded.message_id`)
          .run(this.client.siteUrl, messages.at(-1)!.id);
      }
      this.lastError = null;
      this.failures = 0;
      this.retryAt = 0;
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Cloud upload failed";
      this.failures++;
      this.retryAt =
        now +
        Math.max(0, Date.now() - startedAt) +
        (error instanceof HttpError && [400, 401, 403].includes(error.status)
          ? 3_600_000
          : Math.min(300_000, 15_000 * 2 ** Math.min(this.failures - 1, 5)));
    } finally {
      this.busy = false;
    }
  }
}
