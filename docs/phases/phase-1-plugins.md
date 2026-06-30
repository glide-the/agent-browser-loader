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
| `agent-browser-plugin-stealth` | launch.mutate 插件（含 Profile 参数注入，已合并 userprofile-browser） | ✓ 完成 |
| `agent-browser.json` | 插件注册表 | ✓ 更新 |

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

删除锁文件会导致正在运行的 Chrome 进程出现数据竞争，可能损坏 Profile 数据。当前 userprofile 插件只作为 `launch.mutate` 返回 Chrome 启动参数，不读取、不删除、不修复 Profile 锁文件。

### 为什么 userprofile 改为 launch.mutate？

`browser.provider` 通过 `--provider` 触发，会让 agent-browser 进入 provider 浏览器路径；该路径不能和 `--extension` 同用。userprofile 改为 `launch.mutate` 后，Profile 参数、stealth 参数和扩展都留在本地 launch 管线中。

---

## 已知局限与后续方向

### 当前局限

1. **Profile 复用依赖本地 launch** — 不再使用 `--provider agent-browser-plugin-userprofile-browser`；通过 `launch.mutate` 注入 Profile args
2. **没有实测验证** — 插件协议通过 JSON 测试，但未在实际 BOSS 直聘场景中端到端验证效果
3. **验证码问题未解决** — BOSS 直聘除反爬外还有 CAPTCHA，CapSolver 扩展需要 API Key，未集成

### 后续方向（如需继续）

- [ ] 验证 userprofile-browser 插件在真实 BOSS 直聘场景下的效果
- [ ] 验证 userprofile 与 stealth 两个 `launch.mutate` 插件同时启用时的真实站点效果
- [ ] 集成 CapSolver 扩展（需要配置 API Key）
- [ ] 考虑将 `--no-sandbox` 场景下的沙盒替代方案（Docker 容器隔离）

---

## 指标

| 指标 | 值 |
|---|---|
| 实现的插件数 | 2 |
| 协议测试用例 | manifest ×2、launch.mutate、错误处理 |
| TypeScript 源码行数 | 随插件迭代变化，以当前源码为准 |
| 构建方式 | Bun bundle → single dist/index.js |
| 遗留 blocked issues | 5（其他 Agent 权限边界内，无法由 CEO 关闭） |
