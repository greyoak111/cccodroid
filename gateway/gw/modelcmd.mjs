import { log } from "./config.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";
import { PROVIDER, providerById } from "./providers.mjs";
import { effortLevelsOf, fetchModels, normEffort } from "./models.mjs";
import { effectiveAutoCompact } from "./stream.mjs";
import { effectiveModel, setSessModel } from "./sessmodel.mjs";

// ── /model 与 /effort：由网关本地处理 ─────────────────────────────────
// 为什么不让 claude 自己处理：它自带的 /model 只改「当前会话」，
// 而 GUI 每次调用都是新进程 —— 下一条消息就忘了。所以由网关记：
// 0.3.16 起：在会话里打 → 只改这个会话（sid）；新会话里打（还没会话号）→ 改全局默认。
export async function handleLocalCommand(name, arg, reply, sid) {
  // 清单、档位、校验都按这个会话真跑的那家：钉的 → 项目默认 → 全局（和 run.mjs、/api/models 同一套，#78）
  const now = effectiveModel(sid);
  const P = providerById(now.provider) || PROVIDER;
  const models = await fetchModels(false, P);   // 只是读清单：走 10 分钟缓存，项目那家清单地址慢时别每次干等
  const curId = now.model, curEff = now.effort;
  // 只认同名的：指定的型号不在清单里就当不知道窗口，别借默认或第一项的（#82）；没指定才按那家默认 / 第一项
  const want = curId || P.defaultModel;
  const cur = want ? models.find((m) => m.id === want) : models[0];
  const commit = (patch) => {
    // 等清单期间这个会话真跑的那家可能被改了（比如项目默认接口 A→B，审查 #122-2）：这里选中的型号是按旧那家的
    // 清单校验的，不能再写到新那家名下。作废这次命令，让用户按新接口重来。
    const nowP = sid ? providerById(effectiveModel(sid).provider) || PROVIDER : PROVIDER;
    if (nowP.id !== P.id) return false;
    if (sid) { setSessModel(sid, patch); return true; }
    if (patch.model !== undefined) SETTINGS.model = patch.model || null;
    if (patch.effort !== undefined) SETTINGS.effort = patch.effort || null;
    saveSettings();
    return true;
  };
  const staleReply = (tag) => reply("没改成：等型号清单的时候这个会话的接口换了。请按现在的接口重新执行一遍。", tag);
  const scope = sid ? "（只改这个会话）" : "（改的是全局默认）";

  // ── /autocompact ──
  // 交给 claude 自己处理的话：它写进 ~/.claude/settings.json，但我们下发的 CLAUDE_CODE_AUTO_COMPACT_WINDOW
  // 优先级更高（它会说 "env is set and takes precedence"），界面上的压缩线也要切一次模型才刷新。
  // 所以由网关接住：存进设置（和设置页那一栏是同一个值），下一轮起生效，前端收到 run_end 就刷新刻度。
  if (name === "autocompact") {
    const win = Number(cur && cur.context_window) || 0;
    const fmt = (n) => (n >= 1e6 ? +(n / 1e6).toFixed(2) + "M" : Math.round(n / 1000) + "k");
    if (!arg) {
      const v = effectiveAutoCompact();
      return reply(
        `自动压缩线：**${v ? fmt(v) + " tokens" : "默认（由 claude 按模型窗口决定）"}**${win ? `　（当前模型窗口 ${fmt(win)}）` : ""}\n\n` +
        "用法：`/autocompact 400k`、`/autocompact 1m`；恢复默认：`/autocompact off`。设置页「自动压缩」一栏是同一个值。",
        "autocompact"
      );
    }
    const a = arg.trim().toLowerCase();
    let n = null;
    if (!/^(off|default|reset|auto|0)$/.test(a)) {
      const m = a.match(/^(\d+(?:\.\d+)?)\s*([km]?)$/);
      if (!m) return reply(`看不懂 \`${arg.trim()}\`。写成 \`400k\`、\`1m\` 或纯数字；恢复默认用 \`off\`。`, "autocompact");
      n = Math.round(Number(m[1]) * (m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1));
      if (n < 10000) return reply(`${fmt(n)} 太小了，压缩线至少 10k。`, "autocompact");
    }
    SETTINGS.autoCompactWindow = n;
    const persisted = saveSettings();
    log(`⌘ /autocompact → ${n || "(默认)"}`);
    return reply(
      (n ? `自动压缩线已设为 **${fmt(n)} tokens**，下一轮起生效。` : "自动压缩线已恢复默认（由 claude 按模型窗口决定），下一轮起生效。") +
      (n && win && n > win ? `\n\n> **注意**：比当前模型的窗口（${fmt(win)}）还大，实际会先撞上窗口上限。` : "") +
      (persisted ? "" : "\n\n> **注意**：设置没能写入磁盘，只在本次运行内生效；重启后会恢复。"),
      "autocompact"
    );
  }

  // ── /model ──
  if (name === "model" || name === "models") {
    if (!arg) {
      // 原生厂商（claude 自己认识模型）：不列清单，也不劝你手选
      if (!models.length) {
        return reply(
          `当前厂商：**${P.label || P.id}**（claude 原生）\n\n` +
          `> 该厂商由 claude 自己决定模型，未提供可切换的模型清单 —— \`/model\` 在此不适用。\n` +
          `> 若要指定，可直接写进 \`ccapp-providers.json\` 的 \`defaultModel\`。`,
          "model"
        );
      }
      const lines = models.map((m) => {
        const on = m.id === curId ? "**▸** " : "　　";
        const img = (m.input_modalities || []).includes("image") ? " · 支持图片" : "";
        const eff = (m.effort?.supported_levels || []).join(" / ");
        return `${on}\`${m.id}\` — ${m.name || ""}\n　　上下文 ${Math.round((m.context_window || 0) / 1024)}k${img} · effort ${eff}`;
      }).join("\n\n");
      return reply(
        `当前厂商：**${P.label || P.id}**\n` +
        `当前模型：**${curId || "(由 claude 决定)"}**　（effort **${curEff || "默认"}**）\n\n` +
        `可用模型：\n\n${lines}\n\n` +
        `用法：\`/model <id>\`　切换思考强度：\`/effort\`\n\n` +
        (P.nativeModels
          ? `> 模型名由 claude 自己解析，写错会直接报错。`
          : `> 第三方厂商对不认识的名字**可能静默回落**，所以这里挡一道，免得你以为切成功了。`),
        "model"
      );
    }
    const t = arg.toLowerCase().trim();
    const target = models.find((m) => m.id.toLowerCase() === t)
      || models.find((m) => (m.name || "").toLowerCase() === t)
      || models.find((m) => m.id.toLowerCase().includes(t));
    if (!target) {
      if (!models.length) {
        return reply(
          `当前厂商（**${P.label || P.id}**）未提供模型清单，\`/model\` 不适用。\n` +
          `> 原生厂商由 claude 自己决定模型；要指定就改 \`ccapp-providers.json\` 的 \`defaultModel\`。`,
          "model"
        );
      }
      return reply(
        `没有模型 \`${arg}\`。\n\n可用：${models.map((m) => "`" + m.id + "`").join("、")}\n\n` +
        `（${P.label || P.id} 收到不认识的名字可能静默回落，所以这里挡住，免得你以为切成功了）`,
        "model"
      );
    }
    const eff = normEffort(target, curEff, P);
    const effChanged = eff !== curEff;
    if (!commit({ model: target.id, effort: eff || "" })) return staleReply("model");
    return reply(
      `已切换到 **${target.id}**${target.name ? "（" + target.name + "）" : ""}\n\n` +
      `- 上下文窗口：${Math.round((target.context_window || 0) / 1024)}k\n` +
      `- 输入模态：${(target.input_modalities || []).join(" / ")}\n` +
      `- effort 档位：${(target.effort?.supported_levels || []).join(" / ")}\n` +
      (effChanged ? `- **注意**：原 effort 该模型不支持，已调为 \`${eff}\`\n` : "") +
      `\n下一条消息生效${scope}。`,
      "model"
    );
  }

  // ── /effort ──
  if (name === "effort") {
    const levels = effortLevelsOf(cur, P);
    const dflt = cur && cur.effort && cur.effort.default_level;
    if (!arg) {
      const lines = levels.map((l) =>
        `${l === curEff ? "**▸** " : "　　"}\`${l}\`` + (l === dflt ? "　（模型默认）" : "")).join("\n");
      return reply(
        `当前模型 **${curId || "默认"}** 的思考强度：**${curEff || "(未设置)"}**\n\n${lines}\n\n` +
        `用法：\`/effort <level>\`\n\n` +
        `> 档位越高思考越久、通常质量越好。实测首字延迟：\`low\` ≈ 0.9s，\`max\` ≈ 2.3s。`,
        "effort"
      );
    }
    const t = arg.toLowerCase().trim();
    if (levels.includes(t)) {
      if (!commit({ effort: t })) return staleReply("effort");
      return reply(`思考强度已设为 **${t}**（模型 ${curId || "默认"}）。\n\n下一条消息生效${scope}。`, "effort");
    }
    // claude 认 low/medium/high/xhigh/max，DeepSeek 只有 low/high/max，做个就近映射
    const alias = { medium: "high", xhigh: "max", highest: "max", lowest: "low", normal: "high" }[t];
    if (alias && levels.includes(alias)) {
      if (!commit({ effort: alias })) return staleReply("effort");
      return reply(`\`${arg}\` 不是 ${curId} 的档位，已就近设为 **${alias}**。\n\n` +
        `该模型支持：${levels.map((l) => "`" + l + "`").join("、")}`, "effort");
    }
    return reply(`\`${arg}\` 不是有效档位。**${curId || "默认模型"}** 支持：${levels.map((l) => "`" + l + "`").join("、")}`, "effort");
  }

  return reply(`未知命令 /${name}`, name);
}
