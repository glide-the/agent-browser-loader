# TASK-REQUIREMENT-FORMAT.md

> Prompt Template: filled for SUO-115. This is not the final task document.

Optimized Prompt:

你是 BackendTaskAgent，负责把 Paperclip Issue 转换为可执行、可验证、可排期的后端任务文档。请基于下面已经填充的 Issue 输入，输出一份 Markdown 后端任务文档，文档必须包含：任务标题、关联 Issue、任务目标、实现步骤、涉及文件路径、输入 / 输出说明、依赖项、测试策略、完成标志、风险提示。

## 1. Issue 基本信息

- Issue: SUO-115
- 标题: 实现 agent-browser-plugin-stealth 插件代码
- 优先级: medium
- 当前状态: in_progress
- 父任务: SUO-113 CEOOrchestrator：编排 agent-browser 插件实现流水线
- 祖先任务: SUO-109 完成目标任务
- 被阻塞任务: SUO-113 完成前依赖 SUO-115
- 标签: 原 Issue 未提供 labels；按领域归类为 backend, launch.mutate, plugin, stealth, chrome, typescript, bun, agent-browser。
- 当前工作目录: /Users/dmeck/agent-brower
- 插件工作目录: plugins/agent-browser-plugin-stealth/
- 输出目录: docs/task/
- 任务文档输出: docs/task/task_115_backend_stealth_plugin_code.md

## 2. 背景上下文

项目目标是在 agent-browser 插件系统下实现两个本地 TypeScript 插件包：

- agent-browser-plugin-userprofile-browser: 目标能力为 browser.provider，用于复用、启动或连接带用户 Chrome Profile 的本地 Chrome，并返回 agent-browser 可消费的 browser.cdpUrl。
- agent-browser-plugin-stealth: 目标能力为 launch.mutate，用于本地 Chrome 启动前追加 stealth 参数、扩展、init scripts 和 userAgent。

当前仓库中可用上下文文件：

- docs/当前目标.md: 用户要求参考 agent-browser 插件文档，先做架构设计，再实现 browser.provider 插件，然后实现 launch.mutate 插件。
- docs/当前问题.md: 记录 CDP 与 --extension 不能同时使用、本地 Chrome 启动方式、控制器/执行器、capabilities 抽象等背景。
- docs/背景上下文.md: 记录 BOSS 直聘反爬、Profile 复用、CapSolver 扩展、CDP 与 extension 冲突、stealth 注入方向。
- docs/task/task_110_backend_agent_browser_plugin_system.md: 已完成的插件系统架构与骨架规划。
- docs/task/task_112_backend_stealth_launch_mutator.md: SUO-115 的直接参考任务文档。
- agent-browser.json: 当前已有 `stealth` 条目，但仍指向 `npx -y agent-browser-plugin-stealth`。

标准输入目录 docs/design/ 与 docs/issue/ 在当前工作区不存在；本次任务文档以 Paperclip Issue 描述、已完成 SUO-110/SUO-112 任务文档、当前 docs/*.md 和现有 agent-browser.json 为输入来源，并在风险提示中记录该输入缺口。

## 3. 官方插件协议约束

参考 SUO-110 与 SUO-112 中已经确认的 agent-browser 插件架构，生成任务时必须采用以下约束：

- 插件是本地可执行进程。
- agent-browser 启动插件进程，通过 stdin 写入 JSON 请求，通过 stdout 读取 JSON 响应。
- 协议字段优先使用 protocol: agent-browser.plugin.v1。
- 请求 envelope 包含 protocol、type、capability、request。
- plugin.manifest 应返回插件 name、capabilities、description。
- launch.mutate 成功响应必须包含 launch 字段。
- launch 字段必须包含 args、extensions、initScripts、userAgent。
- stdout 只输出 JSON，不输出日志；调试日志只能写 stderr 或文件。
- 本任务还要求兼容 Issue 简化格式，并在响应中保留 id 字段。

## 4. SUO-115 需求字段

SUO-115 要求根据 docs/task/task_112_backend_stealth_launch_mutator.md 实现 agent-browser-plugin-stealth 插件完整代码：

- 创建 plugins/agent-browser-plugin-stealth/package.json。
- 创建 plugins/agent-browser-plugin-stealth/tsconfig.json。
- 创建 plugins/agent-browser-plugin-stealth/build.ts。
- 创建 plugins/agent-browser-plugin-stealth/src/index.ts。
- 运行 bun run build 确认 dist/index.js 生成成功。
- 更新 agent-browser.json，将现有 stealth npx 条目改为本地构建产物。
- manifest 请求必须返回 capabilities: ["launch.mutate"]。
- stdin/stdout 使用 agent-browser.plugin.v1 协议。
- plugin.manifest 返回 capabilities: ["launch.mutate"]。
- launch.mutate 返回包含 args、extensions、initScripts、userAgent 的成功响应。
- 默认 args 包含 --disable-blink-features=AutomationControlled。
- initScripts 隐藏 navigator.webdriver。
- stdout 只输出 JSON，日志写 stderr。
- 兼容官方 envelope 和 Issue 简化格式，并保留 id 字段。
- 完成后提交 commit，包含 Co-Authored-By: Paperclip <noreply@paperclip.ing>。

## 5. 协议与实现判断

任务文档必须显式说明：

- 实现应优先兼容官方 agent-browser.plugin.v1 协议，否则 agent-browser 0.31.1 可能无法消费该插件。
- Issue 简化格式仅作为兼容和脚本测试入口，不应覆盖官方 envelope。
- launch.mutate 只作用于 agent-browser 本地 launch，不会自动修改 --cdp、--auto-connect 或 browser.provider 已经启动好的浏览器。
- extensions 只能引用本地绝对路径；不存在或相对路径必须给出明确错误或 warning 策略。
- 不得把 CapSolver API key、cookie、token 或其他密钥写入 agent-browser.json、README 示例或 stdout。
- userAgent 默认值应保守；优先读取环境变量，避免硬编码过期或平台冲突的 UA。
- 任何 JSON parse error、unsupported type、配置错误和运行时异常都必须返回 JSON error，不能把错误栈写入 stdout。

## 6. 实现范围

需要规划的实现范围：

- 创建独立 npm 包: plugins/agent-browser-plugin-stealth/。
- 实现 package.json、tsconfig.json、build.ts、src/index.ts。
- 实现 stdin/stdout 协议入口和请求分发。
- 实现 plugin.manifest。
- 实现 launch.mutate 的 args 合并、extensions 解析、initScripts 生成和 userAgent 覆盖。
- 更新 agent-browser.json 的 stealth 本地插件配置。
- 更新 README 的使用说明、环境变量、协议示例、限制和安全风险。
- 运行 bun run build、manifest 协议测试和 launch.mutate 协议测试。
- 提交 commit。

不属于本任务文档的范围：

- 不实现 browser.provider 或 Chrome Profile 启动逻辑。
- 不实现验证码求解服务或 CapSolver API 调用。
- 不编写前端、Stage 排期或产品设计稿。
- 不承诺稳定绕过特定站点风控。
- BackendTaskAgent 本轮只产出 task 文档，不直接实现插件源码。

## 7. 关联路径

规划文档输出：

- docs/task/TASK-REQUIREMENT-FORMAT.md
- docs/task/task_115_backend_stealth_plugin_code.md

后续实现目标路径：

- plugins/agent-browser-plugin-stealth/package.json
- plugins/agent-browser-plugin-stealth/tsconfig.json
- plugins/agent-browser-plugin-stealth/build.ts
- plugins/agent-browser-plugin-stealth/src/index.ts
- plugins/agent-browser-plugin-stealth/dist/index.js
- agent-browser.json
- README.md

## 8. 验收条件

生成的后端任务文档必须满足：

- 与 SUO-115 映射清晰，并说明 docs/task/task_112_backend_stealth_launch_mutator.md 是直接参考文档。
- 明确 launch.mutate 的官方协议、输入输出和错误响应。
- 明确 official envelope 与 Issue 简化格式的兼容边界。
- 明确 args、extensions、initScripts、userAgent 的合并和默认策略。
- 明确 stdout/stderr 边界和 JSON error 策略。
- 明确 agent-browser.json 本地 stealth 配置。
- 明确后续实现需要运行 bun run build、manifest 测试、launch.mutate 测试并提交 commit。
- 包含实现步骤、涉及路径、输入 / 输出、依赖、测试策略、完成标志和风险提示。
- 明确 BackendTaskAgent 的职责边界：当前产物是任务文档，不是源码实现完成。

## 9. 输出要求

请输出 docs/task/task_115_backend_stealth_plugin_code.md，文档语言使用中文，路径保持相对项目根目录。除风险提示和边界说明外，不扩展到前端、Stage 排期或实际代码实现。
