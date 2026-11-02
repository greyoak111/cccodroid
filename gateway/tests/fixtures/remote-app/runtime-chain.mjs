// Two real runtime factories + real relay + original gateway adapters.
// Only disposable certs, in-memory vaults and boot APIs are test doubles.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRemoteRuntime } from '../../../gw/remote/runtime.mjs';
import { createRemoteRoute } from '../../../gw/remote.mjs';
import { createRemoteStore } from '../../../gw/remote/store.mjs';
import { createSourceAdapter } from '../../../gw/remote/tablet-data.mjs';
import { createTunnelRelayServer } from '../../../../remote-relay/src/tunnel-server.mjs';
import { findSessionFile, peekSession } from '../../../gw/sessions.mjs';
import { transcriptItems } from '../../../gw/transcript.mjs';
import { disposableCredentials } from './tls-channel.mjs';
import { startRemoteUiServer } from './ui-server.mjs';
import { runRemoteBrowserScenarios } from './browser-scenarios.mjs';
import { LOCAL_SESSION, until } from './original-run.mjs';

export async function createRuntimeChain({ original, prepaired = true, rateBitsPerSecond = null, now = Date.now } = {}) {
  const root = await fs.mkdtemp(path.join(original.workspace, 'real-remote-runtime-'));
  const hostIdentity = await disposableCredentials(root, 'runtime-host'), phoneIdentity = await disposableCredentials(root, 'runtime-phone');
  hostIdentity.identity = { ...hostIdentity.identity, name: 'Synthetic tablet' };
  phoneIdentity.identity = { ...phoneIdentity.identity, name: 'Synthetic phone' };
  const hostToken = 'h'.repeat(43), phoneToken = 'p'.repeat(43), logs = [];
  const rateLimits = rateBitsPerSecond ? { bytesPerSecond: rateBitsPerSecond / 8, outboundBytesPerSecond: rateBitsPerSecond / 8 } : {};
  const relay = await createTunnelRelayServer({ devices: [{ deviceId: hostIdentity.identity.deviceId, token: hostToken }, { deviceId: phoneIdentity.identity.deviceId, token: phoneToken }], pairs: prepaired ? [[hostIdentity.identity.deviceId, phoneIdentity.identity.deviceId]] : [], logger: (event) => logs.push(event), limits: { messagesPerSecond: 200, messageBurst: 200, ...rateLimits } });
  await relay.listen(); const serverUrl = 'http://127.0.0.1:' + relay.address().port;
  const vault = () => {
    const items = new Map(); let n = 0;
    return { async seal(value) { const handle = 'synthetic-vault-' + ++n; items.set(handle, value); return handle; }, async unseal(handle) { if (!items.has(handle)) throw new Error('Synthetic vault absent'); return items.get(handle); } };
  };
  const hostStore = createRemoteStore(null, vault()), phoneStore = createRemoteStore(null, vault());
  hostStore.setIdentity(hostIdentity.identity); phoneStore.setIdentity(phoneIdentity.identity);
  if (prepaired) {
    hostStore.putPeer(phoneIdentity.identity); phoneStore.putPeer(hostIdentity.identity);
  }
  await hostStore.configure({ serverUrl, deviceName: 'Synthetic tablet' }, JSON.stringify({ deviceId: hostIdentity.identity.deviceId, token: hostToken }));
  await phoneStore.configure({ serverUrl, deviceName: 'Synthetic phone' }, JSON.stringify({ deviceId: phoneIdentity.identity.deviceId, token: phoneToken }));
  const sourceEvents = { subscribed: 0, callbacks: 0, captures: 0, histories: 0 };
  const rawSource = createSourceAdapter({ findSessionFile, peekSession, transcriptItems, runOfSession: original.runOfSession, onPublish: original.onPublish });
  const sourceAdapter = { ...rawSource,
    subscribe(listener) { sourceEvents.subscribed++; const off = rawSource.subscribe((event) => { sourceEvents.callbacks++; return listener(event); }); return () => { sourceEvents.subscribed--; off(); }; },
    capture(id) { sourceEvents.captures++; return rawSource.capture(id); },
    readHistory(id, options) { sourceEvents.histories++; return rawSource.readHistory(id, options); },
  };
  const executor = { capabilities: { literalText: true, messageReplay: true, remoteOnce: true, planDefault: true },
    getRun: (id) => original.RUNS.get(id), getRunOfSession: original.runOfSession, submitText: original.enqueueRemoteText,
    answerPerm: (run, id, answer, options) => run.answerPerm(id, answer, options), abortRun: original.abortRun, onEvent: original.onPublish };
  const dummyExecutor = { capabilities: {}, getRun: () => null, getRunOfSession: () => null, submitText: () => false, answerPerm: () => false, abortRun: () => false, onEvent: () => () => {} };
  const dummySource = { describe: () => null, readHistory: async () => ({ entries: [], cursor: null }), current: () => null };
  const notifications = { host: [], phone: [] };
  const fakeHost = (side) => ({ available: false, async status() { return { hostAvailable: false, shouldConnect: true, foreground: true, notificationPermission: 'unsupported' }; },
    async syncNotifications(entries) { notifications[side].push(structuredClone(entries)); }, async clearNotifications() {},
    async reportConnectionState() {}, async setBackgroundEnabled() {}, watchPolicy() { return () => {}; } });
  const hostHome = path.join(root, 'host'), phoneHome = path.join(root, 'phone');
  await fs.mkdir(hostHome); await fs.mkdir(phoneHome);
  const hostOptions = { home: hostHome, sourceAdapter, executor, identityBundle: hostIdentity, store: hostStore, hostAdapter: fakeHost('host'), allowLoopback: true, now };
  let host = await createRemoteRuntime(hostOptions);
  const phone = await createRemoteRuntime({ home: phoneHome, sourceAdapter: dummySource, executor: dummyExecutor, identityBundle: phoneIdentity, store: phoneStore, hostAdapter: fakeHost('phone'), allowLoopback: true, now });
  const hostRoute = createRemoteRoute(host), phoneRoute = createRemoteRoute(phone);
  let phoneUi = null, disposed = false;
  try { await Promise.all([host.connect(), phone.connect()]); }
  catch (error) { await Promise.allSettled([host.dispose(), phone.dispose()]); await relay.close(); await fs.rm(root, { recursive: true, force: true }); throw error; }
  const hosted = async () => {
    const result = await host.hosting(LOCAL_SESSION);
    return result.hosting;
  };
  return {
    root, original, host, phone, hostStore, phoneStore, relay, logs, hostIdentity, phoneIdentity, notifications, sourceAdapter,
    hostDeviceId: hostIdentity.identity.deviceId, phoneDeviceId: phoneIdentity.identity.deviceId,
    routeRemote: hostRoute, phoneRoute, hosted,
    allowedOrigins() { return phoneUi ? [phoneUi.origin] : []; },
    async invite() {
      const result = await host.invite({ localSessionId: LOCAL_SESSION, deviceId: phoneIdentity.identity.deviceId });
      const handle = result.hosting.remoteSessionId;
      try { await until(async () => (await phone.list()).snapshot.sessions.some((session) => session.remoteSessionId === handle), 'real invitation crosses relay/TLS'); }
      catch (error) { console.error('Independent runtime invitation evidence ' + JSON.stringify({ host: await host.settings(), phone: await phone.settings(), sessions: (await phone.list()).snapshot.sessions, relay: relay.stats(), logs })); throw error; }
      return handle;
    },
    async revoke() { const g = await hosted(); return host.revoke({ localSessionId: LOCAL_SESSION, remoteSessionId: g.remoteSessionId, grantVersion: g.grantVersion }); },
    async restartHost() {
      await host.dispose();
      host = await createRemoteRuntime(hostOptions);
      await host.connect();
      return host;
    },
    async browserAcceptance(context) {
      phoneUi = await startRemoteUiServer({ routeRemote: phoneRoute });
      const chain = this;
      const scenarios = { phoneDeviceId: chain.phoneDeviceId, hosted, revoke: () => chain.revoke(), async usePhone() {
        await context.cdp.call('Page.navigate', { url: phoneUi.origin + '/?lang=zh' });
        await context.until(() => context.cdp.eval('!!(window.__cc && __cc.srv.connected && __cc.state.settings)'), 'actual phone App boot');
      } };
      await runRemoteBrowserScenarios({ ...context, chain: scenarios, original });
    },
    evidence() { return { relay: relay.stats(), rateBitsPerSecond, logs, sourceEvents, phoneUi: phoneUi?.state, pairing: prepaired ? 'disposable prepaired devices; not first-pair GUI evidence' : 'runtime pairing workflow' }; },
    async diagnostic() { return { hostSnapshot: (await host.status()).snapshot, phoneSnapshot: (await phone.status()).snapshot, ...this.evidence() }; },
    async close() { if (disposed) return; disposed = true; await phoneUi?.close(); await Promise.allSettled([host.dispose(), phone.dispose()]); await relay.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}
