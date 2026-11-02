import "../gw/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createAppRemoteComponent } from "../gw/remote-component-app.mjs";

test("actual application adapter initializes without an installed payload and without creating identity/data", async () => {
  const manager = await createAppRemoteComponent();
  try {
    const status = await manager.status();
    assert.equal(status.state, "absent"); assert.equal(status.enabled, false);
    assert.equal(fs.existsSync(path.join(process.env.CCAPP_HOME, ".cccodroid/remote-session/remote-v1")), false);
    await assert.rejects(manager.invoke("status"), { code: "REMOTE_UNAVAILABLE" });
  } finally { await manager.close(); }
});
