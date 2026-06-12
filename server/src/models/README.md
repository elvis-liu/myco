# Model Provider Configuration

## 配置文件位置

默认位置：`$MYCO_STATE_DIR/models.json`
自定义位置：设置环境变量 `MYCO_MODELS_CONFIG_PATH`

## 环境变量引用语法

配置文件中使用 `${ENV_VAR}` 或 `${ENV_VAR:default}` 语法引用环境变量：

```json
{
  "apiKey": "${ANTHROPIC_API_KEY}",
  "baseUrl": "${CUSTOM_ENDPOINT:http://localhost:11434/v1}"
}
```

- `${VAR}` - 直接引用环境变量 `VAR`
- `${VAR:default}` - 如果 `VAR` 未设置，使用 `default` 值

## 配置优先级

优先级从高到低：

1. **运行时参数** - API 调用时传入的 `opts.provider` / `opts.model`
2. **会话级配置** - `rec.criticModel`（仅 critic 场景）
3. **配置文件** - `$MYCO_STATE_DIR/models.json`
4. **环境变量** - `MYCO_CRITIC_MODEL` 等
5. **默认值** - `defaults.js` 硬编码配置

## Provider 配置说明

| 字段 | 说明 |
|------|------|
| `apiKey` | API 密钥，支持 `${ENV_VAR}` 语法 |
| `baseUrl` | API endpoint URL |
| `defaultModel` | 默认使用的模型 |
| `sampling` | 模型参数（temperature, topP, maxOutputTokens 等） |

### Azure OpenAI 特殊字段

| 字段 | 说明 |
|------|------|
| `apiVersion` | Azure API 版本 |
| `deploymentName` | Azure deployment 名称 |

## Scenario 配置说明

| 场景 | 说明 | SDK/API |
|------|------|---------|
| `agent` | Agent 会话 | SDK 内部管理 auth |
| `critic` | Critic 评估 | API-based，支持动态切换 |
| `summarizer` | 摘要生成 | API-based |
| `extractor` | 内容提取 | SDK 内部管理 auth |
| `btw` | BTW 助手 | SDK 内部管理 auth |

## 示例配置

参考 `models.json.example` 文件。

## 安全建议

1. 使用 `${ENV_VAR}` 语法，避免在配置文件中硬编码 API Key
2. 配置文件权限设置为 `0600`（仅 owner 可读写）
3. API Key 验证失败时，系统会优雅降级到下一个可用 provider