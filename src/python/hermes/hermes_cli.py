"""
hermes_cli.py — Hermes Extensions 命令行接口
============================================
所有 Hermes 能力通过这个 CLI 对外暴露，供 TypeScript/OpenClaw 工具调用。

用法:
    python hermes_cli.py <command> [args...]

命令:
    shield <text>              — Context Threat 安全扫描
    expand <text> [--cwd .]   — @引用展开
    route <text>              — 智能路由决策
    skills find <query>       — 查找匹配的 Skills
    skills list               — 列出所有已注册 Skills
    skills feedback <name> <rating> [suggestion]  — 记录反馈
    compress <json_messages>  — 分层 Context 压缩
"""

import sys
import json
import os
from pathlib import Path

# 确保 hermes 包在路径中
CLI_DIR = Path(__file__).parent
WORKSPACE = Path(r"C:\Users\Surface\.openclaw\workspace-main")
SRC_PYTHON = WORKSPACE / "src" / "python"
sys.path.insert(0, str(SRC_PYTHON))

VENV_PYTHON = WORKSPACE / ".venv" / "Scripts" / "python.exe"


def cmd_shield(text: str) -> dict:
    """扫描威胁"""
    from hermes import context_threat
    result = context_threat.scan_content(text)
    return {
        "blocked": result.blocked,
        "findings": result.findings,
        "clean_content": result.clean_content,
    }


def cmd_expand(text: str, cwd: str = ".") -> dict:
    """展开 @ 引用"""
    from hermes import context_reference
    result = context_reference.expand_references(text, cwd=cwd, context_length=150000)
    return {
        "message": result.message,
        "warnings": result.warnings,
        "ref_count": len(result.refs),
        "refs": [
            {
                "type": ref.reference_type,
                "raw": ref.raw,
                "expanded": ref.expanded_content[:200] if ref.expanded_content else "",
                "truncated": ref.truncated,
            }
            for ref in result.refs
        ],
    }


def cmd_route(text: str) -> dict:
    """智能路由"""
    from hermes import smart_routing
    r = smart_routing.choose_route(
        user_message=text,
        primary_provider="minimax",
        primary_model="MiniMax-M2.7",
        cheap_provider="minimax",
        cheap_model="abab6.5s-chat",
    )
    return {
        "use_cheap": r.use_cheap,
        "provider": r.provider,
        "model": r.model,
        "reason": r.reason,
        "score": r.complexity_score,
        "matched_keywords": r.matched_keywords,
    }


def cmd_skills_find(query: str) -> dict:
    """查找 Skills"""
    from hermes.integration import HermesIntegration
    h = HermesIntegration(enable_skills=True, skills_dir=str(WORKSPACE / "src" / "python" / "hermes" / "skills"))
    matches = h.find_skills(query)
    return {
        "matches": [
            {
                "name": s.manifest.name,
                "description": s.manifest.description,
                "trigger": s.trigger_text[:100] if s.trigger_text else "",
                "confidence": round(score, 2),
            }
            for s, score in matches
        ],
        "count": len(matches),
    }


def cmd_skills_list() -> dict:
    """列出所有 Skills"""
    from hermes.integration import HermesIntegration
    h = HermesIntegration(enable_skills=True, skills_dir=str(WORKSPACE / "src" / "python" / "hermes" / "skills"))
    if not h.skill_store:
        return {"skills": [], "count": 0}
    all_skills = h.skill_store.list_skills()
    return {
        "skills": [
            {
                "name": s.manifest.name,
                "description": s.manifest.description,
                "trigger": s.trigger_text[:80] if s.trigger_text else "",
                "rating": s.manifest.rating,
                "uses": s.manifest.uses,
            }
            for s in all_skills
        ],
        "count": len(all_skills),
    }


def cmd_skills_feedback(name: str, rating: float, suggestion: str = "") -> dict:
    """记录 Skill 反馈"""
    from hermes.integration import HermesIntegration
    h = HermesIntegration(enable_skills=True, skills_dir=str(WORKSPACE / "src" / "python" / "hermes" / "skills"))
    h.log_skill_feedback(name, rating, suggestion=suggestion)
    return {"ok": True, "skill": name, "rating": rating}


def cmd_compress(messages_json: str) -> dict:
    """分层 Context 压缩"""
    from hermes.integration import HermesIntegration
    messages = json.loads(messages_json)
    h = HermesIntegration()
    result = h.compress_if_needed(messages)
    if result is None:
        return {"compressed": False, "reason": "under threshold"}
    return {
        "compressed": True,
        "original_tokens": result.original_tokens,
        "compressed_tokens": result.compressed_tokens,
        "ratio": result.compression_ratio,
        "method": result.method,
        "summary": result.summary[:300],
    }


COMMANDS = {
    "shield": cmd_shield,
    "expand": cmd_expand,
    "route": cmd_route,
    "skills_find": cmd_skills_find,
    "skills_list": cmd_skills_list,
    "skills_feedback": cmd_skills_feedback,
    "compress": cmd_compress,
}


def main():
    if len(sys.argv) < 2:
        print("Usage: hermes_cli.py <command> [args...]")
        print("Commands:", ", ".join(COMMANDS.keys()))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "expand" and len(sys.argv) >= 3:
        # expand <text> [--cwd path]
        text = sys.argv[2]
        cwd = "."
        if len(sys.argv) >= 5 and sys.argv[3] == "--cwd":
            cwd = sys.argv[4]
        result = cmd_expand(text, cwd)

    elif cmd == "skills_find" and len(sys.argv) >= 3:
        query = " ".join(sys.argv[2:])
        result = cmd_skills_find(query)

    elif cmd == "skills_list":
        result = cmd_skills_list()

    elif cmd == "skills_feedback" and len(sys.argv) >= 4:
        name = sys.argv[2]
        rating = float(sys.argv[3])
        suggestion = " ".join(sys.argv[4:]) if len(sys.argv) > 4 else ""
        result = cmd_skills_feedback(name, rating, suggestion)

    elif cmd == "compress" and len(sys.argv) >= 3:
        result = cmd_compress(sys.argv[2])

    elif cmd in COMMANDS:
        text = " ".join(sys.argv[2:])
        result = COMMANDS[cmd](text)

    else:
        print(json.dumps({"error": f"Unknown command or missing args: {sys.argv}"}))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
