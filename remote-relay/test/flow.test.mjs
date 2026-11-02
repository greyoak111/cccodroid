import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityOutbox, TokenBucket } from '../src/flow.mjs';

function fakeSocket() {
  return { readyState: 1, bufferedAmount: 0, writes: [], callbacks: [],
    send(data, options, callback) { this.writes.push(data); this.callbacks.push(callback); } };
}
function outbox(socket, extra = {}) {
  return new PriorityOutbox({ socket, maxBytes: 1000, highReserveBytes: 200, maxItems: 10,
    highReserveItems: 2, maxSocketBytes: 1000, sendBytesPerSecond: 10000, burstBytes: 1000,
    now: () => 100, pollIntervalMs: 60000, ...extra });
}

test('token bucket limits bursts and does not refill when clock moves backwards', () => {
  let now = 1000;
  const bucket = new TokenBucket({ rate: 10, burst: 20, now: () => now });
  assert.equal(bucket.take(20), true);
  assert.equal(bucket.take(), false);
  now += 500;
  assert.equal(bucket.take(5), true);
  now -= 1000;
  assert.equal(bucket.take(), false);
  now = 2000;
  assert.equal(bucket.take(5), true);
});

test('controls and receipts overtake queued history; only one frame enters TCP', () => {
  const socket = fakeSocket();
  const queue = outbox(socket);
  queue.enqueue({ data: 'history', priority: 2, expiresAt: 1000 });
  queue.enqueue({ data: 'event', priority: 1, expiresAt: 1000 });
  queue.enqueue({ data: 'stop', priority: 0, expiresAt: 1000 });
  queue.pump();
  assert.deepEqual(socket.writes, ['stop']);
  queue.pump();
  assert.deepEqual(socket.writes, ['stop']);
  socket.callbacks.shift()();
  queue.pump();
  assert.deepEqual(socket.writes, ['stop', 'event']);
  socket.callbacks.shift()();
  queue.pump();
  assert.deepEqual(socket.writes, ['stop', 'event', 'history']);
  socket.callbacks.shift()();
  assert.deepEqual(queue.stats(), { queuedBytes: 0, queuedItems: 0, inFlight: false });
  queue.close();
});

test('low priority cannot consume reserved capacity; all queues remain bounded', () => {
  const queue = outbox(fakeSocket());
  assert.equal(queue.enqueue({ data: 'x'.repeat(800), priority: 2, expiresAt: 1000 }).ok, true);
  assert.equal(queue.enqueue({ data: 'x', priority: 2, expiresAt: 1000 }).code, 'backpressure');
  assert.equal(queue.enqueue({ data: 'x'.repeat(200), priority: 0, expiresAt: 1000 }).ok, true);
  assert.equal(queue.enqueue({ data: 'x', priority: 0, expiresAt: 1000 }).code, 'backpressure');
  assert.equal(queue.stats().queuedBytes, 1000);
  queue.close();
});

test('slow socket is not filled; expiry and route cancellation report rejection', () => {
  let now = 100;
  const socket = fakeSocket();
  socket.bufferedAmount = 1000;
  const results = [];
  const queue = outbox(socket, { now: () => now, onResult: (metadata, code) => results.push([metadata, code]) });
  queue.enqueue({ data: 'expired', expiresAt: 110, metadata: 'a' });
  queue.enqueue({ data: 'cancelled', expiresAt: 1000, metadata: 'b' });
  queue.pump();
  assert.equal(socket.writes.length, 0);
  now = 120;
  queue.pump();
  queue.cancel(metadata => metadata === 'b');
  assert.deepEqual(results, [['a', 'expired'], ['b', 'route_inactive']]);
  assert.equal(queue.stats().queuedBytes, 0);
  queue.close();
});
