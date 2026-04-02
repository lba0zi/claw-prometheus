"""
claw-prometheus Hermes Extensions
================================
从 Hermes Agent 源码中提炼的可选增强模块。
OpenClaw 可选择性加载这些能力。

使用方式:
    from src.python.hermes import (
        context_threat,
        context_reference,
        smart_routing,
        trajectory,
        context_compressor,
    )
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

__all__ = [
    "context_threat",
    "context_reference",
    "smart_routing",
    "trajectory",
    "context_compressor",
]
if HAS_SKILLS:
    __all__.append("skill")
