import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createRemoteRoute } from "../gw/remote.mjs";
import { NEXT } from "../gw/http.mjs";

async function request(route, url, { method = "GET", data, authed = true } = {}) {
  const req = new PassThrough(); req.method = method; req.ccAuthed = authed;
  const headers = {};
  const res = { headers, req, setHeader(k, v) { headers[k] = v; }, writeHead(status, h) { this.status = status; Object.assign(headers, h); }, end(value) { this.data = value ? JSON.parse(String(value)) : null; } };
  const u = new URL(url, "http://127.0.0.1");
  const result = route(req, res, u, u.pathname);
  req.end(data === undefined ? "" : JSON.stringify(data));
  return { result: await result, res };
}

test("remote route is a narrow authenticated local capability API", async () => {
  const calls = [];
  const runtime = new Proxy({}, { get: (_o, name) => async (value) => { calls.push([name, value]); return { ok: true, method: name }; } });
  const route = createRemoteRoute(runtime);
  assert.equal((await request(route, "/api/status")).result, NEXT);
  const denied = await request(route, "/api/remote/status", { authed: false });
  assert.equal(denied.res.status, 403); assert.equal(calls.length, 0);
  const command = { generation: 1, binding: { fromDeviceId: "phone", toDeviceId: "tablet", hostInstanceId: "boot", remoteSessionId: "hosted-1", grantVersion: 1, runId: "run-1" }, type: "message.submit", payload: { text: "/model leave as text" }, commandId: "command-1" };
  const valid = await request(route, "/api/remote/command", { method: "POST", data: command });
  assert.equal(valid.res.status, 200);
  assert.deepEqual(calls, [["command", command]]);
  assert.equal(valid.res.headers["cache-control"], "no-store");
  for (const extra of [{ url: "/api/chat" }, { permissionMode: "bypassPermissions" }, { attachments: [] }, { cwd: "/private" }]) {
    const bad = await request(route, "/api/remote/command", { method: "POST", data: { ...command, ...extra } });
    assert.equal(bad.res.status, 400); assert.equal(bad.res.data.code, "INVALID_SCHEMA");
  }
  assert.equal(calls.length, 1);
  const unknown = await request(route, "/api/remote/proxy", { method: "POST", data: { url: "/api/file" } });
  assert.equal(unknown.res.status, 404);
  assert.equal(calls.length, 1);
});

test("remote route never returns sensitive runtime exception text", async () => {
  const route = createRemoteRoute({ status() { throw new Error("Bearer synthetic-private-token and session content"); } });
  const { res } = await request(route, "/api/remote/status");
  assert.equal(res.data.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(res.data).includes("synthetic-private-token"));
});
