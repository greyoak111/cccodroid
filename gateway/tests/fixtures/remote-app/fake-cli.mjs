// Disposable stream-json execution endpoint, not a model or a shell.
// It exists to exercise the real startRun/parser/answerPerm/abortRun chain.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (process.env.CCAPP_TEST !== '1' || !process.env.CCAPP_REMOTE_FIXTURE_DIR) throw new Error('Isolated remote fixture only');
const root = process.env.CCAPP_REMOTE_FIXTURE_DIR;
const runId = process.env.CCAPP_RUN_ID;
const args = process.argv.slice(2);
const sid = args[args.indexOf('--resume') + 1] || 'remote-fixture-original';
const record = (ev) => fs.appendFileSync(path.join(root, 'child-events.jsonl'), JSON.stringify({ runId, ...ev }) + '\n');
const send = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const transcript = path.join(process.env.HOME, '.claude', 'projects', 'remote-fixture', sid + '.jsonl');
fs.mkdirSync(path.dirname(transcript), { recursive: true });
let initialized = false, serial = 0, lastSignal = '', current = null;
const emitText = (text) => {
  send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  const committed = { type: 'assistant', uuid: `${runId}-a-${++serial}`, sessionId: sid, message: { role: 'assistant', content: [{ type: 'text', text }] } };
  fs.appendFileSync(transcript, JSON.stringify(committed) + '\n');
  send(committed);
};
const request = (tool, input, suffix = tool) => {
  const requestId = `${runId}-${suffix}-${++serial}`;
  current = { requestId, tool, input };
  record({ kind: 'request', ...current });
  send({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: tool, tool_use_id: 'fixture-tool-' + serial, input, description: 'Synthetic scope, never actually executed', requires_user_interaction: tool === 'AskUserQuestion' || tool === 'ExitPlanMode' } });
};
const finish = () => {
  record({ kind: 'finish' });
  send({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'Synthetic original run finished', usage: { input_tokens: 1, output_tokens: 1 } });
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === 'user') {
    record({ kind: 'user', message: ev.message });
    if (!initialized) {
      initialized = true;
      send({ type: 'system', subtype: 'init', session_id: sid, model: 'fixture-model', permissionMode: 'default', claude_code_version: 'fixture-only' });
      fs.appendFileSync(transcript, JSON.stringify({ type: 'user', uuid: `${runId}-u`, sessionId: sid, cwd: process.cwd(), message: ev.message }) + '\n');
      send({ type: 'user', isReplay: true, session_id: sid, message: ev.message });
      request('Bash', { command: 'printf remote-fixture-only', description: 'Synthetic command; fake CLI does not execute it' });
    } else { send({ type: 'user', isReplay: true, session_id: sid, message: ev.message }); emitText('Synthetic additional text received in original session.'); }
  } else if (ev.type === 'control_request') {
    record({ kind: 'host_control_request', request: ev.request });
    send({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: {} } });
  } else if (ev.type === 'control_response') {
    record({ kind: 'control_response', response: ev.response });
    if (current && ev.response?.request_id === current.requestId) {
      current = null;
      emitText(ev.response.response?.behavior === 'allow' ? 'Original execution continued after one-time approval.' : 'Original execution continued after denial.');
    }
  }
});
input.on('close', () => process.exit(0));
const timer = setInterval(() => {
  try {
    const text = fs.readFileSync(path.join(root, 'signals', runId + '.json'), 'utf8');
    if (lastSignal === text) return;
    lastSignal = text;
    const ev = JSON.parse(text);
    if (ev.kind === 'finish') finish();
    else if (ev.kind === 'cancel' && current) { send({ type: 'control_cancel_request', request_id: current.requestId }); current = null; }
    else if (ev.kind === 'request') request(ev.tool, ev.input, ev.tag || ev.tool);
    else if (ev.kind === 'text') emitText(ev.text);
  } catch (error) { if (error.code !== 'ENOENT') record({ kind: 'fixture_error', message: error.message }); }
}, 20);
setTimeout(() => { clearInterval(timer); process.exit(98); }, 90_000).unref();
