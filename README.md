# claw-harness

> Extracting production-grade AI Agent capabilities from the Claude Code source leak — now integrated into OpenClaw.

## What is this?

On March 31, 2026, security researcher [@Fried_rice](https://github.com/fried-rice7) discovered that Anthropic's official Claude Code npm package contained full TypeScript source code in its `cli.js.map` file — ~512,000 lines of a production AI Coding Agent's internal harness system.

**claw-harness** extracts the most valuable engineering patterns from that leak and packages them as OpenClaw plugins and standalone Python modules.

---

## Features

### 🛡️ Security — Bash/PowerShell Multi-Layer Defense

Detects and blocks dangerous operations **before** execution:

| Pattern | Risk | Action |
|---------|------|--------|
| `rm -rf /` / `Remove-Item -Recurse -Force` | Critical | BLOCK |
| `format` / `Format-Volume` | Critical | BLOCK |
| `Invoke-Expression` / `IEX` | Critical | BLOCK |
| `shutdown /s /f` / `stop-computer -Force` | Critical | BLOCK |
| `sekurlsa::` / `mimikatz` | Critical | BLOCK |
| `Invoke-WebRequest \| IEX` (download+exec) | Dangerous | WARN |
| `Set-ExecutionPolicy Bypass` | Dangerous | WARN |
| Network UNC path access | Warning | WARN |

### 🧠 Memory — Session Compaction

LLM context has limits. Session compaction solves this proactively:

```
对话历史 14 轮 → 压缩为摘要 + 最近 6 轮
上下文长度: ~14,000 tokens → ~3,000 tokens
节省: ~11,000 tokens
```

Compressed history is saved to `memory/YYYY-MM-DD-compact.md`.

### 🧭 Routing — Command + Tool Dual Matching

User input simultaneously matches against Commands (`/git-commit`) and Tools (`BashTool`):

```
"帮我 git commit"
→ [command] git-commit   score=8  (git + commit keywords)
→ [tool]    BashTool     score=2  (bash keyword)
```

Commands are preferred at equal scores.

### 🌿 Branching — Parallel Exploration

Try two approaches simultaneously without disrupting the main session:

```
SessionBranch("方案A: Rust重写")  → branch_id=abc123
[在分支中执行方案A]

SessionBranch("方案B: Python优化") → branch_id=def456
[在分支中执行方案B]

SessionMerge("def456", strategy="newest_wins")  → 合并回主分支
```

### 📋 Permission Denial Log

Every tool rejection is logged to JSONL for security auditing:

```json
{"tool_name":"Bash_rm","reason":"explicit deny","timestamp":"2026-04-01T12:00:00Z","session_id":"abc123"}
```

---

## Installation

### Option 1: OpenClaw Plugin (Recommended)

```bash
# 1. Copy plugin to OpenClaw extensions
cp -r claw-harness ~/.openclaw/extensions/

# 2. Create symlink for dependencies
mkdir -p ~/.openclaw/extensions/claw-harness/node_modules
ln -s /path/to/openclaw/node_modules/@sinclair \
  ~/.openclaw/extensions/claw-harness/node_modules/@sinclair

# 3. Add to openclaw.json
openclaw config set plugins.allow '["claw-harness"]'
openclaw config set plugins.entries.claw-harness.enabled true
openclaw config set plugins.entries.claw-harness.config '{}'

# 4. Add tools to allowlist
openclaw config set tools.allow '[
  "claw-harness/BashSecurityCheck",
  "claw-harness/SessionCompact",
  "claw-harness/PromptRoute",
  "claw-harness/ToolPermissionCheck",
  "claw-harness/SessionBranch",
  "claw-harness/DenialLog"
]'

# 5. Restart
openclaw gateway restart
```

### Option 2: Python Standalone

```bash
pip install -e ./python
```

```python
from claw_harness import bash_security, tool_permissions, session_compactor

security = bash_security.BashSecurity()
result = security.analyze("Remove-Item C:\\Temp -Recurse -Force")
print(result.summary())  # 🚫 BLOCKED: recursive_delete
```

---

## Configuration

```jsonc
{
  "plugins": {
    "entries": {
      "claw-harness": {
        "enabled": true,
        "config": {
          "compactAfterTurns": 12,       // Auto-compact after N turns
          "maxBudgetTokens": 2000,       // Budget per turn
          "denyTools": ["Bash_rm", "FormatTool"],  // Explicit denies
          "denyToolPrefixes": ["Network*"],         // Prefix denies
          "bashSecurityEnabled": true,     // Enable security checks
          "autoCompact": true,             // Heartbeat auto-compact
          "logDenials": true              // Log rejections to JSONL
        }
      }
    }
  }
}
```

---

## Architecture

```
src/
├── modules/                    # Standalone TypeScript modules
│   ├── tool-permissions.ts    # Permission denial tracking
│   ├── session-compactor.ts   # Conversation compaction
│   ├── turn-result.ts        # Structured execution results
│   ├── prompt-router.ts      # Command + tool routing
│   ├── bash-security.ts       # PowerShell security analysis
│   ├── session-branching.ts   # Parallel session branches
│   └── permission-denial-log.ts # Security audit log
│
├── python/                    # Standalone Python modules
│   ├── tool_permissions.py
│   ├── session_compactor.py
│   ├── turn_result.py
│   ├── prompt_router.py
│   └── bash_security.py
│
└── claw-harness/             # OpenClaw plugin
    ├── index.ts               # Plugin entry point
    ├── openclaw.plugin.json  # Plugin manifest + config schema
    └── src/tools.ts          # OpenClaw agent tools implementation
```

---

## For OpenClaw Agents

Add to your `AGENTS.md` or `SOUL.md`:

```markdown
## Security

Before executing ANY shell command, call BashSecurityCheck first:
- BLOCK: tell user and do not execute
- WARN: explain risk, proceed only after confirmation

## Session Compaction

When session exceeds ~10 turns, call SessionCompact automatically.
```

---

## Documentation

- [OpenClaw Plugin Guide](./claw-harness/README.md)
- [Python Module API](./src/python/)
- [Claude Code Leak Analysis](https://zhuanlan.zhihu.com/p/2022378958767887638) (Zhihu, Chinese)

---

## Disclaimers

- This project is an **independent engineering analysis** of publicly available source code.
- It is **not affiliated with**, **not supported by**, and **not endorsed by** Anthropic PBC.
- Source code from this project must not be used to create a competing product to Claude Code.
- See [LICENSE](./LICENSE) for full terms.

---

## Credits

- Original leak discovery: [@Fried_rice](https://github.com/fried-rice7) (Chaofan Shou)
- Inspired by: [instructkr/claude-code](https://github.com/instructkr/claude-code) — clean-room Python reimplementation
- This project: clean-room engineering analysis and OpenClaw integration
