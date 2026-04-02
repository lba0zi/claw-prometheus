# claw-prometheus

> **普罗米修斯之火** — 盗取神火，照亮人间。

```
 _____ _          ___             _   
|_   _| |_  ___  / __|_  _ _ _   | |_
  | | | ' \/ -_) \__ \ || | ' \  |  _|
  |_| |_||_\___| |___/\_,_|_||_|  \__|
                   _  __
                  | |/ /___ _  _ _ __   ___
                  | ' </ -_) || | '_ \ / -_)
                  |_|\_\_|\_\\_, | .__/ \___|
                             |__/|_|         
```

AI Agent 的 Harness 能力，从某 AI Coding 产品源码泄露中提炼，装入 OpenClaw。

---

## 神话缘起

> 普罗米修斯用泥土造人，盗取奥林匹斯之火，将文明与技艺带给人类。

2026年3月，某 AI Coding 产品的源码意外泄露——完整的产品级 Agent Harness 系统，
数万行 TypeScript 代码，如神界火种散落人间。

**claw-prometheus** 将这些工程实践提取、重构、装入 OpenClaw，让这火种继续燃烧。

---

## 功能总览

| 模块 | 功能 | 来源 |
|------|------|------|
| 🛡️ **BashSecurity** | PowerShell 多层安全防御，危险命令执行前拦截 | 危险命令检测 + 路径验证 |
| 🧠 **SessionCompactor** | 对话历史自动压缩，解决长对话失忆 | 超过阈值自动触发 |
| 🧭 **PromptRouter** | 用户输入双重路由，命令 + 工具智能匹配 | 权重打分算法 |
| 🌿 **SessionBranching** | 会话分叉探索，并行尝试多方案后合并 | 分叉 / 合并元数据 |
| 📊 **TurnResult** | 结构化执行结果，stop_reason 全程追踪 | 多轮 Turn 循环 |
| 🔐 **ToolPermissionContext** | 工具权限拒绝追踪，前缀通配匹配 | 风险等级模型 |
| 📋 **PermissionDenialLog** | 安全拒绝日志持久化，JSONL 格式 | 审计追踪 |

---

## 快速开始

### 1. 安装插件

```bash
# 克隆
git clone https://github.com/lba0zi/claw-prometheus.git
cd claw-prometheus

# 复制到 OpenClaw 扩展目录
cp -r . ~/.openclaw/extensions/claw-prometheus/

# 创建 @sinclair/typebox 依赖链接
mkdir -p ~/.openclaw/extensions/claw-prometheus/node_modules/@sinclair
ln -s /path/to/openclaw/node_modules/@sinclair/typebox \
  ~/.openclaw/extensions/claw-prometheus/node_modules/@sinclair/typebox
```

### 2. 配置 OpenClaw

```bash
# 允许插件
openclaw config set plugins.allow '["claw-prometheus"]'

# 启用插件
openclaw config set plugins.entries.claw-prometheus.enabled true

# 插件配置（可选）
openclaw config set plugins.entries.claw-prometheus.config '{
  "compactAfterTurns": 12,
  "denyTools": ["Bash_rm", "FormatTool"],
  "bashSecurityEnabled": true,
  "autoCompact": true
}'

# 工具 allowlist（关键！必须显式列出才能被 LLM 调用）
openclaw config set tools.allow '[
  "claw-prometheus/BashSecurityCheck",
  "claw-prometheus/BashSecurityAnalyze",
  "claw-prometheus/SessionCompact",
  "claw-prometheus/SessionCompactStatus",
  "claw-prometheus/PromptRoute",
  "claw-prometheus/PromptRouteList",
  "claw-prometheus/ToolPermissionCheck",
  "claw-prometheus/SessionBranch",
  "claw-prometheus/DenialLog"
]'

# 重启生效
openclaw gateway restart
```

### 3. 验证安装

```bash
openclaw status | grep claw-prometheus
# 应显示: [plugins] claw-prometheus loaded
```

---

## 工具详解

### 🛡️ BashSecurity — 执行前安全检查

```python
# Python 独立使用
from src.python import bash_security

security = bash_security.BashSecurity()

result = security.analyze("Remove-Item C:\\Temp\\test -Recurse -Force")
# → BLOCK: recursive_delete: 递归强制删除

result = security.analyze("Get-Process | Select-Object Name")
# → PASS: 安全命令
```

| 危险模式 | 等级 | 结果 |
|---------|------|------|
| `rm -rf /` / `Remove-Item -Recurse -Force` | 极危 | 🚫 拦截 |
| `format` / `Format-Volume` | 极危 | 🚫 拦截 |
| `Invoke-Expression` / `IEX` | 极危 | 🚫 拦截 |
| `shutdown /s /f` | 极危 | 🚫 拦截 |
| 凭据窃取模式 | 极危 | 🚫 拦截 |
| 网络下载 + 执行管道 | 危险 | ⚠️ 警告 |
| `Set-ExecutionPolicy Bypass` | 危险 | ⚠️ 警告 |

### 🧠 SessionCompactor — 对话自动压缩

触发条件：对话超过 ~12 轮，或 token 数超过 ~8000。

```python
from src.python import session_compactor

compactor = session_compactor.SessionCompactor(compact_after_turns=12, keep_recent_turns=6)

# 每次对话结束检查
if compactor.should_compact(turn_count):
    result = compactor.summarize_old_messages(messages, session_id="sess-001")
    # result.summary: 压缩摘要
    # result.kept_messages: 最近保留的消息
    # 节省 ~11000 tokens
```

压缩结果自动保存到 `memory/YYYY-MM-DD-compact.md`。

### 🧭 PromptRouter — 智能双重路由

```python
from src.python import prompt_router

router = prompt_router.create_default_router()

matches = router.route("帮我 git commit")
# → [command] git-commit  score=8
# → [tool]    BashTool     score=2
```

得分相同优先命令，分数不同分数高者优先。

### 🌿 SessionBranching — 分叉探索

```python
from src.python import session_branching

# 创建分叉
branch = session_branching.create_branch(
    parent_id="main-session",
    description="尝试用 Rust 重写核心模块"
)
# → branch.branch_id = "abc123"

# 在分支中执行探索...

# 合并回来
session_branching.merge_branch(
    branch_id="abc123",
    strategy="newest_wins"  # parent_wins | child_wins | newest_wins
)
```

---

## OpenClaw Agent 集成

在 `SOUL.md` 或 `AGENTS.md` 中加入规则，让 AI 自动调用这些工具：

```markdown
## 安全：每次 exec 前必须检查

任何 shell 命令执行前，先调用 `BashSecurityCheck`：

- 返回 BLOCK → 告知用户，不执行
- 返回 WARN → 说明风险，得到确认后再执行

## 记忆：对话过长自动压缩

对话超过 ~10 轮，调用 `SessionCompact` 压缩历史，
摘要写入 memory/，保持上下文精简。

## 探索：同时尝试多个方案时

调用 `SessionBranch` 创建分叉，
不同分支探索不同方案，完成后合并。
```

---

## 配置参考

```jsonc
{
  "plugins": {
    "entries": {
      "claw-prometheus": {
        "enabled": true,
        "config": {
          // 压缩相关
          "compactAfterTurns": 12,      // 触发压缩的对话轮次
          "maxBudgetTokens": 2000,      // 单次最大 token 预算
          "keepRecentTurns": 6,          // 压缩后保留轮次

          // 权限相关
          "denyTools": ["Bash_rm", "FormatTool"],   // 精确拒绝的工具
          "denyToolPrefixes": ["Network*"],           // 前缀拒绝
          "autoDenyDangerous": true,                   // 高危自动拒绝

          // 行为开关
          "bashSecurityEnabled": true,   // 启用安全检查
          "autoCompact": true,           // heartbeat 时自动检查压缩
          "logDenials": true             // 记录拒绝到 JSONL
        }
      }
    }
  }
}
```

---

## 架构

```
claw-prometheus/
├── src/
│   ├── modules/                  # TypeScript — OpenClaw 直接引用
│   │   ├── bash-security.ts     # 805 行，20+ 危险模式检测
│   │   ├── session-compactor.ts  # 500 行，压缩算法
│   │   ├── turn-result.ts       # 555 行，结构化结果
│   │   ├── prompt-router.ts     # 641 行，权重路由
│   │   ├── tool-permissions.ts  # 436 行，权限追踪
│   │   ├── session-branching.ts # 574 行，分叉管理
│   │   └── permission-denial-log.ts  # 588 行，审计日志
│   │
│   └── python/                  # Python — 独立使用 / 脚本
│       ├── bash_security.py      # BashSecurity 独立版
│       ├── session_compactor.py  # 会话压缩独立版
│       ├── turn_result.py        # TurnResult + QueryEngine
│       ├── prompt_router.py      # 路由独立版
│       └── tool_permissions.py   # 权限追踪独立版
│
├── claw-prometheus/              # OpenClaw 插件
│   ├── index.ts                  # 插件入口
│   ├── openclaw.plugin.json     # 配置 Schema
│   └── src/tools.ts             # 14 个 OpenClaw Agent Tools
│
├── README.md                     # 本文档
└── LICENSE                       # MIT + 版权声明
```

---

## 验证记录

```
✅ Remove-Item -Recurse -Force  →  BLOCK (recursive_delete)
✅ shutdown /s /f              →  BLOCK (shutdown_restart)
✅ Get-Process | Select-Object  →  PASS
✅ git commit -m fix           →  PASS
✅ NetworkScanner (前缀匹配)    →  BLOCK (Network*)
✅ ToolPermissionContext 通配符   →  正常工作
✅ SessionCompactor 压缩逻辑    →  正常 (OR 条件修正)
✅ PromptRouter 中文路由        →  正常 (git+commit score=8)
```

---

## 免责声明

本项目基于公开泄露的源码进行独立工程研究，不与任何公司关联。
工程洞察不得用于创建竞争产品。
详见 [LICENSE](./LICENSE)。
