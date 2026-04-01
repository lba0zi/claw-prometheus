# OpenClaw Agent Harness Modules

> 从某 AI Coding 产品源码泄露中提炼的 AI Agent 核心基础设施。

## 架构概览

```
用户输入
    ↓
prompt-router    ← 智能路由：匹配 Command 或 Tool
    ↓
ToolPermissionContext  ← 权限检查
    ↓
BashSecurity    ← 安全分析（PowerShell 专用）
    ↓
TurnResult       ← 执行 + 结构化结果
    ↓
SessionCompactor ← 超过阈值自动压缩
    ↓
PermissionDenialLogger ← 拒绝审计
    ↓
SessionBranching ← 分叉 / 合并（可选）
```

## 模块清单

| 模块 | 语言 | 功能 | 优先级 |
|------|------|------|--------|
| `tool-permissions` | TypeScript | 工具权限拒绝追踪 | P0 |
| `session-compactor` | TypeScript | 多轮对话自动压缩 | P0 |
| `turn-result` | TypeScript | 结构化执行结果 | P0 |
| `prompt-router` | TypeScript | 智能路由 | P1 |
| `bash-security` | TypeScript | PowerShell 多层安全 | P1 |
| `session-branching` | TypeScript | 会话分叉与合并 | P2 |
| `permission-denial-log` | TypeScript | 拒绝日志审计 | P1 |

## 快速开始

```typescript
import { ToolPermissionContext } from './modules/tool-permissions';
import { SessionCompactor } from './modules/session-compactor';
import { PromptRouter } from './modules/prompt-router';

// 1. 权限上下文
const ctx = ToolPermissionContext.fromDenyList(['BashTool', 'PowerShellTool']);
console.log(ctx.blocks('BashTool')); // true

// 2. 会话压缩
const compactor = new SessionCompactor({ compact_after_turns: 12 });
if (compactor.shouldCompact(15)) {
  const result = compactor.summarizeOldMessages(history);
  // result.kept 保留最近消息，result.summary 是压缩摘要
}

// 3. 路由
const router = new PromptRouter();
router.registerCommand('commit', ['git', 'commit', '提交'], handler);
router.registerTool('BashTool', ['bash', 'shell', '终端'], handler);
const matches = router.route('帮我 git commit');
```

## 数据存储

模块使用 `C:\Users\Surface\.openclaw\workspace-main\.openclaw\` 目录：

```
.openclaw/
├── branches/          # 会话分叉元数据
│   └── {branch_id}.json
└── denial-log.jsonl   # 拒绝日志（JSONL，每行一条）
```

## 与 OpenClaw Gateway 的集成点

| OpenClaw 概念 | 对应模块 | 集成方式 |
|--------------|---------|---------|
| `exec` 工具 | `bash-security` | 执行前调用 `analyzeCommand()` |
| 子 agent | `tool-permissions` | 每次 `sessions_spawn` 前检查 |
| 会话历史 | `session-compactor` | 每轮结束调用 `shouldCompact()` |
| 路由决策 | `prompt-router` | 消息入口处调用 `route()` |
| 执行结果 | `turn-result` | subagent 返回时用 `createTurnResult()` 封装 |
| 分叉探索 | `session-branching` | 用户要求"同时做 A 和 B"时触发 |
| 安全审计 | `permission-denial-log` | `blocks()` 返回 true 时记录 |
