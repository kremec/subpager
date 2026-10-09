import { loadConfig } from "./config";
import { RadioReceiver } from "./radio";
import { Outbox } from "./outbox";
import { FirebaseBackend, FirebaseWorker } from "./firebase";
import { FirestoreJobsProcessor } from "./processor";
import { createErrorReporter, logError, logInfo } from "./log";

async function main() {
  const config = await loadConfig();
  const noRadio = process.env.SUBPAGER_NO_RADIO === "1";
  const client = await FirebaseBackend.open(config.firebase);
  const outbox = new Outbox(config.outbox);
  const worker = new FirebaseWorker(outbox, client);
  const processor = new FirestoreJobsProcessor(
    client.db,
    {
      openaiApiKey: process.env.OPENAI_API_KEY,
      expoAccessToken: process.env.EXPO_ACCESS_TOKEN,
    },
    client.users,
  );
  let receiver: RadioReceiver | undefined;
  let stopping = false;
  let delivery = Promise.resolve();
  const reportCloud = createErrorReporter("Firestore sync");
  const reportReceiver = createErrorReporter("Receiver");
  const reportRadioLog = createErrorReporter("Radio diagnostic");
  const tick = () => {
    if (stopping) return;
    delivery = worker.tick().then(() => reportCloud(worker.lastError));
  };
  const timer = setInterval(tick, 1000);
  logInfo(
    `Subpager Firestore: ${config.firebase.projectId}. Radio: ${noRadio ? "disabled" : config.radio.frequencyHz}; outbox=${config.outbox}`,
  );
  const cleanup = async () => {
    clearInterval(timer);
    const jobsStopping = processor.stop();
    await receiver?.stop();
    await delivery;
    await jobsStopping;
    await client.db.terminate();
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
  processor.start();
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
        logInfo(`Saved ${clip.reason} clip: ${clip.path}`);
      },
      onCall: (call) => {
        if (stopping) return;
        try {
          const reception = outbox.save(
            call,
            client.db.collection("messages").doc().id,
          );
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
