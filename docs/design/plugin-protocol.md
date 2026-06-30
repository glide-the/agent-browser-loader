# agent-browser.plugin.v1 协议规范

## 概述

`agent-browser.plugin.v1` 是 agent-browser 用于与本地插件进程通信的 JSON 协议。插件作为子进程运行，通过 **stdin/stdout** 接收请求和返回响应。

---

## 通信模式

- **传输层**：stdin/stdout，UTF-8 编码
- **格式**：每个请求/响应为一行 JSON（NDJSON）
- **进程模型**：每次请求启动一个新插件进程（无长连接）
- **调试输出**：只能写 stderr，stdout 必须是纯 JSON

---

## 请求格式

### 官方格式（推荐）

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "<request-type>",
  "capability": "<capability>",
  "request": { ... }
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 是 | 固定值 `"agent-browser.plugin.v1"` |
| `type` | string | 是 | 请求类型，如 `plugin.manifest`、`launch.mutate`、`browser.launch` |
| `capability` | string | 否 | 插件能力标识（与 type 对应） |
| `request` | object | 否 | 请求负载，内容因 type 而异 |

### 遗留格式（兼容）

```json
{
  "type": "launch.mutate",
  "id": "req-1",
  "launch": { "args": [] }
}
```

- 无 `protocol` 字段时识别为遗留格式
- 响应中会携带原始 `id` 字段
- `launch.args` 直接位于信封顶层

---

## 响应格式

### 成功响应

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "<response-field>": { ... }
}
```

### 错误响应

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": false,
  "error": {
    "code": "<error-code>",
    "message": "<human-readable message>"
  }
}
```

### 遗留格式响应（当请求携带 `id`）

```json
{
  "id": "<original-id>",
  "launch": { ... }
}
```

---

## 内置请求类型

### `plugin.manifest`

查询插件支持的能力列表。

请求：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "plugin.manifest",
  "request": {}
}
```

响应：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "manifest": {
    "name": "plugin-name",
    "capabilities": ["launch.mutate"],
    "description": "..."
  }
}
```

---

### `launch.mutate`（Capability: `launch.mutate`）

在本地 Chrome 启动前注入参数、扩展和页面脚本。

请求：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "launch.mutate",
  "capability": "launch.mutate",
  "request": {
    "args": ["--existing-arg"],
    "extensions": [],
    "initScripts": [],
    "userAgent": ""
  }
}
```

`request` 字段均为可选，默认空数组/空字符串。

响应：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "launch": {
    "args": ["--existing-arg", "--disable-blink-features=AutomationControlled"],
    "extensions": ["/abs/path/to/extension"],
    "initScripts": ["(function() { ... })();"],
    "userAgent": ""
  }
}
```

`launch` 字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `args` | string[] | 完整的 Chrome 启动参数（包含已有参数 + 新增参数） |
| `extensions` | string[] | Chrome 扩展绝对路径列表 |
| `initScripts` | string[] | 在每个新页面加载前执行的 JS 脚本 |
| `userAgent` | string | 自定义 UA，空字符串表示使用 agent-browser 默认值 |

---

### `browser.launch`（Capability: `browser.provider`）

启动或连接 Chrome，返回 CDP WebSocket URL。

请求：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "browser.launch",
  "capability": "browser.provider",
  "request": {
    "userDataDir": "/path/to/profile",
    "profileDirectory": "Default",
    "executablePath": "/path/to/chrome",
    "cdpUrl": "ws://127.0.0.1:9222/...",
    "port": 9222,
    "args": []
  }
}
```

所有字段均为可选。

响应：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "browser": {
    "cdpUrl": "ws://127.0.0.1:9222/devtools/browser/<session>",
    "directPage": false,
    "metadata": {
      "userDataDir": "/path/to/profile",
      "profileDirectory": "Default",
      "source": "/path/to/real/profile",
      "mode": "launch",
      "sessionId": "userprofile-launch-12345-1700000000000",
      "port": 9222,
      "pid": 92368,
      "synced": true
    },
    "cleanup": {
      "sessionId": "userprofile-launch-12345-1700000000000"
    }
  }
}
```

`mode` 取值：`"launch"` | `"connect"`

---

### `browser.close`（Capability: `browser.provider`）

关闭由 `browser.launch` 启动的 Chrome。

请求：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "browser.close",
  "capability": "browser.provider",
  "request": {
    "sessionId": "userprofile-launch-12345-1700000000000",
    "removeDebugDir": false
  }
}
```

响应：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": {
    "closed": true,
    "removedDebugDir": false
  }
}
```

幂等响应（已关闭或 connect 模式）：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": {
    "closed": false,
    "noOp": true
  }
}
```

---

## 错误码

| code | 含义 |
|---|---|
| `empty_input` | stdin 无内容 |
| `parse_error` | JSON 解析失败 |
| `unsupported_protocol` | `protocol` 字段不是 `agent-browser.plugin.v1` |
| `unsupported_type` | 不支持的 `type` 值 |
| `profile_not_found` | 源 `<userDataDir>/<profileDirectory>` 不存在 |
| `profile_locked` | Chrome Profile 已被锁（SingletonLock） |
| `chrome_not_found` | 找不到 Chrome/Chromium 可执行文件 |
| `launch_failed` | Chrome 启动失败 |
| `connect_failed` | CDP 连接失败 |
| `session_not_found` | `browser.close` 找不到 sessionId |
| `fatal` | 未捕获的运行时错误 |

---

## NDJSON 多行支持

插件支持在同一 stdin 中接收多行 JSON（每行一个请求），每行对应一行响应输出。这主要用于测试和批量调用：

```bash
printf '{"protocol":"agent-browser.plugin.v1","type":"plugin.manifest","request":{}}\n{"protocol":"agent-browser.plugin.v1","type":"launch.mutate","request":{"args":[]}}\n' \
  | node dist/index.js
```

---

## 插件开发规范

1. **stdout 只写 JSON**，调试日志全部走 stderr
2. **单请求单进程**：每次调用是独立进程，不维护持久状态（session 注册表除外）
3. **退出码**：成功退出 0；fatal 错误可退出 1（同时在 stdout 输出错误 JSON）
4. **Shebang**：dist/index.js 首行应有 `#!/usr/bin/env node`，文件权限 755
5. **幂等**：同一请求多次调用应返回一致的结果
