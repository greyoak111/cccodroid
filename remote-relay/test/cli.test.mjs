import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { main, readPrivateConfig } from '../src/cli.mjs';
import { testDevices } from './helpers.mjs';

async function configFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = join(directory, 'config.json');
  const devices = testDevices();
  const config = { devices, pairs: [['tablet', 'phone']], stateFile: join(directory, 'state.json'), port: 0 };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  return { directory, configFile, config };
}

test('private config refuses unsafe permissions and does not surface sensitive parse messages', async t => {
  const { configFile, config } = await configFixture(t);
  assert.deepEqual(await readPrivateConfig(configFile), config);
  await chmod(configFile, 0o644);
  await assert.rejects(readPrivateConfig(configFile), /unsafe_config_file/);
  const errors = [];
  const result = await main(['--config', configFile], { errorOutput: line => errors.push(line) });
  assert.equal(result.exitCode, 1);
  assert.equal(errors.join('').includes(config.devices[0].token), false);
});

test('standalone command starts only its random-port relay and shuts down with SIGTERM', async t => {
  const { configFile, config } = await configFixture(t);
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, '--config', configFile], {
    env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  let errors = '';
  child.stderr.on('data', data => { errors += data.toString(); });
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('cli_timeout')); }, 5000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`early_exit:${code}`)); });
    child.stdout.on('data', data => {
      output += data.toString();
      for (const line of output.split('\n')) {
        try { const record = JSON.parse(line); if (record.event === 'relay_listening') { clearTimeout(timeout); resolve(record); } }
        catch {}
      }
    });
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(response.status, 200);
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve([code, signal])));
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  for (const device of config.devices) assert.equal((output + errors).includes(device.token), false);
});
