import { afterEach, expect, spyOn, test } from "bun:test";
import { SpinLive } from "./spin-live";

const separator = String.fromCharCode(30);

class Socket {
  binaryType = "";
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send(value: string): void {
    this.sent.push(value);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  receive(value: object): void {
    this.onmessage?.({ data: JSON.stringify(value) + separator });
  }
  subscribe(): void {
    this.onopen?.();
    this.receive({});
    this.receive({ type: 3, invocationId: "connection", result: "private" });
    this.receive({ type: 3, invocationId: "subscription", result: null });
  }
}

const restore: (() => void)[] = [];
afterEach(() => {
  for (const callback of restore.splice(0).reverse()) callback();
});

function setup() {
  let now = 0;
  let timerId = 0;
  const timers = new Map<
    number,
    { callback: () => void; at: number; interval?: number }
  >();
  const timer = (callback: () => void, delay: number, interval?: number) => {
    const id = ++timerId;
    timers.set(id, { callback, at: now + delay, interval });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => timer(callback, delay)) as typeof setTimeout);
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => timer(callback, delay, delay)) as typeof setInterval);
  const clear = (id: unknown) => timers.delete(Number(id));
  const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
    clear,
  );
  const clearIntervalSpy = spyOn(
    globalThis,
    "clearInterval",
  ).mockImplementation(clear);
  const info = spyOn(console, "log").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  restore.push(() => {
    clock.mockRestore();
    timeout.mockRestore();
    interval.mockRestore();
    clearTimeoutSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    info.mockRestore();
    errors.mockRestore();
  });
  const sockets: Socket[] = [];
  const ids: string[] = [];
  let connections = 0;
  const live = new SpinLive(
    10015,
    (id) => ids.push(id),
    () => connections++,
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  restore.push(() => live.stop());
  live.start();
  return {
    live,
    sockets,
    socket: sockets[0]!,
    ids,
    connections: () => connections,
    timers,
    info,
    errors,
    advance: (duration: number) => {
      const end = now + duration;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, value]) => value.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        if (next[1].interval) next[1].at += next[1].interval;
        else timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

test("handshake and numeric public group subscription precede incident callbacks", () => {
  const state = setup();
  state.socket.receive({
    type: 1,
    target: "Action",
    arguments: [{ lokacijaId: 472595 }],
  });
  // A hub invocation is not a successful handshake.
  expect(state.socket.closed).toBe(true);
  expect(state.connections()).toBe(0);
  expect(state.ids).toEqual([]);
  state.advance(15_000);
  const socket = state.sockets[1]!;
  socket.onopen?.();
  expect(socket.sent).toEqual(['{"protocol":"json","version":1}' + separator]);
  socket.receive({});
  expect(JSON.parse(socket.sent[1]!.slice(0, -1))).toEqual({
    type: 1,
    invocationId: "connection",
    target: "ConnectionId",
    arguments: [],
  });
  socket.receive({ type: 3, invocationId: "connection", result: "private" });
  expect(JSON.parse(socket.sent[2]!.slice(0, -1))).toEqual({
    type: 1,
    invocationId: "subscription",
    target: "AddToGroup",
    arguments: [10015],
  });
  socket.receive({
    type: 1,
    target: "Action",
    arguments: [{ lokacijaId: 123 }],
  });
  expect(state.ids).toEqual([]);
  socket.receive({ type: 3, invocationId: "subscription", result: null });
  expect(state.connections()).toBe(1);
  expect(state.info.mock.calls.join(" ")).not.toContain("private");
});

test("fragmented frames validate incident IDs and ignore pings and ID-less actions", () => {
  const state = setup();
  state.socket.subscribe();
  const message = JSON.stringify({
    type: 1,
    target: "aCtIoN",
    arguments: [
      { lokacijaId: 472595 },
      { lokacijaId: "472595" },
      { lokacijaId: "472606" },
      { lokacijaId: "0" },
      { lokacijaId: -1 },
      { lokacijaId: "001" },
      { lokacijaId: "1e3" },
      { lokacijaId: "9007199254740992" },
      { lokacijaId: {} },
      { private: "not an incident" },
      null,
    ],
  });
  state.socket.onmessage?.({ data: message.slice(0, 20) });
  expect(state.ids).toEqual([]);
  state.socket.onmessage?.({
    data: new TextEncoder().encode(message.slice(20) + separator),
  });
  state.socket.receive({ type: 6 });
  state.socket.receive({ type: 1, target: "Action", arguments: [{}] });
  expect(state.ids).toEqual(["472595", "472606"]);
  expect(state.connections()).toBe(1);
});

test("type 7 and error/close schedule one reconnect and stale sockets are ignored", () => {
  const state = setup();
  state.socket.subscribe();
  state.live.start();
  expect(state.sockets).toHaveLength(1);
  state.socket.receive({ type: 7, error: "private error" });
  state.socket.onerror?.();
  state.socket.onclose?.();
  state.advance(15_000);
  expect(state.sockets).toHaveLength(2);
  state.sockets[1]!.subscribe();
  state.socket.receive({
    type: 1,
    target: "Action",
    arguments: [{ lokacijaId: 1 }],
  });
  state.sockets[1]!.receive({
    type: 1,
    target: "Action",
    arguments: [{ lokacijaId: 2 }],
  });
  expect(state.ids).toEqual(["2"]);
  expect(state.connections()).toBe(2);
  expect(state.errors.mock.calls.join(" ")).not.toContain("private error");
});

test("handshake and subscription deadlines retry without a server close event", () => {
  const state = setup();
  state.advance(10_000);
  expect(state.socket.closed).toBe(true);
  state.advance(15_000);
  const socket = state.sockets[1]!;
  socket.onopen?.();
  socket.receive({});
  socket.receive({ type: 3, invocationId: "connection", result: "private" });
  state.advance(10_000);
  expect(socket.closed).toBe(true);
  state.advance(15_000);
  expect(state.sockets).toHaveLength(3);
});

test("keepalive pings stop and reconnect after 45 seconds without input", () => {
  const state = setup();
  state.socket.subscribe();
  state.advance(30_000);
  expect(
    state.socket.sent.filter((frame) => frame.includes('"type":6')),
  ).toHaveLength(2);
  expect(state.socket.closed).toBe(false);
  state.advance(15_000);
  expect(state.socket.closed).toBe(true);
  state.advance(15_000);
  expect(state.sockets).toHaveLength(2);
});

test("stop clears all timers, closes the socket and prevents pending reconnect", () => {
  const state = setup();
  state.socket.subscribe();
  state.live.stop();
  expect(state.socket.closed).toBe(true);
  expect(state.timers.size).toBe(0);
  state.advance(120_000);
  expect(state.sockets).toHaveLength(1);
  state.live.start();
  state.sockets[1]!.onerror?.();
  state.live.stop();
  expect(state.timers.size).toBe(0);
  state.advance(120_000);
  expect(state.sockets).toHaveLength(2);
});

test.each([
  { type: 3, invocationId: "subscription", error: "private" },
  { type: 3, invocationId: "subscription", result: { statusCode: 200 } },
])("unverified subscription completion fails closed: %j", (completion) => {
  const state = setup();
  state.socket.onopen?.();
  state.socket.receive({});
  state.socket.receive({
    type: 3,
    invocationId: "connection",
    result: "private",
  });
  state.socket.receive(completion);
  expect(state.socket.closed).toBe(true);
  expect(state.connections()).toBe(0);
  expect(state.errors.mock.calls.join(" ")).not.toContain("private");
});

test("oversized and malformed frames close without logging their contents", () => {
  const state = setup();
  state.socket.onmessage?.({ data: "x".repeat(1_000_001) });
  expect(state.socket.closed).toBe(true);
  state.advance(15_000);
  state.sockets[1]!.onmessage?.({ data: "private-invalid-json" + separator });
  expect(state.sockets[1]!.closed).toBe(true);
  expect(state.errors.mock.calls.join(" ")).not.toContain(
    "private-invalid-json",
  );
});

test("Bun WebSocket exchanges SignalR frames with a local mock hub", async () => {
  const frames: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response(null, { status: 400 }),
    websocket: {
      message: (socket, data) => {
        const message = JSON.parse(String(data).slice(0, -1));
        frames.push(message);
        if (message.protocol === "json") socket.send("{}" + separator);
        else if (message.target === "ConnectionId")
          socket.send(
            JSON.stringify({
              type: 3,
              invocationId: message.invocationId,
              result: "private",
            }) + separator,
          );
        else if (message.target === "AddToGroup")
          socket.send(
            JSON.stringify({
              type: 3,
              invocationId: message.invocationId,
              result: null,
            }) +
              separator +
              JSON.stringify({
                type: 1,
                target: "Action",
                arguments: [{ lokacijaId: 472595 }],
              }) +
              separator,
          );
      },
    },
  });
  let connected = false;
  let receive!: (id: string) => void;
  const received = new Promise<string>((resolve) => {
    receive = resolve;
  });
  const live = new SpinLive(
    10015,
    receive,
    () => {
      connected = true;
    },
    () => new WebSocket(`ws://127.0.0.1:${server.port}`),
  );
  try {
    live.start();
    expect(await received).toBe("472595");
    expect(connected).toBe(true);
    expect(frames.map((frame) => frame.target ?? frame.protocol)).toEqual([
      "json",
      "ConnectionId",
      "AddToGroup",
    ]);
    expect(frames[2]?.arguments).toEqual([10015]);
  } finally {
    live.stop();
    server.stop(true);
  }
});
