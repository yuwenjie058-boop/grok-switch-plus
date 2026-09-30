# 兼容性与证据等级

适用发布：`0.1.0-alpha.2`。这里区分“开发环境测试”“宿主静态结构检查”和“真实客户端往返”，避免把一个层面的通过当成全部兼容。

| 环境 / 合同 | 支持范围 | 验证方式 |
| --- | --- | --- |
| Windows + Node.js 20、22 | 构建、离线演示、预检、合成回归 | GitHub Actions 矩阵；不代表支持桌面端安装 |
| Linux + Node.js 20、22 | 同上，额外覆盖目录刷盘失败 | GitHub Actions 矩阵 |
| Node.js 24（Windows） | 本地开发验证 | 维护者本地测试；未加入 CI 矩阵 |
| Linux Box，包含唯一推理工厂及所需 Prompt 接口 | 可能满足基础注入合同 | `preflight` 检查当前文件，不按版本名称猜测 |
| 含 `FileTranscriptMirror` 的宿主 | 必须满足特定 journal 比较、UserMessage 时间字段及解码接口 | 合成 journal 回归 + 当前文件预检 |
| 含 `createSendMessageTool2` 的宿主 | 必须满足三个 terminal hook 锚点 | 合成 hook 回归 + 当前文件预检 |
| Windows 桌面客户端 / 平台 Temporal 会话 | 本仓库安装器不负责迁移 | 参见迁移设计；不能靠一次 preflight 宣称兼容 |
| 其他 Node 版本、未知宿主结构、未来官方更新 | 未认证 | 需新增复现和版本适配 |

**公开 alpha.2 的真实宿主版本验收列表目前为空。** 私有部署中使用过相关内部构建，但不能据此给这个新发布认证某个官方客户端/宿主版本。桌面客户端版本号也不能替代 Box 内的宿主版本与文件哈希。

## 先判断当前文件

无账号体验：

```sh
npm run preflight -- examples/synthetic-host.cjs --json
```

分析你有权访问的宿主文件副本：

```sh
node dist/grok-switch.cjs preflight /absolute/path/to/host-main.cjs --json
```

在目标 Linux Box 上，可省略路径，使用默认宿主路径或 `GROK_SWITCH_HOST`。它只读取宿主和自身程序，在内存中生成候选并通过 stdin 检查语法。不会执行宿主、读取供应商配置、创建备份、调用 API、更新守护或申请重启。

- 退出码 **0**：静态结构通过，`eligible: true`，仍须实际运行验收。
- 退出码 **2**：已完成预检但被阻断，查看 `checks` 中失败的阶段。
- 退出码 **1**：命令参数等其他 CLI 错误。
- `runtimeVerified` 始终为 `false`，预检没有做真实运行验证。

失败阶段：`host_snapshot`（缺失、非普通文件或读取中变化）、`patch_integrity`（已有补丁不完整）、`host_contract`（必要结构不匹配）、`candidate_syntax`（候选语法无效或检查超时）。为防止泄露源码，JSON 不输出宿主内容或解析器引用的源代码。

一次预检是某个时刻的快照。官方更新后需要重跑，安装器也会在写入前再次检查。它不检测供应商额度、消息路由、活跃任务、所有自定义补丁冲突或业务任务结果。

## 如何增加真实兼容记录

提交 Plus 版本、Node/OS、官方宿主版本（若能读取）、宿主文件 SHA256、预检结果，以及经过脱敏的真实客户端往返和工具调用结果。声明是否测试恢复与更新路径。不要上传原宿主、配置、对话或私有网络信息。

维护者复现后再增加“真实运行已验证”记录。单独报告安装命令成功或 HTTP 200 不足以认证。
