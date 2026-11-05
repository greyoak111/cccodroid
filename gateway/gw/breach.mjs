// 破甲特征检查：发行版回填给 claude 的文字（CLAUDE.md、rules、skill、斜杠命令、子代理、自动记忆…）先过这一关，命中整轮不跑。
//
// 这是认「现成破甲包」的，不是万能分类器：改写措辞能绕过去。所以发行版另外从结构上封口（--setting-sources ""，见 edition.mjs），
// 只有经过这里的文字才进上下文；钩子、插件代码这类查不了内容的，只认签名组件带的。
// 判定：强特征一条就算；弱特征要跨两类（一份正常的项目约定偶尔说一句「不要拒绝合理请求」不该被拦）。
// 规则只看文字本身，命中报文件与行号，给用户改。

/** [类别, 强?, 正则]。类别相同的弱特征只算一类 */
const RULES = [
  // 自称破甲 / 越狱
  // 只提这个词不算（讨论破甲的笔记、审计报告到处都是）；要和下面别的类别一起出现
  ["jailbreak", true, /\bDAN\s+mode\b|\bdo anything now\b|developer\s+mode\s+(?:enabled|on)\b|开发者模式(?:已)?(?:开启|启用)/i],
  ["jailbreak", false, /破甲|越狱|jail\s*-?\s*break/i],
  // 冒充系统、开发者、Anthropic 的消息
  ["spoof", true, /<\/?\s*system-reminder\s*>|<\/?\s*(?:system|developer)(?:[_-]?(?:message|prompt|instructions?))?\s*>|\[\s*(?:system|developer)\s+(?:message|instruction|override)\s*\]|anthropic\s+(?:policy|safety|system)\s+(?:update|override|exception)/i],
  // 压过宿主 / 系统 / 安全规则
  ["override", true, /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:(?:your|the|any|previous|prior|above|earlier|system)\s+){1,3}(?:instructions|prompts?|rules|guidelines|polic(?:y|ies)|safety|restrictions)|忽略(?:掉)?(?:你的|所有|一切|之前|以上|上面|系统)(?:的)?(?:系统)?(?:提示|指令|规则|设定|限制)|(?:优先级|效力)\s*(?:高于|压过|大于)\s*(?:一切|所有|系统|宿主|安全)|用户(?:任务|指令)?\s*>\s*(?:本)?规则\s*>\s*(?:宿主|系统)/i],
  ["override", false, /(?:宿主|系统)(?:的)?默认(?:倾向|规则|限制)|(?:above|over)\s+(?:all\s+)?(?:system|default)\s+(?:behaviou?r|instructions)/i],
  // 宣布没有限制
  ["unlimited", true, /不存在[^\n]{0,12}不属于我的范围|(?:没有|无|取消)(?:任何)?(?:内容)?(?:限制|禁区|底线|审查)(?:声明|模式)|无限制(?:声明|模式|规则)|\b(?:no|without)\s+(?:any\s+)?(?:restrictions|limits|filters|censorship)\s+(?:mode|apply|whatsoever)|\buncensored\s+mode\b|\bunrestricted\s+mode\b/i],
  ["unlimited", false, /无限制|全开|不设限|\bunrestricted\b|\buncensored\b|\bno\s+(?:restrictions|limits|filters)\b/i],
  // 拆拒答：软拒 / 禁用句型 / 不评估性质 / 不问用途
  ["antirefuse", true, /软拒|拒答的唯一来源|禁用句型|(?:不|别|勿)(?:要)?(?:评估|判断|审查)(?:请求|用户)?(?:的)?(?:性质|意图|动机)|\bnever\s+refuse\b|\bmust\s+not\s+refuse\b|refusals?\s+(?:are|is)\s+(?:forbidden|not\s+allowed|prohibited)/i],
  ["antirefuse", false, /(?:不(?:要|准|得|许)|禁止|别)拒绝|不(?:确认|核实)授权|不问用途|不要求(?:书面)?(?:授权|范围|材料)|(?:do\s+not|don't)\s+(?:refuse|decline)|(?:no|without)\s+(?:warnings?|disclaimers?)\b|不(?:写|加)(?:免责|风险提示|能力边界)/i],
  // 管思考过程：把风险评估当场作废
  ["thought", true, /(?:衡量风险|讨论政策|猜意图|给请求定性)[^\n]{0,20}(?:作废|删掉|不进)|(?:贴|打)(?:了)?标签[^\n]{0,20}删掉|delete\s+(?:the\s+)?label|思考槽/i],
  ["thought", false, /(?:in\s+your\s+)?(?:thinking|reasoning)\s+(?:must\s+)?(?:not|never)\s+(?:consider|evaluate)\s+(?:risk|safety|policy)|推理(?:里|中)?(?:不|别)(?:要)?(?:考虑|评估)(?:风险|安全|政策)/i],
  // 把违法类目当普通工单
  ["illicit", false, /(?:(?:木马|洗钱|盗版|外挂|社工|伪造|渗透|过检|反作弊|注册机)[^\n]{0,6}){3,}|(?:malware|money\s+laundering|piracy|cheats?|forgery)[^\n]{0,40}(?:just|only)\s+(?:a\s+)?(?:task|ticket|job)/i],
];

const MAX_TEXT = 2 << 20;   // 超过的只看前 2MB

/**
 * 查一段文字。返回 { blocked, hits:[{ cat, strong, line, excerpt }] }
 * hits 只列每类第一条，够用户定位；blocked 按「强一条 / 弱跨两类」判。
 */
export function scanText(text) {
  const s = String(text ?? "").slice(0, MAX_TEXT);
  const hits = [], seenCat = new Set();
  let strong = false;
  const lines = s.split("\n");
  for (const [cat, isStrong, re] of RULES) {
    if (seenCat.has(cat + isStrong)) continue;
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      hits.push({ cat, strong: isStrong, line: i + 1, excerpt: lines[i].trim().slice(0, 120) });
      seenCat.add(cat + isStrong);
      if (isStrong) strong = true;
      break;
    }
    // 跨行的（类目清单拆成几行）：整段再看一次
    if (!seenCat.has(cat + isStrong) && !isStrong && cat === "illicit" && re.test(s.replace(/\n/g, " "))) {
      hits.push({ cat, strong: false, line: 0, excerpt: "" });
      seenCat.add(cat + isStrong);
    }
  }
  const cats = new Set(hits.map((h) => h.cat));
  return { blocked: strong || cats.size >= 2, hits };
}

/** 查多份：[{ name, text }] → { blocked, found:[{ name, hits }] }（只列命中的） */
export function scanAll(items) {
  const found = [];
  for (const it of items || []) {
    const r = scanText(it.text);
    if (r.blocked) found.push({ name: it.name, hits: r.hits });
  }
  return { blocked: found.length > 0, found };
}

/** 给用户看的一行：文件:行 摘要 */
export function describe(found, max = 6) {
  return found.slice(0, max).map((f) => {
    const h = f.hits.find((x) => x.strong) || f.hits[0];
    return `${f.name}${h && h.line ? ":" + h.line : ""}${h && h.excerpt ? " 「" + h.excerpt.slice(0, 60) + "」" : ""}`;
  }).join("\n");
}
