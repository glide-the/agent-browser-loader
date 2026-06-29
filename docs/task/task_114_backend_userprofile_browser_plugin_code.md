# 任务标题

实现 agent-browser-plugin-userprofile-browser 插件代码

## 关联 Issue

- 主关联 Issue: SUO-114 实现 agent-browser-plugin-userprofile-browser 插件代码
- 直接参考文档: docs/task/task_111_backend_userprofile_browser_provider.md
- 架构依赖: SUO-110 架构设计：agent-browser 插件系统 (Node TS + bun)，已完成
- 编排父任务: SUO-113 CEOOrchestrator：编排 agent-browser 插件实现流水线
- 祖先任务: SUO-109 完成目标任务
- 优先级: medium

## 任务目标

在 `plugins/agent-browser-plugin-userprofile-browser/` 下实现一个独立 Node.js + TypeScript 插件包，使 agent-browser 可以通过 `--provider agent-browser-plugin-userprofile-browser` 调用本地 `browser.provider` 插件。

插件必须支持 `plugin.manifest`、`browser.launch`、`browser.close` 三类请求。`browser.launch` 的核心目标是启动或连接一个可 CDP 访问的本地 Chrome，并返回 agent-browser 可消费的 `browser.cdpUrl`；用户 Profile 路径、profile directory、启动模式和 session 信息应放入 `browser.metadata`。

本任务文档只规划后续实现工作。BackendTaskAgent 当前职责不包含直接写插件源码或提交 commit。

## 实现步骤

1. 创建插件包目录:
   - `plugins/agent-browser-plugin-userprofile-browser/package.json`
   - `plugins/agent-browser-plugin-userprofile-browser/tsconfig.json`
   - `plugins/agent-browser-plugin-userprofile-browser/build.ts`
   - `plugins/agent-browser-plugin-userprofile-browser/src/index.ts`

2. 配置 `package.json`:
   - `name`: `agent-browser-plugin-userprofile-browser`
   - `version`: `0.1.0`
   - `type`: `module`
   - `main`: `dist/index.js`
   - `bin`: `{ "agent-browser-plugin-userprofile-browser": "./dist/index.js" }`
   - `scripts.build`: `bun run build.ts`
   - 依赖保持最小，优先使用 Node.js 标准库处理 stdin/stdout、路径、HTTP、进程和平台探测。

3. 配置 TypeScript 与 bun build:
   - `tsconfig.json` 使用严格类型检查，目标为 Node.js ESM。
   - `build.ts` 使用 `Bun.build` 将 `src/index.ts` 打包到 `dist/index.js`。
   - 构建产物必须能通过 `node ./dist/index.js` 执行。
   - 如需直接作为 bin 执行，构建产物应包含 shebang；否则 `agent-browser.json` 使用 `command: "node"` 显式运行。

4. 实现协议类型:
   - `PluginEnvelope<TRequest>`
   - `PluginSuccessResponse`
   - `PluginErrorResponse`
   - `PluginManifestResponse`
   - `BrowserLaunchRequest`
   - `BrowserCloseRequest`
   - `BrowserProviderResponse`
   - `BrowserCleanup`
   - `BrowserMetadata`

5. 实现 stdin/stdout 入口:
   - 从 stdin 读取请求内容。
   - 正常 agent-browser 调用路径按单个 JSON request 处理。
   - 可保留 legacy NDJSON/id 兼容分支用于脚本测试，但 official envelope 必须是主路径。
   - stdout 只能输出 JSON 响应。
   - 日志、warning、调试信息和错误栈只能写入 stderr。
   - JSON parse error、unsupported type、配置错误和运行时异常都必须转为 JSON error 响应。

6. 实现请求分发:
   - 校验 `protocol === "agent-browser.plugin.v1"`。
   - 支持 `plugin.manifest`。
   - 支持 `browser.launch`。
   - 支持 `browser.close`。
   - 对不支持的 `type` 返回稳定错误码，例如 `unsupported_type`。

7. 实现 `plugin.manifest`:
   - 返回 `name: "agent-browser-plugin-userprofile-browser"`。
   - 返回 `capabilities: ["browser.provider"]`。
   - `description` 说明插件会启动或连接带用户 Profile 的本地 Chrome。

8. 实现 Profile 路径探测:
   - macOS 默认 user data dir: `~/Library/Application Support/Google/Chrome`。
   - Linux 默认 user data dir: `${XDG_CONFIG_HOME:-~/.config}/google-chrome`。
   - Linux fallback: `${XDG_CONFIG_HOME:-~/.config}/chromium`。
   - 默认 profile directory: `Default`。
   - 支持 request 或环境变量覆盖:
     - `AGENT_BROWSER_USERPROFILE_DIR`
     - `AGENT_BROWSER_USERPROFILE_NAME`
     - `AGENT_BROWSER_PROFILE_DIRECTORY`
     - `CHROME_PATH`
   - 对路径执行 `~` 展开、绝对路径解析和存在性检查。

9. 实现 Chrome executable 探测:
   - 优先使用 request.executablePath。
   - 其次使用 `CHROME_PATH`。
   - macOS fallback: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。
   - Linux fallback: `google-chrome`、`google-chrome-stable`、`chromium`、`chromium-browser`。
   - 找不到可执行文件时返回 JSON error，不把错误栈写到 stdout。

10. 实现 `browser.launch` 的 connect/launch 策略:
    - 如果 request 或环境变量提供 `cdpUrl`，优先验证可连接并返回 connect 模式。
    - 如果指定 remote debugging port，尝试读取 `http://127.0.0.1:<port>/json/version` 并解析 `webSocketDebuggerUrl`。
    - 如果需要启动 Chrome，使用可用端口或 `--remote-debugging-port=0`。
    - 启动后读取 `DevToolsActivePort` 或轮询 `/json/version` 得到 `cdpUrl`。
    - 启动参数至少包含 `--user-data-dir=<userDataDir>` 与 `--profile-directory=<profileDirectory>`。
    - 支持 request.args 追加额外 Chrome 参数，但要去重并避免覆盖核心 provider 参数。
    - 为 launch 等待设置明确超时，超时返回可解释的 JSON error。

11. 处理 Profile 锁定与敏感数据:
    - 检测 Chrome user data dir 下的平台锁文件或 singleton 文件。
    - 不删除真实用户 Profile 的锁文件。
    - 不复制、不修改、不清理用户真实 Profile 内容，除非后续需求单独审批复制策略。
    - 如果 Profile 已被运行中的 Chrome 锁定，优先连接已有 remote debugging 实例；无法连接时返回明确错误。
    - 不把 cookies、token、完整 Profile 内容或本地敏感文件写入日志。

12. 返回 `browser.launch` 成功响应:
    - 必须包含 `browser.cdpUrl`。
    - `browser.directPage` 默认 false。
    - `browser.metadata` 至少包含 `userDataDir`、`profileDirectory`、`mode`、`sessionId`。
    - 如果插件启动了 Chrome，返回 `browser.cleanup.sessionId`，供 `browser.close` 使用。
    - 如果 agent-browser 当前版本验证可接受额外字段，可保留 `"user-data-dir"` 与 `"profile-directory"` 作为兼容字段；不能依赖这两个字段替代 `cdpUrl`。

13. 实现 `browser.close`:
    - 接收 request 中的 `sessionId` 或 cleanup 信息。
    - 只关闭 provider 自己启动的 Chrome 进程。
    - connect 模式下不关闭用户已有浏览器。
    - 重复 close、session 不存在或已关闭时保持幂等，返回成功或清晰 no-op 响应。

14. 更新 `agent-browser.json`:
    - 添加或替换本地 provider 条目。
    - `name` 使用 `agent-browser-plugin-userprofile-browser`。
    - `command` 使用 `node`。
    - `args` 指向 `./plugins/agent-browser-plugin-userprofile-browser/dist/index.js`。
    - 不删除 captcha、vault、cloud-browser、stealth 等无关示例配置，除非后续实现 Issue 另有明确要求。

   目标配置:

   ```json
   {
     "name": "agent-browser-plugin-userprofile-browser",
     "command": "node",
     "args": ["./plugins/agent-browser-plugin-userprofile-browser/dist/index.js"],
     "capabilities": ["browser.provider"]
   }
   ```

15. 更新 README:
    - 说明插件用途和 `--provider agent-browser-plugin-userprofile-browser` 用法。
    - 说明 Profile 选择策略、环境变量、锁定风险和 cleanup 行为。
    - 提供 official `plugin.manifest`、`browser.launch`、`browser.close` 请求/响应示例。
    - 说明 `user-data-dir` / `profile-directory` 与 `browser.cdpUrl` 的关系。
    - 明确独立 `launch.mutate` 不会自动作用于 provider 已启动或 CDP 连接的浏览器。

16. 构建、验证与提交:
    - 在 `plugins/agent-browser-plugin-userprofile-browser/` 执行 `bun run build`。
    - 确认 `dist/index.js` 存在且可由 `node` 执行。
    - 运行 manifest 协议测试，确认返回 `capabilities: ["browser.provider"]`。
    - 完成后提交 commit，并包含 `Co-Authored-By: Paperclip <noreply@paperclip.ing>`。

## 涉及文件路径

- `plugins/agent-browser-plugin-userprofile-browser/package.json`
- `plugins/agent-browser-plugin-userprofile-browser/tsconfig.json`
- `plugins/agent-browser-plugin-userprofile-browser/build.ts`
- `plugins/agent-browser-plugin-userprofile-browser/src/index.ts`
- `agent-browser.json`
- `README.md`
- `docs/task/TASK-REQUIREMENT-FORMAT.md`
- `docs/task/task_114_backend_userprofile_browser_plugin_code.md`

## 输入 / 输出说明

official `plugin.manifest` 输入:

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "plugin.manifest",
  "capability": "plugin.manifest",
  "request": {}
}
```

official `plugin.manifest` 输出:

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

official `browser.launch` 输入:

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

official `browser.launch` 成功输出:

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

official `browser.close` 输入:

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

official `browser.close` 输出:

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "data": {
    "closed": true
  }
}
```

错误输出要求:

- official envelope 请求返回 `{ "protocol": "agent-browser.plugin.v1", "success": false, "error": { "code": "...", "message": "..." } }`。
- stdout 保持 JSON，不能混入日志。
- stderr 可以输出诊断日志，但不得包含 cookies、token 或敏感 Profile 内容。

## 依赖项

- SUO-110 插件系统架构约束。
- SUO-111 browser.provider 任务文档。
- Node.js。
- bun。
- TypeScript。
- macOS 或 Linux Chrome/Chromium。
- 本地 agent-browser CLI 0.31.1 或兼容版本。
- 可选：已开启 remote debugging 的 Chrome 实例，用于 connect 模式验证。

## 测试策略

1. 构建测试:
   - 在 `plugins/agent-browser-plugin-userprofile-browser/` 执行 `bun run build`。
   - 确认 `dist/index.js` 存在且可由 `node` 执行。

2. manifest 协议测试:
   - 执行:

     ```bash
     echo '{"protocol":"agent-browser.plugin.v1","type":"plugin.manifest","capability":"plugin.manifest","request":{}}' | node ./plugins/agent-browser-plugin-userprofile-browser/dist/index.js
     ```

   - 确认响应包含 `success: true` 与 `capabilities: ["browser.provider"]`。

3. `browser.launch` 协议测试:
   - 用 mock Chrome launch 或可控测试环境输入 official `browser.launch` 请求。
   - 确认响应包含 `browser.cdpUrl`、`browser.metadata.userDataDir`、`browser.metadata.profileDirectory`。
   - 输入 unsupported type，确认返回 JSON error。
   - 输入无效 JSON，确认 stdout 返回 JSON error。

4. Profile 探测测试:
   - 在 macOS 路径下确认默认 user data dir 和 profile directory 推导正确。
   - 在 Linux 路径下确认 `XDG_CONFIG_HOME`、google-chrome 和 chromium fallback 生效。
   - 设置 `AGENT_BROWSER_USERPROFILE_DIR`、`AGENT_BROWSER_PROFILE_DIRECTORY`、`CHROME_PATH`，确认覆盖优先级正确。

5. 启动/连接测试:
   - 使用 mock spawn 验证 Chrome 启动参数包含 `--user-data-dir`、`--profile-directory` 和 remote debugging 参数。
   - 对已有 remote debugging port 调用 `/json/version`，确认能解析 `webSocketDebuggerUrl`。
   - Profile 锁定时确认不会删除锁文件，并返回明确错误或连接已有实例。

6. `browser.close` 测试:
   - provider 自己启动 Chrome 时，`browser.close` 可以关闭对应 session。
   - connect 模式下，`browser.close` 不关闭用户已有浏览器。
   - 重复 close 不抛异常。

7. agent-browser 集成测试:
   - `agent-browser plugin show agent-browser-plugin-userprofile-browser` 或等价命令能读取本地配置。
   - `agent-browser --provider agent-browser-plugin-userprofile-browser open about:blank` 能触发 provider。
   - 如需验证真实 Profile，先关闭同一 Profile 的普通 Chrome，或启动一个已开启 remote debugging 的 Chrome 再走 connect 模式。

## 完成标志

- `plugins/agent-browser-plugin-userprofile-browser/package.json` 已创建。
- `plugins/agent-browser-plugin-userprofile-browser/tsconfig.json` 已创建。
- `plugins/agent-browser-plugin-userprofile-browser/build.ts` 已创建。
- `plugins/agent-browser-plugin-userprofile-browser/src/index.ts` 已创建。
- `plugins/agent-browser-plugin-userprofile-browser/dist/index.js` 构建成功。
- `plugin.manifest` 返回 `capabilities: ["browser.provider"]`。
- `browser.launch` 返回官方可消费的 `browser.cdpUrl`。
- `browser.close` 幂等处理。
- `agent-browser.json` 已包含本地 provider 插件条目。
- README 记录用法、环境变量、协议示例和 Profile 风险。
- 已运行 SUO-114 指定的 manifest 命令并记录结果。
- 已提交 commit，包含 `Co-Authored-By: Paperclip <noreply@paperclip.ing>`。

## 风险提示

- 当前工作区没有标准 `docs/design/` 和 `docs/issue/` 输入目录；本任务文档使用 Paperclip Issue 描述、SUO-111 任务文档和现有 `docs/*.md` 补足上下文。
- 当前仓库尚不存在 `plugins/` 目录，后续实现需要从零创建插件包。
- BackendTaskAgent 的角色边界是不写实现代码；SUO-114 的源码实现和 commit 需要由具备实现权限的 Agent 或人工继续执行。
- `browser.provider` 的关键字段是 `browser.cdpUrl`；仅返回 `user-data-dir` 和 `profile-directory` 不足以让 agent-browser 连接浏览器。
- 真实 Chrome Profile 通常会被正在运行的 Chrome 锁定，强行复用可能失败或损坏用户状态。
- provider 返回的是已启动或外部浏览器；独立 stealth `launch.mutate` 插件不会自动修改它。
- 如果业务目标是同时复用真实 Profile、加载扩展并应用 stealth，后续实现可能需要把 stealth 参数合并到 provider 的 Chrome 启动参数中，而不是依赖独立 launch.mutate 自动叠加。
- 读取或复用用户 Profile 涉及 cookies、登录态和本地敏感数据，日志、README 和测试输出不得泄露敏感内容。
