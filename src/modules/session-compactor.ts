/**
 * session-compactor.ts
 * 会话压缩器 - 为 OpenClaw AI Agent 管理长对话的上下文压缩
 * 
 * @description
 * 当对话轮次达到阈值时，自动压缩旧的对话消息为摘要，
 * 保持上下文完整性的同时控制 token 消耗。
 * 
 * @example
 * ```typescript
 * const compactor = new SessionCompactor();
 * compactor.set_compaction_turns(10);
 * 
 * if (compactor.should_compact(11)) {
 *   const { summary, kept } = compactor.summarize_old_messages(messages);
 *   const context = compactor.build_compacted_context(summary, kept);
 * }
 * ```
 */

import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** 消息结构 */
export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string | Date;
  metadata?: Record<string, unknown>;
}

/** 压缩结果 */
export interface CompactionResult {
  summary: string;
  kept: Message[];
  compressedCount: number;
  tokensSaved?: number;
}

/** 对话历史 */
export interface ConversationHistory {
  sessionId: string;
  messages: Message[];
  turnCount: number;
  lastUpdated: string;
}

// ============================================================================
// TokenEstimator - Token 估算工具
// ============================================================================

/**
 * 简单的 Token 估算器
 * 使用经验公式：中文约 2 chars/token，英文约 4 chars/token
 */
export class TokenEstimator {
  /**
   * 估算文本的 token 数量
   * @param text 输入文本
   */
  static estimate(text: string): number {
    if (!text || text.length === 0) return 0;
    
    // 简单估算：按字符数 / 4 + 句子数
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishChars = text.length - chineseChars;
    
    // 中文约 1.5-2 chars/token，英文约 3-4 chars/token
    const chineseTokens = Math.ceil(chineseChars / 2);
    const englishTokens = Math.ceil(englishChars / 4);
    
    // 添加标记 token 估算（每条消息约 3-5 个标记）
    const messageOverhead = 4;
    
    return chineseTokens + englishTokens + messageOverhead;
  }

  /**
   * 估算消息数组的总 token 数
   */
  static estimateMessages(messages: Message[]): number {
    return messages.reduce((total, msg) => {
      return total + TokenEstimator.estimate(msg.content);
    }, 0);
  }
}

// ============================================================================
// SessionCompactor - 会话压缩器
// ============================================================================

/**
 * 会话压缩器
 * 
 * 功能：
 * 1. 判断是否需要压缩（基于轮次阈值）
 * 2. 将旧消息压缩为摘要
 * 3. 构建压缩后的上下文字符串
 */
export class SessionCompactor {
  /** 压缩触发阈值（轮次） */
  private _compact_after_turns: number;
  
  /** 单条消息最大 token 数 */
  private _max_tokens_per_message: number;
  
  /** 摘要系统提示 */
  private _summarizeSystemPrompt: string;

  constructor(options?: {
    compact_after_turns?: number;
    max_tokens_per_message?: number;
  }) {
    this._compact_after_turns = options?.compact_after_turns ?? 12;
    this._max_tokens_per_message = options?.max_tokens_per_message ?? 4000;
    this._summarizeSystemPrompt = `你是一个对话摘要助手。请简洁地总结以下对话历史，提取：
1. 主要话题和任务
2. 已完成的关键操作
3. 重要的决定或结论
4. 任何未解决或待处理的事项

保持摘要简洁但信息完整，便于后续上下文恢复。`;
  }

  // ============================================================================
  // Getters & Setters
  // ============================================================================

  /**
   * 获取压缩阈值
   */
  get_compaction_turns(): number {
    return this._compact_after_turns;
  }

  /**
   * 设置压缩阈值
   * @param n 轮次阈值
   */
  set_compaction_turns(n: number): void {
    if (n < 1) {
      throw new Error('Compaction threshold must be at least 1');
    }
    this._compact_after_turns = n;
  }

  /**
   * 获取单消息最大 token 数
   */
  get max_tokens_per_message(): number {
    return this._max_tokens_per_message;
  }

  /**
   * 设置单消息最大 token 数
   */
  set max_tokens_per_message(n: number) {
    if (n < 100) {
      throw new Error('Max tokens per message must be at least 100');
    }
    this._max_tokens_per_message = n;
  }

  // ============================================================================
  // Core Methods
  // ============================================================================

  /**
   * 判断是否应该压缩
   * @param turnCount 当前轮次
   */
  should_compact(turnCount: number): boolean {
    return turnCount >= this._compact_after_turns;
  }

  /**
   * 压缩旧消息
   * 
   * 策略：
   * 1. 保留最近 N 条消息（默认 4 条）
   * 2. 将更早的消息压缩为摘要
   * 3. 返回摘要和保留的消息
   * 
   * @param messages 对话消息列表
   * @param keepRecent 保留最近消息数量
   */
  summarize_old_messages(
    messages: Message[],
    keepRecent = 4
  ): CompactionResult {
    if (!messages || messages.length === 0) {
      return { summary: '', kept: [], compressedCount: 0 };
    }

    // 消息不足，不需要压缩
    if (messages.length <= keepRecent) {
      return {
        summary: '',
        kept: [...messages],
        compressedCount: 0,
      };
    }

    // 分割消息：需要压缩的部分 vs 保留的部分
    const toCompress = messages.slice(0, -keepRecent);
    const kept = messages.slice(-keepRecent);

    // 构建压缩内容
    const summaryContent = this._build_summary_content(toCompress);
    const estimatedTokens = TokenEstimator.estimate(summaryContent);

    // 生成摘要文本（这里使用简单的拼接+总结提示）
    // 在实际使用中，可能需要调用 LLM API 来生成真正的摘要
    const summary = this._generate_summary(toCompress);

    return {
      summary,
      kept,
      compressedCount: toCompress.length,
      tokensSaved: estimatedTokens,
    };
  }

  /**
   * 构建压缩后的上下文字符串
   * 
   * 格式：
   * ```
   * 以上是对话摘要:{summary}
   * 
   * 最近的对话:
   * {keptMessages}
   * ```
   * 
   * @param summary 压缩摘要
   * @param keptMessages 保留的消息
   */
  build_compacted_context(summary: string, keptMessages: Message[]): string {
    const parts: string[] = [];

    // 添加摘要部分
    if (summary && summary.length > 0) {
      parts.push(`以上是对话摘要:\n${summary}`);
    }

    // 添加最近对话部分
    if (keptMessages && keptMessages.length > 0) {
      const recentStr = keptMessages
        .map((msg) => this._format_message_brief(msg))
        .join('\n');
      parts.push(`\n最近的对话:\n${recentStr}`);
    }

    return parts.join('\n');
  }

  /**
   * 完整压缩流程
   * 
   * @param messages 所有对话消息
   * @param turnCount 当前轮次
   * @param keepRecent 保留最近消息数
   */
  compact(
    messages: Message[],
    turnCount: number,
    keepRecent = 4
  ): CompactionResult | null {
    if (!this.should_compact(turnCount)) {
      return null;
    }

    return this.summarize_old_messages(messages, keepRecent);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 构建摘要内容（用于发送给 LLM）
   */
  private _build_summary_content(messages: Message[]): string {
    return messages
      .map((msg) => `[${msg.role}]: ${msg.content}`)
      .join('\n---\n');
  }

  /**
   * 生成摘要（简单版本，实际应调用 LLM）
   * 
   * 这里提供一个基础实现，真实场景中应该：
   * 1. 将消息发送给 LLM
   * 2. 获取 LLM 生成的摘要
   * 3. 或者使用预设的模板填充
   */
  private _generate_summary(messages: Message[]): string {
    if (messages.length === 0) {
      return '(无历史对话)';
    }

    // 简单统计摘要
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const topics = this._extract_topics(messages);

    const lines: string[] = [
      `共 ${messages.length} 条消息（用户 ${userMessages.length} 条，助手 ${assistantMessages.length} 条）`,
    ];

    if (topics.length > 0) {
      lines.push(`涉及主题：${topics.slice(0, 5).join('、')}`);
    }

    // 提取首尾消息作为关键节点
    if (messages.length > 0) {
      const firstUserMsg = messages.find((m) => m.role === 'user');
      if (firstUserMsg && firstUserMsg.content.length > 100) {
        lines.push(`用户首条请求：${firstUserMsg.content.slice(0, 100)}...`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 提取对话主题（简单关键词提取）
   */
  private _extract_topics(messages: Message[]): string[] {
    const allText = messages.map((m) => m.content).join(' ');
    
    // 简单分词（实际应该用更好的 NLP 工具）
    const words = allText
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    // 统计词频
    const freq = new Map<string, number>();
    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    // 返回高频词
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);
  }

  /**
   * 格式化消息为简洁形式
   */
  private _format_message_brief(msg: Message): string {
    const role = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';
    let content = msg.content;
    
    // 截断过长内容
    const maxLen = 200;
    if (content.length > maxLen) {
      content = content.slice(0, maxLen) + '...';
    }
    
    return `${role} ${content}`;
  }
}

// ============================================================================
// ConversationHistoryManager - 对话历史管理器
// ============================================================================

/**
 * 对话历史管理器
 * 提供持久化存储和恢复功能
 */
export class ConversationHistoryManager {
  private storagePath: string;
  private maxHistoryAge: number; // 毫秒，默认 7 天

  constructor(
    storagePath?: string,
    maxHistoryAgeDays = 7
  ) {
    // 默认路径：.openclaw/history/
    this.storagePath = storagePath || this._get_default_storage_path();
    this.maxHistoryAge = maxHistoryAgeDays * 24 * 60 * 60 * 1000;
    
    this._ensure_storage_dir();
  }

  /**
   * 获取默认存储路径
   */
  private _get_default_storage_path(): string {
    const basePath = process.env.OPENCLAW_HOME || 
      path.join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw');
    return path.join(basePath, 'history');
  }

  /**
   * 确保存储目录存在
   */
  private _ensure_storage_dir(): void {
    try {
      if (!fs.existsSync(this.storagePath)) {
        fs.mkdirSync(this.storagePath, { recursive: true });
      }
    } catch (err) {
      console.error('Failed to create history storage directory:', err);
    }
  }

  /**
   * 保存对话历史
   */
  saveHistory(sessionId: string, messages: Message[]): void {
    const filePath = path.join(this.storagePath, `${sessionId}.json`);
    const history: ConversationHistory = {
      sessionId,
      messages,
      turnCount: messages.length,
      lastUpdated: new Date().toISOString(),
    };

    try {
      fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save conversation history:', err);
    }
  }

  /**
   * 加载对话历史
   */
  loadHistory(sessionId: string): ConversationHistory | null {
    const filePath = path.join(this.storagePath, `${sessionId}.json`);
    
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data) as ConversationHistory;
      }
    } catch (err) {
      console.error('Failed to load conversation history:', err);
    }
    
    return null;
  }

  /**
   * 清理过期历史
   */
  cleanupExpired(): number {
    let deletedCount = 0;
    const now = Date.now();

    try {
      const files = fs.readdirSync(this.storagePath);
      
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        const filePath = path.join(this.storagePath, file);
        const stat = fs.statSync(filePath);
        
        if (now - stat.mtimeMs > this.maxHistoryAge) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }
    } catch (err) {
      console.error('Failed to cleanup expired history:', err);
    }

    return deletedCount;
  }
}

// ============================================================================
// Module Exports
// ============================================================================

export default SessionCompactor;

export {
  SessionCompactor,
  TokenEstimator,
  ConversationHistoryManager,
};

export type {
  Message,
  CompactionResult,
  ConversationHistory,
};
