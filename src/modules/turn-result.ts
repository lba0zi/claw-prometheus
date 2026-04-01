/**
 * turn-result.ts
 * 结构化执行结果 - 为 OpenClaw AI Agent 提供统一的执行结果表示
 * 
 * @description
 * 定义并实现 TurnResult、UsageSummary、StopReason 等核心类型，
 * 提供增量 token 计算、结果格式化等工具函数。
 * 
 * @example
 * ```typescript
 * const result = newTurnResult({ prompt: 'Hello' });
 * addUsage(result, 'Hello', 'Hi there!');
 * console.log(formatResult(result));
 * ```
 */

import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** 停止原因枚举 */
export type StopReason = 
  | 'completed'        // 正常完成
  | 'max_turns_reached' // 达到最大轮次
  | 'max_budget_reached' // 达到预算上限
  | 'error'            // 执行错误
  | 'timeout'          // 超时
  | 'user_stop'        // 用户主动停止
  | 'unknown';         // 未知原因

/** Token 使用量摘要 */
export interface UsageSummary {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  total_cost?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    prompt_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
    text_tokens?: number;
  };
}

/** 单个匹配的命令 */
export interface MatchedCommand {
  name: string;
  score: number;
  handler?: string;
  executionTime?: number;
}

/** 单个匹配的工具 */
export interface MatchedTool {
  name: string;
  score: number;
  allowed: boolean;
  reason?: string;
}

/** 单个权限拒绝记录 */
export interface PermissionDenialRecord {
  tool_name: string;
  reason: string;
  timestamp: string;
  session_id?: string;
}

/** TurnResult 配置 */
export interface TurnResultConfig {
  sessionId?: string;
  prompt?: string;
  output?: string;
  matched_commands?: MatchedCommand[];
  matched_tools?: MatchedTool[];
  permission_denials?: PermissionDenialRecord[];
  usage?: Partial<UsageSummary>;
  stop_reason?: StopReason;
  timestamp?: string | Date;
  metadata?: Record<string, unknown>;
}

/** TurnResult 主结构 */
export interface TurnResult {
  /** 会话 ID */
  session_id: string;
  /** 用户输入 */
  prompt: string;
  /** 助手输出 */
  output: string;
  /** 匹配的命令列表 */
  matched_commands: MatchedCommand[];
  /** 匹配的工具列表 */
  matched_tools: MatchedTool[];
  /** 权限拒绝记录 */
  permission_denials: PermissionDenialRecord[];
  /** Token 使用量 */
  usage: UsageSummary;
  /** 停止原因 */
  stop_reason: StopReason;
  /** 时间戳 */
  timestamp: string;
  /** 错误信息（如果有） */
  error?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 执行耗时（毫秒） */
  execution_time_ms?: number;
}

// ============================================================================
// Token Estimator
// ============================================================================

/**
 * 简单 Token 估算器
 * 
 * 注意：这是一个近似估算。真实 token 数需要使用官方 tokenizer。
 * - 中文：约 2 chars/token
 * - 英文：约 4 chars/token
 */
export class TokenEstimator {
  /**
   * 估算文本的 token 数量
   */
  static estimate(text: string): number {
    if (!text || text.length === 0) return 0;
    
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishChars = text.length - chineseChars;
    
    const chineseTokens = Math.ceil(chineseChars / 2);
    const englishTokens = Math.ceil(englishChars / 4);
    
    return chineseTokens + englishTokens;
  }

  /**
   * 估算输入和输出的 token
   */
  static estimateIO(input: string, output: string): { input: number; output: number } {
    return {
      input: TokenEstimator.estimate(input),
      output: TokenEstimator.estimate(output),
    };
  }
}

// ============================================================================
// Stop Reason Utilities
// ============================================================================

/**
 * 判断停止原因是否为终态
 */
export function isTerminalStopReason(reason: StopReason): boolean {
  const terminalReasons: StopReason[] = [
    'completed',
    'max_turns_reached',
    'max_budget_reached',
    'error',
    'timeout',
    'user_stop',
  ];
  
  return terminalReasons.includes(reason);
}

/**
 * 获取停止原因的友好描述
 */
export function getStopReasonLabel(reason: StopReason): string {
  const labels: Record<StopReason, string> = {
    completed: '✅ 完成',
    max_turns_reached: '⏹️ 达到最大轮次',
    max_budget_reached: '💰 达到预算上限',
    error: '❌ 执行错误',
    timeout: '⏱️ 执行超时',
    user_stop: '🛑 用户停止',
    unknown: '❓ 未知',
  };
  
  return labels[reason] || labels.unknown;
}

/**
 * 判断是否为成功完成
 */
export function isSuccessfulStop(reason: StopReason): boolean {
  return reason === 'completed' || reason === 'user_stop';
}

// ============================================================================
// TurnResult Factory
// ============================================================================

/**
 * 创建新的 TurnResult
 */
export function newTurnResult(config: TurnResultConfig = {}): TurnResult {
  const now = new Date().toISOString();
  
  return {
    session_id: config.sessionId || generateSessionId(),
    prompt: config.prompt || '',
    output: config.output || '',
    matched_commands: config.matched_commands || [],
    matched_tools: config.matched_tools || [],
    permission_denials: config.permission_denials || [],
    usage: {
      input_tokens: config.usage?.input_tokens || 0,
      output_tokens: config.usage?.output_tokens || 0,
      total_tokens: config.usage?.total_tokens,
      total_cost: config.usage?.total_cost,
    },
    stop_reason: config.stop_reason || 'unknown',
    timestamp: config.timestamp || now,
    metadata: config.metadata,
  };
}

/**
 * 生成会话 ID
 */
export function generateSessionId(): string {
  return `sess_${crypto.randomBytes(16).toString('hex')}`;
}

// ============================================================================
// Usage Tracking
// ============================================================================

/**
 * 增量计算 token 使用量
 * 
 * @param result 现有结果
 * @param input 新增输入
 * @param output 新增输出
 * @param costPerToken 可选的 token 单价
 */
export function addUsage(
  result: TurnResult,
  input: string,
  output: string,
  costPerToken?: { input: number; output: number }
): TurnResult {
  const inputTokens = TokenEstimator.estimate(input);
  const outputTokens = TokenEstimator.estimate(output);
  
  const newUsage: UsageSummary = {
    input_tokens: result.usage.input_tokens + inputTokens,
    output_tokens: result.usage.output_tokens + outputTokens,
    total_tokens: (result.usage.total_tokens || 0) + inputTokens + outputTokens,
  };
  
  if (costPerToken) {
    const inputCost = inputTokens * costPerToken.input;
    const outputCost = outputTokens * costPerToken.output;
    newUsage.total_cost = (result.usage.total_cost || 0) + inputCost + outputCost;
  } else if (result.usage.total_cost !== undefined) {
    const ratio = (inputTokens + outputTokens) / 
      Math.max(1, (result.usage.input_tokens + result.usage.output_tokens));
    newUsage.total_cost = result.usage.total_cost * ratio;
  }
  
  return {
    ...result,
    usage: newUsage,
  };
}

/**
 * 合并两个 UsageSummary
 */
export function mergeUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: (a.total_tokens || a.input_tokens + a.output_tokens) + 
                  (b.total_tokens || b.input_tokens + b.output_tokens),
    total_cost: (a.total_cost || 0) + (b.total_cost || 0),
  };
}

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * 格式化 TurnResult 为可读字符串
 */
export function formatResult(
  result: TurnResult,
  options?: {
    truncate?: number;
    includeMetadata?: boolean;
    includeTimestamp?: boolean;
  }
): string {
  const opts = {
    truncate: 200,
    includeMetadata: false,
    includeTimestamp: true,
    ...options,
  };

  const parts: string[] = [];

  // Header
  parts.push('═══════════════════════════════════════');
  parts.push(`  Turn Result - ${result.session_id.slice(0, 16)}...`);
  parts.push('═══════════════════════════════════════');

  // Stop Reason
  parts.push(`\n⏹️  Stop Reason: ${getStopReasonLabel(result.stop_reason)}`);

  // Usage
  parts.push('\n📊 Token Usage:');
  parts.push(`   Input:  ${result.usage.input_tokens} tokens`);
  parts.push(`   Output: ${result.usage.output_tokens} tokens`);
  if (result.usage.total_tokens) {
    parts.push(`   Total:  ${result.usage.total_tokens} tokens`);
  }
  if (result.usage.total_cost !== undefined) {
    parts.push(`   Cost:   $${result.usage.total_cost.toFixed(6)}`);
  }

  // Prompt
  const promptPreview = result.prompt.length > opts.truncate
    ? result.prompt.slice(0, opts.truncate) + '...'
    : result.prompt;
  parts.push(`\n📥 Prompt:\n${promptPreview || '(empty)'}`);

  // Output
  const outputPreview = result.output.length > opts.truncate
    ? result.output.slice(0, opts.truncate) + '...'
    : result.output;
  parts.push(`\n📤 Output:\n${outputPreview || '(empty)'}`);

  // Matched Commands
  if (result.matched_commands.length > 0) {
    parts.push('\n⚡ Matched Commands:');
    for (const cmd of result.matched_commands) {
      parts.push(`   ${cmd.name} (score: ${cmd.score.toFixed(2)})`);
    }
  }

  // Matched Tools
  if (result.matched_tools.length > 0) {
    parts.push('\n🔧 Matched Tools:');
    for (const tool of result.matched_tools) {
      const status = tool.allowed ? '✅' : '❌';
      parts.push(`   ${status} ${tool.name} (score: ${tool.score.toFixed(2)})`);
    }
  }

  // Permission Denials
  if (result.permission_denials.length > 0) {
    parts.push('\n🚫 Permission Denials:');
    for (const denial of result.permission_denials) {
      parts.push(`   - ${denial.tool_name}: ${denial.reason}`);
    }
  }

  // Error
  if (result.error) {
    parts.push(`\n❗ Error: ${result.error}`);
  }

  // Metadata
  if (opts.includeMetadata && result.metadata) {
    parts.push('\n📋 Metadata:');
    parts.push(`   ${JSON.stringify(result.metadata)}`);
  }

  // Timestamp
  if (opts.includeTimestamp) {
    parts.push(`\n🕐 Timestamp: ${result.timestamp}`);
  }

  // Execution Time
  if (result.execution_time_ms !== undefined) {
    parts.push(`⏱️  Execution: ${result.execution_time_ms}ms`);
  }

  parts.push('\n═══════════════════════════════════════');

  return parts.join('\n');
}

/**
 * 格式化为简洁的一行摘要
 */
export function formatResultBrief(result: TurnResult): string {
  const parts: string[] = [];
  
  parts.push(`[${getStopReasonLabel(result.stop_reason)}]`);
  parts.push(`in:${result.usage.input_tokens}`);
  parts.push(`out:${result.usage.output_tokens}`);
  
  if (result.permission_denials.length > 0) {
    parts.push(`denials:${result.permission_denials.length}`);
  }
  
  if (result.matched_commands.length > 0) {
    parts.push(`cmds:${result.matched_commands.map(c => c.name).join(',')}`);
  }
  
  if (result.error) {
    parts.push(`error:${result.error.slice(0, 50)}`);
  }
  
  return parts.join(' ');
}

/**
 * 导出为 JSON 格式
 */
export function toJSON(result: TurnResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * 从 JSON 创建 TurnResult
 */
export function fromJSON(json: string): TurnResult {
  try {
    const parsed = JSON.parse(json);
    return parsed as TurnResult;
  } catch (err) {
    throw new Error(`Failed to parse TurnResult from JSON: ${err}`);
  }
}

// ============================================================================
// Result Builder Pattern
// ============================================================================

/**
 * TurnResult 构建器
 * 提供流式 API 构建复杂结果
 */
export class TurnResultBuilder {
  private result: TurnResult;

  constructor(sessionId?: string) {
    this.result = newTurnResult({ sessionId });
  }

  prompt(prompt: string): this {
    this.result.prompt = prompt;
    return this;
  }

  output(output: string): this {
    this.result.output = output;
    return this;
  }

  addCommand(name: string, score: number, handler?: string): this {
    this.result.matched_commands.push({ name, score, handler });
    return this;
  }

  addTool(name: string, score: number, allowed: boolean, reason?: string): this {
    this.result.matched_tools.push({ name, score, allowed, reason });
    return this;
  }

  addDenial(toolName: string, reason: string, sessionId?: string): this {
    this.result.permission_denials.push({
      tool_name: toolName,
      reason,
      timestamp: new Date().toISOString(),
      session_id: sessionId,
    });
    return this;
  }

  stopReason(reason: StopReason): this {
    this.result.stop_reason = reason;
    return this;
  }

  error(message: string): this {
    this.result.error = message;
    this.result.stop_reason = 'error';
    return this;
  }

  metadata(key: string, value: unknown): this {
    if (!this.result.metadata) {
      this.result.metadata = {};
    }
    this.result.metadata[key] = value;
    return this;
  }

  executionTime(ms: number): this {
    this.result.execution_time_ms = ms;
    return this;
  }

  usage(inputTokens: number, outputTokens: number, totalCost?: number): this {
    this.result.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      total_cost: totalCost,
    };
    return this;
  }

  build(): TurnResult {
    return { ...this.result };
  }
}

// ============================================================================
// Module Exports
// ============================================================================

export default TurnResult;

export {
  // Core types
  newTurnResult,
  addUsage,
  mergeUsage,
  formatResult,
  formatResultBrief,
  isTerminalStopReason,
  getStopReasonLabel,
  isSuccessfulStop,
  generateSessionId,
  TokenEstimator,
  TurnResultBuilder,
  toJSON,
  fromJSON,
};

export type {
  StopReason,
  UsageSummary,
  MatchedCommand,
  MatchedTool,
  PermissionDenialRecord,
  TurnResultConfig,
  TurnResult,
};
