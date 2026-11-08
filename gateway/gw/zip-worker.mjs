// 解压 worker：zipReadAsync（sessionops.mjs）把整个包交过来，在这里一口气解完再整批交回，
// 解的那段时间网关主线程照常处理别的请求（F7，原来是同步解，期间网关别的事都得等）
import { parentPort, workerData } from "node:worker_threads";
import { zipReadCore } from "./zipcore.mjs";

const fail = (code, vars) => Object.assign(new Error(code), { zipCode: code, vars });
try {
  const buf = Buffer.from(workerData.buf.buffer, workerData.buf.byteOffset, workerData.buf.byteLength);
  const files = zipReadCore(buf, workerData.max, fail);
  // 解出来的数据逐个转移所有权，不再拷一遍；Buffer.from(body) 这类可能共用一块底层内存，转移前先各自拷成独立的
  const list = files.map((f) => {
    const u8 = f.data.byteOffset === 0 && f.data.byteLength === f.data.buffer.byteLength ? f.data : Uint8Array.prototype.slice.call(f.data);
    return { name: f.name, data: new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength) };
  });
  const seen = new Set(), xfer = [];
  for (const f of list) if (!seen.has(f.data.buffer)) { seen.add(f.data.buffer); xfer.push(f.data.buffer); }
  parentPort.postMessage({ files: list }, xfer);
} catch (err) {
  parentPort.postMessage({ err: err.zipCode ? { code: err.zipCode, vars: err.vars } : { message: String(err?.message || err) } });
}
