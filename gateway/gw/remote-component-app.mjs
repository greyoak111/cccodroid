import path from "node:path";
import { CFG, PREFIX } from "./config.mjs";
import { compRecord, devkitIdentity, registerRemoteComponentProvider } from "./components.mjs";
import { findSessionFile, peekSession } from "./sessions.mjs";
import { transcriptItems } from "./transcript.mjs";
import { runOfSession, RUNS } from "./runs.mjs";
import { enqueueRemoteText, abortRun } from "./queue.mjs";
import { onPublish } from "./bus.mjs";
import { createHostAdapterFromGatewayStdin } from "./remote-host.mjs";
import { createRemoteComponentManager, importRemoteComponent } from "./remote-component.mjs";

let appManager;
export function getAppRemoteComponent() {
  if (!appManager) throw Object.assign(new Error("REMOTE_UNAVAILABLE"), { code: "REMOTE_UNAVAILABLE" });
  return appManager;
}

export async function createAppRemoteComponent() {
  // Consume the direct-child capability at startup even without a component;
  // it never reaches model/tool descendants and is not a component path/env API.
  const hostAdapter = await createHostAdapterFromGatewayStdin();
  const executor = Object.freeze({
    capabilities: Object.freeze({ literalText: true, remoteOnce: true, planDefault: true, messageReplay: true }),
    getRun: (id) => RUNS.get(id), getRunOfSession: runOfSession, submitText: enqueueRemoteText,
    answerPerm: (run, id, answer, options) => run.answerPerm?.(id, answer, options) ?? false,
    abortRun, onEvent: onPublish,
  });
  const host = Object.freeze({ home: path.join(path.resolve(CFG.home), ".cccodroid", "remote-session"), hostAdapter, executor,
    source: Object.freeze({ findSessionFile, peekSession, transcriptItems, runOfSession, onPublish }) });
  appManager = createRemoteComponentManager({ prefix: PREFIX, home: path.resolve(CFG.home),
    readRecord: () => compRecord("remote-session"), readDevkit: devkitIdentity,
    createRuntime: (descriptor) => importRemoteComponent(descriptor, host) });
  registerRemoteComponentProvider(() => appManager);
  await appManager.status();
  return appManager;
}
