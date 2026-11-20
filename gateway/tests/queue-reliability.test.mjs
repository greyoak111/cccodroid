import { test } from "node:test";
import { fixture, INTR, MARK } from "./queue-sched-fixture.mjs";

const SID = "0b0e0000-0000-4000-8000-000000000001";
const old = { id: "previous", text: "previous prompt not in a transcript", startedAt: 1, unstarted: true,
  req: { model: "fixture" }, sideTools: ["Write fixture"] };

test("a transient receipt failure followed by an empty publish does not discard recovery", (t) => {
  const f = fixture(t);
  f.put(MARK, { run: old, stop: true }); // legacy single-run shape
  f.boot(`
    const undo = failingRename((file) => file === INTR);
    Q.recoverRunMark(); undo();
    assert.ok(fs.existsSync(MARK));
    Q.publishState();
  `);
  f.boot(`
    Q.recoverRunMark();
    const [entry] = Q.INTERRUPTED;
    assert.equal(Q.INTERRUPTED.length, 1);
    assert.equal(entry.id, 'previous'); assert.equal(entry.cause, 'stop'); assert.equal(entry.why, 'unstarted');
    assert.deepEqual(entry.req, { model: 'fixture' }); assert.deepEqual(entry.sideTools, ['Write fixture']);
    assert.equal(fs.existsSync(MARK), false);
  `);
});

test("a sustained receipt failure preserves old recovery, new active work and both queue entries across restarts", (t) => {
  const f = fixture(t);
  f.put(INTR, { id: "prior-card", text: "already saved card" }); // legacy singleton
  f.put(MARK, { stop: true, runs: [old], queue: [{ id: "old-q", message: "original queued prompt" }] });
  f.boot(`
    failingRename((file) => file === INTR);
    Q.recoverRunMark();
    assert.equal(Q.INTERRUPTED.at(-1).text, 'previous prompt not in a transcript');
    fillSlots();
    const newItem = Q.enqueue({ message: 'new queued prompt' });
    const mark = get(MARK);
    assert.equal(mark.runs.length, maxParallel());
    assert.deepEqual(mark.interrupted.map((x) => x.id), ['prior-card', 'previous']);
    assert.deepEqual(mark.queue.map((x) => x.id), ['old-q', newItem.id]);
  `);
  f.boot(`
    failingRename((file) => file === INTR);
    Q.recoverRunMark(); Q.publishState();
    assert.equal(Q.INTERRUPTED.find((x) => x.id === 'previous').cause, 'stop');
    assert.equal(Q.INTERRUPTED.filter((x) => x.id === 'previous').length, 1);
    assert.equal(get(MARK).interrupted.length, maxParallel() + 2);
  `);
  f.boot(`
    Q.recoverRunMark(); Q.pump();
    assert.equal(RUNS.size, 0);
    assert.equal(get(INTR).length, maxParallel() + 2);
    assert.deepEqual(Q.QUEUE.map((q) => [q.message, q.held]), [['original queued prompt', true], ['new queued prompt', true]]);
    assert.equal('interrupted' in get(MARK), false);
  `);
});

test("the fallback does not resurrect a dismissed receipt after the old receipt file cannot be removed", (t) => {
  const f = fixture(t);
  f.put(INTR, [old]);
  f.boot(`
    const rm = fs.rmSync;
    fs.rmSync = (file, ...args) => { if (path.basename(file) === INTR) throw new Error('fixture'); return rm(file, ...args); };
    await route(Q.routeQueue, 'POST', '/api/interrupted/dismiss', { id: 'previous' });
    assert.deepEqual(get(MARK).interrupted, []);
  `);
  f.boot(`
    Q.recoverRunMark();
    assert.deepEqual(Q.INTERRUPTED, []);
    assert.equal(fs.existsSync(INTR), false); assert.equal(fs.existsSync(MARK), false);
  `);
});

test("a crash between primary receipt commit and mark cleanup does not resurrect an older fallback", (t) => {
  const f = fixture(t);
  f.put(MARK, { runs: [old], queue: [{ id: "existing-q", message: "keep the queued prompt" }] });
  f.boot(`
    const undo = failingRename((file) => file === INTR);
    Q.recoverRunMark(); Q.publishState(); undo();
    assert.equal(get(MARK).interrupted.length, 1);
    const rm = fs.rmSync;
    fs.rmSync = (file, ...args) => {
      const out = rm(file, ...args);
      if (path.basename(file) === INTR) process.exit(0);
      return out;
    };
    await route(Q.routeQueue, 'POST', '/api/interrupted/dismiss', { id: 'previous' });
    assert.fail('expected the process to end before mark cleanup');
  `);
  f.boot(`
    Q.recoverRunMark();
    assert.deepEqual(Q.INTERRUPTED, []);
    assert.equal(Q.QUEUE[0].message, 'keep the queued prompt');
  `);
});

test("recovered known-session lanes use the session for hold and occupancy even with free global slots", (t) => {
  const f = fixture(t);
  f.put(MARK, { runs: [{ id: "root", done: true, sessionId: SID }], queue: [
    { id: "first", sessionId: SID, lane: "n:ended", message: "first" },
    { id: "second", follow: "cancelled", lane: "n:root", message: "second" },
    { id: "third", lane: "s:" + SID, message: "third" },
    { id: "unknown", lane: "n:unestablished", follow: "unestablished", message: "new session" },
  ] });
  f.boot(`
    const sid = ${JSON.stringify(SID)};
    openSession(sid);
    Q.recoverRunMark();
    assert.deepEqual(Q.INTERRUPTED, [], 'a completed lane root is not an interruption');
    const [a, b, c, d] = Q.QUEUE;
    assert.deepEqual([a.lane, b.lane, c.lane, d.lane], ['s:' + sid, 's:' + sid, 's:' + sid, 'n:unestablished']);
    assert.equal(b.sessionId, sid); assert.equal(c.sessionId, sid);
    assert.deepEqual(get(MARK).queue.slice(0, 3).map((q) => q.lane), Array(3).fill('s:' + sid));
    assert.ok(Q.QUEUE.every((q) => q.held));
    const r = run('fresh-live', { sessionId: sid, lane: 'n:fresh-live' }); RUNS.set(r.id, r);
    assert.ok(RUNS.size < maxParallel());
    a.held = b.held = c.held = false;
    Q.pump();
    assert.deepEqual(Q.QUEUE.map((q) => q.id), ['first', 'second', 'third', 'unknown']);
    assert.deepEqual([...RUNS.keys()], [r.id]);
    Q.holdLane(r);
    assert.ok([a, b, c].every((q) => q.held));
  `);
});

test("a queue checkpoint canonicalizes the resolved session without changing its live new-session lane", (t) => {
  fixture(t).boot(`
    const sid = ${JSON.stringify(SID)};
    Q.RUN_SESSIONS.set('root', sid);
    const queued = { id: 'follower', lane: 'n:root', follow: 'cancelled', message: 'fixture', held: true };
    Q.QUEUE.push(queued); Q.publishState();
    const [stored] = get(MARK).queue;
    assert.equal(stored.sessionId, sid); assert.equal(stored.lane, 's:' + sid);
    assert.equal(queued.lane, 'n:root');
  `);
});

test("P2-1：清中断记录没落盘时如实失败，不带快照的旧 runs 不再下次复活", (t) => {
  const f = fixture(t);
  f.put(MARK, { runs: [{ id: "stale", text: "old prompt", startedAt: 1, unstarted: true }],
    queue: [{ id: "keep-q", message: "saved queued prompt" }] });
  // 第一次启动：INTR 能写、运行标记写不进 → 忽略操作必须失败，卡片与旧 runs 都还留着
  f.boot(`
    failingRename((file) => file === MARK);
    Q.recoverRunMark();
    assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ['stale']);
    assert.equal(Q.setInterrupted([]), false);
    assert.deepEqual(get(INTR).map((e) => e.id), ['stale']);
    assert.equal('interrupted' in get(MARK), false);
  `);
  // 第二次启动（存储恢复）：卡片还在（上次忽略确实没落盘），这次忽略成功，旧 runs 随标记重写一并清掉
  f.boot(`
    Q.recoverRunMark();
    assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ['stale']);
    assert.equal(Q.setInterrupted([]), true);
    assert.equal(fs.existsSync(INTR), false);
    assert.deepEqual(get(MARK).runs, []);
  `);
  // 第三次启动：卡片不复活
  f.boot(`
    Q.recoverRunMark();
    assert.deepEqual(Q.INTERRUPTED, []);
  `);
});
