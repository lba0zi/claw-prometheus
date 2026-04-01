"""
prompt_router.py — 智能路由 (command + tool 双重匹配)
=======================================================
来自 Claude Code 的 `route_prompt` 设计。

目标: 用户输入同时匹配 Command（斜杠命令）和 Tool，选择最优执行路径。

算法:
    1. Tokenize: 分词，去除符号，转小写
    2. 权重打分: 命令词命中 + 正则匹配 + 模糊匹配
    3. 排序: score DESC, kind ASC (command 优先)
    4. 返回 Top N (默认 5)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Any

RouterMatch = tuple[str, ...]  # (matched_names,)


@dataclass
class RoutedMatch:
    """
    路由匹配结果。
    
    Attributes:
        kind:    "command" | "tool"
        name:    匹配到的命令/工具名
        score:   匹配分数（越高越匹配）
        reason:  匹配原因
        handler: 处理函数（如果有）
    """
    kind: str
    name: str
    score: int
    reason: str
    handler: Callable | None = None

    def __repr__(self) -> str:
        return f"RoutedMatch({self.kind}={self.name!r} score={self.score})"


@dataclass
class _RegisteredItem:
    """注册项（命令或工具）。"""
    name: str
    keywords: list[str]
    patterns: list[re.Pattern]
    handler: Callable | None
    kind: str  # "command" | "tool"


class PromptRouter:
    """
    智能路由器。
    
    同时管理 Command 和 Tool 两个注册池，
    根据用户输入返回最佳匹配。

    @example
        router = PromptRouter()
        
        # 注册命令
        router.register_command(
            "git-commit",
            keywords=["git", "commit", "提交", "提交代码"],
            handler=git_commit_handler
        )
        
        # 注册工具
        router.register_tool(
            "BashTool",
            keywords=["bash", "终端", "命令", "shell"],
            handler=bash_handler
        )
        
        # 路由
        matches = router.route("帮我 git commit")
        # → [RoutedMatch(command=git-commit, score=2, reason="git+commit"),
        #    RoutedMatch(tool=BashTool, score=1, reason="命令")]
    """
    def __init__(self, max_matches: int = 5):
        self.max_matches = max_matches
        self._commands: list[_RegisteredItem] = []
        self._tools: list[_RegisteredItem] = []

    # ─── Registration ──────────────────────────────────────────────

    def register_command(
        self,
        name: str,
        keywords: list[str],
        handler: Callable | None = None,
        patterns: list[str] | None = None,
    ) -> None:
        """注册一个命令。"""
        self._commands.append(_RegisteredItem(
            name=name,
            keywords=[k.lower() for k in keywords],
            patterns=[re.compile(p, re.I) for p in (patterns or [])],
            handler=handler,
            kind="command",
        ))

    def register_tool(
        self,
        name: str,
        keywords: list[str],
        handler: Callable | None = None,
        patterns: list[str] | None = None,
    ) -> None:
        """注册一个工具。"""
        self._tools.append(_RegisteredItem(
            name=name,
            keywords=[k.lower() for k in keywords],
            patterns=[re.compile(p, re.I) for p in (patterns or [])],
            handler=handler,
            kind="tool",
        ))

    # ─── Routing ──────────────────────────────────────────────────

    def route(self, prompt: str) -> list[RoutedMatch]:
        """
        路由用户输入。
        
        Returns:
            按 score 降序排列的匹配列表（最多 max_matches 条）
        """
        tokens = self._tokenize(prompt)
        if not tokens:
            return []

        all_items = [(item, "command") for item in self._commands] + \
                    [(item, "tool") for item in self._tools]
        
        scored: list[RoutedMatch] = []
        for item, kind in all_items:
            score, reason = self._score_item(item, tokens, prompt)
            if score > 0:
                scored.append(RoutedMatch(
                    kind=kind,
                    name=item.name,
                    score=score,
                    reason=reason,
                    handler=item.handler,
                ))
        
        # 排序: score 降序，command 优先于 tool（同分时）
        scored.sort(key=lambda m: (-m.score, 0 if m.kind == "command" else 1))
        return scored[:self.max_matches]

    def route_with_context(
        self,
        prompt: str,
        context: dict[str, Any],
    ) -> list[RoutedMatch]:
        """
        带上下文的路由。
        
        上下文可用于：当前目录、已加载文件、用户偏好等。
        目前仅将上下文 key 作为额外 token 加入打分。
        """
        matches = self.route(prompt)
        # 可以在这里根据 context 过滤或加权
        # 例如：当前在 git repo 时，/git commit 权重 +1
        if context.get("in_git_repo"):
            for m in matches:
                if "git" in m.name.lower():
                    m.score += 1
        return matches[:self.max_matches]

    def best_match(self, prompt: str) -> RoutedMatch | None:
        """返回最佳匹配（仅第一个）。"""
        matches = self.route(prompt)
        return matches[0] if matches else None

    # ─── Scoring ───────────────────────────────────────────────────

    def _tokenize(self, text: str) -> set[str]:
        """分词：去除符号，转小写。"""
        cleaned = re.sub(r"[/\\-_.:;,!?(){}[\]<>@#$%^&*+=~\|`\"]", " ", text)
        tokens = {t.lower() for t in cleaned.split() if len(t) >= 2}
        return tokens

    def _score_item(self, item: _RegisteredItem, tokens: set[str], prompt: str) -> tuple[int, str]:
        """
        计算单个 item 的匹配分数。
        
        Scoring:
            精确命令词命中: +2/词
            部分匹配: +1/词
            正则匹配: +3
            prompt 中直接出现命令名: +2
        
        Returns:
            (score, reason)
        """
        score = 0
        reasons = []

        # 1. 命令词命中
        for kw in item.keywords:
            if kw in tokens:
                score += 2
                reasons.append(f"+kw:{kw}")
            else:
                # 部分包含
                for token in tokens:
                    if token in kw or kw in token:
                        score += 1
                        reasons.append(f"+partial:{token}∈{kw}")

        # 2. 正则匹配
        prompt_lower = prompt.lower()
        for pat in item.patterns:
            if pat.search(prompt_lower):
                score += 3
                reasons.append(f"+regex:{pat.pattern}")

        # 3. 命令名直接出现
        name_parts = item.name.lower().replace("-", " ").replace("_", " ").split()
        for part in name_parts:
            if len(part) >= 3 and part in prompt_lower:
                score += 2
                reasons.append(f"+name:{part}")

        # 4. 斜杠前缀（命令特有）
        if item.kind == "command":
            slash_names = [f"/{item.name.lower().replace('-', '')}",
                          f"/{item.name.lower()}"]
            for sn in slash_names:
                if sn in prompt_lower:
                    score += 3
                    reasons.append("+slash")

        return score, ", ".join(reasons[:4]) if reasons else ""


# ─────────────────────────────────────────────────────────────────
# 内置命令和工具注册
# ─────────────────────────────────────────────────────────────────

def register_builtin_commands(router: PromptRouter) -> None:
    """注册 Claude Code 的内置命令。"""
    commands = [
        ("git-commit", ["git", "commit", "提交"]),
        ("git-branch", ["git", "branch", "分支"]),
        ("git-status", ["git", "status"]),
        ("branch", ["branch", "分支"]),
        ("commit", ["commit", "提交"]),
        ("compact", ["compact", "压缩", "精简"]),
        ("brief", ["brief", "简报", "摘要"]),
        ("clear", ["clear", "清除", "清理"]),
        ("config", ["config", "配置"]),
        ("cost", ["cost", "成本", "花费"]),
        ("context", ["context", "上下文", "上下文"]),
        ("copy", ["copy", "复制"]),
        ("resume", ["resume", "恢复", "继续"]),
        ("retry", ["retry", "重试"]),
        ("bughunter", ["bughunter", "bug", "错误"]),
        ("browse", ["browse", "浏览", "阅读"]),
        ("model", ["model", "模型"]),
        ("claude", ["claude", "ai"]),
        ("help", ["help", "帮助", "?"]),
        ("exit", ["exit", "quit", "退出"]),
    ]
    for name, keywords in commands:
        router.register_command(name, keywords)


def register_builtin_tools(router: PromptRouter) -> None:
    """注册 Claude Code 的内置工具。"""
    tools = [
        ("BashTool", ["bash", "terminal", "终端", "命令", "shell", "sh"]),
        ("PowerShellTool", ["powershell", "ps", "pwsh", "powershell"]),
        ("FileReadTool", ["read", "读取", "读文件", "cat"]),
        ("FileWriteTool", ["write", "写入", "写文件", "新建文件"]),
        ("FileEditTool", ["edit", "编辑", "修改文件", "sed"]),
        ("GlobTool", ["glob", "find", "find", "搜索文件", "文件列表"]),
        ("GrepTool", ["grep", "search", "搜索", "查找", "内容搜索"]),
        ("AgentTool", ["agent", "子agent", "子代理"]),
        ("forkSubagent", ["fork", "分叉", "分支"]),
        ("resumeAgent", ["resume", "恢复"]),
        ("planAgent", ["plan", "计划"]),
        ("LSPTool", ["lsp", "符号", "代码定义", "跳转"]),
        ("MCPTool", ["mcp", "plugin", "插件"]),
        ("ChromeTool", ["chrome", "browser", "浏览器"]),
        ("ConfigTool", ["config", "配置"]),
        ("BriefTool", ["brief", "brief", "摘要模式"]),
    ]
    for name, keywords in tools:
        router.register_tool(name, keywords)


def create_default_router() -> PromptRouter:
    """创建带内置注册的默认路由器。"""
    router = PromptRouter()
    register_builtin_commands(router)
    register_builtin_tools(router)
    return router


# ─────────────────────────────────────────────────────────────────
# OpenClaw 集成便捷函数
# ─────────────────────────────────────────────────────────────────

def route_for_openclaw(prompt: str) -> list[RoutedMatch]:
    """
    OpenClaw 专用路由函数。
    
    使用默认路由器对 prompt 进行路由，
    返回匹配结果供 OpenClaw 决定使用哪个工具/命令。
    """
    router = create_default_router()
    return router.route(prompt)


def format_routing_result(matches: list[RoutedMatch]) -> str:
    """格式化路由结果为可读字符串。"""
    if not matches:
        return "无匹配命令/工具"
    lines = [f"路由结果 ({len(matches)} 个匹配):"]
    for m in matches:
        lines.append(f"  {m.kind:8} {m.name:20} score={m.score:3}  {m.reason}")
    return "\n".join(lines)


if __name__ == "__main__":
    router = create_default_router()
    
    test_prompts = [
        "帮我 git commit",
        "/compact 精简一下对话",
        "读取一下 config.json",
        "帮我写一个快速排序",
        "用 powershell 执行 ipconfig",
        "/help",
        "搜索一下这个文件夹里的 TODO",
    ]
    
    for p in test_prompts:
        matches = router.route(p)
        print(f"\n输入: {p!r}")
        print(format_routing_result(matches))
