"""
context_reference.py — @引用展开器
来自 Hermes 的 context_references.py 设计。
"""

import re
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional, Callable

__all__ = ["parse_references", "expand_references", "ContextRef", "RefExpansionResult"]

MAX_FILE_SIZE = 50 * 1024  # 50KB
DEFAULT_CONTEXT_LENGTH = 200000


REFERENCE_PATTERN = re.compile(
    r'(?<![\w/])@(?:(?P<simple>diff|staged)\b|(?P<kind>file|folder|git|url):(?P<value>\S+))'
)


class ContextRef:
    """表示解析出的一个 @ 引用。"""
    def __init__(
        self,
        raw: str,
        kind: str,        # 'file', 'folder', 'git', 'url', 'diff', 'staged'
        target: str,      # 引用目标值
        line_range: Optional[tuple[int, int]] = None,
        position: int = 0,
    ):
        self.raw = raw
        self.kind = kind
        self.target = target
        self.line_range = line_range
        self.position = position

    def __repr__(self):
        if self.line_range:
            return f"<ContextRef {self.kind}:{self.target}:{self.line_range[0]}-{self.line_range[1]}>"
        return f"<ContextRef {self.kind}:{self.target}>"


class RefExpansionResult:
    """@引用展开结果。"""
    def __init__(
        self,
        message: str,
        original_message: str,
        refs: list[ContextRef],
        warnings: list[str],
        injected_tokens: int,
        expanded: bool,
        blocked: bool,
    ):
        self.message = message
        self.original_message = original_message
        self.refs = refs
        self.warnings = warnings
        self.injected_tokens = injected_tokens
        self.expanded = expanded
        self.blocked = blocked

    def __repr__(self):
        return (f"<RefExpansionResult refs={len(self.refs)} "
                f"tokens={self.injected_tokens} blocked={self.blocked}>")


def _estimate_tokens(text: str) -> int:
    """
    估算 token 数量。
    中文 4 字符 ≈ 1 token，英文 1 token ≈ 4 字符。
    混合文本按比例估算。
    """
    if not text:
        return 0

    chinese_chars = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
    other_chars = len(text) - chinese_chars

    # Chinese: 4 chars/token; English: 4 chars/token
    # Total tokens = (chinese/4) + (other/4) but simplified:
    return (chinese_chars + other_chars) // 4 + 1


def _resolve_path(target: str, cwd: str) -> str:
    """
    解析引用路径，防止路径穿越。
    只允许在 cwd 下的文件/目录。
    """
    # Handle absolute paths
    if os.path.isabs(target):
        resolved = os.path.normpath(target)
    else:
        resolved = os.path.normpath(os.path.join(cwd, target))

    # Security: ensure resolved path is under cwd
    try:
        cwd_abs = os.path.abspath(cwd)
        resolved_abs = os.path.abspath(resolved)
        # Must be under cwd
        if not resolved_abs.startswith(cwd_abs + os.sep) and resolved_abs != cwd_abs:
            raise ValueError(f"Path outside cwd: {target}")
    except ValueError:
        raise

    return resolved


def _read_file_lines(filepath: str, line_range: Optional[tuple[int, int]] = None) -> str:
    """
    读取文件指定行。
    line_range: (start, end) 1-indexed inclusive
    """
    resolved = _resolve_path(filepath, ".")

    if not os.path.isfile(resolved):
        return f"[Error: file not found: {filepath}]"

    try:
        size = os.path.getsize(resolved)
        if size > MAX_FILE_SIZE:
            return f"[Error: file too large ({size} bytes, max {MAX_FILE_SIZE}): {filepath}]"
    except OSError:
        return f"[Error: cannot access file: {filepath}]"

    try:
        with open(resolved, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except OSError as e:
        return f"[Error: cannot read file: {e}]"

    if line_range:
        start, end = line_range
        # Convert to 0-indexed
        start_idx = max(0, start - 1)
        end_idx = min(len(lines), end)
        if start_idx >= len(lines):
            return f"[Error: line range out of bounds: {filepath}:{start}-{end}]"
        selected = lines[start_idx:end_idx]
        header = f"// File: {filepath} (lines {start}-{end})\n"
    else:
        selected = lines
        header = f"// File: {filepath}\n"

    return header + ''.join(selected)


def _list_folder(target: str, cwd: str) -> str:
    """列出目录结构，不展开文件内容。"""
    try:
        resolved = _resolve_path(target, cwd)
    except ValueError as e:
        return f"[Error: {e}]"

    if not os.path.isdir(resolved):
        return f"[Error: not a directory: {target}]"

    try:
        entries = []
        for name in sorted(os.listdir(resolved)):
            full = os.path.join(resolved, name)
            if os.path.isdir(full):
                entries.append(f"  📁 {name}/")
            else:
                size = os.path.getsize(full)
                entries.append(f"  📄 {name} ({size}B)")
        if not entries:
            return f"// Folder: {target} (empty)"
        return f"// Folder: {target}\n" + "\n".join(entries)
    except OSError as e:
        return f"[Error: cannot list directory: {e}]"


def _run_git(args: list[str]) -> str:
    """运行 git 命令。"""
    try:
        result = subprocess.run(
            ['git'] + args,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0 and result.stderr:
            return f"[Error: git {' '.join(args)} failed: {result.stderr.strip()}]"
        return result.stdout or "[no output]"
    except subprocess.TimeoutExpired:
        return "[Error: git command timed out]"
    except FileNotFoundError:
        return "[Error: git not found]"
    except OSError as e:
        return f"[Error: cannot run git: {e}]"


def _get_git_diff(count: Optional[int] = None) -> str:
    """获取 git diff 或 log。"""
    if count is not None and count > 0:
        return _run_git(['log', f'-{count}', '--patch'])
    elif count is not None and count == 0:
        return _run_git(['log', '--oneline', '-10'])
    else:
        return _run_git(['diff'])


def _get_git_staged() -> str:
    """获取 git diff --staged。"""
    return _run_git(['diff', '--staged'])


def _fetch_url(url: str, url_fetcher: Optional[Callable] = None) -> str:
    """抓取 URL 内容。"""
    if url_fetcher is not None:
        try:
            return url_fetcher(url)
        except Exception as e:
            return f"[Error fetching URL: {e}]"

    # Built-in fetcher using urllib
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=10) as resp:
            content = resp.read().decode('utf-8', errors='replace')
            # Truncate if too large
            if len(content) > MAX_FILE_SIZE * 2:
                content = content[:MAX_FILE_SIZE * 2] + f"\n[...truncated {len(content) - MAX_FILE_SIZE * 2} chars...]"
            return content
    except ImportError:
        return "[Error: urllib not available]"
    except Exception as e:
        return f"[Error fetching URL: {e}]"


def _parse_line_range(value: str) -> tuple[str, Optional[tuple[int, int]]]:
    """
    解析 'path/to/file:10-20' 格式。
    返回 (path, (start, end) or None)
    """
    # Match :N-M or :N  at the end
    m = re.match(r'^(.+):(\d+)-(\d+)$', value)
    if m:
        path = m.group(1)
        return path, (int(m.group(2)), int(m.group(3)))
    m = re.match(r'^(.+):(\d+)$', value)
    if m:
        path = m.group(1)
        n = int(m.group(2))
        return path, (n, n)
    return value, None


def parse_references(message: str) -> list[ContextRef]:
    """
    解析消息中的 @ 引用。

    Parameters
    ----------
    message : str

    Returns
    -------
    list[ContextRef]
    """
    refs = []
    for m in REFERENCE_PATTERN.finditer(message):
        raw = m.group(0)
        simple = m.group('simple')
        kind = m.group('kind')
        value = m.group('value')

        if simple:
            refs.append(ContextRef(raw=raw, kind=simple, target=simple, position=m.start()))
        elif kind == 'file':
            path, line_range = _parse_line_range(value)
            refs.append(ContextRef(raw=raw, kind='file', target=path, line_range=line_range, position=m.start()))
        elif kind == 'folder':
            refs.append(ContextRef(raw=raw, kind='folder', target=value, position=m.start()))
        elif kind == 'git':
            # @git:N means last N commits with diff
            try:
                n = int(value)
            except ValueError:
                n = 5
            refs.append(ContextRef(raw=raw, kind='git', target=str(n), position=m.start()))
        elif kind == 'url':
            refs.append(ContextRef(raw=raw, kind='url', target=value, position=m.start()))
        else:
            # Should not happen
            refs.append(ContextRef(raw=raw, kind='unknown', target=value, position=m.start()))

    return refs


def expand_references(
    message: str,
    cwd: str = ".",
    context_length: int = DEFAULT_CONTEXT_LENGTH,
    max_tokens_ratio: float = 0.5,
    url_fetcher: Optional[Callable] = None,
) -> RefExpansionResult:
    """
    展开所有 @ 引用，返回修改后的消息。

    Parameters
    ----------
    message : str
        原始消息
    cwd : str
        当前工作目录（用于解析相对路径）
    context_length : int
        最大上下文长度（token）
    max_tokens_ratio : float
        引用内容占 context_length 的最大比例（硬限制）
    url_fetcher : callable, optional
        URL 抓取函数，签名为 fn(url) -> str

    Returns
    -------
    RefExpansionResult
        展开结果
    """
    original_message = message
    refs = parse_references(message)
    warnings = []
    injected_parts: list[tuple[int, str]] = []  # (position, expanded_text)

    for ref in refs:
        if ref.kind == 'file':
            expanded = _read_file_lines(ref.target, ref.line_range)
        elif ref.kind == 'folder':
            expanded = _list_folder(ref.target, cwd)
        elif ref.kind == 'git':
            try:
                n = int(ref.target)
            except ValueError:
                n = 5
            expanded = _get_git_diff(n)
        elif ref.kind == 'diff':
            expanded = _get_git_diff()
        elif ref.kind == 'staged':
            expanded = _get_git_staged()
        elif ref.kind == 'url':
            expanded = _fetch_url(ref.target, url_fetcher)
        else:
            expanded = f"[Unknown ref kind: {ref.kind}]"

        injected_parts.append((ref.position, expanded))

    # Build expanded message by replacing @refs with expansions
    # Sort by position descending to replace from end to start
    expanded_message = message
    for pos, expanded in sorted(injected_parts, key=lambda x: -x[0]):
        # Find the @ref at this position
        ref_start = pos
        # Find the end of this reference (next whitespace or end)
        # Simple approach: replace the raw ref text
        for ref in refs:
            if ref.position == pos:
                expanded_message = expanded_message.replace(ref.raw, f"\n{expanded}\n", 1)
                break

    # Estimate tokens of injected content
    injected_text = "\n".join(expanded for _, expanded in injected_parts)
    injected_tokens = _estimate_tokens(injected_text)

    # Hard limit: injected <= context_length * max_tokens_ratio
    hard_limit = int(context_length * max_tokens_ratio)
    soft_limit = int(context_length * 0.25)

    blocked = injected_tokens > hard_limit
    if injected_tokens > hard_limit:
        warnings.append(
            f"Token limit exceeded: {injected_tokens} > {hard_limit} "
            f"(ratio {injected_tokens/context_length:.1%}, max {max_tokens_ratio:.0%})"
        )
    elif injected_tokens > soft_limit:
        warnings.append(
            f"High token usage: {injected_tokens} tokens "
            f"({injected_tokens/context_length:.1%} of context)"
        )

    expanded = len(refs) > 0

    return RefExpansionResult(
        message=expanded_message,
        original_message=original_message,
        refs=refs,
        warnings=warnings,
        injected_tokens=injected_tokens,
        expanded=expanded,
        blocked=blocked,
    )
