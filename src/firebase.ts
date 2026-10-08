import { createSign } from "node:crypto";
import type { Config } from "./config";
import { isObject, isRic } from "./radio/decoder";
import type { Message, PushJob, RicUnit, Store } from "./store";

type HttpRequest = (url: string, options: RequestInit) => Promise<Response>;
interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}
type Value =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { stringValue: string };
interface Document {
  name: string;
  fields?: Record<string, Value>;
  updateTime?: string;
}
type Write =
  | { update: { name: string; fields: Record<string, Value> } }
  | { delete: string };

function encode(value: string | number | boolean | null): Value {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  return { stringValue: value };
}

function decode(value: Value): string | number | boolean | null {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("booleanValue" in value) return value.booleanValue;
  return null;
}

function fields(document: Document): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(document.fields ?? {}).map(([key, value]) => [
      key,
      decode(value),
    ]),
  );
}

function subscription(data: Record<string, unknown> | null) {
  if (
    !data ||
    typeof data.expoPushToken !== "string" ||
    data.expoPushToken.length > 256 ||
    !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(data.expoPushToken)
  )
    return null;
  return { token: data.expoPushToken };
}

export class FirebaseClient {
  private token: { value: string; expiresAt: number } | undefined;
  private tokenRequest: Promise<string> | undefined;
  private readonly documentRequests = new Map<
    string,
    Promise<Document | null>
  >();
  private readonly root: string;
  constructor(
    readonly projectId: string,
    private account: ServiceAccount,
    private request: HttpRequest = fetch,
  ) {
    if (account.project_id !== projectId)
      throw new Error("Firebase service account belongs to another project");
    this.root = `projects/${projectId}/databases/(default)/documents`;
  }

  static async open(config: NonNullable<Config["firebase"]>) {
    const account: unknown = await Bun.file(config.serviceAccountPath).json();
    if (
      !isObject(account) ||
      typeof account.project_id !== "string" ||
      typeof account.client_email !== "string" ||
      typeof account.private_key !== "string"
    )
      throw new Error("Invalid Firebase service account file");
    return new FirebaseClient(config.projectId, {
      project_id: account.project_id,
      client_email: account.client_email,
      private_key: account.private_key,
    });
  }

  private accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now())
      return Promise.resolve(this.token.value);
    this.tokenRequest ??= this.refreshAccessToken().finally(() => {
      this.tokenRequest = undefined;
    });
    return this.tokenRequest;
  }

  private async refreshAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.account.client_email,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    ).toString("base64url");
    const unsigned = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(this.account.private_key, "base64url");
    const response = await this.request("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Firebase OAuth HTTP ${response.status}`);
    }
    const result: unknown = await response.json();
    if (
      !isObject(result) ||
      typeof result.access_token !== "string" ||
      typeof result.expires_in !== "number" ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 60
    )
      throw new Error("Invalid Firebase OAuth response");
    this.token = {
      value: result.access_token,
      expiresAt: Date.now() + (result.expires_in - 60) * 1000,
    };
    return this.token.value;
  }

  private async call(path: string, method = "GET", body?: object) {
    const response = await this.request(
      `https://firestore.googleapis.com/v1/${this.root}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok && response.status !== 404) {
      if (response.status === 401) this.token = undefined;
      const result: unknown = await response.json().catch(() => null);
      const failure =
        isObject(result) && isObject(result.error) ? result.error : null;
      const reason =
        failure && typeof failure.message === "string"
          ? `: ${failure.message}`
          : "";
      throw new Error(
        `Firestore HTTP ${response.status} (${method} ${path.split("?")[0]})${reason}`,
      );
    }
    return response;
  }

  async get(
    collection: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const document = await this.document(collection, id);
    return document ? fields(document) : null;
  }

  document(collection: string, id: string): Promise<Document | null> {
    const path = `/${collection}/${encodeURIComponent(id)}`;
    const existing = this.documentRequests.get(path);
    if (existing) return existing;
    const pending = this.readDocument(path).finally(() => {
      this.documentRequests.delete(path);
    });
    this.documentRequests.set(path, pending);
    return pending;
  }

  private async readDocument(path: string): Promise<Document | null> {
    const response = await this.call(path);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    return (await response.json()) as Document;
  }

  async clearPushToken(uid: string, updateTime: string) {
    const query = new URLSearchParams({
      "updateMask.fieldPaths": "expoPushToken",
      "currentDocument.updateTime": updateTime,
    });
    const response = await this.call(
      `/devices/${encodeURIComponent(uid)}?${query}`,
      "PATCH",
      {
        fields: { expoPushToken: encode(null) },
      },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Firestore HTTP ${response.status}`);
  }

  async latestMessageId(): Promise<number> {
    const response = await this.call(":runQuery", "POST", {
      structuredQuery: {
        from: [{ collectionId: "messages" }],
        select: { fields: [{ fieldPath: "id" }] },
        orderBy: [{ field: { fieldPath: "id" }, direction: "DESCENDING" }],
        limit: 1,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Firestore HTTP ${response.status}`);
    }
    const result: unknown = await response.json();
    if (!Array.isArray(result) || !result.every(isObject))
      throw new Error("Invalid Firestore message cursor response");
    const documents = result.filter((row) => "document" in row);
    if (
      !documents.length &&
      result.every((row) => typeof row.readTime === "string")
    )
      return 0;
    const document = documents[0]?.document;
    const data =
      isObject(document) && isObject(document.fields)
        ? document.fields.id
        : null;
    const id =
      isObject(data) &&
      typeof data.integerValue === "string" &&
      /^[1-9]\d*$/.test(data.integerValue)
        ? Number(data.integerValue)
        : NaN;
    if (documents.length !== 1 || !Number.isSafeInteger(id) || id <= 0)
      throw new Error("Invalid Firestore message cursor response");
    return id;
  }

  async list(collection: string) {
    const documents: { id: string; data: Record<string, unknown> }[] = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({ pageSize: "1000" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await this.call(`/${collection}?${query}`);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Firestore HTTP ${response.status}`);
      }
      const page = (await response.json()) as {
        documents?: Document[];
        nextPageToken?: string;
      };
      for (const document of page.documents ?? [])
        documents.push({
          id: document.name.split("/").at(-1)!,
          data: fields(document),
        });
      pageToken = page.nextPageToken ?? "";
    } while (pageToken);
    return documents;
  }

  async set(
    collection: string,
    id: string,
    data: Record<string, string | number | boolean | null>,
  ) {
    const response = await this.call(
      `/${collection}/${encodeURIComponent(id)}`,
      "PATCH",
      {
        fields: Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, encode(value)]),
        ),
      },
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Firestore HTTP ${response.status}`);
  }

  async upload(messages: Message[]) {
    await this.commit(
      messages.map((message) => ({
        update: {
          name: `${this.root}/messages/${message.id}`,
          fields: Object.fromEntries(
            Object.entries(message).map(([key, value]) => [key, encode(value)]),
          ),
        },
      })),
    );
  }

  private async commit(writes: Write[]) {
    for (let offset = 0; offset < writes.length; offset += 500) {
      const response = await this.call(":commit", "POST", {
        writes: writes.slice(offset, offset + 500),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Firestore HTTP ${response.status}`);
    }
  }

  async syncRicUnits(units: RicUnit[]) {
    const local = new Map<string, RicUnit>();
    for (const unit of units) {
      if (
        !isRic(unit.ric) ||
        typeof unit.unitName !== "string" ||
        !unit.unitName.trim() ||
        local.has(String(unit.ric))
      )
        throw new Error("Invalid or duplicate RIC unit mapping");
      local.set(String(unit.ric), unit);
    }
    const remote = await this.list("ricUnits");
    const previous = new Map(remote.map((unit) => [unit.id, unit.data]));
    const writes: Write[] = [];
    let updated = 0;
    let deleted = 0;
    for (const [id, unit] of local) {
      const existing = previous.get(id);
      if (existing?.ric === unit.ric && existing.unitName === unit.unitName)
        continue;
      writes.push({
        update: {
          name: `${this.root}/ricUnits/${id}`,
          fields: { ric: encode(unit.ric), unitName: encode(unit.unitName) },
        },
      });
      updated++;
    }
    for (const unit of remote) {
      if (local.has(unit.id)) continue;
      writes.push({ delete: `${this.root}/ricUnits/${unit.id}` });
      deleted++;
    }
    await this.commit(writes);
    return { updated, deleted };
  }

  async devices() {
    const [members, devices] = await Promise.all([
      this.list("members"),
      this.list("devices"),
    ]);
    const approved = new Map(
      members
        .filter((member) => member.data.approved === true)
        .map((member) => [member.id, member.data]),
    );
    return devices.flatMap((device) => {
      const data = subscription(device.data);
      const member = approved.get(device.id);
      return member && data
        ? [
            {
              uid: device.id,
              name:
                typeof member.label === "string"
                  ? member.label.trim() || device.id
                  : device.id,
              ...data,
            },
          ]
        : [];
    });
  }

  async authorize(job: PushJob) {
    if (!job.deviceId.startsWith("firebase:")) return false;
    const uid = job.deviceId.slice("firebase:".length);
    const [member, device] = await Promise.all([
      this.get("members", uid),
      this.document("devices", uid),
    ]);
    const data = subscription(device ? fields(device) : null);
    const authorized =
      member?.approved === true &&
      data !== null &&
      data.token === job.expoPushToken;
    if (authorized) {
      if (typeof device?.updateTime !== "string" || !device.updateTime)
        throw new Error("Missing Firestore device update time");
      job.deviceUpdateTime = device.updateTime;
    }
    return authorized;
  }
}

export class FirebaseWorker {
  lastError: string | null = null;
  private lastMessageId: number | undefined;
  private nextAttempt = 0;
  private retryDelay = 15000;
  private nextDevices = 0;
  private running: Promise<void> | undefined;
  constructor(
    private store: Store,
    readonly client: FirebaseClient,
  ) {}

  async authorize(job: PushJob) {
    if (this.lastMessageId === undefined || job.messageId > this.lastMessageId)
      throw new Error("Message upload is pending");
    return this.client.authorize(job);
  }

  tick(now = Date.now()) {
    if (this.running) return this.running;
    if (now < this.nextAttempt) return Promise.resolve();
    this.running = this.sync(now)
      .catch((error) => {
        this.lastError =
          error instanceof Error ? error.message : "Firebase sync failed";
        this.nextAttempt = Math.max(now, Date.now()) + this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, 300000);
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async sync(now: number) {
    await this.clearRejectedPushTokens();
    await this.syncMessages();
    if (now >= this.nextDevices) {
      this.store.syncFirebaseDevices(await this.client.devices());
      this.nextDevices = Math.max(now, Date.now()) + 60000;
    }
    this.retryDelay = 15000;
    this.lastError = null;
  }

  private async clearRejectedPushTokens() {
    for (const rejected of this.store.rejectedPushTokens()) {
      const uid = rejected.id.slice("firebase:".length);
      const document = await this.client.document("devices", uid);
      if (document && fields(document).expoPushToken === rejected.token) {
        if (typeof document.updateTime !== "string" || !document.updateTime)
          throw new Error("Missing Firestore device update time");
        if (rejected.updateTime === null) {
          // Old databases have no captured registration version. Persist the
          // first read before writing so an uncertain result can be retried safely.
          this.store.pinRejectedPushToken(
            rejected.id,
            rejected.token,
            document.updateTime,
          );
          rejected.updateTime = document.updateTime;
        }
        if (document.updateTime === rejected.updateTime)
          await this.client.clearPushToken(uid, rejected.updateTime);
      }
      this.store.clearRejectedPushToken(
        rejected.id,
        rejected.token,
        rejected.updateTime,
      );
    }
  }

  private async syncMessages() {
    this.lastMessageId ??= await this.client.latestMessageId();
    const messages = this.store.firebaseMessages(this.lastMessageId);
    if (messages.length) {
      await this.client.upload(messages);
      this.lastMessageId = messages.at(-1)!.id;
    }
  }
}
