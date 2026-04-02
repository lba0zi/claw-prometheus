"""
hermes_integration.py — OpenClaw + Hermes Extensions 集成层
==========================================================
将 hermes 的所有能力无缝接入 OpenClaw 的工作流。

使用方式（在 OpenClaw 的 Python 脚本/模块中）:
    from src.python.hermes.integration import HermesIntegration
    h = HermesIntegration()
    h.on_message(user_message)
    h.on_turn_complete(messages, model="MiniMax-M2.7")
"""

from . import context_threat
from . import context_reference
from . import smart_routing
from . import trajectory
from . import context_compressor

try:
    from . import skill
    HAS_SKILLS = True
except ImportError:
    HAS_SKILLS = False


class HermesIntegration:
    """
    OpenClaw 的 Hermes 增强能力集成器。
    
    工作流:
    
    用户消息到达
           ↓
    [1] Context Reference 展开 (@git, @file, @url)
           ↓
    [2] Context Threat 检测 (prompt injection 扫描)
           ↓
    [3] 智能路由 (判断用便宜模型还是主模型)
           ↓
    [4] Agent 执行 (turn loop)
           ↓
    [5] Trajectory 记录 (保存对话轨迹)
           ↓
    [6] 分层 Context 压缩 (保持上下文精简)
           ↓
    [7] Skills 查找 (如果有匹配的 skill)
    """

    def __init__(
        self,
        cwd: str = ".",
        context_budget: int = 180000,
        enable_skills: bool = True,
        trajectory_dir: str = "~/.openclaw/trajectories",
        skills_dir: str = "~/.openclaw/skills",
    ):
        self.cwd = cwd
        self.context_budget = context_budget
        self.trajectory_logger = trajectory.TrajectoryLogger(trajectory_dir)
        self.compressor = context_compressor.HierarchicalCompressor()
        self.turn_buffer: list[dict] = []

        if HAS_SKILLS and enable_skills:
            self.skill_store = skill.SkillStore(skills_dir)
            # 注册内置 skills
            for s in skill.BUILTIN_OPENCLAW_SKILLS:
                try:
                    self.skill_store.register_skill(**s)
                except Exception:
                    pass  # 已存在则跳过
        else:
            self.skill_store = None

        self.last_route: smart_routing.RouteDecision | None = None
        self.last_threat_report: context_threat.ThreatReport | None = None
        self.last_compression: context_compressor.CompressedContext | None = None

    # ─────────────────────────────────────────────────────────────
    # 1. 消息入口处理
    # ─────────────────────────────────────────────────────────────

    def on_message(self, user_message: str) -> tuple[str, smart_routing.RouteDecision]:
        """
        用户消息入口，返回 (processed_message, route_decision)。
        
        处理流程:
        1. 展开 @ 引用
        2. 检测威胁
        3. 选择模型
        """
        # Step 1: 展开 @ 引用
        try:
            ref_result = context_reference.expand_references(
                user_message,
                cwd=self.cwd,
                context_length=self.context_budget,
            )
            processed = ref_result.message
            if ref_result.warnings:
                processed += "\n\n" + "\n".join(ref_result.warnings)
        except Exception:
            processed = user_message

        # Step 2: Context Threat 检测
        self.last_threat_report = context_threat.scan_content(processed)
        if self.last_threat_report.blocked:
            # 内容被阻止，需要审查
            return (
                f"[安全审查中] 您的消息包含被阻止的内容，请修改后重试。\n"
                f"发现: {', '.join(self.last_threat_report.findings)}",
                None,
            )
        processed = self.last_threat_report.clean_content

        # Step 3: 智能路由
        from . import smart_routing as sr
        self.last_route = sr.choose_route(
            user_message=processed,
            primary_provider="minimax",
            primary_model="MiniMax-M2.7",
            cheap_provider="minimax",
            cheap_model="abab6.5s-chat",
        )

        return processed, self.last_route

    # ─────────────────────────────────────────────────────────────
    # 2. Turn 完成记录
    # ─────────────────────────────────────────────────────────────

    def on_turn_complete(
        self,
        role: str,
        content: str,
        tool_calls: list[dict] = None,
    ) -> None:
        """
        每次 Turn 完成时调用，记录到 trajectory buffer。
        """
        self.trajectory_logger.log_turn(role, content, tool_calls)

    def on_session_end(
        self,
        model: str,
        completed: bool = True,
        tags: list[str] = None,
        session_id: str = "",
    ) -> None:
        """
        会话结束时调用，将 buffer 写入 JSONL。
        """
        self.trajectory_logger.flush(
            model=model,
            completed=completed,
            tags=tags or [],
            session_id=session_id,
        )
        self.turn_buffer.clear()

    # ─────────────────────────────────────────────────────────────
    # 3. Context 压缩
    # ─────────────────────────────────────────────────────────────

    def compress_if_needed(self, messages: list[dict]) -> context_compressor.CompressedContext | None:
        """
        检查是否需要压缩，必要时执行分层压缩。
        
        返回压缩结果，或者 None（不需要压缩）。
        """
        original_tokens = sum(
            context_reference.estimate_tokens(m.get("content", ""))
            for m in messages
        )
        if original_tokens < self.context_budget * 0.7:
            return None

        self.last_compression = self.compressor.compress(
            messages,
            context_budget=self.context_budget,
        )
        return self.last_compression

    # ─────────────────────────────────────────────────────────────
    # 4. Skills 查询
    # ─────────────────────────────────────────────────────────────

    def find_skills(self, query: str) -> list[skill.Skill]:
        """
        根据查询找到最匹配的 skills。
        """
        if not self.skill_store:
            return []
        matches = self.skill_store.find_skill(query)
        return [s for s, score in matches if score > 0.3]

    def get_skill_guidance(self, query: str) -> str:
        """
        获取与当前查询最相关的 skill 指令内容。
        """
        skills = self.find_skills(query)
        if not skills:
            return ""
        return skills[0].trigger_text

    def log_skill_feedback(
        self,
        skill_name: str,
        rating: float,
        session_id: str = "",
        suggestion: str = "",
    ) -> None:
        """
        记录 skill 使用反馈，触发自我进化。
        """
        if self.skill_store:
            self.skill_store.log_feedback(skill_name, rating, session_id, suggestion)

    # ─────────────────────────────────────────────────────────────
    # 5. 快捷方法
    # ─────────────────────────────────────────────────────────────

    def quick_check(self, command: str) -> str:
        """
        快速安全检查一条命令。
        相当于 BashSecurityCheck 的轻量版。
        """
        result = context_threat.scan_content(command)
        if result.blocked:
            return f"🚫 BLOCKED: {', '.join(result.findings)}"
        if result.findings:
            return f"⚠️  WARN: {', '.join(result.findings)}"
        return "✅ PASS"

    def build_system_prompt(self, base_prompt: str, query: str = "") -> str:
        """
        构建最终 system prompt，加入 skills 指引。
        """
        parts = [base_prompt]
        if query:
            skill_guidance = self.get_skill_guidance(query)
            if skill_guidance:
                parts.append("\n\n## Relevant Skills\n" + skill_guidance)
        return "\n\n".join(parts)
