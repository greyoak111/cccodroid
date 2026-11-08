// devkit.lock.json 的验签：和 components.json / modules.json / notices 同一把 ed25519 公钥。
// 单独一个文件是为了能直接测（pkg.mjs 一 import 就按命令行参数干活，测不了里面的函数）。
// 打 APK 时 build.sh 把 android/assets/bin/* 一起拷进 app/bin，pkg.mjs 从旁边导入。
import crypto from "node:crypto";

// 服务端公钥（SPKI PEM）；私钥只在发布机与组件仓库的 CI 密钥里。
// 与 APK 里 Ed25519.INDEX_PUBKEY_B64（4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=）是同一把，测试里会核对
export const PUBKEY_B64 = "4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=";
const PUBKEY = crypto.createPublicKey("-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA4u1V3UuRVZgXwqXXQaQIBaefPf2PCGqKqvsna9Pgzzs=\n-----END PUBLIC KEY-----\n");

/** 下载地址里的 release tag（与 APK 的 Updater.tagOf 同一个正则） */
export const tagOf = (base) => { const m = /\/download\/([^/]+)\/?$/.exec(String(base || "")); return m ? m[1] : ""; };

/** 对原始字节验签（sig 是 base64、解码后须 64 字节），并核清单里的 release 就是下载地址里的 tag：
 *  旧版清单连签名一起搬到新 tag 下冒充新版过不去。通过返回解析后的 lock，否则 null。
 *  pub 参数只给测试换钥匙用，正常调用不要传。 */
export function verifyLock(body, sigB64, base, pub = PUBKEY) {
  try {
    const sig = Buffer.from(String(sigB64 || "").trim(), "base64");
    if (sig.length !== 64 || !crypto.verify(null, Buffer.from(body), pub, sig)) return null;
    const l = JSON.parse(Buffer.from(body).toString("utf8"));
    if (!l || typeof l !== "object" || Array.isArray(l)) return null;
    if (typeof l.release !== "string" || !l.release || l.release !== tagOf(base)) return null;
    return l;
  } catch { return null; }
}
