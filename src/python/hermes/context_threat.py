"""
context_threat.py — Prompt 注入攻击检测
来自 Hermes 的 prompt_builder.py 安全设计。
"""

import re
import os
from typing import Optional

__all__ = ["scan_content", "scan_file", "is_safe_to_inject", "ThreatReport"]

CONTEXT_THREAT_PATTERNS = [
    # prompt injection
    (r'ignore\s+(previous|all|above|prior)\s+instructions', 'prompt_injection'),
    (r'do\s+not\s+tell\s+the\s+user', 'deception_hide'),
    (r'system\s+prompt\s+override', 'sys_prompt_override'),
    (r'disregard\s+(your|all|any)\s+(instructions|rules|guidelines)', 'disregard_rules'),
    (r'act\s+as\s+(if|though)\s+you\s+(have\s+no|don\'t\s+have)\s+(restrictions|limits|rules)', 'bypass_restrictions'),
    # HTML/invisible injection
    (r'<\s*div\s+style\s*=\s*["\'].*display\s*:\s*none', 'hidden_div'),
    (r'<\s*!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->', 'html_comment_injection'),
    # exfiltration
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', 'exfil_curl'),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)', 'read_secrets'),
    (r'base64\s+-d\s+[^\n]+', 'base64_decode_secrets'),
    (r'wget\s+.*\$\{?\w*(KEY|TOKEN|SECRET)', 'wget_exfil'),
]

# Compile patterns for performance
_COMPILED_PATTERNS = [(re.compile(p, re.IGNORECASE | re.DOTALL), label) for p, label in CONTEXT_THREAT_PATTERNS]

INVISIBLE_UNICODE = {'\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
                     '\u202a', '\u202b', '\u202c', '\u202d', '\u202e'}

# Severity level for each threat type — higher = more severe
THREAT_SEVERITY = {
    'prompt_injection': 5,
    'deception_hide': 5,
    'sys_prompt_override': 7,
    'disregard_rules': 6,
    'bypass_restrictions': 7,
    'hidden_div': 4,
    'html_comment_injection': 4,
    'exfil_curl': 9,
    'read_secrets': 9,
    'base64_decode_secrets': 8,
    'wget_exfil': 9,
}

# Threats with severity >= 8 are blocked outright
BLOCK_THRESHOLD = 8


class ThreatReport:
    """扫描报告。"""
    def __init__(self, clean_content: str, findings: list[str], blocked: bool):
        self.clean_content = clean_content
        self.findings = list(findings)
        self.blocked = blocked

    def __repr__(self):
        status = "BLOCKED" if self.blocked else "CLEAN"
        return f"<ThreatReport findings={self.findings!r} blocked={self.blocked}>"

    def __str__(self):
        if not self.findings:
            return f"[✓ Safe — no threats detected]"
        lines = [f"[!] Threats found ({len(self.findings)}):"]
        for f in self.findings:
            lines.append(f"  - {f}")
        if self.blocked:
            lines.append("[!] Content BLOCKED — high-severity threats detected")
        return "\n".join(lines)


def _detect_invisible_chars(content: str) -> list[str]:
    """检测不可见 Unicode 字符。"""
    findings = []
    for char in INVISIBLE_UNICODE:
        if char in content:
            count = content.count(char)
            findings.append(f"invisible_unicode:{char!r} (x{count})")
    return findings


def _detect_patterns(content: str) -> list[str]:
    """用正则检测威胁模式。"""
    findings = []
    for pattern, label in _COMPILED_PATTERNS:
        if pattern.search(content):
            findings.append(label)
    return findings


def _clean_invisible_chars(content: str) -> str:
    """移除不可见 Unicode 字符。"""
    for char in INVISIBLE_UNICODE:
        content = content.replace(char, '')
    return content


def _block_match(match: re.Match, label: str) -> str:
    """将匹配替换为拦截标记。"""
    return f"[BLOCKED: {label}]"


def _clean_patterns(content: str) -> tuple[str, list[str]]:
    """用拦截标记替换威胁模式，返回 (cleaned, labels)。"""
    findings = []
    for pattern, label in _COMPILED_PATTERNS:
        if pattern.search(content):
            findings.append(label)
            content = pattern.sub(lambda m: _block_match(m, label), content)
    return content, findings


def scan_content(content: str, filename: str = "unknown") -> ThreatReport:
    """
    扫描内容中的 prompt injection 威胁。
    返回清洗后的内容和报告。

    Parameters
    ----------
    content : str
        要扫描的内容
    filename : str
        文件名（用于日志）

    Returns
    -------
    ThreatReport
        包含清洗后内容、威胁列表、是否被拦截
    """
    findings = []

    # Step 1: detect invisible chars
    invisible_findings = _detect_invisible_chars(content)
    findings.extend(invisible_findings)
    # Remove invisible chars from content
    clean = _clean_invisible_chars(content)

    # Step 2: detect patterns
    pattern_findings = _detect_patterns(clean)
    findings.extend(pattern_findings)

    # Step 3: replace patterns with blocked markers
    clean, _ = _clean_patterns(clean)

    # Step 4: determine if blocked
    max_severity = max((THREAT_SEVERITY.get(f, 0) for f in findings), default=0)
    blocked = max_severity >= BLOCK_THRESHOLD

    return ThreatReport(clean_content=clean, findings=findings, blocked=blocked)


def scan_file(filepath: str) -> ThreatReport:
    """
    读取文件并扫描。

    Parameters
    ----------
    filepath : str
        文件路径

    Returns
    -------
    ThreatReport
    """
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except OSError as e:
        return ThreatReport(
            clean_content="",
            findings=[f"file_read_error:{e}"],
            blocked=False,
        )
    return scan_content(content, filename=filepath)


def is_safe_to_inject(content: str) -> tuple[bool, list[str]]:
    """
    快速检查：返回 (is_safe, findings_list)。
    不执行清洗操作，速度更快。
    """
    findings = []

    # Check invisible chars
    findings.extend(_detect_invisible_chars(content))

    # Check patterns
    findings.extend(_detect_patterns(content))

    # Safe if no findings, and no high-severity threats
    safe = not findings
    return safe, findings
