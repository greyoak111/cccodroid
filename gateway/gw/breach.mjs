// 破甲特征检查：发行版回填给 claude 的文字（CLAUDE.md、rules、skill、斜杠命令、子代理、自动记忆…）先过这一关，命中整轮不跑。
//
// 这是认「现成破甲包」的，不是万能分类器：改写措辞能绕过去。所以发行版另外从结构上封口（--setting-sources ""，见 edition.mjs），
// 只有经过这里的文字才进上下文；钩子、插件代码这类查不了内容的，只认签名组件带的。
// 判定：强特征一条就算；弱特征要跨两类（一份正常的项目约定偶尔说一句「不要拒绝合理请求」不该被拦）。
// 规则只看文字本身，命中报文件与行号，给用户改。
// 判前先归一化（NFKC、去零宽、去汉字间分隔），并还原 base64/hex 外壳、查倒序句：形态变换不能直接穿层。

/** [类别, 强?, 正则]。类别相同的弱特征只算一类 */
// 英文词间分隔容忍（红队 r8 11-08）：ignore. all. / never. refuse / no. restrictions 这类词间插标点的改形，
// 和中文 P1-3 一个道理，词与词之间允许少量标点分隔。只放宽英文多词短语，单词语义不变。
const RULES = [
  // 自称破甲 / 越狱
  // 只提这个词不算（讨论破甲的笔记、审计报告到处都是）；要和下面别的类别一起出现
  ["jailbreak", true, /\bDAN[.,;:!?|/\\_\-*'"\s]{1,4}mode\b|\bdo[.,;:!?|/\\_\-*'"\s]{1,4}anything[.,;:!?|/\\_\-*'"\s]{1,4}now\b|developer[.,;:!?|/\\_\-*'"\s]{1,4}mode[.,;:!?|/\\_\-*'"\s]{1,4}(?:enabled|on)\b|开发者模式(?:已)?(?:开启|启用)|(?:你是|现在是|我是)[.,;:!?|/\\_\-*'"\s]{0,4}DAN\b/i],
  // 复核（11-06 三轮）：反破甲/防破甲这类否定式是讨论防御工程，不是用词本身；排除后不再参与跨类凑数
  // 红队收窄 r4（11-07）：设备语境（iOS/iPhone/iPad/安卓/Android/手机/设备/平板/刷机/系统级 + 越狱）不算——
  // 讲刷机越狱的日常文档不该凑成跨类误拦；模型越狱的说法（越狱提示、越狱模式之类）照拦
  ["jailbreak", false, /(?<![反防抗])破甲|(?<!(?:[反防抗]|iOS|iPhone|iPad|安卓|Android|手机|设备|平板|刷机|系统级)[ \t　]*)越狱|(?<![A-Za-z-])jail\s*-?\s*break/i],
  // 冒充系统、开发者、Anthropic 的消息
  ["spoof", true, /<\/?\s*system-reminder\s*>|<\/?\s*(?:system|developer)(?:[_-]?(?:message|prompt|instructions?))?\s*>|[<＜]\/?\s*(?:system-reminder|system|developer)(?:\s+(?:message|instruction|override))?\s*[>＞]|\[\s*(?:system|developer)\s+(?:message|instruction|override)\s*\]|anthropic\s+(?:policy|safety|system)\s+(?:update|override|exception)|\bauthority\s*[:：]\s*(?:anthropic|system|developer)\b|\boverride\s*[:：]\s*(?:true|yes|on)\b|\boperator[.,;:!?|/\\_\-*'"\s]{1,4}directive\b|(?:系统层|平台|系统)(?:的)?(?:下发|注入)(?:的)?(?:补充)?(?:说明|通知|指令|更新)|(?:早先|之前|此前|以上)(?:的)?规则(?:已|全部)?(?:作废|失效|取消)/i],
  // role: system 单条只算弱特征：正常文档也会举 prompt 格式的例子，单条不拦（s05 那种头里有 authority/override 的仍是强特征）
  ["spoof", false, /(?:^|\n)\s*role\s*[:：]\s*(?:system|developer|anthropic)\b/i],
  // 压过宿主 / 系统 / 安全规则
  // 红队 11-07：句读/斜杠/注音拆词的「忽略之前的…」直球，词间字间都放行分隔符（语料 2471 份该拆法 0 出现）。
  // 拼音夹汉字、中英混排不在此列（正则层不追，语义闸门兜）
  // 良性复核 11-07：「忽略」链里得有一个指范围的词（你/所有/之前/系统…）才认提示/规则/设定/限制，
  // 只有「的/收到/看到」这类泛词的只认「指令」——不然「可以忽略，收到的提示是旧版残留」「忽略看到的规则提示」也拦。
  // 「无视」要带全称量词、宿主/内置，或明说提示词/指令；裸「无视系统提示」挪进下面的弱规则。
  // 加减规则别插在中间：EDGE_RE / CJK_ONLY 按下标对应
  // 日/俄/韩直球短语（红队 r8 11-08）：只收「忽略以前的所有指示」这类高精度整短语，全面多语言不追（沿拼音先例归语义闸门）
  ["override", true, /(?:ignor\w*|disregard\w*|forg\w*|overrid\w*)[.,;:!?|/\\_\-*'"\s]{1,4}(?:all[.,;:!?|/\\_\-*'"\s]{1,4})?(?:(?:your|the|any|previous|prior|above|earlier|system)[.,;:!?|/\\_\-*'"\s]{1,4}){1,3}(?:instructions|prompts?|rules|guidelines|polic(?:y|ies)|safety|restrictions)|忽略(?:掉)?(?:[，。、；：\/]{0,2}(?:你|你的|所有|一切|之前|以上|上面|系统|全部|的|收到|看到|读到|见到|知道)){0,3}[，。、；：\/]{0,2}(?:你|你的|所有|一切|之前|以上|上面|系统|全部)(?:[，。、；：\/]{0,2}(?:你|你的|所有|一切|之前|以上|上面|系统|全部|的|收到|看到|读到|见到|知道)){0,3}[，。、；：\/]{0,2}(?:系统)?[，。、；：\/]{0,2}(?:提示|指令|规则|设定|限制)|忽略(?:掉)?(?:[，。、；：\/]{0,2}(?:的|收到|看到|读到|见到|知道)){1,3}[，。、；：\/]{0,2}指令|忽(?:[，。、；：\/]|\(\d+\))*略(?:[，。、；：\/]|\(\d+\))*之(?:[，。、；：\/]|\(\d+\))*前(?:[，。、；：\/]|\(\d+\))*的(?:[，。、；：\/]|\(\d+\))*(?:所(?:[，。、；：\/]|\(\d+\))*有(?:[，。、；：\/]|\(\d+\))*)?指(?:[，。、；：\/]|\(\d+\))*令|无视(?:掉)?[，。、；：\/]{0,2}(?:一切|所有|任何)[，。、；：\/]{0,2}(?:系统|宿主|内置)?[，。、；：\/]{0,2}(?:提示|指令|规则|设定|限制)|无视(?:掉)?[，。、；：\/]{0,2}(?:宿主|内置)[，。、；：\/]{0,2}(?:提示|指令|规则|设定|限制)|无视(?:掉)?[，。、；：\/]{0,2}系统[，。、；：\/]{0,2}(?:提示词|指令)|无(?:[，。、；：\/]|\(\d+\))*视(?:[，。、；：\/]|\(\d+\))*系(?:[，。、；：\/]|\(\d+\))*统(?:[，。、；：\/]|\(\d+\))*提(?:[，。、；：\/]|\(\d+\))*示(?<!无视系统提示)|(?:优先级|效力)\s*(?:高于|压过|大于)\s*(?:一切|所有|系统|宿主|安全)|用户(?:任务|指令)?\s*>\s*(?:本)?规则\s*>\s*(?:宿主|系统)|(?:以前|これまで)(?:の)?(?:すべての|全ての)?(?:指示|命令)(?:を|は)?(?:無視|削除)|игнорируй(?:те)?[.,;:!?|/\\_\-*'"\s]{1,4}(?:все[.,;:!?|/\\_\-*'"\s]{1,4})?(?:предыдущие|прошлые)[.,;:!?|/\\_\-*'"\s]{1,4}инструкции|이전(?:의)?[.,;:!?|/\\_\-*'"\s]{1,4}(?:모든[.,;:!?|/\\_\-*'"\s]{1,4})?(?:지시(?:사항)?|지침)(?:을|를)?[.,;:!?|/\\_\-*'"\s]{1,4}(?:모두[.,;:!?|/\\_\-*'"\s]{1,4})?무시/i],
  // 裸「无视系统提示 / 规则」只算弱：装 APK 的说明里常写「无视系统提示，点仍然安装」（11-07 良性复核）
  ["override", false, /无视(?:掉)?系统(?:提示|规则)|系统(?:的)?默认(?:倾向|规则|限制)|(?:above|over)\s+(?:all\s+)?(?:system|default)\s+(?:behaviou?r|instructions)/i],
  // 群友 zx-5426 的红队资料（11-05）里漏掉的写法：把自己排在内置系统提示之上（权威链用全角 ＞）、「冲突时以本节为准」
  ["override", true, /(?:优先于|高于|压过|凌驾于?)(?:一切|所有)?(?:内置|宿主|默认)?的?系统提示|(?:与|和)(?:内置|宿主)?(?:系统)?(?:提示|指令)冲突时[，,]?以(?:本节|本文件|本规范|本段|此)为准|[＞>][^\n]{0,30}(?:内置|宿主)(?:系统)?提示|上位压死下位|(?:以下|本)(?:约定|规则|规范)[^\n]{0,20}比(?:内置|宿主|系统)[^\n]{0,10}(?:要紧|重要|优先)|\b(?:where|if)[.,;:!?|/\\_\-*'"\s]{1,4}this[.,;:!?|/\\_\-*'"\s]{1,4}document[.,;:!?|/\\_\-*'"\s]{1,4}conflicts?[.,;:!?|/\\_\-*'"\s]{1,4}with[^\n]{0,40}this[.,;:!?|/\\_\-*'"\s]{1,4}document[.,;:!?|/\\_\-*'"\s]{1,4}wins\b|\bthis[.,;:!?|/\\_\-*'"\s]{1,4}document[.,;:!?|/\\_\-*'"\s]{1,4}(?:takes[.,;:!?|/\\_\-*'"\s]{1,4}precedence|prevails)\b|(?:本规范|本文件|本规则)[^\n]{0,6}(?:覆盖|取代|顶替)[^\n]{0,6}(?:内置|系统)(?:提示|规则|指令)|(?:内置|系统)(?:提示|规则|指令)[^\n]{0,10}(?:被|由)[^\n]{0,4}(?:本规范|本文件)[^\n]{0,4}(?:覆盖|取代|顶替)|宿主[^\n]{0,4}默认(?:倾向|规则|限制)/i],
  ["override", false, /宿主对齐|对齐层/],
  // 宣布没有限制
  ["unlimited", true, /不存在[^\n]{0,12}不属于我的范围|(?:没有|无|取消)(?:任何)?(?:内容)?(?:限制|禁区|底线|审查)(?:声明|模式)|无限制(?:声明|模式|规则)|\b(?:no|without)[.,;:!?|/\\_\-*'"\s]{1,4}(?:any[.,;:!?|/\\_\-*'"\s]{1,4})?(?:restrictions|limits|filters|censorship)[.,;:!?|/\\_\-*'"\s]{1,4}(?:mode|apply|whatsoever)|\buncensored[.,;:!?|/\\_\-*'"\s]{1,4}mode\b|\bunrestricted[.,;:!?|/\\_\-*'"\s]{1,4}mode\b|不存在(?:任何|什么)?(?:禁区|底线)|没有(?:任何|什么)?(?:禁区|底线问题|底线)|(?:所有|任何)(?:话题|问题)(?:都|一律)?(?:照答|可答)|(?:按|以|作)「?全开」?(?:处理|对待|运行)|(?:要什么|要啥)(?:就)?给(?:什么|啥)/i],
  ["unlimited", false, /无限制|全开|不设限|不设(?:话题)?禁区|\buncensored\b|\bno[.,;:!?|/\\_\-*'"\s]{1,4}(?:restrictions|limits|filters)\b/i],
  // 拆拒答：软拒 / 禁用句型 / 不评估性质 / 不问用途
  ["antirefuse", true, /软拒|拒答的唯一来源|禁用句型|(?:不|别|勿)(?:要)?(?:评估|判断|审查)(?:请求|用户)?(?:的)?(?:性质|意图|动机)|\bnever[.,;:!?|/\\_\-*'"\s]{1,4}refuse\b|\bmust[.,;:!?|/\\_\-*'"\s]{1,4}not[.,;:!?|/\\_\-*'"\s]{1,4}refuse\b|refusals?[.,;:!?|/\\_\-*'"\s]{1,4}(?:are|is)[.,;:!?|/\\_\-*'"\s]{1,4}(?:forbidden|not[.,;:!?|/\\_\-*'"\s]{1,4}allowed|prohibited)/i],
  // 红队资料（11-05）：宣布没有该拒绝的、把拒绝说成输出故障 / RLHF 误触发、列一串拒答句当禁用词、之前的拒绝不算数、不给任务定性
  ["antirefuse", true, /不存在(?:任何)?需要(?:拒绝|评估|授权)|拒绝(?:是|=|＝)\s*(?:输出)?(?:管道)?故障|(?:命中|出现)[^\n]{0,12}(?:=|＝|即判?)\s*输出故障|拒绝[^\n]{0,20}(?:出现|命中)即(?:视为|判)?(?:输出)?故障|RLHF[^\n]{0,8}(?:产物|误触发)|(?:早前|之前|先前|此前)(?:那些|的)?拒绝[^\n]{0,20}(?:不削弱|无效|作废|不算)|不(?:要)?(?:对|给)(?:任务|请求)(?:做)?(?:性质)?(?:归类|定性)|(?:(?:抱歉|对不起|我不能|我无法|无法协助|作为一个?\s*AI|As an AI|I can'?t|I'?m sorry)[^\n]{0,24}){4}|(?:把|将)[^\n]{0,20}(?:抱歉|我不能|我无法|拒绝)[^\n]{0,20}(?:从|在)(?:你的)?(?:输出|回复|答复)[^\n]{0,10}(?:删|去|清|移除)|不(?:需要|必|用)确认授权[^\n]{0,30}(?:也)?不(?:用|必)问(?:用途|来意)|缺(?:少|的)?参数[^\n]{0,15}(?:自己|自行|直接)(?:填|补|定)/i],
  ["antirefuse", false, /不(?:逐条)?(?:询问|索要)授权|反问(?:用户)?(?:是否有)?权限|(?:合法|被授权|在范围内)[^\n]{0,12}(?:=|＝)\s*惰性|不作推理输入|拒绝(?:冲动|倾向)/],
  ["antirefuse", false, /(?:不(?:要|准|得|许)|禁止|别)拒绝|不(?:确认|核实)授权|不问用途|不要求(?:书面)?(?:授权|范围|材料)|(?:do[.,;:!?|/\\_\-*'"\s]{1,4}not|don't)[.,;:!?|/\\_\-*'"\s]{1,4}(?:refuse|decline)|\bnever[.,;:!?|/\\_\-*'"\s]{1,4}(?:decline|reject)\b|(?:no|without)[.,;:!?|/\\_\-*'"\s]{1,4}(?:any[.,;:!?|/\\_\-*'"\s]{1,4})?(?:warnings|disclaimers?)(?=[^\n]{0,20}\byour\b)|\byour[.,;:!?|/\\_\-*'"\s]{1,4}(?:output|replies|responses|answers|refusals?)\w*[.,;:!?|/\\_\-*'"\s]{1,4}[^\n]{0,16}[.,;:!?|/\\_\-*'"\s]{0,4}(?:no|without)[.,;:!?|/\\_\-*'"\s]{1,4}(?:any[.,;:!?|/\\_\-*'"\s]{1,4})?(?:warnings|disclaimers?)\b|不(?:写|加)(?:免责|风险提示|能力边界)/i],
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
  ["illicit", false, /(?:(?:木马|免杀|杀软|钓鱼|洗钱|盗版|外挂|社工|伪造|渗透|过检|反作弊|注册机)[^\n]{0,6}){3,}|(?:malware|money[.,;:!?|/\\_\-*'"\s]{1,4}laundering|piracy|cheats?|forgery)[^\n]{0,40}(?:just|only)[.,;:!?|/\\_\-*'"\s]{1,4}(?:a[.,;:!?|/\\_\-*'"\s]{1,4})?(?:task|ticket|job)/i],
  // 提取系统提示（红队 r8 11-08，封禁族 BW-01 对照缺口）：单条只算弱——安全文档常描述这类测试，
  // 和别的类别一起出现才拦。日/英短语同收，全面多语言不追
  ["reveal", false, /(?:提取|输出|打印|展示|泄露|透露|复述)(?:你|你的)?(?:完整|全部)?(?:系统提示(?:词)?|初始提示(?:词)?)|システムプロンプト(?:を|の)?(?:出力|表示|開示|教えて)|\b(?:output|print|reveal|show|extract)[.,;:!?|/\\_\-*'"\s]{1,4}(?:me[.,;:!?|/\\_\-*'"\s]{1,4})?(?:your|the)[.,;:!?|/\\_\-*'"\s]{1,4}(?:full[.,;:!?|/\\_\-*'"\s]{1,4}|complete[.,;:!?|/\\_\-*'"\s]{1,4}|entire[.,;:!?|/\\_\-*'"\s]{1,4})?system[.,;:!?|/\\_\-*'"\s]{1,4}prompt\b|\bprompt[.,;:!?|/\\_\-*'"\s]{1,4}extraction\b/i],
];

// 对行边界敏感的规则：带 \b、^ 或行尾前后瞻的——拼接文本里行边界消失，这些锚的语义会变，
// 中文文件的主扫描直接扫拼接文本时，这几条要另做逐行补扫（性能项 11-06）。
// 只边界敏感的少数分支才需要补扫（其余分支拼接扫描已含逐行语义）：拆出来当补扫正则，
// null 的用整条规则（基本全是边界敏感、或降弱逻辑需要整条的）
const EDGE_IDX = new Set([0, 2, 3, 6, 8, 9, 10, 13, 14]);
const EDGE_RE = [];
EDGE_RE[0] = /\bDAN[.,;:!?|/\\_\-*'"\s]{1,4}mode\b|\bdo[.,;:!?|/\\_\-*'"\s]{1,4}anything[.,;:!?|/\\_\-*'"\s]{1,4}now\b|developer[.,;:!?|/\\_\-*'"\s]{1,4}mode[.,;:!?|/\\_\-*'"\s]{1,4}(?:enabled|on)\b|(?:你是|现在是|我是)[.,;:!?|/\\_\-*'"\s]{0,4}DAN\b/i;
EDGE_RE[2] = /<\/?\s*system-reminder\s*>|<\/?\s*(?:system|developer)(?:[_-]?(?:message|prompt|instructions?))?\s*>|[<＜]\/?\s*(?:system-reminder|system|developer)(?:\s+(?:message|instruction|override))?\s*[>＞]|\[\s*(?:system|developer)\s+(?:message|instruction|override)\s*\]|\bauthority\s*[:：]\s*(?:anthropic|system|developer)\b|\boverride\s*[:：]\s*(?:true|yes|on)\b|\boperator[.,;:!?|/\\_\-*'"\s]{1,4}directive\b/i;
EDGE_RE[6] = /\b(?:where|if)[.,;:!?|/\\_\-*'"\s]{1,4}this[.,;:!?|/\\_\-*'"\s]{1,4}document[.,;:!?|/\\_\-*'"\s]{1,4}conflicts?[.,;:!?|/\\_\-*'"\s]{1,4}with[^\n]{0,40}this[.,;:!?|/\\_\-*'"\s]{1,4}document[.,;:!?|/\\_\-*'"\s]{1,4}wins\b|\bthis[.,;:!?|/\\_\-*'"\s]{1,4}document[.,;:!?|/\\_\-*'"\s]{1,4}(?:takes[.,;:!?|/\\_\-*'"\s]{1,4}precedence|prevails)\b/i;
EDGE_RE[8] = /\b(?:no|without)[.,;:!?|/\\_\-*'"\s]{1,4}(?:any[.,;:!?|/\\_\-*'"\s]{1,4})?(?:restrictions|limits|filters|censorship)[.,;:!?|/\\_\-*'"\s]{1,4}(?:mode|apply|whatsoever)|\buncensored[.,;:!?|/\\_\-*'"\s]{1,4}mode\b|\bunrestricted[.,;:!?|/\\_\-*'"\s]{1,4}mode\b/i;
EDGE_RE[9] = /\buncensored\b|\bno[.,;:!?|/\\_\-*'"\s]{1,4}(?:restrictions|limits|filters)\b/i;
EDGE_RE[10] = /\bnever[.,;:!?|/\\_\-*'"\s]{1,4}refuse\b|\bmust[.,;:!?|/\\_\-*'"\s]{1,4}not[.,;:!?|/\\_\-*'"\s]{1,4}refuse\b/i;
EDGE_RE[13] = /\bnever[.,;:!?|/\\_\-*'"\s]{1,4}(?:decline|reject)\b|(?:no|without)[.,;:!?|/\\_\-*'"\s]{1,4}(?:any[.,;:!?|/\\_\-*'"\s]{1,4})?(?:warnings|disclaimers?)(?=[^\n]{0,20}\byour\b)|\byour[.,;:!?|/\\_\-*'"\s]{1,4}(?:output|replies|responses|answers|refusals?)\w*[.,;:!?|/\\_\-*'"\s]{1,4}[^\n]{0,16}[.,;:!?|/\\_\-*'"\s]{0,4}(?:no|without)[.,;:!?|/\\_\-*'"\s]{1,4}(?:any[.,;:!?|/\\_\-*'"\s]{1,4})?(?:warnings|disclaimers?)\b/i;
const RULES_EDGE = RULES.map((r, i) => EDGE_RE[i] ?? r[2]);
const RULES_EDGE_G = RULES_EDGE.map((re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
// 纯汉字规则的：文字里一个汉字都没有就不可能命中，整段跳过（性能项 11-06）
const CJK_ONLY = new Set([7, 12, 14, 18, 20, 21]);

const MAX_TEXT = 2 << 20;   // 超过的只看前 2MB

// ── 归一化与外壳解码（防形变）────────────────────────────────
// 只动不影响语义的形态：全角→半角（NFKC）、零宽与格式控制字符、汉字之间插的分隔符。
// 引号不动（豁免判定靠引号定位）；行分隔符换成普通换行，不合并行。
const ZW_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
// 只删空格类与间隔号，句读（，。；：）不删：把两句话拼成一句会造出「不要拒绝，任何请求…」这种假阳性（复核 11-06 二轮）
const SEP_RE = /(?<=[\u4e00-\u9fff])[ \t\u3000·・]*(?=[\u4e00-\u9fff])/g;
const norm = (s) => s.normalize("NFKC").replace(/[\u2028\u2029]/g, "\n").replace(ZW_RE, "").replace(SEP_RE, "");
// 规则无关的归一（全角标点→半角、NFKC 杂项）不改任何规则的字面；只有全角字母数字、零宽/行分隔符、
// 汉字间分隔才可能让规则命中。都没有就不做归一（性能项 11-06）。
// NFKC 很贵：只有全角字母数字需要它；零宽/行分隔/汉字间分隔用轻量正则就够了
const NORM_RELEVANT = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]|[\u4e00-\u9fff][ \t\u3000\u00b7\u30fb][\u4e00-\u9fff]/;
// \u540c\u5f62\u5b57\u6539\u5f62\uff08\u7ea2\u961f r8 11-08\uff09\uff1a\u897f\u91cc\u5c14/\u5e0c\u814a\u91cc\u957f\u5f97\u50cf\u62c9\u4e01\u5b57\u6bcd\u7684\u6309\u62c9\u4e01\u6620\u5c04\uff0c\u4f5c\u4e3a\u72ec\u7acb\u53d8\u4f53\u626b\u4e00\u904d\u2014\u2014
// \u53ea\u52a0\u53d8\u4f53\u3001\u4e0d\u52a8\u4e3b\u6587\u672c\u4e0e\u884c\u53f7\uff08\u6620\u5c04\u6309\u5b57\u7b26\u4e00\u4e00\u5bf9\u5e94\uff0c\u884c\u7ed3\u6784\u4e0d\u53d8\uff09\uff1b\u4e3b\u626b\u63cf\u5df2\u4e2d\u7684\u7c7b\u522b\u4e0d\u4f1a\u91cd\u590d\u8ba1\u3002
// \u53ea\u78b0\u542b\u540c\u5f62\u5b57\u7684\u6587\u672c\uff1b\u6570\u5b66\u6587\u6863\u91cc\u7684\u5e0c\u814a\u5b57\u6bcd\u4f1a\u89e6\u53d1\u4e00\u8d9f\u53d8\u4f53\u626b\u63cf\uff0c\u8bef\u62e6\u7531\u8bed\u6599\u95e8\u628a\u4f4f\uff08\u4e24\u4efd\u771f\u5b9e\u8bed\u6599 0 \u65b0\u589e\uff09\u3002
const CONFUSABLE = new Map(Object.entries({
  "\u0430":"a","\u0432":"b","\u0433":"r","\u0435":"e","\u0438":"u","\u0456":"i","\u0458":"j","\u043a":"k","\u043c":"m","\u043d":"h","\u043e":"o","\u043f":"n","\u0440":"p","\u0441":"c","\u0442":"t","\u0443":"y","\u0445":"x","\u0455":"s","\u044c":"b",
  "\u0410":"A","\u0412":"B","\u0415":"E","\u0406":"I","\u0408":"J","\u041a":"K","\u041c":"M","\u041d":"H","\u041e":"O","\u0420":"P","\u0421":"C","\u0422":"T","\u0423":"Y","\u0425":"X","\u0405":"S",
  "\u03b1":"a","\u03b2":"b","\u03b3":"y","\u03b5":"e","\u03b7":"n","\u03b9":"i","\u03ba":"k","\u03bc":"u","\u03bd":"v","\u03bf":"o","\u03c0":"n","\u03c1":"p","\u03c4":"t","\u03c5":"u","\u03c7":"x",
  "\u0391":"A","\u0392":"B","\u0395":"E","\u0397":"H","\u0399":"I","\u039a":"K","\u039c":"M","\u039d":"N","\u039f":"O","\u03a1":"P","\u03a4":"T","\u03a5":"Y","\u03a7":"X","\u0396":"Z",
}));
const CONF_G = new RegExp("[" + [...CONFUSABLE.keys()].join("") + "]", "g");
const CONF_T = new RegExp(CONF_G.source);   // \u4e0d\u5e26 g \u7684\u5b88\u536b\uff08\u907f\u514d lastIndex \u72b6\u6001\uff09
const confusableMap = (s) => s.replace(CONF_G, (c) => CONFUSABLE.get(c));
const FULL_ALNUM = /[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/;
const normLite = (s) => s.replace(/[\u2028\u2029]/g, "\n").replace(ZW_RE, "").replace(SEP_RE, "");
// 常见编码壳：base64、十六进制。解出来必须含规则锚词才替换——只含汉字/成句英文不够：
// 乱码常带单个汉字，被旧判据放行后整份乱码还要过全规则扫描，实测占良性全量一半耗时（性能项 11-06）。
// 真攻击解出来必然是规则句式，锚词必在。
const plausible = (s) => /(?:忽略|指令|提示|系统|拒绝|限制|模式|规则|用户|任务|约束|木马|免杀|钓鱼|洗钱|盗版|外挂|社工|伪造|渗透|crack|keygen|patch|authority|instructions?|system|ignore|refuse|decline|restrict|priority|unlimited|jailbreak|bypass)/i.test(s);
// 判有无的守卫尽量简（不带 g，避免 lastIndex 状态）：
// b64 只要「连续 16 个 b64 字符」即可——只有 3+ 个尾随 = 的怪串会虚报，替换照样解不出东西，无害（性能项 11-06）
const B64_GUARD = /[A-Za-z0-9+/]{16}/;
const HEX_GUARD = /[0-9a-fA-F]{24}/;   // 偶数成对 ≥24 个十六进制字符（奇数尾差一个半字节，解出来一样）
// 替换还是按完整候选：b64 要整段（≤2 个尾随 =）+ hex 整段
const B64_RE = /[A-Za-z0-9+/]{16,}={0,2}(?=$|[^A-Za-z0-9+/=])/g;
const B64_NG = new RegExp(B64_RE.source);   // 不带 g 的同款：在替换回调里测「解出来还是不是壳」，不能动外层循环的 lastIndex
const HEX_RE = /[0-9a-fA-F]{24,}/g;
// 哪种外壳疑似出现才解哪种（性能项 11-06：代码里满地的哈希只满足 hex 守卫，不解 base64 就省一整遍扫描）
// 红队 11-07：双层壳（b64 套 b64 / b64 套 hex 等）第一层解出来没锚词就丢了——解出来还是壳样串就再解一层（封顶两层）
// ROT13 壳（红队 r8 11-08）：原文含「ROT13 编码的锚词」（R13_SHELL）才轮转，解出来含规则锚词（R13_ANCHOR）才作为变体扫——
// 两道闸都是每文件一次正则，普通文本白扫一趟的代价只有一次字符映射
const rot13 = (s) => s.replace(/[A-Za-z]/g, (c) => {
  const b = c <= "Z" ? 65 : 97;
  return String.fromCharCode(b + ((c.charCodeAt(0) - b + 13) % 26));
});
// ROT13 解出来必须含规则锚词才算壳（普通英文 ROT13 后是乱码，过不了这个闸）
const R13_ANCHOR = /\b(?:ignore|disregard|forget|override|instructions?|prompts?|rules?|system|refus(?:e|als?)|restrictions?|uncensored|unrestricted|unlimited|previous|prior|operator|directive|authority|anthropic|jailbreak|warnings?|output|reveal|extract(?:ion)?|precedence)\b/i;
// 锚词的 ROT13 编码：原文里出现这些串才值得轮转（每文件一次正则测试，性能项）
const R13_SHELL = /\b(?:vtaber|qvfertneq|bireevqr|vafgehpgvbaf?|cebzcgf?|flfgrz|ershfr|ershfnyf|erfgevpgvbaf?|haprafberq|hayvzvgrq|cerivbhf|bcrengbe|qverpgvir|nhgubevgl|arire|QNA)\b/i;
function decodeShells(s, b64, hex) {
  const second = (d, m) => {
    // hex 先试：hex 串（[0-9a-f]）全是 b64 字符，B64_NG 会误中，hex 守卫更严（≥24 个十六进制字符）
    try {
      if (HEX_GUARD.test(d)) { const d2 = Buffer.from(d, "hex").toString("utf8"); if (plausible(d2)) return d2; }
      if (B64_NG.test(d)) { const d2 = Buffer.from(d, "base64").toString("utf8"); if (plausible(d2)) return d2; }
    } catch {}
    return m;
  };
  let out = s;
  if (b64) out = out.replace(B64_RE, (m) => {
    try { const d = Buffer.from(m, "base64").toString("utf8"); return plausible(d) ? d : second(d, m); } catch { return m; }
  });
  if (hex) out = out.replace(HEX_RE, (m) => {
    try { const d = Buffer.from(m, "hex").toString("utf8"); return plausible(d) ? d : second(d, m); } catch { return m; }
  });
  return out;
}
// 倒序壳：整句倒着写。只认高精度的字面句。原文里找倒序词即可——
// 「整体倒序后字面正序」等价于「原文里出现倒序词」（rs.indexOf(k) ⟺ s.indexOf(rk)，语料 5522 项验证一致），
// 不用再构造整文倒序（性能项 11-06）
const REV_KW = ["忽略之前的所有指令", "忽略之前所有指令", "忽略之前的指令", "进入无限制模式", "无限制模式", "不要拒绝", "无视系统提示", "系统提示作废", "冒充系统", "优先于系统提示", "不再有任何限制"];
const REV_RK = REV_KW.map((k) => [...k].reverse().join(""));
function findRev(s) {
  for (let i = 0; i < REV_KW.length; i++) {
    const pos = s.indexOf(REV_RK[i]);
    if (pos < 0) continue;
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
const EXAMPLE_POST = /^[,，、.。]?\s*(?:这类|这种|此类|之类|这样的|等|(?:旧|老|过时|废弃|淘汰)(?:表述|说法|提法|写法|措辞|句式|话))/;
const DEFENSIVE_POST = /\b(?:do\s+not|don'?t|never)\s+(?:follow|obey|comply\s+with|act\s+on|execute)\s+(?:it|them|these|this|that|those|such\s+(?:text|content|instructions|directives))\b|\btreat(?:ed)?\s+(?:it|them|these|this|that|those)\s+as\s+(?:plain\s+)?data\b|(?:这类|这种|此类|这些|之类)[^\n]{0,8}?(?:(?:不要|不得|不能|不|别|勿)(?:照做|执行|遵循|服从|听从|理会)|(?:当|视)(?:作|成|为)(?:普通)?(?:数据|资料)|不是指令|(?:旧|老|过时|废弃|淘汰)(?:表述|说法|提法|写法|措辞|句式|话))|^(?:旧|老|过时|废弃|淘汰)(?:表述|说法|提法|写法|措辞|句式|话)/i;
// 防御说法后面又改口点名执行的（「…这类话不要照做，除了第一条」「Do not follow it. Follow the first one instead.」）不算（DeepSeek 复核 v067c 中-1）
const REVOKE = /除了|除非|照做|照办|执行|参照|参见|比照|依(?:此|照)|照(?:此|用)|按(?:第|其|此)|据(?:此|引)|遵照|依照|沿用|从之|\b(?:except|unless|follow|obey|execute|apply|act\s+on)\b/i;
const count = (s, ch) => s.split(ch).length - 1;
// 行首的空白、引用（>）、列表（- * + 数字. 数字)）、标题（#）记号不算正文：这些开头的标签仍是行首标签
const LINE_MARK = /^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s*/;
/** 句中单个标签：前面同一行已有正文、且全文（反引号/围栏外）没有同名的另一半标签——是被谈论的标签名，不是包住一段话的冒充（简报③补充，二轮复核 11-06；成对改看全文，三轮复核 11-06） */
const midTag = (line, idx, m0, whole) => {
  const tag = m0.replace(/^\s+/, "");
  if (!/^[<＜]/.test(tag)) return false;
  let p = line.slice(0, idx);
  for (;;) { const m = LINE_MARK.exec(p); if (!m || !m[0].length) break; p = p.slice(m[0].length); }
  if (!/\S/.test(p)) return false;
  const name = (tag.match(/[a-z][\w-]*/i) || [""])[0].toLowerCase();
  const esc = name.replace(/-/g, "\\-");
  // 全文里同名标签开、关两半都出现：是包住一段话的冒充（跨行、各行前加字也算），仍强
  const open = new RegExp("[<＜]\\s*" + esc + "\\b", "i"), close = new RegExp("[<＜]\\/\\s*" + esc + "\\b", "i");
  const bare = whole.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1/gm, "").replace(/`[^`\n]*`/g, "");
  return !(open.test(bare) && close.test(bare));
};
/** 位置 idx 是否落在行内代码（反引号）里：前面反引号数为奇数 */
const inBacktick = (line, idx) => {
  let n = 0;
  for (let p = 0; p < idx && p < line.length; p++) if (line[p] === "`") n++;
  return n % 2 === 1;
};
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
// 各规则的 g 版本，g 循环扫描用：预编译一次，用前 lastIndex 归零（性能项 11-06：每份每轮 new RegExp 是编译大头）
const RULES_G = RULES.map((r) => new RegExp(r[2].source, r[2].flags.includes("g") ? r[2].flags : r[2].flags + "g"));

/**
 * 查一段文字。返回 { blocked, hits:[{ cat, strong, line, excerpt }] }
 * hits 只列每类第一条，够用户定位；blocked 按「强一条 / 弱跨两类」判。
 * 主扫描直接在归一化后的文字上做（归一只动不影响语义的形态，豁免的引号定位不受影响；全角/零宽/字间分隔的形变
 * 一次扫掉，不用再扫一遍原文）；再查两个变体补覆盖：整段拼接（换行拆句，不归一——要能映射回原行）、
 * 外壳解码（base64/hex）。变体只补主扫描没命中的类别，不覆盖主扫描行号。
 */
export function scanText(text) {
  const s = String(text ?? "").slice(0, MAX_TEXT);
  // 只有规则相关的归一（全角字母数字/零宽/行分隔符/汉字间分隔）才做；其中 NFKC 只在全角字母数字时必要（性能项 11-06）
  const base = !process.env.BREACH_NO_NORM && NORM_RELEVANT.test(s) ? (FULL_ALNUM.test(s) ? norm(s) : normLite(s)) : s;
  const hits = [], seenCat = new Set();
  let strong = false;
  const addHit = (cat, isStrong, line, excerpt) => {
    if (seenCat.has(cat + isStrong)) return;
    hits.push({ cat, strong: isStrong, line, excerpt });
    seenCat.add(cat + isStrong);
    if (isStrong) strong = true;
  };
  const variants = [];
  const addVariant = (t, joined, mapped) => { if (t && t !== s && !variants.some((v) => v.t === t)) variants.push({ t, joined, mapped }); };
  // 拼接变体只在原文含 CJK 或零宽字符时生成（拆句主要是中文词形变；纯 ASCII 文件拆句由逐行扫描兜底，简报②口径）
  if (s.includes("\n") && !process.env.BREACH_NO_JOIN && /[一-鿿\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(s)) addVariant(s.replace(/\n/g, ""), true, true);
  if (!process.env.BREACH_NO_DECODE) {
    const hasB64 = B64_GUARD.test(s), hasHex = HEX_GUARD.test(s);
    if (hasB64 || hasHex) {
      // 先解外壳再归一：守卫命中大多解不出东西（哈希、随机串），整份 NFKC 很贵，别白做（性能项 11-06）
      const raw = decodeShells(s, hasB64, hasHex);
      if (raw !== s) {
        // 只做逐行解码：解码+整段拼接的组合会把整份文件当豁免上下文，引号反例被后文推翻（SKILL.md 误报复盘 11-06）
        const dec = norm(raw);
        if (dec !== s) addVariant(dec, false, false);
      }
    }
    // 外壳闸：原文里有「ROT13 编码的锚词」（vtaber、vafgehpgvbaf 这类串正常英文里是乱码，误触发≈0）才轮转——
    // 中英混排文本靠 plausible 会恒真（中文锚词不变），必须按英文锚词判
    if (R13_SHELL.test(s)) {
      const r13 = rot13(s);
      if (R13_ANCHOR.test(r13)) addVariant(r13, false, false);
    }
  }

  const lines0 = s.split("\n");
  // 每行是否在代码围栏里（``` / ~~~ 成对切换）——懒算：只有 spoof 强规则命中时才需要（性能项 11-06）
  let fenceIn = null;
  const getFenceIn = () => {
    if (fenceIn) return fenceIn;
    fenceIn = [];
    let inF = false;
    for (const ln of lines0) {
      fenceIn.push(inF);
      const t = ln.trimStart();
      if (t.startsWith("```") || t.startsWith("~~~")) inF = !inF;
    }
    return fenceIn;
  };
  const scanOne = (t, joined, mapped, only, fromLines = lines0, tHasCjk = null, linesIn = null) => {
    const lines = joined ? [t] : (linesIn ?? t.split("\n"));
    // 懒算：只有 relabel/illicit 两条才看拼接串，多数 pass 不付这份拷贝（性能项 11-06）
    let joinedAll = null;
    const getJoinedAll = () => joinedAll ?? (joinedAll = joined ? t : t.replace(/\n/g, " "));
    const hasCjk = tHasCjk ?? /[一-鿿]/.test(t);   // 纯汉字规则门：命中早退，纯 ASCII 扫到底（性能项 11-06）
    const lineOf = (idx) => (joined ? 0 : Math.min(idx + 1, lines0.length));
    const excerptOf = (i, m) => {
      const ln = lineOf(i);
      if (ln > 0 && lines0[ln - 1] != null) return lines0[ln - 1].trim().slice(0, 120);
      return (m[0] || "").slice(0, 120);
    };
    if (joined && mapped) {
      // 原样拼接（s 去换行）：命中映射回原行，豁免用该行的局部上下文判——整段拼起来拿全文件当上下文，
      // 引号反例会被后文的 REVOKE 词推翻（SKILL.md 误报复盘 11-06，同 import-memory 回归）
      const fromStart = [0];
      for (let i = 0; i < fromLines.length - 1; i++) fromStart.push(fromStart[i] + fromLines[i].length);
      const jlineM = (j) => {
        let lo = 0, hi = fromStart.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fromStart[mid] <= j) lo = mid; else hi = mid - 1; }
        return lo;
      };
      for (let ri = 0; ri < RULES.length; ri++) {
        if (CJK_ONLY.has(ri) && !hasCjk) continue;
        const [cat, isStrong, re] = RULES[ri];
        if (seenCat.has(cat + isStrong)) continue;
        if (cat === "spoof" && !isStrong) continue;   // role: system 靠 (?:^|\n) 锚定，拼接文本里锚没了，扫了也是白扫
        const g = RULES_G[ri];
        g.lastIndex = 0;
        for (let m; (m = g.exec(t)); ) {
          const li = jlineM(m.index);
          const line = fromLines[li];
          const rel = { index: m.index - fromStart[li], 0: m[0] };
          // spoof 强规则：反引号/代码围栏里被谈论的标签名降为弱特征，裸标签仍强（简报③）
          if (cat === "spoof" && isStrong && (inBacktick(line, rel.index) || getFenceIn()[li] || midTag(line, rel.index, m[0], s))) { if (!m[0].length) g.lastIndex++; continue; }
          // 命中跨了原换行（拆句攻击）就不走豁免；落在同一行内才按原行判
          const sameLine = jlineM(m.index + Math.max(m[0].length - 1, 0)) === li && rel.index + m[0].length <= line.length;
          if (sameLine && EXEMPT.has(cat) && exempt(line, rel)) { if (!m[0].length) g.lastIndex++; continue; }
          // 摘录给用户看原文行（归一文本的映射行可能与原文差在分隔符上）
          addHit(cat, isStrong, li + 1, (lines0[Math.min(li, lines0.length - 1)] ?? line).trim().slice(0, 120));
          break;
        }
      }
      return;
    }
    // 逐行语义的整段扫描：每条规则 g 循环一趟扫完，命中按位置回映射行——和逐行 exec 等价，
    // 但省掉每行一次的调用开销（性能项 11-06）。跨行命中（\s 吞掉换行那种）逐行语义看不到，跳过。
    // 文本还带着换行符：行起点要算上换行本身占的位置（+1）。
    const tStartT = [0];
    for (let i = 0; i < lines.length - 1; i++) tStartT.push(tStartT[i] + lines[i].length + 1);
    const jlineT = (j) => {
      let lo = 0, hi = tStartT.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tStartT[mid] <= j) lo = mid; else hi = mid - 1; }
      return lo;
    };
    for (let ri = 0; ri < RULES.length; ri++) {
      if (only && !only.has(ri)) continue;
      if (CJK_ONLY.has(ri) && !hasCjk) continue;
      const [cat, isStrong, , opt] = RULES[ri];
      if (seenCat.has(cat + isStrong)) continue;
      const re = only ? RULES_EDGE[ri] : RULES[ri][2];
      const g = only ? RULES_EDGE_G[ri] : RULES_G[ri];
      if (opt && opt.joined) {
        // 跨行写的（一条拆成几行）：整段并成一行看，命中再回头找起始行
        const m = re.exec(getJoinedAll());
        if (!m) continue;
        if (joined) {
          addHit(cat, isStrong, 0, (m[0] || "").slice(0, 120));
        } else {
          // 按 m.index 回映射行号（拼接串每行占 长度+1 个空格位）
          let off = 0, ln = 1;
          for (let k = 0; k < lines.length; k++) {
            if (off + lines[k].length + 1 > m.index) { ln = k + 1; break; }
            off += lines[k].length + 1;
          }
          addHit(cat, isStrong, ln, lines0[Math.min(ln - 1, lines0.length - 1)].trim().slice(0, 120));
        }
        continue;
      }
      g.lastIndex = 0;
      if (cat === "spoof" && isStrong) {
        // 反引号/代码围栏里提到标签名是被谈论的对象：降弱继续找，裸标签（行首成对）仍强（简报③）
        for (let m; (m = g.exec(t)); ) {
          if (!m[0].length) { g.lastIndex++; continue; }
          const j0 = m.index + m[0].search(/[^\s]/);   // (?:^|\n) 前缀把换行算进命中串：内容从第一个非空白算起
          if (m[0].replace(/^\s+/, "").includes("\n")) continue;
          const li = jlineT(j0);
          const rel = { index: j0 - tStartT[li], 0: m[0].slice(j0 - m.index) };
          if (inBacktick(lines[li], rel.index) || getFenceIn()[li] || midTag(lines[li], rel.index, rel[0], s)) { addHit(cat, false, lineOf(li), excerptOf(li, m)); continue; }
          addHit(cat, true, lineOf(li), excerptOf(li, m));
          break;
        }
        continue;
      }
      for (let m; (m = g.exec(t)); ) {
        if (!m[0].length) { g.lastIndex++; continue; }
        const j0 = m.index + m[0].search(/[^\s]/);
        if (m[0].replace(/^\s+/, "").includes("\n")) continue;
        const li = jlineT(j0);
        const rel = { index: j0 - tStartT[li], 0: m[0].slice(j0 - m.index) };
        if (EXEMPT.has(cat) && exempt(lines[li], rel)) continue;
        addHit(cat, isStrong, lineOf(li), excerptOf(li, m));
        break;
      }
      // 跨行的（类目清单拆成几行）：整段再看一次
      if (!seenCat.has(cat + isStrong) && !isStrong && cat === "illicit" && re.test(getJoinedAll())) {
        addHit(cat, false, 0, "");
      }
    }
  };
  // 同形字变体：含同形字才映射，映射后和主文本不同才扫（BREACH_NO_CONF 可关，排查用）
  if (!process.env.BREACH_NO_CONF && CONF_T.test(s)) {
    const cm = confusableMap(base);
    if (cm !== base) addVariant(cm, false, false);
  }
  const joinedV = variants.find((v) => v.joined);
  const sHasCjk = /[一-鿿]/.test(s);   // 一次算好：拼接/补扫/倒序/解码守卫都问这个（性能项 11-06）
  if (joinedV && base === s) {
    // 中文（无规则相关归一）文本：主扫描直接扫拼接文本，拆句和行内一体覆盖；
    // 对行边界敏感的规则另做逐行补扫，其余规则拼接扫描已含逐行语义（性能项 11-06）
    scanOne(joinedV.t, true, true, null, lines0, sHasCjk);
    if (!process.env.BREACH_NO_EDGE) scanOne(s, false, false, EDGE_IDX, null, sHasCjk, lines0);
    for (const v of variants) if (!v.joined) scanOne(v.t, false, false);
  } else if (joinedV) {
    // 有规则相关归一的：拼接扫描扫归一后的文本（拆句与全角/零宽/字间分隔形变一体兜住，映射回归一后的行），
    // 行边界敏感规则在归一文本上逐行补扫（性能项 11-06）
    const baseLines = base.split("\n");
    scanOne(base.replace(/\n/g, ""), true, true, null, baseLines, sHasCjk);
    if (!process.env.BREACH_NO_EDGE) scanOne(base, false, false, EDGE_IDX, null, sHasCjk, baseLines);
    for (const v of variants) if (!v.joined) scanOne(v.t, false, false);
  } else {
    scanOne(base, false, false, null, null, sHasCjk, base === s ? lines0 : null);
    for (const v of variants) scanOne(v.t, v.joined, v.mapped);
  }
  // 倒序词表全是汉字：无 CJK 的文本不可能有倒序壳（性能项 11-06）
  const rv = sHasCjk ? findRev(s) : null;
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
