// Use completed assistant blocks only. A CLI message may arrive as multiple
// assistant events with the same ID, e.g. thinking, followed by text.
const MAX_TEXT = 16_384;
const PREVIEW_LENGTH = 160;
const unsafe = /[\p{Cc}\p{Cs}؜‎‏‪-‮⁦-⁩]/u;

export function trackWorkIslandReply() {
  let message = null, reply = null;
  const select = (id) => {
    if (!message || message.id !== id) message = { id, text: "", clean: true, stop: null };
    return message;
  };
  const blocks = (m, content, append) => {
    if (!Array.isArray(content) || (append && !content.length)) { m.clean = false; return; }
    for (const block of content) {
      if (block?.type !== "text" || typeof block.text !== "string" || (append && m.text.length + block.text.length > MAX_TEXT)) {
        m.clean = false;
        return;
      }
      if (append && m.clean) m.text += block.text;
    }
  };
  const stop = (m, reason) => {
    if (reason == null) return;
    if (m.stop !== null && m.stop !== reason) m.clean = false;
    m.stop = reason;
  };
  return {
    feed(ev, sessionId) {
      if (!ev || typeof ev.type !== "string") {
        reply = null;
        if (message) message.clean = false;
        return;
      }
      if (ev.parent_tool_use_id || ev.isSidechain) return;
      switch (ev.type) {
        case "assistant": {
          reply = null;
          const msg = ev.message;
          if (typeof msg?.id !== "string" || !msg.id) { if (message) message.clean = false; return; }
          // Match the same message ID through stream start and all final blocks.
          // A different ID without a matching stream start mid-message is ambiguous.
          if (message?.streaming && message.id !== msg.id) { message.clean = false; return; }
          const m = select(msg.id);
          if (ev.session_id !== sessionId || !sessionId || ev.isReplay || ev.isMeta || ev.isApiErrorMessage || msg.role !== "assistant" || (typeof msg.model !== "string" || !msg.model) || msg.model === "<synthetic>") m.clean = false;
          stop(m, msg.stop_reason);
          blocks(m, msg.content, true);
          break;
        }
        case "stream_event": {
          reply = null;
          const e = ev.event;
          if (e?.type === "message_start") {
            const id = e.message?.id;
            const m = select(id);
            m.streaming = true;
            if (typeof id !== "string" || !id || (ev.session_id && ev.session_id !== sessionId)) m.clean = false;
            blocks(m, e.message.content, false);
          } else if (message && e?.type === "content_block_start") {
            blocks(message, [e.content_block], false);
          } else if (message && e?.type === "content_block_delta" && e.delta?.type !== "text_delta") {
            message.clean = false;
          } else if (message && e?.type === "message_delta") {
            stop(message, e.delta?.stop_reason);
          } else if (message && e?.type === "message_stop") {
            message.streaming = false;
          }
          break;
        }
        case "user":
        case "control_request":
        case "error":
          // Interleaved user/tool traffic breaks the tie between text and result.
          reply = null;
          if (message) message.clean = false;
          break;
      }
    },
    result(ev, sessionId) {
      const m = message;
      message = reply = null;
      if (!sessionId || ev.session_id !== sessionId || ev.parent_tool_use_id || ev.isSidechain || ev.is_error !== false || ev.subtype !== "success" || ev.local_command) return;
      if (!m?.clean || m.streaming || (ev.stop_reason ?? m.stop) !== "end_turn" || (m.stop !== null && m.stop !== "end_turn")) return;
      const text = m.text.trim();
      if (!text || typeof ev.result !== "string" || text !== ev.result.trim()) return;
      const line = text.replace(/[\t\r\n\p{Z}]+/gu, " ");
      // Never include control characters, code fences, or tag-like blocks in notifications.
      if (unsafe.test(line) || /```|~~~|<[!?/]?[a-z][^<>]*>/iu.test(line)) return;
      const chars = Array.from(line);
      reply = chars.length > PREVIEW_LENGTH ? chars.slice(0, PREVIEW_LENGTH - 1).join("").trimEnd() + "…" : line;
    },
    get text() { return reply; },
  };
}
