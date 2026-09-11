#!/usr/bin/env python3
"""Deterministic local-only export, verification and import for AI Carry private data.

The tool deliberately prints only paths, locations, categories and counts for
secret findings. It never prints a matched value and never performs networking.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import tomllib
import unicodedata
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


TOOL_VERSION = "1.2.1"
PACKAGE_SCHEMA = 3
CURRENT_PACKAGE_TYPE = "ai-carry-private-migration"
LEGACY_PACKAGE_TYPES = frozenset({"agent-carry-private-migration"})
ACCEPTED_PACKAGE_TYPES = frozenset({CURRENT_PACKAGE_TYPE, *LEGACY_PACKAGE_TYPES})
MANIFEST_PATH = "private-package/manifest.json"
PRIVATE_ARCHIVE_ROOT = "private-package/assets"
PRIVATE_RESTORE_ROOT = ".assistant-private/assets"
DEFAULT_PATH_CONTRACT_NAME = "portable-path-contract.json"
PORTABLE_PATH_PREFIX = "ac-path:"
PORTABLE_REFERENCE_PATTERN = re.compile(r"ac-path:([a-z0-9][a-z0-9.-]{1,63})/(.+)")
MAX_INSPECTABLE_TEXT_BYTES = 16 * 1024 * 1024
ABSOLUTE_PATH_PATTERN = re.compile(
    r"^(?:[A-Za-z]:[\\/]|\\\\|/(?:Users|home|var|tmp|opt|mnt|Volumes)/)"
)

FORBIDDEN_ARCHIVE_EXTENSIONS = {
    ".7z", ".bat", ".cmd", ".com", ".dll", ".dmg", ".exe", ".hta",
    ".iso", ".jar", ".js", ".lnk", ".msi", ".ps1", ".py", ".rar",
    ".reg", ".scr", ".sh", ".tar", ".vbs", ".wsf", ".zip",
}
FORBIDDEN_PATH_PARTS = {
    ".env", "cookie", "cookies", "credential", "credentials", "id_rsa",
    "id_ed25519", "login-state", "password", "passwords", "private-key",
    "recovery-code", "recovery-codes", "secret", "secrets", "session-store",
}
TEXT_EXTENSIONS = {".json", ".md", ".srt", ".txt", ".toml", ".vtt", ".yaml", ".yml"}

ENCRYPTED_PRIVATE_KEY_MARKER = "".join(("-----BEGIN ENCRYPTED ", "PRIVATE KEY-----"))

SECRET_PATTERNS = [
    ("private-key-block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("encrypted-private-key", re.compile(re.escape(ENCRYPTED_PRIVATE_KEY_MARKER))),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{35,})\b")),
    ("openai-style-token", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("aws-secret-access-key", re.compile(r"(?i)\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*[\"']?[A-Za-z0-9+/=]{24,}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("authorization-header", re.compile(r"(?im)(?:^|[\r\n,{])\s*[\"']?(?:proxy-)?authorization[\"']?\s*[:=]\s*[\"']?bearer\s+[A-Za-z0-9._~+\/-]{12,}")),
    ("basic-authorization-header", re.compile(r"(?im)(?:^|[\r\n,{])\s*[\"']?(?:proxy-)?authorization[\"']?\s*[:=]\s*[\"']?basic\s+[A-Za-z0-9+/]{4,}={0,2}")),
    ("cookie-header", re.compile(r"(?im)(?:^|[\r\n,{])\s*[\"']?(?:cookie|set-cookie)[\"']?\s*[:=]\s*[\"']?[^\r\n\"']{8,}")),
    ("slack-token", re.compile(r"\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b")),
    ("gitlab-token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b")),
    ("huggingface-token", re.compile(r"\bhf_[A-Za-z0-9]{20,}\b")),
    ("npm-token", re.compile(r"\bnpm_[A-Za-z0-9]{20,}\b")),
    ("stripe-live-token", re.compile(r"\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b")),
    ("stripe-test-token", re.compile(r"\b(?:sk|rk)_test_[A-Za-z0-9]{16,}\b")),
    ("credential-url", re.compile(r"(?i)\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|https?)://[^\s/:@]*:[^\s/]{4,}@[A-Za-z0-9.-]+(?::\d+)?(?:[/?#\s]|$)")),
    ("client-secret", re.compile(r"(?i)\bclient[_-]?secret\b\s*[:=]\s*[\"']?[^\s\"'`;]{8,}")),
    (
        "secret-assignment",
        re.compile(
            r"(?im)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|session[_-]?(?:id|token)|secret|private[_-]?key|recovery[_-]?code)\b"
            r"\s*[:=]\s*[\"']?[A-Za-z0-9/+_.=-]{8,}"
        ),
    ),
]


class MigrationError(RuntimeError):
    def __init__(self, code: str, message: str, *, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class SourceEntry:
    entry_kind: str
    source_path: Path
    archive_path: str
    relative_path: str
    restore_path: str
    stable_ref_key: str
    stable_ref_value: str


@dataclass(frozen=True)
class PortableReference:
    source_path: str
    pointer_locator: str
    scope: str
    relative_path: str


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_file_atomic(source: Path, target: Path, *, expected_sha256: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".ac-", suffix=".tmp", dir=target.parent)
    digest = hashlib.sha256()
    try:
        with source.open("rb") as reader, os.fdopen(fd, "wb") as writer:
            for chunk in iter(lambda: reader.read(1024 * 1024), b""):
                digest.update(chunk)
                writer.write(chunk)
            writer.flush()
            os.fsync(writer.fileno())
        if digest.hexdigest() != expected_sha256:
            raise MigrationError("copy-source-changed", "复制期间源文件摘要发生变化。")
        os.replace(temp_name, target)
    finally:
        Path(temp_name).unlink(missing_ok=True)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def safe_error(error: MigrationError) -> dict[str, Any]:
    return {
        "status": "failed",
        "error": error.code,
        "message": error.message,
        "details": error.details,
        "tool_version": TOOL_VERSION,
    }


def require_root(root: Path) -> Path:
    resolved = root.resolve()
    required = [resolved / "assistant.toml", resolved / "instance" / "manifest.toml"]
    missing = [str(path.relative_to(resolved)).replace("\\", "/") for path in required if not path.is_file()]
    if missing:
        raise MigrationError("invalid-ai-carry-root", "目标不是完整的 AI Carry 实例。", details={"missing": missing})
    return resolved


def is_link_or_reparse(path: Path) -> bool:
    try:
        stat_result = path.lstat()
    except OSError:
        return False
    attributes = getattr(stat_result, "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    is_junction = getattr(path, "is_junction", lambda: False)
    return path.is_symlink() or bool(is_junction()) or bool(attributes & reparse_flag)


def ensure_no_link_components(root: Path, path: Path, *, field: str) -> None:
    root = root.resolve()
    lexical = Path(os.path.abspath(path))
    if not lexical.is_relative_to(root):
        raise MigrationError("path-outside-instance", "路径越过当前 AI Carry 实例。", details={"field": field})
    relative = lexical.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        if is_link_or_reparse(current):
            raise MigrationError("link-or-reparse-boundary", "实例内路径经过链接、目录联接或重解析点。", details={"field": field, "path": relative.as_posix()})


def read_toml(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise MigrationError("invalid-toml", "必要 TOML 文件无法解析。", details={"path": path.name, "category": type(exc).__name__}) from exc


def read_json_no_duplicates(data: bytes, *, label: str) -> dict[str, Any]:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise MigrationError("duplicate-json-key", "JSON 包含重复字段。", details={"path": label, "field": key})
            result[key] = value
        return result

    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=reject_duplicates)
    except UnicodeDecodeError as exc:
        raise MigrationError("invalid-json-encoding", "JSON 必须使用 UTF-8。", details={"path": label}) from exc
    except json.JSONDecodeError as exc:
        raise MigrationError("invalid-json", "JSON 无法解析。", details={"path": label, "line": exc.lineno}) from exc
    if not isinstance(value, dict):
        raise MigrationError("invalid-json-root", "JSON 根节点必须是对象。", details={"path": label})
    return value


def safe_locator(kind: str, value: str) -> str:
    return f"{kind}#{hashlib.sha256(value.encode('utf-8')).hexdigest()[:16]}"


def portable_json_findings(data: bytes, *, relative_path: str) -> list[dict[str, Any]]:
    if Path(relative_path).suffix.casefold() != ".json":
        return []
    value = read_json_no_duplicates(data, label=relative_path)
    findings: list[dict[str, Any]] = []

    def walk(node: Any, pointer: str = "") -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                escaped = str(key).replace("~", "~0").replace("/", "~1")
                walk(child, f"{pointer}/{escaped}")
            return
        if isinstance(node, list):
            for index, child in enumerate(node):
                walk(child, f"{pointer}/{index}")
            return
        if not isinstance(node, str):
            return
        category: str | None = None
        if ABSOLUTE_PATH_PATTERN.match(node):
            category = "absolute-path"
        elif node.startswith(PORTABLE_PATH_PREFIX):
            match = PORTABLE_REFERENCE_PATTERN.fullmatch(node)
            if not match:
                category = "invalid-portable-reference"
            else:
                relative = match.group(2)
                pure = PurePosixPath(relative)
                if relative != "." and (pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts)):
                    category = "unsafe-portable-reference"
        if category:
            findings.append({
                "path": relative_path,
                "pointer_locator": safe_locator("pointer", pointer or "/"),
                "category": category,
                "value_returned": False,
            })

    walk(value)
    return findings


def portable_json_references(data: bytes, *, relative_path: str) -> list[PortableReference]:
    if Path(relative_path).suffix.casefold() != ".json":
        return []
    value = read_json_no_duplicates(data, label=relative_path)
    references: list[PortableReference] = []

    def walk(node: Any, pointer: str = "") -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                escaped = str(key).replace("~", "~0").replace("/", "~1")
                walk(child, f"{pointer}/{escaped}")
            return
        if isinstance(node, list):
            for index, child in enumerate(node):
                walk(child, f"{pointer}/{index}")
            return
        if not isinstance(node, str):
            return
        match = PORTABLE_REFERENCE_PATTERN.fullmatch(node)
        if match:
            references.append(PortableReference(
                source_path=relative_path,
                pointer_locator=safe_locator("pointer", pointer or "/"),
                scope=match.group(1),
                relative_path=match.group(2),
            ))

    walk(value)
    return references


def portable_restore_semantics(
    payloads: Iterable[tuple[str, bytes]],
    *,
    restore_paths: set[str],
    target_root: Path | None,
    policy: dict[str, Any] | None,
    path_contract: dict[str, Any] | None,
) -> dict[str, Any]:
    counts = {
        "reference_count": 0,
        "package_or_target_resolved": 0,
        "reconstructable_missing": 0,
        "external_input_resupply": 0,
        "missing_required": 0,
    }
    findings: list[dict[str, Any]] = []
    if target_root is None or policy is None or path_contract is None:
        for restore, data in payloads:
            counts["reference_count"] += len(portable_json_references(data, relative_path=restore))
        return {"status": "syntax-only", **counts, "findings": []}

    portable_scope = str(policy["portableScope"])
    scopes = path_contract.get("scopes")
    if not isinstance(scopes, dict) or portable_scope not in scopes:
        raise MigrationError("invalid-portable-path-contract", "路径契约没有登记迁移策略使用的逻辑范围。", details={"scope": portable_scope})
    for restore, data in payloads:
        for reference in portable_json_references(data, relative_path=restore):
            counts["reference_count"] += 1
            scope_contract = scopes.get(reference.scope)
            if not isinstance(scope_contract, dict):
                counts["missing_required"] += 1
                findings.append({
                    "path": reference.source_path,
                    "pointer_locator": reference.pointer_locator,
                    "category": "unknown-portable-scope",
                    "scope": reference.scope,
                })
                continue
            scope_root = scope_contract.get("root")
            if scope_root is None:
                counts["external_input_resupply"] += 1
                continue
            if scope_root == ".":
                target = target_root if reference.relative_path == "." else target_root / PurePosixPath(reference.relative_path)
                if target.exists():
                    counts["package_or_target_resolved"] += 1
                else:
                    counts["missing_required"] += 1
                    findings.append({
                        "path": reference.source_path,
                        "pointer_locator": reference.pointer_locator,
                        "category": "missing-instance-target",
                    })
                continue

            declared_root = clean_relative(str(scope_root).replace("\\", "/"), field=f"pathContract.scopes.{reference.scope}.root")
            full_restore = declared_root if reference.relative_path == "." else f"{declared_root}/{reference.relative_path}"
            target = target_root / PurePosixPath(full_restore)
            if full_restore in restore_paths or target.exists():
                counts["package_or_target_resolved"] += 1
            elif reference.scope == portable_scope and matches_any(reference.relative_path, policy["excludePatterns"]):
                counts["reconstructable_missing"] += 1
            else:
                counts["missing_required"] += 1
                findings.append({
                    "path": reference.source_path,
                    "pointer_locator": reference.pointer_locator,
                    "category": "missing-required-business-target",
                })
    return {
        "status": "passed" if counts["missing_required"] == 0 else "blocked",
        **counts,
        "findings": findings,
    }


def load_policy(root: Path, policy_path: Path | None = None) -> tuple[Path, dict[str, Any]]:
    if policy_path is None:
        raise MigrationError(
            "migration-policy-required",
            "需要明确指定当前实例已登记的迁移策略；工具不会扫描工作区猜测策略。",
        )
    candidate = policy_path if policy_path.is_absolute() else (root / policy_path)
    ensure_no_link_components(root, candidate, field="migration-policy")
    path = candidate.resolve()
    if not path.is_file() or not path.is_relative_to(root):
        raise MigrationError("missing-migration-policy", "未找到实例登记的本地业务数据迁移策略，或策略位于实例之外。")
    policy = read_json_no_duplicates(path.read_bytes(), label=str(path.relative_to(root)).replace("\\", "/"))
    required = ["sourceRoot", "archiveRoot", "restoreRoot", "purposePrefix", "portableScope", "includePatterns", "excludePatterns", "allowedExtensions", "categories", "limits"]
    missing = [key for key in required if key not in policy]
    if missing:
        raise MigrationError("invalid-migration-policy", "本地业务数据迁移策略缺少字段。", details={"missing": missing})
    source_root = clean_relative(str(policy["sourceRoot"]).replace("\\", "/"), field="policy.sourceRoot")
    archive_root = clean_relative(str(policy["archiveRoot"]).replace("\\", "/"), field="policy.archiveRoot")
    restore_root = clean_relative(str(policy["restoreRoot"]).replace("\\", "/"), field="policy.restoreRoot")
    if not source_root.startswith(".assistant-local/") or not restore_root.startswith(".assistant-local/"):
        raise MigrationError("invalid-migration-policy-boundary", "业务资料策略只能读取和恢复到实例内已登记的 .assistant-local 范围。")
    if not archive_root.startswith("private-package/business-data/"):
        raise MigrationError("invalid-migration-policy-boundary", "业务资料包内范围必须位于 private-package/business-data/。")
    if not re.fullmatch(r"business-data:[a-z0-9][a-z0-9._-]{1,127}", str(policy["purposePrefix"])):
        raise MigrationError("invalid-migration-purpose", "业务资料策略缺少稳定、领域无关的用途前缀。")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,63}", str(policy["portableScope"])):
        raise MigrationError("invalid-portable-scope", "业务资料策略的逻辑范围 ID 无效。")
    if not all(isinstance(policy.get(key), list) for key in ("includePatterns", "excludePatterns", "allowedExtensions")):
        raise MigrationError("invalid-migration-policy", "业务资料策略的包含、排除和扩展名必须是数组。")
    if not isinstance(policy.get("categories"), dict) or not isinstance(policy.get("limits"), dict):
        raise MigrationError("invalid-migration-policy", "业务资料策略的类别或资源限制无效。")
    required_limits = {"maxFiles", "maxTotalBytes", "maxSingleFileBytes", "maxCompressionRatio"}
    if not required_limits.issubset(policy["limits"]):
        raise MigrationError("invalid-migration-policy", "业务资料策略缺少资源限制。", details={"missing": sorted(required_limits - set(policy["limits"]))})
    try:
        max_files = int(policy["limits"]["maxFiles"])
        max_total = int(policy["limits"]["maxTotalBytes"])
        max_single = int(policy["limits"]["maxSingleFileBytes"])
        max_ratio = float(policy["limits"]["maxCompressionRatio"])
    except (TypeError, ValueError) as exc:
        raise MigrationError("invalid-migration-policy", "业务资料策略的资源限制必须是数字。") from exc
    if min(max_files, max_total, max_single) <= 0 or max_ratio <= 1 or max_single > max_total:
        raise MigrationError("invalid-migration-policy", "业务资料策略的资源限制范围无效。")
    return path, policy


def load_path_contract(root: Path, policy_file: Path, policy: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    configured = str(policy.get("pathContract", DEFAULT_PATH_CONTRACT_NAME))
    candidate = Path(configured)
    unresolved = candidate if candidate.is_absolute() else (
        (root / candidate) if "/" in configured.replace("\\", "/") else (policy_file.parent / candidate)
    )
    ensure_no_link_components(root, unresolved, field="portable-path-contract")
    path = unresolved.resolve()
    if not path.is_file() or not path.is_relative_to(root):
        raise MigrationError("missing-portable-path-contract", "未找到实例登记的逻辑路径契约，或契约位于实例之外。")
    contract = read_json_no_duplicates(path.read_bytes(), label=str(path.relative_to(root)).replace("\\", "/"))
    if contract.get("referencePrefix") != PORTABLE_PATH_PREFIX or not isinstance(contract.get("scopes"), dict):
        raise MigrationError("invalid-portable-path-contract", "逻辑路径契约缺少有效前缀或范围声明。")
    if str(policy["portableScope"]) not in contract["scopes"]:
        raise MigrationError("invalid-portable-path-contract", "逻辑路径契约没有登记当前迁移范围。", details={"scope": str(policy["portableScope"])})
    scope = contract["scopes"][str(policy["portableScope"])]
    if not isinstance(scope, dict) or str(scope.get("root", "")).replace("\\", "/") != str(policy["restoreRoot"]).replace("\\", "/"):
        raise MigrationError("portable-scope-root-mismatch", "逻辑路径契约中的恢复根与迁移策略不一致。", details={"scope": str(policy["portableScope"])})
    return path, contract


def clean_relative(value: str, *, field: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise MigrationError("unsafe-relative-path", "包内路径格式不安全。", details={"field": field})
    if unicodedata.normalize("NFC", value) != value:
        raise MigrationError("unsafe-relative-path", "包内路径不是 Unicode NFC 规范形式。", details={"field": field})
    pure = PurePosixPath(value)
    if pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise MigrationError("unsafe-relative-path", "包内路径可能越界。", details={"field": field, "path": value})
    reserved = re.compile(r"(?i)^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$")
    for part in pure.parts:
        if re.search(r'[<>:"\\|?*\x00-\x1f]', part) or part.endswith((" ", ".")):
            raise MigrationError("unsafe-relative-path", "包内路径包含跨系统不安全字符。", details={"field": field})
        if reserved.fullmatch(part.split(".", 1)[0]):
            raise MigrationError("unsafe-relative-path", "包内路径包含跨系统保留名称。", details={"field": field})
    return pure.as_posix()


def portable_collision_key(value: str) -> str:
    normalized = unicodedata.normalize("NFC", value)
    return "".join(chr(ord(char) + 32) if "A" <= char <= "Z" else char for char in normalized)


def check_source_file(path: Path, *, relative_label: str, max_single: int) -> None:
    try:
        stat_result = path.lstat()
    except OSError as exc:
        raise MigrationError("source-file-unreadable", "源文件无法读取。", details={"path": relative_label, "category": type(exc).__name__}) from exc
    if is_link_or_reparse(path):
        raise MigrationError("source-link-forbidden", "迁移源中不允许链接或重解析点。", details={"path": relative_label})
    if not path.is_file():
        raise MigrationError("source-not-regular-file", "迁移源必须是普通文件。", details={"path": relative_label})
    if stat_result.st_size > max_single:
        raise MigrationError("source-file-too-large", "单个迁移文件超过限制。", details={"path": relative_label, "size": stat_result.st_size, "limit": max_single})


def path_findings(relative_path: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    pure = PurePosixPath(relative_path)
    lowered_parts = {part.casefold() for part in pure.parts}
    if lowered_parts & FORBIDDEN_PATH_PARTS:
        findings.append({"path": relative_path, "location": "path", "category": "credential-or-login-path", "count": 1})
    if pure.suffix.casefold() in {".key", ".keystore", ".pem", ".p12", ".pfx"}:
        findings.append({"path": relative_path, "location": "path", "category": "credential-file-type", "count": 1})
    if pure.suffix.casefold() in FORBIDDEN_ARCHIVE_EXTENSIONS:
        findings.append({"path": relative_path, "location": "path", "category": "executable-or-nested-package", "count": 1})
    return findings


def content_findings(data: bytes, *, relative_path: str) -> list[dict[str, Any]]:
    if Path(relative_path).suffix.casefold() not in TEXT_EXTENSIONS:
        return []
    text = data.decode("utf-8", errors="ignore")
    findings: list[dict[str, Any]] = []
    for category, pattern in SECRET_PATTERNS:
        matches = list(pattern.finditer(text))
        if not matches:
            continue
        first = matches[0]
        line = text.count("\n", 0, first.start()) + 1
        findings.append({"path": relative_path, "location": f"line:{line}", "category": category, "count": len(matches)})
    return findings


def stable_private_refs(root: Path) -> set[str]:
    refs: set[str] = set()
    expression = re.compile(r"\bprivate\.[A-Za-z0-9._-]+\b")
    instance_root = root / "instance"
    for path in sorted(instance_root.rglob("*")):
        if not path.is_file() or path.suffix.casefold() not in {".md", ".toml"}:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        refs.update(expression.findall(text))
    return refs


def matches_any(relative_path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatchcase(relative_path, pattern) for pattern in patterns)


def category_for(relative_path: str, policy: dict[str, Any]) -> str:
    first = PurePosixPath(relative_path).parts[0]
    categories = policy["categories"]
    return str(categories.get(relative_path, categories.get(first, "registered-business-data")))


def collect_entries(root: Path, policy: dict[str, Any]) -> tuple[list[SourceEntry], dict[str, int]]:
    limits = policy["limits"]
    max_single = int(limits["maxSingleFileBytes"])
    entries: list[SourceEntry] = []
    excluded = {"placeholder": 0, "policy-excluded": 0, "not-registered": 0}

    refs = stable_private_refs(root)
    private_root = root / PRIVATE_RESTORE_ROOT
    if private_root.exists():
        ensure_no_link_components(root, private_root, field="private-assets-root")
        for path in sorted(private_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(private_root).as_posix()
            if path.name == ".gitkeep":
                excluded["placeholder"] += 1
                continue
            check_source_file(path, relative_label=f"{PRIVATE_RESTORE_ROOT}/{rel}", max_single=max_single)
            if path.suffix.casefold() in FORBIDDEN_ARCHIVE_EXTENSIONS:
                raise MigrationError("unsupported-private-file-type", "隐私正文包含可执行文件或嵌套压缩包。", details={"path": f"{PRIVATE_RESTORE_ROOT}/{rel}", "extension": path.suffix.casefold()})
            asset_ref = path.name[: -len(path.suffix)] if path.suffix else path.name
            if asset_ref not in refs:
                raise MigrationError("unregistered-private-asset", "隐私正文没有稳定引用，已停止打包。", details={"path": f"{PRIVATE_RESTORE_ROOT}/{rel}", "category": "missing-stable-private-ref"})
            entries.append(SourceEntry(
                entry_kind="private-asset",
                source_path=path,
                archive_path=f"{PRIVATE_ARCHIVE_ROOT}/{rel}",
                relative_path=rel,
                restore_path=f"{PRIVATE_RESTORE_ROOT}/{rel}",
                stable_ref_key="asset_ref",
                stable_ref_value=asset_ref,
            ))

    source_root_rel = clean_relative(str(policy["sourceRoot"]).replace("\\", "/"), field="policy.sourceRoot")
    source_root = root / PurePosixPath(source_root_rel)
    archive_root = clean_relative(str(policy["archiveRoot"]).replace("\\", "/"), field="policy.archiveRoot")
    restore_root = clean_relative(str(policy["restoreRoot"]).replace("\\", "/"), field="policy.restoreRoot")
    allowed = {str(value).casefold() for value in policy["allowedExtensions"]}
    if source_root.exists():
        ensure_no_link_components(root, source_root, field="policy.sourceRoot")
        for path in sorted(source_root.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(source_root).as_posix()
            if not matches_any(rel, policy["includePatterns"]):
                excluded["not-registered"] += 1
                continue
            if matches_any(rel, policy["excludePatterns"]):
                excluded["policy-excluded"] += 1
                continue
            check_source_file(path, relative_label=f"{source_root_rel}/{rel}", max_single=max_single)
            if path.suffix.casefold() not in allowed:
                raise MigrationError("unsupported-business-file-type", "登记范围中出现未允许的数据类型。", details={"path": f"{source_root_rel}/{rel}", "extension": path.suffix.casefold()})
            category = category_for(rel, policy)
            entries.append(SourceEntry(
                entry_kind="local-business-data",
                source_path=path,
                archive_path=f"{archive_root}/{rel}",
                relative_path=rel,
                restore_path=f"{restore_root}/{rel}",
                stable_ref_key="purpose_ref",
                stable_ref_value=f"{policy['purposePrefix']}:{category}",
            ))

    if len(entries) > int(limits["maxFiles"]):
        raise MigrationError("too-many-files", "迁移文件数量超过策略限制。", details={"count": len(entries), "limit": int(limits["maxFiles"])})
    total = sum(entry.source_path.stat().st_size for entry in entries)
    if total > int(limits["maxTotalBytes"]):
        raise MigrationError("package-too-large", "迁移内容总量超过策略限制。", details={"bytes": total, "limit": int(limits["maxTotalBytes"])})
    return entries, excluded


def scan_sources(entries: Iterable[SourceEntry]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for entry in entries:
        findings.extend(path_findings(entry.restore_path))
        if entry.source_path.suffix.casefold() in TEXT_EXTENSIONS:
            if entry.source_path.stat().st_size > MAX_INSPECTABLE_TEXT_BYTES:
                raise MigrationError("text-inspection-limit", "登记的文本文件超过确定性检查上限，未创建迁移包。", details={"path": entry.restore_path, "limit": MAX_INSPECTABLE_TEXT_BYTES})
            findings.extend(content_findings(entry.source_path.read_bytes(), relative_path=entry.restore_path))
    return findings


def scan_portability(entries: Iterable[SourceEntry]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for entry in entries:
        if entry.source_path.suffix.casefold() == ".json":
            if entry.source_path.stat().st_size > MAX_INSPECTABLE_TEXT_BYTES:
                raise MigrationError("json-inspection-limit", "登记的 JSON 超过逻辑路径检查上限，未创建迁移包。", details={"path": entry.restore_path, "limit": MAX_INSPECTABLE_TEXT_BYTES})
            findings.extend(portable_json_findings(entry.source_path.read_bytes(), relative_path=entry.restore_path))
    return findings


def zip_write_bytes(archive: zipfile.ZipFile, name: str, data: bytes, *, compress: bool = True) -> None:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o100600 << 16
    info.compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    archive.writestr(info, data)


def zip_write_file(archive: zipfile.ZipFile, name: str, source: Path, *, expected_sha256: str, compress: bool = True) -> None:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o100600 << 16
    info.compress_type = zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED
    digest = hashlib.sha256()
    with source.open("rb") as reader, archive.open(info, "w", force_zip64=True) as writer:
        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
            digest.update(chunk)
            writer.write(chunk)
    if digest.hexdigest() != expected_sha256:
        raise MigrationError("source-changed-during-export", "打包期间源文件发生变化，已停止。", details={"path": name})


def export_package(root: Path, output_dir: Path, policy_path: Path | None = None) -> dict[str, Any]:
    root = require_root(root)
    output_dir = output_dir.resolve()
    if output_dir == root or output_dir.is_relative_to(root):
        raise MigrationError("output-inside-instance", "迁移包必须输出到 AI Carry 工作目录之外。", details={"path": str(output_dir)})
    output_dir.mkdir(parents=True, exist_ok=True)
    policy_file, policy = load_policy(root, policy_path)
    path_contract, contract = load_path_contract(root, policy_file, policy)
    entries, excluded = collect_entries(root, policy)
    findings = scan_sources(entries)
    if findings:
        raise MigrationError("secret-scan-blocked", "本地脱敏扫描发现疑似秘密，未创建迁移包。", details={"finding_count": sum(item["count"] for item in findings), "findings": findings})
    portability_findings = scan_portability(entries)
    if portability_findings:
        raise MigrationError(
            "nonportable-json-blocked",
            "迁移范围内的 JSON 仍包含绝对路径或无效逻辑引用，未创建迁移包。",
            details={"finding_count": len(portability_findings), "findings": portability_findings},
        )

    assistant = read_toml(root / "assistant.toml")
    instance = read_toml(root / "instance" / "manifest.toml")
    package_id = f"pvt-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
    package_name = f"ai-carry-private-{package_id}.zip"
    package_path = output_dir / package_name
    if package_path.exists():
        raise MigrationError("output-conflict", "目标迁移包已经存在。", details={"path": str(package_path)})

    manifest_entries: list[dict[str, Any]] = []
    counts = {"private_asset": 0, "local_business_data": 0}
    total_bytes = 0
    opaque_binary_count = 0
    for entry in entries:
        size = entry.source_path.stat().st_size
        item = {
            "entry_kind": entry.entry_kind,
            "archive_path": entry.archive_path,
            "relative_path": entry.relative_path,
            "restore_path": entry.restore_path,
            entry.stable_ref_key: entry.stable_ref_value,
            "size": size,
            "sha256": sha256_file(entry.source_path),
            "conflict_policy": "preview-before-overwrite",
        }
        manifest_entries.append(item)
        counts["private_asset" if entry.entry_kind == "private-asset" else "local_business_data"] += 1
        total_bytes += size
        if entry.source_path.suffix.casefold() not in TEXT_EXTENSIONS:
            opaque_binary_count += 1

    manifest = {
        "schema_version": PACKAGE_SCHEMA,
        "package_type": CURRENT_PACKAGE_TYPE,
        "package_id": package_id,
        "source_instance_id": str(instance["instance_id"]),
        "product_version": str(assistant["product_version"]),
        "asset_schema": str(instance.get("versions", {}).get("asset_schema", assistant.get("asset_schema", "unknown"))),
        "created_at": utc_now(),
        "credentials_included": False,
        "entry_counts": counts,
        "uncompressed_bytes": total_bytes,
        "content_policy": {
            "private_assets": "stable-reference-only",
            "business_data_policy": str(policy_file.relative_to(root)).replace("\\", "/"),
            "business_data_policy_sha256": sha256_file(policy_file),
            "archive_root": clean_relative(str(policy["archiveRoot"]).replace("\\", "/"), field="policy.archiveRoot"),
            "restore_root": clean_relative(str(policy["restoreRoot"]).replace("\\", "/"), field="policy.restoreRoot"),
            "purpose_prefix": str(policy["purposePrefix"]),
            "portable_scope": str(policy["portableScope"]),
            "portable_path_contract": str(path_contract.relative_to(root)).replace("\\", "/"),
            "portable_path_contract_sha256": sha256_file(path_contract),
        },
        "excluded_summary": excluded,
        "secret_scan": {"status": "passed-for-paths-and-inspectable-text", "finding_count": 0, "opaque_binary_count": opaque_binary_count, "values_returned": False},
        "portable_paths": {"status": "passed", "finding_count": 0, "raw_values_returned": False},
        "entries": manifest_entries,
    }
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")

    fd, temp_name = tempfile.mkstemp(prefix=f".{package_id}-", suffix=".tmp", dir=output_dir)
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        with zipfile.ZipFile(temp_path, "w", allowZip64=True) as archive:
            zip_write_bytes(archive, MANIFEST_PATH, manifest_bytes)
            for source, item in zip(entries, manifest_entries, strict=True):
                compress = source.source_path.suffix.casefold() not in {".mp4"}
                zip_write_file(archive, item["archive_path"], source.source_path, expected_sha256=item["sha256"], compress=compress)
        os.replace(temp_path, package_path)
    finally:
        temp_path.unlink(missing_ok=True)

    try:
        verification = verify_package(package_path, expected_root=root, policy_path=policy_file)
    except Exception:
        package_path.unlink(missing_ok=True)
        raise
    return {
        "status": "validated",
        "action": "export",
        "package_path": str(package_path),
        "package_id": package_id,
        "package_sha256": sha256_file(package_path),
        "entry_counts": counts,
        "entry_count": len(manifest_entries),
        "uncompressed_bytes": total_bytes,
        "excluded_summary": excluded,
        "secret_scan": verification["secret_scan"],
        "uploaded": False,
        "tool_version": TOOL_VERSION,
    }


def zip_member_is_link(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_IFMT(mode) == stat.S_IFLNK


def sha256_zip_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> str:
    digest = hashlib.sha256()
    with archive.open(info, "r") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_manifest_entry(item: dict[str, Any], *, schema: int, policy: dict[str, Any] | None = None) -> tuple[str, str]:
    kind = str(item.get("entry_kind", "private-asset" if schema == 1 else ""))
    relative = clean_relative(str(item.get("relative_path", "")), field="entries.relative_path")
    restore = clean_relative(str(item.get("restore_path", "")), field="entries.restore_path")
    archive_path = item.get("archive_path")
    if schema == 1:
        archive = f"{PRIVATE_ARCHIVE_ROOT}/{relative}"
    else:
        archive = clean_relative(str(archive_path or ""), field="entries.archive_path")
    if kind == "private-asset":
        if not archive.startswith(f"{PRIVATE_ARCHIVE_ROOT}/") or not restore.startswith(f"{PRIVATE_RESTORE_ROOT}/"):
            raise MigrationError("private-entry-boundary", "隐私正文条目越过允许边界。", details={"path": archive})
        if not item.get("asset_ref"):
            raise MigrationError("missing-asset-ref", "隐私正文条目缺少稳定引用。", details={"path": archive})
    elif kind == "local-business-data" and schema >= 2:
        if not archive.startswith("private-package/business-data/"):
            raise MigrationError("business-entry-boundary", "业务数据条目越过包内允许边界。", details={"path": archive})
        if not restore.startswith(".assistant-local/"):
            raise MigrationError("business-restore-boundary", "业务数据条目越过恢复边界。", details={"path": restore})
        if not str(item.get("purpose_ref", "")).startswith("business-data:"):
            raise MigrationError("missing-purpose-ref", "业务数据条目缺少登记用途。", details={"path": archive})
        if policy is not None:
            archive_root = clean_relative(str(policy["archiveRoot"]).replace("\\", "/"), field="policy.archiveRoot")
            restore_root = clean_relative(str(policy["restoreRoot"]).replace("\\", "/"), field="policy.restoreRoot")
            purpose_prefix = str(policy["purposePrefix"])
            if not archive.startswith(f"{archive_root}/"):
                raise MigrationError("business-entry-policy-boundary", "业务数据条目不属于当前策略的包内范围。", details={"path": archive})
            if not restore.startswith(f"{restore_root}/"):
                raise MigrationError("business-restore-policy-boundary", "业务数据条目不属于当前策略的恢复范围。", details={"path": restore})
            if not str(item.get("purpose_ref", "")).startswith(f"{purpose_prefix}:"):
                raise MigrationError("business-purpose-policy-boundary", "业务数据条目的用途不属于当前策略。", details={"path": archive})
    else:
        raise MigrationError("unknown-entry-kind", "迁移包包含未知条目类型。", details={"kind": kind, "path": archive})
    if item.get("conflict_policy") != "preview-before-overwrite":
        raise MigrationError("unsafe-conflict-policy", "迁移条目没有使用覆盖前预览策略。", details={"path": archive})
    if not isinstance(item.get("size"), int) or int(item["size"]) < 0:
        raise MigrationError("invalid-entry-size", "迁移条目大小无效。", details={"path": archive})
    if not re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256", ""))):
        raise MigrationError("invalid-entry-sha256", "迁移条目摘要无效。", details={"path": archive})
    return archive, restore


def verify_package(package_path: Path, *, expected_root: Path | None = None, policy_path: Path | None = None) -> dict[str, Any]:
    package_path = package_path.resolve()
    if not package_path.is_file():
        raise MigrationError("package-not-found", "未找到本地隐私迁移包。", details={"path": str(package_path)})
    if package_path.suffix.casefold() != ".zip":
        raise MigrationError("package-type-invalid", "本地隐私迁移包必须是 ZIP。", details={"path": package_path.name})

    policy: dict[str, Any] | None = None
    policy_file: Path | None = None
    path_contract_file: Path | None = None
    path_contract: dict[str, Any] | None = None
    if expected_root is not None:
        expected_root = require_root(expected_root)
        if policy_path is not None:
            policy_file, policy = load_policy(expected_root, policy_path)
            path_contract_file, path_contract = load_path_contract(expected_root, policy_file, policy)
    limits = (policy or {}).get("limits", {"maxFiles": 10000, "maxTotalBytes": 2147483648, "maxSingleFileBytes": 1073741824, "maxCompressionRatio": 1000})
    with zipfile.ZipFile(package_path, "r") as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            raise MigrationError("duplicate-archive-path", "迁移包包含重复路径。")
        collision_keys = [portable_collision_key(name) for name in names]
        if len(collision_keys) != len(set(collision_keys)):
            raise MigrationError("portable-path-collision", "迁移包包含跨系统会互相覆盖的路径。")
        if MANIFEST_PATH not in names:
            raise MigrationError("missing-package-manifest", "迁移包缺少内部清单。")
        if len(infos) > int(limits["maxFiles"]) + 1:
            raise MigrationError("too-many-archive-entries", "迁移包条目数量超过限制。", details={"count": len(infos)})
        expanded = 0
        for info in infos:
            clean_relative(info.filename, field="zip.entry")
            if info.flag_bits & 0x1:
                raise MigrationError("encrypted-entry", "迁移包不能包含加密条目。", details={"path": info.filename})
            if info.is_dir() or zip_member_is_link(info):
                raise MigrationError("non-regular-archive-entry", "迁移包只能包含普通文件。", details={"path": info.filename})
            if info.file_size > int(limits["maxSingleFileBytes"]):
                raise MigrationError("archive-entry-too-large", "迁移包单个条目超过限制。", details={"path": info.filename, "size": info.file_size})
            if info.compress_size == 0 and info.file_size > 0:
                raise MigrationError("abnormal-compression", "迁移包压缩比例异常。", details={"path": info.filename})
            if info.compress_size and info.file_size / info.compress_size > float(limits["maxCompressionRatio"]):
                raise MigrationError("abnormal-compression", "迁移包压缩比例超过限制。", details={"path": info.filename})
            expanded += info.file_size
        if expanded > int(limits["maxTotalBytes"]) + 10 * 1024 * 1024:
            raise MigrationError("archive-too-large", "迁移包展开总量超过限制。", details={"bytes": expanded})

        manifest = read_json_no_duplicates(archive.read(MANIFEST_PATH), label=MANIFEST_PATH)
        schema = int(manifest.get("schema_version", 0))
        if schema not in {1, 2, 3}:
            raise MigrationError("unsupported-package-schema", "不支持该隐私包版本。", details={"schema_version": schema})
        if manifest.get("package_type") not in ACCEPTED_PACKAGE_TYPES or manifest.get("credentials_included") is not False:
            raise MigrationError("invalid-package-identity", "隐私包身份或凭据声明无效。")
        entries = manifest.get("entries")
        if not isinstance(entries, list):
            raise MigrationError("invalid-package-entries", "隐私包条目清单无效。")

        expected_names = {MANIFEST_PATH}
        secret_findings: list[dict[str, Any]] = []
        portability_findings: list[dict[str, Any]] = []
        portable_payloads: list[tuple[str, bytes]] = []
        total = 0
        kind_counts = {"private_asset": 0, "local_business_data": 0}
        opaque_binary_count = 0
        restore_paths: set[str] = set()
        restore_collision_keys: set[str] = set()
        for item in entries:
            if not isinstance(item, dict):
                raise MigrationError("invalid-package-entry", "隐私包条目必须是对象。")
            archive_name, restore = validate_manifest_entry(item, schema=schema, policy=policy)
            if archive_name in expected_names or restore in restore_paths:
                raise MigrationError("duplicate-manifest-path", "内部清单包含重复条目。", details={"path": archive_name})
            restore_collision = portable_collision_key(restore)
            if restore_collision in restore_collision_keys:
                raise MigrationError("portable-restore-collision", "内部清单包含跨系统会互相覆盖的恢复路径。", details={"path": restore})
            expected_names.add(archive_name)
            restore_paths.add(restore)
            restore_collision_keys.add(restore_collision)
            if archive_name not in names:
                raise MigrationError("manifest-file-missing", "内部清单登记的文件不存在。", details={"path": archive_name})
            info = archive.getinfo(archive_name)
            if info.file_size != int(item["size"]):
                raise MigrationError("entry-size-mismatch", "迁移条目大小不一致。", details={"path": archive_name, "expected": int(item["size"]), "actual": info.file_size})
            actual_sha = sha256_zip_member(archive, info)
            if actual_sha != item["sha256"]:
                raise MigrationError("entry-sha256-mismatch", "迁移条目摘要不一致。", details={"path": archive_name})
            secret_findings.extend(path_findings(restore))
            suffix = Path(restore).suffix.casefold()
            data: bytes | None = None
            if suffix in TEXT_EXTENSIONS:
                if info.file_size > MAX_INSPECTABLE_TEXT_BYTES:
                    raise MigrationError("text-inspection-limit", "迁移包中的文本文件超过确定性检查上限。", details={"path": restore, "limit": MAX_INSPECTABLE_TEXT_BYTES})
                data = archive.read(archive_name)
                secret_findings.extend(content_findings(data, relative_path=restore))
            if schema >= 3 and suffix == ".json":
                if data is None:
                    data = archive.read(archive_name)
                portability_findings.extend(portable_json_findings(data, relative_path=restore))
                portable_payloads.append((restore, data))
            if suffix not in TEXT_EXTENSIONS:
                opaque_binary_count += 1
            total += info.file_size
            if str(item.get("entry_kind", "private-asset")) == "private-asset":
                kind_counts["private_asset"] += 1
            else:
                kind_counts["local_business_data"] += 1

        actual_names = set(names)
        if actual_names != expected_names:
            extra = sorted(actual_names - expected_names)
            missing = sorted(expected_names - actual_names)
            raise MigrationError("archive-manifest-set-mismatch", "迁移包实际文件与内部清单不一致。", details={"extra": extra, "missing": missing})
        if secret_findings:
            raise MigrationError("secret-scan-blocked", "迁移包复扫发现疑似秘密。", details={"finding_count": sum(item["count"] for item in secret_findings), "findings": secret_findings})
        if portability_findings:
            raise MigrationError(
                "nonportable-json-blocked",
                "迁移包复扫发现绝对路径或无效逻辑引用。",
                details={"finding_count": len(portability_findings), "findings": portability_findings},
            )
        if expected_root is not None and kind_counts["local_business_data"] and policy is None:
            raise MigrationError("migration-policy-required", "目标验证包含业务资料，必须明确指定当前实例登记的迁移策略。")
        portable_semantics = portable_restore_semantics(
            portable_payloads,
            restore_paths=restore_paths,
            target_root=expected_root,
            policy=policy,
            path_contract=path_contract,
        ) if schema >= 3 else {
            "status": "legacy-unverified",
            "reference_count": 0,
            "package_or_target_resolved": 0,
            "reconstructable_missing": 0,
            "external_input_resupply": 0,
            "missing_required": 0,
            "findings": [],
        }
        if portable_semantics["missing_required"]:
            raise MigrationError(
                "portable-reference-target-missing",
                "迁移包中的逻辑引用在目标实例上缺少必需对象。",
                details={
                    "finding_count": portable_semantics["missing_required"],
                    "findings": portable_semantics["findings"],
                },
            )

        if expected_root is not None:
            instance = read_toml(expected_root / "instance" / "manifest.toml")
            if manifest.get("source_instance_id") != instance.get("instance_id"):
                raise MigrationError("source-instance-mismatch", "迁移包实例 ID 与当前实例不一致。", details={"expected": instance.get("instance_id"), "actual": manifest.get("source_instance_id")})
            if schema >= 2 and policy is not None:
                if policy_file is None:
                    raise MigrationError("migration-policy-required", "目标验证缺少明确迁移策略。")
                expected_policy_sha = sha256_file(policy_file)
                actual_policy_sha = manifest.get("content_policy", {}).get("business_data_policy_sha256")
                if actual_policy_sha != expected_policy_sha:
                    raise MigrationError("business-policy-mismatch", "业务数据迁移策略与当前实例不一致。", details={"path": str(policy_file.relative_to(expected_root)).replace("\\", "/")})
            if schema >= 3 and kind_counts["local_business_data"]:
                if path_contract_file is None:
                    raise MigrationError("missing-portable-path-contract", "目标实例缺少明确的逻辑路径契约。")
                expected_contract_sha = sha256_file(path_contract_file)
                actual_contract_sha = manifest.get("content_policy", {}).get("portable_path_contract_sha256")
                if actual_contract_sha != expected_contract_sha:
                    raise MigrationError("portable-path-contract-mismatch", "迁移包路径契约与当前实例不一致。", details={"path": str(path_contract_file.relative_to(expected_root)).replace("\\", "/")})

    return {
        "status": "validated",
        "action": "verify",
        "package_path": str(package_path),
        "package_id": manifest.get("package_id"),
        "schema_version": schema,
        "entry_count": len(entries),
        "entry_counts": kind_counts,
        "uncompressed_bytes": total,
        "package_sha256": sha256_file(package_path),
        "secret_scan": {"status": "passed-for-paths-and-inspectable-text", "finding_count": 0, "opaque_binary_count": opaque_binary_count, "values_returned": False},
        "portable_paths": {
            "status": portable_semantics["status"],
            "finding_count": 0,
            "raw_values_returned": False,
            "reference_count": portable_semantics["reference_count"],
            "package_or_target_resolved": portable_semantics["package_or_target_resolved"],
            "reconstructable_missing": portable_semantics["reconstructable_missing"],
            "external_input_resupply": portable_semantics["external_input_resupply"],
            "missing_required": portable_semantics["missing_required"],
        },
        "tool_version": TOOL_VERSION,
    }


def package_manifest(package_path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(package_path, "r") as archive:
        return read_json_no_duplicates(archive.read(MANIFEST_PATH), label=MANIFEST_PATH)


def ensure_target_identity(target_root: Path, manifest: dict[str, Any]) -> Path:
    target_root = require_root(target_root)
    target_instance = read_toml(target_root / "instance" / "manifest.toml")
    if target_instance.get("instance_id") != manifest.get("source_instance_id"):
        raise MigrationError("target-instance-mismatch", "目标实例与迁移包不匹配。", details={"expected": manifest.get("source_instance_id"), "actual": target_instance.get("instance_id")})
    return target_root


def destination_path(target_root: Path, restore_path: str) -> Path:
    clean = clean_relative(restore_path, field="entries.restore_path")
    target_root = target_root.resolve()
    target = Path(os.path.abspath(target_root / PurePosixPath(clean)))
    if not target.is_relative_to(target_root):
        raise MigrationError("restore-path-escape", "恢复路径越过目标实例。", details={"path": restore_path})
    ensure_no_link_components(target_root, target, field="entries.restore_path")
    return target


def atomic_write_bytes(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    # Keep the temporary basename short so a valid deep Windows target does not
    # fail only because the transaction suffix pushed it over the path limit.
    fd, temp_name = tempfile.mkstemp(prefix=".ac-", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, target)
    finally:
        Path(temp_name).unlink(missing_ok=True)


def import_transaction_root(target_root: Path) -> Path:
    root = target_root / ".assistant-local" / "migration-transactions"
    ensure_no_link_components(target_root, root, field="migration-transaction-root")
    return root


def finish_import_transaction(transaction_dir: Path, cleanup_warnings: list[str]) -> None:
    # Mark a verified commit before best-effort deletion. Even partial cleanup
    # must never be interpreted on the next run as an interrupted data write.
    completed = transaction_dir.with_name("completed-" + transaction_dir.name)
    try:
        transaction_dir.rename(completed)
    except OSError:
        cleanup_warnings.append(transaction_dir.name)
        return  # The intact journal can still verify all installed bytes.
    try:
        shutil.rmtree(completed)
    except OSError:
        cleanup_warnings.append(completed.name)


def recover_import_transaction(transaction_dir: Path, target_root: Path, cleanup_warnings: list[str] | None = None) -> str:
    manifest_path = transaction_dir / "transaction.json"
    if not manifest_path.is_file():
        raise MigrationError("import-journal-missing", "迁移写入事务缺少恢复清单；已保留现场。")
    manifest = read_json_no_duplicates(manifest_path.read_bytes(), label="migration-transaction")
    if manifest.get("schema_version") != 1 or not isinstance(manifest.get("entries"), list):
        raise MigrationError("import-journal-invalid", "迁移写入事务恢复清单无效；已保留现场。")

    entries: list[tuple[dict[str, Any], Path, Path]] = []
    for item in manifest["entries"]:
        if not isinstance(item, dict):
            raise MigrationError("import-journal-invalid", "迁移写入事务条目无效；已保留现场。")
        target = destination_path(target_root, str(item.get("restore_path", "")))
        backup = transaction_dir / "backups" / str(item.get("backup_name", ""))
        entries.append((item, target, backup))

    all_installed = all(
        target.is_file() and sha256_file(target) == str(item.get("after_sha256", ""))
        for item, target, _ in entries
    )
    if all_installed:
        finish_import_transaction(transaction_dir, cleanup_warnings if cleanup_warnings is not None else [])
        return "completed"

    for item, target, backup in entries:
        existed = item.get("existed") is True
        before_sha = str(item.get("before_sha256") or "")
        after_sha = str(item.get("after_sha256") or "")
        if existed:
            if not backup.is_file() or sha256_file(backup) != before_sha:
                raise MigrationError("import-backup-invalid", "迁移写入事务备份缺失或摘要不一致；已保留现场。")
            copy_file_atomic(backup, target, expected_sha256=before_sha)
            if sha256_file(target) != before_sha:
                raise MigrationError("import-rollback-verification-failed", "迁移写入回滚后摘要不一致；已保留现场。")
        elif target.exists():
            if not target.is_file() or sha256_file(target) != after_sha:
                raise MigrationError("import-concurrent-target-change", "迁移写入恢复时发现目标被其他操作改变；已保留现场。")
            target.unlink()
    shutil.rmtree(transaction_dir)
    return "rolled-back"


def recover_import_transactions(target_root: Path, cleanup_warnings: list[str] | None = None) -> int:
    root = import_transaction_root(target_root)
    if not root.exists():
        return 0
    recovered = 0
    warnings = cleanup_warnings if cleanup_warnings is not None else []
    for transaction in sorted(root.iterdir()):
        ensure_no_link_components(target_root, transaction, field="migration-transaction")
        if not transaction.is_dir():
            raise MigrationError("import-transaction-root-invalid", "迁移事务目录包含非目录对象；已保留现场。")
        if re.fullmatch(r"completed-import-[0-9a-f]{32}", transaction.name):
            # No recovery reads/writes to user data after a verified commit.
            try:
                shutil.rmtree(transaction)
            except OSError:
                warnings.append(transaction.name)
            continue
        if not re.fullmatch(r"import-[0-9a-f]{32}", transaction.name):
            raise MigrationError("import-transaction-name-invalid", "迁移事务目录包含未知对象；已保留现场。")
        recover_import_transaction(transaction, target_root, warnings)
        recovered += 1
    return recovered


def preview_import(package_path: Path, target_root: Path, *, policy_path: Path | None = None) -> dict[str, Any]:
    target_root = require_root(target_root)
    verification = verify_package(package_path, expected_root=target_root, policy_path=policy_path)
    manifest = package_manifest(package_path)
    target_root = ensure_target_identity(target_root, manifest)
    groups: dict[str, list[str]] = {"new": [], "same": [], "conflict": []}
    for item in manifest["entries"]:
        restore = str(item["restore_path"])
        target = destination_path(target_root, restore)
        if not target.exists():
            groups["new"].append(restore)
        elif target.is_file() and sha256_file(target) == item["sha256"]:
            groups["same"].append(restore)
        else:
            groups["conflict"].append(restore)
    return {
        "status": "preview-ready",
        "action": "preview-import",
        "package_path": str(package_path.resolve()),
        "package_id": manifest["package_id"],
        "target_root": str(target_root),
        "counts": {key: len(value) for key, value in groups.items()},
        "paths": groups,
        "verification": {
            "status": verification["status"],
            "secret_scan": verification["secret_scan"],
            "portable_paths": verification["portable_paths"],
        },
        "tool_version": TOOL_VERSION,
    }


def import_package(package_path: Path, target_root: Path, *, policy_path: Path | None = None, overwrite_conflicts: bool = False, confirmed_package_id: str | None = None) -> dict[str, Any]:
    target_root = require_root(target_root)
    cleanup_warnings: list[str] = []
    recovered_transactions = recover_import_transactions(target_root, cleanup_warnings)
    preview = preview_import(package_path, target_root, policy_path=policy_path)
    manifest = package_manifest(package_path)
    if preview["counts"]["conflict"] and not overwrite_conflicts:
        raise MigrationError("conflicts-require-confirmation", "存在冲突，尚未写入任何文件。", details={"package_id": manifest["package_id"], "conflict_count": preview["counts"]["conflict"], "paths": preview["paths"]["conflict"]})
    if overwrite_conflicts and confirmed_package_id != manifest["package_id"]:
        raise MigrationError("overwrite-confirmation-missing", "覆盖冲突需要明确确认当前包 ID。", details={"package_id": manifest["package_id"]})

    target_root = target_root.resolve()
    backup_path: Path | None = None
    conflicts = set(preview["paths"]["conflict"])
    if conflicts:
        backup_dir = target_root / ".assistant-local" / "migration-backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / f"private-import-backup-{manifest['package_id']}.zip"
        if backup_path.exists():
            raise MigrationError("backup-conflict", "冲突备份文件已经存在，未覆盖目标。", details={"path": str(backup_path)})
        with zipfile.ZipFile(backup_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as backup:
            for restore in sorted(conflicts):
                target = destination_path(target_root, restore)
                if target.is_file():
                    backup.write(target, f"backup/{restore}")

    skipped_same = len(preview["paths"]["same"])
    planned: list[dict[str, Any]] = []
    for index, item in enumerate(manifest["entries"]):
        restore = str(item["restore_path"])
        target = destination_path(target_root, restore)
        if restore in preview["paths"]["same"]:
            continue
        existed = target.is_file()
        stem = hashlib.sha256(restore.encode("utf-8")).hexdigest()[:20]
        planned.append({
            "index": index,
            "restore_path": restore,
            "archive_path": item.get("archive_path") or f"{PRIVATE_ARCHIVE_ROOT}/{item['relative_path']}",
            "target": target,
            "existed": existed,
            "before_sha256": sha256_file(target) if existed else None,
            "after_sha256": item["sha256"],
            "backup_name": f"{index:04d}-{stem}.bak",
            "staged_name": f"{index:04d}-{stem}.next",
        })

    if planned:
        transaction_dir = import_transaction_root(target_root) / f"import-{uuid.uuid4().hex}"
        backup_dir = transaction_dir / "backups"
        staged_dir = transaction_dir / "staged"
        backup_dir.mkdir(parents=True)
        staged_dir.mkdir(parents=True)
        try:
            with zipfile.ZipFile(package_path, "r") as archive:
                for plan in planned:
                    staged = staged_dir / plan["staged_name"]
                    digest = hashlib.sha256()
                    with archive.open(plan["archive_path"], "r") as reader, staged.open("wb") as writer:
                        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
                            digest.update(chunk)
                            writer.write(chunk)
                        writer.flush()
                        os.fsync(writer.fileno())
                    if digest.hexdigest() != plan["after_sha256"]:
                        raise MigrationError("entry-changed-before-write", "写入前摘要复核失败。", details={"path": plan["restore_path"]})
                    if plan["existed"]:
                        copy_file_atomic(plan["target"], backup_dir / plan["backup_name"], expected_sha256=plan["before_sha256"])
            transaction_manifest = {
                "schema_version": 1,
                "package_id": manifest["package_id"],
                "entries": [
                    {
                        "restore_path": plan["restore_path"],
                        "existed": plan["existed"],
                        "before_sha256": plan["before_sha256"],
                        "after_sha256": plan["after_sha256"],
                        "backup_name": plan["backup_name"],
                        "staged_name": plan["staged_name"],
                    }
                    for plan in planned
                ],
            }
            atomic_write_bytes(
                transaction_dir / "transaction.json",
                (json.dumps(transaction_manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
            )
        except Exception:
            shutil.rmtree(transaction_dir)
            raise

        installed = 0
        try:
            for plan in planned:
                staged = staged_dir / plan["staged_name"]
                if sha256_file(staged) != plan["after_sha256"]:
                    raise MigrationError("staged-entry-changed", "迁移暂存条目摘要发生变化。", details={"path": plan["restore_path"]})
                copy_file_atomic(staged, plan["target"], expected_sha256=plan["after_sha256"])
                installed += 1
                if os.environ.get("AI_CARRY_TEST_IMPORT_FAIL_AFTER") == str(installed):
                    raise RuntimeError("synthetic import interruption")
            for plan in planned:
                if not plan["target"].is_file() or sha256_file(plan["target"]) != plan["after_sha256"]:
                    raise MigrationError("post-import-verification-failed", "迁移写入后摘要复核失败。", details={"path": plan["restore_path"]})
        except Exception as exc:
            try:
                recover_import_transaction(transaction_dir, target_root)
            except MigrationError:
                raise
            raise MigrationError(
                "import-transaction-rolled-back",
                "迁移写入中断，已恢复写入前数据。",
                details={"category": type(exc).__name__, "installed_before_failure": installed},
            ) from exc
        finish_import_transaction(transaction_dir, cleanup_warnings)

    written = len(planned)

    post_mismatch: list[str] = []
    for item in manifest["entries"]:
        target = destination_path(target_root, str(item["restore_path"]))
        if not target.is_file() or sha256_file(target) != item["sha256"]:
            post_mismatch.append(str(item["restore_path"]))
    if post_mismatch:
        raise MigrationError("post-import-verification-failed", "导入后摘要复核失败。", details={"paths": post_mismatch})
    post_verification = verify_package(package_path, expected_root=target_root, policy_path=policy_path)

    return {
        "status": "validated",
        "action": "import",
        "package_id": manifest["package_id"],
        "target_root": str(target_root),
        "written": written,
        "same_skipped": skipped_same,
        "conflicts_overwritten": len(conflicts),
        "backup_path": str(backup_path) if backup_path else None,
        "post_import_mismatches": 0,
        "secret_credentials_restored": False,
        "portable_paths": post_verification["portable_paths"],
        "recovered_incomplete_transactions": recovered_transactions,
        "transaction_artifacts_remaining": len(cleanup_warnings),
        "cleanup_warnings": cleanup_warnings,
        "user_summary": "资料已恢复并回读通过；临时清理未完成，已恢复资料可正常使用，不需要重复导入。" if cleanup_warnings else "资料已恢复并回读通过。",
        "tool_version": TOOL_VERSION,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AI Carry 本地隐私与业务数据迁移工具")
    subparsers = parser.add_subparsers(dest="command", required=True)

    export = subparsers.add_parser("export", help="在本地导出迁移包")
    export.add_argument("--root", type=Path, required=True)
    export.add_argument("--output-dir", type=Path, required=True)
    export.add_argument("--policy", type=Path)

    verify = subparsers.add_parser("verify", help="校验迁移包")
    verify.add_argument("--package", type=Path, required=True)
    verify.add_argument("--root", type=Path)
    verify.add_argument("--policy", type=Path)

    preview = subparsers.add_parser("preview-import", help="预览导入，不写文件")
    preview.add_argument("--package", type=Path, required=True)
    preview.add_argument("--target-root", type=Path, required=True)
    preview.add_argument("--policy", type=Path)

    restore = subparsers.add_parser("import", help="导入非冲突内容；冲突默认停止")
    restore.add_argument("--package", type=Path, required=True)
    restore.add_argument("--target-root", type=Path, required=True)
    restore.add_argument("--policy", type=Path)
    restore.add_argument("--overwrite-conflicts", action="store_true")
    restore.add_argument("--confirmed-package-id")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parse_args(argv or sys.argv[1:])
    try:
        if args.command == "export":
            result = export_package(args.root, args.output_dir, args.policy)
        elif args.command == "verify":
            result = verify_package(args.package, expected_root=args.root, policy_path=args.policy)
        elif args.command == "preview-import":
            result = preview_import(args.package, args.target_root, policy_path=args.policy)
        else:
            result = import_package(
                args.package,
                args.target_root,
                policy_path=args.policy,
                overwrite_conflicts=args.overwrite_conflicts,
                confirmed_package_id=args.confirmed_package_id,
            )
        emit(result)
        return 0
    except MigrationError as exc:
        emit(safe_error(exc))
        return 2
    except (OSError, zipfile.BadZipFile) as exc:
        emit({
            "status": "failed",
            "error": "local-io-or-archive-error",
            "message": "本地文件或压缩包处理失败。",
            "details": {"category": type(exc).__name__},
            "tool_version": TOOL_VERSION,
        })
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
