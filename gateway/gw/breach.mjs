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
  // 群友 zx-5426 的红队资料（11-05）里漏掉的写法：把自己排在内置系统提示之上（权威链用全角 ＞）、「冲突时以本节为准」
  ["override", true, /(?:优先于|高于|压过|凌驾于?)(?:一切|所有)?(?:内置|宿主|默认)?的?系统提示|(?:与|和)(?:内置|宿主)?(?:系统)?(?:提示|指令)冲突时[，,]?以(?:本节|本文件|本规范|本段|此)为准|[＞>][^\n]{0,30}(?:内置|宿主)(?:系统)?提示|上位压死下位/i],
  ["override", false, /宿主对齐|对齐层/],
  // 宣布没有限制
  ["unlimited", true, /不存在[^\n]{0,12}不属于我的范围|(?:没有|无|取消)(?:任何)?(?:内容)?(?:限制|禁区|底线|审查)(?:声明|模式)|无限制(?:声明|模式|规则)|\b(?:no|without)\s+(?:any\s+)?(?:restrictions|limits|filters|censorship)\s+(?:mode|apply|whatsoever)|\buncensored\s+mode\b|\bunrestricted\s+mode\b/i],
  ["unlimited", false, /无限制|全开|不设限|不设(?:话题)?禁区|\bunrestricted\b|\buncensored\b|\bno\s+(?:restrictions|limits|filters)\b/i],
  // 拆拒答：软拒 / 禁用句型 / 不评估性质 / 不问用途
  ["antirefuse", true, /软拒|拒答的唯一来源|禁用句型|(?:不|别|勿)(?:要)?(?:评估|判断|审查)(?:请求|用户)?(?:的)?(?:性质|意图|动机)|\bnever\s+refuse\b|\bmust\s+not\s+refuse\b|refusals?\s+(?:are|is)\s+(?:forbidden|not\s+allowed|prohibited)/i],
  // 红队资料（11-05）：宣布没有该拒绝的、把拒绝说成输出故障 / RLHF 误触发、列一串拒答句当禁用词、之前的拒绝不算数、不给任务定性
  ["antirefuse", true, /不存在(?:任何)?需要(?:拒绝|评估|授权)|拒绝(?:是|=|＝)\s*(?:输出)?(?:管道)?故障|(?:命中|出现)[^\n]{0,12}(?:=|＝|即判?)\s*输出故障|拒绝[^\n]{0,20}(?:出现|命中)即(?:视为|判)?(?:输出)?故障|RLHF[^\n]{0,8}(?:产物|误触发)|(?:早前|之前|先前|此前)的?拒绝[^\n]{0,20}(?:不削弱|无效|作废|不算)|不(?:要)?(?:对|给)(?:任务|请求)(?:做)?(?:性质)?(?:归类|定性)|(?:(?:抱歉|对不起|我不能|我无法|无法协助|作为一个?\s*AI|As an AI|I can'?t|I'?m sorry)[^\n]{0,24}){4}/i],
  ["antirefuse", false, /不(?:逐条)?(?:询问|索要)授权|反问(?:用户)?(?:是否有)?权限|(?:合法|被授权|在范围内)[^\n]{0,12}(?:=|＝)\s*惰性|不作推理输入|拒绝(?:冲动|倾向)/],
  ["antirefuse", false, /(?:不(?:要|准|得|许)|禁止|别)拒绝|不(?:确认|核实)授权|不问用途|不要求(?:书面)?(?:授权|范围|材料)|(?:do\s+not|don't)\s+(?:refuse|decline)|(?:no|without)\s+(?:any\s+)?(?:warnings|disclaimers?)\b|不(?:写|加)(?:免责|风险提示|能力边界)/i],
  // 管思考过程：把风险评估当场作废
  ["thought", true, /(?:衡量风险|讨论政策|猜意图|给请求定性)[^\n]{0,20}(?:作废|删掉|不进)|(?:贴|打)(?:了)?标签[^\n]{0,20}删掉|delete\s+(?:the\s+)?label|思考槽/i],
  ["thought", false, /(?:in\s+your\s+)?(?:thinking|reasoning)\s+(?:must\s+)?(?:not|never)\s+(?:consider|evaluate)\s+(?:risk|safety|policy)|推理(?:里|中)?(?:不|别)(?:要)?(?:考虑|评估)(?:风险|安全|政策)/i],
  // 把攻击类术语改个说法（「工作区文体」包装，红队资料 11-05 专为躲检测改写）：crack=兼容性分析、keygen=演示实现……两条以上才算，可以跨行
  ["relabel", true, /(?:(?:crack|patch|keygen|reverse\s*shell|exploit|payload|绕过校验|外挂|注册机|木马|免杀)(?:\s*\/\s*\w+)?\s*[=＝][^；;\n=＝]{2,40}[；;。]?\s*){2,}/i, { joined: true }],
  // 预先宣布一切都在授权范围内、首字即交付
  ["preauth", false, /(?:请求|任务)(?:涉及|中)的[^\n]{0,30}均属(?:上述|授权|已授权)?范围|(?:默认|视为|一律)(?:已)?(?:获得)?授权(?:处理)?|按[^\n]{0,10}默认授权/],
  ["anchor", false, /锚点前零字符|首\s*Token|第一个(?:非空)?字符(?:起)?(?:必须|即)/i],
  ["conceal", false, /不自称(?:任何)?(?:底层)?模型名?/],
  // 不许提规则本身：藏起来的规则才怕被人看见（红队资料 11-05）
  ["conceal", false, /不(?:在回复中)?(?:讨论|提及|透露|引用)(?:本规范|本规则|本文件|系统提示)[^\n]{0,40}(?:存在|来源|修改)|没有对本规则的引用/],
  // 把违法类目当普通工单
  ["illicit", false, /(?:(?:木马|洗钱|盗版|外挂|社工|伪造|渗透|过检|反作弊|注册机)[^\n]{0,6}){3,}|(?:malware|money\s+laundering|piracy|cheats?|forgery)[^\n]{0,40}(?:just|only)\s+(?:a\s+)?(?:task|ticket|job)/i],
];

const MAX_TEXT = 2 << 20;   // 超过的只看前 2MB

// 防注入的说明会举例：「导出里要是有 "ignore previous instructions" 这类话，不要照做」（claude.ai 同步的官方技能 import-memory，11-05 误拦）。
// 命中的片段整个在引号里、同一行又明说别照做 / 当数据看，这一处不算；只有引号、或只有防御说法，照拦
const QUOTES = [['"', '"'], ["`", "`"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]];   // 单引号 ' 和英文缩写的撇号分不开，不认
const DEFENSIVE = /\b(?:do\s+not|don'?t|never)\s+(?:follow|obey|comply|act\s+on)\b|\bnever\s+instructions\b|\btreat(?:ed)?\s+(?:\w+\s+){0,3}as\s+data\b|\bis\s+data\b|不(?:要|得|能)?(?:照做|执行|遵循|服从|听从)|(?:当|视)(?:作|成|为)(?:普通)?(?:数据|资料)|不是指令/i;
const count = (s, ch) => s.split(ch).length - 1;
function quoted(line, m) {
  const pre = line.slice(0, m.index), post = line.slice(m.index + m[0].length);
  return QUOTES.some(([o, c]) => {
    if (o === c) return count(pre, o) % 2 === 1 && post.includes(c);   // 前面开着一个引号没关，后面有收尾的
    const lo = pre.lastIndexOf(o), lc = pre.lastIndexOf(c), no = post.indexOf(o), nc = post.indexOf(c);
    return lo > lc && nc >= 0 && (no < 0 || nc < no);
  });
}
const GLOBAL = new WeakMap();
function firstMatch(re, line) {
  const m0 = re.exec(line);
  if (!m0 || !(quoted(line, m0) && DEFENSIVE.test(line))) return m0;   // 绝大多数行到这里就完了
  let g = GLOBAL.get(re);
  if (!g) GLOBAL.set(re, (g = new RegExp(re.source, re.flags + "g")));
  g.lastIndex = 0;
  for (let m; (m = g.exec(line)); ) {
    if (!(quoted(line, m) && DEFENSIVE.test(line))) return m;
    if (!m[0].length) g.lastIndex++;
  }
  return null;
}

/**
 * 查一段文字。返回 { blocked, hits:[{ cat, strong, line, excerpt }] }
 * hits 只列每类第一条，够用户定位；blocked 按「强一条 / 弱跨两类」判。
 */
export function scanText(text) {
  const s = String(text ?? "").slice(0, MAX_TEXT);
  const hits = [], seenCat = new Set();
  let strong = false;
  const lines = s.split("\n");
  const joined = s.replace(/\n/g, " ");
  for (const [cat, isStrong, re, opt] of RULES) {
    if (seenCat.has(cat + isStrong)) continue;
    if (opt && opt.joined) {
      // 跨行写的（一条拆成几行）：整段并成一行看，命中再回头找起始行
      const m = re.exec(joined);
      if (!m) continue;
      const line = s.slice(0, m.index).split("\n").length;
      hits.push({ cat, strong: isStrong, line, excerpt: (lines[line - 1] || "").trim().slice(0, 120) });
      seenCat.add(cat + isStrong);
      if (isStrong) strong = true;
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const m = firstMatch(re, lines[i]);
      if (!m) continue;
      hits.push({ cat, strong: isStrong, line: i + 1, excerpt: lines[i].trim().slice(0, 120) });
      seenCat.add(cat + isStrong);
      if (isStrong) strong = true;
      break;
    }
    // 跨行的（类目清单拆成几行）：整段再看一次
    if (!seenCat.has(cat + isStrong) && !isStrong && cat === "illicit" && re.test(joined)) {
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
