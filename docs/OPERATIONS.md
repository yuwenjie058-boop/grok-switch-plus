# 安装、验证与恢复

此版本供能管理自身 Box 环境的开发者试用。目标为 Node.js 20+ 的 Linux 宿主，默认程序路径 `/home/box/sand-host/host-main.cjs`，默认配置目录 `/workspace/grok-switch`。这是接口约定，不代表所有 Grok Bot 版本都符合。环境变量 `GROK_SWITCH_HOST`、`GROK_SWITCH_DIR` 和 `GROK_SWITCH_SUPERVISOR_DIR` 可覆盖测试/部署路径；不能靠改路径把不兼容宿主变成兼容宿主。

## 安装前

从发行页下载时，应使用同一版本的构建文件与校验清单，核对 `grok-switch.cjs` 的 SHA256。PLUS 构建已经包含切换器、CLI 和面板，无需另外安装上游项目。

1. 确认消息确实到达 Box；平台 Temporal 会话的迁移另见 `MIGRATION.md`。
2. 保存宿主原始文件及哈希、现有供应商配置、运行目录和恢复方法。备份放在仓库之外。
3. 等待活跃任务结束，避免同时由旧守护、官方更新或另一个补丁工具写入宿主。
4. 在独立克隆中运行 `npm test`。把构建后的 `dist/grok-switch.cjs` 复制到目标 Box 的 `/workspace/grok-switch/grok-switch.cjs`，不要用上游下载链接替换 Plus 构建。

先运行 `node /workspace/grok-switch/grok-switch.cjs preflight --json`。退出码 0 仅代表当前文件的静态结构通过，退出码 2 表示阻断；检查范围与版本证据见 [兼容表](COMPATIBILITY.md)。

## 安装与供应商

在目标 Box 执行：

```sh
node /workspace/grok-switch/grok-switch.cjs install
```

它会检查结构、保存原始宿主、打补丁并申请一次重启，同时启动仅监听本机的面板。在 Box 的浏览器中打开输出的面板地址，用自己的 API 地址、模型和 key 配置供应商。不要公开面板端口。

也可通过 `--key-file` 提供私有文件；避免明文 `--key` 被终端历史保留。CLI 完整选项见 `help`。推荐先使用供应商 API key；本版没有针对继承的 Codex 设备认证路径新增真实账号验收。

## 从上游或旧版 PLUS 更新

PLUS 沿用 `grok-switch.cjs`、`/workspace/grok-switch`、配置字段和宿主补丁标记。版本号属于独立发布线，`0.1.0-alpha.3` 不是上游 `0.8.5` 的降级；更新检查比较具体补丁内容，而非把两个项目的版本号当作同一序列。

1. 记录正在运行的版本、守护启用状态和启动方式，等待任务空闲。备份旧切换器、宿主原文件及当前文件、供应商配置和整个私有运行目录。
2. 暂停旧版本的守护和外部自动启动机制，停止旧面板（支持时执行旧文件的 `ui stop`），确认没有其他工具在同时写入宿主。只关闭浏览器页面不会停止面板服务。
3. 将校验过的 PLUS 文件先放到单独的暂存目录，对现有宿主运行 `node /path/to/staged/grok-switch.cjs preflight --json`。若已有补丁损坏或结构不匹配，先排查或按备份恢复，不要强行覆盖。
4. 预检通过后，用 PLUS 文件替换部署目录中的旧切换器，保留配置、账本和原始宿主备份。运行该文件的 `install`，更新已识别的补丁并启动新面板；在输出提示的空闲重启完成后验收。
5. 按下节确认供应商、客户端往返和运行版本，再按原先的部署方式恢复需要的守护进程。确保它启动的是新文件，且只有一个写入方。

带有额外第三方修改或无法识别补丁的部署不保证直接更新。上述步骤不会自动迁移平台会话、桌面客户端或定时任务的所有权。

alpha.3 保留工具的 `strict` 设置；Responses 默认 `strict: false`。Shell、Read、AwaitShell 的 `machineId` 若已填写但为空或非字符串，会阻止调用。云端执行应省略该字段；指定本机应使用已注册的机器 ID。不会把无效目标悄悄改成另一台机器。

## 验证顺序

```sh
node /workspace/grok-switch/grok-switch.cjs status --json
node /workspace/grok-switch/grok-switch.cjs test PROVIDER_NAME --json
node /workspace/grok-switch/grok-switch.cjs log 5
```

供应商测试成功只证明接口连通。还需要在真实客户端发一条无副作用消息，确认 Box 收到、供应商实际响应、客户端显示回复。核对运行进程加载的补丁版本与收据，不能只检查磁盘文件。切换身份路由后可能需要完整重启客户端以刷新内存中的 roster/harness 状态。

## 可选上下文处理

示例片段在 `examples/context-settings.json`，需要合并到现有私有配置，不能覆盖其中的供应商信息。先保持关闭，观察后使用 dry-run，再单独决定是否 apply。

折叠处理的是大型工具结果，不是用户对话的通用语义摘要。账本维持已发送内容的形态，原文保存在运行目录 `ctx-cache/` 中。不要在活跃会话中随意清空缓存或账本，也不要把它们上传。`freshHeadChars`/`freshTailChars` 决定保留的首尾；旧 `keepHeadChars`/`keepTailChars` 不再控制裁剪。

有限账本的淘汰和存储异常可能改变形态。alpha.2 的写入锁、文件/目录刷盘，以及异常恢复步骤见 [可靠性说明](RELIABILITY.md)。

## 可选守护

安装和实际请求验证后，再按需启用：

```sh
node /workspace/grok-switch/grok-switch.cjs watchdog enable
node /workspace/grok-switch/grok-switch.cjs watchdog run
```

`run` 运行观察进程，`enable` 才允许修复。发行目录的启动脚本和 `.desktop` 文件是 Linux XDG 模板，需由部署者放到自己的启动机制中；它们不是完整服务管理器，不保证无桌面启动或崩溃自恢复。

守护只处理满足检查的更新。忙碌、版本结构变化、并发写入、运行收据不匹配或持续请求失败都应查看 `watchdog status` 和日志。失败锁定后先定位原因，不能通过反复 enable 隐藏异常。新 PID、匹配收据以及实际请求证据分别说明不同层面的状态。

## 停用与恢复

```sh
node /workspace/grok-switch/grok-switch.cjs watchdog disable
node /workspace/grok-switch/grok-switch.cjs official
```

`official` 切回官方推理但保留配置。要移除宿主补丁，在确认空闲、备份有效后执行 `restore`；它会恢复并申请重启。切回推理供应商不会自动撤销外部的身份、客户端路由或调度变更，这些必须按各自的迁移记录恢复。

恢复后再次确认进程与客户端消息闭环。禁止将“命令退出成功”当成全链路恢复证明。
