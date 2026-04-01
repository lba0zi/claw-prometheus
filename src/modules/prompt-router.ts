/**
 * prompt-router.ts
 * 智能路由 - 为 OpenClaw AI Agent 提供命令和工具的智能匹配
 * 
 * @description
 * 分析用户输入，智能识别并路由到合适的命令或工具。
 * 支持关键词匹配、正则匹配、权重打分、上下文感知。
 * 
 * @example
 * ```typescript
 * const router = new PromptRouter();
 * router.registerCommand('git.commit', ['commit', '提交'], handler);
 * router.registerTool('read', ['read', '读取', '查看文件'], handler);
 * 
 * const matches = router.route('git commit -m "fix"');
 * // [{kind: 'command', name: 'git.commit', score: 0.95, reason: '正则匹配 git commit'}]
 * ```
 */

import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** 路由目标类型 */
export type RoutedKind = 'command' | 'tool';

/** 单个路由匹配结果 */
export interface RoutedMatch {
  kind: RoutedKind;
  name: string;
  score: number;
  reason: string;
  handler?: Function;
  metadata?: Record<string, unknown>;
}

/** 命令注册信息 */
export interface CommandRegistration {
  name: string;
  keywords: string[];
  handler?: Function;
  regex?: RegExp[];
  weight: number;
  registeredAt: Date;
  description?: string;
}

/** 工具注册信息 */
export interface ToolRegistration {
  name: string;
  keywords: string[];
  handler?: Function;
  regex?: RegExp[];
  weight: number;
  registeredAt: Date;
  description?: string;
}

/** 路由配置选项 */
export interface RouterOptions {
  /** 最大返回匹配数 */
  maxMatches?: number;
  /** 最低分数阈值 */
  minScore?: number;
  /** 命令优先级权重 */
  commandPriorityWeight?: number;
  /** 是否启用模糊匹配 */
  fuzzyEnabled?: boolean;
  /** 模糊匹配阈值 */
  fuzzyThreshold?: number;
}

// ============================================================================
// KeywordMatcher - 关键词匹配器
// ============================================================================

/**
 * 关键词匹配器
 * 支持精确匹配、前缀匹配、模糊匹配
 */
export class KeywordMatcher {
  /**
   * 精确匹配
   */
  static exactMatch(keyword: string, text: string, caseSensitive = false): boolean {
    if (!caseSensitive) {
      return text.toLowerCase().includes(keyword.toLowerCase());
    }
    return text.includes(keyword);
  }

  /**
   * 前缀匹配
   */
  static prefixMatch(keyword: string, text: string): boolean {
    const lowerText = text.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();
    
    // 检查是否以关键词开头
    if (lowerText.startsWith(lowerKeyword)) return true;
    
    // 检查是否包含完整词
    const words = lowerText.split(/\s+/);
    return words.some(word => word.startsWith(lowerKeyword));
  }

  /**
   * 子串匹配（宽松）
   */
  static substringMatch(keyword: string, text: string): boolean {
    return text.toLowerCase().includes(keyword.toLowerCase());
  }

  /**
   * 计算匹配分数
   * @returns 0-1 之间的分数
   */
  static score(keyword: string, text: string): number {
    const lowerText = text.toLowerCase();
    const lowerKeyword = keyword.toLowerCase();
    
    // 精确匹配（整个词）
    if (lowerText === lowerKeyword) return 1.0;
    
    // 前缀匹配开头
    if (lowerText.startsWith(lowerKeyword)) return 0.9;
    
    // 词边界前缀匹配
    const words = lowerText.split(/\s+/);
    if (words.some(word => word.startsWith(lowerKeyword))) return 0.8;
    
    // 子串匹配
    if (lowerText.includes(lowerKeyword)) {
      // 根据位置和长度调整分数
      const index = lowerText.indexOf(lowerKeyword);
      const positionScore = 1 - (index / lowerText.length);
      return 0.5 * positionScore + 0.3;
    }
    
    // 模糊匹配（简单 Jaccard）
    const similarity = this.jaccardSimilarity(lowerKeyword, lowerText);
    if (similarity > 0.3) {
      return similarity * 0.5;
    }
    
    return 0;
  }

  /**
   * Jaccard 相似度
   */
  private static jaccardSimilarity(a: string, b: string): number {
    const setA = new Set(a.split(''));
    const setB = new Set(b.split(''));
    
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    
    return intersection.size / union.size;
  }
}

// ============================================================================
// PromptRouter - 智能路由器
// ============================================================================

/**
 * 智能路由
 * 
 * 功能：
 * 1. 注册命令和工具
 * 2. 分析用户输入
 * 3. 返回匹配的候选列表（带分数排序）
 * 4. 支持正则匹配和关键词匹配
 * 5. 命令优先于工具（分数相同时）
 */
export class PromptRouter {
  private commands: Map<string, CommandRegistration> = new Map();
  private tools: Map<string, ToolRegistration> = new Map();
  private options: Required<RouterOptions>;

  constructor(options?: RouterOptions) {
    this.options = {
      maxMatches: 5,
      minScore: 0.1,
      commandPriorityWeight: 1.2,
      fuzzyEnabled: true,
      fuzzyThreshold: 0.3,
      ...options,
    };
  }

  // ============================================================================
  // Registration Methods
  // ============================================================================

  /**
   * 注册命令
   * @param name 命令名称（如 "git.commit", "task.create"）
   * @param keywords 触发关键词列表
   * @param handler 命令处理器
   * @param description 命令描述
   */
  registerCommand(
    name: string,
    keywords: string[],
    handler?: Function,
    description?: string
  ): void {
    if (!name || keywords.length === 0) {
      throw new Error('Command name and at least one keyword required');
    }

    // 编译正则模式
    const regexPatterns = this._extractRegexPatterns(keywords);
    
    this.commands.set(name.toLowerCase(), {
      name: name.toLowerCase(),
      keywords: keywords.map(k => k.toLowerCase()),
      handler,
      regex: regexPatterns,
      weight: 1.0,
      registeredAt: new Date(),
      description,
    });
  }

  /**
   * 注册工具
   * @param name 工具名称
   * @param keywords 触发关键词列表
   * @param handler 工具处理器
   * @param description 工具描述
   */
  registerTool(
    name: string,
    keywords: string[],
    handler?: Function,
    description?: string
  ): void {
    if (!name || keywords.length === 0) {
      throw new Error('Tool name and at least one keyword required');
    }

    const regexPatterns = this._extractRegexPatterns(keywords);
    
    this.tools.set(name.toLowerCase(), {
      name: name.toLowerCase(),
      keywords: keywords.map(k => k.toLowerCase()),
      handler,
      regex: regexPatterns,
      weight: 1.0,
      registeredAt: new Date(),
      description,
    });
  }

  /**
   * 批量注册
   */
  registerBulk(
    items: Array<{
      type: 'command' | 'tool';
      name: string;
      keywords: string[];
      handler?: Function;
      description?: string;
    }>
  ): void {
    for (const item of items) {
      if (item.type === 'command') {
        this.registerCommand(item.name, item.keywords, item.handler, item.description);
      } else {
        this.registerTool(item.name, item.keywords, item.handler, item.description);
      }
    }
  }

  // ============================================================================
  // Routing Methods
  // ============================================================================

  /**
   * 路由用户输入
   * @param prompt 用户输入
   * @returns 匹配的候选列表（按分数降序）
   */
  route(prompt: string): RoutedMatch[] {
    return this.routeWithContext(prompt, {});
  }

  /**
   * 带上下文的路由
   * 
   * @param prompt 用户输入
   * @param context 上下文信息（如当前目录、最近使用的命令等）
   */
  routeWithContext(prompt: string, context: Record<string, unknown> = {}): RoutedMatch[] {
    if (!prompt || prompt.trim().length === 0) {
      return [];
    }

    const results: RoutedMatch[] = [];
    const promptLower = prompt.toLowerCase().trim();

    // 1. 检查正则匹配（最高优先级）
    const regexMatches = this._checkRegexMatches(prompt);
    results.push(...regexMatches);

    // 2. 检查命令关键词匹配
    const commandMatches = this._checkKeywordMatches(prompt, promptLower, 'command');
    results.push(...commandMatches);

    // 3. 检查工具关键词匹配
    const toolMatches = this._checkKeywordMatches(prompt, promptLower, 'tool');
    results.push(...toolMatches);

    // 4. 上下文增强（如果提供了上下文）
    this._applyContextBoost(results, context);

    // 5. 排序和过滤
    const sorted = this._sortAndFilter(results);

    return sorted;
  }

  /**
   * 检查单个命令是否匹配
   */
  checkCommand(prompt: string, commandName: string): RoutedMatch | null {
    const results = this.route(prompt);
    return results.find(m => m.kind === 'command' && m.name === commandName) || null;
  }

  /**
   * 检查单个工具是否匹配
   */
  checkTool(prompt: string, toolName: string): RoutedMatch | null {
    const results = this.route(prompt);
    return results.find(m => m.kind === 'tool' && m.name === toolName) || null;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 从关键词中提取正则模式
   * 格式: /pattern/flags
   */
  private _extractRegexPatterns(keywords: string[]): RegExp[] {
    const regexes: RegExp[] = [];
    
    for (const keyword of keywords) {
      const match = keyword.match(/^\/(.+)\/([gimsuy]*)$/);
      if (match) {
        try {
          regexes.push(new RegExp(match[1], match[2]));
        } catch (err) {
          console.warn(`Invalid regex pattern: ${keyword}`);
        }
      }
    }
    
    return regexes;
  }

  /**
   * 检查正则匹配
   */
  private _checkRegexMatches(prompt: string): RoutedMatch[] {
    const results: RoutedMatch[] = [];

    // 检查命令
    for (const [name, cmd] of this.commands) {
      for (const regex of cmd.regex || []) {
        if (regex.test(prompt)) {
          results.push({
            kind: 'command',
            name: cmd.name,
            score: 1.0, // 正则匹配最高分
            reason: `正则匹配 ${regex.toString()}`,
            handler: cmd.handler,
          });
          break; // 每个命令只匹配一次
        }
      }
    }

    // 检查工具
    for (const [name, tool] of this.tools) {
      for (const regex of tool.regex || []) {
        if (regex.test(prompt)) {
          results.push({
            kind: 'tool',
            name: tool.name,
            score: 1.0,
            reason: `正则匹配 ${regex.toString()}`,
            handler: tool.handler,
          });
          break;
        }
      }
    }

    return results;
  }

  /**
   * 检查关键词匹配
   */
  private _checkKeywordMatches(
    prompt: string,
    promptLower: string,
    kind: RoutedKind
  ): RoutedMatch[] {
    const results: RoutedMatch[] = [];
    const registry = kind === 'command' ? this.commands : this.tools;

    for (const [name, reg] of registry) {
      let bestScore = 0;
      let bestReason = '';

      for (const keyword of reg.keywords) {
        const score = KeywordMatcher.score(keyword, promptLower);
        
        if (score > bestScore) {
          bestScore = score;
          bestReason = this._getMatchReason(keyword, promptLower);
        }
      }

      if (bestScore >= this.options.minScore) {
        results.push({
          kind,
          name: reg.name,
          score: bestScore,
          reason: bestReason,
          handler: reg.handler,
          metadata: {
            description: reg.description,
          },
        });
      }
    }

    return results;
  }

  /**
   * 获取匹配原因描述
   */
  private _getMatchReason(keyword: string, promptLower: string): string {
    if (promptLower === keyword) return `精确匹配 "${keyword}"`;
    if (promptLower.startsWith(keyword)) return `前缀匹配 "${keyword}"`;
    if (promptLower.includes(keyword)) return `包含 "${keyword}"`;
    return `模糊匹配 "${keyword}"`;
  }

  /**
   * 应用上下文增强
   */
  private _applyContextBoost(
    results: RoutedMatch[],
    context: Record<string, unknown>
  ): void {
    if (!context || Object.keys(context).length === 0) return;

    // 如果当前目录匹配，增加相关命令分数
    const cwd = context['cwd'] as string;
    if (cwd) {
      for (const result of results) {
        // 简单启发式：如果命令名包含目录名的一部分，增加分数
        if (result.kind === 'command') {
          const cmdParts = result.name.split('.');
          if (cmdParts.some(part => cwd.toLowerCase().includes(part))) {
            result.score *= 1.1;
          }
        }
      }
    }
  }

  /**
   * 排序和过滤
   */
  private _sortAndFilter(results: RoutedMatch[]): RoutedMatch[] {
    // 去重：相同 kind+name 只保留最高分
    const deduped = new Map<string, RoutedMatch>();
    for (const result of results) {
      const key = `${result.kind}:${result.name}`;
      const existing = deduped.get(key);
      if (!existing || result.score > existing.score) {
        deduped.set(key, result);
      }
    }

    // 转换为数组
    let sorted = Array.from(deduped.values());

    // 应用命令优先级权重
    for (const result of sorted) {
      if (result.kind === 'command') {
        result.score *= this.options.commandPriorityWeight;
      }
    }

    // 排序：先按分数降序，分数相同则命令优先
    sorted.sort((a, b) => {
      if (Math.abs(a.score - b.score) < 0.01) {
        // 分数相近时，命令优先
        if (a.kind === 'command' && b.kind === 'tool') return -1;
        if (a.kind === 'tool' && b.kind === 'command') return 1;
      }
      return b.score - a.score;
    });

    // 截取最大数量
    return sorted.slice(0, this.options.maxMatches);
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * 列出所有注册的路由
   */
  listRoutes(): Array<{ kind: RoutedKind; name: string; keywords: string[]; description?: string }> {
    const routes: Array<{ kind: RoutedKind; name: string; keywords: string[]; description?: string }> = [];

    for (const cmd of this.commands.values()) {
      routes.push({
        kind: 'command',
        name: cmd.name,
        keywords: cmd.keywords,
        description: cmd.description,
      });
    }

    for (const tool of this.tools.values()) {
      routes.push({
        kind: 'tool',
        name: tool.name,
        keywords: tool.keywords,
        description: tool.description,
      });
    }

    return routes;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    commandCount: number;
    toolCount: number;
    totalKeywords: number;
  } {
    let totalKeywords = 0;
    
    for (const cmd of this.commands.values()) {
      totalKeywords += cmd.keywords.length;
    }
    
    for (const tool of this.tools.values()) {
      totalKeywords += tool.keywords.length;
    }

    return {
      commandCount: this.commands.size,
      toolCount: this.tools.size,
      totalKeywords,
    };
  }

  /**
   * 清除所有注册
   */
  clear(): void {
    this.commands.clear();
    this.tools.clear();
  }
}

// ============================================================================
// Default Router Factory
// ============================================================================

/**
 * 创建默认路由器
 * 预注册常见命令和工具
 */
export function createDefaultRouter(): PromptRouter {
  const router = new PromptRouter();

  // 常见命令
  router.registerCommand('git.commit', ['commit', '提交', 'git commit'], undefined, 'Git 提交');
  router.registerCommand('git.push', ['push', '推送', 'git push'], undefined, 'Git 推送');
  router.registerCommand('git.pull', ['pull', '拉取', 'git pull'], undefined, 'Git 拉取');
  router.registerCommand('git.status', ['status', '状态', 'git status'], undefined, 'Git 状态');
  router.registerCommand('git.branch', ['branch', '分支'], undefined, 'Git 分支');

  router.registerCommand('task.create', ['create task', '新建任务', '创建任务'], undefined, '创建任务');
  router.registerCommand('task.list', ['list tasks', '任务列表', '查看任务'], undefined, '查看任务');

  // 常见工具
  router.registerTool('read', ['read', '读取', '查看', 'cat'], undefined, '读取文件');
  router.registerTool('write', ['write', '写入', '创建文件'], undefined, '写入文件');
  router.registerTool('edit', ['edit', '编辑', '修改'], undefined, '编辑文件');
  router.registerTool('exec', ['exec', '执行', '运行'], undefined, '执行命令');
  router.registerTool('search', ['search', '搜索', 'find'], undefined, '搜索');
  router.registerTool('web_fetch', ['fetch', '获取网页'], undefined, '获取网页');
  router.registerTool('web_search', ['search', '搜索', 'google'], undefined, '网络搜索');

  return router;
}

// ============================================================================
// Module Exports
// ============================================================================

export default PromptRouter;

export {
  PromptRouter,
  KeywordMatcher,
  createDefaultRouter,
};

export type {
  RoutedKind,
  RoutedMatch,
  CommandRegistration,
  ToolRegistration,
  RouterOptions,
};
