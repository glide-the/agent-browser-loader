# 任务标题

实现 agent-browser-plugin-stealth 插件代码

## 关联 Issue

- 主关联 Issue: SUO-115 实现 agent-browser-plugin-stealth 插件代码
- 直接参考文档: docs/task/task_112_backend_stealth_launch_mutator.md
- 架构依赖: SUO-110 架构设计：agent-browser 插件系统 (Node TS + bun)，已完成
- 编排父任务: SUO-113 CEOOrchestrator：编排 agent-browser 插件实现流水线
- 祖先任务: SUO-109 完成目标任务
- 优先级: medium

## 任务目标

在 `plugins/agent-browser-plugin-stealth/` 下实现一个独立 Node.js + TypeScript 插件包，使 agent-browser 在本地启动 Chrome 前可以通过 `launch.mutate` 插件追加 stealth 相关启动参数、扩展、init scripts 和 userAgent。

插件必须支持 `plugin.manifest` 与 `launch.mutate`。`plugin.manifest` 返回 `capabilities: ["launch.mutate"]`；`launch.mutate` 返回 `args`、`extensions`、`initScripts`、`userAgent` 四类启动配置，并兼容官方 `agent-browser.plugin.v1` envelope 和 Issue 简化格式。

本任务文档只规划后续实现工作。BackendTaskAgent 当前职责不包含直接写插件源码或提交 commit；SUO-115 的代码实现需要交给具备源码实现权限的执行者继续处理。

## 实现步骤

1. 创建插件包目录：
   - `plugins/agent-browser-plugin-stealth/package.json`
   - `plugins/agent-browser-plugin-stealth/tsconfig.json`
   - `plugins/agent-browser-plugin-stealth/build.ts`
   - `plugins/agent-browser-plugin-stealth/src/index.ts`

2. 配置 `package.json`：
   - `name`: `agent-browser-plugin-stealth`
   - `version`: `0.1.0`
   - `type`: `module`
   - `main`: `dist/index.js`
   - `bin`: `{ "agent-browser-plugin-stealth": "./dist/index.js" }`
   - `scripts.build`: `bun run build.ts`
   - 依赖保持最小，优先使用 Node.js 标准库处理 stdin/stdout、路径、环境变量和错误输出。

3. 配置 TypeScript 与 bun build：
   - `tsconfig.json` 使用严格类型检查，目标为 Node.js ESM。
   - `build.ts` 使用 `Bun.build` 将 `src/index.ts` 打包到 `dist/index.js`。
   - 构建产物必须能通过 `node ./dist/index.js` 执行。
   - 如需直接作为 bin 执行，构建产物应包含 shebang；否则 `agent-browser.json` 使用 `command: "node"` 显式运行。

4. 实现协议类型：
   - `PluginEnvelope<TRequest>`
   - `PluginSuccessResponse`
   - `PluginErrorResponse`
   - `PluginManifestResponse`
   - `LaunchMutateRequest`
   - `LaunchMutateResponse`
   - `LegacyLaunchMutateRequest`
   - `LegacyLaunchMutateResponse`

5. 实现 stdin/stdout 入口：
   - 从 stdin 读取请求内容。
   - 正常 agent-browser 调用路径按单个 JSON request 处理。
   - 可保留 legacy NDJSON/id 兼容分支用于脚本测试。
   - 每个有效请求输出一行 JSON 响应。
   - stdout 只能输出 JSON 响应。
   - 日志、warning、调试信息和错误栈只能写入 stderr。
   - JSON parse error、unsupported type、配置错误和运行时异常都必须转为 JSON error 响应。

6. 实现请求分发：
   - 优先校验 `protocol === "agent-browser.plugin.v1"`。
   - 支持 `plugin.manifest`。
   - 支持 `launch.mutate`。
   - 对不支持的 `type` 返回稳定错误码，例如 `unsupported_type`。
   - 对缺少 protocol 但符合 Issue 简化格式的请求走兼容分支，并在响应中保留原始 `id`。

7. 实现 `plugin.manifest`：
   - 返回 `name: "agent-browser-plugin-stealth"`。
   - 返回 `capabilities: ["launch.mutate"]`。
   - `description` 说明插件用于本地 Chrome launch 前追加 stealth args、extensions、initScripts 和 userAgent。

8. 实现 `launch.mutate` 的 args 合并：
   - 保留请求中已有的 `request.args` 或 `launch.args`。
   - 默认追加 `--disable-blink-features=AutomationControlled`。
   - 去重后保持稳定顺序，优先保留调用方已有参数。
   - 支持 `AGENT_BROWSER_STEALTH_ARGS` 追加额外 Chrome args，允许用逗号或换行分隔。

9. 实现 extensions 配置：
   - 默认返回 `extensions: []`。
   - 支持 `AGENT_BROWSER_STEALTH_EXTENSION` 传入单个扩展绝对路径。
   - 支持 `AGENT_BROWSER_STEALTH_EXTENSIONS` 传入多个扩展绝对路径，使用逗号或换行分隔。
   - 对不存在或非绝对路径的扩展给出明确 JSON error 或 stderr warning；策略必须在 README 固定。
   - 不把 CapSolver API key 或其他密钥写入 `agent-browser.json`、README 示例或 stdout。

10. 实现 initScripts：
    - 返回 `initScripts` 字符串数组。
    - 至少包含隐藏 `navigator.webdriver` 的幂等脚本。
    - 补齐最小 `window.chrome.runtime` 形状，避免页面直接检测为空。
    - 只做通用最小覆盖，不写站点特定绕过逻辑。
    - 避免破坏真实 `navigator.plugins`、`navigator.languages` 等对象的原型链、可枚举性和正常页面功能。

11. 实现 userAgent 策略：
    - 返回字段 `userAgent`，类型为字符串。
    - 优先读取 `AGENT_BROWSER_STEALTH_USER_AGENT`。
    - 未配置时可返回空字符串，避免硬编码过期 UA。
    - 如果使用临时默认 UA，只能作为测试 fixture，并在 README 说明过期与平台冲突风险。

12. 更新 `agent-browser.json`：
    - 将现有 `stealth` 插件从 `npx -y agent-browser-plugin-stealth` 改成本地构建产物。
    - 推荐配置：

```json
{
  "name": "stealth",
  "command": "node",
  "args": ["./plugins/agent-browser-plugin-stealth/dist/index.js"],
  "capabilities": ["launch.mutate"]
}
```

13. 更新 README：
    - 说明插件只作用于 agent-browser 本地 launch。
    - 说明 CDP、`--auto-connect` 或 browser.provider 已启动浏览器不会自动叠加该 `launch.mutate`。
    - 说明环境变量：`AGENT_BROWSER_STEALTH_ARGS`、`AGENT_BROWSER_STEALTH_EXTENSION`、`AGENT_BROWSER_STEALTH_EXTENSIONS`、`AGENT_BROWSER_STEALTH_USER_AGENT`。
    - 说明扩展路径必须是本地绝对路径。
    - 说明过期 UA、反检测脚本失效和第三方扩展密钥风险。

14. 构建、验证与提交：
    - 在 `plugins/agent-browser-plugin-stealth/` 执行 `bun run build`。
    - 确认 `dist/index.js` 存在且可由 `node` 执行。
    - 运行 manifest 协议测试，确认返回 `capabilities: ["launch.mutate"]`。
    - 运行 launch.mutate 协议测试，确认响应包含 `args`、`extensions`、`initScripts`、`userAgent`。
    - 完成后提交 commit，并包含 `Co-Authored-By: Paperclip <noreply@paperclip.ing>`。

## 涉及文件路径

- `plugins/agent-browser-plugin-stealth/package.json`
- `plugins/agent-browser-plugin-stealth/tsconfig.json`
- `plugins/agent-browser-plugin-stealth/build.ts`
- `plugins/agent-browser-plugin-stealth/src/index.ts`
- `plugins/agent-browser-plugin-stealth/dist/index.js`
- `agent-browser.json`
- `README.md`
- `docs/task/TASK-REQUIREMENT-FORMAT.md`
- `docs/task/task_115_backend_stealth_plugin_code.md`

## 输入 / 输出说明

official `plugin.manifest` 输入：

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "plugin.manifest",
  "capability": "plugin.manifest",
  "request": {}
}
```

official `plugin.manifest` 输出：

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "manifest": {
    "name": "agent-browser-plugin-stealth",
    "capabilities": ["launch.mutate"],
    "description": "Append local Chrome launch args, extensions, init scripts, and userAgent overrides."
  }
}
```

official `launch.mutate` 输入：

```json
{
  "protocol": "agent-browser.plugin.v1",
  "type": "launch.mutate",
  "capability": "launch.mutate",
  "request": {
    "args": []
  }
}
```

official `launch.mutate` 成功输出：

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "launch": {
    "args": ["--disable-blink-features=AutomationControlled"],
    "extensions": [],
    "initScripts": [
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
    ],
    "userAgent": ""
  }
}
```

Issue 简化格式输入：

```json
{
  "type": "launch.mutate",
  "id": "req-1",
  "launch": {
    "args": []
  }
}
```

Issue 简化格式成功输出：

```json
{
  "id": "req-1",
  "launch": {
    "args": [
      "--disable-blink-features=AutomationControlled"
    ],
    "extensions": [],
    "initScripts": [
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
    ],
    "userAgent": ""
  }
}
```

错误输出要求：

- 官方 envelope 请求返回 `{ "protocol": "agent-browser.plugin.v1", "success": false, "error": { "code": "...", "message": "..." } }`。
- Issue 简化格式请求返回 `{ "id": "req-1", "error": { "code": "...", "message": "..." } }`。
- stdout 保持 JSON，一行一个响应。

## 依赖项

- SUO-110 的插件系统架构约束。
- docs/task/task_112_backend_stealth_launch_mutator.md。
- Node.js。
- bun。
- TypeScript。
- 本地 agent-browser CLI。
- 可选 Chrome 扩展目录，例如 CapSolver Chrome extension。

## 测试策略

1. 构建测试：
   - 在 `plugins/agent-browser-plugin-stealth/` 执行 `bun run build`。
   - 确认 `dist/index.js` 存在并可由 `node ./dist/index.js` 执行。

2. manifest 协议测试：
   - 输入官方 `plugin.manifest` 请求。
   - 确认返回 `success: true` 和 `capabilities: ["launch.mutate"]`。

3. launch.mutate 官方 envelope 测试：
   - 输入官方 envelope 格式。
   - 确认返回 `launch.args`、`launch.extensions`、`launch.initScripts`、`launch.userAgent`。
   - 确认 args 包含 `--disable-blink-features=AutomationControlled`。

4. launch.mutate NDJSON/id 兼容测试：
   - 输入 Issue 简化格式。
   - 确认响应保留 `id`。
   - 输入多行 NDJSON，确认每行请求都有一行响应。

5. 配置测试：
   - 设置 `AGENT_BROWSER_STEALTH_ARGS`，确认额外参数被追加、去重且顺序稳定。
   - 设置 `AGENT_BROWSER_STEALTH_EXTENSION` 或 `AGENT_BROWSER_STEALTH_EXTENSIONS`，确认扩展路径进入 `launch.extensions`。
   - 设置不存在或相对扩展路径，确认错误或 warning 策略与 README 一致。
   - 设置 `AGENT_BROWSER_STEALTH_USER_AGENT`，确认响应使用该值。

6. 错误处理测试：
   - 输入非法 JSON，确认 stdout 返回 JSON error。
   - 输入 unsupported type，确认 stdout 返回 JSON error。
   - 确认 stderr 日志不会污染 stdout。

7. agent-browser 集成测试：
   - `agent-browser plugin show stealth` 或等价命令能读取本地插件。
   - `agent-browser open about:blank` 触发本地 launch 时能调用 `launch.mutate`。
   - 如需验证脚本效果，在页面内检查 `navigator.webdriver`，期望为 `undefined` 或等价隐藏结果。

## 完成标志

- `plugins/agent-browser-plugin-stealth/package.json` 已创建。
- `plugins/agent-browser-plugin-stealth/tsconfig.json` 已创建。
- `plugins/agent-browser-plugin-stealth/build.ts` 已创建。
- `plugins/agent-browser-plugin-stealth/src/index.ts` 已创建。
- `plugins/agent-browser-plugin-stealth/dist/index.js` 构建成功。
- `plugin.manifest` 返回 `capabilities: ["launch.mutate"]`。
- `launch.mutate` 返回 `args`、`extensions`、`initScripts`、`userAgent` 四个字段。
- 官方 envelope 和 Issue 简化格式都被测试覆盖。
- `agent-browser.json` 的 `stealth` 条目已更新为本地 `node ./plugins/agent-browser-plugin-stealth/dist/index.js`。
- README 记录环境变量、协议示例、扩展配置、provider/CDP 限制和安全风险。
- 已提交 commit，包含 `Co-Authored-By: Paperclip <noreply@paperclip.ing>`。

## 风险提示

- 当前工作区没有标准 `docs/design/` 和 `docs/issue/` 输入目录；本任务文档使用 Paperclip Issue 描述、SUO-110/SUO-112 任务文档和现有 `docs/*.md` 补足上下文。
- BackendTaskAgent 的角色边界是输出后端任务文档，不是直接实现源码；SUO-115 的实际代码产物需要移交给具备实现权限的执行者。
- `launch.mutate` 只对本地 agent-browser launch 生效，不对 `--cdp`、`--auto-connect` 或 `--provider` 已启动浏览器生效。
- 反检测脚本可能随网站策略变化失效，不应承诺稳定绕过特定站点风控。
- 第三方验证码扩展依赖外部 API key，密钥不能写入 `agent-browser.json` 或提交到仓库。
- 过期或平台不匹配的 userAgent 会形成新的指纹异常，应优先通过环境变量配置。
- 过度修改 navigator 对象可能破坏页面正常功能，应保持最小、可配置、可回滚。
