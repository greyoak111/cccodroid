// Thin dependencies only: every side effect calls actual original gateway code.
import path from 'node:path';
import { createTabletControl } from '../../../gw/remote/tablet-control.mjs';
import { createFrame } from '../../../gw/remote/protocol.mjs';

export function createOriginalControl({ original, run, now = Date.now, requestTtlMs = 300000, executorOverrides = {} }) {
  const grant = { hostDeviceId: 'fixture_tablet', phoneDeviceId: 'fixture_phone', hostInstanceId: 'fixture_control_boot', remoteSessionId: 'fixture_control_handle', grantVersion: 1, runId: run.id, state: 'active', expiresAt: now() + 3600000, localSessionId: original.localSessionId };
  const ledgerPath = path.join(original.root, 'independent-control-ledger.json');
  const binding = { fromDeviceId: grant.phoneDeviceId, toDeviceId: grant.hostDeviceId, hostInstanceId: grant.hostInstanceId, remoteSessionId: grant.remoteSessionId, grantVersion: grant.grantVersion, runId: run.id };
  const executor = {
    // No capabilities claim for unimplemented literal text or permission hooks.
    capabilities: {}, getRun: (id) => original.RUNS.get(id), getRunOfSession: original.runOfSession,
    submitText: (item) => original.enqueue({ sessionId: item.sessionId, message: item.text, literalText: item.literalText, remoteCommandId: item.commandId, sourceDeviceId: item.sourceDeviceId }),
    answerPerm: (target, id, answer, flags) => target.answerPerm(id, answer, flags),
    abortRun: original.abortRun, onEvent: original.onPublish, ...executorOverrides,
  };
  const receipts = [];
  const make = (hostInstanceId = grant.hostInstanceId) => {
    const control = createTabletControl({ deviceId: grant.hostDeviceId, hostInstanceId, ledgerPath, readGrant: (handle) => handle === grant.remoteSessionId ? grant : null, executor, now, requestTtlMs });
    control.onReceipt((frame) => receipts.push(frame)); return control;
  };
  return { grant, binding, executor, receipts, make, control: make(),
    frame(type, payload, commandId, extra = {}) { return createFrame(type, { ...binding, ...extra }, payload, { now: now(), commandId }); },
  };
}
