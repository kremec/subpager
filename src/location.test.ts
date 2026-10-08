import { expect, test } from "bun:test";
import { ConvexClient, ConvexWorker, HttpError } from "./convex";
import {
  LocationExtractor,
  LocationWorker,
  parseLocation,
  readLocationResponse,
} from "./location";
import { Store } from "./store";

function stream(events: object[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
}

test("location accepts only a copied source span or null", () => {
  expect(
    parseLocation('{"location":"ŠOLI GOLO"}', "VAJA, GORI V ŠOLI GOLO."),
  ).toBe("ŠOLI GOLO");
  expect(parseLocation('{"location":null}', "TEST")).toBeNull();
  for (const text of [
    '{"location":"OŠ Golo"}',
    '{"location":""}',
    '{"location":" GOLO"}',
    '{"location":null,"query":"Golo"}',
  ])
    expect(() => parseLocation(text, "GOLO")).toThrow();
});

test("subscription-style streams accept empty final output only after a consistent completed event", async () => {
  const events = [
    { type: "response.output_text.delta", delta: '{"location":' },
    { type: "response.output_text.delta", delta: "null}" },
    { type: "response.output_text.done", text: '{"location":null}' },
    {
      type: "response.completed",
      response: { status: "completed", output: [] },
    },
  ];
  expect(await readLocationResponse(stream(events))).toBe('{"location":null}');
  await expect(
    readLocationResponse(stream(events.slice(0, 2))),
  ).rejects.toThrow();
  await expect(
    readLocationResponse(
      stream([
        ...events.slice(0, 2),
        { type: "response.output_text.done", text: "different" },
        events[3]!,
      ]),
    ),
  ).rejects.toThrow();
  await expect(
    readLocationResponse(
      stream([...events, { type: "response.refusal.done" }]),
    ),
  ).rejects.toThrow();
});

test("a committed extraction survives failed cloud patch without another billed inference", async () => {
  const store = new Store(":memory:", true, true);
  let extractions = 0;
  let failPatch = true;
  const transport: (
    url: string,
    options: RequestInit,
  ) => Promise<Response> = async (url) => {
    if (String(url).endsWith("/location") && failPatch)
      return new Response(null, { status: 503 });
    return Response.json({ inserted: 1 });
  };
  const client = new ConvexClient(
    "https://test.convex.site",
    "secret",
    transport,
  );
  const cloud = new ConvexWorker(store, client);
  const extractor = {
    extract: async () => {
      extractions++;
      return "GOLO";
    },
  };
  try {
    const message = store.save(
      {
        receivedAt: new Date().toISOString(),
        ric: 1,
        function: 3,
        type: "alpha",
        content: "ŠOLA GOLO",
      },
      30,
      300,
    );
    await cloud.tick();
    let worker = new LocationWorker(store, extractor, client, cloud);
    const now = Date.now();
    await worker.tick(now);
    expect(extractions).toBe(1);
    await worker.tick(now);
    expect(worker.lastError).toBe("Convex HTTP 503");
    failPatch = false;
    worker = new LocationWorker(store, extractor, client, cloud);
    await worker.tick(now + 15_100);
    expect(extractions).toBe(1);
    expect(
      store.db
        .query("SELECT state FROM location_jobs WHERE message_id = ?")
        .get(message.id),
    ).toEqual({ state: "uploaded" });
  } finally {
    store.close();
  }
});

test("quota errors pause all extraction work while message publication continues", async () => {
  const store = new Store(":memory:", true, true);
  let extractions = 0;
  const transport: (
    url: string,
    options: RequestInit,
  ) => Promise<Response> = async () => Response.json({ inserted: 2 });
  const client = new ConvexClient(
    "https://test.convex.site",
    "secret",
    transport,
  );
  const cloud = new ConvexWorker(store, client);
  const worker = new LocationWorker(
    store,
    {
      extract: async () => {
        extractions++;
        throw new HttpError(429, "OpenAI");
      },
    },
    client,
    cloud,
  );
  try {
    for (const content of ["ŠOLA GOLO", "CESTA 1"])
      store.save(
        {
          receivedAt: new Date().toISOString(),
          ric: 1,
          function: 3,
          type: "alpha",
          content,
        },
        30,
        300,
      );
    const now = Date.now();
    await worker.tick(now);
    await worker.tick(now + 1000);
    await new LocationWorker(
      store,
      {
        extract: async () => {
          extractions++;
          return null;
        },
      },
      client,
      cloud,
    ).tick(now + 1000);
    expect(extractions).toBe(1);
    await cloud.tick();
    expect(cloud.cursor).toBe(2);
    store.db
      .query(
        "UPDATE location_jobs SET state = 'ready', location = 'CESTA 1' WHERE message_id = 2",
      )
      .run();
    await worker.tick(now + 2000);
    expect(
      store.db
        .query("SELECT state FROM location_jobs WHERE message_id = 2")
        .get(),
    ).toEqual({ state: "uploaded" });
    expect(extractions).toBe(1);
  } finally {
    store.close();
  }
});

test("missing API credentials are deferred until extraction and do not block worker setup", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const extractor = await LocationExtractor.open({});
    await expect(extractor.extract("ŠOLA GOLO")).rejects.toMatchObject({
      status: 401,
    });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("extraction uses the environment API key without reading a credential file", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "isolated-test-api-key";
  try {
    const extractor = new LocationExtractor(
      "instructions",
      "gpt-6-luna",
      async (_url, options) => {
        expect(new Headers(options.headers).get("authorization")).toBe(
          "Bearer isolated-test-api-key",
        );
        return stream([
          { type: "response.output_text.delta", delta: '{"location":null}' },
          { type: "response.output_text.done", text: '{"location":null}' },
          { type: "response.completed", response: { status: "completed" } },
        ]);
      },
    );
    expect(await extractor.extract("TEST")).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
