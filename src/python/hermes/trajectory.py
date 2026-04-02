"""
trajectory.py — 对话轨迹记录
来自 Hermes 的 trajectory.py 设计。
用于收集 RL/Fine-tuning 数据。
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

TRAJECTORY_TAGS = [
    "code_review",
    "bug_fix",
    "refactor",
    "new_feature",
    "explained",
    "research",
    "data_analysis",
    "shell_command",
    "file_edit",
    "planning",
    "failed",
    "timeout",
]


@dataclass
class TrajectoryEntry:
    """
    单条轨迹记录，ShareGPT 格式。
    conversations 格式: [{"role": "user"|"assistant"|"tool", "content": "...", ...}]
    """

    conversations: list[dict]
    timestamp: str
    model: str
    completed: bool
    session_id: str = ""
    agent_id: str = ""
    tags: list[str] = field(default_factory=list)
    trajectory_id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "TrajectoryEntry":
        # backward compat: tags might be None
        d.setdefault("tags", [])
        d.setdefault("trajectory_id", str(uuid.uuid4()))
        return cls(**d)


class TrajectoryLogger:
    """
    轨迹记录器。流式构建 + 批量写入 JSONL。
    """

    def __init__(
        self,
        log_dir: str = "~/.openclaw/trajectories",
        success_filename: str = "trajectory_samples.jsonl",
        fail_filename: str = "failed_trajectories.jsonl",
    ):
        self.log_dir = Path(log_dir).expanduser()
        self.success_file = self.log_dir / success_filename
        self.fail_file = self.log_dir / fail_filename
        self._buffer: list[dict] = []
        self._ensure_dir()

    def _ensure_dir(self) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def _target_file(self, completed: bool) -> Path:
        return self.fail_file if not completed else self.success_file

    def log(
        self,
        messages: list[dict],
        model: str,
        completed: bool,
        session_id: str = "",
        agent_id: str = "",
        tags: Optional[list[str]] = None,
    ) -> str:
        """
        追加一条轨迹记录到 JSONL。
        返回生成的 trajectory_id。
        """
        entry = TrajectoryEntry(
            conversations=messages,
            timestamp=datetime.now(timezone.utc).isoformat(),
            model=model,
            completed=completed,
            session_id=session_id,
            agent_id=agent_id,
            tags=tags or [],
        )
        target = self._target_file(completed)
        with target.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry.to_dict(), ensure_ascii=False) + "\n")
        return entry.trajectory_id

    def log_turn(
        self,
        role: str,
        content: str,
        tool_calls: Optional[list[dict]] = None,
        metadata: Optional[dict] = None,
    ) -> None:
        """
        记录单个 turn（用于流式构建轨迹）。
        """
        turn: dict = {
            "role": role,
            "content": content,
            "tool_calls": tool_calls or [],
        }
        if metadata:
            turn["metadata"] = metadata
        self._buffer.append(turn)

    def flush(
        self,
        model: str,
        completed: bool,
        session_id: str = "",
        agent_id: str = "",
        tags: Optional[list[str]] = None,
    ) -> str:
        """
        将 buffer 写入文件，清空 buffer。
        返回生成的 trajectory_id。
        """
        trajectory_id = self.log(
            messages=self._buffer,
            model=model,
            completed=completed,
            session_id=session_id,
            agent_id=agent_id,
            tags=tags,
        )
        self._buffer = []
        return trajectory_id

    def clear_buffer(self) -> None:
        """清空 buffer 而不写入。"""
        self._buffer = []

    def query(
        self,
        limit: int = 10,
        completed_only: bool = False,
        tag: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> list[TrajectoryEntry]:
        """
        查询历史轨迹。
        """
        files = [self.success_file]
        if not completed_only:
            files.append(self.fail_file)

        results: list[TrajectoryEntry] = []
        for fp in files:
            if not fp.exists():
                continue
            with fp.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = TrajectoryEntry.from_dict(json.loads(line))
                    except Exception:
                        continue

                    if session_id and entry.session_id != session_id:
                        continue
                    if tag and tag not in (entry.tags or []):
                        continue

                    results.append(entry)
                    if len(results) >= limit:
                        return results

        return results

    def count(self, completed_only: bool = False) -> int:
        """返回轨迹总数。"""
        total = 0
        files = [self.success_file]
        if not completed_only:
            files.append(self.fail_file)
        for fp in files:
            if fp.exists():
                with fp.open("r", encoding="utf-8") as fh:
                    total += sum(1 for line in fh if line.strip())
        return total

    def tag_suggestions(self, limit: int = 5) -> list[str]:
        """返回最近轨迹中出现最频繁的标签。"""
        tag_counts: dict[str, int] = {}
        for fp in [self.success_file, self.fail_file]:
            if not fp.exists():
                continue
            with fp.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = TrajectoryEntry.from_dict(json.loads(line))
                    except Exception:
                        continue
                    for t in entry.tags or []:
                        tag_counts[t] = tag_counts.get(t, 0) + 1
        return sorted(tag_counts, key=lambda x: tag_counts[x], reverse=True)[:limit]


if __name__ == "__main__":
    import tempfile

    print("=== trajectory 单元测试 ===")

    # 使用临时目录
    with tempfile.TemporaryDirectory() as tmpdir:
        logger = TrajectoryLogger(log_dir=tmpdir)

        # 测试1: log + query
        tid = logger.log(
            messages=[
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hi there!"},
            ],
            model="MiniMax-M2.7",
            completed=True,
            session_id="sess-001",
            tags=["explained"],
        )
        print(f"写入轨迹 ID: {tid}")

        results = logger.query(limit=10)
        assert len(results) == 1
        assert results[0].model == "MiniMax-M2.7"
        assert results[0].completed is True
        print(f"查询结果: {len(results)} 条")

        # 测试2: log_turn + flush
        logger.log_turn("user", "帮我写一个快速排序")
        logger.log_turn("assistant", "def quicksort(arr): ...", tool_calls=[{"name": "write"}])
        logger.log_turn("tool", "文件已写入 /tmp/sort.py")
        tid2 = logger.flush(model="MiniMax-M2.7", completed=True, tags=["code_review"])
        print(f"flush 轨迹 ID: {tid2}")

        results = logger.query(limit=10)
        assert len(results) == 2
        print(f"log_turn+flush 后查询: {len(results)} 条")

        # 测试3: failed 轨迹
        logger.log(
            messages=[{"role": "user", "content": "debug this"}],
            model="MiniMax-M2.7",
            completed=False,
            tags=["failed"],
        )

        all_results = logger.query(limit=10)
        assert len(all_results) == 3
        completed_only = logger.query(limit=10, completed_only=True)
        assert len(completed_only) == 2
        print(f"completed_only 查询: {len(completed_only)} 条")

        # 测试4: tag 过滤
        tagged = logger.query(limit=10, tag="code_review")
        assert len(tagged) == 1
        print(f"tag=code_review 查询: {len(tagged)} 条")

        # 测试5: count
        assert logger.count() == 3
        assert logger.count(completed_only=True) == 2
        print(f"count: {logger.count()}, completed_only: {logger.count(completed_only=True)}")

        # 测试6: tag_suggestions
        suggestions = logger.tag_suggestions()
        print(f"标签建议: {suggestions}")

    print("\n✅ 所有测试通过！")
