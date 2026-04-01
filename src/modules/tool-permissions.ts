/**
 * tool-permissions.ts
 * 工具权限系统 - 为 OpenClaw AI Agent 提供细粒度的工具访问控制
 * 
 * @description
 * 实现基于风险等级的工具体系，支持前缀匹配、拒绝列表和白名单。
 * 支持 4 级风险分类：safe | warning | dangerous | critical
 * 
 * @example
 * ```typescript
 * // 从拒绝列表创建权限上下文
 * const ctx = ToolPermissionContext.fromDenyList(['rm', 'format', 'del /s']);
 * const result = ctx.check('rm -rf /');
 * // result: { allowed: false, reason: 'Tool "rm" is explicitly denied' }
 * ```
 */

import * as path from 'path';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** 风险等级枚举 */
export type RiskLevel = 'safe' | 'warning' | 'dangerous' | 'critical';

/** 单个工具的注册信息 */
export interface ToolRegistration {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  registeredAt: Date;
}

/** 拒绝记录 */
export interface PermissionDenial {
  toolName: string;
  reason: string;
  deniedAt: Date;
}

/** 权限检查结果 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  riskLevel?: RiskLevel;
}

/** 工具注册表接口 */
export interface IToolRegistry {
  registerTool(name: string, description: string, riskLevel: RiskLevel): void;
  getTool(name: string): ToolRegistration | undefined;
  listTools(): ToolRegistration[];
}

/** 权限上下文接口 */
export interface IPermissionContext {
  blocks(toolName: string): boolean;
  getDenialReason(toolName: string): string | undefined;
  check(toolName: string): PermissionCheckResult;
}

// ============================================================================
// PermissionDenial - 拒绝记录类
// ============================================================================

/**
 * 表示一个工具被拒绝的记录
 */
export class PermissionDenial {
  public readonly toolName: string;
  public readonly reason: string;
  public readonly deniedAt: Date;

  constructor(toolName: string, reason: string) {
    this.toolName = toolName;
    this.reason = reason;
    this.deniedAt = new Date();
  }

  toJSON(): object {
    return {
      toolName: this.toolName,
      reason: this.reason,
      deniedAt: this.deniedAt.toISOString(),
    };
  }
}

// ============================================================================
// BasicToolRegistry - 工具注册表
// ============================================================================

/**
 * 基础工具注册表
 * 维护所有已注册工具的元数据
 */
export class BasicToolRegistry implements IToolRegistry {
  private tools: Map<string, ToolRegistration> = new Map();

  /**
   * 注册一个新工具
   * @param name 工具名称（支持通配符如 "Bash*"）
   * @param description 工具描述
   * @param riskLevel 风险等级
   */
  registerTool(name: string, description: string, riskLevel: RiskLevel): void {
    if (!name || name.trim().length === 0) {
      throw new Error('Tool name cannot be empty');
    }
    if (!['safe', 'warning', 'dangerous', 'critical'].includes(riskLevel)) {
      throw new Error(`Invalid risk level: ${riskLevel}`);
    }

    this.tools.set(name.toLowerCase(), {
      name: name.toLowerCase(),
      description,
      riskLevel,
      registeredAt: new Date(),
    });
  }

  /**
   * 获取工具注册信息
   * @param name 工具名称
   */
  getTool(name: string): ToolRegistration | undefined {
    const lower = name.toLowerCase();
    return this.tools.get(lower);
  }

  /**
   * 列出所有已注册的工具
   */
  listTools(): ToolRegistration[] {
    return Array.from(this.tools.values());
  }

  /**
   * 检查工具是否已注册
   */
  hasTool(name: string): boolean {
    return this.tools.has(name.toLowerCase());
  }
}

// ============================================================================
// ToolPermissionContext - 权限上下文
// ============================================================================

/**
 * 工具权限上下文
 * 核心组件：判断某个工具是否被阻止访问
 * 
 * @example
 * ```typescript
 * const ctx = new ToolPermissionContext();
 * ctx.registerTool('rm', 'Remove files', 'dangerous');
 * ctx.deny('rm', 'Requires confirmation');
 * 
 * ctx.blocks('rm'); // true
 * ctx.check('rm'); // { allowed: false, reason: 'Requires confirmation', riskLevel: 'dangerous' }
 * ```
 */
export class ToolPermissionContext implements IPermissionContext {
  private denials: Map<string, PermissionDenial> = new Map();
  private wildcardDenials: Array<{ prefix: string; denial: PermissionDenial }> = [];
  private registry: BasicToolRegistry;

  constructor(registry?: BasicToolRegistry) {
    this.registry = registry || new BasicToolRegistry();
  }

  /**
   * 从拒绝列表创建权限上下文（工厂方法）
   * 支持精确名称和前缀模式（如 "Bash*"）
   * 
   * @param denyList 拒绝列表，元素支持：
   *   - 精确名称: "rm", "format"
   *   - 前缀匹配: "Bash*", "PowerShell*"
   *   - 正则模式: "/^temp_.*$/"
   * @param defaultReason 默认拒绝原因
   */
  static fromDenyList(denyList: string[], defaultReason = 'Tool is on deny list'): ToolPermissionContext {
    const ctx = new ToolPermissionContext();
    
    for (const item of denyList) {
      if (item.endsWith('*')) {
        // 前缀匹配模式
        const prefix = item.slice(0, -1).toLowerCase();
        const denial = new PermissionDenial(item, `${defaultReason} (wildcard: ${item})`);
        ctx.wildcardDenials.push({ prefix, denial });
      } else if (item.startsWith('/') && item.endsWith('/')) {
        // 正则模式（预留扩展）
        // 目前简化为精确匹配
        ctx.deny(item.slice(1, -1), defaultReason);
      } else {
        // 精确匹配
        ctx.deny(item, defaultReason);
      }
    }
    
    return ctx;
  }

  /**
   * 拒绝指定工具
   * @param toolName 工具名称
   * @param reason 拒绝原因
   */
  deny(toolName: string, reason: string): void {
    const denial = new PermissionDenial(toolName, reason);
    this.denials.set(toolName.toLowerCase(), denial);
  }

  /**
   * 解除对工具的拒绝
   */
  allow(toolName: string): boolean {
    return this.denials.delete(toolName.toLowerCase());
  }

  /**
   * 检查工具是否被阻止
   * 支持前缀匹配：如果工具名匹配任何通配符前缀，则被阻止
   * 
   * @param toolName 工具名称
   */
  blocks(toolName: string): boolean {
    const lower = toolName.toLowerCase();
    
    // 精确匹配
    if (this.denials.has(lower)) {
      return true;
    }
    
    // 前缀匹配
    for (const { prefix } of this.wildcardDenials) {
      if (lower.startsWith(prefix)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 获取拒绝原因
   * @param toolName 工具名称
   */
  getDenialReason(toolName: string): string | undefined {
    const lower = toolName.toLowerCase();
    
    // 精确匹配
    const denial = this.denials.get(lower);
    if (denial) {
      return denial.reason;
    }
    
    // 前缀匹配
    for (const { prefix, denial: wildcardDenial } of this.wildcardDenials) {
      if (lower.startsWith(prefix)) {
        return wildcardDenial.reason;
      }
    }
    
    return undefined;
  }

  /**
   * 获取风险等级标签
   */
  private getRiskLevelLabel(risk: RiskLevel): string {
    const labels: Record<RiskLevel, string> = {
      safe: '🟢 Safe',
      warning: '🟡 Warning',
      dangerous: '🟠 Dangerous',
      critical: '🔴 Critical',
    };
    return labels[risk];
  }

  /**
   * 检查工具权限
   * @param toolName 工具名称
   */
  check(toolName: string): PermissionCheckResult {
    // 检查是否在拒绝列表
    if (this.blocks(toolName)) {
      return {
        allowed: false,
        reason: this.getDenialReason(toolName) || 'Tool is explicitly denied',
        riskLevel: this.registry.getTool(toolName)?.riskLevel,
      };
    }

    // 获取工具注册信息
    const tool = this.registry.getTool(toolName);
    if (!tool) {
      // 未注册的工具，默认允许（保守策略）
      return {
        allowed: true,
        riskLevel: undefined,
      };
    }

    // 基于风险等级判断
    switch (tool.riskLevel) {
      case 'critical':
        return {
          allowed: false,
          reason: `Critical risk tool "${toolName}" requires explicit allow`,
          riskLevel: 'critical',
        };
      case 'dangerous':
        return {
          allowed: true,
          reason: `Dangerous tool "${toolName}" - proceed with caution`,
          riskLevel: 'dangerous',
        };
      case 'warning':
        return {
          allowed: true,
          reason: `Warning: ${tool.description}`,
          riskLevel: 'warning',
        };
      default:
        return {
          allowed: true,
          riskLevel: 'safe',
        };
    }
  }

  /**
   * 获取底层注册表
   */
  getRegistry(): BasicToolRegistry {
    return this.registry;
  }

  /**
   * 导出当前拒绝列表
   */
  exportDenyList(): Array<{ tool: string; reason: string }> {
    const result: Array<{ tool: string; reason: string }> = [];
    
    for (const [tool, denial] of this.denials) {
      result.push({ tool, reason: denial.reason });
    }
    
    for (const { prefix, denial } of this.wildcardDenials) {
      result.push({ tool: `${prefix}*`, reason: denial.reason });
    }
    
    return result;
  }
}

// ============================================================================
// RiskLevelThresholds - 风险等级阈值
// ============================================================================

/**
 * 风险等级阈值配置
 */
export interface RiskLevelThresholds {
  safe: number;
  warning: number;
  dangerous: number;
  critical: number;
}

export const DEFAULT_RISK_THRESHOLDS: RiskLevelThresholds = {
  safe: 0,
  warning: 30,
  dangerous: 60,
  critical: 85,
};

// ============================================================================
// DefaultPermissionManager - 默认权限管理器（便捷工厂）
// ============================================================================

/**
 * 创建默认权限管理器
 * 预配置常见危险工具的拒绝规则
 */
export function createDefaultPermissionContext(): ToolPermissionContext {
  const ctx = new ToolPermissionContext();
  const registry = ctx.getRegistry();

  // 注册系统工具
  registry.registerTool('Bash', 'Execute bash/shell commands', 'dangerous');
  registry.registerTool('PowerShell', 'Execute PowerShell commands', 'dangerous');
  registry.registerTool('exec', 'Execute arbitrary shell commands', 'critical');
  registry.registerTool('delete', 'Delete files or records', 'dangerous');
  registry.registerTool('write', 'Write or create files', 'warning');
  registry.registerTool('edit', 'Edit existing files', 'warning');
  registry.registerTool('read', 'Read file contents', 'safe');
  registry.registerTool('web_fetch', 'Fetch web content', 'safe');
  registry.registerTool('web_search', 'Search the web', 'safe');
  registry.registerTool('message', 'Send messages to channels', 'warning');

  // 默认拒绝高危操作
  ctx.deny('exec', 'exec tool is disabled by default - use specific tools instead');
  ctx.deny('rm', 'rm command is disabled - use trash instead');
  ctx.deny('format', 'format command is disabled');
  ctx.deny('del', 'del command is disabled');

  return ctx;
}

// ============================================================================
// Module Exports
// ============================================================================

export default ToolPermissionContext;

export {
  ToolPermissionContext,
  BasicToolRegistry,
  PermissionDenial,
  createDefaultPermissionContext,
  DEFAULT_RISK_THRESHOLDS,
};

export type {
  RiskLevel,
  ToolRegistration,
  PermissionDenial as PermissionDenialRecord,
  PermissionCheckResult,
  IToolRegistry,
  IPermissionContext,
  RiskLevelThresholds,
};
