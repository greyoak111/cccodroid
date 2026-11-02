// 语言注册表：界面支持哪些语言。加一种语言 = 这里加一行 + 新建 lang-<code>.js（格式照 lang-en.js）。
//   code   词典文件名后缀，也是存进设置里的值（lang-<code>.js）；zh 是源语言，没有词典文件
//   name   在语言下拉框里显示的名字 —— 用该语言自己的写法（Русский 而不是 Russian），永远不翻译
//   match  系统语言（navigator.languages，小写）以这些前缀开头时，「跟随系统」选它；
//          **越具体的写在越前面**，匹配时按最长前缀取胜（zh-tw 优先配 zh-Hant 而不是 zh）
//   dir    "rtl" 用于阿拉伯语 / 希伯来语等，默认 ltr
// 「跟随系统」找不到匹配时用英文。缺译的键先回退英文，再回退中文原文。
//
// 已接入：联合国另外五种官方语言（英/法/西/俄/阿）+ 日语、韩语、印尼语 + 繁体中文（简体中文是源语言）。
window.I18N_LANGS = [
  { code: "zh", name: "简体中文", match: ["zh-cn", "zh-sg", "zh-hans", "zh"] },
  { code: "zh-Hant", name: "繁體中文", match: ["zh-tw", "zh-hk", "zh-mo", "zh-hant"] },
  { code: "en", name: "English", match: ["en"] },
  { code: "fr", name: "Français", match: ["fr"] },
  { code: "es", name: "Español", match: ["es"] },
  { code: "ru", name: "Русский", match: ["ru"] },
  { code: "ar", name: "العربية", match: ["ar"], dir: "rtl" },
  { code: "ja", name: "日本語", match: ["ja"] },
  { code: "ko", name: "한국어", match: ["ko"] },
  { code: "id", name: "Bahasa Indonesia", match: ["id", "in"] },   // 老安卓把印尼语报成 in
  // 待补的语言照这个格式往下加，例如：
  // { code: "de", name: "Deutsch", match: ["de"] },
];
