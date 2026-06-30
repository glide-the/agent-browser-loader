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
  ├─ plugin run <name>     →  command.run 插件 (一次性准备工作)
  │      └── agent-browser-plugin-userprofile-browser
  │            browser.launch: rsync 同步 Profile → RemoteDebug 目录，持久化 launch 目录
  │            browser.close : 清理持久化状态
  │
  ├─ 本地 launch 路径        →  launch.mutate 插件 (注入 args/extensions/initScripts/profile)
  │      └── agent-browser-plugin-stealth
  │            读取 userprofile-browser 持久化的 user-data-dir，注入 stealth 参数
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

## 插件一：agent-browser-plugin-userprofile-browser（command.run）

> 该插件负责 Profile 准备。rsync 重同步过去被放在 stealth 的 `launch.mutate` 里，会在每次本地启动时阻塞；现拆分为 `command.run`，变成显式的一次性操作。

### 职责

`command.run` 插件 — 通过 `agent-browser plugin run userprofile-browser <type>` 调用，支持 `browser.launch` / `browser.close` 两种请求类型，响应字段为 `data`。

### 核心流程

```
plugin run userprofile-browser browser.launch
  │
  ├─ 解析 source userDataDir / profileDirectory / debugDir
  ├─ 若状态文件已存在且未 force：跳过 rsync（保证“只同步一次”）
  ├─ 否则 rsync 同步 source/<profile>/ → debug/<profile>/（排除 lock/log/journal/cache）
  ├─ 写入状态文件 { userDataDir, profileDirectory, source, syncedAt }
  └─ 返回 { data: { userDataDir, profileDirectory, synced, statePath } }

plugin run userprofile-browser browser.close
  └─ 删除状态文件（removeDebugDir:true 时一并删除 debug 目录）
```

### 路径解析与状态文件

> agent-browser 以子进程方式拉起插件，环境变量无法可靠传入，因此配置改为读取本地文件
> `<cwd>/.agent-browser/userprofile.config.json`（与 stealth 共享）。env 变量仅作为兜底。

```
配置文件 .agent-browser/userprofile.config.json:
  { userDataDir?, profileDirectory?, debugDir?, statePath? }

source userDataDir:
  1. request.userDataDir
  2. 配置文件 userDataDir
  3. AGENT_BROWSER_USERPROFILE_DIR / _NAME (env，兜底)
  4. 平台默认（macOS: ~/Library/Application Support/Google/Chrome；Linux: 同上）

debug userDataDir（启动目录）:
  1. request.debugDir
  2. 配置文件 debugDir
  3. AGENT_BROWSER_USERPROFILE_DEBUG_DIR (env，兜底)
  4. <source>RemoteDebug 同级目录（macOS: ~/.../Google/ChromeRemoteDebug）

状态文件路径（与 stealth 共享）:
  配置文件 statePath → AGENT_BROWSER_USERPROFILE_STATE (env，兜底)
    → <cwd>/.agent-browser/userprofile-browser-state.json
```

### 关键设计决策

- **rsync 只执行一次**：通过 command.run 从 launch.mutate 热路径剖离；状态文件存在则跳过，`force:true` 可重新同步。
- **绕过 “non-default data directory” 限制**：全量 rsync 让 RemoteDebug 目录看起来像真实 Profile。
- **不启动或关闭 Chrome、不删除 Profile 锁**：只同步数据并记录启动目录；rsync 排除锁/日志/journal/cache，即使 Chrome 运行中也能安全拷贝。
- **不记录敏感数据**：不读取也不记录 cookie / token / Profile 文件内容。

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

#### profile 参数（来自 userprofile-browser 状态文件）

stealth 在每次 `launch.mutate` 时读取 userprofile-browser 持久化的状态文件，追加缺失的：

- `--user-data-dir=<RemoteDebug 目录>`
- `--profile-directory=<profile>`
- `--no-first-run` / `--no-default-browser-check`

解析优先级：`request.userDataDir` > 状态文件 `userDataDir` > 配置文件 `debugDir`/`userDataDir` > `AGENT_BROWSER_USERPROFILE_DIR`(env，兜底) > 平台默认。stealth **不**执行 rsync —— 同步由 userprofile-browser 一次性完成。

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
    },
    {
      "name": "userprofile-browser",
      "command": "node",
      "args": ["./plugins/agent-browser-plugin-userprofile-browser/dist/index.js"],
      "capabilities": ["command.run"]
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
│   └── agent-browser-plugin-userprofile-browser/  # command.run: Profile rsync + 持久化
│       ├── src/index.ts
│       ├── dist/index.js
│       ├── build.ts
│       ├── package.json
│       └── tsconfig.json
└── start-chrome-debug.sh       # 手动 Chrome 启动脚本（遗留）
```
