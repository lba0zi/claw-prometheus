"""
models_dev.py — 模型注册表查询
来自 Hermes 的 models_dev.py 设计。
从 models.dev/api.json 获取所有模型的 context window 和价格。
"""

import json
import os
import time
import urllib.request
from pathlib import Path
from typing import Optional

__all__ = ["fetch_models_dev", "get_model_info", "find_cheapest_model", "ModelInfo"]

MODELS_DEV_URL = "https://models.dev/api.json"
CACHE_TTL = 3600  # 1 hour

# Disk cache path
CACHE_DIR = Path.home() / ".openclaw"
CACHE_FILE = CACHE_DIR / "models_dev_cache.json"

PROVIDER_MAP = {
    "openrouter": "openrouter",
    "anthropic": "anthropic",
    "minimax": "minimax",
    "deepseek": "deepseek",
    "openai": "openai",
    "kimi": "kimi",
    "zai": "zai",
    "fireworks": "fireworks",
    "together": "together",
    # Aliases / variations
    "or": "openrouter",
    "anthropic-claude": "anthropic",
    "openai-gpt": "openai",
    "moonshot": "kimi",
    "zhipu": "zai",
}

# Provider display names
PROVIDER_DISPLAY = {
    "openrouter": "OpenRouter",
    "anthropic": "Anthropic",
    "minimax": "MiniMax",
    "deepseek": "DeepSeek",
    "openai": "OpenAI",
    "kimi": "Kimi (Moonshot)",
    "zai": "Zhipu (Zai)",
    "fireworks": "Fireworks AI",
    "together": "Together AI",
}

# Context window defaults by provider (if not in API data)
DEFAULT_CONTEXTS = {
    "anthropic": 200000,
    "openai": 128000,
    "deepseek": 128000,
    "minimax": 1000000,
    "openrouter": 128000,  # varies by model
    "kimi": 128000,
    "zai": 128000,
    "fireworks": 128000,
    "together": 128000,
}

# Price per 1M tokens — used as fallback when API data is missing
DEFAULT_INPUT_PRICES = {
    "anthropic": 3.0,
    "openai": 2.5,
    "deepseek": 0.27,
    "minimax": 0.0,
    "openrouter": 0.1,
    "kimi": 0.0,
    "zai": 0.0,
    "fireworks": 0.7,
    "together": 0.5,
}

DEFAULT_OUTPUT_PRICES = {
    "anthropic": 15.0,
    "openai": 10.0,
    "deepseek": 1.1,
    "minimax": 0.0,
    "openrouter": 0.1,
    "kimi": 0.0,
    "zai": 0.0,
    "fireworks": 2.0,
    "together": 0.5,
}

# Task complexity -> price tier
TASK_TIERS = {
    "simple": {"max_price": 0.5},      # Q&A, translation, simple code
    "medium": {"max_price": 2.0},      # writing, analysis
    "complex": {"max_price": 10.0},   # deep reasoning, long context
    "unknown": {"max_price": 100.0},  # no match, use all
}

# Keywords for task classification
TASK_KEYWORDS = {
    "simple": [
        "翻译", "translate", "spell check", "grammar", "fix typo",
        "simple", "hello", "hi ", "天气", "question", "what is",
        "who is", "definition", "lookup", "查", "问",
    ],
    "complex": [
        "reasoning", "think", "analyze deeply", "complex", "research",
        "long context", "deep search", "写论文", "分析", "深度",
        "reason", "logical", "multi-step", "cohere", "reasoning",
    ],
}


class ModelInfo:
    """模型信息。"""
    def __init__(
        self,
        name: str,
        provider: str,
        context_window: int,
        input_price: float,   # per 1M tokens
        output_price: float,  # per 1M tokens
        display_name: str = "",
        description: str = "",
        supports_vision: bool = False,
        supports_function_calling: bool = False,
        **extra,
    ):
        self.name = name
        self.provider = provider
        self.context_window = context_window
        self.input_price = input_price
        self.output_price = output_price
        self.display_name = display_name or name
        self.description = description
        self.supports_vision = supports_vision
        self.supports_function_calling = supports_function_calling
        self._extra = extra

    def __repr__(self):
        return (f"<ModelInfo {self.name} [{self.provider}] "
                f"context={self.context_window} "
                f"${self.input_price}/${self.output_price}/1M>")

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "provider": self.provider,
            "context_window": self.context_window,
            "input_price": self.input_price,
            "output_price": self.output_price,
            "display_name": self.display_name,
            "description": self.description,
            "supports_vision": self.supports_vision,
            "supports_function_calling": self.supports_function_calling,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ModelInfo":
        return cls(**{k: v for k, v in d.items() if k not in ("_extra",)})


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

_cache: Optional[dict] = None
_cache_timestamp: float = 0


def _get_cache() -> Optional[dict]:
    """Get in-memory cache if fresh."""
    global _cache, _cache_timestamp
    if _cache is not None and (time.time() - _cache_timestamp) < CACHE_TTL:
        return _cache
    return None


def _load_disk_cache() -> Optional[dict]:
    """Load disk cache if fresh."""
    if not CACHE_FILE.exists():
        return None
    try:
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict) and "timestamp" in data:
            age = time.time() - data["timestamp"]
            if age < CACHE_TTL:
                return data
    except (OSError, json.JSONDecodeError):
        pass
    return None


def _save_disk_cache(data: dict) -> None:
    """Save to disk cache."""
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Fetch
# ---------------------------------------------------------------------------

def fetch_models_dev(force_refresh: bool = False) -> dict:
    """
    获取 models.dev 注册表（带内存+磁盘缓存）。

    Parameters
    ----------
    force_refresh : bool
        强制从网络刷新

    Returns
    -------
    dict
        原始 API 数据
    """
    global _cache, _cache_timestamp

    if not force_refresh:
        mem = _get_cache()
        if mem is not None:
            return mem
        disk = _load_disk_cache()
        if disk is not None:
            _cache = disk
            _cache_timestamp = time.time()
            return disk

    # Fetch from network
    try:
        req = urllib.request.Request(
            MODELS_DEV_URL,
            headers={"User-Agent": "Hermes/1.0"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode('utf-8', errors='replace')
            data = json.loads(raw)
    except Exception as e:
        # Fallback: return cached data even if stale
        disk = _load_disk_cache()
        if disk is not None:
            return disk
        raise RuntimeError(f"Failed to fetch models.dev: {e}")

    # Normalize: wrap in dict with timestamp
    if isinstance(data, list):
        data = {"models": data}
    data["timestamp"] = time.time()

    _cache = data
    _cache_timestamp = time.time()
    _save_disk_cache(data)
    return data


# ---------------------------------------------------------------------------
# Query
# ---------------------------------------------------------------------------

def _normalize_provider(provider: str) -> str:
    """Normalize provider name."""
    lower = provider.lower()
    return PROVIDER_MAP.get(lower, lower)


def _guess_provider_from_name(name: str) -> str:
    """Guess provider from model name."""
    name_lower = name.lower()
    for prov, keywords in {
        "openrouter": ["openrouter"],
        "anthropic": ["claude", "anthropic"],
        "deepseek": ["deepseek"],
        "openai": ["gpt", "openai"],
        "minimax": ["minimax", "abab"],
        "kimi": ["kimi", "moonshot", "ai"],
        "zai": ["zhipu", "glm", "zai"],
        "fireworks": ["fireworks"],
        "together": ["together"],
    }.items():
        if any(k in name_lower for k in keywords):
            return prov
    return "openrouter"  # default


def get_model_info(model: str, provider: str = "") -> Optional[ModelInfo]:
    """
    查询指定模型的信息。

    Parameters
    ----------
    model : str
        模型名（如 'claude-3-5-sonnet'）
    provider : str
        提供商（如 'anthropic', 'openrouter'）

    Returns
    -------
    ModelInfo | None
    """
    data = fetch_models_dev()
    providers = [p.lower().strip() for p in provider.split(",") if p.strip()]
    if not providers:
        providers = [_guess_provider_from_name(model)]

    models_list = data.get("models", [])

    # Try exact match first
    for entry in models_list:
        entry_name = entry.get("name", "")
        entry_provider = (_normalize_provider(entry.get("provider", "")) or
                          _guess_provider_from_name(entry_name))
        if entry_name.lower() == model.lower() and entry_provider in providers:
            return _entry_to_model_info(entry)

    # Try substring match
    for entry in models_list:
        entry_name = entry.get("name", "")
        entry_provider = (_normalize_provider(entry.get("provider", "")) or
                          _guess_provider_from_name(entry_name))
        if model.lower() in entry_name.lower() and entry_provider in providers:
            return _entry_to_model_info(entry)

    # Not found in API — return with defaults
    if providers:
        return ModelInfo(
            name=model,
            provider=providers[0],
            context_window=DEFAULT_CONTEXTS.get(providers[0], 128000),
            input_price=DEFAULT_INPUT_PRICES.get(providers[0], 0.1),
            output_price=DEFAULT_OUTPUT_PRICES.get(providers[0], 0.1),
        )
    return None


def _entry_to_model_info(entry: dict) -> ModelInfo:
    """Convert API entry to ModelInfo."""
    name = entry.get("name", "")
    raw_provider = entry.get("provider", "")
    provider = _normalize_provider(raw_provider) or _guess_provider_from_name(name)

    # Context window: try different field names
    ctx = entry.get("context_length") or entry.get("context_window") or DEFAULT_CONTEXTS.get(provider, 128000)

    # Prices
    inp = entry.get("input", entry.get("input_price", DEFAULT_INPUT_PRICES.get(provider, 0)))
    out = entry.get("output", entry.get("output_price", DEFAULT_OUTPUT_PRICES.get(provider, 0)))

    # Handle nested price objects
    if isinstance(inp, dict):
        inp = inp.get("price", 0)
    if isinstance(out, dict):
        out = out.get("price", 0)

    return ModelInfo(
        name=name,
        provider=provider,
        context_window=int(ctx),
        input_price=float(inp) if inp else 0.0,
        output_price=float(out) if out else 0.0,
        display_name=entry.get("display_name", name),
        description=entry.get("description", ""),
        supports_vision=bool(entry.get("vision", entry.get("supports_vision", False))),
        supports_function_calling=bool(entry.get("function_calling", entry.get("supports_function_calling", False))),
    )


def _classify_task(task: str) -> str:
    """Classify task complexity."""
    task_lower = task.lower()
    complex_score = sum(1 for kw in TASK_KEYWORDS["complex"] if kw in task_lower)
    simple_score = sum(1 for kw in TASK_KEYWORDS["simple"] if kw in task_lower)
    if complex_score > simple_score:
        return "complex"
    return "medium"


def find_cheapest_model(
    task: str,
    required_context: int = 128000,
    providers: list[str] = None,
) -> Optional[ModelInfo]:
    """
    根据任务描述找最便宜的可用模型。

    Parameters
    ----------
    task : str
        任务描述（如 'simple Q&A', 'complex reasoning'）
    required_context : int
        所需最小上下文窗口
    providers : list[str], optional
        限定提供商列表

    Returns
    -------
    ModelInfo | None
    """
    data = fetch_models_dev()
    models_list = data.get("models", [])

    # Filter
    tier = _classify_task(task)
    max_price = TASK_TIERS[tier]["max_price"]

    candidates = []
    for entry in models_list:
        info = _entry_to_model_info(entry)

        # Filter by provider
        if providers:
            normalized = [_normalize_provider(p) for p in providers]
            if info.provider not in normalized:
                continue

        # Filter by context
        if info.context_window < required_context:
            continue

        # Filter by price tier
        if info.input_price > max_price:
            continue

        candidates.append(info)

    if not candidates:
        # Relax price constraint
        for entry in models_list:
            info = _entry_to_model_info(entry)
            if providers and info.provider not in [_normalize_provider(p) for p in providers]:
                continue
            if info.context_window < required_context:
                continue
            candidates.append(info)

    if not candidates:
        return None

    # Sort by input price ascending
    candidates.sort(key=lambda m: m.input_price)
    return candidates[0]
