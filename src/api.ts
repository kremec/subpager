import type { Store } from "./store";
import { isObject, isRic } from "./radio/decoder";
import { logError } from "./log";

export interface ReceiverStatus {
  state: string;
  lastMessageAt: string | null;
  error: string | null;
  lastAudioAt?: string | null;
  restartCount?: number;
}

export interface ApiOptions {
  store: Store;
  receiverStatus: () => ReceiverStatus;
  pushError: () => string | null;
}

function positiveInteger(value: string | null, defaultValue?: number) {
  if (value === null) return defaultValue;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const response = (body: object, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

export function createHandler(options: ApiOptions) {
  const { store, receiverStatus, pushError } = options;
  return async (request: Request): Promise<Response> => {
    try {
      const authorization = request.headers.get("authorization");
      const token = authorization?.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";
      const device =
        token.length >= 32 && token.length <= 128
          ? store.authenticate(token)
          : null;
      if (!device) return response({ error: "Unauthorized" }, 401);
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/v1/status" && request.method === "GET") {
        return response({
          receiver: receiverStatus(),
          pendingPushes: store.pendingCount(),
          pushError: pushError(),
        });
      }
      if (path === "/v1/messages" && request.method === "GET") {
        const before = positiveInteger(
          url.searchParams.get("before"),
          Number.MAX_SAFE_INTEGER,
        );
        const limit = positiveInteger(url.searchParams.get("limit"), 50);
        const ricValue = url.searchParams.get("ric");
        const ric =
          ricValue === null
            ? undefined
            : /^\d+$/.test(ricValue)
              ? Number(ricValue)
              : NaN;
        const q = url.searchParams.get("q") ?? "";
        if (
          !before ||
          !limit ||
          limit > 100 ||
          (ric !== undefined && !isRic(ric)) ||
          q.length > 256
        )
          return response({ error: "Invalid history query" }, 400);
        return response(
          store.list({
            before,
            limit,
            ric,
            q,
            includeRepeats: url.searchParams.get("includeRepeats") === "true",
          }),
        );
      }
      const messageMatch = path.match(/^\/v1\/messages\/(\d+)(\/audio)?$/);
      if (messageMatch && request.method === "GET") {
        const id = positiveInteger(messageMatch[1]!);
        if (!id) return response({ error: "Invalid message ID" }, 400);
        if (!messageMatch[2]) {
          const message = store.getMessage(id);
          return message
            ? response(message)
            : response({ error: "Message not found" }, 404);
        }
        const recording = store.getRecording(id);
        if (!recording)
          return response({ error: "Recording not available" }, 404);
        return new Response(recording.wav, {
          headers: {
            "content-type": "audio/wav",
            "content-length": String(recording.wav.byteLength),
            "cache-control": "no-store",
            "content-disposition": `inline; filename="message-${id}.wav"`,
          },
        });
      }
      if (path === "/v1/devices/me" && request.method === "PUT") {
        const bodyText = await request.text();
        if (new TextEncoder().encode(bodyText).byteLength > 8192)
          return response({ error: "Request too large" }, 413);
        let body: unknown;
        try {
          body = JSON.parse(bodyText);
        } catch {
          return response({ error: "Invalid JSON" }, 400);
        }
        if (
          !isObject(body) ||
          typeof body.expoPushToken !== "string" ||
          !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/.test(
            body.expoPushToken,
          ) ||
          body.expoPushToken.length > 256
        )
          return response({ error: "Expected an Expo push token" }, 400);
        store.registerDevice(device.id, body.expoPushToken);
        return response({ id: device.id });
      }
      if (path === "/v1/devices/me" && request.method === "DELETE") {
        store.disablePush(device.id);
        return response({ ok: true });
      }
      return response({ error: "Not found" }, 404);
    } catch (error) {
      logError(
        `API operation failed: ${error instanceof Error ? error.message : "Unexpected error"}`,
      );
      return response({ error: "Server operation failed" }, 500);
    }
  };
}
