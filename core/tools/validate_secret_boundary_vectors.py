#!/usr/bin/env python3
"""Verify private migration scanning against the shared synthetic vector set."""

from __future__ import annotations

import json
from pathlib import Path

from private_data_migration import SECRET_PATTERNS, content_findings


ROOT = Path(__file__).resolve().parents[2]
VECTORS = json.loads((ROOT / "core/schemas/secret-boundary-test-vectors.json").read_text(encoding="utf-8"))


def main() -> int:
    patterns = dict(SECRET_PATTERNS)
    for vector in VECTORS["blocked"]:
        value = "".join(vector["parts"])
        category = vector["category"]
        if vector.get("decoded_json") is True:
            findings = content_findings(value.encode("utf-8"), relative_path="fixture.json")
            if not any(item["category"] == category and item["location"] == "decoded-json" for item in findings):
                raise RuntimeError(f"private migration scanner missed decoded JSON category: {category}")
        elif category not in patterns or not patterns[category].search(value):
            raise RuntimeError(f"private migration scanner missed shared category: {category}")
    for value in VECTORS["allowed"]:
        matches = [category for category, pattern in SECRET_PATTERNS if pattern.search(value)]
        if matches:
            raise RuntimeError(f"private migration scanner false positive {matches}: {value}")
    print(f"Private migration secret boundary passed {len(VECTORS['blocked'])} blocked and {len(VECTORS['allowed'])} allowed shared vectors.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
