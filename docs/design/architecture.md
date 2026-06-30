# agent-browser 插件系统架构设计

## 背景

为了在 BOSS 直聘等有反爬检测的网站上实现稳定的 AI 自动化操作，需要解决两个核心问题：

1. **Chrome 用户 Profile 复用** — 使用已登录的真实 Chrome Profile，而非沙盒 headless 浏览器
2. **自动化特征隐藏** — 隐藏 CDP/webdriver 暴露给 JS 层的自动化特征

agent-browser 通过插件系统（`agent-browser.plugin.v1`）支持本地扩展这两个能力。

---

## 整体架构

```
agent-browser CLI
  │
  ├─ --provider <name>     →  browser.provider 插件 (提供 cdpUrl)
  │      └── cloud-browser 等远程/外部浏览器 provider
  │
  ├─ 本地 launch 路径        →  launch.mutate 插件 (注入 args/extensions/initScripts/profile)
  │      └── agent-browser-plugin-stealth
  │            （合并了原 agent-browser-plugin-userprofile-browser 的 Profile 注入）
  │
  └─ agent-browser.json     →  插件注册表
```

### 插件通信方式

所有插件使用 **stdin/stdout JSON（NDJSON 兼容）** 作为进程间通信协议。

- 父进程（agent-browser）通过 stdin 写入请求
- 插件通过 stdout 输出响应
- 调试信息只能写入 stderr，不得污染 stdout

---

## 插件协议：agent-browser.plugin.v1

### 请求信封（official）

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "<request-type>",
  "capability": "<capability>",
  "request": { ... }
}
```

### 响应信封

成功：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "launch": { ... }  // 或 "browser": { ... } 等
}
```

错误：
```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": false,
  "error": { "code": "...", "message": "..." }
}
```

### Capability 类型

| Capability | Request type | 触发时机 | 响应字段 |
|---|---|---|---|
| `browser.provider` | `browser.launch`, `browser.close` | `--provider <name>` | `browser` |
| `launch.mutate` | `launch.mutate` | 所有本地 launch | `launch` |
| `credential.read` | `credential.resolve` | `auth login --credential-provider <name>` | `credential` |
| `command.run` | 自定义 | `plugin run <name> <type>` | `data` |

---

## 插件：agent-browser-plugin-stealth（含 Profile 注入）

> 原 `agent-browser-plugin-userprofile-browser` 已合并进本插件。二者同为 `launch.mutate`，现统一为单个插件。

### Profile 注入职责

`launch.mutate` 插件 — 在 agent-browser 本地启动 Chrome 前注入真实 Chrome Profile 参数。

### 核心流程

```
launch.mutate 请求
  │
  ├─ 读取 request.args / extensions / initScripts / userAgent
  ├─ 解析 userDataDir / profileDirectory
  ├─ 保留调用方已有参数
  ├─ 追加缺失的 --user-data-dir / --profile-directory / no-first-run 参数
  └─ 返回 { launch: { args, extensions, initScripts, userAgent } }
```

### Profile 解析优先级

```
userDataDir:
  1. request.userDataDir
  2. AGENT_BROWSER_USERPROFILE_DIR (env)
  3. 平台默认:
     - macOS: ~/Library/Application Support/Google/Chrome
     - Linux: ${XDG_CONFIG_HOME:-~/.config}/google-chrome（chromium 回退）

profileDirectory:
  1. request.profileDirectory
  2. AGENT_BROWSER_PROFILE_DIRECTORY (env)
  3. 默认: "Default"
```

### 关键设计决策

- **不用 `browser.provider`**：provider 路径不能和 `--extension` 同用；Profile 复用必须留在本地 launch 管线。
- **不启动或关闭 Chrome**：插件只返回 launch 变更，Chrome 生命周期由 agent-browser 本地执行器负责。
- **不删除 Profile 锁**：插件不读取或修复 Chrome Profile 锁文件，避免损坏用户数据。
- **保留显式参数优先级**：如果调用方已经传入 `--user-data-dir` 或 `--profile-directory`，不覆盖该值。

---

## 插件二：agent-browser-plugin-stealth

### Stealth 注入职责

`launch.mutate` 插件 — 在 agent-browser 本地启动 Chrome 前，注入 stealth 相关的参数、扩展和页面脚本。

### **重要限制**

此插件**仅作用于本地 launch 路径**。以下情况不受此插件影响：

- `--cdp` 模式
- `--auto-connect` 模式
- `browser.provider` 插件提供的浏览器

### 注入内容

#### args（Chrome 启动参数）

| 参数 | 作用 |
|---|---|
| `--disable-blink-features=AutomationControlled` | 去除 Chromium 自动化控制标志 |
| `--no-sandbox` | 仅当 `AGENT_BROWSER_STEALTH_NO_SANDBOX=1` 时追加 |

#### initScripts（页面注入脚本）

每个新页面（`addScriptToEvaluateOnNewDocument`）注入：

1. **隐藏 `navigator.webdriver`** — `Object.defineProperty(navigator, 'webdriver', { get: () => undefined })`
2. **补全 `window.chrome.runtime`** — `{ runtime: {} }` shape，避免 chrome 空对象检测
3. **no-op plugins 检查** — 避免破坏 `navigator.plugins` 原型链

#### userAgent

- 优先使用 `AGENT_BROWSER_STEALTH_USER_AGENT` 环境变量
- 否则返回空字符串（agent-browser 使用自身默认 UA）
- 不硬编码 UA，避免平台指纹不匹配

#### extensions

- `AGENT_BROWSER_STEALTH_EXTENSION` — 单个扩展绝对路径
- `AGENT_BROWSER_STEALTH_EXTENSIONS` — 多个扩展绝对路径（逗号或换行分隔）
- 路径不存在时输出 stderr 警告，不中断启动

---

## 技术选型

| 维度 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript (strict) | 类型安全，与 agent-browser 生态一致 |
| 运行时 | Node.js ≥ 18 | ESM 原生支持，process.stdin async iterator |
| 打包器 | Bun | 零配置，单文件输出，速度快 |
| 模块格式 | ESM (`"type": "module"`) | 与 Node 18+ 原生 ESM 对齐 |
| 输出格式 | 单 CJS-like bundle（bun target:node） | 依赖内联，无需 node_modules |

### 构建流程

```bash
bun run build.ts
# → dist/index.js（带 shebang，chmod 755）
```

---

## agent-browser.json 注册

```json
{
  "plugins": [
    {
      "name": "stealth",
      "command": "node",
      "args": ["./plugins/agent-browser-plugin-stealth/dist/index.js"],
      "capabilities": ["launch.mutate"]
    }
  ]
}
```

---

## 目录结构

```
agent-brower/
├── agent-browser.json          # 插件注册表
├── README.md                   # 项目总览
├── docs/
│   ├── design/
│   │   ├── architecture.md     # 本文件
│   │   └── plugin-protocol.md  # 协议详细规范
│   ├── issues/
│   │   └── SUO-109.md          # 任务记录
│   └── phases/
│       └── phase-1-plugins.md  # 阶段总结
├── plugins/
│   ├── agent-browser-plugin-stealth/
│   │   ├── src/index.ts
│   │   ├── dist/index.js       # 构建产物
│   │   ├── build.ts
│   │   ├── package.json
│   │   └── tsconfig.json
└── start-chrome-debug.sh       # 手动 Chrome 启动脚本（遗留）
```
