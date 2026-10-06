# Grok Switch Plus

**面向 Grok Bot 的持续维护模型切换器，集成宿主适配、工具调用修复、上下文管理与运行恢复。**

**当前候选 `0.1.0-alpha.5`（预发布）** · [下载已发布版本](https://github.com/yuwenjie058-boop/grok-switch-plus/releases) · [English](README.en.md) · [兼容性](docs/COMPATIBILITY.md) · [安装与恢复](docs/OPERATIONS.md)

Grok Switch Plus 让兼容 Linux Box 中的 Grok Bot 使用你配置的模型 API，并围绕连续工具执行、长对话和宿主更新提供配套能力。下载一个构建文件即可使用完整的切换器、命令行和配置面板，无需先安装上游项目。

PLUS 基于 [enderzcx/grok-bot-switch](https://github.com/enderzcx/grok-bot-switch) 独立维护和发布，继承其协议路由与配置能力，继续发展宿主适配与稳定性改进。沿用 MIT 许可并保留原作者署名；它是社区项目，不隶属于 xAI、X 或 Grok Bot 官方。

## PLUS 提供什么

| 能力 | 现在可以做什么 |
| --- | --- |
| 模型与供应商切换 | 使用配置面板或 CLI 管理供应商，支持 OpenAI Chat Completions、Responses 和 Anthropic Messages；可切回官方推理 |
| 宿主适配 | 包含 journal 与工具 hook 的适配逻辑；只读预检和安装器检查当前宿主结构 |
| 连续工具执行 | 修复流式参数交付、图片历史与成功轮询误判；校验执行机器目标，避免无效参数被派发 |
| 长对话管理 | 传递模型容量元数据；可选工具输出裁剪，保存原文并重放既有形态 |
| 更新与恢复 | 提供备份、维护锁、运行版本收据及可选更新守护，帮助发现磁盘补丁与运行进程不一致 |
| 可验证的交付 | 完整源码、单文件构建、离线演示；核心 CI 配置覆盖 Linux/Windows × Node 20/22/24 |

**alpha.5 候选** 为可选桌面路由工具增加 Windows `0.66.0` 精确结构适配，保留 `0.57.1`。新增原生工厂摘要校验和完整接线健康检查，保留原生 automation 契约；只读检查的 `runtimeVerified` 仍为 `false`。本机真实 `0.66.0` 安装包的候选生成、582 个 packed 条目验证及两个 CJS 语法检查通过，尚未完成该公开构建的真实登录与消息往返认证。此前上下文重放修复和上游 0.8.5 修复继续保留。详见 [兼容证据](docs/COMPATIBILITY.md)、[更新记录](CHANGELOG.md)、[代码结构](docs/ARCHITECTURE.md) 和 [来源记录](UPSTREAM.md)。

新版宿主适配是 PLUS 的维护重点。当前代码包含针对后续宿主结构变化的适配，但公开版本的真实宿主验收记录仍待补齐；请按 [兼容表](docs/COMPATIBILITY.md) 核对自己的环境。稳定性改进对应具体修复和回归测试，不代表所有版本、模型和任务都已验收。

## 开始使用

1. 从 [Releases](https://github.com/yuwenjie058-boop/grok-switch-plus/releases) 下载 `grok-switch.cjs` 和对应校验文件，或克隆本仓库自行构建。
2. 在你管理的 Linux Box 上，按 [安装与恢复](docs/OPERATIONS.md) 备份、运行 `preflight` 并安装 PLUS。
3. 在配置面板设置供应商，验证 API 连通，再确认真实客户端能收发消息和调用工具。

已有上游版本的用户可直接采用 PLUS 构建更新，具体步骤见 [从上游或旧版 PLUS 更新](docs/OPERATIONS.md#从上游或旧版-plus-更新)。已有命令、配置目录和补丁标记继续沿用，升级前仍需备份和结构检查。

## 我们跨过了哪些阻碍

能切换模型之后，还需要让工具连续执行、长对话保持稳定，并在宿主更新或执行位置改变时知道故障发生在哪一层。这是 Plus 的工作重点，适用于不同员工身份和兼容的模型供应商。

| 使用中遇到的问题 | Plus 的处理方式 | 可以复用的部分 |
| --- | --- | --- |
| 反复查询进度、截图时被当作死循环；并行工具收到不完整参数 | 区分成功重复与连续失败；按工具交付完整参数 | 协议适配器、流式回归测试 |
| 截图和工具历史换协议后顺序或格式不对 | 按协议转换工具结果、图片与不可表达的历史内容 | 三协议转换与降级测试 |
| 大型工具输出持续挤占上下文；重复改写历史影响缓存稳定性 | 首次发送时裁剪，落盘原文和账本，后续重放固定形态 | v4.1 上下文模块、存储故障测试 |
| 模型容量没有传到宿主，宿主无法使用正确的摘要阈值 | 显式上报经过核实的容量元数据 | 与供应商配置同级的容量字段 |
| 官方更新覆盖补丁；磁盘已修复但旧进程仍在运行 | 兼容性和空闲检查、备份、运行收据及请求验证 | 守护状态机、并发与恢复测试 |
| 换完模型/执行位置后员工不回消息，任务可能由两边调度 | 分开核对身份、历史、客户端路由与唯一调度方 | 迁移方法；独立实验性调度核心 |

详见 **[阻碍、解法与验证证据](docs/OBSTACLES.md)**。这些改进来自旧版基线和后续运行环境中的实际障碍；部分由宿主变化引入。对比范围及已纳入的上游修复见 [UPSTREAM.md](UPSTREAM.md)。

## 十分钟内看到效果

核心构建与测试使用 Node.js 20+，无需安装第三方 npm 依赖：

```sh
git clone https://github.com/yuwenjie058-boop/grok-switch-plus.git
cd grok-switch-plus
npm run demo
npm run preflight -- examples/synthetic-host.cjs --json
npm test
npm run test:cron
# 可选桌面工具回归，需要 Python 3.10+
npm run test:client
```

演示把同一份合成工具消息从约 **18.4 万字符缩到 1.29 万字符**，并实际检查重放一致、原文可恢复、账本写入失败时保留原输出。它不调用 API，临时数据自动清理；数字是字符量，不代表 token 费用或任务质量。详见 [演示说明](docs/DEMO.md)。

## 我的环境能不能用

先看 [兼容表和验收标准](docs/COMPATIBILITY.md)，再对你有权访问的宿主文件副本运行：

```sh
node dist/grok-switch.cjs preflight /absolute/path/to/host-main.cjs --json
```

预检只读文件和检查候选语法，不执行宿主、不读取供应商配置、不调用 API、不重启。退出码 0 表示静态结构通过，2 表示阻断；即便通过，`runtimeVerified` 仍为 false。它不代替真实客户端往返验收。

测试使用合成宿主和临时目录。构建产物是 `dist/grok-switch.cjs`；文件名和运行目录保留上游约定，避免破坏现有配置。

**安装目标是兼容的云端 Linux Box 宿主。** Windows 上能构建、测试，不代表可以直接给 Windows 桌面客户端安装这个文件。平台侧 Temporal 会话也不会因换推理供应商自动变成本地会话。请先阅读 [安装与恢复](docs/OPERATIONS.md)，确认路由与备份，再在目标 Box 中安装。

首次 `install` 会修改宿主并申请重启；测试通过不等于任意宿主版本兼容。仓库不分发官方客户端、`app.asar` 或宿主完整程序。

桌面重启后消息走错执行位置的恢复见 [可选客户端路由工具](experimental/client-routing/README.md)。目前支持明确校验的 Windows `0.57.1` / `0.66.0` 结构，需要 Python 3.10+，只生成并验证候选文件；不会自动部署、重启或替用户决定 Bot 归属。相同版本号但未知源结构也会拒绝。工具 CI 配置为 Linux/Windows × Node 20/24 × Python 3.10/3.12，仍属于预发布实验工具。

官方 Linux 客户端连接或登录保持问题见 [Linux 代理、证书与安全存储指南](docs/LINUX-CLIENT.md)。官方客户端登录及同会话重开实测，不等于 PLUS 的 Linux 桌面补丁支持或完整路由认证。

## 可选与实验功能

上下文裁剪、提前收尾防护默认关闭，更新守护需显式启用。账本刷盘、写入竞争、容量和恢复边界见 [可靠性说明](docs/RELIABILITY.md)。[客户端路由工具](experimental/client-routing/README.md)、[名单校验核心](experimental/ownership/README.md) 和 [本地调度核心](experimental/local-cron/README.md) 均需单独接入，不由默认安装器接管；[员工连续性迁移](docs/MIGRATION.md) 目前提供检查流程，尚无一键迁移器。

## 配置与边界

- DeepSeek 等兼容供应商通过 `openai-chat` 接入，模型名称、地址和容量以你的供应商为准。
- 使用本地配置面板或私有 key 文件输入凭据，不要把 key 放进聊天、命令历史或 Issue。
- `contextWindowTokens` 与供应商的 `model` 同级，必须是核实后的正整数；它不是输出长度限制。
- 上下文折叠是工具结果裁剪，不是模型生成摘要。原文缓存和诊断文件可能含业务内容，应保留在私有运行目录。
- 请求失败会报错，不承诺供应商可用性；代码不会把失败请求静默改投官方模型。
- 推理路由影响同一宿主中的相关 Bot，语音等平台能力不因此迁移。
- 保留了上游实验性 Codex 认证实现，但本次不把它作为推荐入门路径，也不承诺订阅资格或兼容性。

## 开发与贡献

`src/protocols/` 负责协议转换，`src/runtime.cjs` 负责注入与路由，`src/ctx-*` 负责上下文，`src/maintenance.cjs` 与 `src/watchdog.cjs` 负责恢复流程。`build.mjs` 将这些代码和上游配置面板合为单文件。

面板源码及其锁文件保留在 `panel/`；重新构建面板需在该目录执行 `npm ci` 和 `npm run build`，再回根目录构建。面板要求满足其 Vite 依赖的 Node 版本，建议使用 Node.js 22.12+。

欢迎提交脱敏的复现、合成测试和版本兼容修复。请先看 [贡献说明](CONTRIBUTING.md)、[安全说明](SECURITY.md)、[上游来源](UPSTREAM.md) 与 [更新说明](CHANGELOG.md)。优先事项是积累真实宿主兼容记录，以及把身份和迁移预检从文档进一步做成工具。

## 许可与致谢

[MIT](LICENSE)。保留 enderzcx 的原始版权声明。面板包含 CC Switch 的 MIT 代码及依赖声明，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
