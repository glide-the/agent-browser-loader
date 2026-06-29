# 任务标题

实现 agent-browser-plugin-stealth 的 launch.mutate 插件

## 关联 Issue

- 主关联 Issue: SUO-112 实现 launch.mutate 插件 (agent-browser-plugin-stealth)
- 架构依赖: SUO-110 架构设计：agent-browser 插件系统 (Node TS + bun)
- 父任务: SUO-109 完成目标任务
- 优先级: medium

## 任务目标

在 `plugins/agent-browser-plugin-stealth/` 下实现一个独立 TypeScript npm 包，使 agent-browser 在本地启动浏览器前可以调用 `launch.mutate` 插件追加 stealth 相关启动参数、扩展路径、init scripts 和 userAgent。

本插件只负责返回启动配置，不直接驱动页面、不处理验证码、不存储 API key、不绕过 provider/CDP 已经启动的浏览器。

## 实现步骤

1. 初始化包结构:
   - 创建 `plugins/agent-browser-plugin-stealth/package.json`。
   - 创建 `plugins/agent-browser-plugin-stealth/tsconfig.json`。
   - 创建 `plugins/agent-browser-plugin-stealth/build.ts`。
   - 创建 `plugins/agent-browser-plugin-stealth/src/index.ts`。

2. package.json 要求:
   - `name`: `agent-browser-plugin-stealth`
   - `version`: `0.1.0`
   - `type`: `module`
   - `main`: `dist/index.js`
   - `bin`: `{ "agent-browser-plugin-stealth": "./dist/index.js" }`
   - `scripts.build`: `bun run build.ts`

3. 实现通用协议入口:
   - 读取 stdin 全量 JSON。
   - 校验 `protocol === "agent-browser.plugin.v1"`。
   - 支持 `plugin.manifest` 和 `launch.mutate`。
   - 对 unsupported type 返回 JSON error。
   - stdout 只输出一个 JSON 响应。

4. 实现 `plugin.manifest`:
   - 返回 name: `stealth` 或 `agent-browser-plugin-stealth`。
   - capabilities: `["launch.mutate"]`。
   - description: 说明该插件追加本地 Chrome 启动 stealth 配置。

5. 实现 `launch.mutate` 响应:
   - 返回 `launch.args`，至少包含 `--disable-blink-features=AutomationControlled`。
   - 可按环境变量或配置追加 extensions，例如 CapSolver 扩展绝对路径。
   - 返回 `launch.initScripts`，用于在页面脚本前隐藏核心自动化特征。
   - 返回 `launch.userAgent`，默认可为空或由环境变量配置；避免硬编码过期 UA。

6. initScripts 设计:
   - 移除或隐藏 `navigator.webdriver`。
   - 补齐最小 `window.chrome.runtime` 形状。
   - 避免破坏 `navigator.plugins`、`navigator.languages` 等真实对象的可枚举性和原型链。
   - 脚本应尽量幂等，重复注入不抛错。
   - 不包含站点特定绕过逻辑。

7. 配置输入:
   - `AGENT_BROWSER_STEALTH_EXTENSION`: 可选，单个扩展绝对路径。
   - `AGENT_BROWSER_STEALTH_EXTENSIONS`: 可选，逗号分隔多个扩展绝对路径。
   - `AGENT_BROWSER_STEALTH_USER_AGENT`: 可选，自定义 UA。
   - `AGENT_BROWSER_STEALTH_ARGS`: 可选，逗号或换行分隔额外 Chrome args。

8. 更新 agent-browser.json:
   - 将现有 stealth 条目从 `npx -y agent-browser-plugin-stealth` 改为本地 node 执行。
   - 推荐保留配置名 `stealth`，便于 policy action `plugin:stealth:launch.mutate`。

目标条目:

```json
{
  "name": "stealth",
  "command": "node",
  "args": ["./plugins/agent-browser-plugin-stealth/dist/index.js"],
  "capabilities": ["launch.mutate"]
}
```

9. 更新 README:
   - 说明插件仅作用于本地 launch。
   - 说明不能与 CDP/provider 已启动浏览器自动叠加。
   - 说明扩展路径需要绝对路径，且 API key 不应写入 agent-browser.json。

## 涉及文件路径

- `plugins/agent-browser-plugin-stealth/package.json`
- `plugins/agent-browser-plugin-stealth/tsconfig.json`
- `plugins/agent-browser-plugin-stealth/build.ts`
- `plugins/agent-browser-plugin-stealth/src/index.ts`
- `agent-browser.json`
- `README.md`

## 输入 / 输出说明

输入请求:

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

成功输出:

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "launch": {
    "args": ["--disable-blink-features=AutomationControlled"],
    "extensions": ["/absolute/path/to/extension"],
    "initScripts": [
      "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
    ],
    "userAgent": "Mozilla/5.0 ..."
  }
}
```

manifest 输出:

```json
{
  "protocol": "agent-browser.plugin.v1",
  "success": true,
  "manifest": {
    "name": "stealth",
    "capabilities": ["launch.mutate"],
    "description": "Append local Chrome launch args, extensions, init scripts, and userAgent overrides."
  }
}
```

## 依赖项

- SUO-110 的架构约束。
- Node.js。
- bun。
- TypeScript。
- 本地 agent-browser CLI。
- 可选 Chrome 扩展目录，例如 CapSolver extension。

## 测试策略

1. 构建测试:
   - 在插件目录执行 `bun run build`。
   - 确认 `dist/index.js` 可由 node 执行。

2. 协议测试:
   - 输入 `plugin.manifest`，确认返回 capabilities。
   - 输入 `launch.mutate`，确认返回 `launch.args`、`launch.extensions`、`launch.initScripts`、`launch.userAgent`。
   - 输入 unsupported type，确认返回 `success: false`。

3. 配置测试:
   - 设置 `AGENT_BROWSER_STEALTH_EXTENSION` 为不存在路径，确认返回清晰错误或跳过策略符合 README。
   - 设置 `AGENT_BROWSER_STEALTH_USER_AGENT`，确认响应中使用该值。
   - 设置额外 args，确认去重并保持稳定顺序。

4. agent-browser 集成测试:
   - `agent-browser plugin show stealth`
   - `agent-browser open about:blank`
   - 如需验证脚本效果，可打开测试页后执行 `agent-browser eval "navigator.webdriver"`，期望返回 undefined 或等价隐藏结果。

## 完成标志

- 插件包目录完整。
- `bun run build` 成功。
- `plugin.manifest` 和 `launch.mutate` 都有协议处理。
- `agent-browser.json` 的 stealth 条目指向本地 `node ./plugins/agent-browser-plugin-stealth/dist/index.js`。
- README 记录环境变量、协议示例、扩展配置和 provider/CDP 限制。
- 完成后按 SUO-112 要求提交 commit。

## 风险提示

- `launch.mutate` 只对本地 agent-browser launch 生效，不对 `--cdp`、`--auto-connect` 或 `--provider` 已启动浏览器生效。
- 反检测脚本可能随网站策略变化失效，不应承诺稳定绕过特定站点风控。
- 第三方验证码扩展依赖外部 API key，密钥不能写入 agent-browser.json 或提交到仓库。
- 过度修改 navigator 对象可能破坏页面正常功能，应保持最小、可配置、可回滚。
