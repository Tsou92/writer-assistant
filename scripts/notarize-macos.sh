#!/usr/bin/env bash
# macOS 代码签名 + 公证(notarization)流程辅助脚本。
# 运行前先 export 以下环境变量:
#   APPLE_ID                        开发者 Apple ID
#   APPLE_APP_SPECIFIC_PASSWORD     app 专用密码(App Store Connect 生成)
#   APPLE_TEAM_ID                   Team ID(10 位)
#   APPLE_SIGNING_IDENTITY          "Developer ID Application: XXX (TEAM)"
#
# 用法: scripts/notarize-macos.sh path/to/app_or_dmg
set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" || ! -e "$TARGET" ]]; then
  echo "用法: $0 <path-to-.app-or-.dmg>" >&2
  exit 1
fi

for var in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID APPLE_SIGNING_IDENTITY; do
  if [[ -z "${!var:-}" ]]; then
    echo "缺少环境变量: $var" >&2
    exit 1
  fi
done

ENTITLEMENTS="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/entitlements.plist"

if [[ "$TARGET" == *.app ]]; then
  echo "→ 对 .app 进行 deep 签名..."
  codesign --force --deep --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$APPLE_SIGNING_IDENTITY" \
    "$TARGET"
  ZIP="${TARGET%.app}.zip"
  rm -f "$ZIP"
  /usr/bin/ditto -c -k --keepParent "$TARGET" "$ZIP"
  SUBMIT="$ZIP"
else
  SUBMIT="$TARGET"
fi

echo "→ 提交公证:$SUBMIT"
xcrun notarytool submit "$SUBMIT" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

echo "→ stapling ticket..."
if [[ "$TARGET" == *.app ]]; then
  xcrun stapler staple "$TARGET"
else
  xcrun stapler staple "$TARGET"
fi

echo "→ 验证..."
spctl --assess --type execute --verbose=4 "$TARGET" || true
echo "完成。"
