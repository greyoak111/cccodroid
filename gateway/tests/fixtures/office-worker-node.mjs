// Node bridge for the unchanged browser worker protocol; no app/gateway/config imports.
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
globalThis.self = globalThis;
globalThis.importScripts = (...urls) => {
  for (const url of urls) {
    const file = path.join(workerData.web, url.replace(/^\//, ""));
    vm.runInThisContext(fs.readFileSync(file, "utf8"), { filename: file });
  }
};
globalThis.postMessage = data => parentPort.postMessage(data);
vm.runInThisContext(fs.readFileSync(path.join(workerData.web, "office/sheet-worker.js"), "utf8"), { filename: "sheet-worker.js" });
parentPort.on("message", data => self.onmessage({ data }));
