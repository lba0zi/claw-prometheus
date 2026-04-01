/**
 * session-branching.ts
 * 会话分叉管理 - 为 OpenClaw AI Agent 提供对话分支和历史管理
 * 
 * @description
 * 支持创建对话分支、合并分支、比较分支差异等功能。
 * 使用文件存储分支元数据和对话历史。
 */

import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ============================================================================
// Types & Interfaces
// ============================================================================

/** 消息结构 */
export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/** 分支元数据 */
export interface BranchMetadata {
  branch_id: string;
  parent_id?: string;
  created_at: string;
  branch_name?: string;
  description?: string;
  merged: boolean;
  merged_into?: string;
  tags?: string[];
}

/** 分支差异 */
export interface BranchDiff {
  branchIdA: string;
  branchIdB: string;
  compared_at: string;
  added: Message[];
  removed: Message[];
  modified: Message[];
  identical: boolean;
}

/** 合并结果 */
export interface MergeResult {
  success: boolean;
  merged_branch_id: string;
  target_branch_id: string;
  conflicts_resolved: number;
  merged_messages: Message[];
  strategy: string;
  error?: string;
}

/** 冲突解决策略 */
export type ConflictStrategy = 'parent_wins' | 'child_wins' | 'newest_wins' | 'manual';

/** 文件存储的分叉记录 */
interface BranchFile {
  metadata: BranchMetadata;
  messages: Message[];
}

// ============================================================================
// Utility Functions
// ============================================================================

function generateId(prefix: string): string {
  const hash = crypto.randomBytes(12).toString('hex');
  return `${prefix}_${hash}`;
}

function formatDate(date: Date = new Date()): string {
  return date.toISOString();
}

function safeJsonParse<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ============================================================================
// SessionBranching
// ============================================================================

export class SessionBranching {
  private storagePath: string;
  private indexFile: string;
  private branchesIndex: Map<string, BranchMetadata>;

  constructor(storagePath?: string) {
    this.storagePath = storagePath || this._getDefaultStoragePath();
    this.indexFile = path.join(this.storagePath, 'index.json');
    this.branchesIndex = new Map();
    
    this._ensureStorage();
    this._loadIndex();
  }

  private _getDefaultStoragePath(): string {
    const home = process.env.OPENCLAW_HOME || 
      path.join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw');
    return path.join(home, 'branches');
  }

  private _ensureStorage(): void {
    ensureDir(this.storagePath);
  }

  private _loadIndex(): void {
    try {
      if (fs.existsSync(this.indexFile)) {
        const data = fs.readFileSync(this.indexFile, 'utf-8');
        const branches = safeJsonParse<BranchMetadata[]>(data, []);
        this.branchesIndex = new Map(branches.map(b => [b.branch_id, b]));
      }
    } catch {
      this.branchesIndex = new Map();
    }
  }

  private _saveIndex(): void {
    try {
      const branches = Array.from(this.branchesIndex.values());
      fs.writeFileSync(this.indexFile, JSON.stringify(branches, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save branches index:', err);
    }
  }

  private _getBranchFile(branchId: string): string {
    return path.join(this.storagePath, `${branchId}.json`);
  }

  private _loadBranchMessages(branchId: string): Message[] {
    try {
      const filePath = this._getBranchFile(branchId);
      if (fs.existsSync(filePath)) {
        const data = safeJsonParse<BranchFile>(
          fs.readFileSync(filePath, 'utf-8'),
          { metadata: {} as BranchMetadata, messages: [] }
        );
        return data.messages || [];
      }
    } catch {
      // Ignore
    }
    return [];
  }

  private _loadBranchFile(branchId: string): BranchFile | null {
    try {
      const filePath = this._getBranchFile(branchId);
      if (fs.existsSync(filePath)) {
        return safeJsonParse<BranchFile>(
          fs.readFileSync(filePath, 'utf-8'),
          { metadata: {} as BranchMetadata, messages: [] }
        );
      }
    } catch {
      // Ignore
    }
    return null;
  }

  private _messagesEqual(a: Message, b: Message): boolean {
    return a.role === b.role && a.content === b.content;
  }

  private _findDivergence(source: Message[], target: Message[]): number {
    const minLen = Math.min(source.length, target.length);
    for (let i = 0; i < minLen; i++) {
      if (!this._messagesEqual(source[i], target[i])) {
        return i;
      }
    }
    return minLen;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  createBranch(
    parentSessionId: string,
    description?: string,
    messages?: Message[],
    branchName?: string
  ): BranchMetadata {
    const branchId = generateId('branch');
    const now = formatDate();

    let branchMessages: Message[] = messages || [];
    
    // 如果没有提供消息，尝试从父分支复制
    if (!messages || messages.length === 0) {
      // 尝试多种可能的消息文件位置
      const possiblePaths = [
        path.join(process.env.OPENCLAW_HOME || '', 'history', `${parentSessionId}.json`),
        path.join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'history', `${parentSessionId}.json`),
      ];
      
      for (const filePath of possiblePaths) {
        if (fs.existsSync(filePath)) {
          try {
            const data = safeJsonParse<{ messages?: Message[] }>(
              fs.readFileSync(filePath, 'utf-8'),
              {}
            );
            if (data.messages && data.messages.length > 0) {
              branchMessages = data.messages;
              break;
            }
          } catch {
            // Continue
          }
        }
      }
    }

    const metadata: BranchMetadata = {
      branch_id: branchId,
      parent_id: parentSessionId,
      created_at: now,
      branch_name: branchName,
      description: description || `Branch from ${parentSessionId}`,
      merged: false,
    };

    const branchFile: BranchFile = {
      metadata,
      messages: branchMessages,
    };

    try {
      fs.writeFileSync(
        this._getBranchFile(branchId),
        JSON.stringify(branchFile, null, 2),
        'utf-8'
      );
      
      this.branchesIndex.set(branchId, metadata);
      this._saveIndex();
    } catch (err) {
      throw new Error(`Failed to create branch: ${err}`);
    }

    return metadata;
  }

  listBranches(parentId?: string): BranchMetadata[] {
    const branches = Array.from(this.branchesIndex.values());
    
    if (parentId) {
      return branches.filter(b => b.parent_id === parentId);
    }
    
    return branches.sort((a, b) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  getBranch(branchId: string): BranchMetadata | null {
    return this.branchesIndex.get(branchId) || null;
  }

  getBranchHistory(branchId: string): Message[] {
    return this._loadBranchMessages(branchId);
  }

  updateBranchMessages(branchId: string, messages: Message[]): void {
    const filePath = this._getBranchFile(branchId);
    const existing = this._loadBranchFile(branchId);
    
    if (!existing) {
      throw new Error(`Branch ${branchId} not found`);
    }

    existing.messages = messages;
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  isAncestor(branchId: string, potentialAncestorId: string): boolean {
    const branch = this.branchesIndex.get(branchId);
    if (!branch) return false;

    let current = branch;
    const visited = new Set<string>();

    while (current.parent_id) {
      if (visited.has(current.parent_id)) return false;
      if (current.parent_id === potentialAncestorId) return true;

      visited.add(current.parent_id);
      const parent = this.branchesIndex.get(current.parent_id);
      if (!parent) break;
      current = parent;
    }

    return false;
  }

  getAncestorChain(branchId: string): BranchMetadata[] {
    const chain: BranchMetadata[] = [];
    const branch = this.branchesIndex.get(branchId);
    
    if (!branch) return chain;

    let current = branch;
    const visited = new Set<string>();

    while (current.parent_id) {
      if (visited.has(current.parent_id)) break;
      
      const parent = this.branchesIndex.get(current.parent_id);
      if (!parent) break;
      
      visited.add(current.parent_id);
      chain.push(parent);
      current = parent;
    }

    return chain;
  }

  getChildBranches(branchId: string): BranchMetadata[] {
    return this.listBranches(branchId);
  }

  mergeBranch(
    branchId: string,
    targetSessionId: string,
    strategy: ConflictStrategy = 'newest_wins'
  ): MergeResult {
    const sourceBranch = this.branchesIndex.get(branchId);
    if (!sourceBranch) {
      return {
        success: false,
        merged_branch_id: branchId,
        target_branch_id: targetSessionId,
        conflicts_resolved: 0,
        merged_messages: [],
        strategy,
        error: 'Source branch not found',
      };
    }

    if (sourceBranch.merged) {
      return {
        success: false,
        merged_branch_id: branchId,
        target_branch_id: targetSessionId,
        conflicts_resolved: 0,
        merged_messages: [],
        strategy,
        error: 'Branch already merged',
      };
    }

    const sourceMessages = this.getBranchHistory(branchId);
    
    // 尝试加载目标消息
    const possibleTargetPaths = [
      path.join(process.env.OPENCLAW_HOME || '', 'history', `${targetSessionId}.json`),
      path.join(process.env.HOME || process.env.USERPROFILE || '.', '.openclaw', 'history', `${targetSessionId}.json`),
    ];
    
    let targetMessages: Message[] = [];
    for (const targetFile of possibleTargetPaths) {
      if (fs.existsSync(targetFile)) {
        try {
          const targetData = safeJsonParse<{ messages?: Message[] }>(
            fs.readFileSync(targetFile, 'utf-8'),
            {}
          );
          targetMessages = targetData.messages || [];
          break;
        } catch {
          // Continue
        }
      }
    }

    const { merged, conflicts } = this._mergeMessages(sourceMessages, targetMessages, strategy);

    sourceBranch.merged = true;
    sourceBranch.merged_into = targetSessionId;
    this.branchesIndex.set(branchId, sourceBranch);
    this._saveIndex();

    // 保存到目标文件
    const targetFile = possibleTargetPaths[0];
    try {
      ensureDir(path.dirname(targetFile));
      
      const mergedData = {
        sessionId: targetSessionId,
        messages: merged,
        lastUpdated: formatDate(),
        mergedFrom: branchId,
      };
      
      fs.writeFileSync(targetFile, JSON.stringify(mergedData, null, 2), 'utf-8');
    } catch (err) {
      return {
        success: false,
        merged_branch_id: branchId,
        target_branch_id: targetSessionId,
        conflicts_resolved: conflicts,
        merged_messages: [],
        strategy,
        error: `Failed to write merged history: ${err}`,
      };
    }

    return {
      success: true,
      merged_branch_id: branchId,
      target_branch_id: targetSessionId,
      conflicts_resolved: conflicts,
      merged_messages: merged,
      strategy,
    };
  }

  private _mergeMessages(
    source: Message[],
    target: Message[],
    strategy: ConflictStrategy
  ): { merged: Message[]; conflicts: number } {
    if (source.length === 0) return { merged: [...target], conflicts: 0 };
    if (target.length === 0) return { merged: [...source], conflicts: 0 };

    const divergenceIndex = this._findDivergence(source, target);
    const common = source.slice(0, divergenceIndex);
    const sourceDivergent = source.slice(divergenceIndex);
    const targetDivergent = target.slice(divergenceIndex);

    let merged: Message[];
    let conflicts = 0;

    switch (strategy) {
      case 'parent_wins':
        merged = [...common, ...targetDivergent];
        conflicts = sourceDivergent.length;
        break;
      case 'child_wins':
        merged = [...common, ...sourceDivergent];
        conflicts = targetDivergent.length;
        break;
      case 'newest_wins':
        const sourceTime = source[source.length - 1]?.timestamp;
        const targetTime = target[target.length - 1]?.timestamp;
        const sourceNewer = !targetTime || (sourceTime && sourceTime > targetTime);
        merged = [...common, ...(sourceNewer ? sourceDivergent : targetDivergent)];
        conflicts = Math.min(sourceDivergent.length, targetDivergent.length);
        break;
      default:
        merged = [...common, ...targetDivergent];
        conflicts = sourceDivergent.length;
    }

    return { merged, conflicts };
  }

  diffBranches(branchIdA: string, branchIdB: string): BranchDiff {
    const messagesA = this.getBranchHistory(branchIdA);
    const messagesB = this.getBranchHistory(branchIdB);

    const divergenceA = this._findDivergence(messagesA, messagesB);
    const divergenceB = this._findDivergence(messagesB, messagesA);

    const added: Message[] = messagesB.slice(divergenceA);
    const removed: Message[] = messagesA.slice(divergenceB);
    
    // Modified messages (same position but different content)
    const modified: Message[] = [];
    for (let i = 0; i < Math.min(divergenceA, divergenceB); i++) {
      if (!this._messagesEqual(messagesA[i], messagesB[i])) {
        modified.push(messagesB[i]); // Show B's version
      }
    }

    return {
      branchIdA,
      branchIdB,
      compared_at: formatDate(),
      added,
      removed,
      modified,
      identical: added.length === 0 && removed.length === 0 && modified.length === 0,
    };
  }

  deleteBranch(branchId: string): boolean {
    const branch = this.branchesIndex.get(branchId);
    if (!branch) return false;

    // 检查是否已合并
    if (branch.merged) {
      throw new Error('Cannot delete a merged branch');
    }

    // 检查是否有子分支
    const children = this.getChildBranches(branchId);
    if (children.length > 0) {
      throw new Error('Cannot delete branch with child branches');
    }

    // 删除文件
    const filePath = this._getBranchFile(branchId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    this.branchesIndex.delete(branchId);
    this._saveIndex();

    return true;
  }

  getStats(): {
    totalBranches: number;
    activeBranches: number;
    mergedBranches: number;
    oldestBranch?: string;
    newestBranch?: string;
  } {
    const branches = this.listBranches();
    const active = branches.filter(b => !b.merged);
    const merged = branches.filter(b => b.merged);

    return {
      totalBranches: branches.length,
      activeBranches: active.length,
      mergedBranches: merged.length,
      oldestBranch: branches.length > 0 ? branches[branches.length - 1].branch_id : undefined,
      newestBranch: branches.length > 0 ? branches[0].branch_id : undefined,
    };
  }
}

// ============================================================================
// Module Exports
// ============================================================================

export default SessionBranching;

export {
  SessionBranching,
};

export type {
  Message,
  BranchMetadata,
  BranchDiff,
  MergeResult,
  ConflictStrategy,
};
