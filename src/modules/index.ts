/**
 * OpenClaw Agent Harness Modules
 * ==============================
 * 从 Claude Code 泄露源码中提炼的 AI Agent 核心基础设施。
 *
 * 模块列表:
 *   tool-permissions      - 工具权限拒绝追踪
 *   session-compactor     - 多轮对话自动压缩
 *   turn-result           - 结构化执行结果 + stop_reason
 *   prompt-router         - 智能路由 (command + tool 双重匹配)
 *   bash-security         - Bash/PowerShell 多层安全防御
 *   session-branching     - 会话分叉与合并
 *   permission-denial-log - 拒绝日志 (审计追踪)
 *
 * @example
 * import { ToolPermissionContext } from './tool-permissions';
 * import { SessionCompactor } from './session-compactor';
 * import { PromptRouter } from './prompt-router';
 * import { TurnResult } from './turn-result';
 * import { BashSecurity } from './bash-security';
 * import { SessionBranching } from './session-branching';
 * import { PermissionDenialLogger } from './permission-denial-log';
 */

export { ToolPermissionContext, PermissionDenial, BasicToolRegistry } from './tool-permissions';
export { SessionCompactor, CompactionResult } from './session-compactor';
export {
  TurnResult,
  UsageSummary,
  StopReason,
  createTurnResult,
  addUsage,
  isTerminalStopReason,
  formatTurnResult,
} from './turn-result';
export { PromptRouter, RoutedMatch, registerBuiltinCommands, registerBuiltinTools } from './prompt-router';
export {
  BashSecurity,
  SecurityCheckResult,
  DangerousCommandAlert,
  PathValidationResult,
  createBashSecurity,
} from './bash-security';
export {
  SessionBranching,
  BranchMetadata,
  MergeResult,
  BranchDiff,
  createBranching,
  listBranches,
  mergeBranch,
} from './session-branching';
export {
  PermissionDenialLogger,
  DenialEntry,
  DenialSummary,
  createDenialLogger,
  queryDenials,
  getDenialSummary,
} from './permission-denial-log';
