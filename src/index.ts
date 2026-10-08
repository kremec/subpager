import { join } from "node:path";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { loadConfig } from "./config";
import { createHandler, type ReceiverStatus } from "./api";
import { RadioReceiver, type AudioClip } from "./radio";
import { Store } from "./store";
import { PushWorker } from "./delivery";
import { ConvexClient, ConvexWorker } from "./convex";
import { LocationExtractor, LocationWorker } from "./location";
import { createErrorReporter, logError, logInfo } from "./log";

async function archiveRecording(
  store: Store,
  clip: AudioClip,
  path = clip.path,
) {
  const wav = await Bun.file(path).bytes();
  const messages = store.saveRecording(wav, clip.calls);
  if (!messages.length) throw new Error("No live messages match the recording");
  // Delete staging files only after the SQLite transaction has committed.
  await unlink(path);
  await unlink(`${path}.json`);
  logInfo(
    `Stored recording for call(s): ${messages.join(", ")}; bytes=${wav.byteLength}`,
  );
}

async function main() {
  const config = await loadConfig();
  const noRadio = process.env.SUBPAGER_NO_RADIO === "1";
  const client = config.convex
    ? await ConvexClient.open(config.convex)
    : undefined;
  const store = new Store(config.database, !!client, !!config.location);
  const cloud = client ? new ConvexWorker(store, client) : undefined;
  const worker = client
    ? undefined
    : new PushWorker(store, fetch, process.env.EXPO_ACCESS_TOKEN);
  const location =
    config.location && client && cloud
      ? new LocationWorker(
          store,
          await LocationExtractor.open(config.location),
          client,
          cloud,
        )
      : undefined;
  if (config.clips.enabled) {
    await mkdir(config.clips.directory, { recursive: true });
    // Recover a clip committed to disk before a prior process could archive it.
    for (const name of await readdir(config.clips.directory)) {
      if (!/^subpager-decoded-.*\.wav$/.test(name)) continue;
      await Bun.file(join(config.clips.directory, `${name}.json`))
        .json()
        .then((clip: AudioClip) =>
          archiveRecording(store, clip, join(config.clips.directory, name)),
        )
        .catch((error) =>
          logError(`Recording archive failed: ${name}: ${String(error)}`),
        );
    }
  }
  let receiver: RadioReceiver | undefined;
  const status = (): ReceiverStatus => {
    const radio = receiver?.status();
    return {
      state: radio?.state ?? "disabled",
      lastMessageAt: radio?.lastCallAt ?? null,
      error: radio?.error ?? null,
      lastAudioAt: radio?.lastAudioAt ?? null,
      restartCount: radio?.restartCount ?? 0,
    };
  };
  const server = client
    ? undefined
    : Bun.serve({
        hostname: config.api.host,
        port: config.api.port,
        maxRequestBodySize: 8192,
        fetch: createHandler({
          store,
          receiverStatus: status,
          pushError: () => worker?.lastError ?? null,
        }),
      });
  let stopping = false;
  let delivery = Promise.resolve();
  let delivering = false;
  const reportCloud = createErrorReporter("Convex sync");
  const reportLocation = createErrorReporter("Location enrichment");
  let enrichment = Promise.resolve();
  let enriching = false;
  const reportPush = createErrorReporter("Push delivery");
  const reportDelivery = createErrorReporter("Delivery worker");
  const reportReceiver = createErrorReporter("Receiver");
  const reportRadioLog = createErrorReporter("Radio diagnostic");
  const tick = () => {
    if (stopping || delivering) return;
    delivering = true;
    delivery = (async () => {
      await cloud?.tick().catch(() => {});
      if (cloud) reportCloud(cloud.lastError);
      await worker?.tick();
      if (worker) reportPush(worker.lastError);
      reportDelivery(null);
    })()
      .catch((error) =>
        reportDelivery(
          error instanceof Error ? error.message : "Unexpected error",
        ),
      )
      .finally(() => {
        delivering = false;
      });
  };
  const locationTick = () => {
    if (stopping || enriching || !location) return;
    enriching = true;
    enrichment = location
      .tick()
      .catch((error) => {
        reportLocation(
          error instanceof Error ? error.message : "Location worker failed",
        );
      })
      .finally(() => {
        reportLocation(location.lastError);
        enriching = false;
      });
  };
  const timer = setInterval(() => {
    tick();
    locationTick();
  }, 1000);
  tick();
  locationTick();
  logInfo(
    `${client ? `Subpager Convex: ${client.siteUrl}` : `Subpager API: ${server!.url}`}. Radio: ${noRadio ? "disabled" : config.radio.frequencyHz}`,
  );
  const cleanup = async () => {
    clearInterval(timer);
    await server?.stop(true);
    await receiver?.stop();
    await delivery;
    await enrichment;
  };
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    logInfo("Stopping Subpager");
    await cleanup();
    store.close();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  if (!noRadio) {
    receiver = new RadioReceiver({
      ...config.radio,
      clips: config.clips,
      onLog: (message) => {
        if (message.startsWith("Receiver PCM resumed")) {
          reportReceiver(null);
          logInfo(message);
        } else reportRadioLog(message);
      },
      onState: (radio) => {
        if (radio.state === "restarting" && radio.error)
          reportReceiver(radio.error);
      },
      onClip: async (clip) => {
        if (clip.reason === "decoded") await archiveRecording(store, clip);
        else if (clip.reason === "manual")
          logInfo(`Saved manual clip: ${clip.path}`);
      },
      onCall: (call) => {
        if (stopping) return;
        try {
          const message = store.save(
            call,
            config.dedupeSeconds,
            config.pushMaxAgeSeconds,
          );
          logInfo(
            `Received call ${message.id}; receivedAt=${message.receivedAt}; RIC=${String(message.ric).padStart(7, "0")}; function=${message.function}; type=${message.type}${message.duplicateOf ? `; repeatOf=${message.duplicateOf}` : ""}; content=${JSON.stringify(message.content)}`,
          );
          tick();
        } catch (error) {
          logError(
            `Message storage failed: ${error instanceof Error ? error.message : "Unexpected error"}`,
          );
          void stop(1);
        }
      },
    });
    try {
      await receiver.start();
    } catch (error) {
      stopping = true;
      await cleanup();
      store.close();
      throw error;
    }
  }
}

main().catch((error) => {
  logError(error instanceof Error ? error.message : "Unexpected error");
  process.exitCode = 1;
});
