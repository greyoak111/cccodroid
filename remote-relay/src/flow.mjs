// No message body or identifier is inspected by the scheduler.
export class TokenBucket {
  constructor({ rate, burst = rate, now = Date.now }) {
    if (!(rate > 0) || !(burst > 0)) throw new TypeError('invalid_bucket');
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.now = now;
    this.updatedAt = now();
  }

  take(cost = 1) {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, now - this.updatedAt) * this.rate / 1000);
    this.updatedAt = Math.max(this.updatedAt, now);
    if (cost > this.tokens) return false;
    this.tokens -= cost;
    return true;
  }
}

export class PriorityOutbox {
  constructor({ socket, maxBytes = 512 * 1024, maxItems = 128, highReserveBytes = 128 * 1024,
    highReserveItems = 16, maxSocketBytes = 64 * 1024, sendBytesPerSecond = 256 * 1024,
    burstBytes = 64 * 1024, now = Date.now, onResult = () => {}, onClose = () => {},
    pollIntervalMs = 10 }) {
    if (maxBytes <= 0 || maxItems <= 0 || highReserveBytes >= maxBytes ||
        highReserveItems >= maxItems || maxSocketBytes <= 0) throw new TypeError('invalid_outbox_limits');
    this.socket = socket;
    this.limits = { maxBytes, maxItems, highReserveBytes, highReserveItems, maxSocketBytes };
    this.queues = [[], [], []];
    this.bytes = 0;
    this.items = 0;
    this.inFlight = null;
    this.now = now;
    this.onResult = onResult;
    this.onClose = onClose;
    this.closed = false;
    this.timer = null;
    this.pollIntervalMs = pollIntervalMs;
    this.bucket = new TokenBucket({ rate: sendBytesPerSecond, burst: burstBytes, now });
  }

  enqueue({ data, priority = 1, expiresAt, metadata }) {
    if (this.closed) return { ok: false, code: 'peer_offline' };
    this.pruneExpired();
    const bytes = Buffer.byteLength(data);
    if (![0, 1, 2].includes(priority) || !Number.isSafeInteger(expiresAt) || bytes > this.bucket.burst) {
      return { ok: false, code: 'frame_too_large' };
    }
    if (expiresAt <= this.now()) return { ok: false, code: 'expired' };
    const byteLimit = this.limits.maxBytes - (priority === 0 ? 0 : this.limits.highReserveBytes);
    const itemLimit = this.limits.maxItems - (priority === 0 ? 0 : this.limits.highReserveItems);
    if (this.bytes + bytes > byteLimit || this.items + 1 > itemLimit) {
      return { ok: false, code: 'backpressure' };
    }
    this.queues[priority].push({ data, bytes, expiresAt, metadata });
    this.bytes += bytes;
    this.items++;
    this.schedule();
    return { ok: true };
  }

  schedule() {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  pruneExpired() {
    const expired = [];
    for (let index = 0; index < this.queues.length; index++) {
      const keep = [];
      for (const item of this.queues[index]) {
        if (item.expiresAt > this.now()) keep.push(item);
        else { this.bytes -= item.bytes; this.items--; expired.push(item); }
      }
      this.queues[index] = keep;
    }
    for (const item of expired) this.onResult(item.metadata, 'expired');
  }

  pump() {
    if (this.closed || this.inFlight) return;
    if (this.socket.readyState !== 1) return this.close('peer_offline');
    this.pruneExpired();
    const queue = this.queues.find(q => q.length);
    if (!queue) return;
    const item = queue[0];
    // At most one frame is committed to ws/TCP at a time. Waiting high-priority
    // controls can overtake all application-queued history, not an in-flight frame.
    if (this.socket.bufferedAmount + item.bytes > this.limits.maxSocketBytes || !this.bucket.take(item.bytes)) {
      this.schedule();
      return;
    }
    queue.shift();
    this.inFlight = item;
    try {
      this.socket.send(item.data, { binary: false, compress: false }, error => {
        if (this.inFlight !== item) return;
        this.inFlight = null;
        this.bytes -= item.bytes;
        this.items--;
        this.onResult(item.metadata, error ? 'peer_offline' : 'forwarded');
        if (error) this.close('peer_offline');
        else this.schedule();
      });
    } catch {
      this.inFlight = null;
      this.bytes -= item.bytes;
      this.items--;
      this.onResult(item.metadata, 'peer_offline');
      this.close('peer_offline');
    }
  }

  cancel(predicate, code = 'route_inactive') {
    const removed = [];
    for (let index = 0; index < this.queues.length; index++) {
      const keep = [];
      for (const item of this.queues[index]) {
        if (!predicate(item.metadata)) keep.push(item);
        else { this.bytes -= item.bytes; this.items--; removed.push(item); }
      }
      this.queues[index] = keep;
    }
    // Notify only after detaching; callbacks may synchronously cancel another
    // route/tunnel and must not observe the same queued item twice.
    for (const item of removed) this.onResult(item.metadata, code);
  }

  close(code = 'peer_offline') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    const pending = [...this.queues.flat(), ...(this.inFlight ? [this.inFlight] : [])];
    this.queues = [[], [], []];
    this.inFlight = null;
    this.bytes = 0;
    this.items = 0;
    for (const item of pending) this.onResult(item.metadata, code);
    this.onClose(code);
  }

  stats() {
    return { queuedBytes: this.bytes, queuedItems: this.items, inFlight: Boolean(this.inFlight) };
  }
}
