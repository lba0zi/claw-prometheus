/**
 * permission-denial-log.ts
 * 拒绝日志 - 为 OpenClaw AI Agent 记录和分析工具权限拒绝
 * 
 * @description
 * 记录所有工具权限拒绝事件，支持查询、统计和导出。
 * 使用 JSONL 格式存储，每行一条记录。
 * 
 * @example
 * ```typescript
 * const logger = new PermissionDenialLogger();
 * const entry = logger.log('exec', 'Destructive command', 'session-123');
 * const summary = logger.getSummary();
 * const markdown = logger.exportAsMarkdown();
 * ```
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** 单条拒绝记录 */
export interface DenialEntry {
  id: string;
  tool_name: string;
  reason: string;
  timestamp: string;
  session_id?: string;
  prompt_excerpt?: string;
  risk_level?: string;
  resolved?: boolean;
  resolved_at?: string;
}

/** 拒绝统计摘要 */
export interface DenialSummary {
  tool_name: string;
  count: number;
  reasons: string[];
  first_at: string;
  last_at: string;
  recent_rate?: number;
}

/** 查询过滤器 */
export interface DenialFilter {
  tool_name?: string;
  since?: Date;
  until?: Date;
  session_id?: string;
  limit?: number;
  offset?: number;
  resolved?: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

function generateId(): string {
  return `denial_${crypto.randomBytes(8).toString('hex')}`;
}

function formatDate(date: Date = new Date()): string {
  return date.toISOString();
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * 从文件读取所有行
 */
function readLines(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(line => line.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * 安全解析 JSONL 行
 */
function parseLine<T>(line: string, fallback: T): T {
  try {
    return JSON.parse(line) as T;
  } catch {
    return fallback;
  }
}

// ============================================================================
// PermissionDenialLogger
// ============================================================================

/**
 * 权限拒绝日志记录器
 * 
 * 功能：
 * 1. 记录拒绝事件到 JSONL 文件
 * 2. 查询拒绝历史
 * 3. 生成统计摘要
 * 4. 导出为 Markdown
 */
export class PermissionDenialLogger {
  private logFile: string;
  private indexFile: string;
  private cache: DenialEntry[];
  private cacheDirty: boolean;

  constructor(storagePath?: string) {
    const basePath = storagePath || this._getDefaultStoragePath();
    this.logFile = path.join(basePath, 'denial-log.jsonl');
    this.indexFile = path.join(basePath, 'denial-index.json');
    this.cache = [];
    this.cacheDirty = false;
    
    this._ensureStorage();
    this._loadCache();
  }

  /**
   * 获取默认存储路径
   */
  private _getDefaultStoragePath(): string {
    const home = process.env.OPENCLAW_HOME || 
      path.join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw');
    return home;
  }

  /**
   * 确保存储目录存在
   */
  private _ensureStorage(): void {
    ensureDir(path.dirname(this.logFile));
  }

  /**
   * 加载缓存
   */
  private _loadCache(): void {
    this.cache = readLines(this.logFile).map(line => 
      parseLine<DenialEntry>(line, {
        id: '',
        tool_name: '',
        reason: '',
        timestamp: '',
      } as DenialEntry)
    ).filter(entry => entry.id);
  }

  /**
   * 刷新缓存到磁盘
   */
  private _flushCache(): void {
    if (!this.cacheDirty) return;

    try {
      const content = this.cache.map(entry => JSON.stringify(entry)).join('\n');
      fs.writeFileSync(this.logFile, content + '\n', 'utf-8');
      this.cacheDirty = false;
    } catch (err) {
      console.error('Failed to flush denial log cache:', err);
    }
  }

  /**
   * 追加单条记录
   */
  private _appendEntry(entry: DenialEntry): void {
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', 'utf-8');
      this.cache.push(entry);
      this.cacheDirty = true;
    } catch (err) {
      console.error('Failed to append denial entry:', err);
      throw err;
    }
  }

  // ==========================================================================
  // Core Operations
  // ==========================================================================

  /**
   * 记录一次拒绝
   * 
   * @param toolName 被拒绝的工具名
   * @param reason 拒绝原因
   * @param sessionId 会话 ID（可选）
   * @param promptExcerpt 相关的提示摘录（可选）
   * @param riskLevel 风险等级（可选）
   */
  log(
    toolName: string,
    reason: string,
    sessionId?: string,
    promptExcerpt?: string,
    riskLevel?: string
  ): DenialEntry {
    const entry: DenialEntry = {
      id: generateId(),
      tool_name: toolName,
      reason,
      timestamp: formatDate(),
      session_id: sessionId,
      prompt_excerpt: promptExcerpt ? promptExcerpt.slice(0, 500) : undefined,
      risk_level: riskLevel,
      resolved: false,
    };

    this._appendEntry(entry);
    return entry;
  }

  /**
   * 查询拒绝记录
   * 
   * @param filter 查询过滤器
   */
  query(filter: DenialFilter = {}): DenialEntry[] {
    let results = [...this.cache];

    // 按工具名过滤
    if (filter.tool_name) {
      const toolLower = filter.tool_name.toLowerCase();
      results = results.filter(e => 
        e.tool_name.toLowerCase().includes(toolLower)
      );
    }

    // 按时间范围过滤
    if (filter.since) {
      const sinceTime = filter.since.getTime();
      results = results.filter(e => 
        new Date(e.timestamp).getTime() >= sinceTime
      );
    }

    if (filter.until) {
      const untilTime = filter.until.getTime();
      results = results.filter(e => 
        new Date(e.timestamp).getTime() <= untilTime
      );
    }

    // 按会话 ID 过滤
    if (filter.session_id) {
      results = results.filter(e => e.session_id === filter.session_id);
    }

    // 按已解决状态过滤
    if (filter.resolved !== undefined) {
      results = results.filter(e => e.resolved === filter.resolved);
    }

    // 排序（按时间倒序）
    results.sort((a, b) => 
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // 分页
    if (filter.offset) {
      results = results.slice(filter.offset);
    }

    if (filter.limit && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /**
   * 获取统计摘要
   * 
   * @param toolName 可选：只统计指定工具
   */
  getSummary(toolName?: string): DenialSummary | DenialSummary[] {
    const entries = toolName 
      ? this.cache.filter(e => e.tool_name.toLowerCase() === toolName.toLowerCase())
      : [...this.cache];

    if (toolName) {
      return this._buildSummary(entries, toolName);
    }

    // 按工具分组
    const byTool = new Map<string, DenialEntry[]>();
    for (const entry of entries) {
      const existing = byTool.get(entry.tool_name) || [];
      existing.push(entry);
      byTool.set(entry.tool_name, existing);
    }

    const summaries: DenialSummary[] = [];
    for (const [name, toolEntries] of byTool) {
      summaries.push(this._buildSummary(toolEntries, name));
    }

    return summaries.sort((a, b) => b.count - a.count);
  }

  /**
   * 构建单个工具的摘要
   */
  private _buildSummary(entries: DenialEntry[], toolName: string): DenialSummary {
    if (entries.length === 0) {
      return {
        tool_name: toolName,
        count: 0,
        reasons: [],
        first_at: new Date(0).toISOString(),
        last_at: new Date(0).toISOString(),
      };
    }

    // 统计原因
    const reasonCounts = new Map<string, number>();
    for (const entry of entries) {
      const reason = entry.reason;
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }

    // 按频率排序原因
    const reasons = Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason]) => reason);

    // 时间范围
    const timestamps = entries.map(e => new Date(e.timestamp).getTime());
    const firstAt = new Date(Math.min(...timestamps));
    const lastAt = new Date(Math.max(...timestamps));

    // 计算近期频率（最近 24 小时）
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentCount = entries.filter(e => 
      new Date(e.timestamp).getTime() > oneDayAgo
    ).length;

    return {
      tool_name: toolName,
      count: entries.length,
      reasons,
      first_at: firstAt.toISOString(),
      last_at: lastAt.toISOString(),
      recent_rate: recentCount,
    };
  }

  /**
   * 获取最近的拒绝记录
   */
  getRecentDenials(count: number = 10): DenialEntry[] {
    return this.query({ limit: count });
  }

  /**
   * 标记为已解决
   */
  resolve(entryId: string): boolean {
    const entry = this.cache.find(e => e.id === entryId);
    if (!entry) return false;

    entry.resolved = true;
    entry.resolved_at = formatDate();
    this.cacheDirty = true;
    
    return true;
  }

  /**
   * 清除旧记录
   * 
   * @param before 可选：只删除此日期之前的记录
   * @returns 删除的记录数量
   */
  clear(before?: Date): number {
    const beforeTime = before ? before.getTime() : Date.now();
    
    const toKeep = this.cache.filter(e => 
      new Date(e.timestamp).getTime() > beforeTime
    );

    const deletedCount = this.cache.length - toKeep.length;
    
    if (deletedCount > 0) {
      this.cache = toKeep;
      
      // 重写文件
      try {
        const content = this.cache.map(entry => JSON.stringify(entry)).join('\n');
        fs.writeFileSync(this.logFile, content + '\n', 'utf-8');
      } catch (err) {
        console.error('Failed to rewrite denial log:', err);
      }
    }

    return deletedCount;
  }

  /**
   * 导出为 Markdown 表格
   */
  exportAsMarkdown(): string {
    const entries = this.query({});
    const summaries = typeof this.getSummary() === 'object' 
      ? [this.getSummary() as DenialSummary]
      : this.getSummary() as DenialSummary[];

    const lines: string[] = [];

    // Header
    lines.push('# Permission Denial Log\n');
    lines.push(`Generated: ${formatDate()}\n`);
    lines.push('---\n');

    // Summary section
    lines.push('## Summary by Tool\n');
    lines.push('| Tool | Count | First Seen | Last Seen | Top Reasons |');
    lines.push('|------|-------|------------|-----------|-------------|');

    for (const summary of summaries) {
      const reasonList = summary.reasons.slice(0, 3).join(', ');
      lines.push(`| ${summary.tool_name} | ${summary.count} | ${summary.first_at.slice(0, 10)} | ${summary.last_at.slice(0, 10)} | ${reasonList} |`);
    }

    lines.push('\n');

    // Recent entries
    lines.push('## Recent Denials\n');
    lines.push('| ID | Tool | Reason | Session | Timestamp |');
    lines.push('|----|------|--------|---------|----------|');

    for (const entry of entries.slice(0, 50)) {
      const reason = entry.reason.length > 50 
        ? entry.reason.slice(0, 50) + '...' 
        : entry.reason;
      const session = entry.session_id || '-';
      lines.push(`| ${entry.id.slice(0, 8)} | ${entry.tool_name} | ${reason} | ${session.slice(0, 8)} | ${entry.timestamp.slice(0, 19)} |`);
    }

    lines.push('\n');
    lines.push('---\n');
    lines.push(`Total entries: ${entries.length}\n`);

    return lines.join('\n');
  }

  /**
   * 导出为 CSV
   */
  exportAsCsv(): string {
    const entries = this.query({});
    const lines: string[] = [];

    // Header
    lines.push('id,tool_name,reason,timestamp,session_id,risk_level,resolved,resolved_at');

    for (const entry of entries) {
      const row = [
        entry.id,
        `"${entry.tool_name.replace(/"/g, '""')}"`,
        `"${entry.reason.replace(/"/g, '""')}"`,
        entry.timestamp,
        entry.session_id || '',
        entry.risk_level || '',
        entry.resolved?.toString() || 'false',
        entry.resolved_at || '',
      ];
      lines.push(row.join(','));
    }

    return lines.join('\n');
  }

  // ==========================================================================
  // Analytics
  // ==========================================================================

  /**
   * 获取每日拒绝趋势
   */
  getDailyTrend(days: number = 7): Array<{ date: string; count: number }> {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const result: Array<{ date: string; count: number }> = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayStart = now - i * dayMs;
      const dayEnd = dayStart + dayMs;
      const dateStr = new Date(dayStart).toISOString().slice(0, 10);

      const count = this.cache.filter(e => {
        const t = new Date(e.timestamp).getTime();
        return t >= dayStart && t < dayEnd;
      }).length;

      result.push({ date: dateStr, count });
    }

    return result;
  }

  /**
   * 获取高频拒绝工具
   */
  getTopOffenders(limit: number = 5): DenialSummary[] {
    const summaries = this.getSummary() as DenialSummary[];
    return summaries.slice(0, limit);
  }

  /**
   * 获取常见的拒绝原因
   */
  getCommonReasons(limit: number = 5): Array<{ reason: string; count: number }> {
    const reasonCounts = new Map<string, number>();
    
    for (const entry of this.cache) {
      reasonCounts.set(entry.reason, (reasonCounts.get(entry.reason) || 0) + 1);
    }

    return Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([reason, count]) => ({ reason, count }));
  }

  // ==========================================================================
  // Utility
  // ==========================================================================

  /**
   * 获取记录总数
   */
  count(): number {
    return this.cache.length;
  }

  /**
   * 检查是否有未解决的拒绝
   */
  hasUnresolved(): boolean {
    return this.cache.some(e => !e.resolved);
  }

  /**
   * 清空所有记录（危险操作）
   */
  clearAll(): number {
    const count = this.cache.length;
    this.cache = [];
    try {
      fs.writeFileSync(this.logFile, '', 'utf-8');
    } catch (err) {
      console.error('Failed to clear denial log:', err);
    }
    return count;
  }
}

// ============================================================================
// Module Exports
// ============================================================================

export default PermissionDenialLogger;

export {
  PermissionDenialLogger,
};

export type {
  DenialEntry,
  DenialSummary,
  DenialFilter,
};
