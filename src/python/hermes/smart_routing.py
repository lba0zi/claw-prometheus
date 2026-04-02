"""
smart_routing.py — 任务复杂度路由
来自 Hermes 的 smart_model_routing.py 设计。
"""

from dataclasses import dataclass
from typing import Optional

# Complex task keywords
COMPLEX_KEYWORDS = {
    "debug", "debugging", "implement", "implementation", "refactor",
    "patch", "traceback", "stacktrace", "exception", "error",
    "analyze", "analysis", "investigate", "architecture", "design",
    "compare", "benchmark", "optimize", "optimise", "review",
    "terminal", "shell", "tool", "tools", "pytest", "test", "tests",
    "plan", "planning", "delegate", "subagent", "cron", "docker",
    "kubernetes", "security", "vulnerability", "database", "sql",
    "api", "http", "websocket", "refactor", "migration",
    "architect", "blueprint", "pipeline", "workflow", "agent",
}


@dataclass
class RouteDecision:
    """Model routing decision."""
    use_cheap: bool
    provider: str
    model: str
    reason: str
    matched_keywords: list[str]
    complexity_score: int


def classify_complexity(user_message: str) -> tuple[bool, list[str]]:
    """
    Classify task complexity by keyword matching.
    Returns (is_complex, matched_keywords).
    is_complex = True when score >= 2.
    """
    text = user_message.lower()
    matched = [kw for kw in COMPLEX_KEYWORDS if kw in text]
    return len(matched) >= 2, matched


# Default route config (MiniMax example)
ROUTE_CONFIG = {
    "enabled": True,
    "cheap_model": {
        "provider": "minimax",
        "model": "abab6.5s-chat",
    },
    "primary_model": {
        "provider": "minimax",
        "model": "MiniMax-M2.7",
    },
}


def choose_route(
    user_message: str,
    primary_provider: str,
    primary_model: str,
    cheap_provider: str,
    cheap_model: str,
    config: Optional[dict] = None,
) -> RouteDecision:
    """
    Decide which model to use based on task complexity.

    Simple tasks -> cheap_model
    Complex tasks -> primary_model
    """
    if config is None:
        config = ROUTE_CONFIG

    is_complex, matched = classify_complexity(user_message)
    score = len(matched)

    if is_complex:
        kw_display = ", ".join(matched[:5])
        if score > 5:
            kw_display = kw_display + "...+" + str(score - 5)
        reason = "Complex task detected (" + str(score) + " keywords: " + kw_display + "), using primary model"
        return RouteDecision(
            use_cheap=False,
            provider=primary_provider,
            model=primary_model,
            reason=reason,
            matched_keywords=matched,
            complexity_score=score,
        )
    else:
        kw_display = ", ".join(matched[:3])
        reason = "Simple task (" + str(score) + " keywords: " + kw_display + "), using cheap model"
        return RouteDecision(
            use_cheap=True,
            provider=cheap_provider,
            model=cheap_model,
            reason=reason,
            matched_keywords=matched,
            complexity_score=score,
        )
