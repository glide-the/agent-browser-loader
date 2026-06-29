# 任务标题

实现 agent-browser-plugin-userprofile-browser 的 browser.provider 插件

## 关联 Issue

- 主关联 Issue: SUO-111 实现 browser.provider 插件 (agent-browser-plugin-userprofile-browser)
- 架构依赖: SUO-110 架构设计：agent-browser 插件系统 (Node TS + bun)，已完成
- 父任务: SUO-109 完成目标任务
- 优先级: medium

## 任务目标

在 `plugins/agent-browser-plugin-userprofile-browser/` 下实现一个独立 TypeScript npm 包，使 agent-browser 可以通过 `--provider agent-browser-plugin-userprofile-browser` 调用本地 browser.provider 插件。

插件要处理 `browser.launch` 和 `browser.close` 请求。`browser.launch` 的核心职责不是只返回本地 Profile 路径，而是安全地启动或连接一个开启 remote debugging 的 Chrome，并返回 agent-browser 可连接的 `browser.cdpUrl`。用户数据目录和 profile directory 信息应放入 `browser.metadata`，用于追踪与调试。

## 实现步骤

1. 初始化插件包结构：
   - 创建 `plugins/agent-browser-plugin-userprofile-browser/package.json`。
   - 创建 `plugins/agent-browser-plugin-userprofile-browser/tsconfig.json`。
   - 创建 `plugins/agent-browser-plugin-userprofile-browser/build.ts`。
   - 创建 `plugins/agent-browser-plugin-userprofile-browser/src/index.ts`。

2. 配置 package.json：
   - `name`: `agent-browser-plugin-userprofile-browser`
   - `version`: `0.1.0`
   - `type`: `module`
   - `main`: `dist/index.js`
   - `bin`: `{ "agent-browser-plugin-userprofile-browser": "./dist/index.js" }`
   - `scripts.build`: `bun run build.ts`
   - 依赖保持最小，优先使用 Node.js 标准库完成 stdin/stdout、路径、进程和平台探测。

3. 配置 TypeScript 与 bun build：
   - `tsconfig.json` 使用严格类型检查，目标为 Node.js ESM。
   - `build.ts` 使用 `Bun.build` 打包 `src/index.ts` 到 `dist/index.js`。
   - 构建产物必须可被 `node ./dist/index.js` 执行。
   - 构建后确保 bin 入口具备 shebang 或由 `node` 命令显式执行。

4. 实现协议类型定义：
   - 定义 `PluginEnvelope<TRequest>`。
   - 定义 `PluginSuccessResponse`、`PluginErrorResponse`。
   - 定义 `PluginManifestResponse`。
   - 定义 `BrowserLaunchRequest`、`BrowserCloseRequest`。
   - 定义 `BrowserProviderResponse`，包含 `cdpUrl`、`directPage`、`metadata`、`cleanup`。
   - 定义兼容 Issue 示例的 legacy request/response 类型，但不得让 legacy 类型覆盖官方协议。

5. 实现 stdin/stdout 入口：
   - 从 stdin 读取完整输入。
   - 优先按官方单 JSON request 解析。
   - 如果单 JSON 解析失败且存在多行非空内容，可按 NDJSON 解析，用于直接脚本测试兼容。
   - agent-browser 正常调用路径必须保持一个请求对应一个 JSON 响应。
   - stdout 只输出 JSON；调试日志写 stderr 或文件。
   - 任何异常都返回 `{ protocol: "agent-browser.plugin.v1", success: false, error }`，不要抛出未捕获异常到 stdout。

6. 实现请求分发：
   - 校验 `protocol === "agent-browser.plugin.v1"`；legacy 请求缺少 protocol 时只走兼容分支。
   - 支持 `plugin.manifest`。
   - 支持 `browser.launch`。
   - 支持 `browser.close`。
   - 对不支持的 `type` 返回 `success: false` 和稳定错误码或错误消息。

7. 实现 `plugin.manifest`：
   - 返回 name: `agent-browser-plugin-userprofile-browser`
   - 返回 capabilities: `["browser.provider"]`
   - 返回 description: 说明插件会启动或连接带用户 Profile 的本地 Chrome。

8. 实现 Chrome Profile 探测：
   - macOS 默认 user data dir: `~/Library/Application Support/Google/Chrome`。
   - Linux 默认 user data dir: `${XDG_CONFIG_HOME:-~/.config}/google-chrome`。
   - Linux fallback: `${XDG_CONFIG_HOME:-~/.config}/chromium`。
   - 默认 profile directory: `Default`。
   - 支持 request 或环境变量覆盖：
     - `AGENT_BROWSER_USERPROFILE_DIR`
     - `AGENT_BROWSER_USERPROFILE_NAME`
     - `AGENT_BROWSER_PROFILE_DIRECTORY`
     - `CHROME_PATH`
   - 对路径做 `~` 展开、绝对路径解析和存在性检查。

9. 实现 Chrome executable 探测：
   - 优先使用 request.executablePath。
   - 其次使用 `CHROME_PATH`。
   - macOS fallback: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。
   - Linux fallback: `google-chrome`、`google-chrome-stable`、`chromium`、`chromium-browser`。
   - 找不到可执行文件时返回明确 JSON error。

10. 实现 `browser.launch` 的启动/连接策略：
    - 如果 request 或环境变量提供 `cdpUrl`，优先验证可连接后返回 connect 模式。
    - 如果指定 remote debugging port，尝试读取 `http://127.0.0.1:<port>/json/version` 获取 `webSocketDebuggerUrl`。
    - 如果需要启动 Chrome，使用可用端口或 `--remote-debugging-port=0`，并读取 `DevToolsActivePort` 或 `/json/version` 得到 `cdpUrl`。
    - 启动参数至少包含 `--user-data-dir=<userDataDir>` 和 `--profile-directory=<profileDirectory>`。
    - 支持 request.args 追加额外 Chrome 参数，但要去重并避免覆盖核心 provider 参数。
    - 如果目标 Profile 已被运行中的 Chrome 锁定，不要强行复用；优先连接已有 remote debugging 实例，否则返回明确错误。

11. 处理 Profile 锁定和安全策略：
    - 检测 Chrome user data dir 下的锁文件或平台特定 singleton 文件。
    - 不删除用户真实 Profile 的锁文件。
    - 不在默认行为中复制或修改用户 Profile。
    - 如果后续实现需要复制 Profile 到临时目录，必须在 README 记录复制策略、排除项、清理策略和数据风险。
    - 不把 cookies、token 或 Profile 内敏感文件写入日志。

12. 返回 `browser.launch` 成功响应：
    - 必须包含 `browser.cdpUrl`。
    - `browser.directPage` 默认 false。
    - `browser.metadata` 至少包含 `userDataDir`、`profileDirectory`、`mode`、`sessionId`。
    - 如果 agent-browser 当前版本验证可接受额外字段，可以在 `browser` 内额外保留 `"user-data-dir"` 与 `"profile-directory"` 作为 Issue 示例兼容字段；否则不要依赖这两个字段。
    - 如果插件启动了 Chrome，返回 `browser.cleanup.sessionId`，用于后续 `browser.close`。

13. 实现 `browser.close`：
    - 接收 request 中的 cleanup/session 信息。
    - 只关闭 provider 自己启动的 Chrome 进程。
    - 如果 provider 只是连接已有 Chrome，返回成功但不关闭用户浏览器。
    - 对重复 close 或 session 不存在的情况保持幂等，返回成功或清晰的 no-op 响应。

14. 更新 `agent-browser.json`：
    - 添加或替换本地 provider 条目。
    - `name` 使用 `agent-browser-plugin-userprofile-browser`。
    - `command` 使用 `node`。
    - `args` 指向 `./plugins/agent-browser-plugin-userprofile-browser/dist/index.js`。
    - 不删除 captcha、vault、cloud-browser 等无关示例配置，除非实现任务另有明确要求。

15. 更新 README：
    - 说明插件用途和 `--provider agent-browser-plugin-userprofile-browser` 用法。
    - 说明官方协议请求/响应示例。
    - 说明 Profile 选择策略、环境变量、锁定风险和 cleanup 行为。
    - 说明 Issue 中 `user-data-dir` / `profile-directory` 与官方 `browser.cdpUrl` 的兼容关系。
    - 明确 `launch.mutate` 不会自动作用于 provider 已启动或 CDP 连接的浏览器。

16. 完成实现后提交：
    - 运行 `bun run build` 验证编译。
    - 运行最小协议测试。
    - 按 SUO-111 要求提交 commit。

## 涉及文件路径

- `plugins/agent-browser-plugin-userprofile-browser/package.json`
- `plugins/agent-browser-plugin-userprofile-browser/tsconfig.json`
- `plugins/agent-browser-plugin-userprofile-browser/build.ts`
- `plugins/agent-browser-plugin-userprofile-browser/src/index.ts`
- `agent-browser.json`
- `README.md`

## 输入 / 输出说明

官方 `plugin.manifest` 输入：

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "plugin.manifest",
  "capability": "plugin.manifest",
  "request": {}
}
```

官方 `plugin.manifest` 输出：

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

官方 `browser.launch` 输入：

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "browser.launch",
  "capability": "browser.provider",
  "request": {
    "profileDirectory": "Default"
  }
}
```

官方 `browser.launch` 成功输出：

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
      "mode": "launch",
      "sessionId": "userprofile-provider-session"
    },
    "cleanup": {
      "sessionId": "userprofile-provider-session"
    }
  }
}
```

Issue 示例兼容输入：

```json
{ "type": "browser.launch", "id": "req-1" }
```

兼容输出要求：

- 兼容输出可以保留 `id`，便于直接脚本测试。
- 兼容输出仍应包含可连接的 `browser.cdpUrl`。
- `user-data-dir` 与 `profile-directory` 至少应映射到 `browser.metadata.userDataDir` 和 `browser.metadata.profileDirectory`。

`browser.close` 输入：

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "browser.close",
  "capability": "browser.provider",
  "request": {
    "sessionId": "userprofile-provider-session"
  }
}
```

`browser.close` 输出：

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": {
    "closed": true
  }
}
```

## 依赖项

- SUO-110 的架构约束已经完成。
- Node.js。
- bun。
- TypeScript。
- macOS 或 Linux Chrome/Chromium。
- 本地 agent-browser CLI 0.31.1 或兼容版本。
- 可选：已开启 remote debugging 的 Chrome 实例，用于 connect 模式。

## 测试策略

1. 构建测试：
   - 在 `plugins/agent-browser-plugin-userprofile-browser/` 执行 `bun run build`。
   - 确认 `dist/index.js` 存在且可由 `node` 执行。

2. 协议测试：
   - 通过 stdin 输入 `plugin.manifest`，确认返回 manifest。
   - 输入 official `browser.launch` 请求，在 mock Chrome launch 下确认响应包含 `browser.cdpUrl` 与 metadata。
   - 输入 legacy 单行 `{ "type": "browser.launch", "id": "req-1" }`，确认兼容分支不破坏 official 分支。
   - 输入 unsupported type，确认返回 `success: false`。
   - 输入无效 JSON，确认 stdout 返回 JSON error。

3. Profile 探测测试：
   - 在 macOS 路径下确认默认 user data dir 和 profile directory 推导正确。
   - 在 Linux 路径下确认 `XDG_CONFIG_HOME`、google-chrome 和 chromium fallback 生效。
   - 设置 `AGENT_BROWSER_USERPROFILE_DIR`、`AGENT_BROWSER_PROFILE_DIRECTORY`、`CHROME_PATH`，确认覆盖优先级正确。

4. 启动/连接测试：
   - 使用 mock spawn 验证 Chrome 启动参数包含 `--user-data-dir`、`--profile-directory`、remote debugging 参数。
   - 对已有 remote debugging port 调用 `/json/version`，确认能解析 `webSocketDebuggerUrl`。
   - Profile 锁定时确认不会删除锁文件，并返回明确错误或连接已有实例。

5. close 测试：
   - provider 自己启动 Chrome 时，`browser.close` 可以关闭对应 session。
   - connect 模式下，`browser.close` 不关闭用户已有浏览器。
   - 重复 close 不抛异常。

6. agent-browser 集成测试：
   - `agent-browser plugin show agent-browser-plugin-userprofile-browser`
   - `agent-browser --provider agent-browser-plugin-userprofile-browser open about:blank`
   - 如需验证真实 Profile，先关闭同一 Profile 的普通 Chrome，或启动一个已开启 remote debugging 的 Chrome 再走 connect 模式。

## 完成标志

- 插件包目录完整。
- `package.json`、`tsconfig.json`、`build.ts`、`src/index.ts` 已实现。
- `plugin.manifest`、`browser.launch`、`browser.close` 都有协议处理。
- `browser.launch` 返回官方可消费的 `browser.cdpUrl`。
- Profile 路径和 profile directory 信息写入 `browser.metadata`。
- 已处理 official JSON envelope 与 Issue legacy NDJSON/id 示例的兼容边界。
- `agent-browser.json` 指向本地构建产物。
- README 记录用法、环境变量、协议示例和 Profile 风险。
- `bun run build` 成功。
- 已完成 SUO-111 要求的 commit。

## 风险提示

- 当前工作区没有标准 `docs/design/` 和 `docs/issue/` 输入目录；本任务文档使用 Paperclip Issue 描述、SUO-110 任务文档和现有 `docs/*.md` 补足上下文。
- SUO-111 原描述中的 `browser.user-data-dir` 和 `browser.profile-directory` 不是 agent-browser 官方 browser.provider 的核心响应字段；实现必须先保证 `browser.cdpUrl`，再把 Profile 信息放入 metadata 或经验证的兼容字段。
- 真实 Chrome Profile 通常会被正在运行的 Chrome 锁定，强行复用可能失败或损坏用户状态。
- provider 路径返回的是已启动或外部浏览器；独立 stealth `launch.mutate` 插件不会自动修改它。
- 如果业务目标是同时复用真实 Profile、加载扩展并应用 stealth，后续实现可能需要把 stealth 参数合并到 provider 的 Chrome 启动参数中，而不是依赖 SUO-112 自动叠加。
- 读取或复用用户 Profile 涉及 cookies、登录态和本地敏感数据，日志与 README 必须避免泄露路径之外的敏感内容。
