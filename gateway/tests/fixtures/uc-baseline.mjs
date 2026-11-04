// 所有测试文件共用一个临时 home（scripts/test.mjs）：前面的测试往 ~/.claude 写过 skill、命令之类，
// 这里真起一轮时会弹「用户级配置有改动」卡片（gw/userconf.mjs），没人点就一直等，整轮测试卡死。
// 要真起一轮的测试文件在导入 config 之后导入这个：先把当前样子认下
import { ucKeep, ucPending } from "../../gw/userconf.mjs";
ucKeep(ucPending()?.rels || []);
