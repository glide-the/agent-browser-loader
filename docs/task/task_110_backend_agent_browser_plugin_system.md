# 任务标题

agent-browser 本地插件系统架构与骨架规划

## 关联 Issue

- 主 Issue: SUO-110 架构设计：agent-browser 插件系统 (Node TS + bun)
- 父任务: SUO-109 完成目标任务
- 下游任务:
  - SUO-111 实现 browser.provider 插件 (agent-browser-plugin-userprofile-browser)
  - SUO-112 实现 launch.mutate 插件 (agent-browser-plugin-stealth)
- 优先级: medium

## 任务目标

为 agent-browser 的两个本地插件包建立统一后端任务边界和协议约束，让后续实现可以在 Node.js + TypeScript + bun 下完成独立 npm 包骨架、协议类型、构建脚本、manifest 支持和本地 agent-browser.json 配置。

本任务只定义架构与可执行实现任务，不负责写插件源码、不提交 commit、不改写 docs/design/、docs/issue/ 或 docs/stage/。

## 实现步骤

1. 建立插件目录规划:
   - `plugins/agent-browser-plugin-userprofile-browser/`
   - `plugins/agent-browser-plugin-stealth/`

2. 每个插件包都采用独立 npm 包结构:
   - `package.json`: 包含 name、version、type、main、bin、scripts。
   - `tsconfig.json`: 输出到 `dist/`，启用 strict、ES2022、NodeNext 或等价 Node ESM 配置。
   - `build.ts`: 使用 bun build 把 `src/index.ts` 打包为可执行入口。
   - `src/index.ts`: 只放协议入口、manifest 分发、请求分发和占位业务逻辑。

3. 统一协议处理模型:
   - 从 stdin 读取完整输入并解析为一个 JSON 请求。
   - 校验 `protocol === "agent-browser.plugin.v1"`。
   - 支持 `plugin.manifest`。
   - 对支持的 request type 返回成功响应。
   - 对不支持的 type 返回 `{ protocol, success: false, error }`。
   - stdout 只写一个 JSON 响应；日志写 stderr 或文件。

4. 定义 TypeScript 协议类型:
   - `PluginRequest<TRequest>`
   - `PluginSuccessResponse`
   - `PluginErrorResponse`
   - `PluginManifestResponse`
   - `BrowserLaunchRequest`
   - `BrowserCloseRequest`
   - `BrowserProviderResponse`
   - `LaunchMutateRequest`
   - `LaunchMutateResponse`

5. 明确 browser.provider 与 launch.mutate 的组合边界:
   - `browser.provider` 用于启动或连接外部浏览器，并返回 `browser.cdpUrl`。
   - `launch.mutate` 用于本地 agent-browser 启动 Chrome 之前追加 args、extensions、initScripts、userAgent。
   - agent-browser 官方文档说明 `launch.mutate` 不会作用于 CDP 连接或 remote/browser.provider 已启动的浏览器。
   - 因此如果产品路径要求 `--provider` 和 stealth 同时生效，stealth 参数必须并入 provider 启动 Chrome 的过程，不能依赖独立 `launch.mutate` 自动叠加。

6. 更新 agent-browser.json 的目标配置:
   - 为 userprofile provider 添加或替换同名本地插件条目。
   - 将 stealth 从 `npx -y agent-browser-plugin-stealth` 改为本地 `node` 执行构建产物。
   - 不在本任务中要求删除 captcha、vault 等无关配置；实现任务可在修改前确认是否保留示例插件。

目标配置形状:

```json
{
  "plugins": [
    {
      "name": "agent-browser-plugin-userprofile-browser",
      "command": "node",
      "args": ["./plugins/agent-browser-plugin-userprofile-browser/dist/index.js"],
      "capabilities": ["browser.provider"]
    },
    {
      "name": "stealth",
      "command": "node",
      "args": ["./plugins/agent-browser-plugin-stealth/dist/index.js"],
      "capabilities": ["launch.mutate"]
    }
  ]
}
```

## 涉及文件路径

- `docs/task/TASK-REQUIREMENT-FORMAT.md`
- `docs/task/task_110_backend_agent_browser_plugin_system.md`
- `docs/task/task_111_backend_userprofile_browser_provider.md`
- `docs/task/task_112_backend_stealth_launch_mutator.md`
- `plugins/agent-browser-plugin-userprofile-browser/`
- `plugins/agent-browser-plugin-stealth/`
- `agent-browser.json`
- `README.md`

## 输入 / 输出说明

输入:

- Paperclip Issue SUO-110、SUO-111、SUO-112 的描述和依赖关系。
- 当前仓库 `docs/当前目标.md`、`docs/当前问题.md`、`docs/背景上下文.md`。
- agent-browser 官方插件文档和本地 `agent-browser 0.31.1` help 输出。

输出:

- 一个共享架构任务文档。
- 两个下游实现任务文档。
- 对协议冲突和组合限制的明确风险提示。

## 依赖项

- Node.js 运行环境。
- bun 作为构建器和脚本执行器。
- TypeScript。
- 本地已安装或可运行的 agent-browser CLI。
- macOS/Linux Chrome Profile 路径探测能力由 SUO-111 后续实现负责。

## 测试策略

1. 文档级校验:
   - `docs/task/` 下存在 requirement prompt 和三个任务文档。
   - 每个任务文档包含必需章节。
   - SUO-110、SUO-111、SUO-112 均可在文档中检索。

2. 后续实现级校验:
   - 每个插件包执行 `bun install` 和 `bun run build` 成功。
   - 每个插件可用 `node dist/index.js` 通过 stdin 输入测试 `plugin.manifest`。
   - `agent-browser plugin list` 能读取本地配置。
   - provider 与 stealth 分别跑最小端到端命令。

## 完成标志

- `docs/task/TASK-REQUIREMENT-FORMAT.md` 已填充 SUO-110 输入。
- `docs/task/task_110_backend_agent_browser_plugin_system.md` 已生成。
- `docs/task/task_111_backend_userprofile_browser_provider.md` 已生成。
- `docs/task/task_112_backend_stealth_launch_mutator.md` 已生成。
- 文档明确了官方协议、下游任务映射、构建方式、配置目标和风险。

## 风险提示

- 当前工作区没有标准 `docs/design/` 和 `docs/issue/` 输入目录；本任务使用 Paperclip Issue 描述和现有 `docs/*.md` 补足上下文。
- 下游 Issue 中的 NDJSON/id 协议描述与官方文档当前的单 JSON envelope 不一致，后续实现应以 `agent-browser.plugin.v1` 为主。
- `browser.provider` 返回 `user-data-dir` / `profile-directory` 不是官方文档中的标准 provider 响应字段；如需保留这些信息，应放入 `browser.metadata`，核心连接仍返回 `browser.cdpUrl`。
- `launch.mutate` 不会自动修改 provider/CDP 已启动的浏览器；同时需要 Profile 和 stealth 时必须在实现路径中显式选择本地 launch 或 provider 内置 stealth 参数。
