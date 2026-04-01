"""
tool_permissions.py — 工具权限拒绝追踪
=======================================
来自 Prometheus（普罗米修斯）的 ToolPermissionContext 设计。

风险等级:
    safe       — 安全操作，如读文件、搜索
    warning    — 需要确认的操作，如执行命令
    dangerous  — 高风险操作，如删除、格式化
    critical   — 极高风险，如系统修改、凭据访问
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

RiskLevel = Literal["safe", "warning", "dangerous", "critical"]

import os as _os
_DENY_LOG_BASE = _os.environ.get(
    "OPENCLAW_WORKSPACE",
    _os.path.dirname(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
)
DENY_LOG_PATH = _DENY_LOG_BASE + "/.openclaw/denial-log.jsonl"


@dataclass(frozen=True)
class PermissionDenial:
    """单次权限拒绝记录。"""
    tool_name: str
    reason: str
    timestamp: float
    session_id: str = ""
    prompt_excerpt: str = ""

    def as_dict(self) -> dict:
        return {
            "tool_name": self.tool_name,
            "reason": self.reason,
            "timestamp": self.timestamp,
            "session_id": self.session_id,
            "prompt_excerpt": self.prompt_excerpt,
        }


@dataclass
class ToolPermissionContext:
    """
    工具权限上下文。
    
    支持:
    - 精确名称匹配: deny_list=["BashTool"]
    - 前缀通配匹配: deny_prefixes=["Network*", "Disk*"]
    - 风险等级自动拒绝: auto_deny_dangerous=True
    
    @example
        ctx = ToolPermissionContext.from_deny_list(
            ["BashTool"],
            deny_prefixes=["Network*"]
        )
        ctx.blocks("BashTool")          # True
        ctx.blocks("NetworkScanner")    # True (前缀匹配)
        ctx.blocks("FileReadTool")      # False
    """
    deny_names: frozenset[str] = field(default_factory=frozenset)
    deny_prefixes: tuple[str, ...] = field(default_factory=tuple)
    deny_risk_levels: frozenset[RiskLevel] = field(default_factory=lambda: frozenset({"critical"}))
    auto_deny_dangerous: bool = True

    @classmethod
    def from_deny_list(
        cls,
        deny_list: list[str] | None = None,
        deny_prefixes: list[str] | None = None,
        deny_risk_levels: list[RiskLevel] | None = None,
        auto_deny_dangerous: bool = True,
    ) -> ToolPermissionContext:
        return cls(
            deny_names=frozenset(n.lower() for n in (deny_list or [])),
            deny_prefixes=tuple((p or "").lower() for p in (deny_prefixes or [])),
            deny_risk_levels=frozenset(deny_risk_levels or ["critical"]),
            auto_deny_dangerous=auto_deny_dangerous,
        )

    def blocks(self, tool_name: str) -> bool:
        """检查工具是否被拒绝。
        
        支持通配符 * : 'Network*' 匹配所有以 'Network' 开头的工具名。
        """
        lowered = tool_name.lower()
        if lowered in self.deny_names:
            return True
        for prefix in self.deny_prefixes:
            prefix_lower = prefix.lower()
            if "*" in prefix_lower:
                # 通配符匹配：'Network*' → 'networkscanner'.startswith('network')
                prefix_base = prefix_lower.replace("*", "")
                if lowered.startswith(prefix_base):
                    return True
            elif lowered.startswith(prefix_lower):
                return True
        return False

    def check(self, tool_name: str) -> tuple[bool, str | None]:
        """
        检查工具是否可用。
        
        Returns:
            (allowed: bool, reason_if_denied: str | None)
        """
        if self.blocks(tool_name):
            reason = self._get_denial_reason(tool_name)
            return False, reason
        return True, None

    def get_denial_reason(self, tool_name: str) -> str | None:
        """获取拒绝原因（如果被拒绝）。"""
        if not self.blocks(tool_name):
            return None
        return self._get_denial_reason(tool_name)

    def _get_denial_reason(self, tool_name: str) -> str:
        lowered = tool_name.lower()
        if lowered in self.deny_names:
            return f"Tool '{tool_name}' is explicitly denied"
        for prefix in self.deny_prefixes:
            if lowered.startswith(prefix.lower()):
                return f"Tool '{tool_name}' matches denied prefix '{prefix}'"
        return f"Tool '{tool_name}' denied by risk policy"


# ─────────────────────────────────────────────────────────────────
# 工具注册表
# ─────────────────────────────────────────────────────────────────

RISK_PATTERNS: dict[str, tuple[RiskLevel, str]] = {
    "BashTool": ("warning", "执行系统命令，可能有副作用"),
    "PowerShellTool": ("warning", "执行 PowerShell 命令"),
    "FileWriteTool": ("dangerous", "写入文件系统"),
    "FileEditTool": ("warning", "编辑现有文件"),
    "FileReadTool": ("safe", "读取文件内容"),
    "GlobTool": ("safe", "搜索文件"),
    "GrepTool": ("safe", "搜索文件内容"),
    "Bash_rm": ("critical", "删除文件或目录"),
    "Bash_format": ("critical", "格式化操作"),
    "NetworkTool": ("dangerous", "网络操作"),
    "MCPTool": ("warning", "MCP 协议工具"),
    "ChromeTool": ("dangerous", "控制浏览器"),
    "AgentTool": ("warning", "启动子 Agent"),
    "forkSubagent": ("warning", "分叉子 Agent"),
    "resumeAgent": ("safe", "恢复 Agent 会话"),
    "ConfigTool": ("warning", "修改配置"),
    "OAuthTool": ("critical", "OAuth 认证操作"),
    "KeychainTool": ("critical", "访问密钥链"),
}


@dataclass
class ToolMetadata:
    name: str
    description: str
    risk_level: RiskLevel
    patterns: list[str] = field(default_factory=list)


class BasicToolRegistry:
    """
    工具注册表。
    
    管理工具元数据（名称、描述、风险等级、匹配模式），
    并提供权限检查接口。
    """
    def __init__(self):
        self._tools: dict[str, ToolMetadata] = {}
        for name, (risk, desc) in RISK_PATTERNS.items():
            self.register(name, desc, risk)

    def register(
        self,
        name: str,
        description: str,
        risk_level: RiskLevel,
        patterns: list[str] | None = None,
    ) -> None:
        self._tools[name.lower()] = ToolMetadata(
            name=name,
            description=description,
            risk_level=risk_level,
            patterns=patterns or [],
        )

    def get(self, name: str) -> ToolMetadata | None:
        return self._tools.get(name.lower())

    def get_risk_level(self, name: str) -> RiskLevel:
        meta = self._tools.get(name.lower())
        if meta:
            return meta.risk_level
        return "warning"  # 默认风险等级

    def check_with_risk(
        self,
        tool_name: str,
        ctx: ToolPermissionContext,
    ) -> tuple[bool, str | None, RiskLevel]:
        """
        综合风险 + 权限上下文检查工具。
        
        Returns:
            (allowed, reason_if_denied, risk_level)
        """
        risk = self.get_risk_level(tool_name)
        allowed, reason = ctx.check(tool_name)
        if not allowed:
            return False, reason, risk
        # 风险等级自动拒绝
        if ctx.auto_deny_dangerous and risk in ctx.deny_risk_levels:
            return False, f"Tool '{tool_name}' denied by auto-deny policy for risk level '{risk}'", risk
        return True, None, risk

    def all_tools(self) -> list[ToolMetadata]:
        return list(self._tools.values())


# ─────────────────────────────────────────────────────────────────
# 拒绝日志
# ─────────────────────────────────────────────────────────────────

def log_denial(
    tool_name: str,
    reason: str,
    session_id: str = "",
    prompt_excerpt: str = "",
) -> PermissionDenial:
    """记录一次权限拒绝。"""
    import json, os, time as _time
    
    entry = PermissionDenial(
        tool_name=tool_name,
        reason=reason,
        timestamp=_time.time(),
        session_id=session_id,
        prompt_excerpt=prompt_excerpt[:200] if prompt_excerpt else "",
    )
    
    os.makedirs(os.path.dirname(DENY_LOG_PATH), exist_ok=True)
    with open(DENY_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry.as_dict(), ensure_ascii=False) + "\n")
    
    return entry


if __name__ == "__main__":
    # 演示
    ctx = ToolPermissionContext.from_deny_list(
        ["Bash_rm", "FormatTool"],
        deny_prefixes=["Network*", "Disk*"],
    )
    registry = BasicToolRegistry()
    
    for tool in ["BashTool", "Bash_rm", "NetworkScanner", "FileReadTool", "ChromeTool"]:
        allowed, reason, risk = registry.check_with_risk(tool, ctx)
        status = "✅" if allowed else "🚫"
        print(f"{status} {tool} ({risk}) — {reason or 'OK'}")
        if not allowed:
            log_denial(tool, reason or "unknown", prompt_excerpt="test prompt")
