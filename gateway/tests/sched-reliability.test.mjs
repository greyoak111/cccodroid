import { test } from "node:test";
import { AT, NOW, DB, INTR, LOG, MARK, fixture } from "./queue-sched-fixture.mjs";

const task = (id, over = {}) => ({ id, name: id, prompt: "synthetic task", on: true, nextAt: AT,
  freq: { kind: "daily", time: "09:00" }, busy: "queue", missed: "ask", notify: "none", ...over });
const once = { kind: "once", date: "2026-11-20", time: "09:00" };
const db = (tasks, more = {}) => ({ tasks, allowLogin: true, monthlySeeded: true, lastTick: NOW - 30_000, ...more });
const scheduleFixture = (t) => fixture(t, { sched: true });

test("waiting plans are durable before nextAt advances, then recover with ask/run/skip policies", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("ask-once", { freq: once }), task("run-daily", { missed: "run" }),
    task("skip-daily", { missed: "skip" }), task("run-once", { missed: "run", freq: once })]));
  f.boot(`
    fillSlots(); S.tick(AT); S.tick(AT);
    const disk = get(DB);
    assert.deepEqual(disk.pending.map((o) => [o.taskId, o.at]), [['ask-once', AT], ['run-daily', AT], ['skip-daily', AT], ['run-once', AT]]);
    assert.equal(disk.tasks[0].nextAt, null);
    assert.equal(disk.tasks[3].nextAt, null);
    assert.ok(disk.tasks[1].nextAt > NOW);
    assert.deepEqual(scheduled(), []);
    assert.ok(S.running().every((x) => x.waiting));
  `);
  f.boot(`
    Q.recoverRunMark(); fillSlots();
    for (const id of ['run-daily', 'run-once']) S.DB.tasks.find((x) => x.id === id).busy = 'run';
    S.tick(AT); await defer(); S.tick(AT);
    assert.deepEqual(get(DB).pending, []);
    assert.deepEqual(get(DB).missed, [{ taskId: 'ask-once', at: AT }]);
    assert.deepEqual(get(LOG).map((r) => [r.taskId, r.at, r.st]), [['skip-daily', AT, 'skip']]);
    assert.deepEqual(scheduled().map((q) => [q.sched.taskId, q.sched.scheduledAt]), [['run-daily', AT], ['run-once', AT]]);
    assert.ok(scheduled().every((q) => !q.held && q.unattended));
  `);
  f.boot(`
    Q.recoverRunMark(); fillSlots(); S.tick(AT); S.tick(AT);
    assert.deepEqual(get(DB).missed, [{ taskId: 'ask-once', at: AT }]);
    assert.equal(get(LOG).length, 1, 'held scheduled work is not reported as a second missed run');
    assert.deepEqual(scheduled().map((q) => [q.sched.taskId, q.held]), [['run-daily', true], ['run-once', true]]);
  `);
});

test("a failed occurrence write neither advances the alarm nor enqueues a turn", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("due", { busy: "run" })]));
  f.boot(`
    fillSlots();
    const undo = failingRename((file) => file === DB);
    S.tick(AT);
    assert.equal(S.DB.tasks[0].nextAt, AT); assert.equal(get(DB).tasks[0].nextAt, AT);
    assert.equal(Number(fs.readFileSync('ccapp-sched-next')), AT);
    assert.deepEqual(scheduled(), []);
    undo(); S.tick(AT);
    assert.ok(get(DB).tasks[0].nextAt > NOW);
    assert.equal(get(MARK).queue.filter((x) => x.sched?.scheduledAt === AT).length, 1);
    assert.deepEqual(get(DB).pending, []);
  `);
});

test("a failed occurrence commit does not turn an ask-policy miss into a due turn", (t) => {
  const f = scheduleFixture(t);
  const missedAt = AT - 10 * 60_000, lastTick = NOW - 20 * 60_000;
  f.put(DB, db([task("ask", { nextAt: missedAt, busy: "run" })], { lastTick }));
  f.boot(`
    fillSlots();
    failingRename((file, src) => file === DB && JSON.parse(fs.readFileSync(src)).pending.length > 0);
    S.tick();
    assert.equal(get(DB).tasks[0].nextAt, ${missedAt});
    assert.deepEqual(scheduled(), []);
  `);
  f.boot(`
    fillSlots(); S.tick();
    assert.deepEqual(scheduled(), []);
    assert.deepEqual(get(DB).missed, [{ taskId: 'ask', at: ${missedAt} }]);
    assert.deepEqual(get(DB).pending, []);
  `);
});

test("a queue checkpoint failure leaves the same occurrence eligible for recovery", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("due", { busy: "run", missed: "run" })]));
  f.boot(`
    fillSlots(); failingRename((file) => file === MARK); S.tick(AT);
    assert.deepEqual(scheduled(), []);
    assert.deepEqual(get(DB).pending, [{ taskId: 'due', at: AT }]);
  `);
  f.boot(`
    Q.recoverRunMark(); fillSlots(); S.tick(); await defer(); S.tick();
    assert.equal(scheduled('due').length, 1);
    assert.equal(scheduled('due')[0].sched.scheduledAt, AT);
    assert.deepEqual(get(DB).pending, []);
  `);
});

test("failure to commit handoff cannot publish or activate the queue copy; live retry stays due", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("due", { busy: "run", missed: "ask" })]));
  f.put(MARK, { queue: [{ id: "prior", message: "leave this held" }] });
  f.boot(`
    Q.recoverRunMark();
    const published = [], activated = [];
    onPublish((e) => { if (e.type === 'state') published.push(...e.queue.filter((q) => q.sched)); });
    // Observe pump after the real schedule guard, but do not start a CLI turn.
    Q.START_GUARDS.push((q) => {
      activated.push({ q, pending: get(DB).pending, stored: get(MARK).queue.map((x) => x.id) });
      return false;
    });
    const undo = failingRename((file, src) => file === DB && JSON.parse(fs.readFileSync(src)).pending.length === 0);
    S.tick(AT);
    assert.deepEqual(scheduled(), []); assert.deepEqual(published, []); assert.deepEqual(activated, []);
    assert.deepEqual(get(DB).pending, [{ taskId: 'due', at: AT }]);
    await defer(); undo(); S.tick();
    assert.equal(published.length, 1); assert.equal(activated.length, 1);
    const { q, pending, stored } = activated[0];
    assert.equal(q.sched.scheduledAt, AT); assert.deepEqual(pending, []); assert.ok(stored.includes(q.id));
    assert.deepEqual(Q.QUEUE.map((q) => [q.id, q.held]), [['prior', true]]);
    await defer(); S.tick();
    assert.equal(activated.length, 1);
  `);
});

test("restart in the handoff window restores one held queue entry instead of replaying it", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("due", { busy: "run", missed: "run" })]));
  f.boot(`
    const rename = fs.renameSync;
    fs.renameSync = (a, b) => {
      if (path.basename(b) === DB && JSON.parse(fs.readFileSync(a)).pending?.length === 0) process.exit(0);
      return rename(a, b);
    };
    S.tick(AT);
    assert.fail('expected the process to end between queue checkpoint and handoff commit');
  `);
  f.boot(`
    assert.equal(get(MARK).queue.length, 1); assert.equal(get(DB).pending.length, 1);
    const id = get(MARK).queue[0].id;
    const attempted = [];
    Q.START_GUARDS.unshift((q) => { attempted.push(q.id); return false; });
    Q.recoverRunMark(); S.tick(); Q.pump();
    assert.deepEqual(get(DB).pending, []);
    assert.deepEqual(scheduled('due').map((q) => [q.id, q.held]), [[id, true]]);
    assert.deepEqual(attempted, []);
    assert.equal(RUNS.size, 0);
  `);
});

test("ambiguous started turns are not replayed even when ledger cleanup fails across another restart", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("started", { missed: "run", busy: "run", freq: once, nextAt: null }),
    task("finished", { missed: "run", busy: "run", nextAt: AT + 86_400_000 })],
  { pending: ["started", "finished"].map((taskId) => ({ taskId, at: AT })) }));
  f.put(MARK, { runs: [
    { id: "first", text: "may already have run", startedAt: AT, sched: { taskId: "started", scheduledAt: AT, key: "start-key" } },
    { id: "completed", text: "already done", done: true, startedAt: AT, sched: { taskId: "finished", scheduledAt: AT, key: "done-key" } },
  ] });
  f.boot(`
    failingRename((file) => file === DB || file === INTR);
    Q.recoverRunMark(); Q.publishState();
    assert.deepEqual(get(MARK).schedHandoffs.map((x) => x.taskId), ['started', 'finished']);
    assert.equal(get(LOG).filter((x) => x.runId === 'first' && x.st === 'err').length, 1);
  `);
  f.boot(`
    Q.recoverRunMark(); fillSlots(); S.tick(); S.tick();
    assert.deepEqual(get(DB).pending, []); assert.equal(get(DB).tasks[0].on, false);
    assert.equal(scheduled().length, 0); assert.equal(get(INTR).filter((x) => x.id === 'first').length, 1);
    assert.deepEqual(get(LOG).map((r) => [r.runId, r.st]), [['first', 'err']]);
  `);
});

test("discarding a recovered queue entry cannot turn it back into an automatic missed run", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("due", { missed: "run", busy: "run", nextAt: AT + 86_400_000 })],
    { pending: [{ taskId: "due", at: AT }] }));
  f.put(MARK, { queue: [{ id: "held", message: "synthetic task", sched: { taskId: "due", scheduledAt: AT, key: "held-key" } }] });
  f.boot(`
    failingRename((file) => file === DB);
    Q.recoverRunMark();
    assert.equal(scheduled('due')[0].held, true);
    await route(Q.routeQueue, 'POST', '/api/queue/remove', { id: 'held' });
    assert.deepEqual(get(MARK).queue, []);
    assert.deepEqual(get(MARK).schedHandoffs, [{ taskId: 'due', scheduledAt: AT, started: false }]);
    fillSlots(); S.tick(); assert.deepEqual(scheduled(), []);
  `);
  f.boot(`
    Q.recoverRunMark(); fillSlots(); S.tick();
    assert.deepEqual(get(DB).pending, []);
    assert.deepEqual(scheduled(), []);
  `);
});

test("a persisted skip is not repeated if the process stops before receipt cleanup", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("skip", { busy: "run", missed: "run", skipNext: true, skipAt: AT })]));
  f.boot(`
    failingRename((file, src) => file === DB && JSON.parse(fs.readFileSync(src)).pending.length === 0);
    S.tick(AT); assert.equal(get(LOG).length, 1); assert.equal(get(DB).pending.length, 1);
  `);
  f.boot(`
    Q.recoverRunMark(); fillSlots(); S.tick();
    assert.equal(get(DB).tasks[0].skipNext, false); assert.deepEqual(get(DB).pending, []);
    assert.deepEqual(scheduled(), []); assert.equal(get(LOG).length, 1);
  `);
});

test("explicit disable or pause is durable and re-enabling does not restore cancelled waiting work", (t) => {
  const f = scheduleFixture(t);
  f.put(DB, db([task("toggle", { missed: "run" }), task("pause", { missed: "run" })]));
  f.boot(`
    fillSlots(); S.tick(AT);
    assert.equal(get(DB).pending.length, 2);
    await route(routeSched, 'PATCH', '/api/sched/toggle', { on: false });
    await route(routeSched, 'PATCH', '/api/sched/toggle', { on: true });
    await route(routeSched, 'POST', '/api/sched/pause/pause', { mode: '1d' });
    await route(routeSched, 'POST', '/api/sched/pause/pause', { mode: 'none' });
    assert.deepEqual(get(DB).pending, []);
  `);
  f.boot(`
    Q.recoverRunMark(); fillSlots(); S.tick();
    assert.deepEqual(scheduled(), []);
  `);
});
