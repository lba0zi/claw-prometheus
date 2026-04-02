"""
context_compressor.py — 多层对话压缩
来自 Hermes 的 context_compressor.py 设计。
比 session_compactor 更精细：工具输出剪枝 → 迭代摘要 → 结构化模板

纯规则实现，不调用任何 LLM API。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal, Optional

CompressionStage = Literal["none", "prune", "cheap_summary", "iterative", "full"]

# 工具输出超过这个字符数（~500 tokens）就剪枝
TOOL_OUTPUT_MAX_CHARS = 2000

# 首尾保留字符数
TOOL_PRUNE_HEAD = 200
TOOL_PRUNE_TAIL = 100

SUMMARY_GOAL_TEMPLATE = """## Goal
{goal}

## Progress
{progress}

## Decisions
{decisions}

## Next Steps
{next_steps}"""


def _count_tokens(text: str) -> int:
    """
    粗略估算 token 数（中文≈2 chars/token，英文≈4 chars/token）。
    """
    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    english = len(re.findall(r"[a-zA-Z0-9]", text))
    other = len(text) - chinese - english
    return int(chinese / 2 + english / 4 + other)


@dataclass
class CompressedContext:
    """压缩结果"""

    original_tokens: int
    compressed_tokens: int
    stage: CompressionStage
    summary: str
    kept_turns: list[dict] = field(default_factory=list)
    pruned_content: list[str] = field(default_factory=list)
    compression_count: int = 0

    @property
    def savings_ratio(self) -> float:
        if self.original_tokens == 0:
            return 0.0
        return 1.0 - self.compressed_tokens / self.original_tokens

    def __repr__(self) -> str:
        return (
            f"CompressedContext(stage={self.stage}, "
            f"tokens={self.original_tokens}→{self.compressed_tokens} "
            f"(saved {self.savings_ratio:.1%}), "
            f"kept_turns={len(self.kept_turns)}, "
            f"pruned={len(self.pruned_content)})"
        )


class HierarchicalCompressor:
    """
    分层压缩策略:

    Stage 1 - 工具输出剪枝:
        工具输出 > TOOL_OUTPUT_MAX_CHARS 的截断，保留首尾摘要
        "长输出: {first_200}...{last_100} [节省 N chars]"

    Stage 2 - 廉价辅助摘要:
        用简单规则提取每个 turn 的意图和结果
        turn 格式: "[user] 意图 | [assistant] 动作 | [tool] 结果摘要"

    Stage 3 - 迭代式结构化摘要:
        将多轮对话合并为结构化模板
        保留: Goal, Progress, Decisions, Next Steps

    Stage 4 - 纯摘要（超过阈值触发）:
        规则生成最终摘要（无 LLM）
    """

    def __init__(self, tool_max_chars: int = TOOL_OUTPUT_MAX_CHARS):
        self.tool_max_chars = tool_max_chars

    def compress(
        self,
        messages: list[dict],
        context_budget: int = 180000,
        force_stage: CompressionStage = "none",
    ) -> CompressedContext:
        """
        执行分层压缩。

        1. 先计算原始 token
        2. 检查是否需要压缩
        3. 逐级应用压缩策略
        4. 返回压缩结果
        """
        if not messages:
            return CompressedContext(
                original_tokens=0,
                compressed_tokens=0,
                stage="none",
                summary="",
            )

        # 1. 计算原始 token
        original_tokens = sum(_count_tokens(m.get("content", "") or "") for m in messages)

        # 2. 检查是否需要压缩
        if force_stage == "none":
            if original_tokens <= context_budget:
                return CompressedContext(
                    original_tokens=original_tokens,
                    compressed_tokens=original_tokens,
                    stage="none",
                    summary="",
                    kept_turns=list(messages),
                )

        # 3. 逐级应用压缩策略
        stage: CompressionStage = "prune"
        pruned_content: list[str] = []
        current_messages = list(messages)

        # Stage 1: 工具输出剪枝
        pruned_messages, pruned = self._prune_tool_outputs(current_messages)
        pruned_content.extend(pruned)
        current_messages = pruned_messages
        tokens_after_prune = sum(_count_tokens(m.get("content", "") or "") for m in current_messages)

        if force_stage == "prune" or (force_stage == "none" and tokens_after_prune <= context_budget):
            stage = "prune"
            return CompressedContext(
                original_tokens=original_tokens,
                compressed_tokens=tokens_after_prune,
                stage=stage,
                summary="",
                kept_turns=current_messages,
                pruned_content=pruned_content,
                compression_count=len(pruned_content),
            )

        # Stage 2: 廉价摘要
        turn_summaries = [self._cheap_summary_turn(m) for m in current_messages]
        summary_text = "\n".join(turn_summaries)
        tokens_after_summary = _count_tokens(summary_text) + sum(
            _count_tokens(m.get("content", "") or "") for m in current_messages if m.get("role") not in ("user", "assistant", "tool")
        )

        if force_stage == "cheap_summary" or (force_stage == "none" and tokens_after_summary <= context_budget):
            stage = "cheap_summary"
            return CompressedContext(
                original_tokens=original_tokens,
                compressed_tokens=tokens_after_summary,
                stage=stage,
                summary=summary_text,
                kept_turns=current_messages,
                pruned_content=pruned_content,
                compression_count=len(pruned_content),
            )

        # Stage 3: 迭代式结构化摘要
        structured = self._build_structured_summary(turn_summaries)
        tokens_after_structured = _count_tokens(structured)

        if force_stage == "iterative" or (force_stage == "none" and tokens_after_structured <= context_budget):
            stage = "iterative"
            return CompressedContext(
                original_tokens=original_tokens,
                compressed_tokens=tokens_after_structured,
                stage=stage,
                summary=structured,
                kept_turns=[],
                pruned_content=pruned_content,
                compression_count=len(pruned_content),
            )

        # Stage 4: 强制全量压缩（纯摘要，无 LLM）
        # 用关键词提取代替 LLM
        full_summary = self._rule_based_full_summary(messages, turn_summaries)
        stage = "full"
        tokens_final = _count_tokens(full_summary)
        return CompressedContext(
            original_tokens=original_tokens,
            compressed_tokens=tokens_final,
            stage=stage,
            summary=full_summary,
            kept_turns=[],
            pruned_content=pruned_content,
            compression_count=len(pruned_content),
        )

    def _prune_tool_outputs(self, messages: list[dict]) -> tuple[list[dict], list[str]]:
        """
        Stage 1: 剪枝长工具输出。
        对工具消息，如果 content 超过 tool_max_chars，保留首尾各 TOOL_PRUNE_HEAD/TOOL_PRUNE_TAIL 字符。
        """
        pruned_content: list[str] = []
        pruned_messages: list[dict] = []

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "") or ""

            if role == "tool" and len(content) > self.tool_max_chars:
                head = content[:TOOL_PRUNE_HEAD]
                tail = content[-TOOL_PRUNE_TAIL:]
                saved_chars = len(content) - TOOL_PRUNE_HEAD - TOOL_PRUNE_TAIL
                new_content = (
                    f"{head}\n...\n[长输出截断，节省 ~{saved_chars} 字符]\n...\n{tail}"
                )
                pruned_content.append(content)
                pruned_messages.append({**msg, "content": new_content})
            else:
                pruned_messages.append(msg)

        return pruned_messages, pruned_content

    def _cheap_summary_turn(self, turn: dict) -> str:
        """
        Stage 2: 规则-based 单轮摘要。
        返回格式: "[role] 内容摘要"
        """
        role = turn.get("role", "?")
        content = (turn.get("content", "") or "")[:300]

        if role == "tool":
            # 工具输出只取前100字符
            return f"[tool] {content[:100]}..."
        elif role == "user":
            # 用户消息取前150字符
            return f"[user] {content[:150]}"
        elif role == "assistant":
            # assistant 可能带有 tool_calls
            tool_calls = turn.get("tool_calls", [])
            if tool_calls:
                names = ", ".join(tc.get("name", "unknown") for tc in tool_calls[:3])
                return f"[assistant] 调用工具({names}): {content[:100]}"
            return f"[assistant] {content[:150]}"
        else:
            return f"[{role}] {content[:150]}"

    def _build_structured_summary(self, summaries: list[str]) -> str:
        """
        Stage 3: 将摘要列表整理成结构化模板。
        规则：
        - 前 1-2 个 user turn → Goal
        - 全部 assistant/tool turn → Progress
        - 涉及决策的关键词 → Decisions
        - 最后一个 user turn → Next Steps（推断）
        """
        user_summaries = [s for s in summaries if s.startswith("[user]")]
        assistant_summaries = [s for s in summaries if s.startswith("[assistant]")]
        tool_summaries = [s for s in summaries if s.startswith("[tool]")]

        # Goal: 前两个 user 消息
        goal_parts = [s.replace("[user]", "").strip() for s in user_summaries[:2]]
        goal = "；".join(p for p in goal_parts if p) or "（未识别到明确目标）"

        # Progress: assistant + tool 的摘要
        progress_parts = []
        for s in assistant_summaries:
            text = s.replace("[assistant]", "").strip()
            if text:
                progress_parts.append(text)
        for s in tool_summaries:
            text = s.replace("[tool]", "").strip()
            if text:
                progress_parts.append(text)
        progress = "\n- ".join(progress_parts) if progress_parts else "（无操作记录）"

        # Decisions: 包含关键词的摘要
        decision_keywords = ["选择", "决定", "使用", "采纳", "决定", "switch", "choose", "use", "adopt", "select"]
        decision_parts = [
            s for s in summaries
            if any(kw in s.lower() for kw in decision_keywords)
        ]
        decisions = "\n- ".join(d.replace("[assistant]", "").replace("[tool]", "").strip() for d in decision_parts) if decision_parts else "（无明确决策记录）"

        # Next Steps: 最后一个 user 消息（通常是下一步指示）
        next_steps = user_summaries[-1].replace("[user]", "").strip() if user_summaries else "（未识别到下一步指示）"

        return SUMMARY_GOAL_TEMPLATE.format(
            goal=goal,
            progress=progress,
            decisions=decisions,
            next_steps=next_steps,
        )

    def _rule_based_full_summary(
        self, messages: list[dict], summaries: list[str]
    ) -> str:
        """
        Stage 4: 纯规则全量摘要（无 LLM）。
        从消息中提取关键词、模式，生成结构化摘要。
        """
        # 提取所有 user 内容中的关键词（名词/动词短语）
        all_user_content = " ".join(
            (m.get("content", "") or "") for m in messages if m.get("role") == "user"
        )
        # 提取技术关键词
        tech_patterns = [
            r"\b(python|javascript|java|go|rust|c\+\+|typescript|bash|shell|sql)\b",
            r"\b(git|docker|kubernetes|aws|azure|gcp|linux|windows|macos)\b",
            r"\b(api|rest|graphql|websocket|http|tcp|udp)\b",
            r"\b(database|db|postgres|mysql|redis|mongodb|sql)\b",
            r"\b(debug|test|refactor|migrate|deploy|build|run|install)\b",
            r"\b(file|directory|folder|path|url|endpoint|route)\b",
        ]
        tech_terms: set[str] = set()
        for pat in tech_patterns:
            tech_terms.update(t.lower() for t in re.findall(pat, all_user_content, re.IGNORECASE))

        structured = self._build_structured_summary(summaries)
        tech_line = f"涉及技术: {', '.join(sorted(tech_terms))}" if tech_terms else ""
        return f"{structured}\n\n## 技术栈\n{tech_line}"


# ---------------------------------------------------------------------------
# 便捷单函数
# ---------------------------------------------------------------------------

def compress_messages(
    messages: list[dict],
    context_budget: int = 180000,
    force_stage: Optional[CompressionStage] = None,
) -> CompressedContext:
    """
    一行调用压缩。
    """
    compressor = HierarchicalCompressor()
    return compressor.compress(messages, context_budget, force_stage=force_stage or "none")


if __name__ == "__main__":
    print("=== context_compressor 单元测试 ===")

    # 测试1: 不需要压缩
    short_messages = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi there!"},
    ]
    result = compress_messages(short_messages, context_budget=100)
    print(f"短消息: {result}")
    assert result.stage == "none"
    assert len(result.kept_turns) == 2
    print("✅ 短消息无需压缩")

    # 测试2: Stage 1 - 工具输出剪枝
    long_tool_content = "x" * 3000
    messages_prune = [
        {"role": "user", "content": "run this"},
        {"role": "assistant", "content": "executing..."},
        {"role": "tool", "content": long_tool_content},
    ]
    result = compress_messages(messages_prune, context_budget=100, force_stage="prune")
    print(f"剪枝: {result}")
    assert result.stage == "prune"
    assert len(result.pruned_content) == 1
    assert len(result.kept_turns) == 3
    # 检查保留内容
    pruned_msg = result.kept_turns[2]
    assert len(pruned_msg["content"]) < len(long_tool_content)
    assert "长输出截断" in pruned_msg["content"]
    print("✅ 工具输出剪枝正常")

    # 测试3: Stage 2 - 廉价摘要
    result = compress_messages(messages_prune, context_budget=100, force_stage="cheap_summary")
    print(f"廉价摘要: {result}")
    assert result.stage == "cheap_summary"
    assert result.summary
    print(f"摘要内容:\n{result.summary}")
    print("✅ 廉价摘要正常")

    # 测试4: Stage 3 - 结构化摘要
    messages_complex = [
        {"role": "user", "content": "我想用 Python 写一个快速排序算法"},
        {"role": "assistant", "content": "好的，我来写一个快速排序实现", "tool_calls": [{"name": "write"}]},
        {"role": "tool", "content": "文件已写入 /tmp/quicksort.py"},
        {"role": "user", "content": "现在帮我加个二分搜索"},
    ]
    result = compress_messages(messages_complex, context_budget=100, force_stage="iterative")
    print(f"结构化摘要: {result}")
    assert result.stage == "iterative"
    assert "## Goal" in result.summary
    assert "## Progress" in result.summary
    assert "## Decisions" in result.summary
    assert "## Next Steps" in result.summary
    print(f"摘要:\n{result.summary}")
    print("✅ 结构化摘要正常")

    # 测试5: Stage 4 - 全量压缩
    result = compress_messages(messages_complex, context_budget=50, force_stage="full")
    print(f"全量压缩: {result}")
    assert result.stage == "full"
    assert "## 技术栈" in result.summary or "python" in result.summary.lower()
    print(f"全量摘要:\n{result.summary}")
    print("✅ 全量压缩正常")

    # 测试6: 节省比例计算
    long_messages = [
        {"role": "user", "content": "debug this error traceback exception in module"},
        {"role": "assistant", "content": "analyzing the issue..."},
        {"role": "tool", "content": "error details" * 500},
        {"role": "user", "content": "optimize the database query and refactor"},
    ]
    result = compress_messages(long_messages, context_budget=100)
    print(f"自动压缩: {result}")
    print(f"节省比例: {result.savings_ratio:.1%}")
    assert result.savings_ratio >= 0
    print("✅ 自动压缩正常")

    print("\n✅ ✅ ✅ 所有单元测试通过！")
