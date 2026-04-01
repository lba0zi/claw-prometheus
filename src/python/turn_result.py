"""
turn_result.py — 结构化执行结果 + stop_reason
==============================================
来自 Prometheus（普罗米修斯）的 TurnResult 设计。

StopReason:
    completed          — 正常完成
    max_turns_reached  — 达到最大轮次
    max_budget_reached — 超出预算
    error              — 执行出错
    timeout            — 超时
    user_interrupt     — 用户中断
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal

StopReason = Literal[
    "completed",
    "max_turns_reached",
    "max_budget_reached",
    "error",
    "timeout",
    "user_interrupt",
]


@dataclass(frozen=True)
class UsageSummary:
    """Token 使用量摘要。"""
    input_tokens: int = 0
    output_tokens: int = 0
    total_cost: float = 0.0

    def add(self, text: str) -> UsageSummary:
        """根据文本长度估算 token（简单估算：1 token ≈ 4 字符）。"""
        estimated = len(text) // 4
        return UsageSummary(
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens + estimated,
            total_cost=self.total_cost,
        )

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class TurnResult:
    """
    单轮 Agent 执行结果。
    
    Attributes:
        prompt:         用户输入
        output:         Agent 回复
        matched_commands: 匹配到的命令列表
        matched_tools:  匹配到的工具列表
        permission_denials: 被拒绝的工具及原因
        usage:          Token 使用量
        stop_reason:    停止原因
        timestamp:       时间戳
        session_id:     会话 ID
    """
    prompt: str
    output: str
    matched_commands: tuple[str, ...] = field(default_factory=tuple)
    matched_tools: tuple[str, ...] = field(default_factory=tuple)
    permission_denials: tuple[dict, ...] = field(default_factory=tuple)
    usage: UsageSummary = field(default_factory=UsageSummary)
    stop_reason: StopReason = "completed"
    timestamp: float = field(default_factory=time.time)
    session_id: str = ""

    def as_dict(self) -> dict:
        return {
            "prompt": self.prompt,
            "output": self.output,
            "matched_commands": self.matched_commands,
            "matched_tools": self.matched_tools,
            "permission_denials": self.permission_denials,
            "usage": {
                "input_tokens": self.usage.input_tokens,
                "output_tokens": self.usage.output_tokens,
                "total_cost": self.usage.total_cost,
            },
            "stop_reason": self.stop_reason,
            "timestamp": self.timestamp,
            "session_id": self.session_id,
        }


TERMINAL_REASONS: set[str] = {
    "max_turns_reached",
    "max_budget_reached",
    "error",
    "timeout",
    "user_interrupt",
}


def is_terminal_stop_reason(reason: StopReason) -> bool:
    """是否为终止性原因（不会再继续执行）。"""
    return reason in TERMINAL_REASONS


def create_turn_result(
    prompt: str,
    output: str,
    matched_commands: list[str] | None = None,
    matched_tools: list[str] | None = None,
    permission_denials: list[dict] | None = None,
    usage: UsageSummary | None = None,
    stop_reason: StopReason = "completed",
    session_id: str = "",
) -> TurnResult:
    """TurnResult 工厂函数。"""
    return TurnResult(
        prompt=prompt,
        output=output,
        matched_commands=tuple(matched_commands or []),
        matched_tools=tuple(matched_tools or []),
        permission_denials=tuple(permission_denials or []),
        usage=usage or UsageSummary(),
        stop_reason=stop_reason,
        session_id=session_id,
    )


def format_turn_result(result: TurnResult, verbose: bool = False) -> str:
    """格式化 TurnResult 为可读字符串。"""
    lines = [
        f"[Turn] stop={result.stop_reason}",
        f"  commands: {', '.join(result.matched_commands) or 'none'}",
        f"  tools:    {', '.join(result.matched_tools) or 'none'}",
        f"  denials:  {len(result.permission_denials)}",
        f"  tokens:   in={result.usage.input_tokens} out={result.usage.output_tokens}",
    ]
    if verbose:
        lines.append(f"  prompt:   {result.prompt[:80]}{'...' if len(result.prompt) > 80 else ''}")
        lines.append(f"  output:   {result.output[:200]}{'...' if len(result.output) > 200 else ''}")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────
# Query Engine Port — 多轮循环执行器
# ─────────────────────────────────────────────────────────────────

@dataclass
class QueryEngineConfig:
    """查询引擎配置。"""
    max_turns: int = 8
    max_budget_tokens: int = 2000
    compact_after_turns: int = 12
    structured_output: bool = False
    structured_retry_limit: int = 2


class QueryEnginePort:
    """
    多轮 Agent 循环执行器。
    
    来自 Prometheus（普罗米修斯）的 `PortRuntime.run_turn_loop` 设计。
    支持: 多轮执行、自动压缩、预算控制、结构化输出。
    """
    def __init__(
        self,
        config: QueryEngineConfig | None = None,
        session_id: str = "",
    ):
        self.config = config or QueryEngineConfig()
        self.session_id = session_id or _generate_id()
        self.turns: list[TurnResult] = []
        self._messages: list[str] = []

    @property
    def turn_count(self) -> int:
        return len(self.turns)

    def submit(
        self,
        prompt: str,
        matched_commands: list[str] | None = None,
        matched_tools: list[str] | None = None,
        denied_tools: list[dict] | None = None,
        output: str = "",
        stop_reason: StopReason = "completed",
    ) -> TurnResult:
        """
        提交一轮执行。
        
        返回 TurnResult，并自动判断是否达到终止条件。
        """
        result = create_turn_result(
            prompt=prompt,
            output=output,
            matched_commands=matched_commands,
            matched_tools=matched_tools,
            permission_denials=denied_tools,
            usage=UsageSummary(input_tokens=len(prompt) // 4),
            stop_reason=stop_reason,
            session_id=self.session_id,
        )

        # 检查是否达到终止条件
        if len(self.turns) >= self.config.max_turns:
            result.stop_reason = "max_turns_reached"
        elif result.usage.total_tokens > self.config.max_budget_tokens:
            result.stop_reason = "max_budget_reached"

        self.turns.append(result)
        self._messages.append(prompt)
        return result

    def should_compact(self) -> bool:
        """是否应该压缩历史。"""
        return len(self._messages) >= self.config.compact_after_turns

    def compact(self) -> str:
        """
        压缩对话历史，返回摘要。
        
        保留最近 N 条，生成摘要丢弃旧的。
        """
        keep = self.config.compact_after_turns
        old_messages = self._messages[:-keep]
        self._messages = self._messages[-keep:]
        
        if not old_messages:
            return ""
        # 简单摘要：前3条 + 后3条 的首句
        summary_parts = []
        for msg in old_messages[:3]:
            summary_parts.append(msg[:60])
        if len(old_messages) > 3:
            summary_parts.append(f"... ({len(old_messages) - 6} 条消息省略)")
        for msg in old_messages[-3:]:
            summary_parts.append(msg[:60])
        return " | ".join(summary_parts)

    def get_history_summary(self) -> str:
        """获取当前轮次历史摘要。"""
        lines = [f"共 {len(self.turns)} 轮对话"]
        for i, t in enumerate(self.turns):
            lines.append(f"  [{i+1}] {t.stop_reason} | {t.usage.total_tokens} tokens")
        return "\n".join(lines)


def _generate_id() -> str:
    import uuid
    return uuid.uuid4().hex[:8]


if __name__ == "__main__":
    # 演示
    engine = QueryEnginePort(QueryEngineConfig(max_turns=5, compact_after_turns=3))
    for i in range(5):
        r = engine.submit(f"用户消息 {i+1}", output=f"回复 {i+1}")
        print(format_turn_result(r))
        if is_terminal_stop_reason(r.stop_reason):
            print("→ 终止")
            break
        if engine.should_compact():
            summary = engine.compact()
            print(f"→ 压缩完成，摘要: {summary[:60]}")
