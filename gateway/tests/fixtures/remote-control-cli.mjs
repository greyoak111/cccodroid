// Disposable stream-json execution endpoint for the real App's startRun.
// It never imports an SDK, connects to an API, reads a project, or runs tools.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

if (process.env.CCAPP_TEST !== '1' || !process.env.REMOTE_CONTROL_FIXTURE) throw new Error('Isolated fixture environment required');
const root = process.env.REMOTE_CONTROL_FIXTURE;
const marker = path.join(root, `${process.env.CCAPP_RUN_ID}.jsonl`);
const argv = process.argv.slice(2);
const sessionId = argv[argv.indexOf('--resume') + 1] || 'fixture-session';
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const record = (event) => fs.appendFileSync(marker, JSON.stringify(event) + '\n');
let count = 0, asked = false;
record({ fixture: 'started', sessionId, argv });
const requests = [
  { id: 'fixture-bash', tool: 'Bash', input: { command: 'printf fixture-only', description: 'Never actually executed' } },
  { id: 'fixture-question', tool: 'AskUserQuestion', input: { questions: [
    { question: 'Which original option?', header: 'Fixture', multiSelect: false, options: [{ label: 'Keep', description: 'Original choice' }, { label: 'Change' }] },
    { question: 'Any original note?', header: 'Note', multiSelect: false, options: [{ label: 'No' }] },
  ] } },
  { id: 'fixture-plan', tool: 'ExitPlanMode', input: { plan: '1. Review original fixture\n2. Confirm every subsequent tool' } },
  { id: 'fixture-guard', tool: 'Read', input: { file_path: '/fixture/only' }, guard: 'cccodroid-guard|device:clipboard|fixture clipboard guard' },
  { id: 'fixture-guard-again', tool: 'Read', input: { file_path: '/fixture/only-again' }, guard: 'cccodroid-guard|device:clipboard|second fixture clipboard guard' },
];
function ask(index) {
  const request = requests[index];
  emit({ type: 'control_request', request_id: request.id, request: { subtype: 'can_use_tool', tool_name: request.tool,
    input: request.input, tool_use_id: `tool-${request.id}`, permission_suggestions: [], requires_user_interaction: true,
    ...(request.guard ? { decision_reason_type: 'hook', decision_reason: request.guard } : {}) } });
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let event; try { event = JSON.parse(line); } catch { process.exitCode = 95; return; }
  record(event);
  if (event.type === 'user') {
    const content = event.message?.content;
    const userText = typeof content === 'string' ? content : (content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (userText.includes('__fixture_close_without_replay__')) {
      record({ fixture: 'closed-without-replay' }); process.exit(0);
    }
    if (!count++) emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fixture-model', permissionMode: 'default', claude_code_version: 'fixture-only' });
    // This is the replay-user-messages acknowledgement the real App consumes.
    emit({ type: 'user', isReplay: true, message: event.message, uuid: `fixture-user-${count}` });
    if (!asked) { asked = true; ask(0); }
    return;
  }
  if (event.type === 'control_response') {
    const index = requests.findIndex((r) => r.id === event.response?.request_id);
    if (index >= 0 && index + 1 < requests.length) ask(index + 1);
    return;
  }
  if (event.type === 'control_request') emit({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id } });
});
lines.on('close', () => { record({ fixture: 'stdin-closed' }); process.exit(0); });
