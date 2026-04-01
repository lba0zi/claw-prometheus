/**
 * claw-harness — OpenClaw Plugin
 * ================================
 * 将某 AI Coding 产品源码泄露中的核心 harness 模块集成到 OpenClaw。
 *
 * 功能：
 *  1. ToolPermissionContext  — 工具权限拒绝追踪
 *  2. SessionCompactor       — 多轮对话自动压缩
 *  3. TurnResult             — 结构化执行结果 + stop_reason
 *  4. PromptRouter           — 智能路由（command + tool 双重匹配）
 *  5. BashSecurity           — Bash/PowerShell 多层安全防御
 *  6. SessionBranching       — 会话分叉与合并
 *  7. PermissionDenialLog    — 拒绝日志审计
 *
 * 集成点：
 *  - registerTool()          — 注册为 OpenClaw agent tools
 *  - gateway hooks           — exec 执行前安全检查（通过工具参数注入）
 *  - heartbeat               — 自动会话压缩检查（通过 cron 触发）
 *
 * 存放位置：~/.openclaw/workspace-main/src/claw-harness/
 * 启用方式：在 openclaw 配置中添加 plugins.entries.claw-harness
 */

import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk/core";
import { registerTools } from "./src/tools.js";

export default function clawHarnessPlugin(api: OpenClawPluginApi) {
  const config = (api.config.plugins?.entries?.["claw-harness"] as Record<string, unknown>) || {};

  // 注册所有 harness 模块为 OpenClaw agent tools
  registerTools(api, config);

  api.logger.info("[claw-harness] loaded", {
    compactAfterTurns: config["compactAfterTurns"],
    bashSecurityEnabled: config["bashSecurityEnabled"],
    autoCompact: config["autoCompact"],
  });
}
