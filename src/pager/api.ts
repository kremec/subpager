import type { Connection } from "@/pager/types";

export async function request<T>(
  connection: Connection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init?.signal?.aborted) controller.abort();
  init?.signal?.addEventListener("abort", abort);
  const timeout = setTimeout(abort, 15_000);
  try {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 401)
        throw new Error("Device key rejected. Check connection settings.");
      throw new Error(`Server returned HTTP ${response.status}.`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", abort);
  }
}

export function normalizeConnection(connection: Connection): Connection {
  const url = new URL(connection.baseUrl.trim());
  if (url.protocol !== "https:" && !(__DEV__ && url.protocol === "http:")) {
    throw new Error(
      "Use an HTTPS server URL. Development builds also accept HTTP.",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use the server origin only, for example https://pager.example.com.",
    );
  }
  if (!connection.apiKey.trim())
    throw new Error("Enter the device key from your server.");
  if (connection.rics.length > 100)
    throw new Error("Use at most 100 alert RICs.");
  if (
    connection.rics.some(
      (ric) => !Number.isInteger(ric) || ric < 0 || ric > 2097151,
    )
  ) {
    throw new Error("RICs must be whole numbers from 0 to 2097151.");
  }
  return {
    baseUrl: url.origin,
    apiKey: connection.apiKey.trim(),
    rics: [...new Set(connection.rics)],
  };
}

let deviceQueue = Promise.resolve();
const retiredConnections = new WeakSet<Connection>();

export function mutateDevice(
  connection: Connection,
  body?: { expoPushToken: string; rics: number[] },
) {
  const operation = deviceQueue.then(() => {
    if (body && retiredConnections.has(connection)) return;
    return request<void>(
      connection,
      "/v1/devices/me",
      body
        ? { method: "PUT", body: JSON.stringify(body) }
        : { method: "DELETE" },
    );
  });
  deviceQueue = operation.catch(() => {});
  return operation;
}

// Stop registrations from an old session before waiting for any in-flight PUT.
export async function disconnectDevice(connection: Connection) {
  retiredConnections.add(connection);
  try {
    await mutateDevice(connection);
  } catch (error) {
    retiredConnections.delete(connection);
    throw error;
  }
}
