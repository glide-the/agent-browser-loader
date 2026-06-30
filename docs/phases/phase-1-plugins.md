# 阶段总结：Phase 1 — agent-browser 插件系统实现

**周期：** 2026-06-29  
**目标任务：** SUO-109 完成目标任务  
**状态：** 完成 ✓

---

## 阶段目标

为 agent-browser 实现两个本地插件，解决在有反爬检测的网站（BOSS 直聘）上使用 AI 自动化时遇到的技术障碍：

- 无法复用已登录的 Chrome 用户 Profile
- CDP 连接导致 `navigator.webdriver` 特征暴露

---

## 完成的工作

### 技术实现

| 产物 | 类型 | 状态 |
|---|---|---|
| `agent-browser-plugin-userprofile-browser` | browser.provider 插件（rsync Profile + 拉起 Chrome 返回 cdpUrl） | ✓ 完成 |
| `agent-browser-plugin-stealth` | launch.mutate 插件（stealth 参数 + 从状态文件读取 Profile 参数） | ✓ 完成 |
| `agent-browser.json` | 插件注册表 | ✓ 更新 |
| `.agent-browser/userprofile.config.json` | 本地配置文件（替代环境变量，两插件共享） | ✓ 完成 |

### 文档沉淀（本阶段补充）

| 文档 | 路径 | 说明 |
|---|---|---|
| 架构设计 | `docs/design/architecture.md` | 整体架构、插件设计决策 |
| 协议规范 | `docs/design/plugin-protocol.md` | agent-browser.plugin.v1 完整规范 |
| 任务记录 | `docs/issues/SUO-109.md` | 执行过程、交付产物、经验教训 |
| 项目 README | `README.md` | 两个插件的使用说明（已有） |

---

## 技术决策记录

### 为什么用 ESM + NodeNext？

agent-browser 生态使用 ESM。`"type": "module"` + `moduleResolution: NodeNext` 确保在 Node 18+ 上无兼容性问题，同时 Bun 构建后的产物能被 `node` 直接执行。

### 为什么 stealth 插件不硬编码 User-Agent？

硬编码的 UA 会随时间过期（Chrome 版本更新），且必须与实际运行平台匹配。平台不匹配的 UA 反而会产生新的指纹异常。通过环境变量让调用方在运行时提供正确值。

### 为什么 userprofile 插件不删除 SingletonLock？

删除锁文件会导致正在运行的 Chrome 进程出现数据竞争，可能损坏 Profile 数据。userprofile-browser 插件在 rsync 时排除 `SingletonLock`/`LOCK`/journal/cache，既不读取、不删除、也不修复 Profile 锁文件，因此即使真实 Chrome 运行中也能安全拷贝。

### 为什么 userprofile 用 browser.provider 而非 launch.mutate？

重型 Profile rsync 若放在 `launch.mutate`，会阻塞每一次本地启动。改为 `browser.provider` 后，同步 + 启动每会话只发生一次，agent-browser 直接接管返回的 cdpUrl；且由于 provider 自己拉起 Chrome，扩展/Profile/参数都由 provider 直接控制，规避了 `--provider` 与 `--extension` 不能同用的限制。

- **userprofile-browser（browser.provider）**：`browser.launch` 完成 rsync（状态文件存在则跳过，`force:true` 重同步）+ spawn Chrome + 返回 cdpUrl；`browser.close` 按 sessionId 终止 Chrome。活 Chrome 进程记录在会话注册表。
- **stealth（launch.mutate）**：本地 launch 路径上从状态文件读取，追加 `--user-data-dir` / `--profile-directory`，不执行 rsync。

### 为什么配置改为本地文件而非环境变量？

agent-browser 以子进程方式拉起插件，环境变量无法可靠传入子进程。Profile 相关配置改为读取本地文件 `<cwd>/.agent-browser/userprofile.config.json`（两个插件共享，字段 `userDataDir`/`profileDirectory`/`debugDir`/`statePath`）。`AGENT_BROWSER_USERPROFILE_*` 环境变量仅作兜底。

---

## 已知局限与后续方向

### 当前局限

1. **Profile 复用通过 browser.provider** — `--provider userprofile-browser` 一次性同步 + 拉起 Chrome 返回 cdpUrl；stealth（launch.mutate）仅用于本地 launch 回退路径
2. **没有实测验证** — 插件协议通过 JSON 测试，但未在实际 BOSS 直聘场景中端到端验证效果
3. **验证码问题未解决** — BOSS 直聘除反爬外还有 CAPTCHA，CapSolver 扩展需要 API Key，未集成

### 后续方向（如需继续）

- [ ] 验证 userprofile-browser 插件在真实 BOSS 直聘场景下的效果
- [ ] 验证 userprofile-browser（browser.provider 拉起 Chrome）驱动登录 Profile 在真实站点的效果
- [ ] 集成 CapSolver 扩展（需要配置 API Key）

---

## 指标

| 指标 | 值 |
|---|---|
| 实现的插件数 | 2 |
| 协议测试用例 | manifest、launch.mutate、browser.provider（browser.launch/close、CDP 端到端）、错误处理 |
| TypeScript 源码行数 | 随插件迭代变化，以当前源码为准 |
| 构建方式 | Bun bundle → single dist/index.js |
| 遗留 blocked issues | 5（其他 Agent 权限边界内，无法由 CEO 关闭） |
