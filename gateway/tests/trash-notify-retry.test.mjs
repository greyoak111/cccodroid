import { test } from "node:test";
import { DB, INTR, MARK, fixture } from "./queue-sched-fixture.mjs";

const SID = "trash-retry-session";
const INCOMPLETE = "ccapp-incomplete.json";
const setup = `
  const sid = ${JSON.stringify(SID)}, incomplete = ${JSON.stringify(INCOMPLETE)};
  const meta = path.join('.ccapp-trash', sid, 'meta.json');
  const ops = await import(new URL('sessionops.mjs', gw));
  const { incompleteOf, markIncomplete } = await import(new URL('incomplete.mjs', gw));
`;

test("回收通知的写盘失败可以重试，不把仅在内存里的移除当作完成", (t) => {
  for (const file of [MARK, INTR, INCOMPLETE, DB]) {
    const f = fixture(t, { sched: true });
    f.put(DB, { tasks: [{ id: "task", on: false, lastSid: SID, lostSid: "previous" }], monthlySeeded: true });
    f.boot(setup + `
      openSession(sid);
      const keep = { id: 'keep', message: 'another session', held: true };
      const receipt = { id: 'keep-receipt' };
      Q.QUEUE.push(keep, { id: 'remove', sessionId: sid, message: 'fixture', held: true });
      assert(Q.setInterrupted([receipt, { id: 'old', sessionId: sid }]));
      assert(markIncomplete(sid, 'old'));
      assert(Q.publishState());
      const file = ${JSON.stringify(file)}, before = fs.readFileSync(file, 'utf8');
      const undo = failingRename((dest) => dest === file);
      assert.throws(() => ops.trashSession(sid), undefined, file);
      assert.equal(get(meta).tx.phase, 'notify', file);
      assert.equal(fs.readFileSync(file, 'utf8'), before, file);
      assert.deepEqual(Q.QUEUE, [keep]);
      assert.deepEqual(Q.INTERRUPTED, [receipt]);
      assert.equal(incompleteOf(sid), null);
      if (file === DB) {
        assert.equal(S.DB.tasks[0].lastSid, sid);
        assert.equal(S.DB.tasks[0].lostSid, 'previous');
      }
      assert.throws(() => ops.restoreSession(sid), undefined, file);
      assert.equal(get(meta).tx.phase, 'notify', file);
      undo();
      ops.recoverTrash();
      assert.equal(get(meta).tx.phase, 'ready', file);
      assert.deepEqual(get(MARK).queue, [keep]);
      assert.deepEqual(get(INTR), [receipt]);
      assert.equal(get(incomplete)[sid], undefined);
      assert.equal(get(DB).tasks[0].lostSid, sid);
      assert.equal(get(DB).tasks[0].lastSid, null);
      assert(ops.restoreSession(sid).ok);
    `);
  }
});

test("重启会落盘清除回收会话的旧中断记录，恢复后不会回来", (t) => {
  for (const queueFirst of [false, true]) {
    const f = fixture(t, { queueFirst });
    f.boot(setup + `
      openSession(sid);
      assert(Q.setInterrupted([{ id: 'old', sessionId: sid }]));
      const rename = fs.renameSync;
      fs.renameSync = (a, b) => {
        rename(a, b);
        if (path.relative(process.cwd(), b) === meta && get(meta).tx.phase === 'notify') process.exit(0);
      };
      ops.trashSession(sid);
      assert.fail('没在通知落盘后停止');
    `);
    f.boot(setup + `
      assert.equal(get(meta).tx.phase, 'notify');
      assert.equal(get(INTR)[0].sessionId, sid);
      // 先加载 queue 时历史检查已经可用，旧卡没露到内存里；先加载 providers 时留到通知清。
      assert.deepEqual(Q.INTERRUPTED.map((e) => e.id), ${queueFirst} ? [] : ['old']);
      ops.recoverTrash({ hooks: false });
      Q.recoverRunMark();
      ops.recoverTrash();
      assert.equal(get(meta).tx.phase, 'ready');
      assert.deepEqual(Q.INTERRUPTED, []);
      assert.equal(fs.existsSync(INTR), false);
      assert(ops.restoreSession(sid).ok);
    `);
    f.boot(`assert.deepEqual(Q.INTERRUPTED, []);`);
  }
});
