# 十分钟体验：同一个输入，关闭与启用裁剪

无需账号、API key 或官方宿主，Node.js 20+ 即可：

```sh
npm run demo
npm run preflight -- examples/synthetic-host.cjs --json
```

演示直接运行 `src/ctx-compact.cjs`，不是提前写好的结果表。输入为脚本生成的对象工具结果；对照组是本引擎关闭裁剪时的原消息，不是对最新版上游的性能比较。

示例输出（临时目录长度不同，裁剪后的字符数会略有变化）：

```text
Serialized message characters: 184139 -> about 12900
Stable replay after settings change: PASS
Original output recoverable: PASS
Ledger failure preserves original output: PASS
Temporary data removed: PASS
```

它验证四件事：

1. 大字符串位于对象内部时仍可裁剪，非字符串字段保持原样。
2. 更改首尾保留长度后，已记录的结果仍按原形态重放。
3. 未裁剪原文可以从实际写入的缓存恢复。
4. 新结果的账本写入失败时，返回原输出，避免发出无法重放的新裁剪结果。

临时目录在退出前删除，不需要清理账号状态。`node scripts/demo.mjs --json` 可获取结构化结果。字符数不是 token 数、成本测量或质量评估；裁剪可能移除关键的中间信息，真实业务需要独立评估。

## 单独运行关键故障回归

```sh
npm run build
node --test tests/ctx-ledger-durability.test.mjs
node --test tests/chat-tool-image-order.test.mjs
node --test tests/runtime.test.mjs
```

其中 ledger 回归注入文件刷盘失败、竞争写入和损坏账本，Linux 上还注入目录刷盘失败。完整测试使用 `npm test`。与 API 连通测试及真实客户端验收的区别见 [兼容性](COMPATIBILITY.md)。
