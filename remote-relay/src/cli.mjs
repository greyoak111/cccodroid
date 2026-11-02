import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import { createTunnelRelayServer } from './tunnel-server.mjs';
import { exact } from './validation.mjs';

export async function readPrivateConfig(path) {
  if (!path || !isAbsolute(path)) throw new Error('absolute_config_path_required');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 64 * 1024) {
    throw new Error('unsafe_config_file');
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let text;
  try {
    const current = await file.stat();
    if (!current.isFile() || (current.mode & 0o077) || current.size > 64 * 1024) throw new Error('unsafe_config_file');
    text = await file.readFile('utf8');
  } finally { await file.close(); }
  let config;
  try { config = JSON.parse(text); }
  catch { throw new Error('invalid_config'); }
  exact(config, ['devices', 'pairs', 'stateFile'], ['port', 'host', 'limits', 'bootstrapToken']);
  if (!isAbsolute(config.stateFile) || config.host && !['127.0.0.1', '::1', 'localhost'].includes(config.host) ||
      config.port !== undefined && (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)) {
    throw new Error('invalid_config');
  }
  return config;
}

export async function main(args = process.argv.slice(2), { output = line => process.stdout.write(line + '\n'),
  errorOutput = line => process.stderr.write(line + '\n') } = {}) {
  if (args.length !== 2 || args[0] !== '--config') {
    errorOutput('Usage: node src/cli.mjs --config /absolute/private/relay.json');
    return { exitCode: 2 };
  }
  let relay;
  try {
    const config = await readPrivateConfig(args[1]);
    relay = await createTunnelRelayServer({ ...config,
      logger: record => output(JSON.stringify(record)) });
    const address = await relay.listen({ host: config.host || '127.0.0.1', port: config.port ?? 8765 });
    // Only loopback address and a port are printed. No config contents/errors.
    output(JSON.stringify({ event: 'relay_listening', host: address.address, port: address.port }));
    return { exitCode: 0, relay };
  } catch {
    await relay?.close().catch(() => {});
    errorOutput(JSON.stringify({ event: 'relay_start_failed', code: 'invalid_configuration_or_state' }));
    return { exitCode: 1 };
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { exitCode, relay } = await main();
  process.exitCode = exitCode;
  if (relay) {
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await relay.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
