import type { Config } from "./config";
import type { Outbox, Reception } from "./outbox";

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`Convex HTTP ${status}`);
  }
}

export interface RicUnit {
  ric: number;
  unitName: string;
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

  static async open(config: Config["convex"]) {
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
      await response.body?.cancel().catch(() => {});
      throw new HttpError(response.status);
    }
    return response;
  }

  async ingest(messages: Reception[]) {
    await (
      await this.request("ingest", { messages, notify: true })
    ).arrayBuffer();
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
  private running: Promise<void> | undefined;

  constructor(
    private outbox: Outbox,
    private client: ConvexClient,
  ) {}

  tick(now = Date.now()): Promise<void> {
    if (this.running) return this.running;
    if (now < this.retryAt) return Promise.resolve();
    this.running = this.upload(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async upload(now: number) {
    const startedAt = Date.now();
    try {
      const pending = this.outbox.pending();
      if (!pending.length) return;
      await this.client.ingest(pending.map((item) => item.reception));
      this.outbox.acknowledge(pending);
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
    }
  }
}
