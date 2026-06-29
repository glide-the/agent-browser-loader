# TASK-REQUIREMENT-FORMAT.md

> Prompt Template: filled for SUO-110. This is not the final task document.

Optimized Prompt:

你是 BackendTaskAgent，负责把 Paperclip Issue 转换为可执行、可验证、可排期的后端任务文档。请基于下面已经填充的 Issue 输入，输出 Markdown 后端任务文档，文档必须包含：任务标题、关联 Issue、任务目标、实现步骤、涉及文件路径、输入 / 输出说明、依赖项、测试策略、完成标志、风险提示。

## 1. Issue 基本信息

- Issue: SUO-110
- 标题: 架构设计：agent-browser 插件系统 (Node TS + bun)
- 优先级: medium
- 状态: in_progress
- 父任务: SUO-109 完成目标任务
- 下游阻塞任务:
  - SUO-111 实现 browser.provider 插件 (agent-browser-plugin-userprofile-browser)
  - SUO-112 实现 launch.mutate 插件 (agent-browser-plugin-stealth)
- 标签: 原 Issue 未提供 labels；按领域归类为 backend, plugin-system, typescript, bun, agent-browser。
- 当前工作目录: /Users/dmeck/agent-brower
- 输出目录: docs/task/

## 2. 背景上下文

项目目标是在 agent-browser 的插件系统下设计两个本地 TypeScript 插件包，运行环境为 Node.js，打包器使用 bun：

- agent-browser-plugin-userprofile-browser: 目标能力为 browser.provider，用于用户 Chrome Profile / 本地浏览器提供能力。
- agent-browser-plugin-stealth: 目标能力为 launch.mutate，用于在本地 Chrome 启动前追加 stealth 参数、扩展、init scripts 和 userAgent。

当前仓库中可用上下文文件:

- docs/当前目标.md: 用户要求先做架构设计，再实现 browser.provider 插件，然后实现 launch.mutate 插件。
- docs/当前问题.md: 记录 CDP 与 --extension 不能同时使用、本地 Chrome 启动方式、控制器/执行器、capabilities 抽象等背景。
- docs/背景上下文.md: 记录 BOSS 直聘反爬、Profile 复用、CapSolver 扩展、CDP 与 extension 冲突、stealth 注入方向。
- agent-browser.json: 当前已有远程/示例插件配置，其中 stealth 仍为 npx agent-browser-plugin-stealth。

标准输入目录 docs/design/ 与 docs/issue/ 在当前工作区不存在；本次任务文档以 Paperclip Issue 描述、下游 Issue 描述和当前 docs/*.md 为输入来源，并在风险提示中记录该输入缺口。

## 3. 官方插件协议约束

参考 agent-browser 官方插件文档 https://agent-browser.dev/plugins 和本地 agent-browser 0.31.1 help 输出，生成任务时必须采用以下约束:

- 插件是本地可执行进程。
- agent-browser 启动插件进程，通过 stdin 写入一个 JSON 请求，通过 stdout 读取一个 JSON 响应。
- 协议字段使用 protocol: agent-browser.plugin.v1。
- 请求 envelope 包含 protocol、type、capability、request。
- 成功响应包含 protocol 和 success: true，并按能力返回 manifest、browser、launch 或 data 字段。
- plugin.manifest 应返回插件 name、capabilities、description。
- stdout 只输出 JSON，不输出日志；调试日志只能写 stderr 或文件。
- browser.provider 官方响应字段是 browser，典型内容为 cdpUrl、directPage、metadata、cleanup。
- launch.mutate 官方响应字段是 launch，典型内容为 args、extensions、initScripts、userAgent。
- launch.mutate 只作用于本地启动；对 CDP 连接或远端/外部 browser.provider 已经启动好的浏览器不会再运行。

## 4. 需求澄清与架构判断

下游 Issue SUO-111 中的示例协议写成 NDJSON/id，并要求 browser.user-data-dir 与 browser.profile-directory；这与官方文档当前的 agent-browser.plugin.v1 envelope 和 browser.provider 返回 cdpUrl 的模型不完全一致。任务文档必须显式说明:

- 实现应优先兼容官方 agent-browser.plugin.v1 协议。
- 如果需要 browser.provider 复用真实用户 Profile，推荐让 provider 负责启动或连接一个 Chrome，并返回官方 browser.cdpUrl；Profile 路径、profileDirectory 等信息放入 browser.metadata。
- 如果目标是同时复用 Profile 并应用 stealth，优先考虑 agent-browser 内置 --profile 或 launch args 加 launch.mutate，因为 launch.mutate 不会修改 browser.provider 或 CDP 已经启动的浏览器。
- 若产品坚持 --provider 路径也必须 stealth，则 stealth 参数应并入 provider 启动 Chrome 的参数，不能依赖独立 launch.mutate 插件自动叠加。

## 5. 关联路径

规划文档输出:

- docs/task/task_110_backend_agent_browser_plugin_system.md
- docs/task/task_111_backend_userprofile_browser_provider.md
- docs/task/task_112_backend_stealth_launch_mutator.md

后续实现建议路径:

- plugins/agent-browser-plugin-userprofile-browser/package.json
- plugins/agent-browser-plugin-userprofile-browser/tsconfig.json
- plugins/agent-browser-plugin-userprofile-browser/build.ts
- plugins/agent-browser-plugin-userprofile-browser/src/index.ts
- plugins/agent-browser-plugin-stealth/package.json
- plugins/agent-browser-plugin-stealth/tsconfig.json
- plugins/agent-browser-plugin-stealth/build.ts
- plugins/agent-browser-plugin-stealth/src/index.ts
- agent-browser.json
- README.md

## 6. 验收条件

生成的后端任务文档必须满足:

- 与 SUO-110、SUO-111、SUO-112 映射清晰。
- 不要求本阶段实现代码或提交 commit；代码提交属于后续实现任务。
- 每个文档都有实现步骤、涉及路径、输入 / 输出、依赖、测试策略、完成标志和风险提示。
- 明确 Node.js + TypeScript + bun 构建方式。
- 明确两个插件都是独立 npm 包，可本地运行。
- 明确 agent-browser.json 本地 node 执行配置的目标形状。
- 明确 browser.provider 与 launch.mutate 的组合限制。

## 7. 输出要求

请输出三个 Markdown 任务文档:

1. task_110_backend_agent_browser_plugin_system.md: 共享架构与 monorepo 骨架任务。
2. task_111_backend_userprofile_browser_provider.md: browser.provider 插件实现任务。
3. task_112_backend_stealth_launch_mutator.md: launch.mutate 插件实现任务。

文档语言使用中文，路径保持相对项目根目录，除风险提示外不要扩展到前端、Stage 排期或实际代码实现。
