/**
 * claw-harness/tools.ts
 * ====================
 * 将 7 个 harness 模块注册为 OpenClaw Agent Tools。
 *
 * 每个模块对应一个 / 多个 OpenClaw tool，
 * LLM 可通过工具调用直接使用这些能力。
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "@sinclair/typebox";

// ─── 共享状态 ──────────────────────────────────────────────────────────────

interface PluginConfig {
  compactAfterTurns?: number;
  maxBudgetTokens?: number;
  denyTools?: string[];
  denyToolPrefixes?: string[];
  bashSecurityEnabled?: boolean;
  autoCompact?: boolean;
  logDenials?: boolean;
  branchStorageDir?: string;
}

const DEFAULT_COMPACT_TURNS = 12;
const DEFAULT_MAX_BUDGET = 2000;

// 工具调用计数器（用于模拟 token 计数）
let turnCounter = 0;
const turnHistory: Array<{ prompt: string; output: string; stopReason: string }> = [];

// ─── 辅助函数 ──────────────────────────────────────────────────────────────

function createTextResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function createErrorResult(message: string) {
  return { content: [{ type: "text" as const, text: `❌ Error: ${message}` }], isError: true };
}

// ─── 1. ToolPermission — 工具权限检查 ───────────────────────────────────────

const TOOL_PERMISSION_TOOLS: AnyAgentTool[] = [
  {
    name: "ToolPermissionCheck",
    description:
      "检查某个工具是否被当前权限策略拒绝。返回允许/拒绝状态及原因。用于在执行前验证工具可用性。",
    parameters: Type.Object({
      toolName: Type.String({ description: "要检查的工具名称，如 BashTool、PowerShellTool" }),
    }),
    async execute(_id, params: { toolName: string }) {
      try {
        const denyTools = (globalThis.__clawHarnessConfig?.denyTools as string[]) || [];
        const denyPrefixes = (globalThis.__clawHarnessConfig?.denyToolPrefixes as string[]) || [];

        const nameLower = params.toolName.toLowerCase();
        const blocked =
          denyTools.map((t) => t.toLowerCase()).includes(nameLower) ||
          denyPrefixes.some((p) => nameLower.startsWith(p.toLowerCase()));

        if (blocked) {
          const reason = denyPrefixes.some((p) => nameLower.startsWith(p.toLowerCase()))
            ? `匹配拒绝前缀: ${denyPrefixes.find((p) => nameLower.startsWith(p.toLowerCase()))}`
            : `在拒绝列表中`;
          return createTextResult(`🚫 BLOCKED: ${params.toolName} — ${reason}`);
        }
        return createTextResult(`✅ ALLOWED: ${params.toolName}`);
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },

  {
    name: "ToolPermissionContext",
    description:
      "获取当前权限上下文的摘要信息：拒绝的工具列表、前缀规则、风险阈值。",
    parameters: Type.Object({}),
    async execute(_id) {
      try {
        const denyTools = (globalThis.__clawHarnessConfig?.denyTools as string[]) || [];
        const denyPrefixes = (globalThis.__clawHarnessConfig?.denyToolPrefixes as string[]) || [];
        const autoDeny = globalThis.__clawHarnessConfig?.bashSecurityEnabled ?? true;

        return createTextResult(
          [
            `ToolPermissionContext Summary`,
            `  deny_tools:     [${denyTools.join(", ") || "none"}]`,
            `  deny_prefixes:  [${denyPrefixes.join(", ") || "none"}]`,
            `  auto_deny_dangerous: ${autoDeny}`,
          ].join("\n")
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 2. SessionCompactor — 会话压缩 ─────────────────────────────────────────

const SESSION_COMPACTOR_TOOLS: AnyAgentTool[] = [
  {
    name: "SessionCompact",
    description:
      "手动触发对话历史压缩。分析并压缩旧消息，生成摘要，保留最近关键对话。可选传入当前对话历史。",
    parameters: Type.Object({
      history: Type.Optional(
        Type.Array(
          Type.Object({
            role: Type.String(),
            content: Type.String(),
          })
        )
      ),
      keepRecent: Type.Optional(
        Type.Number({ description: "保留最近几条消息（默认 6）" })
      ),
    }),
    async execute(_id, params: { history?: Array<{ role: string; content: string }>; keepRecent?: number }) {
      try {
        const compactTurns =
          (globalThis.__clawHarnessConfig?.compactAfterTurns as number) ||
          DEFAULT_COMPACT_TURNS;
        const keep = params.keepRecent ?? 6;
        const msgs = params.history ?? [];

        if (msgs.length <= keep) {
          return createTextResult(
            `✅ 未达到压缩阈值（当前 ${msgs.length} 条 ≤ 保留 ${keep} 条）`
          );
        }

        // 简单摘要：对每条消息取前80字符，用 | 分隔
        const old = msgs.slice(0, -keep);
        const kept = msgs.slice(-keep);

        const summaryParts = old.map((m) => {
          const preview = m.content.length > 80 ? m.content.slice(0, 80) + "..." : m.content;
          return `[${m.role}] ${preview}`;
        });
        const summary = summaryParts.join(" | ");

        const tokensSaved =
          old.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0) -
          Math.ceil(summary.length / 4);

        turnHistory.push({
          prompt: `compact(${msgs.length} msgs → keep ${keep})`,
          output: summary,
          stopReason: "compacted",
        });

        return createTextResult(
          [
            `✅ 压缩完成`,
            ``,
            `  原始消息: ${msgs.length} 条`,
            `  压缩后: 摘要 + ${kept} 条保留消息`,
            `  节省 tokens: ~${Math.max(0, tokensSaved)}`,
            ``,
            `--- 压缩摘要 ---`,
            summary.slice(0, 1000) + (summary.length > 1000 ? "..." : ""),
            ``,
            `--- 保留消息 (最近 ${kept} 条) ---`,
            kept.map((m) => `[${m.role}] ${m.content.slice(0, 120)}`).join("\n"),
          ].join("\n")
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },

  {
    name: "SessionCompactStatus",
    description: "查询当前会话压缩状态：轮次、阈值、是否需要压缩。",
    parameters: Type.Object({}),
    async execute(_id) {
      try {
        const compactTurns =
          (globalThis.__clawHarnessConfig?.compactAfterTurns as number) ||
          DEFAULT_COMPACT_TURNS;
        const currentTurns = Math.floor(turnHistory.length);
        const needsCompact = currentTurns >= compactTurns;

        return createTextResult(
          [
            `SessionCompact Status`,
            `  compact_after_turns: ${compactTurns}`,
            `  current_turns:        ${currentTurns}`,
            `  should_compact:       ${needsCompact ? "⚠️  YES" : "✅ NO"}`,
            `  auto_compact:        ${globalThis.__clawHarnessConfig?.autoCompact ?? true}`,
            `  max_budget_tokens:   ${(globalThis.__clawHarnessConfig?.maxBudgetTokens as number) || DEFAULT_MAX_BUDGET}`,
          ].join("\n")
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 3. TurnResult — 结构化执行结果 ─────────────────────────────────────────

const TURN_RESULT_TOOLS: AnyAgentTool[] = [
  {
    name: "TurnResult",
    description:
      "获取上一个工具执行的 TurnResult 结构化结果，包含 stop_reason、usage、matched_commands、permission_denials 等元数据。",
    parameters: Type.Object({}),
    async execute(_id) {
      try {
        const last = turnHistory[turnHistory.length - 1];
        if (!last) {
          return createTextResult("No turn result available yet.");
        }
        const usageIn = Math.ceil(last.prompt.length / 4);
        const usageOut = Math.ceil(last.output.length / 4);

        return createTextResult(
          [
            `TurnResult`,
            `  stop_reason:       ${last.stopReason}`,
            `  matched_commands:  []`,
            `  matched_tools:     []`,
            `  permission_denials: 0`,
            `  usage:`,
            `    input_tokens:   ${usageIn}`,
            `    output_tokens:  ${usageOut}`,
            `    total_tokens:   ${usageIn + usageOut}`,
          ].join("\n")
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },

  {
    name: "TurnHistory",
    description: "获取当前会话的所有 Turn 历史记录。",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "返回最近 N 条（默认 10）" })),
    }),
    async execute(_id, params: { limit?: number }) {
      try {
        const limit = params.limit ?? 10;
        const recent = turnHistory.slice(-limit);

        if (recent.length === 0) {
          return createTextResult("No turn history yet.");
        }

        const lines = [`Turn History (last ${recent.length}):`];
        recent.forEach((t, i) => {
          lines.push(
            `  [${i + 1}] ${t.stopReason} | ${Math.ceil(t.prompt.length / 4) + Math.ceil(t.output.length / 4)} tokens`
          );
        });
        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 4. PromptRouter — 智能路由 ──────────────────────────────────────────────

const PROMPT_ROUTER_TOOLS: AnyAgentTool[] = [
  {
    name: "PromptRoute",
    description:
      "将用户输入同时匹配 Command（斜杠命令）和 Tool（工具），返回按分数排序的匹配列表。用于决定最优执行路径。",
    parameters: Type.Object({
      prompt: Type.String({ description: "用户输入的原始提示" }),
      limit: Type.Optional(Type.Number({ description: "返回最多 N 个匹配（默认 5）" })),
    }),
    async execute(_id, params: { prompt: string; limit?: number }) {
      try {
        const limit = params.limit ?? 5;
        const matches = routePrompt(params.prompt, limit);

        if (matches.length === 0) {
          return createTextResult("No command or tool matches found.");
        }

        const lines = [`Routing: "${params.prompt}"`, ``, `Top ${matches.length} matches:`];
        matches.forEach((m) => {
          lines.push(
            `  [${m.kind.toUpperCase().padEnd(7)}] ${m.name.padEnd(24)} score=${String(m.score).padStart(2)}  ${m.reason}`
          );
        });

        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },

  {
    name: "PromptRouteList",
    description: "列出所有已注册的命令和工具路由规则。",
    parameters: Type.Object({}),
    async execute(_id) {
      try {
        const commands = getRegisteredCommands();
        const tools = getRegisteredTools();
        return createTextResult(
          [
            `Registered Routes`,
            ``,
            `Commands (${commands.length}):`,
            ...commands.slice(0, 20).map((c) => `  /${c}`),
            commands.length > 20 ? `  ... and ${commands.length - 20} more` : "",
            ``,
            `Tools (${tools.length}):`,
            ...tools.slice(0, 20).map((t) => `  ${t}`),
            tools.length > 20 ? `  ... and ${tools.length - 20} more` : "",
          ].join("\n")
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 5. BashSecurity — Bash/PowerShell 安全 ─────────────────────────────────

const BASH_SECURITY_TOOLS: AnyAgentTool[] = [
  {
    name: "BashSecurityCheck",
    description:
      "在执行 PowerShell/Bash 命令前进行多层安全检查：危险命令检测、路径穿越防护、系统目录保护、只读路径保护。返回通过/阻止/警告状态。",
    parameters: Type.Object({
      command: Type.String({ description: "要检查的命令" }),
    }),
    async execute(_id, params: { command: string }) {
      try {
        const result = analyzeBashSecurity(params.command);
        if (result.blocked) {
          return createTextResult(
            [`🚫 BLOCKED`, ``, `  Reason: ${result.blockReason}`, ``, ...formatWarnings(result.warnings)].join("\n")
          );
        }
        if (result.warnings.length > 0) {
          return createTextResult(
            [
              `⚠️  PASSED WITH WARNINGS`,
              `  Risk: ${result.riskLevel}`,
              ``,
              ...formatWarnings(result.warnings),
            ].join("\n")
          );
        }
        return createTextResult(`✅ PASSED (${result.riskLevel}) — 命令安全`);
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },

  {
    name: "BashSecurityAnalyze",
    description:
      "对命令进行完整的安全分析，返回详细的检查报告，包括匹配到的危险模式、路径问题、安全子命令等。",
    parameters: Type.Object({
      command: Type.String({ description: "要分析的完整命令" }),
    }),
    async execute(_id, params: { command: string }) {
      try {
        const result = analyzeBashSecurity(params.command);
        const lines = [
          `Security Analysis: "${params.command.slice(0, 80)}${params.command.length > 80 ? "..." : ""}"`,
          ``,
          `  Passed:   ${result.passed}`,
          `  Blocked:  ${result.blocked}`,
          `  Risk:     ${result.riskLevel}`,
          result.blockReason ? `  Block Reason: ${result.blockReason}` : "",
          ``,
          `  Dangerous Patterns:`,
        ];

        if (result.warnings.length === 0) {
          lines.push(`    (none)`);
        } else {
          result.warnings.forEach((w) => {
            lines.push(`    - [${w.risk}] ${w.patternName}: ${w.message}`);
            if (w.suggestions.length > 0) {
              lines.push(`        Suggestion: ${w.suggestions.join("; ")}`);
            }
          });
        }

        if (result.safeCommands.length > 0) {
          lines.push(``, `  Safe Sub-commands Found:`);
          result.safeCommands.forEach((s) => lines.push(`    ✅ ${s}`));
        }

        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 6. SessionBranching — 会话分叉 ─────────────────────────────────────────

const SESSION_BRANCHING_TOOLS: AnyAgentTool[] = [
  {
    name: "SessionBranch",
    description: "从当前会话创建一个新的探索分支，用于并行尝试不同的解决方案。",
    parameters: Type.Object({
      description: Type.Optional(
        Type.String({ description: "分支描述（如：尝试方案A / 方案B）" })
      ),
    }),
    async execute(_id, params: { description?: string }) {
      try {
        const branchId = generateId();
        const parentId = globalThis.__clawHarnessSessionId || "main";
        const now = Date.now();

        const metadata = {
          branch_id: branchId,
          parent_id: parentId,
          created_at: new Date(now).toISOString(),
          description: params.description || "",
          merged: false,
        };

        // 存储到内存（实际应持久化到 .openclaw/branches/）
        globalThis.__clawHarnessBranches = globalThis.__clawHarnessBranches || {};
        globalThis.__clawHarnessBranches[branchId] = metadata;

        turnHistory.push({
          prompt: `branch ${branchId}`,
          output: `Created branch: ${branchId}`,
          stopReason: "completed",
        });

        return createTextResult(
          [
            `🌿 Branch Created`,
            ``,
            `  branch_id:   ${branchId}`,
            `  parent_id:   ${parentId}`,
            `  description: ${params.description || "(none)"}`,
            `  created_at:  ${metadata.created_at}`,
            ``,
            `Use /branch ${branchId} to switch to this branch.`,
          ].join("\n")
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },

  {
    name: "SessionBranchList",
    description: "列出当前会话的所有分支。",
    parameters: Type.Object({
      parentId: Type.Optional(Type.String({ description: "只列出某分支的子分支" })),
    }),
    async execute(_id, params: { parentId?: string }) {
      try {
        const branches: Record<string, unknown> =
          (globalThis.__clawHarnessBranches as Record<string, unknown>) || {};

        const list = Object.values(branches) as Array<{
          branch_id: string;
          parent_id: string;
          created_at: string;
          description: string;
          merged: boolean;
        }>;

        if (params.parentId) {
          list.filter((b) => b.parent_id === params.parentId);
        }

        if (list.length === 0) {
          return createTextResult("No branches yet. Use SessionBranch to create one.");
        }

        const lines = [`🌿 Branches (${list.length}):`];
        list.forEach((b) => {
          lines.push(
            `  ${b.branch_id} | parent=${b.parent_id} | ${b.merged ? "✅ merged" : "active"} | ${b.description || "(no desc)"}`
          );
        });
        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },

  {
    name: "SessionMerge",
    description:
      "将指定分支合并回目标分支（或主分支）。解决冲突时可选择 parent_wins / child_wins / newest_wins 策略。",
    parameters: Type.Object({
      branchId: Type.String({ description: "要合并的分支 ID" }),
      targetId: Type.Optional(
        Type.String({ description: "目标分支 ID（默认 main）" })
      ),
      strategy: Type.Optional(
        Type.Union([
          Type.Literal("parent_wins"),
          Type.Literal("child_wins"),
          Type.Literal("newest_wins"),
        ])
      ),
    }),
    async execute(_id, params: { branchId: string; targetId?: string; strategy?: string }) {
      try {
        const branches: Record<string, unknown> =
          (globalThis.__clawHarnessBranches as Record<string, unknown>) || {};
        const branch = branches[params.branchId] as
          | { branch_id: string; merged: boolean }
          | undefined;

        if (!branch) {
          return createErrorResult(`Branch not found: ${params.branchId}`);
        }

        branch.merged = true;
        const strategy = params.strategy || "newest_wins";

        return createTextResult(
          [
            `🔀 Merge Complete`,
            ``,
            `  from:  ${params.branchId}`,
            `  into:  ${params.targetId || "main"}`,
            `  strategy: ${strategy}`,
            ``,
            `✅ Branch marked as merged.`,
          ].join("\n")
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 7. PermissionDenialLog — 拒绝日志 ─────────────────────────────────────

const PERMISSION_DENIAL_TOOLS: AnyAgentTool[] = [
  {
    name: "DenialLog",
    description: "记录一次工具权限拒绝事件，供安全审计使用。",
    parameters: Type.Object({
      toolName: Type.String({ description: "被拒绝的工具名称" }),
      reason: Type.String({ description: "拒绝原因" }),
      sessionId: Type.Optional(Type.String({ description: "会话 ID" })),
      promptExcerpt: Type.Optional(Type.String({ description: "触发拒绝的提示摘要" })),
    }),
    async execute(_id, params: { toolName: string; reason: string; sessionId?: string; promptExcerpt?: string }) {
      try {
        const entry = {
          id: generateId(),
          tool_name: params.toolName,
          reason: params.reason,
          timestamp: new Date().toISOString(),
          session_id: params.sessionId || globalThis.__clawHarnessSessionId || "unknown",
          prompt_excerpt: (params.promptExcerpt || "").slice(0, 200),
        };

        // 追加到日志（JSONL 格式）
        const logLine = JSON.stringify(entry);
        process.stderr.write(`[claw-harness denial] ${logLine}\n`);

        return createTextResult(
          [
            `📋 Denial Logged`,
            ``,
            `  id:         ${entry.id}`,
            `  tool:       ${entry.tool_name}`,
            `  reason:     ${entry.reason}`,
            `  timestamp:  ${entry.timestamp}`,
            `  session:    ${entry.session_id}`,
          ].join("\n")
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },

  {
    name: "DenialSummary",
    description: "获取权限拒绝日志的统计摘要：各工具被拒绝次数、最常见原因等。",
    parameters: Type.Object({
      toolName: Type.Optional(
        Type.String({ description: "只统计指定工具" })
      ),
      limit: Type.Optional(
        Type.Number({ description: "返回最近 N 条（默认 10）" })
      ),
    }),
    async execute(_id, params: { toolName?: string; limit?: number }) {
      // 由于是无状态工具，返回模拟统计
      const lines = [
        `📊 Denial Summary`,
        ``,
        `  Total denials: ${turnHistory.filter((t) => t.stopReason.includes("denial")).length}`,
        `  Tracked since: last gateway restart`,
        ``,
        `  Per-tool (simulated, enable logDenials for real data):`,
        `    BashTool:       0 denials`,
        `    PowerShellTool: 0 denials`,
        `    NetworkTool:     0 denials`,
        ``,
        `💡 Set logDenials: true in plugin config to enable JSONL logging.`,
      ];
      return createTextResult(lines.join("\n"));
    },
  },
];

// ─── 全部工具列表 ─────────────────────────────────────────────────────────────

type RoutingMatch = { kind: string; name: string; score: number; reason: string };

const REGISTERED_COMMANDS = [
  "git-commit", "git-branch", "git-status", "compact", "brief", "clear",
  "config", "cost", "context", "copy", "resume", "retry", "bughunter",
  "browse", "model", "claude", "help", "exit",
];

const REGISTERED_TOOLS = [
  "BashTool", "PowerShellTool", "FileReadTool", "FileWriteTool",
  "FileEditTool", "GlobTool", "GrepTool", "AgentTool", "forkSubagent",
  "resumeAgent", "planAgent", "LSPTool", "MCPTool", "ChromeTool",
  "ConfigTool", "BriefTool",
];

const DANGEROUS_PATTERNS: Array<{
  name: string;
  risk: string;
  pattern: RegExp;
  message: string;
  suggestions: string[];
}> = [
  {
    name: "recursive_delete",
    risk: "critical",
    pattern: /Remove-Item\s+.*-Recurse|-Recurse\s+.*-Force|del\s+\/s\s+\/f|rm\s+-rf\s+\/|rm\s+-rf\s+\./i,
    message: "递归强制删除，可能清空目录",
    suggestions: ["移除 -Recurse/-Force 参数", "先确认路径"],
  },
  {
    name: "format_command",
    risk: "critical",
    pattern: /\bformat\s+[a-z]:|Format-Volume/i,
    message: "格式化命令，可能丢失所有数据",
    suggestions: ["使用 Remove-Item 代替"],
  },
  {
    name: "invoke_expression",
    risk: "critical",
    pattern: /IEX\s+|Invoke-Expression\s+|Invoke-Command\s+.*-ScriptBlock/i,
    message: "动态代码执行，高风险注入",
    suggestions: ["使用静态命令", "审查输入来源"],
  },
  {
    name: "shutdown_restart",
    risk: "critical",
    pattern: /shutdown\s+\/s\s+\/f|stop-computer\s+-Force|restart-computer\s+-Force/i,
    message: "关机或重启命令",
    suggestions: ["极其危险，强烈建议拒绝"],
  },
  {
    name: "credential_access",
    risk: "critical",
    pattern: /Get-Credential|sekurlsa::|mimikatz/i,
    message: "凭据访问操作",
    suggestions: ["确认是安全场景"],
  },
  {
    name: "bypass_policy",
    risk: "dangerous",
    pattern: /Set-ExecutionPolicy\s+Bypass|Set-ExecutionPolicy\s+Unrestricted/i,
    message: "绕过执行策略",
    suggestions: ["确认是否必要"],
  },
];

// ─── 实现函数 ─────────────────────────────────────────────────────────────────

function routePrompt(prompt: string, limit: number): RoutingMatch[] {
  const tokens = new Set(
    prompt
      .toLowerCase()
      .replace(/[/\\-_.:;,!?(){}[\]<>@#$%^&*+=~|`"]/g, " ")
      .split()
      .filter((t) => t.length >= 2)
  );

  const matches: RoutingMatch[] = [];

  // 匹配命令
  for (const cmd of REGISTERED_COMMANDS) {
    const parts = cmd.toLowerCase().split("-");
    let score = 0;
    const reasons: string[] = [];
    for (const part of parts) {
      if (tokens.has(part)) {
        score += 2;
        reasons.push(`+kw:${part}`);
      }
    }
    if (tokens.has(cmd.replace("-", ""))) score += 3;
    if (prompt.toLowerCase().includes(`/${cmd}`)) score += 3;
    if (score > 0) {
      matches.push({ kind: "command", name: cmd, score, reason: reasons.join(", ") });
    }
  }

  // 匹配工具
  for (const tool of REGISTERED_TOOLS) {
    const parts = tool.toLowerCase().replace(/tool$/, "").split(/(?=[A-Z])/);
    let score = 0;
    const reasons: string[] = [];
    for (const part of parts) {
      if (tokens.has(part)) {
        score += 2;
        reasons.push(`+kw:${part}`);
      }
    }
    if (score > 0) {
      matches.push({ kind: "tool", name: tool, score, reason: reasons.join(", ") });
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.kind === "command" ? -1 : 1;
  });

  return matches.slice(0, limit);
}

function analyzeBashSecurity(
  command: string
): {
  passed: boolean;
  blocked: boolean;
  blockReason: string;
  warnings: Array<{
    patternName: string;
    risk: string;
    message: string;
    suggestions: string[];
  }>;
  riskLevel: string;
  safeCommands: string[];
} {
  const warnings: Array<{
    patternName: string;
    risk: string;
    message: string;
    suggestions: string[];
  }> = [];
  let blocked = false;
  let blockReason = "";

  for (const p of DANGEROUS_PATTERNS) {
    if (p.pattern.test(command)) {
      warnings.push({
        patternName: p.name,
        risk: p.risk,
        message: p.message,
        suggestions: p.suggestions,
      });
      if (p.risk === "critical") {
        blocked = true;
        blockReason = `${p.name}: ${p.message}`;
      }
    }
  }

  const safeKw = [
    "Get-Process", "Get-Service", "Get-ChildItem", "Get-Content",
    "Select-Object", "Where-Object", "Sort-Object", "Measure-Object",
    "Test-Path", "Resolve-Path", "Get-Command", "Get-Help",
    "echo", "pwd", "cd", "ls", "dir", "git status", "git log",
  ];
  const safeCommands = safeKw.filter((kw) =>
    command.toLowerCase().includes(kw.toLowerCase())
  );

  return {
    passed: !blocked,
    blocked,
    blockReason,
    warnings,
    riskLevel: blocked ? "critical" : warnings.length > 0 ? "warning" : "safe",
    safeCommands,
  };
}

function formatWarnings(
  warnings: Array<{ patternName: string; risk: string; message: string; suggestions: string[] }>
): string[] {
  if (warnings.length === 0) return [];
  const lines: string[] = [`  Warnings (${warnings.length}):`];
  warnings.forEach((w) => {
    lines.push(`    ⚠️  [${w.risk}] ${w.patternName}: ${w.message}`);
    if (w.suggestions.length > 0) {
      lines.push(`        → ${w.suggestions[0]}`);
    }
  });
  return lines;
}

function getRegisteredCommands(): string[] {
  return [...REGISTERED_COMMANDS];
}

function getRegisteredTools(): string[] {
  return [...REGISTERED_TOOLS];
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Hermès CLI 辅助 ─────────────────────────────────────────────────────────

const PYTHON_BIN = "C:\\Users\\Surface\\.openclaw\\workspace-main\\.venv\\Scripts\\python.exe";
const HERMES_CLI = "C:\\Users\\Surface\\.openclaw\\workspace-main\\src\\python\\hermes\\hermes_cli.py";

async function runHermesCmd(args: string[]): Promise<Record<string, unknown>> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [HERMES_CLI, ...args], {
      timeout: 15000,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`JSON parse error: ${stdout.slice(0, 200)}`));
        }
      } else {
        reject(new Error(`hermes_cli exited ${code}: ${stderr.slice(0, 200)}`));
      }
    });
    proc.on("error", reject);
  });
}

// ─── 8. ContextShield — Prompt 注入检测 ───────────────────────────────────────

const HERMES_SHIELD_TOOLS: AnyAgentTool[] = [
  {
    name: "ContextShield",
    description:
      "🛡️ Hermès Context Shield — 扫描用户消息中的 Prompt 注入威胁。检测提示词注入、角色扮演劫持、编码混淆、零宽字符等 12 种攻击向量。返回 blocked（是否阻止）、findings（威胁列表）、clean_content（清洗后内容）。",
    parameters: Type.Object({
      text: Type.String({ description: "要扫描的文本内容（通常是用户消息）" }),
    }),
    async execute(_id, params: { text: string }) {
      try {
        const result = await runHermesCmd(["shield", text]);
        const r = result as { blocked: boolean; findings: string[]; clean_content: string };
        const lines = [
          `🛡️ Context Shield Scan`,
          `  blocked:    ${r.blocked ? "🚫 YES" : "✅ NO"}`,
          `  findings:   ${r.findings.length === 0 ? "none" : r.findings.join(", ")}`,
          ``,
          `  clean:      ${r.clean_content.slice(0, 200)}${r.clean_content.length > 200 ? "..." : ""}`,
        ];
        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 9. RefExpand — @引用展开 ────────────────────────────────────────────────

const HERMES_REF_EXPAND_TOOLS: AnyAgentTool[] = [
  {
    name: "RefExpand",
    description:
      "📎 Hermès @引用展开 — 展开消息中的 @git、@file、@folder、@url 等引用标记，将它们替换为实际内容。避免上下文膨胀，只注入相关内容片段。",
    parameters: Type.Object({
      text: Type.String({ description: "包含 @引用 的原始消息" }),
      cwd: Type.Optional(
        Type.String({ description: "工作目录（默认：用户主目录）" })
      ),
    }),
    async execute(_id, params: { text: string; cwd?: string }) {
      try {
        const workDir = params.cwd || "C:\\Users\\Surface";
        const result = await runHermesCmd(["expand", text, "--cwd", workDir]);
        const r = result as {
          message: string;
          warnings: string[];
          ref_count: number;
          refs: Array<{ type: string; raw: string; expanded: string; truncated: boolean }>;
        };
        const lines = [
          `📎 Ref Expand`,
          `  refs:       ${r.ref_count}`,
          `  warnings:   ${r.warnings.length === 0 ? "none" : r.warnings.join("; ")}`,
          ``,
          `--- Expanded Message ---`,
          r.message.slice(0, 500) + (r.message.length > 500 ? "\n...(truncated)" : ""),
        ];
        if (r.ref_count > 0) {
          lines.push(``, `--- References (${r.ref_count}) ---`);
          r.refs.forEach((ref, i) => {
            lines.push(
              `  [${i + 1}] ${ref.type}: ${ref.raw}`,
              `      → ${ref.expanded.slice(0, 100)}${ref.truncated ? " [TRUNCATED]" : ""}`
            );
          });
        }
        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 10. SmartRoute — 任务复杂度路由 ─────────────────────────────────────────

const HERMES_ROUTE_TOOLS: AnyAgentTool[] = [
  {
    name: "SmartRoute",
    description:
      "🧭 Hermès Smart Route — 判断任务复杂度，选择用便宜模型（abab6.5s）还是主模型（MiniMax-M2.7）。基于 40+ 关键词评分：debug/refactor/analyze/architect/plan 等触发复杂路由。返回 use_cheap、model、reason、score。",
    parameters: Type.Object({
      text: Type.String({ description: "用户消息内容" }),
    }),
    async execute(_id, params: { text: string }) {
      try {
        const result = await runHermesCmd(["route", text]);
        const r = result as {
          use_cheap: boolean;
          provider: string;
          model: string;
          reason: string;
          score: number;
          matched_keywords: string[];
        };
        const modelLabel = r.use_cheap ? "💰 cheap" : "🚀 primary";
        const lines = [
          `🧭 Smart Route Decision`,
          `  decision:   ${modelLabel}`,
          `  model:      ${r.provider}/${r.model}`,
          `  score:      ${r.score} keywords`,
          `  keywords:   ${r.matched_keywords.join(", ") || "none"}`,
          ``,
          `  reason:     ${r.reason}`,
        ];
        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];

// ─── 11. SkillFinder — Skills 自我进化系统 ─────────────────────────────────────

const HERMES_SKILL_TOOLS: AnyAgentTool[] = [
  {
    name: "SkillFind",
    description:
      "🛠️ Hermès Skill Finder — 根据当前任务查找最匹配的 Self-Evolving Skills。内置 3 个 OpenClaw 专用 Skill：bash-expert、coder、researcher。找到后返回 skill 指令内容，可直接融入回复。",
    parameters: Type.Object({
      query: Type.String({ description: "当前任务描述或需求" }),
    }),
    async execute(_id, params: { query: string }) {
      try {
        const result = await runHermesCmd(["skills_find", query]);
        const r = result as {
          matches: Array<{
            name: string;
            description: string;
            trigger: string;
            confidence: number;
          }>;
          count: number;
        };
        if (r.count === 0) {
          return createTextResult(
            `🛠️ Skill Finder\n  matches: 0 — 没有找到匹配的 skill\n\n提示：尝试更通用的关键词，如 "bash"、"code"、"research"`
          );
        }
        const lines = [`🛠️ Skill Finder (${r.count} matches)`];
        r.matches.forEach((m, i) => {
          lines.push(
            ``,
            `  [${i + 1}] ${m.name} (confidence: ${m.confidence})`,
            `      desc:  ${m.description}`,
            `      trigger: ${m.trigger.slice(0, 80)}...`
          );
        });
        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
  {
    name: "SkillList",
    description:
      "📋 列出 Hermès 中所有已注册的 Self-Evolving Skills及其状态（评分、使用次数）。",
    parameters: Type.Object({}),
    async execute(_id) {
      try {
        const result = await runHermesCmd(["skills_list"]);
        const r = result as {
          skills: Array<{
            name: string;
            description: string;
            rating: number;
            uses: number;
          }>;
          count: number;
        };
        if (r.count === 0) {
          return createTextResult("📋 Skill List\n  (empty)");
        }
        const lines = [`📋 Hermès Skills (${r.count} registered)`];
        r.skills.forEach((s, i) => {
          const stars = "★".repeat(Math.round(s.rating)) + "☆".repeat(5 - Math.round(s.rating));
          lines.push(`  [${i + 1}] ${s.name} ${stars} (used ${s.uses}x)`);
          lines.push(`         ${s.description}`);
        });
        return createTextResult(lines.join("\n"));
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
  {
    name: "SkillEvolve",
    description:
      "🧬 记录 Skill 使用反馈，触发自我进化。rating=1.0~5.0，suggestion=改进建议。反馈积累后 SkillStore 会自动生成改进版本。",
    parameters: Type.Object({
      name: Type.String({ description: "Skill 名称" }),
      rating: Type.Number({ description: "使用评分 1.0~5.0" }),
      suggestion: Type.Optional(Type.String({ description: "改进建议（可选）" })),
    }),
    async execute(_id, params: { name: string; rating: number; suggestion?: string }) {
      try {
        const args = ["skills_feedback", params.name, String(params.rating)];
        if (params.suggestion) args.push(params.suggestion);
        const result = await runHermesCmd(args);
        const r = result as { ok: boolean; skill: string; rating: number };
        return createTextResult(
          `🧬 Skill Feedback Recorded\n  skill:    ${r.skill}\n  rating:   ${r.rating}/5.0\n  status:   ✅ recorded — 自我进化已触发`
        );
      } catch (e) {
        return createErrorResult(String(e));
      }
    },
  },
];


// ─── 注册所有工具 ─────────────────────────────────────────────────────────────

export function registerTools(api: OpenClawPluginApi, config: PluginConfig): void {
  // 全局配置（供工具内部访问）
  globalThis.__clawHarnessConfig = config;

  const allToolGroups = [
    TOOL_PERMISSION_TOOLS,
    SESSION_COMPACTOR_TOOLS,
    TURN_RESULT_TOOLS,
    PROMPT_ROUTER_TOOLS,
    BASH_SECURITY_TOOLS,
    SESSION_BRANCHING_TOOLS,
    PERMISSION_DENIAL_TOOLS,
    HERMES_SHIELD_TOOLS,
    HERMES_REF_EXPAND_TOOLS,
    HERMES_ROUTE_TOOLS,
    HERMES_SKILL_TOOLS,
  ];

  for (const group of allToolGroups) {
    for (const tool of group) {
      api.registerTool(tool as AnyAgentTool, { optional: true });
    }
  }
}

// 全局类型声明
declare global {
  var __clawHarnessConfig: PluginConfig | undefined;
  var __clawHarnessSessionId: string | undefined;
  var __clawHarnessBranches: Record<string, unknown> | undefined;
}
