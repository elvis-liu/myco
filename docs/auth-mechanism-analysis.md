# Mycelium 登录机制分析报告

## 一、支持的登录方式

### 1.1 GitHub OAuth 登录（主要方式）

**流程：**
```
用户 → 点击登录 → /auth/github/start → GitHub 授权页
→ 用户授权 → /auth/github/callback → 验证身份
→ 白名单检查 → mintSession → 返回 myco token
```

**关键文件：**
- `server/src/oauth.js` - OAuth 协议实现
- `server/src/auth.js` - Session 管理
- `server/src/index.js` - 路由处理（line 273-350）

**配置要求：**
- `MYCO_GH_CLIENT_ID` - GitHub OAuth App ID
- `MYCO_GH_CLIENT_SECRET` - GitHub OAuth App Secret
- `MYCO_PUBLIC_ORIGIN` - 公开域名（如 `https://myco.labxnow.ai`）
- `allowed-github-users.txt` - 白名单用户列表

**OAuth 请求的 Scope：**
- `read:user` - 读取用户基本信息
- `user:email` - 读取用户邮箱
- `repo` - 仓库访问权限（用于 `/feature` `/bug` 等功能）

### 1.2 PAT（Personal Access Token）登录

**支持的平台：**
- GitHub
- Gitee

**流程：**
```
用户粘贴 PAT → /auth/login → 智能识别平台
→ 调用平台 API 验证 token → 获取用户信息
→ 白名单检查 → mintSession → 存储 token
```

**智能识别逻辑（`server/src/index.js` line 385-404）：**
- Gitee PAT 通常为 32 字符十六进制或以 `gitee_` 开头
- 先尝试 Gitee API，失败则回退到 GitHub
- 非 Gitee 格式的 token 优先尝试 GitHub API

**关键代码位置：**
- `server/src/index.js` line 364-427 - `/auth/login` 路由
- `server/src/git-hosts.js` - 多平台适配层
- `server/src/git-tokens.js` - Token 存储管理

### 1.3 无认证模式（开发模式）

**触发条件：**
- 未设置 `MYCO_GH_CLIENT_ID`
- 不存在 `allowed-github-users.txt`
- 未设置 `MYCO_TEST_OAUTH_BYPASS`

**行为：**
- `isAuthRequired()` 返回 `false`
- `userFromRequest()` 返回 `'default'`
- 所有用户共享单一默认身份

## 二、后端凭据管理

### 2.1 Myco Session Token

**存储位置：**
- `$MYCO_STATE_DIR/auth-sessions.json`（默认 `/data/auth-sessions.json`）
- 文件权限：0600（仅 root 可读写）

**数据结构：**
```json
{
  "<token>": {
    "login": "username",
    "githubId": 12345,
    "name": "User Name",
    "avatarUrl": "https://...",
    "expiresAt": 1234567890
  }
}
```

**关键特性：**
- **TTL：** 30 天
- **滑动续期：** 如果剩余时间 < 7 天，每次使用自动续期到 30 天
- **跨重启持久化：** 服务器重启不会踢出已登录用户
- **内存缓存：** `_loadFromDisk()` 启动时加载，减少磁盘 I/O

**管理 API：**
- `mintSession(login, profile)` - 创建新 session
- `revokeSession(token)` - 删除 session（`/auth/logout`）
- `userFromToken(token)` - 验证 token
- `profileFromToken(token)` - 获取完整用户信息
- `listUsernames()` - 列出所有已登录用户（用于 @ 提示）

### 2.2 Git 平台访问令牌

**存储位置：**
- `$MYCO_STATE_DIR/git-tokens.json`（默认 `/data/git-tokens.json`）
- 文件权限：0600

**数据结构（支持两级存储）：**
```json
{
  "<myco-user>": {
    "github": "<user-level-token>",          // OAuth 发放的全局 token
    "gitee": "<user-level-token>",           // 用户级 fallback
    "github/owner/repo": "<per-repo-PAT>",   // 仓库级 token（优先）
    "gitee/owner/repo#alias": "<aliased-PAT>" // 别名 token（fr-82）
  }
}
```

**查找优先级：**
1. **仓库级 alias token**（如果指定了 alias）
2. **仓库级默认 token**（`provider/owner/repo`）
3. **用户级 fallback**（`provider`）

**管理 API（`server/src/git-tokens.js`）：**
- `getToken(user, provider, owner, repo, alias)` - 查找 token
- `setRepoToken(user, provider, owner, repo, token, alias)` - 设置仓库级 token
- `setUserToken(user, provider, token)` - 设置用户级 token（OAuth 回调）
- `listAliases(user, provider, owner, repo)` - 列出仓库的所有别名
- `listAllPats(user)` - 安全列出所有 PAT（仅返回后 4 位，不泄露完整 token）
- `removeRepoToken(...)` / `removeUserToken(...)` - 删除 token

**安全设计：**
- `listAllPats()` **永不返回完整 token**，只返回 `{present: true, last4}`
- 所有写入操作使用临时文件 + rename，防止部分写入
- 文件权限强制 0600

### 2.3 白名单管理

**存储位置：**
- `$MYCO_STATE_DIR/allowed-github-users.txt`
- 格式：每行一个 GitHub login，支持 `#` 注释

**管理方式：**
- `./scripts/deploy.sh --allow-github-user <login>` - 添加用户（无需重启容器）
- `isAllowed(login)` - 检查白名单（每次登录实时读取文件）

**特性：**
- **实时生效：** 添加白名单无需重启服务器
- **内存无缓存：** 每次验证都重新读取文件，确保管理员修改立即生效

### 2.4 Share Token（会话分享）

**实现方式：**
- **Share Token = Session ID**（无需额外存储）
- 链接格式：`/?s=<sessionId>`
- TTL：7 天
- 无独立存储，通过 `sessions.js` 验证 session 存在性

## 三、登录机制的扩展性分析

### 3.1 当前架构的优点

#### a) 已有一定的平台抽象
```javascript
// git-hosts.js
const KNOWN_PROVIDERS = new Set(['github', 'gitee']);

async function createIssue(opts) {
  const provider = opts.provider.toLowerCase();
  if (provider === 'github') return _createIssueGithub(opts);
  if (provider === 'gitee') return _createIssueGitee(opts);
  return { error: 'unknown provider' };
}
```

- Git 操作已抽象为 `provider → strategy` 分发模式
- Token 存储支持多平台（`git-tokens.js` 的两级 key 结构）

#### b) PAT 登录已支持多平台
- `/auth/login` 智能识别 token 类型
- `fetchUser()` 支持多平台验证

#### c) Session 管理与平台无关
- Myco session token 不绑定特定平台
- 用户可以同时持有 GitHub 和 Gitee 的 Git token

### 3.2 扩展新平台的痛点

#### a) OAuth 流程缺乏抽象

**问题：**
- `oauth.js` **硬编码 GitHub OAuth**
- `/auth/github/start` 和 `/auth/github/callback` 路径固定
- 没有 `provider` 参数化

**需要修改的地方（假设添加 GitLab OAuth）：**
```
1. oauth.js
   - 添加 detectProvider() 或拆分为 github-oauth.js / gitlab-oauth.js
   - 新增 GitLab 的 exchangeCode() / fetchUser()

2. index.js
   - 新增 /auth/gitlab/start / /auth/gitlab/callback 路由
   - 或重构为 /auth/<provider>/start 的通用路由

3. git-hosts.js
   - KNOWN_PROVIDERS.add('gitlab')
   - 新增 _createIssueGitlab / _fetchUserGitlab

4. git-tokens.js
   - KNOWN_PROVIDERS 已通过 git-hosts.js 同步
   - 无需修改（已有两级 key 结构）

5. web/public/app.js
   - 登录界面新增 GitLab 登录按钮
   - 或重构为统一的多平台登录入口
```

#### b) 缺少 Provider 注册机制

**当前状态：**
- `KNOWN_PROVIDERS` 是硬编码的 Set
- 新增平台需要手动修改多个文件的常量

**理想设计：**
```javascript
// providers.js - 统一注册中心
class ProviderRegistry {
  register({
    name: 'gitlab',
    oauth: { startUrl, exchangeCode, fetchUser, scopes },
    api: { createIssue, fetchUser, fetchIssues, closeIssue },
    detect: { hostRegex, urlPattern }
  });
}

// 使用
providers.get('gitlab').oauth.startUrl(state);
```

#### c) PAT 登录的智能识别不够通用

**当前问题：**
- Gitee 的识别逻辑（`gitee_` 前缀或 32 位十六进制）是硬编码
- GitLab、Bitbucket 等平台的 PAT 格式未知，需要新增识别规则

**改进方向：**
- 用户在登录界面**手动选择平台**（下拉菜单）
- 或提供 `/auth/login/<provider>` 的明确路由

#### d) 白名单绑定 GitHub login

**当前设计：**
- `allowed-github-users.txt` 存储 GitHub login
- Gitee 用户使用相同白名单（假设 login 相同）

**问题：**
- 不同平台的 login 可能不同（GitHub 的 `alice` vs GitLab 的 `alice_dev`）
- 白名单机制需要支持平台区分

**改进方案：**
```
# allowed-users.txt（新格式）
github:alice
gitee:alice_dev
gitlab:alice_lab
```

### 3.3 扩展性评分

| 维度 | 当前状态 | 扩展难度 | 说明 |
|------|---------|---------|------|
| Git 操作 | 已抽象 | ⭐⭐ 低 | 新增 `_createIssueGitlab` 等函数即可 |
| Token 存储 | 已抽象 | ⭐ 很低 | 两级 key 结构天然支持多平台 |
| OAuth 登录 | 硬编码 | ⭐⭐⭐⭐ 高 | 需重构路由 + OAuth 模块 |
| PAT 登录 | 半抽象 | ⭐⭐⭐ 中 | 智能识别 + 手动选择双路径 |
| 白名单 | 单平台 | ⭐⭐⭐ 中 | 需支持平台前缀格式 |
| 前端 UI | 单按钮 | ⭐⭐⭐ 中 | 需多平台登录入口 |

### 3.4 推荐的扩展路线

#### 短期（最小改动）
1. **保持 GitHub OAuth 为主**，新增平台仅支持 PAT 登录
2. 在 `/auth/login` 增加平台选择参数（用户手动指定）
3. 扩展 `git-hosts.js` 的 API 适配（工作量小）

#### 中期（完善架构）
1. 创建 `providers.js` 注册机制，统一管理平台适配器
2. OAuth 路由重构为 `/auth/<provider>/start`
3. 白名单支持平台前缀格式
4. 前端登录界面提供多平台选择

#### 长期（插件化）
1. 提供第三方 Provider 插件接口（npm package）
2. 用户通过配置文件启用/禁用平台
3. 支持自定义 Git 平台（企业内部 GitLab）

## 四、安全性分析

### 4.1 现有安全措施

#### a) Token 存储
- 文件权限强制 0600（仅 root 可读写）
- 使用临时文件 + rename（防止部分写入）
- `listAllPats()` 永不泄露完整 token

#### b) OAuth State Nonce
- 5 分钟 TTL（防止 CSRF）
- 内存存储，重启自动失效（迫使重试）

#### c) 白名单强制
- OAuth 登录和白名单检查分离（即使 OAuth 成功，非白名单用户仍被拒绝）
- 白名单实时读取（管理员修改立即生效）

#### d) HTTPS 强制
- 生产环境必须配置 `MYCO_PUBLIC_ORIGIN`（HTTPS）
- WebSocket 连接通过 WSS

### 4.2 潜在风险

#### a) Share Token 无加密
- Session ID 直接作为 share token
- 任何获得链接的人可访问 session
- 建议：增加访问密码或有效期验证

#### b) PAT 登录无 Scope 检查
- 用户可能粘贴权限不足的 token
- 建议：登录时验证 token 权限（调用 `/user` 检查 scopes）

#### c) Git Token 明文存储
- `git-tokens.json` 存储 plaintext token
- 建议：考虑加密存储（对称加密，密钥由环境变量提供）

## 五、总结与建议

### 5.1 现状总结

**优点：**
- GitHub OAuth 流程成熟稳定
- PAT 登录已支持 GitHub + Gitee 双平台
- Token 存储架构清晰（两级 key）
- Git 操作已有多平台抽象

**缺点：**
- OAuth 流程硬编码 GitHub
- 缺少 Provider 注册机制
- 白名单仅支持 GitHub login
- 前端 UI 未提供多平台入口

### 5.2 扩展建议

#### 最小可行方案（支持新平台 PAT 登录）
```
修改文件数：3
工作量：约 2-3 天
风险：低
影响：不破坏现有 GitHub OAuth 流程
```

#### 完整多平台 OAuth 方案
```
修改文件数：6-8
工作量：约 5-7 天
风险：中（需重构路由 + OAuth 模块）
影响：需充分测试回归
```

#### 插件化方案
```
修改文件数：10+
工作量：约 10-15 天
风险：高（架构大幅变更）
影响：需要版本迁移计划
```

### 5.3 下一步行动

1. **评估需求：** 确定是否需要 OAuth 登录支持新平台，还是 PAT 登录已足够
2. **原型验证：** 选择一个平台（如 GitLab）实现 PAT 登录原型，评估工作量
3. **架构评审：** 如果决定支持 OAuth，先设计 Provider 注册机制再动手
4. **安全加固：** 补充 token 权限验证 + share token 访问控制

---

**分析日期：** 2026-06-12
**分析基于：** commit `928c74a feat(fr-101): plan-item tags with quick add/delete`
**核心文件：**
- `server/src/auth.js` - Session 管理
- `server/src/oauth.js` - GitHub OAuth
- `server/src/git-tokens.js` - Token 存储
- `server/src/git-hosts.js` - 多平台适配
- `server/src/index.js` - 路由处理