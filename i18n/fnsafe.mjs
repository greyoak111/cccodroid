// 译文里以 @ 开头的行是一段 JS（复数之类，见 mkdict.mjs），会原样写进 lang-*.js、在界面里执行。
// 外部 PR 往译文里塞一行代码就能在界面里跑（拿得到网关令牌），所以只放行现有这几种形状：
//   (v) => `…${v.n}…`、三元 / 比较 / 取余、字符串、String(v.n)、俄语那种 const f = (a, b, c) => …; return …
// 只许读 v 的一层属性（v.n、v.path…），不许方括号、反斜杠、别的全局名。mkdict 生成时和 pr-guard 审 PR 时都用它。
// 不变式：v 永远是纯数据（i18n.js 里 v(vars || {}) 传的插值对象）。形状里允许 v.x(…)，靠的就是这一条——
// 哪天往插值里塞函数或带方法的对象，这里就得一起收紧。
const IDS = new Set(["v", "String", "const", "return", "f", "a", "b", "c"]);
const BAD_PROP = new Set(["constructor", "prototype", "__proto__", "valueOf", "toString", "call", "apply", "bind", "caller", "arguments"]);

/** 这段（不含开头的 @）是不是放行的形状；不是就返回原因 */
export function i18nFnProblem(src) {
  let s = String(src);
  if (!s.startsWith("(v) => ")) return "要以 (v) => 开头";
  if (/[\\\[\]$]/.test(s.replace(/\$\{/g, ""))) return "不许反斜杠、方括号、$";
  // 1) 双引号字符串换成空串（里面不许有引号、反斜杠、换行）
  s = s.replace(/"[^"\\\n]*"/g, '""');
  // 2) 模板字符串：文字丢掉，只留 ${…} 里的表达式（里面不许再套模板）
  let bad = "";
  s = s.replace(/`([^`]*)`/g, (_, body) => {
    const ex = [];
    const rest = body.replace(/\$\{([^{}`]*)\}/g, (m, e) => { ex.push(e); return ""; });
    if (/[{}]/.test(rest)) bad = "模板里有没配对的花括号";
    return "(" + (ex.length ? ex.join("+") : '""') + ")";
  });
  if (bad) return bad;
  if (/[`"'$]/.test(s.replace(/""/g, ""))) return "引号没配对";
  // 3) 剩下的只能是这些字符（空白只许空格；注释也不许，// 能吃掉生成行尾的逗号）
  if (!/^[\w .()=>?:!<+\-*/%&|,{};"]*$/.test(s)) return "有不允许的字符";
  if (/\/[/*]/.test(s)) return "不许注释";
  // 4) 点号只能出现在 v.<属性> 里，属性名是普通小写单词
  for (const m of s.matchAll(/\./g)) {
    const before = s.slice(0, m.index), after = s.slice(m.index + 1);
    const prop = (/^([a-z][a-zA-Z]{0,15})\b/.exec(after) || [])[1];
    if (!/(^|[^\w$])v\s*$/.test(before) || !prop || BAD_PROP.has(prop)) return "只许读 v 的一层属性";
  }
  // 5) 其余的名字只能是这几个
  const noProps = s.replace(/\bv\s*\.\s*[a-z][a-zA-Z]*/g, "v");
  for (const m of noProps.matchAll(/[A-Za-z_][\w]*/g)) if (!IDS.has(m[0])) return "不认识的名字 " + m[0];
  return "";
}
