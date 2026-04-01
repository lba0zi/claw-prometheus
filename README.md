# claw-prometheus

> 盗取神火，照亮人间。

## 缘起

普罗米修斯用泥土造人，盗取奥林匹斯之火，将文明与技艺带给人类。

2026年3月，某 AI  Coding 产品的源码意外泄露——完整的产品级 Agent Harness 系统，数万行 TypeScript 代码，如神界火种散落人间。

**claw-prometheus** 将这些工程实践提取、重构、装入 OpenClaw，让这火种继续燃烧。

---

## 火种包含的能力

### 🛡️ BashSecurity — 多层安全防御

在命令执行前识别危险操作，如同预警系统守护火种：

| 危险模式 | 等级 | 处理 |
|---------|------|------|
| `rm -rf /` / `Remove-Item -Recurse` | 极危 | 拦截 |
| `format` / `Format-Volume` | 极危 | 拦截 |
| `Invoke-Expression` / `IEX` | 极危 | 拦截 |
| `shutdown /s /f` | 极危 | 拦截 |
| 凭据窃取模式 | 极危 | 拦截 |
| 下载+执行管道 | 危险 | 警告 |
| `Set-ExecutionPolicy Bypass` | 危险 | 警告 |

### 🧠 SessionCompactor — 记忆之火

LLM 的上下文长度有尽，火种不灭——压缩旧记忆，保留精华：

```
对话历史 14 轮 → 摘要 + 最近 6 轮
上下文长度: ~14,000 tokens → ~3,000 tokens
节省: ~11,000 tokens
```

### 🧭 PromptRouter — 双重路由

同时匹配命令与工具，智能选择最优路径：

```
"帮我 git commit"
→ [命令] git-commit   得分=8
→ [工具] BashTool     得分=2
```

### 🌿 SessionBranch — 分支探索

同时探索多条路径，如银色马车并行：

```
SessionBranch("方案A") → branch_id
SessionBranch("方案B") → branch_id
SessionMerge(branch_id) → 合并回主路
```

### 📋 PermissionDenialLog — 盗火日志

每一次拦截都被记录，供安全审计：

```json
{"tool_name":"Bash_rm","reason":"极危操作","timestamp":"2026-04-01T12:00:00Z"}
```

---

## 安装

```bash
# 克隆
git clone https://github.com/lba0zi/claw-prometheus.git
cd claw-prometheus

# 安装插件
cp -r claw-prometheus ~/.openclaw/extensions/
# 创建依赖链接
mkdir -p ~/.openclaw/extensions/claw-prometheus/node_modules
ln -s /path/to/openclaw/node_modules/@sinclair \
  ~/.openclaw/extensions/claw-prometheus/node_modules/@sinclair

# 配置 OpenClaw
openclaw config set plugins.allow '["claw-prometheus"]'
openclaw config set plugins.entries.claw-prometheus.enabled true

# 添加工具到 allowlist
openclaw config set tools.allow '[
  "claw-prometheus/BashSecurityCheck",
  "claw-prometheus/SessionCompact",
  "claw-prometheus/PromptRoute",
  "claw-prometheus/ToolPermissionCheck",
  "claw-prometheus/SessionBranch",
  "claw-prometheus/DenialLog"
]'

# 重启
openclaw gateway restart
```

## Python 独立使用

```bash
pip install -e ./python
```

```python
from claw_prometheus import bash_security, tool_permissions, session_compactor

security = bash_security.BashSecurity()
result = security.analyze("Remove-Item C:\\Temp -Recurse -Force")
print(result.summary())  # 极危 — 拦截
```

---

## 架构

```
src/
├── modules/                    # TypeScript 模块（OpenClaw 直接引用）
│   ├── bash-security.ts        # 安全防御
│   ├── session-compactor.ts   # 记忆压缩
│   ├── turn-result.ts         # 结构化结果
│   ├── prompt-router.ts       # 双重路由
│   ├── tool-permissions.ts    # 权限追踪
│   ├── session-branching.ts   # 分支探索
│   └── permission-denial-log.ts # 安全日志
│
├── python/                    # Python 模块（独立使用）
│   ├── bash_security.py
│   ├── session_compactor.py
│   ├── turn_result.py
│   ├── prompt_router.py
│   └── tool_permissions.py
│
└── claw-prometheus/          # OpenClaw 插件
    ├── index.ts
    ├── openclaw.plugin.json
    └── src/tools.ts          # 14 个 OpenClaw Agent Tools
```

---

## 免责声明

本项目是对公开源码的独立工程研究，不与任何公司关联。工程洞察不得用于创建竞争产品。
