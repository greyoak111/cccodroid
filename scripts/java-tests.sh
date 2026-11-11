#!/bin/sh
# Java 侧的纯逻辑回归（不依赖安卓运行时）：Ed25519 验签向量、特权命令确认规则、硬件密钥认证验链。
# 编译产物放私有缓存目录，不进仓库。用法：sh scripts/java-tests.sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${TMPDIR:-$HOME/.cache}/cccodroid-java-tests
rm -rf "$OUT"; mkdir -p "$OUT"
javac -nowarn -d "$OUT" "$ROOT/android/tests/stub/android/util/Base64.java" "$ROOT/android/java/cc/codroid/Ed25519.java" "$ROOT/android/tests/cc/codroid/Ed25519Vectors.java"
java -cp "$OUT" cc.codroid.Ed25519Vectors
javac -nowarn -d "$OUT" "$ROOT/android/java/cc/codroid/PrivRules.java" "$ROOT/android/tests/cc/codroid/PrivRulesTest.java"
java -cp "$OUT" cc.codroid.PrivRulesTest
javac -nowarn -d "$OUT" "$ROOT/android/java/cc/codroid/KeyAttest.java" "$ROOT/android/tests/cc/codroid/KeyAttestTest.java"
java -cp "$OUT" cc.codroid.KeyAttestTest
# 更新说明挑版本：WhatsNew 引了安卓类，编译要 android.jar（平板 ~/.bldtools，或 ANDROID_JAR）；pick 本身不碰安卓接口
AJAR=${ANDROID_JAR:-$HOME/.bldtools/android.jar}
if [ -f "$AJAR" ]; then
  javac -nowarn -d "$OUT" -cp "$AJAR:$(ls "$ROOT"/third_party/shizuku/*.jar | tr '\n' ':')" $(find "$ROOT/android/java" -name '*.java') "$ROOT/android/tests/cc/codroid/WhatsNewPickTest.java"
  java -cp "$OUT:$AJAR" cc.codroid.WhatsNewPickTest
  # 第二份稳定性报告 l 组（BUG-A01/A02/A03/A04/A05 的纯逻辑；只调基本类型判断，不碰安卓运行时）
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/cc/codroid/Stab2LHostTest.java"
  java -cp "$OUT:$AJAR" cc.codroid.Stab2LHostTest
else echo "跳过 WhatsNewPickTest（没有 android.jar）"; fi
