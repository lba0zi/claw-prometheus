import sys
sys.path.insert(0, r"C:\Users\Surface\.openclaw\workspace-main\src\python\hermes\skills")
from skills import SkillStore, BUILTIN_OPENCLAW_SKILLS

store = SkillStore()

# Register built-in skills
for s in BUILTIN_OPENCLAW_SKILLS:
    name = s["name"]
    store.register_skill(**s)
    print("Registered:", name)

# Find skill
matches = store.find_skill("帮我写一个Python函数")
print()
print("Query matches:")
for skill, score in matches:
    print(f"  [{score:.0f}] {skill.manifest.name} - {skill.manifest.description}")

# Log feedback
store.log_feedback("openclaw-coder", rating=7, session_id="test-session-001", suggestion="可以增加更多类型注解示例")
print()
print("Feedback logged.")

# Show skill prompt
prompt = store.get_skill_prompt("写代码")
print()
print("Skill prompt preview:", prompt[:120], "...")

# List all skills
all_skills = store.list_skills()
print()
print("Total skills:", len(all_skills))
for s in all_skills:
    print(f"  {s.manifest.name} (v{s.manifest.version}, uses={s.manifest.uses}, rating={s.manifest.rating})")

# Check files created
import os
skills_root = os.path.expanduser("~/.openclaw/skills")
print()
for root, dirs, files in os.walk(skills_root):
    level = root.replace(skills_root, "").count(os.sep)
    indent = "  " * level
    print(f"{indent}{os.path.basename(root)}/")
    subindent = "  " * (level + 1)
    for f in files:
        print(f"{subindent}{f}")

# Test improve_skill
print()
print("Testing improve_skill...")
store.log_feedback("openclaw-coder", rating=2, session_id="bad-session", suggestion="缺少错误处理示例")
improved = store.improve_skill("openclaw-coder")
print("Improved skill version:", improved.manifest.version if improved else "None")

# Show version history
versions = store.get_version_history("openclaw-coder")
print("Version history:", len(versions), "versions")
for v, _ in versions:
    print(f"  v{v}")
