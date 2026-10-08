import { loadConfig } from "./config";
import { RadioReceiver } from "./radio";
import { Outbox } from "./outbox";
import { ConvexClient, ConvexWorker } from "./convex";
import { createErrorReporter, logError, logInfo } from "./log";

async function main() {
  const config = await loadConfig();
  const noRadio = process.env.SUBPAGER_NO_RADIO === "1";
  const client = await ConvexClient.open(config.convex);
  const outbox = new Outbox(config.outbox);
  const worker = new ConvexWorker(outbox, client);
  let receiver: RadioReceiver | undefined;
  let stopping = false;
  let delivery = Promise.resolve();
  const reportCloud = createErrorReporter("Convex sync");
  const reportReceiver = createErrorReporter("Receiver");
  const reportRadioLog = createErrorReporter("Radio diagnostic");
  const tick = () => {
    if (stopping) return;
    delivery = worker.tick().then(() => reportCloud(worker.lastError));
  };
  const timer = setInterval(tick, 1000);
  logInfo(
    `Subpager Convex: ${client.siteUrl}. Radio: ${noRadio ? "disabled" : config.radio.frequencyHz}; outbox=${config.outbox}`,
  );
  const cleanup = async () => {
    clearInterval(timer);
    await receiver?.stop();
    await delivery;
  };
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    logInfo("Stopping Subpager");
    await cleanup();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  tick();
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
      onClip: (clip) => {
        if (clip.reason !== "continuous")
          logInfo(`Saved ${clip.reason} clip: ${clip.path}`);
      },
      onCall: (call) => {
        if (stopping) return;
        try {
          const reception = outbox.save(call);
          logInfo(
            `Received call ${reception.sourceId}; receivedAt=${call.receivedAt}; RIC=${String(call.ric).padStart(7, "0")}; function=${call.function}; type=${call.type}; content=${JSON.stringify(call.content)}`,
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
      throw error;
    }
  }
}

main().catch((error) => {
  logError(error instanceof Error ? error.message : "Unexpected error");
  process.exitCode = 1;
});
