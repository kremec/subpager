import { createErrorReporter, logError, logInfo } from "./log";

const separator = String.fromCharCode(30);
const hubUrl = "wss://spin3.sos112.si/api/hub/lokacija";

interface HubFrame {
  type?: number;
  target?: string;
  invocationId?: string;
  error?: unknown;
  result?: unknown;
  arguments?: unknown[];
}

export class SpinLive {
  private running = false;
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private cleanup?: () => void;
  private reportError = createErrorReporter("SPIN live");

  constructor(
    private groupId: number,
    private onIncident: (id: string) => void,
    private onConnected: () => void,
    private createSocket: (url: string) => WebSocket = (url) =>
      new WebSocket(url),
  ) {
    if (!Number.isSafeInteger(groupId) || groupId <= 0)
      throw new Error("Invalid public SPIN group ID");
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnect);
    this.reconnect = undefined;
    this.cleanup?.();
    this.cleanup = undefined;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private retry(reason: string): void {
    if (!this.running) return;
    this.reportError(`${reason}; reconnecting in 15 seconds`);
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.connect();
    }, 15_000);
  }

  private connect(): void {
    if (!this.running || this.socket) return;
    let socket: WebSocket;
    try {
      socket = this.createSocket(hubUrl);
    } catch {
      this.retry("Connection failed");
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    let buffer = "";
    let phase: "handshake" | "connection" | "subscription" | "ready" =
      "handshake";
    let lastReceived = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    const active = () => this.running && this.socket === socket;
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    };
    this.cleanup = cleanup;
    const fail = (reason: string) => {
      if (!active()) return;
      cleanup();
      this.cleanup = undefined;
      this.socket = undefined;
      socket.close();
      this.retry(reason);
    };
    const deadline = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fail("Subscription timed out"), 10_000);
    };
    const send = (message: object) => {
      try {
        socket.send(JSON.stringify(message) + separator);
      } catch {
        fail("Send failed");
      }
    };
    const invoke = (target: string, invocationId: string, args: unknown[]) => {
      deadline();
      send({ type: 1, invocationId, target, arguments: args });
    };
    deadline();
    socket.onopen = () => {
      if (active()) send({ protocol: "json", version: 1 });
    };
    socket.onmessage = (event) => {
      if (!active()) return;
      lastReceived = Date.now();
      const data = event.data;
      if (typeof data === "string") buffer += data;
      else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
        buffer += new TextDecoder().decode(data);
      else {
        fail("Unsupported frame");
        return;
      }
      if (buffer.length > 1_000_000) {
        fail("Oversized frame");
        return;
      }
      let boundary: number;
      while (active() && (boundary = buffer.indexOf(separator)) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (!frame) continue;
        let message: HubFrame;
        try {
          const parsed: unknown = JSON.parse(frame);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Invalid frame");
          message = parsed as HubFrame;
        } catch {
          fail("Invalid frame");
          return;
        }
        if (message.type === 7) {
          fail("Server closed the connection");
          return;
        }
        if (phase === "handshake") {
          if (message.error || message.type !== undefined) {
            fail("Handshake rejected");
            return;
          }
          phase = "connection";
          heartbeat = setInterval(() => {
            if (!active()) return;
            if (Date.now() - lastReceived >= 45_000) {
              fail("Server stopped responding");
              return;
            }
            send({ type: 6 });
          }, 15_000);
          invoke("ConnectionId", "connection", []);
        } else if (
          phase === "connection" &&
          message.type === 3 &&
          message.invocationId === "connection"
        ) {
          if (message.error || typeof message.result !== "string") {
            fail("Connection check rejected");
            return;
          }
          phase = "subscription";
          invoke("AddToGroup", "subscription", [this.groupId]);
        } else if (
          phase === "subscription" &&
          message.type === 3 &&
          message.invocationId === "subscription"
        ) {
          if (message.error || message.result != null) {
            fail("Subscription rejected");
            return;
          }
          clearTimeout(timeout);
          phase = "ready";
          this.reportError(null);
          logInfo(`SPIN live subscribed to public group ${this.groupId}`);
          try {
            this.onConnected();
          } catch {
            logError("SPIN live: Recovery callback failed");
          }
        } else if (
          phase === "ready" &&
          message.type === 1 &&
          typeof message.target === "string" &&
          message.target.toLowerCase() === "action" &&
          Array.isArray(message.arguments)
        ) {
          const ids = new Set<string>();
          for (const argument of message.arguments) {
            if (!argument || typeof argument !== "object") continue;
            const value = (argument as Record<string, unknown>).lokacijaId;
            if (typeof value !== "number" && typeof value !== "string")
              continue;
            const id = String(value);
            if (/^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)))
              ids.add(id);
          }
          for (const id of ids) {
            try {
              this.onIncident(id);
            } catch {
              logError("SPIN live: Incident callback failed");
            }
          }
        }
      }
    };
    socket.onerror = () => fail("Connection failed");
    socket.onclose = () => fail("Connection closed");
  }
}
