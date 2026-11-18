// 同源经典 Worker；SheetJS 和整本工作簿只存在这里，不占界面线程。
"use strict";
importScripts("/office/xlsx.full.min.js", "/office/sheet-model.js");
let model = null, timer = 0;
const reads = new Map();
self.onmessage = ({ data }) => {
  if (data && (data.op === "page" || data.op === "cell")) {
    // 表签 / 单元格连点只计算本批最后一次；主线程已撤销同类旧序号的等待。
    reads.set(data.op, data);
    if (!timer) timer = setTimeout(() => {
      timer = 0;
      const batch = [...reads.values()]; reads.clear();
      for (const data of batch) respond(data);
    }, 0);
  } else respond(data);
};
function respond(data) {
  if (!data || !Number.isSafeInteger(data.id) || data.id < 1) return;
  const { id, op } = data;
  try {
    let value;
    if (op === "load") {
      if (model || !(data.buffer instanceof ArrayBuffer) || data.buffer.byteLength > 32 * 1024 * 1024) throw new Error("sheet input");
      if (SheetPreview.zipExpandsTooMuch(data.buffer)) { const e = new Error("sheet budget"); e.code = "tooBig"; throw e; }
      const wb = XLSX.read(data.buffer, { type: "array", cellStyles: true, cellNF: true });
      model = SheetPreview.create(wb, XLSX);
      value = { names: model.names, active: model.active };
    } else if (!model) throw new Error("sheet not ready");
    else if (op === "page") value = model.page(data.sheet, data.from);
    else if (op === "cell") value = model.cell(data.sheet, data.addr);
    else throw new Error("sheet operation");
    self.postMessage({ id, value });
  } catch (e) {
    self.postMessage({ id, error: { code: e.code === "tooBig" ? "tooBig" : "read", message: String(e.message || e).slice(0, 500) } });
  }
}
