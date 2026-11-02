import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PriorityOutbox } from '../src/flow.mjs';
import { tunnelFixture, peerTunnel } from './tunnel-helpers.mjs';

// An isolated deterministic slow-receiver fixture; not a WAN 3 Mbps result.
test('slow peer data has fixed queue bounds and closes the whole TLS tunnel on overflow', async t => {
  const outboxes = [];
  const fx = await tunnelFixture(t, { pairs: [['tablet', 'phone']], outboxFactory(options) {
    const outbox = new PriorityOutbox(options);
    outboxes.push(outbox); return outbox;
  } });
  const tablet = await fx.connect('tablet'), phone = await fx.connect('phone');
  await peerTunnel(tablet, phone);
  const tabletOutbox = outboxes[0];
  const originalPump = tabletOutbox.pump;
  tabletOutbox.pump = () => {}; // Simulate an indefinitely stalled receiver.
  const payload = randomBytes(32 * 1024).toString('base64');
  for (let index = 0; index < 11; index++) {
    phone.send({ v: 1, op: 'tunnel.data', tunnelId: 'peer-test', data: payload });
    // Keep the source within its token bucket; no operating-system net shaping.
    if (index % 2 === 1) await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(tabletOutbox.stats().queuedBytes <= 512 * 1024);
    assert.ok(tabletOutbox.stats().queuedItems <= 128);
  }
  const rejection = await phone.next(value => value.op === 'error' && ['backpressure', 'tunnel_missing'].includes(value.code));
  assert.ok(rejection);
  assert.equal(fx.relay.stats().tunnels, 0);
  assert.ok(tabletOutbox.stats().queuedBytes <= 128 * 1024); // Only high-priority close remains.
  tabletOutbox.pump = originalPump;
  tabletOutbox.pump();
});

test('receive burst and oversized WebSocket frame close instead of accumulating', async t => {
  const fx = await tunnelFixture(t, { limits: { messagesPerSecond: 1, messageBurst: 2 } });
  const phone = await fx.connect('phone');
  for (let index = 0; index < 10; index++) phone.send({ v: 1, op: 'ping' });
  assert.equal((await phone.closed).code, 1008);
  const tablet = await fx.connect('tablet');
  tablet.ws.send('x'.repeat(65537));
  assert.equal((await tablet.closed).code, 1009);
  assert.equal(fx.relay.stats().tunnels, 0);
});
