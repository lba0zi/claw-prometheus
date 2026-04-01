"""
session_compactor.py — 多轮对话自动压缩
======================================
来自 Prometheus（普罗米修斯）的 `compact` 会话压缩设计。

问题: 对话轮次过多后，AI 忘记早期上下文。
方案: 超过阈值后，自动生成摘要，保留最近 N 条原始消息，
      将摘要注入 system prompt 替代旧历史。

压缩触发条件:
    - 轮次超过 compact_after_turns (默认 12)
    - 或 token 数超过 max_tokens (默认 8000)

压缩算法:
    1. 分离"旧消息"(可压缩) 和 "新消息"(保留)
    2. 对旧消息生成摘要
    3. 构建新的 system prompt: 摘要 + 新消息
"""

from __future__ import annotations

import json
import os
import time
import re
from dataclasses import dataclass, field
from pathlib import Path

COMPACTOR_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".openclaw", "compacts")
MEMORY_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "memory")


@dataclass
class Message:
    """对话消息。"""
    role: str  # "user" | "assistant" | "system"
    content: str
    timestamp: float = field(default_factory=time.time)
    turn: int = 0

    def to_text(self) -> str:
        return f"[{self.role}] {self.content}"

    def estimate_tokens(self) -> int:
        """粗略估算 token 数。"""
        return len(self.content) // 4

    def to_dict(self) -> dict:
        return {
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp,
            "turn": self.turn,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Message:
        return cls(
            role=d["role"],
            content=d["content"],
            timestamp=d.get("timestamp", time.time()),
            turn=d.get("turn", 0),
        )


@dataclass
class CompactionResult:
    """压缩结果。"""
    summary: str
    kept_messages: list[Message]
    compressed_messages: list[Message]
    total_tokens_saved: int
    compaction_count: int  # 第几次压缩
    timestamp: float = field(default_factory=time.time)

    def build_system_context(self, system_prompt: str = "") -> str:
        """构建压缩后的上下文。"""
        parts = []
        if system_prompt:
            parts.append(f"[System]\n{system_prompt}")
        parts.append(f"[对话摘要 - 已压缩 {self.compressed_messages.__len__()} 条消息]\n{self.summary}")
        parts.append("[最近对话]")
        for msg in self.kept_messages:
            parts.append(msg.to_text())
        return "\n\n".join(parts)

    def save(self, session_id: str) -> str:
        """保存压缩记录到文件。"""
        os.makedirs(COMPACTOR_DIR, exist_ok=True)
        filename = f"{session_id}_c{self.compaction_count}_{int(self.timestamp)}.json"
        path = os.path.join(COMPACTOR_DIR, filename)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "summary": self.summary,
                "kept": [m.to_dict() for m in self.kept_messages],
                "compressed": [m.to_dict() for m in self.compressed_messages],
                "tokens_saved": self.total_tokens_saved,
                "compaction_count": self.compaction_count,
                "timestamp": self.timestamp,
            }, f, ensure_ascii=False, indent=2)
        return path


class SessionCompactor:
    """
    对话压缩器。

    @example
        compactor = SessionCompactor(
            compact_after_turns=12,
            max_tokens=8000,
            keep_recent_turns=6,
        )

        if compactor.should_compact(history):
            result = compactor.summarize_old_messages(history, session_id="abc")
            new_context = result.build_system_context(system_prompt)
            # 用 new_context 替代旧的历史消息
    """
    def __init__(
        self,
        compact_after_turns: int = 12,
        max_tokens: int = 8000,
        keep_recent_turns: int = 6,
        memory_dir: str = MEMORY_DIR,
    ):
        self.compact_after_turns = compact_after_turns
        self.max_tokens = max_tokens
        self.keep_recent_turns = keep_recent_turns
        self.memory_dir = memory_dir
        self._compaction_count: int = 0

    def should_compact(self, turn_count: int) -> bool:
        """是否应该压缩。"""
        return turn_count >= self.compact_after_turns

    def should_compact_by_tokens(self, messages: list[Message]) -> bool:
        """按 token 数量判断是否压缩。"""
        total = sum(m.estimate_tokens() for m in messages)
        return total >= self.max_tokens

    def summarize_old_messages(
        self,
        messages: list[Message],
        session_id: str = "",
        llm_summarizer=None,
    ) -> CompactionResult:
        """
        压缩旧消息。

        Args:
            messages: 完整对话历史
            session_id: 会话 ID（用于保存记录）
            llm_summarizer: 可选，传入 LLM 总结函数。
                           如果不传，使用简单规则摘要。

        Returns:
            CompactionResult
        """
        self._compaction_count += 1

        # 保留最近 keep_recent_turns 条，其余压缩
        keep_count = min(self.keep_recent_turns, len(messages))
        kept = messages[-keep_count:]
        old = messages[:-keep_count]

        if llm_summarizer:
            summary = llm_summarizer(old)
        else:
            summary = self._rule_based_summary(old)

        tokens_saved = sum(m.estimate_tokens() for m in old) - len(summary) // 4

        result = CompactionResult(
            summary=summary,
            kept_messages=kept,
            compressed_messages=old,
            total_tokens_saved=max(0, tokens_saved),
            compaction_count=self._compaction_count,
        )

        # 保存压缩记录
        if session_id:
            result.save(session_id)

        return result

    def _rule_based_summary(self, messages: list[Message]) -> str:
        """
        基于规则的摘要（无 LLM 时使用）。

        策略:
        - 提取每条消息的意图标签
        - 记录关键操作（文件修改、命令执行）
        - 用 | 分隔各轮对话
        """
        if not messages:
            return "(无历史消息)"

        parts = []
        for msg in messages:
            content = msg.content
            # 截断超长内容
            if len(content) > 150:
                content = content[:150] + "..."

            # 提取操作类型
            op_type = self._classify_message(content)
            parts.append(f"{msg.role}: [{op_type}] {content[:100]}")

        summary = f"对话历史 ({len(messages)} 轮): " + " | ".join(parts[-6:])
        return summary

    def _classify_message(self, content: str) -> str:
        """简单分类消息类型。"""
        content_lower = content.lower()
        if any(k in content_lower for k in ["文件", "file", "read", "write", "edit"]):
            return "📄文件"
        if any(k in content_lower for k in ["执行", "run", "bash", "command", "终端"]):
            return "⚡命令"
        if any(k in content_lower for k in ["搜索", "search", "grep", "find"]):
            return "🔍搜索"
        if any(k in content_lower for k in ["git", "commit", "branch"]):
            return "🔀Git"
        if any(k in content_lower for k in ["错误", "error", "bug", "失败"]):
            return "🐛调试"
        if any(k in content_lower for k in ["计划", "plan", "分析", "analyze"]):
            return "📋计划"
        if any(k in content_lower for k in ["完成", "done", "success", "成功"]):
            return "✅完成"
        return "💬对话"

    def save_compact_to_memory(self, session_id: str, result: CompactionResult) -> str:
        """
        将压缩摘要保存到 memory 目录。

        文件名: memory/{session_id}_compact_{count}.md
        """
        import datetime as dt

        os.makedirs(self.memory_dir, exist_ok=True)
        date = dt.datetime.now().strftime("%Y-%m-%d")
        filename = f"{session_id}_compact_{result.compaction_count}.md"
        path = os.path.join(self.memory_dir, filename)

        lines = [
            f"# 对话压缩记录",
            f"",
            f"- **会话**: {session_id}",
            f"- **时间**: {dt.datetime.now().isoformat()}",
            f"- **压缩轮次**: {result.compaction_count}",
            f"- **压缩条数**: {len(result.compressed_messages)}",
            f"- **保留条数**: {len(result.kept_messages)}",
            f"- **节省 tokens**: ~{result.total_tokens_saved}",
            f"",
            f"## 摘要",
            f"",
            result.summary,
            f"",
            f"## 保留的最近消息",
            f"",
        ]
        for msg in result.kept_messages[-3:]:
            lines.append(f"**{msg.role}**: {msg.content[:200]}")

        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        return path

    def get_compaction_turns(self) -> int:
        return self.compact_after_turns

    def set_compaction_turns(self, n: int) -> None:
        self.compact_after_turns = max(1, n)


# ─────────────────────────────────────────────────────────────────
# OpenClaw Heartbeat 集成 - 周期性压缩检查
# ─────────────────────────────────────────────────────────────────

def check_and_compact_session(
    session_history: list[Message],
    session_id: str,
    compactor: SessionCompactor | None = None,
    system_prompt: str = "",
) -> tuple[bool, CompactionResult | None, list[Message]]:
    """
    检查并执行压缩的便捷函数。

    Returns:
        (did_compact, result, new_messages)
        - did_compact: 是否执行了压缩
        - result: 压缩结果（如果没有压缩则为 None）
        - new_messages: 压缩后的消息列表（如果没压缩则原样返回）
    """
    compactor = compactor or SessionCompactor()
    turn_count = len(session_history) // 2  # user+assistant = 1 turn

    if not compactor.should_compact(turn_count):
        if not compactor.should_compact_by_tokens(session_history):
            return False, None, session_history

    result = compactor.summarize_old_messages(session_history, session_id)

    # 重新构建消息列表：摘要消息 + 保留消息
    summary_msg = Message(
        role="system",
        content=f"[对话历史摘要]\n{result.summary}",
        timestamp=time.time(),
    )
    new_messages = [summary_msg] + result.kept_messages

    # 保存到 memory
    try:
        compactor.save_compact_to_memory(session_id, result)
    except Exception:
        pass  # 不因存储失败而中断

    return True, result, new_messages


if __name__ == "__main__":
    # 演示
    compactor = SessionCompactor(compact_after_turns=5, keep_recent_turns=3)

    # 模拟对话历史
    history = [
        Message(role="user", content="帮我写一个 Python 函数", turn=1),
        Message(role="assistant", content="这是一个 Python 函数...", turn=1),
        Message(role="user", content="加上类型注解", turn=2),
        Message(role="assistant", content="好的，加上类型注解...", turn=2),
        Message(role="user", content="改成异步函数", turn=3),
        Message(role="assistant", content="改成异步...", turn=3),
        Message(role="user", content="添加错误处理", turn=4),
        Message(role="assistant", content="添加错误处理...", turn=4),
        Message(role="user", content="写单元测试", turn=5),
        Message(role="assistant", content="写单元测试...", turn=5),
    ]

    print(f"当前轮次: {len(history)//2}")
    print(f"应压缩: {compactor.should_compact(len(history)//2)}")

    did, result, new_msgs = check_and_compact_session(history, "demo-session-001", compactor)
    if did:
        print(f"\n✅ 已压缩！节省约 {result.total_tokens_saved} tokens")
        print(f"摘要: {result.summary[:100]}...")
        print(f"新消息数: {len(new_msgs)}")
