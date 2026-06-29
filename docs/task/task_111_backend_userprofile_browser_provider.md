# 任务标题

实现 agent-browser-plugin-userprofile-browser 的 browser.provider 插件

## 关联 Issue

- 主关联 Issue: SUO-111 实现 browser.provider 插件 (agent-browser-plugin-userprofile-browser)
- 架构依赖: SUO-110 架构设计：agent-browser 插件系统 (Node TS + bun)
- 父任务: SUO-109 完成目标任务
- 优先级: medium

## 任务目标

在 `plugins/agent-browser-plugin-userprofile-browser/` 下实现一个独立 TypeScript npm 包，使 agent-browser 可以通过 `--provider agent-browser-plugin-userprofile-browser` 调用本地 provider 插件。

provider 的实现目标必须优先符合官方 `browser.provider` 协议：插件处理 `browser.launch` 和 `browser.close`，并在 `browser.launch` 成功时返回 `browser.cdpUrl`。Chrome Profile 路径、profile directory、session id 等附加信息放入 `browser.metadata`，不要依赖未验证的顶层 `browser.user-data-dir` 字段。

## 实现步骤

1. 初始化包结构:
   - 创建 `plugins/agent-browser-plugin-userprofile-browser/package.json`。
   - 创建 `plugins/agent-browser-plugin-userprofile-browser/tsconfig.json`。
   - 创建 `plugins/agent-browser-plugin-userprofile-browser/build.ts`。
   - 创建 `plugins/agent-browser-plugin-userprofile-browser/src/index.ts`。

2. package.json 要求:
   - `name`: `agent-browser-plugin-userprofile-browser`
   - `version`: `0.1.0`
   - `type`: `module`
   - `main`: `dist/index.js`
   - `bin`: `{ "agent-browser-plugin-userprofile-browser": "./dist/index.js" }`
   - `scripts.build`: `bun run build.ts`

3. 实现通用协议入口:
   - 读取 stdin 全量内容。
   - 解析 JSON。
   - 校验 `protocol`。
   - 分发 `plugin.manifest`、`browser.launch`、`browser.close`。
   - 任何异常都返回 JSON error，不向 stdout 写日志。

4. 实现 `plugin.manifest`:
   - 返回 name: `agent-browser-plugin-userprofile-browser`
   - 返回 capabilities: `["browser.provider"]`
   - 返回简短 description。

5. 实现 `browser.launch` 框架:
   - 解析 request 中可能存在的 profileName、profileDirectory、userDataDir、executablePath、headless、args 等字段。
   - 默认 macOS Chrome user data 根目录为 `~/Library/Application Support/Google/Chrome`。
   - Linux 默认 Chrome user data 根目录可按 `~/.config/google-chrome`，并预留 Chromium fallback `~/.config/chromium`。
   - 优先从环境变量读取可覆盖项，例如 `AGENT_BROWSER_USERPROFILE_DIR`、`AGENT_BROWSER_USERPROFILE_NAME`、`CHROME_PATH`。
   - 启动或连接 Chrome 后返回 `browser.cdpUrl`。
   - 将 `userDataDir`、`profileDirectory`、`mode`、`pid`、`sessionId` 放入 `browser.metadata`。

6. 处理 Chrome Profile 锁和真实 Profile 风险:
   - 如果直接复用默认 Chrome Profile，必须检测是否已有 Chrome 实例正在使用该 profile。
   - 如果 profile 已被锁定，不要强行打开同一 user data dir；优先连接已有 remote debugging Chrome，或返回明确错误。
   - 若实现选择复制 profile 到临时目录，必须把复制策略、排除项和清理策略写入 README。

7. 实现 `browser.close` 框架:
   - 如果 `browser.launch` 返回过 `cleanup.sessionId` 或 pid，则根据 cleanup 信息关闭 provider 自己启动的 Chrome。
   - 如果 provider 只是连接已有 Chrome，则 `browser.close` 返回成功但不关闭用户浏览器。

8. 更新 agent-browser.json:
   - 添加或替换本地 provider 条目。
   - `name` 使用 `agent-browser-plugin-userprofile-browser`，以匹配 `--provider agent-browser-plugin-userprofile-browser`。
   - `command` 使用 `node`。
   - `args` 指向 `./plugins/agent-browser-plugin-userprofile-browser/dist/index.js`。

9. 更新 README:
   - 说明插件用途。
   - 说明官方协议请求/响应示例。
   - 说明 profile 选择策略、环境变量和已知限制。
   - 明确 `launch.mutate` 不会作用于 provider 已启动的浏览器。

## 涉及文件路径

- `plugins/agent-browser-plugin-userprofile-browser/package.json`
- `plugins/agent-browser-plugin-userprofile-browser/tsconfig.json`
- `plugins/agent-browser-plugin-userprofile-browser/build.ts`
- `plugins/agent-browser-plugin-userprofile-browser/src/index.ts`
- `agent-browser.json`
- `README.md`

## 输入 / 输出说明

输入请求:

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "browser.launch",
  "capability": "browser.provider",
  "request": {}
}
```

成功输出:

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "browser": {
    "cdpUrl": "ws://127.0.0.1:9222/devtools/browser/session",
    "directPage": false,
    "metadata": {
      "userDataDir": "/Users/example/Library/Application Support/Google/Chrome",
      "profileDirectory": "Default",
      "mode": "connect-or-launch"
    },
    "cleanup": {
      "sessionId": "userprofile-provider-session"
    }
  }
}
```

manifest 输出:

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "manifest": {
    "name": "agent-browser-plugin-userprofile-browser",
    "capabilities": ["browser.provider"],
    "description": "Launch or connect Chrome with a selected user profile for agent-browser."
  }
}
```

## 依赖项

- SUO-110 的架构约束。
- Node.js。
- bun。
- TypeScript。
- macOS/Linux 的 Chrome 或 Chromium。
- agent-browser CLI 本地配置读取能力。

## 测试策略

1. 构建测试:
   - 在插件目录执行 `bun run build`。
   - 确认 `dist/index.js` 存在且可由 node 执行。

2. 协议单测或脚本测试:
   - 向 stdin 输入 `plugin.manifest`，确认返回 manifest。
   - 输入 unsupported type，确认返回 `success: false`。
   - 输入无效 protocol，确认返回 `success: false`。

3. provider 行为测试:
   - 在不启动真实 Chrome 的情况下，用 mock launch 函数验证 `browser.launch` 响应形状。
   - 在本机可用时跑一次真实 Chrome connect-or-launch 测试，确认返回可连接的 `cdpUrl`。
   - 输入 `browser.close`，确认仅清理 provider 自己启动的进程。

4. agent-browser 集成测试:
   - `agent-browser plugin show agent-browser-plugin-userprofile-browser`
   - `agent-browser --provider agent-browser-plugin-userprofile-browser open about:blank`

## 完成标志

- 插件包目录完整。
- `bun run build` 成功。
- `plugin.manifest`、`browser.launch`、`browser.close` 都有协议处理。
- `agent-browser.json` 指向本地构建产物。
- README 说明 profile 策略、协议格式和限制。
- 完成后按 SUO-111 要求提交 commit。

## 风险提示

- SUO-111 原描述中的 `browser.user-data-dir` 和 `browser.profile-directory` 不是当前官方文档列出的标准 provider 响应字段；实现必须先用 agent-browser 0.31.1 验证是否支持，否则使用 `browser.cdpUrl` 加 `browser.metadata`。
- 默认 Chrome Profile 可能被正在运行的 Chrome 锁定，强行复用会失败或破坏用户状态。
- provider 路径返回的是已启动或外部浏览器；独立 stealth `launch.mutate` 插件不会再修改它。
- 如果业务目标是本地启动且同时应用 stealth，更直接的路径可能是 agent-browser 内置 `--profile` 加 SUO-112 的 `launch.mutate`。
