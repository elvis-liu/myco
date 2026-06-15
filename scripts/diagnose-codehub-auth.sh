#!/bin/bash
# CodeHub clone 认证诊断脚本
# 用于在部署环境中检查 credential helper 是否正常工作

set -e

echo "=== CodeHub Clone 认证诊断 ==="
echo ""

# 1. 检查 git credential helper 是否注册
echo "1. 检查 git credential helper 注册状态:"
HELPER=$(git config --global --get credential.helper 2>/dev/null || echo "未注册")
echo "   credential.helper = $HELPER"
if [[ "$HELPER" == *"git-credential-myco"* ]]; then
  echo "   ✓ 已注册 myco credential helper"
else
  echo "   ✗ 未注册 myco credential helper"
  echo "   → 解决: 确保 docker-entrypoint.sh 正确执行"
fi
echo ""

# 2. 检查 helper 脚本是否存在且可执行
echo "2. 检查 helper 脚本:"
if [ -f "/app/scripts/git-credential-myco.sh" ]; then
  echo "   ✓ 脚本存在: /app/scripts/git-credential-myco.sh"
  if [ -x "/app/scripts/git-credential-myco.sh" ]; then
    echo "   ✓ 脚本可执行"
  else
    echo "   ✗ 脚本不可执行"
    echo "   → 解决: chmod +x /app/scripts/git-credential-myco.sh"
  fi
else
  echo "   ✗ 脚本不存在"
fi
echo ""

# 3. 检查 STATE_DIR 和文件路径
echo "3. 检查 state 目录和文件:"
STATE_DIR="${MYCO_STATE_DIR:-/data}"
echo "   STATE_DIR = $STATE_DIR"
TOKENS_FILE="$STATE_DIR/git-tokens.json"
USERNAMES_FILE="$STATE_DIR/git-usernames.json"

if [ -f "$TOKENS_FILE" ]; then
  echo "   ✓ git-tokens.json 存在: $TOKENS_FILE"
  TOKENS_PERMS=$(stat -c "%a" "$TOKENS_FILE" 2>/dev/null || stat -f "%OLp" "$TOKENS_FILE" 2>/dev/null || echo "unknown")
  echo "   文件权限: $TOKENS_PERMS"
else
  echo "   ✗ git-tokens.json 不存在"
fi

if [ -f "$USERNAMES_FILE" ]; then
  echo "   ✓ git-usernames.json 存在: $USERNAMES_FILE"
  USERNAMES_PERMS=$(stat -c "%a" "$USERNAMES_FILE" 2>/dev/null || stat -f "%OLp" "$USERNAMES_FILE" 2>/dev/null || echo "unknown")
  echo "   文件权限: $USERNAMES_PERMS"
else
  echo "   ✗ git-usernames.json 不存在"
  echo "   → 解决: 登录 CodeHub 后会自动创建"
fi
echo ""

# 4. 检查当前 cwd 是否在 session 工作目录下
echo "4. 检查当前工作目录:"
CWD="$(pwd)"
echo "   cwd = $CWD"
if [[ "$CWD" == *"/wks/"*"/"* ]]; then
  MYCO_USER=$(echo "$CWD" | sed -n 's|.*/wks/\([^/]*\)/.*|\1|p')
  echo "   ✓ 在 session 工作目录下"
  echo "   myco-user = $MYCO_USER"
else
  echo "   ✗ 不在 session 工作目录下 (/wks/<user>/<session-id>/...)"
  echo "   → credential helper 无法识别 myco-user，会静默跳过"
fi
echo ""

# 5. 如果在 session cwd 下，检查 tokens 和 usernames 内容
if [[ "$CWD" == *"/wks/"*"/"* ]]; then
  MYCO_USER=$(echo "$CWD" | sed -n 's|.*/wks/\([^/]*\)/.*|\1|p')

  echo "5. 检查用户 '$MYCO_USER' 的 CodeHub token 和 username:"

  if [ -f "$TOKENS_FILE" ]; then
    # 检查是否有 CodeHub token (user-level 或 per-repo)
    CODEHUB_TOKEN=$(cat "$TOKENS_FILE" | node -e "
      const data = JSON.parse(require('fs').readFileSync('$TOKENS_FILE', 'utf8'));
      const entry = data['$MYCO_USER'];
      if (!entry) { console.log('no-user'); process.exit(0); }
      if (entry['codehub']) { console.log('user-level:' + entry['codehub'].slice(-4)); process.exit(0); }
      for (const key of Object.keys(entry)) {
        if (key.startsWith('codehub/')) { console.log('per-repo:' + key + ':' + entry[key].slice(-4)); process.exit(0); }
      }
      console.log('no-token');
    ")

    if [[ "$CODEHUB_TOKEN" == "user-level:"* ]]; then
      echo "   ✓ 有 user-level CodeHub token (last4: ${CODEHUB_TOKEN#user-level:})"
    elif [[ "$CODEHUB_TOKEN" == "per-repo:"* ]]; then
      echo "   ✓ 有 per-repo CodeHub token: ${CODEHUB_TOKEN#per-repo:}"
    elif [[ "$CODEHUB_TOKEN" == "no-user" ]]; then
      echo "   ✗ git-tokens.json 中无 '$MYCO_USER' 用户"
    elif [[ "$CODEHUB_TOKEN" == "no-token" ]]; then
      echo "   ✗ '$MYCO_USER' 无 CodeHub token"
      echo "   → 解决: 使用 /setpat 设置 CodeHub PAT，或通过 PAT 登录"
    fi
  fi

  if [ -f "$USERNAMES_FILE" ]; then
    CODEHUB_USERNAME=$(cat "$USERNAMES_FILE" | node -e "
      const data = JSON.parse(require('fs').readFileSync('$USERNAMES_FILE', 'utf8'));
      const entry = data['$MYCO_USER'];
      if (!entry) { console.log('no-user'); process.exit(0); }
      if (entry['codehub']) { console.log(entry['codehub']); process.exit(0); }
      console.log('no-username');
    ")

    if [[ "$CODEHUB_USERNAME" == "no-user" ]]; then
      echo "   ✗ git-usernames.json 中无 '$MYCO_USER' 用户"
    elif [[ "$CODEHUB_USERNAME" == "no-username" ]]; then
      echo "   ✗ '$MYCO_USER' 无 CodeHub username"
      echo "   → 解决: 需要重新登录 CodeHub 以存储 username"
    else
      echo "   ✓ CodeHub username: $CODEHUB_USERNAME"
    fi
  fi
  echo ""
fi

# 6. 检查 CodeHub SSL 配置
echo "6. 检查 CodeHub SSL 配置:"
SSL_VERIFY=$(git config --global --get http."https://codehub-y.huawei.com/".sslVerify 2>/dev/null || echo "未配置")
echo "   http.\"https://codehub-y.huawei.com/\".sslVerify = $SSL_VERIFY"
if [[ "$SSL_VERIFY" == "false" ]]; then
  echo "   ✓ CodeHub SSL 验证已禁用（支持自签名证书）"
else
  echo "   ✗ CodeHub SSL 验证未禁用"
  echo "   → 解决: git config --global http.\"https://codehub-y.huawei.com/\".sslVerify false"
fi
echo ""

# 7. 测试 credential helper（模拟 git clone）
echo "7. 模拟 credential helper 测试:"
if [[ "$CWD" == *"/wks/"*"/"* ]]; then
  MYCO_USER=$(echo "$CWD" | sed -n 's|.*/wks/\([^/]*\)/.*|\1|p')

  # 模拟 git stdin
  STDIN_TEST="protocol=https
host=codehub-y.huawei.com
path=test-owner/test-repo.git

"

  # 运行 helper（带 debug）
  echo "   运行 credential helper (MYCO_CRED_DEBUG=1):"
  echo "$STDIN_TEST" | MYCO_CRED_DEBUG=1 /app/scripts/git-credential-myco.sh get 2>&1 | head -15
else
  echo "   (跳过 - 不在 session cwd 下)"
fi
echo ""

echo "=== 诊断完成 ==="
echo ""
echo "如果所有检查都通过但 clone 仍失败，请检查:"
echo "  1. CodeHub PAT 是否有效且有权限访问目标仓库"
echo "  2. CodeHub 服务是否可达"
echo "  3. 仓库 URL 格式是否正确 (https://codehub-y.huawei.com/owner/repo.git)"