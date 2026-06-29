# 任务标题

实现 agent-browser-plugin-stealth 的 launch.mutate 插件

## 关联 Issue

- 主关联 Issue: SUO-112 实现 launch.mutate 插件 (agent-browser-plugin-stealth)
- 架构依赖: SUO-110 架构设计：agent-browser 插件系统 (Node TS + bun)，当前状态 done
- 父任务: SUO-109 完成目标任务
- 优先级: medium

## 任务目标

在 `plugins/agent-browser-plugin-stealth/` 下实现一个独立 TypeScript npm 包，使 agent-browser 在本地启动浏览器前可以调用 `launch.mutate` 插件，追加或覆盖 stealth 相关启动参数、扩展路径、init scripts 和 userAgent。

本插件只负责返回启动配置，不直接驱动页面、不处理验证码、不存储 API key、不承诺绕过特定站点风控，也不会自动修改 CDP 或 browser.provider 已经启动好的浏览器。

## 实现步骤

1. 初始化插件包结构:
   - 创建 `plugins/agent-browser-plugin-stealth/package.json`。
   - 创建 `plugins/agent-browser-plugin-stealth/tsconfig.json`。
   - 创建 `plugins/agent-browser-plugin-stealth/build.ts`。
   - 创建 `plugins/agent-browser-plugin-stealth/src/index.ts`。

2. 配置 package.json:
   - `name`: `agent-browser-plugin-stealth`
   - `version`: `0.1.0`
   - `type`: `module`
   - `main`: `dist/index.js`
   - `bin`: `{ "agent-browser-plugin-stealth": "./dist/index.js" }`
   - `scripts.build`: `bun run build.ts`
   - 构建产物需要能通过 `node ./dist/index.js` 执行。

3. 实现 stdin/stdout 协议入口:
   - stdin 支持单个 JSON 请求，也支持换行分隔 NDJSON。
   - 每个有效请求输出一行 JSON 响应。
   - stdout 只能输出协议 JSON。
   - stderr 可输出日志、warning 和调试信息。
   - JSON parse error、unsupported type、配置错误都必须返回 JSON error，不得把异常栈写入 stdout。

4. 兼容两种请求格式:
   - 官方 envelope: `{ "protocol": "agent-browser.plugin.v1", "type": "launch.mutate", "capability": "launch.mutate", "request": { ... } }`。
   - Issue 简化格式: `{ "type": "launch.mutate", "id": "req-1", "launch": { "args": [] } }`。
   - 对官方 envelope 返回 `{ "protocol": "agent-browser.plugin.v1", "success": true, "launch": { ... } }`。
   - 对 Issue 简化格式返回 `{ "id": "req-1", "launch": { ... } }`，保留原始 `id`。

5. 实现 `plugin.manifest`:
   - 返回插件名称 `agent-browser-plugin-stealth` 或展示名 `stealth`。
   - 返回 `capabilities: ["launch.mutate"]`。
   - 描述该插件用于本地 Chrome launch 前追加 stealth args、extensions、initScripts 和 userAgent。

6. 实现 `launch.mutate` 的 args 合并:
   - 保留请求中已有的 `launch.args` 或 `request.args`。
   - 默认追加 `--disable-blink-features=AutomationControlled`。
   - 去重后保持稳定顺序，优先保留调用方已有参数。
   - `--no-sandbox` 不建议无条件默认开启；为满足 SUO-112 示例，应支持通过环境变量或显式配置启用，并在 README 标注安全风险。
   - 支持 `AGENT_BROWSER_STEALTH_ARGS`，允许用逗号或换行追加额外 Chrome args。

7. 实现 extensions 配置:
   - 默认返回 `extensions: []`。
   - 支持 `AGENT_BROWSER_STEALTH_EXTENSION` 传入单个扩展绝对路径。
   - 支持 `AGENT_BROWSER_STEALTH_EXTENSIONS` 传入多个扩展绝对路径，使用逗号或换行分隔。
   - 对不存在或非绝对路径的扩展给出明确 JSON error 或 stderr warning；具体策略需要在 README 固定，避免静默误配。
   - 不把 CapSolver API key 或其他密钥写入 `agent-browser.json`。

8. 实现 initScripts:
   - 返回 `initScripts` 字符串数组。
   - 至少包含隐藏 `navigator.webdriver` 的脚本。
   - 补齐最小 `window.chrome.runtime` 形状，避免页面直接检测为空。
   - 尽量隐藏常见自动化/CDP 痕迹，但只做通用最小覆盖，不写站点特定绕过逻辑。
   - 脚本必须幂等，重复注入不能抛错。
   - 避免破坏真实 `navigator.plugins`、`navigator.languages` 等对象的原型链、可枚举性和正常页面功能。

9. 实现 userAgent 策略:
   - 返回字段 `userAgent`，类型为字符串。
   - 优先读取 `AGENT_BROWSER_STEALTH_USER_AGENT`。
   - 未配置时可返回空字符串或项目选定的默认 UA；如果使用 SUO-112 示例中的 Chrome/120 UA，只能作为测试 fixture 或临时默认，并在 README 说明过期风险。
   - 不在代码中伪装成与实际平台明显冲突的 UA，避免制造新的指纹异常。

10. 更新 `agent-browser.json`:
    - 将现有 `stealth` 插件从 `npx -y agent-browser-plugin-stealth` 改成本地构建产物。
    - 推荐配置:

```json
{
  "name": "stealth",
  "command": "node",
  "args": ["./plugins/agent-browser-plugin-stealth/dist/index.js"],
  "capabilities": ["launch.mutate"]
}
```

11. 更新 README:
    - 说明插件只作用于 agent-browser 本地 launch。
    - 说明 CDP、`--auto-connect` 或 browser.provider 已启动浏览器不会自动叠加该 `launch.mutate`。
    - 说明环境变量: `AGENT_BROWSER_STEALTH_ARGS`、`AGENT_BROWSER_STEALTH_EXTENSION`、`AGENT_BROWSER_STEALTH_EXTENSIONS`、`AGENT_BROWSER_STEALTH_USER_AGENT`。
    - 说明扩展路径必须是本地绝对路径。
    - 说明 `--no-sandbox`、过期 UA、反检测脚本失效和第三方扩展密钥风险。

12. 构建与提交:
    - 在插件目录执行 `bun run build`。
    - 确认 `dist/index.js` 可由 `node` 执行。
    - 按 SUO-112 要求提交 commit。

## 涉及文件路径

- `plugins/agent-browser-plugin-stealth/package.json`
- `plugins/agent-browser-plugin-stealth/tsconfig.json`
- `plugins/agent-browser-plugin-stealth/build.ts`
- `plugins/agent-browser-plugin-stealth/src/index.ts`
- `agent-browser.json`
- `README.md`

## 输入 / 输出说明

官方 envelope 输入:

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

官方 envelope 成功输出:

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

Issue 简化格式输入:

```json
{
  "type": "launch.mutate",
  "id": "req-1",
  "launch": {
    "args": []
  }
}
```

Issue 简化格式成功输出:

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

manifest 输出:

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

错误输出要求:

- 官方 envelope 请求返回 `{ "protocol": "agent-browser.plugin.v1", "success": false, "error": { ... } }`。
- Issue 简化格式请求返回 `{ "id": "req-1", "error": { ... } }`。
- stdout 保持 JSON，一行一个响应。

## 依赖项

- SUO-110 的插件系统架构约束。
- Node.js。
- bun。
- TypeScript。
- 本地 agent-browser CLI。
- 可选 Chrome 扩展目录，例如 CapSolver Chrome extension。

## 测试策略

1. 构建测试:
   - 在 `plugins/agent-browser-plugin-stealth/` 执行 `bun run build`。
   - 确认 `dist/index.js` 存在并可由 `node ./dist/index.js` 执行。

2. manifest 协议测试:
   - 输入官方 `plugin.manifest` 请求。
   - 确认返回 `success: true` 和 `capabilities: ["launch.mutate"]`。

3. launch.mutate 官方 envelope 测试:
   - 输入官方 envelope 格式。
   - 确认返回 `launch.args`、`launch.extensions`、`launch.initScripts`、`launch.userAgent`。
   - 确认 args 包含 `--disable-blink-features=AutomationControlled`。

4. launch.mutate NDJSON/id 兼容测试:
   - 输入 SUO-112 Issue 示例格式。
   - 确认响应保留 `id`。
   - 输入多行 NDJSON，确认每行请求都有一行响应。

5. 配置测试:
   - 设置 `AGENT_BROWSER_STEALTH_ARGS`，确认额外参数被追加、去重且顺序稳定。
   - 设置 `AGENT_BROWSER_STEALTH_EXTENSION` 或 `AGENT_BROWSER_STEALTH_EXTENSIONS`，确认扩展路径进入 `launch.extensions`。
   - 设置不存在或相对扩展路径，确认错误或 warning 策略与 README 一致。
   - 设置 `AGENT_BROWSER_STEALTH_USER_AGENT`，确认响应使用该值。

6. 错误处理测试:
   - 输入非法 JSON，确认 stdout 返回 JSON error。
   - 输入 unsupported type，确认 stdout 返回 JSON error。
   - 确认 stderr 日志不会污染 stdout。

7. agent-browser 集成测试:
   - `agent-browser plugin show stealth` 或等价命令能读取本地插件。
   - `agent-browser open about:blank` 触发本地 launch 时能调用 `launch.mutate`。
   - 如需验证脚本效果，在页面内检查 `navigator.webdriver`，期望为 `undefined` 或等价隐藏结果。

## 完成标志

- 插件包目录完整。
- `bun run build` 成功。
- `plugin.manifest` 和 `launch.mutate` 都有协议处理。
- 官方 envelope 和 SUO-112 NDJSON/id 格式都被测试覆盖。
- 响应始终返回 `args`、`extensions`、`initScripts`、`userAgent` 四个字段。
- `agent-browser.json` 的 `stealth` 条目指向本地 `node ./plugins/agent-browser-plugin-stealth/dist/index.js`。
- README 记录环境变量、协议示例、扩展配置、provider/CDP 限制和安全风险。
- 完成后按 SUO-112 要求提交 commit。

## 风险提示

- 当前工作区没有标准 `docs/design/` 和 `docs/issue/` 输入目录；本任务文档使用 Paperclip Issue 描述、SUO-110 任务文档和现有 `docs/*.md` 补足上下文。
- `launch.mutate` 只对本地 agent-browser launch 生效，不对 `--cdp`、`--auto-connect` 或 `--provider` 已启动浏览器生效。
- SUO-112 的 NDJSON/id 示例与 SUO-110 记录的官方 envelope 不完全一致，后续实现需要双格式兼容。
- `--no-sandbox` 会降低浏览器沙箱安全性，除非目标运行环境明确需要，否则不应无条件默认开启。
- 反检测脚本可能随网站策略变化失效，不应承诺稳定绕过特定站点风控。
- 第三方验证码扩展依赖外部 API key，密钥不能写入 `agent-browser.json` 或提交到仓库。
- 过期或平台不匹配的 userAgent 会形成新的指纹异常，应优先通过环境变量配置。
- 过度修改 navigator 对象可能破坏页面正常功能，应保持最小、可配置、可回滚。
