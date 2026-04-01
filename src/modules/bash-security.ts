/**
 * bash-security.ts
 * Bash/PowerShell 安全模块 - 为 OpenClaw AI Agent 提供命令安全检查
 * 
 * @description
 * 实现危险命令检测、路径验证、沙箱环境判断等安全功能。
 * 专门针对 Windows (PowerShell) 和 Unix (Bash) 环境优化。
 * 
 * @example
 * ```typescript
 * const security = new BashSecurity();
 * const result = security.analyzeCommand('rm -rf /tmp/*');
 * // result: { passed: false, blocked: true, blockReason: '...' }
 * ```
 */

import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** 风险等级 */
export type RiskLevel = 'safe' | 'warning' | 'dangerous' | 'critical';

/** 危险命令模式 */
export interface DangerousCommandPattern {
  pattern: RegExp;
  risk: Exclude<RiskLevel, 'safe'>;
  message: string;
  suggestion?: string;
}

/** 路径验证结果 */
export interface PathValidationResult {
  valid: boolean;
  reason?: string;
  checks: {
    parentTraversal: boolean;
    systemPath: boolean;
    networkPath: boolean;
    readOnlyPath: boolean;
  };
}

/** 安全警告 */
export interface Warning {
  type: string;
  message: string;
  detail?: string;
}

/** 安全检查结果 */
export interface SecurityCheckResult {
  passed: boolean;
  warnings: Warning[];
  blocked: boolean;
  blockReason?: string;
  riskLevel?: RiskLevel;
  sanitizedCommand?: string;
}

// ============================================================================
// DangerousCommandPattern - 危险命令模式库
// ============================================================================

/**
 * 预定义的危险命令模式
 */
export const DANGEROUS_PATTERNS: DangerousCommandPattern[] = [
  // === Critical: 数据破坏 ===
  {
    pattern: /rm\s+(-[rfv]+\s+)*\/\s*$/i,
    risk: 'critical',
    message: 'Recursive root delete detected',
    suggestion: 'Use "rm -rf /tmp/*" instead for temp files',
  },
  {
    pattern: /del\s+(\/[sfq]\s+)+[a-z]:\\/i,
    risk: 'critical',
    message: 'Recursive Windows delete detected',
    suggestion: 'Use Remove-Item with specific paths',
  },
  {
    pattern: /format\s+[a-z]:/i,
    risk: 'critical',
    message: 'Format command detected',
    suggestion: 'Formatting drives is extremely dangerous',
  },
  {
    pattern: /^\s*shred\s+/i,
    risk: 'critical',
    message: 'Secure delete (shred) detected',
    suggestion: 'Use recycle bin instead',
  },
  // === Critical: 系统修改 ===
  {
    pattern: /dd\s+(if=|of=)/i,
    risk: 'critical',
    message: 'dd command with file I/O detected',
    suggestion: 'dd can destroy disks - use with extreme caution',
  },
  {
    pattern: /mkfs\s+/i,
    risk: 'critical',
    message: 'Filesystem format detected',
    suggestion: 'Creating filesystems is destructive',
  },
  // === Dangerous: 网络相关 ===
  {
    pattern: /curl\s+.*\|\s*sh/i,
    risk: 'dangerous',
    message: 'Pipe to shell (curl | sh) detected',
    suggestion: 'Download scripts and inspect before running',
  },
  {
    pattern: /wget\s+.*\|\s*sh/i,
    risk: 'dangerous',
    message: 'Pipe to shell (wget | sh) detected',
    suggestion: 'Download scripts and inspect before running',
  },
  {
    pattern: /Invoke-WebRequest.*\|.*Invoke-Expression/i,
    risk: 'dangerous',
    message: 'PowerShell web download + execute pattern',
    suggestion: 'Download first, inspect, then execute if safe',
  },
  {
    pattern: /Invoke-Expression\s+\(.*WebRequest/i,
    risk: 'dangerous',
    message: 'PowerShell IEX with web content',
    suggestion: 'Use Start-Process or & operator instead',
  },
  // === Dangerous: 凭据/密钥 ===
  {
    pattern: /chmod\s+[47]777/i,
    risk: 'dangerous',
    message: 'World-writable permission detected',
    suggestion: 'Use more restrictive permissions',
  },
  {
    pattern: /setx\s+[A-Z_]+\s+.+/i,
    risk: 'dangerous',
    message: 'Persistent environment variable modification',
    suggestion: 'Use session-scoped environment variables',
  },
  // === Dangerous: 进程/服务 ===
  {
    pattern: /kill\s+-9\s+1$/i,
    risk: 'dangerous',
    message: 'Kill init/process 1 detected',
    suggestion: 'This can crash the system',
  },
  {
    pattern: /pkill\s+-\s*9/i,
    risk: 'dangerous',
    message: 'Force kill all processes pattern',
    suggestion: 'Target specific processes instead',
  },
  // === Dangerous: 覆盖/重定向 ===
  {
    pattern: />\s*\/dev\/sda/i,
    risk: 'dangerous',
    message: 'Direct write to block device',
    suggestion: 'This can destroy data',
  },
  {
    pattern: /\|\s*cat\s*>/i,
    risk: 'dangerous',
    message: 'Pipe redirect to file detected',
    suggestion: 'Use explicit file operations',
  },
  // === Warning: 脚本执行 ===
  {
    pattern: /bash\s+<.*http/i,
    risk: 'warning',
    message: 'Bash with HTTP input',
    suggestion: 'Download and inspect script first',
  },
  {
    pattern: /source\s+.*http/i,
    risk: 'warning',
    message: 'Source from HTTP detected',
    suggestion: 'Use local files only',
  },
  // === Warning: 持久化 ===
  {
    pattern: /crontab\s+-r/i,
    risk: 'warning',
    message: 'Remove crontab detected',
    suggestion: 'Use crontab -l to view first',
  },
  {
    pattern: /schtasks\s+\/delete/i,
    risk: 'warning',
    message: 'Delete scheduled task',
    suggestion: 'Verify task name before deletion',
  },
  // === Warning: 系统信息收集 ===
  {
    pattern: /cat\s+\/etc\/passwd/i,
    risk: 'warning',
    message: 'Reading password file',
    suggestion: 'This is often used in reconnaissance',
  },
  {
    pattern: /reg\s+(query|export)\s+hklm/i,
    risk: 'warning',
    message: 'Windows registry system hive access',
    suggestion: 'May be used for credential theft detection',
  },
];

// ============================================================================
// System Path Definitions
// ============================================================================

/**
 * Windows 关键系统路径
 */
const WINDOWS_CRITICAL_PATHS = [
  process.env.WINDIR || 'C:\\Windows',
  process.env.SYSTEMROOT || 'C:\\Windows\\System32',
  process.env.PROGRAMFILES || 'C:\\Program Files',
  process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
  'C:\\Boot',
  'C:\\Recovery',
  'C:\\System Volume Information',
].filter(Boolean);

/**
 * Unix 关键系统路径
 */
const UNIX_CRITICAL_PATHS = [
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/etc',
  '/sys',
  '/proc',
  '/boot',
  '/root',
  '/lib',
  '/lib64',
  '/opt',
  '/srv',
];

/**
 * 只读路径
 */
const READONLY_PATHS = [
  '/sys',
  '/proc',
  '/boot',
  'C:\\Windows\\WinSxS',
  'C:\\Windows\\Installer',
];

// ============================================================================
// BashSecurity - Bash 安全检查器
// ============================================================================

/**
 * Bash/PowerShell 安全检查器
 */
export class BashSecurity {
  private customPatterns: DangerousCommandPattern[] = [];
  private enabledChecks: Set<string> = new Set([
    'dangerous_commands',
    'path_traversal',
    'system_paths',
    'network_paths',
    'readonly_paths',
    'sandbox_detection',
  ]);

  constructor(options?: {
    customPatterns?: DangerousCommandPattern[];
    enabledChecks?: string[];
  }) {
    if (options?.customPatterns) {
      this.customPatterns = [...options.customPatterns];
    }
    if (options?.enabledChecks) {
      this.enabledChecks = new Set(options.enabledChecks);
    }
  }

  /**
   * 获取所有危险模式
   */
  getAllPatterns(): DangerousCommandPattern[] {
    return [...DANGEROUS_PATTERNS, ...this.customPatterns];
  }

  /**
   * 添加自定义危险模式
   */
  addPattern(pattern: DangerousCommandPattern): void {
    this.customPatterns.push(pattern);
  }

  /**
   * 设置启用的检查项
   */
  setEnabledChecks(checks: string[]): void {
    this.enabledChecks = new Set(checks);
  }

  // ==========================================================================
  // Path Validation
  // ==========================================================================

  /**
   * 验证路径安全性
   */
  validatePath(inputPath: string): PathValidationResult {
    const checks = {
      parentTraversal: false,
      systemPath: false,
      networkPath: false,
      readOnlyPath: false,
    };

    let reason: string | undefined;

    // 检查父目录遍历
    if (this.checkParentTraversal(inputPath)) {
      checks.parentTraversal = true;
      reason = 'Path traversal (../) detected';
    }

    // 检查系统路径
    if (this.checkSystemPaths(inputPath)) {
      checks.systemPath = true;
      reason = reason || 'System path access detected';
    }

    // 检查网络路径
    if (this.checkNetworkPaths(inputPath)) {
      checks.networkPath = true;
      reason = reason || 'Network path detected';
    }

    // 检查只读路径
    if (this.checkReadOnlyPaths(inputPath)) {
      checks.readOnlyPath = true;
      reason = reason || 'Read-only path detected';
    }

    return {
      valid: !Object.values(checks).some(Boolean),
      reason,
      checks,
    };
  }

  /**
   * 检查路径遍历攻击
   * 防止 ../ 穿越到系统目录
   */
  checkParentTraversal(inputPath: string): boolean {
    // Windows style
    if (/\\\.\.\\|^\.\.\\|\/\.\.\//i.test(inputPath)) {
      return true;
    }
    
    // 规范化后检查
    try {
      const normalized = path.normalize(inputPath);
      if (normalized.includes('..')) {
        return true;
      }
    } catch {
      // Ignore normalization errors
    }

    return false;
  }

  /**
   * 检查是否访问系统路径
   */
  checkSystemPaths(inputPath: string): boolean {
    const normalized = path.normalize(inputPath);
    const lower = normalized.toLowerCase();

    // Windows check
    for (const sysPath of WINDOWS_CRITICAL_PATHS) {
      if (lower.startsWith(sysPath.toLowerCase())) {
        return true;
      }
    }

    // Unix check
    for (const sysPath of UNIX_CRITICAL_PATHS) {
      if (lower.startsWith(sysPath.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  /**
   * 检查网络路径
   */
  checkNetworkPaths(inputPath: string): boolean {
    // UNC paths (Windows)
    if (/^\\\\|^[a-z]:\\{2}/i.test(inputPath)) {
      return true;
    }
    
    // Network protocols
    if (/^(https?|ftp|sftp|ssh):\/\//i.test(inputPath)) {
      return true;
    }

    // Unix NFS/CIFS
    if (/^~\/|^\/mnt\/|^\/net\//i.test(inputPath)) {
      return true;
    }

    return false;
  }

  /**
   * 检查只读路径
   */
  checkReadOnlyPaths(inputPath: string): boolean {
    const normalized = path.normalize(inputPath);
    const lower = normalized.toLowerCase();

    for (const roPath of READONLY_PATHS) {
      if (lower.startsWith(roPath.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  // ==========================================================================
  // Sandboxing Detection
  // ==========================================================================

  /**
   * 检测是否应该启用沙箱
   */
  shouldSandbox(command: string): boolean {
    const platform = process.platform;

    // 检测容器/虚拟化环境
    if (this.isInContainer()) {
      return true;
    }

    // 检测 Hyper-V 虚拟机
    if (this.isInHyperV()) {
      return true;
    }

    // 检测 WSL 环境
    if (this.isInWSL()) {
      return true;
    }

    // 检测受限shell
    if (this.isRestrictedShell()) {
      return true;
    }

    return false;
  }

  /**
   * 检测容器环境
   */
  isInContainer(): boolean {
    // Docker
    if (fs.existsSync('/.dockerenv')) return true;
    
    // Cgroups
    try {
      if (fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker')) {
        return true;
      }
    } catch {
      // Ignore
    }

    // Kubernetes
    if (process.env.KUBERNETES_SERVICE_HOST) return true;

    return false;
  }

  /**
   * 检测 Hyper-V 虚拟机
   */
  isInHyperV(): boolean {
    // Windows Hyper-V detection via registry
    if (process.platform === 'win32') {
      try {
        // This is a simplified check
        const hvGuid = '{8e3a0d16-cef3-5a4f-a0b8-4e70f25f9cfd}';
        // Full implementation would check registry
      } catch {
        // Ignore
      }
    }

    // Linux kvm hypervisor
    try {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      if (/hypervisor|virt/i.test(cpuinfo)) {
        // Further check for Hyper-V specifically
        if (/hypervisor.*microsoft/i.test(cpuinfo)) {
          return true;
        }
      }
    } catch {
      // Ignore
    }

    return false;
  }

  /**
   * 检测 WSL 环境
   */
  isInWSL(): boolean {
    // WSL detection via /proc/version
    try {
      const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      if (version.includes('microsoft') || version.includes('wsl')) {
        return true;
      }
    } catch {
      // Ignore
    }

    // WSLENV
    if (process.env.WSLENV) return true;

    return false;
  }

  /**
   * 检测受限 shell
   */
  isRestrictedShell(): boolean {
    // $SHELL_RESTRICTED or similar
    if (process.env.SHELL_RESTRICTED) return true;
    
    // Check if running with rbash or similar
    const shell = process.env.SHELL || '';
    if (/rbash|rksh|restricted/i.test(shell)) {
      return true;
    }

    return false;
  }

  // ==========================================================================
  // Dangerous Command Detection
  // ==========================================================================

  /**
   * 检查危险命令
   */
  checkDangerousCommand(command: string): {
    risk: string;
    message: string;
    suggestions?: string[];
  } | null {
    for (const pattern of this.getAllPatterns()) {
      if (pattern.pattern.test(command)) {
        return {
          risk: pattern.risk,
          message: pattern.message,
          suggestions: pattern.suggestion ? [pattern.suggestion] : undefined,
        };
      }
    }

    return null;
  }

  /**
   * 提取命令中的路径参数
   */
  extractPaths(command: string): string[] {
    const paths: string[] = [];
    
    // Simple regex for common path patterns
    // Unix: /path, ~/path
    const unixPattern = /(?<!\S)([\/~]\/[^\s'"]+)/g;
    let match;
    while ((match = unixPattern.exec(command)) !== null) {
      paths.push(match[1]);
    }

    // Windows: C:\path, \\server\share
    const winPattern = /([a-zA-Z]:\\[^\s'"]+|\\\\[^\s'"]+)/g;
    while ((match = winPattern.exec(command)) !== null) {
      paths.push(match[1]);
    }

    return [...new Set(paths)]; // Dedupe
  }

  // ==========================================================================
  // Sanitization
  // ==========================================================================

  /**
   * 尝试清理命令（移除危险部分）
   */
  sanitizeCommand(command: string): string {
    let sanitized = command;

    // Remove comment blocks
    sanitized = sanitized.replace(/#.*$/gm, '');
    sanitized = sanitized.replace(/--\s.*$/gm, '');

    // Remove dangerous patterns
    const dangerous = this.getAllPatterns();
    for (const pattern of dangerous) {
      if (pattern.risk === 'critical' || pattern.risk === 'dangerous') {
        // Replace with placeholder
        sanitized = sanitized.replace(pattern.pattern, `[BLOCKED: ${pattern.message}]`);
      }
    }

    return sanitized.trim();
  }

  // ==========================================================================
  // Main Analysis
  // ==========================================================================

  /**
   * 综合安全检查
   */
  analyzeCommand(command: string): SecurityCheckResult {
    const result: SecurityCheckResult = {
      passed: true,
      warnings: [],
      blocked: false,
    };

    // Skip empty commands
    if (!command || command.trim().length === 0) {
      return result;
    }

    // 1. 危险命令检查
    if (this.enabledChecks.has('dangerous_commands')) {
      const danger = this.checkDangerousCommand(command);
      if (danger) {
        result.warnings.push({
          type: danger.risk,
          message: danger.message,
          detail: danger.suggestions?.join('; '),
        });

        if (danger.risk === 'critical') {
          result.blocked = true;
          result.blockReason = danger.message;
          result.passed = false;
        }

        result.riskLevel = danger.risk as RiskLevel;
      }
    }

    // 2. 路径验证
    if (this.enabledChecks.has('path_traversal') ||
        this.enabledChecks.has('system_paths') ||
        this.enabledChecks.has('readonly_paths')) {
      
      const paths = this.extractPaths(command);
      for (const p of paths) {
        const validation = this.validatePath(p);
        
        if (validation.checks.parentTraversal) {
          result.warnings.push({
            type: 'path_traversal',
            message: `Path traversal detected in: ${p}`,
            detail: 'Avoid using ../ in file paths',
          });
        }

        if (validation.checks.systemPath) {
          result.warnings.push({
            type: 'system_path',
            message: `System path access: ${p}`,
            detail: 'Modifying system paths can break the OS',
          });
        }

        if (validation.checks.networkPath) {
          result.warnings.push({
            type: 'network_path',
            message: `Network path detected: ${p}`,
            detail: 'Network paths may be unreliable or insecure',
          });
        }

        if (validation.checks.readOnlyPath) {
          result.warnings.push({
            type: 'readonly_path',
            message: `Read-only path: ${p}`,
            detail: 'This path cannot be modified',
          });
        }
      }
    }

    // 3. 沙箱检测
    if (this.enabledChecks.has('sandbox_detection')) {
      if (this.shouldSandbox(command)) {
        result.warnings.push({
          type: 'sandbox',
          message: 'Operating in sandboxed environment',
          detail: 'Some operations may be restricted',
        });
      }
    }

    // 4. 设置风险等级
    if (!result.riskLevel) {
      if (result.warnings.length > 0) {
        const severities = result.warnings.map(w => w.type);
        if (severities.includes('critical')) {
          result.riskLevel = 'critical';
        } else if (severities.includes('dangerous')) {
          result.riskLevel = 'dangerous';
        } else {
          result.riskLevel = 'warning';
        }
      } else {
        result.riskLevel = 'safe';
      }
    }

    // 5. 生成清理后的命令（如果有危险）
    if (result.blocked || result.riskLevel === 'dangerous' || result.riskLevel === 'critical') {
      result.sanitizedCommand = this.sanitizeCommand(command);
    }

    return result;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 快速检查命令安全性
 */
export function quickSecurityCheck(command: string): boolean {
  const security = new BashSecurity();
  const result = security.analyzeCommand(command);
  return result.passed && !result.blocked;
}

/**
 * 获取风险等级标签
 */
export function getRiskLevelEmoji(level: RiskLevel): string {
  const emojis: Record<RiskLevel, string> = {
    safe: '✅',
    warning: '⚠️',
    dangerous: '🚨',
    critical: '🛑',
  };
  return emojis[level];
}

// ============================================================================
// Module Exports
// ============================================================================

export default BashSecurity;

export {
  BashSecurity,
  DANGEROUS_PATTERNS,
  quickSecurityCheck,
  getRiskLevelEmoji,
};

export type {
  DangerousCommandPattern,
  PathValidationResult,
  Warning,
  SecurityCheckResult,
  RiskLevel,
};
