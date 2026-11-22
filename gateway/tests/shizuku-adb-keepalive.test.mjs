import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { routeDevside } from "../gw/devside.mjs";

test("无线 ADB 保活只接受明确的布尔值，并原样回传原生确认结果", async (t) => {
  const commands = [];
  const originalSocket = process.env.CCAPP_PRIV_SOCK;
  const socketPath = path.join(process.env.CCAPP_TMP, "shz-adb-keepalive.sock");
  process.env.CCAPP_PRIV_SOCK = socketPath;
  t.after(() => {
    if (originalSocket === undefined) delete process.env.CCAPP_PRIV_SOCK;
    else process.env.CCAPP_PRIV_SOCK = originalSocket;
  });

  const app = net.createServer((client) => {
    client.setEncoding("utf8");
    let input = "";
    client.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input);
      commands.push(request);
      client.end(JSON.stringify({ ok: !request.enable, adbKeepalive: false }) + "\n");
    });
  });
  await new Promise((resolve) => app.listen(socketPath, resolve));
  t.after(() => app.close());

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    await routeDevside(req, res, url, url.pathname);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/app/shz_adb_keepalive`;
  const post = (body) => fetch(url, { method: "POST", body: JSON.stringify(body) });

  for (const body of [{}, { enable: "true" }, { enable: 1 }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await fetch(url)).status, 400);
  assert.deepEqual(commands, []);

  assert.deepEqual(await (await post({ enable: true, port: 5037 })).json(), {
    ok: false, adbKeepalive: false,
  });
  assert.deepEqual(await (await post({ enable: false })).json(), {
    ok: true, adbKeepalive: false,
  });
  assert.deepEqual(commands, [
    { op: "shz_adb_keepalive", enable: true },
    { op: "shz_adb_keepalive", enable: false },
  ]);
});
