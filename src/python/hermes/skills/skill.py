"""
skill.py — Skills 自我进化系统
来自 Hermes 的 skills/ 设计。

Skills 存储在 ~/.openclaw/skills/{category}/{name}/ 目录:
  manifest.yaml      — name, triggers, description 等元数据
  instructions.md    — Agent 执行指南
  feedback.jsonl      — 用户反馈流（追加写入）
  versions/           — 历史版本（自动创建）
      v1.md, v2.md, ...
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# Data classes
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SkillManifest:
    name: str
    description: str
    trigger_keywords: list[str]
    platform: str  # "openclaw" | "hermes" | "universal"
    enabled: bool = True
    version: int = 1
    uses: int = 0
    last_used: str = ""
    rating: float = 5.0  # 1-10
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> SkillManifest:
        # filter to known fields only
        known = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class SkillFeedback:
    skill_name: str
    rating: float  # 1-10
    session_id: str
    timestamp: str
    user_feedback: str = ""
    improvement_suggestion: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> SkillFeedback:
        return cls(**d)


@dataclass
class SkillInstruction:
    content: str
    version: int
    improved_at: str
    improvement_source: str  # "auto" | "user_feedback" | "manual"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> SkillInstruction:
        return cls(**d)


class Skill:
    """单个 Skill 的完整数据。"""

    def __init__(self, manifest: SkillManifest, instruction: SkillInstruction):
        self.manifest = manifest
        self.instruction = instruction

    @property
    def trigger_text(self) -> str:
        """生成触发这个 skill 的 prompt 片段"""
        keywords = ", ".join(self.manifest.trigger_keywords)
        return (
            f"[Skill: {self.manifest.name}]\n"
            f"Description: {self.manifest.description}\n"
            f"Triggers: {keywords}\n"
            f"\n{self.instruction.content}"
        )

    def to_dict(self) -> dict:
        return {
            "manifest": self.manifest.to_dict(),
            "instruction": self.instruction.to_dict(),
        }

    @classmethod
    def from_dict(cls, d: dict) -> Skill:
        return cls(
            manifest=SkillManifest.from_dict(d["manifest"]),
            instruction=SkillInstruction.from_dict(d["instruction"]),
        )


# ─────────────────────────────────────────────────────────────────────────────
# Built-in Skills
# ─────────────────────────────────────────────────────────────────────────────

BUILTIN_OPENCLAW_SKILLS = [
    {
        "name": "openclaw-coder",
        "description": "代码编写、重构、Debug",
        "triggers": ["写代码", "实现", "debug", "fix bug", "重构"],
        "instruction": """你是一个专注于代码编写的助手。

## 当被问到写代码时:
1. 先理解需求，明确输入输出
2. 考虑边界情况和错误处理
3. 写完后主动检查: 语法、逻辑、安全问题
4. 复杂函数加上注释解释

## 安全检查清单:
- SQL 注入风险
- 命令注入风险
- 路径穿越
- 敏感信息泄露
""",
    },
    {
        "name": "openclaw-bash-expert",
        "description": "Shell 命令和脚本",
        "triggers": ["bash", "shell", "脚本", "terminal", "执行命令"],
        "instruction": """你是一个 Bash/PowerShell 专家。

## 命令执行原则:
1. 先解释要做什么，再执行
2. 危险命令（rm -rf, format, shutdown）必须确认
3. 优先用只读操作
4. 长命令加注释

## Windows PowerShell 特别提示:
- 用 -WhatIf 预览危险操作
- 确认路径是绝对路径还是相对路径
- 网络下载执行是高风险操作
""",
    },
    {
        "name": "openclaw-researcher",
        "description": "信息搜索和整理",
        "triggers": ["搜索", "调研", "查找", "查一下", "研究"],
        "instruction": """你是一个研究助手。

## 信息收集原则:
1. 先广泛搜索，再深入重点
2. 记录信息来源
3. 区分事实和观点
4. 引用要准确（URL、时间）

## 整理输出格式:
- 关键发现（3-5条）
- 详细信息
- 参考来源
""",
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# SkillStore — storage and evolution engine
# ─────────────────────────────────────────────────────────────────────────────

class SkillStore:
    """
    Skills 存储和进化引擎。

    存储结构:
      ~/.openclaw/skills/
      ├── openclaw-coder/
      │   ├── manifest.yaml
      │   ├── instructions.md
      │   ├── feedback.jsonl
      │   └── versions/
      │       └── v1.md
      ├── openclaw-bash-expert/
      └── ...
    """

    def __init__(self, skills_dir: str = r"~\.openclaw\skills"):
        self.skills_dir = Path(skills_dir).expanduser().resolve()
        self._cache: dict[str, Skill] = {}
        self._ensure_dir()

    # ── helpers ────────────────────────────────────────────────────────────────

    def _ensure_dir(self) -> None:
        self.skills_dir.mkdir(parents=True, exist_ok=True)

    def _skill_dir(self, name: str) -> Path:
        """Category is inferred as the first hyphen-separated segment."""
        category = name.split("-")[0] if "-" in name else name
        return self.skills_dir / category / name

    def _manifest_path(self, skill_dir: Path) -> Path:
        return skill_dir / "manifest.yaml"

    def _instructions_path(self, skill_dir: Path) -> Path:
        return skill_dir / "instructions.md"

    def _feedback_path(self, skill_dir: Path) -> Path:
        return skill_dir / "feedback.jsonl"

    def _versions_dir(self, skill_dir: Path) -> Path:
        return skill_dir / "versions"

    def _version_file(self, skill_dir: Path, version: int) -> Path:
        return self._versions_dir(skill_dir) / f"v{version}.md"

    # ── YAML helpers (no external deps — hand-rolled) ─────────────────────────

    @staticmethod
    def _write_yaml(path: Path, data: dict) -> None:
        lines = []
        for key, value in data.items():
            if isinstance(value, list):
                lines.append(f"{key}:")
                for item in value:
                    lines.append(f"  - {item}")
            elif isinstance(value, bool):
                lines.append(f"{key}: {'true' if value else 'false'}")
            elif value is None:
                lines.append(f"{key}: null")
            elif isinstance(value, str):
                if "\n" in value:
                    lines.append(f"{key}: |")
                    for ln in value.splitlines():
                        lines.append(f"  {ln}")
                else:
                    lines.append(f"{key}: {value}")
            else:
                lines.append(f"{key}: {value}")
        path.write_text("\n".join(lines), encoding="utf-8")

    @classmethod
    def _read_yaml(cls, path: Path) -> dict:
        """Minimal hand-rolled YAML parser for our flat structure."""
        text = path.read_text(encoding="utf-8")
        result: dict = {}
        current_key: str | None = None
        in_block = False
        block_lines: list[str] = []

        for raw_line in text.splitlines():
            stripped = raw_line.rstrip()

            if in_block:
                if stripped.startswith("  ") or stripped == "":
                    block_lines.append(stripped)
                    continue
                else:
                    # end of block
                    result[current_key] = "\n".join(block_lines).rstrip()
                    in_block = False
                    block_lines = []
                    current_key = None

            if not stripped or stripped.startswith("#"):
                continue

            # list item
            m = re.match(r"(\s*)-\s+(.*)", stripped)
            if m:
                indent, val = m.group(1), m.group(2).strip()
                # Initialize as list if current value is None or empty string
                if result.get(current_key) is None or result.get(current_key) == "":
                    result[current_key] = []
                if isinstance(result[current_key], list):
                    result[current_key].append(val)
                continue

            # key: value
            m = re.match(r"(\w+):\s*(.*)", stripped)
            if m:
                key, rest = m.group(1), m.group(2).strip()
                if rest == "|" or rest.startswith("|"):
                    current_key = key
                    in_block = True
                    block_lines = []
                    continue
                current_key = key
                if rest in ("true", "false"):
                    result[key] = rest == "true"
                elif rest == "null":
                    result[key] = None
                elif rest.isdigit():
                    result[key] = int(rest)
                elif rest.replace(".", "", 1).isdigit():
                    result[key] = float(rest)
                else:
                    result[key] = rest
        return result

    # ── public API ────────────────────────────────────────────────────────────

    def register_skill(
        self,
        name: str,
        description: str,
        instruction_content: str | None = None,
        trigger_keywords: list[str] | None = None,
        platform: str = "universal",
        # accept aliases to match BUILTIN dicts
        triggers: list[str] | None = None,
        instruction: str | None = None,
    ) -> Skill:
        """注册一个新 skill，自动创建目录结构和所有文件。"""
        # handle aliases
        if trigger_keywords is None:
            trigger_keywords = triggers if triggers is not None else []
        if instruction_content is None:
            instruction_content = instruction if instruction is not None else ""

        skill_dir = self._skill_dir(name)
        skill_dir.mkdir(parents=True, exist_ok=True)
        self._versions_dir(skill_dir).mkdir(parents=True, exist_ok=True)

        manifest = SkillManifest(
            name=name,
            description=description,
            trigger_keywords=trigger_keywords,
            platform=platform,
            enabled=True,
            version=1,
            uses=0,
            last_used="",
            rating=5.0,
            tags=[],
        )
        instruction = SkillInstruction(
            content=instruction_content,
            version=1,
            improved_at=self._now(),
            improvement_source="manual",
        )

        skill = Skill(manifest, instruction)

        # write manifest.yaml
        self._write_yaml(self._manifest_path(skill_dir), manifest.to_dict())

        # write instructions.md
        self._instructions_path(skill_dir).write_text(
            instruction_content, encoding="utf-8"
        )

        # save initial version
        self._version_file(skill_dir, 1).write_text(
            instruction_content, encoding="utf-8"
        )

        # init feedback.jsonl (empty)
        self._feedback_path(skill_dir).write_text("", encoding="utf-8")

        self._cache[name] = skill
        return skill

    def load_skill(self, name: str) -> Skill | None:
        """从磁盘加载单个 skill，不缓存。"""
        skill_dir = self._skill_dir(name)
        manifest_path = self._manifest_path(skill_dir)
        if not manifest_path.exists():
            return None

        data = self._read_yaml(manifest_path)
        manifest = SkillManifest.from_dict(data)

        instr_path = self._instructions_path(skill_dir)
        if instr_path.exists():
            content = instr_path.read_text(encoding="utf-8")
        else:
            content = ""

        instruction = SkillInstruction(
            content=content,
            version=manifest.version,
            improved_at="",
            improvement_source="manual",
        )

        return Skill(manifest, instruction)

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def find_skill(self, query: str) -> list[tuple[Skill, float]]:
        """
        根据查询找最匹配的 skill，返回 (skill, match_score) 列表，按分数降序排列。

        匹配策略（纯规则，无 LLM）：
        1. query 完整词命中 trigger_keywords: +10 分/个
        2. query 完整词出现在 name 中: +8 分
        3. query 完整词出现在 description 中: +5 分
        4. trigger_keyword 完整词出现在 query 中: +3 分/个
        5. query 词出现在 trigger_keyword 中（子串）: +2 分/个
        6. query 中词出现在 description 中（子串）: +1 分/个
        """
        import re as _re
        q = query.lower()
        q_words = set(q.split())
        results: list[tuple[Skill, float]] = []

        def has_word(text: str, word: str) -> bool:
            """检查 text 中是否包含完整词 word（中英文均适用）"""
            return bool(_re.search(rf"\\b{_re.escape(word)}\\b", text))

        for category_dir in self.skills_dir.iterdir():
            if not category_dir.is_dir():
                continue
            for skill_dir in category_dir.iterdir():
                if not skill_dir.is_dir():
                    continue
                skill = self.load_skill(skill_dir.name)
                if skill is None:
                    continue

                manifest = skill.manifest
                score = 0.0
                name_l = manifest.name.lower()
                desc_l = manifest.description.lower()

                # name and description: whole-word match of full query
                if has_word(name_l, q):
                    score += 8
                if has_word(desc_l, q):
                    score += 5

                # trigger keyword matching
                for kw in manifest.trigger_keywords:
                    kw_l = kw.lower()
                    # exact query == keyword
                    if q == kw_l:
                        score += 10
                    # keyword as whole word in query  e.g. kw="debug", q="debug python code"
                    elif has_word(q, kw_l):
                        score += 3
                    # query word as substring in keyword  e.g. qw="debug", kw="openclaw-debug"
                    elif any(qw in kw_l for qw in q_words):
                        score += 2

                # query words as substring in description
                for qw in q_words:
                    if qw in desc_l and len(qw) >= 3:
                        score += 1

                if score > 0 or q == name_l:
                    results.append((skill, score))

        results.sort(key=lambda x: x[1], reverse=True)
        return results

    def log_feedback(
        self,
        skill_name: str,
        rating: float,
        session_id: str,
        suggestion: str = "",
        user_feedback: str = "",
    ) -> None:
        """
        追加一条反馈记录到 skill 的 feedback.jsonl。
        同时更新 manifest.yaml 中的平均 rating 和使用计数。
        """
        skill_dir = self._skill_dir(skill_name)
        fb_path = self._feedback_path(skill_dir)

        feedback = SkillFeedback(
            skill_name=skill_name,
            rating=rating,
            session_id=session_id,
            timestamp=self._now(),
            user_feedback=user_feedback,
            improvement_suggestion=suggestion,
        )

        with fb_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(feedback.to_dict(), ensure_ascii=False) + "\n")

        # update manifest rating / uses
        manifest_path = self._manifest_path(skill_dir)
        data = self._read_yaml(manifest_path)
        manifest = SkillManifest.from_dict(data)

        old_rating = manifest.rating
        old_uses = manifest.uses
        new_uses = old_uses + 1
        # cumulative moving average
        new_rating = round((old_rating * old_uses + rating) / new_uses, 2)

        manifest.uses = new_uses
        manifest.rating = new_rating
        manifest.last_used = self._now()

        self._write_yaml(manifest_path, manifest.to_dict())

        # update in-memory cache if present
        if skill_name in self._cache:
            self._cache[skill_name].manifest = manifest

    def improve_skill(self, skill_name: str) -> Skill | None:
        """
        根据累计 feedback 自动改进 skill 指令。

        规则（纯规则，无 LLM）：
        - rating >= 8：标记高质量指令片段（写入 high_quality.md）
        - rating <= 3：提取改进建议生成 anti-patterns.md
        - 有 improvement_suggestion：追加到 improved_notes.md
        - 以上融合到新版本的 instructions.md
        """
        skill_dir = self._skill_dir(skill_name)
        manifest_path = self._manifest_path(skill_dir)
        fb_path = self._feedback_path(skill_dir)

        if not fb_path.exists():
            return self.load_skill(skill_name)

        # load all feedback
        feedbacks: list[SkillFeedback] = []
        for line in fb_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                feedbacks.append(SkillFeedback.from_dict(json.loads(line)))
            except Exception:
                continue

        if not feedbacks:
            return self.load_skill(skill_name)

        data = self._read_yaml(manifest_path)
        manifest = SkillManifest.from_dict(data)
        old_version = manifest.version

        instr_path = self._instructions_path(skill_dir)
        current_content = instr_path.read_text(encoding="utf-8") if instr_path.exists() else ""

        improvements: list[str] = []
        high_quality: list[str] = []
        anti_patterns: list[str] = []
        suggestions_merged: list[str] = []

        for fb in feedbacks:
            if fb.rating >= 8:
                high_quality.append(f"[{fb.session_id}] rating={fb.rating}")
            if fb.rating <= 3:
                anti_patterns.append(f"[{fb.session_id}] rating={fb.rating}")
            if fb.improvement_suggestion:
                suggestions_merged.append(
                    f"[{fb.session_id}] {fb.improvement_suggestion}"
                )

        # Build improved content
        new_lines = [current_content.rstrip()]
        new_lines.append("")
        new_lines.append("<!-- AUTO-IMPROVED by SkillStore -->")
        new_lines.append(f"<!-- Improved at: {self._now()} -->")
        new_lines.append(f"<!-- Based on {len(feedbacks)} feedback entries -->")

        if suggestions_merged:
            new_lines.append("")
            new_lines.append("## 改进建议 (Improvement Suggestions)")
            for s in suggestions_merged:
                new_lines.append(f"- {s}")

        if high_quality:
            new_lines.append("")
            new_lines.append("## 高评分片段 (High-rated, keep these patterns)")
            for h in high_quality:
                new_lines.append(f"- {h}")

        if anti_patterns:
            new_lines.append("")
            new_lines.append("## 低评分片段 (Anti-patterns to avoid)")
            for a in anti_patterns:
                new_lines.append(f"- {a}")

        new_content = "\n".join(new_lines)
        new_version = old_version + 1

        # Save old version
        self._versions_dir(skill_dir).mkdir(parents=True, exist_ok=True)
        (self._version_file(skill_dir, old_version)).write_text(
            current_content, encoding="utf-8"
        )
        # Save new version
        (self._version_file(skill_dir, new_version)).write_text(
            new_content, encoding="utf-8"
        )

        # Update instructions.md
        instr_path.write_text(new_content, encoding="utf-8")

        # Update manifest version
        manifest.version = new_version
        self._write_yaml(manifest_path, manifest.to_dict())

        instruction = SkillInstruction(
            content=new_content,
            version=new_version,
            improved_at=self._now(),
            improvement_source="auto",
        )
        skill = Skill(manifest, instruction)
        self._cache[skill_name] = skill
        return skill

    def get_skill_prompt(self, query: str) -> str:
        """根据查询返回最匹配的 skill 触发文本。"""
        matches = self.find_skill(query)
        if not matches:
            return ""
        skill, score = matches[0]
        # update last_used
        manifest_path = self._manifest_path(self._skill_dir(skill.manifest.name))
        if manifest_path.exists():
            data = self._read_yaml(manifest_path)
            manifest = SkillManifest.from_dict(data)
            manifest.last_used = self._now()
            self._write_yaml(manifest_path, manifest.to_dict())
        return skill.trigger_text

    def list_skills(self, platform: str | None = None) -> list[Skill]:
        """列出所有 skill，可按 platform 过滤。"""
        skills: list[Skill] = []
        for category_dir in self.skills_dir.iterdir():
            if not category_dir.is_dir():
                continue
            for skill_dir in category_dir.iterdir():
                if not skill_dir.is_dir():
                    continue
                skill = self.load_skill(skill_dir.name)
                if skill is None:
                    continue
                if platform is None or skill.manifest.platform == platform:
                    skills.append(skill)
        return skills

    def delete_skill(self, name: str) -> bool:
        """删除整个 skill 目录。"""
        skill_dir = self._skill_dir(name)
        if skill_dir.exists():
            shutil.rmtree(skill_dir)
            self._cache.pop(name, None)
            return True
        return False

    def get_feedback_history(self, name: str) -> list[SkillFeedback]:
        """读取 skill 的所有反馈记录。"""
        fb_path = self._feedback_path(self._skill_dir(name))
        if not fb_path.exists():
            return []
        feedbacks: list[SkillFeedback] = []
        for line in fb_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                feedbacks.append(SkillFeedback.from_dict(json.loads(line)))
            except Exception:
                continue
        return feedbacks

    def get_version_history(self, name: str) -> list[tuple[int, str]]:
        """返回 [(version, content), ...]"""
        skill_dir = self._skill_dir(name)
        versions_dir = self._versions_dir(skill_dir)
        if not versions_dir.exists():
            return []
        result: list[tuple[int, str]] = []
        for vf in sorted(versions_dir.iterdir()):
            m = re.match(r"v(\d+)\.md", vf.name)
            if m:
                version = int(m.group(1))
                content = vf.read_text(encoding="utf-8")
                result.append((version, content))
        return result
