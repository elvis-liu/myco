# Myco 项目配置方式分析

本文档详细分析 Myco 项目的各种配置方式，包括 API Key、模型 Base URL、白名单以及其他配置项的管理方式。

## 配置概览

Myco 采用**单状态目录架构**，所有持久化配置都存储在一个统一的状态目录（`MYCO_STATE_DIR`）中，通过 Docker bind-mount 实现容器重启后配置保留。

```mermaid
flowchart TB
  subgraph StateDir["状态目录 ($MYCO_STATE_DIR)"]
    env[".env<br/>环境变量配置"]
    allowlist["allowed-github-users.txt<br/>用户白名单"]
    authSessions["auth-sessions.json<br/>会话令牌"]
    gitTokens["git-tokens.json<br/>Git PAT 存储"]
    sessions["sessions.json<br/>会话记录"]
    caddy["caddy/<br/>Caddy 配置"]
  end

  subgraph Container["Docker 容器"]
    bindEnv["/data/.env"]
    bindAllowlist["/data/allowed-github-users.txt"]
    bindAuth["/data/auth-sessions.json"]
    bindGit["/data/git-tokens.json"]
    bindSessions["/data/sessions.json"]
  end

  StateDir --> Container

  subgraph Runtime["运行时读取"]
    oauth["OAuth 模块<br/>oauth.js"]
    auth["认证模块<br/>auth.js"]
    gitTokenMod["Git Token 模块<br/>git-tokens.js"]
    sessionMod["会话模块<br/>sessions.js"]
    agent["Agent 会话<br/>agent-session.js"]
  end

  bindEnv --> oauth
  bindEnv --> agent
  bindAllowlist --> auth
  bindAuth --> auth
  bindGit --> gitTokenMod
  bindSessions --> sessionMod
```

---

## 1. 状态目录与环境变量

### 1.1 状态目录位置

状态目录由环境变量 `MYCO_STATE_DIR` 控制：

```bash
# 默认值（容器内）
MYCO_STATE_DIR=/data

# 默认值（本地开发）
MYCO_STATE_DIR=~/.myco

# 生产部署（deploy.sh 默认）
MYCO_STATE_DIR=/home/kkrazy/myco-state
```

### 1.2 .env 文件配置

**位置**: `$MYCO_STATE_DIR/.env`

**格式**: 标准 `KEY=value` 格式，支持 `#` 注释

**加载时机**: 容器启动时由 `docker-entrypoint.sh` 加载

```bash
# docker-entrypoint.sh
if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi
```

**加载优先级**: Docker `-e` 参数 > host 环境 > `.env` 文件

**server/src/index.js 中的 .env 加载器**:

```javascript
// 启动时从 $MYCO_STATE_DIR/.env 加载环境变量
// Docker -e 和 host 环境变量优先级更高（不会被覆盖）
(function _loadStateDirEnvAtBoot() {
  const stateDir = process.env.MYCO_STATE_DIR || path.join(require('os').homedir(), '.myco');
  const envPath = path.join(stateDir, '.env');
  // ... 解析 KEY=value 行，跳过已设置的变量
})();
```

---

## 2. OAuth 配置

### 2.1 GitHub OAuth 配置

**配置项**（存储在 `.env`）:

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `MYCO_GH_CLIENT_ID` | GitHub OAuth App Client ID | `Iv1.xxxxx` |
| `MYCO_GH_CLIENT_SECRET` | GitHub OAuth App Client Secret | `xxxxx` |
| `MYCO_PUBLIC_ORIGIN` | 公开访问域名 | `https://myco.labxnow.ai` |

**设置方式**:

```bash
# 通过 deploy.sh 设置
./scripts/deploy.sh --set-oauth <client_id>:<client_secret>

# 或直接编辑 .env
MYCO_GH_CLIENT_ID=Iv1.xxxxx
MYCO_GH_CLIENT_SECRET=xxxxx
MYCO_PUBLIC_ORIGIN=https://myco.labxnow.ai
```

**OAuth 回调 URL**: `<MYCO_PUBLIC_ORIGIN>/auth/github/callback`

**请求 Scope**: `read:user user:email repo`

**server/src/oauth.js 核心逻辑**:

```javascript
function isConfigured() {
  return !!(process.env.MYCO_GH_CLIENT_ID &&
            process.env.MYCO_GH_CLIENT_SECRET &&
            process.env.MYCO_PUBLIC_ORIGIN);
}

function callbackUrl() {
  return `${publicOrigin()}/auth/github/callback`;
}
```

---

## 3. API Key 配置

### 3.1 Anthropic API Key

**配置项**:

| 环境变量 | 说明 | 使用位置 |
|---------|------|----------|
| `ANTHROPIC_API_KEY` | Anthropic API Key | Claude SDK、summarizer、extractor |

**设置方式**:

```bash
# 通过 deploy.sh 设置（会重启容器）
./scripts/deploy.sh --set-anthropic-key sk-ant-xxxxx

# 或编辑 .env
ANTHROPIC_API_KEY=sk-ant-xxxxx
```

**使用位置**:

1. **SDK Agent Session** (`agent-session.js`):
   - 通过 `env: { ...process.env }` 传递给 Claude Agent SDK
   - SDK 自动读取 `ANTHROPIC_API_KEY`

2. **Anthropic Helper** (`anthropic.js`):
   - 用于 summarizer 和 extractor
   - 直接调用 Anthropic Messages API

```javascript
// server/src/anthropic.js
function callAnthropic({ system, userMessage, model, maxTokens }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.resolve(null);
  // ...
}
```

**默认模型**: `claude-haiku-4-5-20251001`

**API Endpoint**: `https://api.anthropic.com/v1/messages`

### 3.2 Gemini API Key（用于 Critic）

**配置项**:

| 环境变量 | 说明 |
|---------|------|
| `GEMINI_API_KEY` | Google Gemini API Key |
| `API_KEY` | 别名（fallback） |

**设置方式**: 编辑 `.env`

```bash
GEMINI_API_KEY=xxxxx
```

**使用位置**: `server/src/gemini.js` - 用于代码评审 critic

```javascript
// server/src/gemini.js
async function runGeminiP(prompt, systemInstruction = '') {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    return '(Gemini API key missing; please set GEMINI_API_KEY or API_KEY)';
  }
  // ...
}
```

**模型**: `gemini-1.5-pro`

---

## 4. 白名单配置

### 4.1 用户访问白名单

**位置**: `$MYCO_STATE_DIR/allowed-github-users.txt`

**格式**: 每行一个用户，支持 provider 前缀

```text
# GitHub 用户
github:alice
github:bob

# Gitee 用户
gitee:developer1

# 简写格式（默认 github）
charlie    # 等价于 github:charlie

# 注释
# 这是注释行
```

**支持的 Provider**: `github`, `gitee`

**设置方式**:

```bash
# 通过 deploy.sh 添加（无需重启容器）
./scripts/deploy.sh --allow-github-user alice
./scripts/deploy.sh --allow-gitee-user developer1

# 或直接编辑文件
echo "github:alice" >> $STATE_DIR/allowed-github-users.txt
```

**server/src/auth.js 核心逻辑**:

```javascript
function loadAllowlist() {
  // 每次检查时重新读取文件（无需重启）
  const raw = fs.readFileSync(ALLOWLIST_FILE, 'utf8');
  // 解析 provider:login 格式
  for (const line of raw.split('\n')) {
    const parsed = parseAllowlistEntry(trimmed);
    if (parsed) out.add(`${parsed.provider}:${parsed.login}`);
  }
  return out;
}

function isAllowed(login, provider = 'github') {
  const allowlist = loadAllowlist();
  return allowlist.has(`${provider}:${login}`);
}
```

---

## 5. Git Token 配置

### 5.1 Git PAT 存储

**位置**: `$MYCO_STATE_DIR/git-tokens.json`

**权限**: `0600`（仅 owner 可读写）

**数据结构**:

```json
{
  "<myco-user>": {
    "github": "<user-level-token>",
    "gitee": "<user-level-token>",
    "github/owner/repo": "<per-repo-PAT>",
    "github/owner/repo#alias": "<aliased-PAT>"
  }
}
```

**Token 优先级**:

1. **Per-repo alias token**: `<provider>/<owner>/<repo>#<alias>`
2. **Per-repo default token**: `<provider>/<owner>/<repo>`
3. **User-level fallback**: `<provider>` (OAuth 授权时自动存储)

**设置方式**:

```bash
# 在会话中使用 /setpat 命令
/setpat ghp_xxxxx

# 或通过 API
curl -X PUT http://localhost:3000/git-token \
  -H "Authorization: Bearer <myco-token>" \
  -d '{"provider":"github","owner":"myorg","repo":"myrepo","token":"ghp_xxxxx"}'
```

**server/src/git-tokens.js 核心逻辑**:

```javascript
function getToken(user, provider, owner, repo, alias) {
  const entry = store[user];
  if (alias) {
    const aliasKey = `${provider}/${owner}/${repo}#${alias}`;
    return entry[aliasKey] || null;
  }
  if (owner && repo) {
    const repoKey = `${provider}/${owner}/${repo}`;
    if (entry[repoKey]) return entry[repoKey];
  }
  return entry[provider] || null;  // user-level fallback
}
```

---

## 6. 会话配置

### 6.1 会话记录存储

**位置**: `$MYCO_STATE_DIR/sessions.json`

**数据结构**:

```json
{
  "sessions": {
    "<session-id>": {
      "id": "abc123",
      "user": "alice",
      "cwd": "/wks/alice/myco-alice-abc123",
      "absCwd": "/wks/alice/myco-alice-abc123",
      "label": "myco project",
      "mode": "agent",
      "mainProject": "/wks/alice/myco-alice-abc123",
      "admins": [],
      "viewers": [],
      "allowList": ["Read", "Edit", "Bash(git)", ...],
      "denyList": [],
      "artifacts": {
        "plan": { "items": [], "updatedAt": null },
        "architecture": "...",
        "test": "..."
      },
      "chat": [...],
      "created": "2026-06-12T10:00:00Z"
    }
  }
}
```

### 6.2 权限白名单/黑名单

**配置位置**: 会话记录的 `allowList` / `denyList` 字段

**默认白名单** (`server/src/permissions.js`):

```javascript
const DEFAULT_ALLOW = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'TodoWrite',
  'NotebookEdit',
  'Bash(git)',
  'Bash(npm)',
  'Bash(yarn)',
  'Bash(node)',
  'Bash(pnpm)',
  'Bash(./test.sh)',
  'Bash(./deploy.sh)',
  'Bash(./test-browser.sh)',
  'Bash(ls)',
  'Bash(pwd)',
  'Bash(cat)',
  'Bash(echo)',
];
```

**匹配语法**:

| Pattern | 说明 |
|---------|------|
| `Read` | 所有 Read 调用 |
| `Edit` | 所有 Edit 调用 |
| `Bash(git)` | 以 `git` 开头的 Bash 命令 |
| `Bash(./test.sh)` | 以 `./test.sh` 开头的命令 |
| `Bash(*)` | 所有 Bash 命令 |

**设置方式**: 通过 `/allow` 和 `/deny` 命令

```bash
# 在会话聊天中
/allow Bash(docker)
/deny Bash(rm -rf)
```

---

## 7. 代理配置

### 7.1 企业代理配置

**配置项**（存储在 `.env`）:

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `MYCO_ENTERPRISE_PROXY` | 启用企业代理 | `0` (禁用) |
| `MYCO_ENTERPRISE_PROXY_URL` | 代理地址 | 无 |
| `MYCO_ENTERPRISE_NO_PROXY` | 不走代理的地址 | `127.0.0.1,localhost,local,.local` |
| `MYCO_ENTERPRISE_TLS_INSECURE` | 禁用 TLS 验证 | `0` |

**设置示例**:

```bash
# .env 文件
MYCO_ENTERPRISE_PROXY=1
MYCO_ENTERPRISE_PROXY_URL=http://user:pass@proxy.company.com:8080
MYCO_ENTERPRISE_TLS_INSECURE=1
```

**docker-entrypoint.sh 处理逻辑**:

```bash
if [ "${MYCO_ENTERPRISE_PROXY:-0}" = "1" ]; then
    export http_proxy="${MYCO_ENTERPRISE_PROXY_URL}"
    export https_proxy="${MYCO_ENTERPRISE_PROXY_URL}"
    export GLOBAL_AGENT_HTTP_PROXY="${http_proxy}"

    # Git 代理配置
    git config --global http.proxy "${http_proxy}"
    git config --global https.proxy "${https_proxy}"

    # SSH URL 重写为 HTTPS（走 HTTP 代理）
    git config --global url."https://github.com/".insteadOf "git@github.com:"
fi
```

### 7.2 标准 HTTP 代理

支持标准环境变量：

```bash
HTTP_PROXY=http://proxy:8080
HTTPS_PROXY=http://proxy:8080
NO_PROXY=127.0.0.1,localhost
```

**server/src/index.js 自动映射**:

```javascript
const stdProxy = process.env.HTTP_PROXY || process.env.http_proxy;
if (stdProxy) {
  process.env.GLOBAL_AGENT_HTTP_PROXY = stdProxy;
}
require('global-agent/bootstrap');
```

---

## 8. SDK 模型配置

### 8.1 Claude SDK 配置

**server/src/agent-session.js SDK Options**:

```javascript
const sdkOpts = {
  cwd: this.cwd,
  permissionMode: 'default',
  env: { ...process.env, ...(gitEnv || {}) },
  abortController: this._abortController,
  canUseTool: (toolName, input, ctx) => this._canUseTool(toolName, input, ctx),
  hooks: {
    PreToolUse: [{ hooks: [(input, toolUseID, ctx) => this._preToolUseHook(...)] }],
  },
  settings: {
    autoMemoryEnabled: true,
    autoMemoryDirectory: path.join(this.cwd, '.claude', 'memory'),
    plansDirectory: path.join(this.cwd, '.claude', 'plans'),
  },
  settingSources: ['project', 'local', 'user'],
  mcpServers: {
    myco: require('./myco-mcp').createMycoMcpServer(this.sessionId),
    'lean-ctx': {
      type: 'stdio',
      command: 'lean-ctx',
      args: ['mcp'],
      env: { CTX_PROJECT_ROOT: this.cwd, LEAN_CTX_AUTONOMY: 'false' },
    },
  },
};

const stream = query({ prompt: this._msgQueue, options: sdkOpts });
```

**关键配置项说明**:

| 配置项 | 说明 |
|--------|------|
| `cwd` | 会话工作目录 |
| `env` | 传递给 SDK 的环境变量（包含 `ANTHROPIC_API_KEY`） |
| `settings.autoMemoryDirectory` | 会话级内存存储位置 |
| `settingSources` | 配置来源优先级 |
| `mcpServers` | MCP 服务器配置 |

### 8.2 模型选择

**SDK 自动选择模型**，可通过以下方式影响：

1. **ANTHROPIC_API_KEY**: 控制使用 Anthropic API
2. **SDK resume**: 通过 `sdkSessionId` 继续会话时保持模型一致性

---

## 9. 其他配置

### 9.1 TLS 配置

**配置项**:

| 环境变量 | 说明 |
|---------|------|
| `MYCO_TLS_CERT_PATH` | TLS 证书路径 |
| `MYCO_TLS_KEY_PATH` | TLS 密钥路径 |
| `NODE_TLS_REJECT_UNAUTHORIZED` | 禁用 TLS 验证（`0`） |

### 9.2 Caddy 反向代理配置

**位置**: `$MYCO_STATE_DIR/Caddyfile`

**默认内容**:

```caddy
{
  servers {
    protocols h1 h2
  }
}

myco.labxnow.ai {
  encode gzip zstd
  reverse_proxy localhost:3000
}
```

### 9.3 工作空间配置

**配置项**:

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `MYCO_WORKSPACE` | 工作空间根目录 | `/wks` (容器内) |

**会话工作目录结构**:

```
/wks/<user>/<session-id>/
├── _myco_/           # 项目 artifacts
│   ├── plan.json
│   ├── architecture.md
│   ├── events.jsonl
│   └── critic.md
├── .claude/          # SDK 配置
│   ├── memory/
│   ├── plans/
│   ├── settings.json
│   └── settings.local.json
└── CLAUDE.md         # 项目指令
```

---

## 10. 配置管理命令

### 10.1 deploy.sh 配置命令

| 命令 | 说明 |
|------|------|
| `--set-oauth <id>:<secret>` | 设置 OAuth 配置 |
| `--set-anthropic-key <key>` | 设置 Anthropic API Key |
| `--allow-github-user <login>` | 添加 GitHub 用户到白名单 |
| `--allow-gitee-user <login>` | 添加 Gitee 用户到白名单 |

### 10.2 会话内配置命令

| 命令 | 说明 |
|------|------|
| `/setpat <token>` | 设置当前仓库的 Git PAT |
| `/listpat` | 列出已存储的 PAT |
| `/allow <pattern>` | 添加工具权限白名单 |
| `/deny <pattern>` | 添加工具权限黑名单 |

---

## 11. 配置安全建议

1. **敏感文件权限**: `auth-sessions.json`、`git-tokens.json`、`.env` 应保持 `0600` 权限
2. **白名单管理**: 仅添加信任的用户，定期审计
3. **API Key 保护**: 不要将 API Key 硬编码在代码中，使用 `.env` 文件
4. **代理 TLS**: 仅在必要时启用 `MYCO_ENTERPRISE_TLS_INSECURE`
5. **Git Credential**: 使用 `/setpat` 而不是在代码中存储 Git PAT

---

## 12. 配置问题排查

| 问题 | 排查步骤 |
|------|----------|
| OAuth 登录失败 | 检查 `.env` 中三个 OAuth 变量是否完整，`MYCO_PUBLIC_ORIGIN` 是否匹配访问域名 |
| "Not invited yet" | 检查 `allowed-github-users.txt` 是否包含该用户 |
| API Key 无效 | 检查 `.env` 中 `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` 是否设置 |
| Git push 失败 | 使用 `/setpat` 设置仓库 PAT |
| 代理不生效 | 检查 `MYCO_ENTERPRISE_PROXY=1` 是否设置 |

---

## 附录：配置文件速查表

| 配置类型 | 文件位置 | 格式 |
|---------|----------|------|
| 环境变量 | `$STATE_DIR/.env` | KEY=value |
| 用户白名单 | `$STATE_DIR/allowed-github-users.txt` | provider:login |
| 会话令牌 | `$STATE_DIR/auth-sessions.json` | JSON |
| Git Token | `$STATE_DIR/git-tokens.json` | JSON |
| 会话记录 | `$STATE_DIR/sessions.json` | JSON |
| Caddy 配置 | `$STATE_DIR/Caddyfile` | Caddy DSL |
| 项目指令 | `<cwd>/CLAUDE.md` | Markdown |
| SDK 设置 | `<cwd>/.claude/settings.json` | JSON |