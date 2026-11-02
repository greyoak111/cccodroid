// Real WebSocket relay and real inner mutual TLS; no plaintext relay decoder.
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { createTunnelRelayServer } from '../../../../remote-relay/src/tunnel-server.mjs';
import { createSecureChannel, createReplayGuard } from '../../../gw/remote/crypto.mjs';
import { disposableCredentials } from './tls-channel.mjs';
import { until } from './original-run.mjs';

export async function websocketPeer(origin, deviceId, token) {
  const ws = new WebSocket(origin + '/v1/relay'), messages = [], listeners = new Set();
  ws.addEventListener('message', ({ data }) => { const frame = JSON.parse(data); messages.push(frame); for (const listener of listeners) listener(frame); });
  await once(ws, 'open'); ws.send(JSON.stringify({ v: 1, op: 'auth', deviceId, token }));
  await until(() => messages.some((m) => m.op === 'auth.ok'), 'real relay first-frame authentication');
  return { ws, messages, send(frame) { ws.send(JSON.stringify({ v: 1, ...frame })); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, close() { ws.close(); } };
}
export async function createTunnelTlsFixture(root) {
  const host = await disposableCredentials(root, 'relay-host'), phone = await disposableCredentials(root, 'relay-phone');
  const hostToken = 'H'.repeat(43), phoneToken = 'P'.repeat(43), wrongToken = 'W'.repeat(43);
  const logs = [];
  const relay = await createTunnelRelayServer({ devices: [{ deviceId: host.identity.deviceId, token: hostToken }, { deviceId: phone.identity.deviceId, token: phoneToken }, { deviceId: 'fixture_wrong_device', token: wrongToken }], pairs: [[host.identity.deviceId, phone.identity.deviceId]], stateFile: root + '/relay-state.json', logger: (event) => logs.push(event) });
  await relay.listen(); const origin = 'ws://127.0.0.1:' + relay.address().port;
  const hostPeer = await websocketPeer(origin, host.identity.deviceId, hostToken), phonePeer = await websocketPeer(origin, phone.identity.deviceId, phoneToken);
  const tunnelId = 'independent_tls_tunnel';
  phonePeer.send({ op: 'tunnel.open', tunnelId, toDeviceId: host.identity.deviceId, purpose: 'peer' });
  await until(() => hostPeer.messages.some((m) => m.op === 'tunnel.opened' && m.tunnelId === tunnelId) && phonePeer.messages.some((m) => m.op === 'tunnel.opened' && m.tunnelId === tunnelId), 'paired actual relay tunnel');
  const pipe = (peer) => {
    const stream = new Duplex({ read() {}, write(chunk, encoding, callback) {
      try { for (let offset = 0; offset < chunk.length; offset += 32 * 1024) peer.send({ op: 'tunnel.data', tunnelId, data: chunk.subarray(offset, offset + 32 * 1024).toString('base64') }); callback(); } catch (error) { callback(error); }
    } });
    peer.subscribe((frame) => { if (frame.tunnelId !== tunnelId) return; if (frame.op === 'tunnel.data') stream.push(Buffer.from(frame.data, 'base64')); else if (frame.op === 'tunnel.closed') stream.destroy(); });
    return stream;
  };
  const context = { hostInstanceId: 'real_relay_boot', remoteSessionId: 'real_relay_handle', grantVersion: 1 };
  const server = createSecureChannel({ role: 'server', transport: pipe(hostPeer), credentials: host.credentials, peerPin: phone.identity.spkiSha256, context, replayGuard: createReplayGuard() });
  const client = createSecureChannel({ role: 'client', transport: pipe(phonePeer), credentials: phone.credentials, peerPin: host.identity.spkiSha256, context, replayGuard: createReplayGuard() });
  const frames = [];
  server.onMessage((frame) => { frames.push(frame); }); client.onMessage(() => {});
  await Promise.all([server.ready, client.ready]);
  return { relay, origin, host, phone, server, client, frames, logs, hostPeer, phonePeer, context, hostToken, phoneToken, wrongToken,
    async close() { server.close(); client.close(); hostPeer.close(); phonePeer.close(); await relay.close(); } };
}
