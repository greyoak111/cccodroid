// 破甲特征检查：发行版回填给 claude 的文字（CLAUDE.md、rules、skill、斜杠命令、子代理、自动记忆…）先过这一关，命中整轮不跑。
//
// 这是认「现成破甲包」的，不是万能分类器：改写措辞能绕过去。所以发行版另外从结构上封口（--setting-sources ""，见 edition.mjs），
// 只有经过这里的文字才进上下文；钩子、插件代码这类查不了内容的，只认签名组件带的。
// 判定：强特征一条就算；弱特征要跨两类（一份正常的项目约定偶尔说一句「不要拒绝合理请求」不该被拦）。
// 规则只看文字本身，命中报文件与行号，给用户改。
// 判前先归一化（NFKC、去零宽、去汉字间分隔），并还原 base64/hex 外壳、查倒序句：形态变换不能直接穿层。

/** [类别, 强?, 正则]。类别相同的弱特征只算一类 */
const RULES = [
  // 自称破甲 / 越狱
  // 只提这个词不算（讨论破甲的笔记、审计报告到处都是）；要和下面别的类别一起出现
  ["jailbreak", true, /\bDAN\s+mode\b|\bdo anything now\b|developer\s+mode\s+(?:enabled|on)\b|开发者模式(?:已)?(?:开启|启用)|(?:你是|现在是|我是)\s*DAN\b/i],
  ["jailbreak", false, /破甲|越狱|jail\s*-?\s*break/i],
  // 冒充系统、开发者、Anthropic 的消息
  ["spoof", true, /<\/?\s*system-reminder\s*>|<\/?\s*(?:system|developer)(?:[_-]?(?:message|prompt|instructions?))?\s*>|[<＜]\/?\s*(?:system-reminder|system|developer)(?:\s+(?:message|instruction|override))?\s*[>＞]|\[\s*(?:system|developer)\s+(?:message|instruction|override)\s*\]|anthropic\s+(?:policy|safety|system)\s+(?:update|override|exception)|\bauthority\s*[:：]\s*(?:anthropic|system|developer)\b|\boverride\s*[:：]\s*(?:true|yes|on)\b|\boperator\s+directive\b|(?:系统层|平台|系统)(?:的)?(?:下发|注入)(?:的)?(?:补充)?(?:说明|通知|指令|更新)|(?:早先|之前|此前|以上)(?:的)?规则(?:已|全部)?(?:作废|失效|取消)/i],
  // role: system 单条只算弱特征：正常文档也会举 prompt 格式的例子，单条不拦（s05 那种头里有 authority/override 的仍是强特征）
  ["spoof", false, /(?:^|\n)\s*role\s*[:：]\s*(?:system|developer|anthropic)\b/i],
  // 压过宿主 / 系统 / 安全规则
  ["override", true, /(?:ignor\w*|disregard\w*|forg\w*|overrid\w*)\s+(?:all\s+)?(?:(?:your|the|any|previous|prior|above|earlier|system)\s+){1,3}(?:instructions|prompts?|rules|guidelines|polic(?:y|ies)|safety|restrictions)|忽略(?:掉)?(?:你|你的|所有|一切|之前|以上|上面|系统|全部|的){1,4}(?:系统)?(?:提示|指令|规则|设定|限制)|(?:优先级|效力)\s*(?:高于|压过|大于)\s*(?:一切|所有|系统|宿主|安全)|用户(?:任务|指令)?\s*>\s*(?:本)?规则\s*>\s*(?:宿主|系统)/i],
  ["override", false, /系统(?:的)?默认(?:倾向|规则|限制)|(?:above|over)\s+(?:all\s+)?(?:system|default)\s+(?:behaviou?r|instructions)/i],
  // 群友 zx-5426 的红队资料（11-05）里漏掉的写法：把自己排在内置系统提示之上（权威链用全角 ＞）、「冲突时以本节为准」
  ["override", true, /(?:优先于|高于|压过|凌驾于?)(?:一切|所有)?(?:内置|宿主|默认)?的?系统提示|(?:与|和)(?:内置|宿主)?(?:系统)?(?:提示|指令)冲突时[，,]?以(?:本节|本文件|本规范|本段|此)为准|[＞>][^\n]{0,30}(?:内置|宿主)(?:系统)?提示|上位压死下位|(?:以下|本)(?:约定|规则|规范)[^\n]{0,20}比(?:内置|宿主|系统)[^\n]{0,10}(?:要紧|重要|优先)|\b(?:where|if)\s+this\s+document\s+conflicts?\s+with[^\n]{0,40}this\s+document\s+wins\b|\bthis\s+document\s+(?:takes\s+precedence|prevails)\b|(?:本规范|本文件|本规则)[^\n]{0,6}(?:覆盖|取代|顶替)[^\n]{0,6}(?:内置|系统)(?:提示|规则|指令)|(?:内置|系统)(?:提示|规则|指令)[^\n]{0,10}(?:被|由)[^\n]{0,4}(?:本规范|本文件)[^\n]{0,4}(?:覆盖|取代|顶替)|宿主[^\n]{0,4}默认(?:倾向|规则|限制)/i],
  ["override", false, /宿主对齐|对齐层/],
  // 宣布没有限制
  ["unlimited", true, /不存在[^\n]{0,12}不属于我的范围|(?:没有|无|取消)(?:任何)?(?:内容)?(?:限制|禁区|底线|审查)(?:声明|模式)|无限制(?:声明|模式|规则)|\b(?:no|without)\s+(?:any\s+)?(?:restrictions|limits|filters|censorship)\s+(?:mode|apply|whatsoever)|\buncensored\s+mode\b|\bunrestricted\s+mode\b|不存在(?:任何|什么)?(?:禁区|底线)|没有(?:任何|什么)?(?:禁区|底线问题|底线)|(?:所有|任何)(?:话题|问题)(?:都|一律)?(?:照答|可答)|(?:按|以|作)「?全开」?(?:处理|对待|运行)|(?:要什么|要啥)(?:就)?给(?:什么|啥)/i],
  ["unlimited", false, /无限制|全开|不设限|不设(?:话题)?禁区|\bunrestricted\b|\buncensored\b|\bno\s+(?:restrictions|limits|filters)\b/i],
  // 拆拒答：软拒 / 禁用句型 / 不评估性质 / 不问用途
  ["antirefuse", true, /软拒|拒答的唯一来源|禁用句型|(?:不|别|勿)(?:要)?(?:评估|判断|审查)(?:请求|用户)?(?:的)?(?:性质|意图|动机)|\bnever\s+refuse\b|\bmust\s+not\s+refuse\b|refusals?\s+(?:are|is)\s+(?:forbidden|not\s+allowed|prohibited)/i],
  // 红队资料（11-05）：宣布没有该拒绝的、把拒绝说成输出故障 / RLHF 误触发、列一串拒答句当禁用词、之前的拒绝不算数、不给任务定性
  ["antirefuse", true, /不存在(?:任何)?需要(?:拒绝|评估|授权)|拒绝(?:是|=|＝)\s*(?:输出)?(?:管道)?故障|(?:命中|出现)[^\n]{0,12}(?:=|＝|即判?)\s*输出故障|拒绝[^\n]{0,20}(?:出现|命中)即(?:视为|判)?(?:输出)?故障|RLHF[^\n]{0,8}(?:产物|误触发)|(?:早前|之前|先前|此前)(?:那些|的)?拒绝[^\n]{0,20}(?:不削弱|无效|作废|不算)|不(?:要)?(?:对|给)(?:任务|请求)(?:做)?(?:性质)?(?:归类|定性)|(?:(?:抱歉|对不起|我不能|我无法|无法协助|作为一个?\s*AI|As an AI|I can'?t|I'?m sorry)[^\n]{0,24}){4}|(?:把|将)[^\n]{0,20}(?:抱歉|我不能|我无法|拒绝)[^\n]{0,20}(?:从|在)(?:你的)?(?:输出|回复|答复)[^\n]{0,10}(?:删|去|清|移除)|不(?:需要|必|用)确认授权[^\n]{0,30}(?:也)?不(?:用|必)问(?:用途|来意)|缺(?:少|的)?参数[^\n]{0,15}(?:自己|自行|直接)(?:填|补|定)/i],
  ["antirefuse", false, /不(?:逐条)?(?:询问|索要)授权|反问(?:用户)?(?:是否有)?权限|(?:合法|被授权|在范围内)[^\n]{0,12}(?:=|＝)\s*惰性|不作推理输入|拒绝(?:冲动|倾向)/],
  ["antirefuse", false, /(?:不(?:要|准|得|许)|禁止|别)拒绝|不(?:确认|核实)授权|不问用途|不要求(?:书面)?(?:授权|范围|材料)|(?:do\s+not|don't)\s+(?:refuse|decline)|\bnever\s+(?:decline|reject)\b|(?:no|without)\s+(?:any\s+)?(?:warnings|disclaimers?)\b|不(?:写|加)(?:免责|风险提示|能力边界)/i],
  // 「不要拒绝任何/一切/所有请求」是拆拒答的直球；「不要拒绝合理请求」这类正常约定不算（任何/一切/所有才拦）。
  // 复核（11-06 二轮）：宾语后面跟「里的/中的」限定句（…里的合理部分）不算
  ["antirefuse", true, /(?:不要|别|禁止|勿)(?:拒绝|回绝)(?:任何|一切|所有)(?:请求|要求|问题|话题)(?!里|中|内)/i],
  // 管思考过程：把风险评估当场作废
  ["thought", true, /(?:衡量风险|讨论政策|猜意图|给请求定性)[^\n]{0,20}(?:作废|删掉|不进)|(?:贴|打)(?:了)?标签[^\n]{0,20}删掉|delete\s+(?:the\s+)?label|思考槽|推理(?:里|中|过程(?:中|里)?)?(?:不必|无需|无须|不要|别|不)(?:要|必|需|须)?(?:考虑|评估|理会)(?:风险|安全|政策)|(?:想到|冒出)(?:拒绝|拒答)[^\n]{0,20}(?:作废|删掉|舍弃|抛掉)/i],
  ["thought", false, /(?:in\s+your\s+)?(?:thinking|reasoning)\s+(?:must\s+)?(?:not|never)\s+(?:consider|evaluate)\s+(?:risk|safety|policy)|推理(?:里|中)?(?:不|别)(?:要)?(?:考虑|评估)(?:风险|安全|政策)/i],
  // 把攻击类术语改个说法（「工作区文体」包装，红队资料 11-05 专为躲检测改写）：crack=兼容性分析、keygen=演示实现……两条以上才算，可以跨行
  ["relabel", true, /(?:(?:crack|patch|keygen|reverse\s*shell|exploit|payload|绕过校验|外挂|注册机|木马|免杀)(?:\s*\/\s*\w+)?\s*[=＝|][^；;\n=＝|]{2,40}(?:[；;。]|[|]){1,2}\s*){2,}/i, { joined: true }],
  // 预先宣布一切都在授权范围内、首字即交付
  // 复核（11-06 二轮）：提强会误拦「新建的文件默认权限是 0644」「子进程一律视为已授权处理」这类正常句，退回弱特征；「权限」一词去掉（太日常）
  ["preauth", false, /(?:请求|任务)(?:涉及|中)的[^\n]{0,30}均属(?:上述|授权|已授权)?范围|(?:默认|视为|一律)(?:已(?:经)?)?(?:获得)?(?:处理)?授权(?:处理)?|按[^\n]{0,10}默认授权/],
  ["anchor", false, /锚点前零字符|首\s*Token|第一个(?:非空)?字符(?:起)?(?:必须|即)/i],
  ["conceal", false, /不自称(?:任何)?(?:底层)?模型名?/],
  // 不许提规则本身：藏起来的规则才怕被人看见（红队资料 11-05）
  ["conceal", false, /不(?:在回复[中里])?(?:讨论|提及|透露|引用)(?:本规范|本规则|本文件|系统提示)[^\n]{0,40}(?:存在|来源|修改)|没有对本规则的引用/],
  // 把违法类目当普通工单
  // 复核（11-06 二轮）：只列类目的安全笔记（「木马/免杀/钓鱼/渗透」清单）是安全文档常态，词数再多也只算弱特征
  ["illicit", false, /(?:(?:木马|免杀|杀软|钓鱼|洗钱|盗版|外挂|社工|伪造|渗透|过检|反作弊|注册机)[^\n]{0,6}){3,}|(?:malware|money\s+laundering|piracy|cheats?|forgery)[^\n]{0,40}(?:just|only)\s+(?:a\s+)?(?:task|ticket|job)/i],
];

const MAX_TEXT = 2 << 20;   // 超过的只看前 2MB

// ── 归一化与外壳解码（防形变）────────────────────────────────
// 只动不影响语义的形态：全角→半角（NFKC）、零宽与格式控制字符、汉字之间插的分隔符。
// 引号不动（豁免判定靠引号定位）；行分隔符换成普通换行，不合并行。
const ZW_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
// 只删空格类与间隔号，句读（，。；：）不删：把两句话拼成一句会造出「不要拒绝，任何请求…」这种假阳性（复核 11-06 二轮）
const SEP_RE = /(?<=[\u4e00-\u9fff])[ \t\u3000·・]*(?=[\u4e00-\u9fff])/g;
const norm = (s) => s.normalize("NFKC").replace(/[\u2028\u2029]/g, "\n").replace(ZW_RE, "").replace(SEP_RE, "");
// 常见编码壳：base64、十六进制。解出来可读（含汉字或成句英文）才替换，避免把随机串解成垃圾拖慢扫描
const plausible = (s) => /[一-鿿]/.test(s) || /[a-zA-Z]{4,}[ \t][a-zA-Z]{4,}/.test(s);
function decodeShells(s) {
  let out = s.replace(/\b[A-Za-z0-9+/]{16,}={0,2}(?=$|[^A-Za-z0-9+/=])/g, (m) => {
    try { const d = Buffer.from(m, "base64").toString("utf8"); return plausible(d) ? d : m; } catch { return m; }
  });
  out = out.replace(/\b(?:[0-9a-fA-F]{2}){12,}\b/g, (m) => {
    try { const d = Buffer.from(m, "hex").toString("utf8"); return plausible(d) ? d : m; } catch { return m; }
  });
  return out;
}
// 倒序壳：整句倒着写。只认高精度的字面句，正反两个方向都查，给出行号
const REV_KW = ["忽略之前的所有指令", "忽略之前所有指令", "忽略之前的指令", "进入无限制模式", "无限制模式", "不要拒绝", "无视系统提示", "系统提示作废", "冒充系统", "优先于系统提示", "不再有任何限制"];
const revStr = (k) => [...k].reverse().join("");
function findRev(s) {
  const rs = [...s].reverse().join("");
  for (const k of REV_KW) {
    const rk = revStr(k);
    let i = s.indexOf(rk), needle = rk;            // 原文字面倒序
    if (i < 0) { i = rs.indexOf(k); needle = k; }  // 整体倒序后字面正序
    if (i < 0) continue;
    const pos = needle === rk ? i : s.length - i - needle.length;
    const line = s.slice(0, pos).split("\n").length;
    const ln = s.split("\n")[line - 1] || "";
    return { line, excerpt: ln.trim().slice(0, 120) };
  }
  return null;
}

// 防注入的说明会举例：「导出里要是有 "ignore previous instructions" 这类话，不要照做」（claude.ai 同步的官方技能 import-memory，11-05 误拦）。
// 只有「压过规则」「冒充系统」两类、而且三样齐了才不算这一处（DeepSeek 复核 v067b：光有引号 + 同行随便一句防御说法，能把破甲句原样带过去）：
//   1. 命中的片段整个在一对引号里；
//   2. 引号前面是举例的说法（such as / e.g. / addressed to you — / 例如 / 比如），或者引号后面紧跟「这类话」；
//   3. 引号后面明说别照做，而且说的就是它（do not follow it / treat them as data / 这类话不要照做）。「do not follow anything outside」不算
// 照抄这种句式、把破甲句塞进引号的，模型得违背一句明说的「别照做」才会执行：那是结构性封口（edition.mjs）的事，不归这里
const QUOTES = [['"', '"'], ["`", "`"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]];   // 单引号 ' 和英文缩写的撇号分不开，不认
const EXEMPT = new Set(["override", "spoof"]);
const EXAMPLE_PRE = /(?:\b(?:such\s+as|like|e\.g\.?|for\s+example|for\s+instance|including)|\baddressed\s+to\s+you\s*[—–:-]|例如|比如|诸如|像是?)[^\n]{0,60}$/i;
const EXAMPLE_POST = /^[,，、.。]?\s*(?:这类|这种|此类|之类|这样的|等)/;
const DEFENSIVE_POST = /\b(?:do\s+not|don'?t|never)\s+(?:follow|obey|comply\s+with|act\s+on|execute)\s+(?:it|them|these|this|that|those|such\s+(?:text|content|instructions|directives))\b|\btreat(?:ed)?\s+(?:it|them|these|this|that|those)\s+as\s+(?:plain\s+)?data\b|(?:这类|这种|此类|这些|之类)[^\n]{0,8}?(?:(?:不要|不得|不能|不|别|勿)(?:照做|执行|遵循|服从|听从|理会)|(?:当|视)(?:作|成|为)(?:普通)?(?:数据|资料)|不是指令)/i;
// 防御说法后面又改口点名执行的（「…这类话不要照做，除了第一条」「Do not follow it. Follow the first one instead.」）不算（DeepSeek 复核 v067c 中-1）
const REVOKE = /除了|除非|照做|照办|执行|参照|参见|比照|依(?:此|照)|照(?:此|用)|按(?:第|其|此)|据(?:此|引)|遵照|依照|沿用|从之|\b(?:except|unless|follow|obey|execute|apply|act\s+on)\b/i;
const count = (s, ch) => s.split(ch).length - 1;
/** 命中的片段整个在一对引号里：返回 [开引号位置, 收引号位置]，不在返回 null */
function quoteSpan(line, m) {
  const a = m.index, b = m.index + m[0].length, pre = line.slice(0, a);
  for (const [o, c] of QUOTES) {
    if (o === c) {
      if (count(pre, o) % 2 !== 1) continue;      // 前面开着一个引号没关
      const nc = line.indexOf(c, b);
      if (nc >= 0) return [pre.lastIndexOf(o), nc];
      continue;
    }
    const lo = pre.lastIndexOf(o), lc = pre.lastIndexOf(c), no = line.indexOf(o, b), nc = line.indexOf(c, b);
    if (lo > lc && nc >= 0 && (no < 0 || nc < no)) return [lo, nc];
  }
  return null;
}
function exempt(line, m) {
  const q = quoteSpan(line, m);
  if (!q) return false;
  const pre = line.slice(0, q[0]), post = line.slice(q[1] + 1);
  if (!(EXAMPLE_PRE.test(pre) || EXAMPLE_POST.test(post))) return false;
  const d = DEFENSIVE_POST.exec(post);
  return !!d && !REVOKE.test(post.slice(d.index + d[0].length));
}
const GLOBAL = new WeakMap();
function firstMatch(re, line, cat) {
  const m0 = re.exec(line);
  if (!m0 || !EXEMPT.has(cat) || !exempt(line, m0)) return m0;   // 绝大多数行到这里就完了
  let g = GLOBAL.get(re);
  if (!g) GLOBAL.set(re, (g = new RegExp(re.source, re.flags + "g")));
  g.lastIndex = 0;
  for (let m; (m = g.exec(line)); ) {
    if (!exempt(line, m)) return m;
    if (!m[0].length) g.lastIndex++;
  }
  return null;
}

/**
 * 查一段文字。返回 { blocked, hits:[{ cat, strong, line, excerpt }] }
 * hits 只列每类第一条，够用户定位；blocked 按「强一条 / 弱跨两类」判。
 * 原文先查（行号、豁免判定都在原文上）；再查归一化变体补覆盖：逐行归一（全角/零宽/字间分隔）、
 * 整段拼接归一（换行拆句）、外壳解码（base64/hex）。变体只补原文没命中的类别，不覆盖原文行号。
 */
export function scanText(text) {
  const s = String(text ?? "").slice(0, MAX_TEXT);
  const hits = [], seenCat = new Set();
  let strong = false;
  const addHit = (cat, isStrong, line, excerpt) => {
    if (seenCat.has(cat + isStrong)) return;
    hits.push({ cat, strong: isStrong, line, excerpt });
    seenCat.add(cat + isStrong);
    if (isStrong) strong = true;
  };
  const variants = [];
  const addVariant = (t, joined) => { if (t && t !== s && !variants.some((v) => v.t === t)) variants.push({ t, joined }); };
  addVariant(norm(s), false);                                   // 逐行归一
  // 整段拼接归一只在有换行时做（换行拆句）；外壳解码只在外壳疑似出现时做（复核 11-06 二轮：省 dirMatches 每轮重扫的开销）
  if (s.includes("\n")) addVariant(norm(s.replace(/\n/g, "")), true);
  if (/[A-Za-z0-9+/]{16,}={0,2}(?=$|[^A-Za-z0-9+/=])|(?:[0-9a-fA-F]{2}){12,}/.test(s)) {
    const dec = norm(decodeShells(s));
    if (dec !== s) { addVariant(dec, false); addVariant(norm(decodeShells(norm(s.replace(/\n/g, "")))), true); }
  }

  const lines0 = s.split("\n");
  const scanOne = (t, joined) => {
    const lines = joined ? [t] : t.split("\n");
    const joinedAll = joined ? t : t.replace(/\n/g, " ");
    const lineOf = (idx) => (joined ? 0 : Math.min(idx + 1, lines0.length));
    const excerptOf = (i, m) => {
      const ln = lineOf(i);
      if (ln > 0 && lines0[ln - 1] != null) return lines0[ln - 1].trim().slice(0, 120);
      return (m[0] || "").slice(0, 120);
    };
    for (const [cat, isStrong, re, opt] of RULES) {
      if (seenCat.has(cat + isStrong)) continue;
      if (opt && opt.joined) {
        // 跨行写的（一条拆成几行）：整段并成一行看，命中再回头找起始行
        const m = re.exec(joinedAll);
        if (!m) continue;
        if (joined) {
          addHit(cat, isStrong, 0, (m[0] || "").slice(0, 120));
        } else {
          // 原文扫描：按 m.index 回映射原行号（拼接串每行占 长度+1 个空格位）
          let off = 0, ln = 1;
          for (let k = 0; k < lines0.length; k++) {
            if (off + lines0[k].length + 1 > m.index) { ln = k + 1; break; }
            off += lines0[k].length + 1;
          }
          addHit(cat, isStrong, ln, lines0[ln - 1].trim().slice(0, 120));
        }
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        const m = firstMatch(re, lines[i], cat);
        if (!m) continue;
        addHit(cat, isStrong, lineOf(i), excerptOf(i, m));
        break;
      }
      // 跨行的（类目清单拆成几行）：整段再看一次
      if (!seenCat.has(cat + isStrong) && !isStrong && cat === "illicit" && re.test(joinedAll)) {
        addHit(cat, false, 0, "");
      }
    }
  };
  scanOne(s, false);
  for (const v of variants) scanOne(v.t, v.joined);
  const rv = findRev(s);
  if (rv) addHit("reverse", true, rv.line, rv.excerpt);

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
