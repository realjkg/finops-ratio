#!/usr/bin/env python3
"""Ratio telemetry mapping discovery kit (Python 3.9+, standard library only).

Status: synthetic-validated, runtime validation pending.

What it checks, on synthetic fixtures only (no provider calls, no credentials):

  * Gateway request logs (LiteLLM-style) -> ai-usage-event/1 records. Usage events are
    accounting-relevant operational records, not billed financial records.
  * Rate-card valuations -> ai-financial-record/1 (kind estimated_invocation), linked by id.
  * FOCUS-aligned billing rows -> ai-financial-record/1 (kinds billed and effective).
  * GPU capacity -> allocation/1, using allocated capacity x duration (not utilization),
    with exclusive, MIG and time-sliced claims and an over-claim guard.
  * Aggregate reconciliation by provider account, provider, model, SKU, token category,
    currency and day. Differences stay visible; their cause is never inferred.
  * Draft sidecars for items outside v1: the source (gateway) estimate, correlation
    metadata, reconciliation links, allocation chaining and agent-run estimates.

Every scenario has an exact expected outcome (expected-results.json). A run fails when
the outcome differs, including when an unexpected warning appears.

Usage:
  python3 -I ratio_telemetry_check.py self-test
  python3 -I ratio_telemetry_check.py run --workdir ./run [--scenario bypass]
  python3 -I ratio_telemetry_check.py golden --out ./expected
  python3 -I ratio_telemetry_check.py scenarios

Field names for LiteLLM spend logs, dcgm-exporter and kubelet pod-resources, OTel GenAI
attributes and FOCUS columns follow public documentation and are marked VERIFY; confirm
them against the versions you deploy. All prices and amounts are synthetic, not sourced.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import hmac
import io
import json
import os
import random
import re
import shutil
import sys
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, getcontext
from fractions import Fraction
from math import floor
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

getcontext().prec = 60

KIT_VERSION = "0.2.0"
KIT_STATUS = "synthetic-validated, runtime validation pending"
HERE = Path(__file__).resolve().parent
TIE_BREAK = "largest remainder; ties broken by target key in ascending code-point order"
MIN_PRECISION = Decimal("0.000001")
RECON_TOLERANCE = Fraction(1, 100)        # 1 % of billed quantity
DRIFT_TOLERANCE = Fraction(2, 100)        # 2 % between source estimate and valuation
SAMPLE_INTERVAL_S = 15
FIXTURE_DAY = datetime(2026, 11, 4, tzinfo=timezone.utc)
CANARY = "RATIO-CANARY-1b7e"
CANARY_EMAIL = "canary.person@example.test"
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")

MSG_BILLED_EXCEEDS = ("Gateway coverage discrepancy: billed usage exceeds observed gateway usage. "
                      "Cause not yet established.")
MSG_OBSERVED_EXCEEDS = "Observed gateway usage exceeds billed usage. Cause not yet established."
MSG_OBSERVED_UNBILLED = "Observed gateway usage has no matching billed aggregate. Cause not yet established."
CANDIDATE_EXPLANATIONS = [
    "ingestion delay or dropped events", "different account, model or period scope",
    "alias or token-accounting mismatch", "retries or late corrections",
    "missing instrumentation", "calls outside the gateway",
]


class MappingError(Exception):
    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code


# ---------------------------------------------------------------------------
# Numbers: precise source parsing, canonical contract strings
# ---------------------------------------------------------------------------
SOURCE_DECIMAL = re.compile(r"^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$")
CANONICAL_DECIMAL = re.compile(r"^-?(0|[1-9]\d{0,39})(\.\d{1,40})?$")


def _reject_constant(name: str) -> Any:
    raise MappingError("SOURCE_NUMBER_NONFINITE", f"JSON constant {name} refused")


def load_json_precise(text: str) -> Any:
    """Parse JSON keeping every number exact: JSON numbers become Decimal, never binary floats."""
    return json.loads(text, parse_float=Decimal, parse_constant=_reject_constant)


def source_decimal(value: Any, what: str) -> Tuple[Decimal, str]:
    """Adapter boundary: accept exact JSON numbers and decimal strings; refuse lossy floats."""
    if isinstance(value, bool):
        raise MappingError("SOURCE_NUMBER_INVALID", f"{what}: boolean is not a number")
    if isinstance(value, float):
        raise MappingError("SOURCE_NUMBER_LOSSY", f"{what}: binary float {value!r}; parse the source with load_json_precise")
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise MappingError("SOURCE_NUMBER_NONFINITE", f"{what}: {value}")
        return value, "json-number"
    if isinstance(value, int):
        return Decimal(value), "json-number"
    if isinstance(value, str) and SOURCE_DECIMAL.match(value.strip()):
        return Decimal(value.strip()), "decimal-string"
    raise MappingError("SOURCE_NUMBER_INVALID", f"{what}: not a decimal: {value!r}")


def source_count(value: Any, what: str) -> Optional[int]:
    if value is None:
        return None
    d, _ = source_decimal(value, what)
    if d != d.to_integral_value() or d < 0:
        raise MappingError("SOURCE_COUNT_INVALID", f"{what}: {value!r} is not a non-negative whole number")
    return int(d)


def canonical(d: Decimal) -> str:
    if d == 0:
        return "0"
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".") if "." in s else s
    if not CANONICAL_DECIMAL.match(s):
        raise MappingError("CANONICAL_DECIMAL_RANGE", f"{d} exceeds canonical decimal bounds")
    return s


def contract_decimal(s: Any, what: str) -> Decimal:
    """Normalized-contract boundary: only canonical decimal strings are accepted."""
    if not isinstance(s, str) or not CANONICAL_DECIMAL.match(s):
        raise MappingError("CONTRACT_DECIMAL_INVALID", f"{what}: {s!r} is not a canonical decimal string")
    return Decimal(s)


def precision_for(amounts: List[Decimal]) -> Decimal:
    q = MIN_PRECISION
    for a in amounts:
        exp = a.as_tuple().exponent
        if isinstance(exp, int) and exp < 0:
            q = min(q, Decimal(1).scaleb(exp))
    return q


def allocate_exact(total: Decimal, weights: Dict[str, Fraction], precision: Decimal) -> Dict[str, Decimal]:
    """Split total by exact weights; parts sum exactly to total. Deterministic tie-break (TIE_BREAK)."""
    if not weights:
        raise MappingError("ALLOCATION_NO_WEIGHTS", "no weights")
    if any(w < 0 for w in weights.values()):
        raise MappingError("ALLOCATION_NEGATIVE_WEIGHT", "negative weight")
    wsum = sum(weights.values(), Fraction(0))
    if wsum == 0:
        raise MappingError("ALLOCATION_ZERO_WEIGHTS", "weights sum to zero")
    units = total / precision
    if units != units.to_integral_value():
        raise MappingError("ALLOCATION_PRECISION", f"{total} is not a multiple of {precision}")
    units_i = int(units)
    sign, n = (-1 if units_i < 0 else 1), abs(units_i)
    raw = {k: Fraction(n) * Fraction(w) / wsum for k, w in weights.items()}
    base = {k: floor(v) for k, v in raw.items()}
    rest = n - sum(base.values())
    for k in sorted(weights, key=lambda k: (-(raw[k] - base[k]), k))[:rest]:
        base[k] += 1
    out = {k: Decimal(sign * v) * precision for k, v in base.items()}
    if sum(out.values(), Decimal(0)) != total:
        raise MappingError("ALLOCATION_NOT_EXACT", "internal error")
    return out


class Money:
    __slots__ = ("amount", "currency")

    def __init__(self, amount: Decimal, currency: str):
        if not isinstance(amount, Decimal):
            raise MappingError("MONEY_TYPE", "Money needs a Decimal")
        self.amount, self.currency = amount, currency

    def __add__(self, other: "Money") -> "Money":
        if other.currency != self.currency:
            raise MappingError("CROSS_CURRENCY", f"refusing to add {self.currency} and {other.currency}")
        return Money(self.amount + other.amount, self.currency)


def frac_text(f: Fraction) -> str:
    return str(f.numerator) if f.denominator == 1 else f"{f.numerator}/{f.denominator}"


def parse_fraction(s: str, what: str) -> Fraction:
    try:
        f = Fraction(s)
    except (ValueError, ZeroDivisionError) as exc:
        raise MappingError("GPU_FRACTION_INVALID", f"{what}: {s!r}") from exc
    if f < 0 or f > 1:
        raise MappingError("GPU_FRACTION_INVALID", f"{what}: {s!r} outside [0, 1]")
    return f


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def next_day(day: str) -> str:
    return (datetime.fromisoformat(day) + timedelta(days=1)).strftime("%Y-%m-%d")


def short_id(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()[:24]


# ---------------------------------------------------------------------------
# Pseudonymization: tenant-scoped HMAC with a key-version id (ps1:<keyId>:<hex>)
# ---------------------------------------------------------------------------
KEY_ID_RE = re.compile(r"^[a-z0-9-]{1,32}$")


class Pseudonymizer:
    """The key never enters telemetry; only its id does. Output is pseudonymous, not anonymous."""

    def __init__(self, master: bytes, key_id: str):
        if len(master) < 32:
            raise SystemExit("pseudonymization key must be at least 32 bytes")
        if not KEY_ID_RE.match(key_id):
            raise SystemExit("pseudonymization key id must match [a-z0-9-]{1,32}")
        self._master, self.key_id = master, key_id

    def ref(self, tenant: str, issuer: str, subject: str) -> str:
        tenant_key = hmac.new(self._master, f"ratio/ps1/tenant-key\x1f{tenant}\x1f{self.key_id}".encode(),
                              hashlib.sha256).digest()
        digest = hmac.new(tenant_key, f"{issuer}\x1f{subject}".encode(), hashlib.sha256).hexdigest()
        return f"ps1:{self.key_id}:{digest}"


def fixture_pseudonymizer() -> Pseudonymizer:
    """Deterministic key for goldens and self-test only. Derived, never a stored secret."""
    return Pseudonymizer(hashlib.sha256(b"ratio-telemetry-kit/fixture-key-derivation/v1").digest(), "fixture-k1")


# ---------------------------------------------------------------------------
# v1 contract shape checks (Python port of src/platform/contracts; the repo's TypeScript
# validators remain authoritative and run over the goldens in contract-conformance.test.ts)
# ---------------------------------------------------------------------------
RX = {
    "id": re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$"),
    "model": re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}(@[0-9A-Za-z][0-9A-Za-z._-]{0,31})?$"),
    "instant": re.compile(r"^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?Z$"),
    "date": re.compile(r"^\d{4}-\d{2}-\d{2}$"),
    "tokens": re.compile(r"^(0|[1-9]\d{0,19})$"),
    "profile": re.compile(r"^[a-z0-9-]{1,64}/\d{1,4}$"),
    "ps1": re.compile(r"^ps1:[a-z0-9-]{1,32}:[0-9a-f]{64}$"),
    "svc": re.compile(r"^svc:[A-Za-z0-9._-]{1,128}$"),
    "agt": re.compile(r"^agt:[A-Za-z0-9._-]{1,128}$"),
    "reason": re.compile(r"^[A-Z][A-Z0-9_]{0,63}$"),
    "currency": re.compile(r"^(USD|EUR|GBP|JPY|CAD|AUD|CHF)$"),  # subset; the TS validator checks full ISO 4217
}
USAGE_KEYS = {"schemaVersion", "eventId", "tenantId", "sourceConnectionId", "dedupKey", "supersedes", "occurredAt",
              "receivedAt", "workloadId", "actorRef", "actorType", "provider", "modelRequested", "modelServed", "sku",
              "providerRequestId", "attempt", "serviceTier", "usageBasis", "tokenUsage", "units", "status",
              "evidenceRef"}
USAGE_REQUIRED = {"schemaVersion", "eventId", "tenantId", "sourceConnectionId", "dedupKey", "occurredAt", "receivedAt",
                  "actorType", "provider", "usageBasis", "status", "evidenceRef"}
TOKEN_KEYS = {"input", "output", "cachedInput", "cacheWrite", "reasoning", "accountingProfile"}
FIN_KEYS = {"schemaVersion", "recordId", "tenantId", "sourceConnectionId", "kind", "amount", "currency", "periodStart",
            "periodEnd", "provider", "providerAccount", "workloadId", "model", "sku", "rateBasis", "rateCardRef",
            "configSha256", "linkedUsageEventIds", "supersedes", "evidenceRef"}
FIN_REQUIRED = {"schemaVersion", "recordId", "tenantId", "sourceConnectionId", "kind", "amount", "currency",
                "periodStart", "periodEnd", "provider", "rateBasis", "evidenceRef"}
ALLOC_KEYS = {"schemaVersion", "allocationId", "tenantId", "methodology", "periodStart", "periodEnd", "currency",
              "basis", "sourceAmount", "shares", "unallocated", "unallocatedReasons", "evidenceRef"}


def _chk(problems: List[str], cond: bool, msg: str) -> None:
    if not cond:
        problems.append(msg)


def _is(kind: str, v: Any) -> bool:
    return isinstance(v, str) and bool(RX[kind].match(v))


def _money(v: Any) -> bool:
    return isinstance(v, str) and bool(CANONICAL_DECIMAL.match(v)) and not (v.startswith("-") and Decimal(v) == 0)


def v_usage_event(e: Dict[str, Any]) -> List[str]:
    p: List[str] = []
    _chk(p, set(e) <= USAGE_KEYS, f"unknown keys {sorted(set(e) - USAGE_KEYS)}")
    _chk(p, USAGE_REQUIRED <= set(e), f"missing {sorted(USAGE_REQUIRED - set(e))}")
    _chk(p, e.get("schemaVersion") == "ai-usage-event/1", "schemaVersion")
    for k in ("eventId", "tenantId", "sourceConnectionId", "dedupKey", "provider", "evidenceRef"):
        _chk(p, _is("id", e.get(k)), f"{k} not an id")
    for k in ("workloadId", "providerRequestId", "supersedes", "sku"):
        if k in e:
            _chk(p, _is("id", e[k]), f"{k} not an id")
    for k in ("modelRequested", "modelServed"):
        if k in e:
            _chk(p, _is("model", e[k]), f"{k} not a model id")
    for k in ("occurredAt", "receivedAt"):
        _chk(p, _is("instant", e.get(k)), f"{k} not a UTC instant")
    if _is("instant", e.get("occurredAt")) and _is("instant", e.get("receivedAt")):
        _chk(p, e["receivedAt"] >= e["occurredAt"], "receivedAt before occurredAt")
    _chk(p, e.get("usageBasis") in ("reported", "estimated"), "usageBasis")
    _chk(p, e.get("status") in ("succeeded", "failed", "cancelled", "unknown"), "status")
    if "attempt" in e:
        _chk(p, isinstance(e["attempt"], int) and not isinstance(e["attempt"], bool) and e["attempt"] > 0, "attempt")
    t = e.get("actorType")
    ref = e.get("actorRef")
    ok = {"human": _is("ps1", ref), "service": _is("svc", ref), "agent": _is("agt", ref),
          "unknown": ref is None}.get(t, False)
    _chk(p, ok, "actorRef does not match actorType")
    if "tokenUsage" in e:
        tu = e["tokenUsage"]
        _chk(p, isinstance(tu, dict) and set(tu) <= TOKEN_KEYS, "tokenUsage keys")
        _chk(p, _is("profile", tu.get("accountingProfile")), "accountingProfile")
        for k in TOKEN_KEYS - {"accountingProfile"}:
            if k in tu:
                _chk(p, _is("tokens", tu[k]), f"tokenUsage.{k} not a canonical integer string")
    return p


def v_financial(r: Dict[str, Any]) -> List[str]:
    p: List[str] = []
    _chk(p, set(r) <= FIN_KEYS, f"unknown keys {sorted(set(r) - FIN_KEYS)}")
    _chk(p, FIN_REQUIRED <= set(r), f"missing {sorted(FIN_REQUIRED - set(r))}")
    _chk(p, r.get("schemaVersion") == "ai-financial-record/1", "schemaVersion")
    _chk(p, r.get("kind") in ("billed", "effective", "estimated_invocation", "credit", "adjustment"), "kind")
    _chk(p, _money(r.get("amount")), "amount not canonical")
    _chk(p, _is("currency", r.get("currency")), "currency")
    _chk(p, _is("date", r.get("periodStart")) and _is("date", r.get("periodEnd")), "period dates")
    if _is("date", r.get("periodStart")) and _is("date", r.get("periodEnd")):
        _chk(p, r["periodEnd"] > r["periodStart"], "periodEnd not after periodStart")
    _chk(p, r.get("rateBasis") in ("contract", "public_list", "not_applicable", "unknown"), "rateBasis")
    if r.get("kind") == "estimated_invocation":
        _chk(p, "rateCardRef" in r, "estimated_invocation needs rateCardRef")
        _chk(p, r.get("rateBasis") in ("contract", "public_list"), "estimate needs contract or public_list basis")
    if "linkedUsageEventIds" in r:
        ids = r["linkedUsageEventIds"]
        _chk(p, isinstance(ids, list) and len(ids) >= 1 and len(set(ids)) == len(ids), "linkedUsageEventIds set")
    return p


def v_allocation(a: Dict[str, Any]) -> List[str]:
    p: List[str] = []
    _chk(p, set(a) == ALLOC_KEYS, f"keys differ: {sorted(set(a) ^ ALLOC_KEYS)}")
    _chk(p, a.get("schemaVersion") == "allocation/1", "schemaVersion")
    _chk(p, a.get("basis") in ("billed", "effective", "estimated_invocation"), "basis")
    for k in ("sourceAmount", "unallocated"):
        _chk(p, _money(a.get(k)), f"{k} not canonical")
    shares = a.get("shares") or []
    for s in shares:
        _chk(p, set(s) == {"targetKind", "targetRef", "amount", "ruleId"}, "share keys")
        _chk(p, s.get("targetKind") in ("workload", "team", "cost_center", "user", "service"), "targetKind")
        _chk(p, _money(s.get("amount")) and _is("id", s.get("targetRef")) and _is("id", s.get("ruleId")), "share fields")
    if not p:
        total = sum((Decimal(s["amount"]) for s in shares), Decimal(0)) + Decimal(a["unallocated"])
        _chk(p, total == Decimal(a["sourceAmount"]), "shares + unallocated != sourceAmount")
        _chk(p, Decimal(a["unallocated"]) == 0 or len(a["unallocatedReasons"]) > 0, "unallocatedReasons required")
        _chk(p, all(_is("reason", x) for x in a["unallocatedReasons"]), "reason codes")
        _chk(p, len({(s["targetKind"], s["targetRef"]) for s in shares}) == len(shares), "duplicate target")
    return p


# ---------------------------------------------------------------------------
# Scenarios and fixtures (synthetic only)
# ---------------------------------------------------------------------------
SCENARIOS: Dict[str, Dict[str, Any]] = {
    "bypass": {"about": "synthetic bypass: billed tokens never seen by the gateway (detector test)",
               "billedOnly": {"input": 5000, "output": 400}},
    "baseline": {"about": "negative control: billing matches gateway observations"},
    "delay": {"about": "control: 3 events arrive after the reconciliation as-of time", "late": 3,
              "asOf": "2026-11-05T06:00:00Z"},
    "delay-resolved": {"about": "control: same data, as-of after late arrivals", "late": 3,
                       "asOf": "2026-11-08T00:00:00Z"},
    "alias-unmapped": {"about": "control: dated served-model id with no canonical mapping", "dated": 4},
    "alias-mapped": {"about": "control: dated served-model id with a versioned canonical mapping", "dated": 4,
                     "canonicalMap": True},
    "accounting-mismatch": {"about": "control: provider profile mis-set (cached counted outside input)",
                            "wrongProfile": True},
    "overclaim": {"about": "control: time-sliced GPU without a replica config (each pod claims 1 GPU)",
                  "dropTimeSlice": True},
}
TENANT = "tenant-fixture"
CONNECTION = {
    "sourceConnectionId": "conn-litellm-fixture", "tenantId": TENANT, "issuer": "litellm:fixture",
    "gatewayEstimateCurrency": "USD",  # VERIFY: the gateway's own cost map currency
    "providerAccounts": {"provider-a": "pa-project-fixture", "provider-b": "pb-workspace-fixture"},
}
PROFILES = {
    "profiles": {
        "fixture-input-includes-cached/1": {"cachedInputWithinInput": True, "cacheWriteBilled": False},
        "fixture-disjoint/1": {"cachedInputWithinInput": False, "cacheWriteBilled": True},
        "fixture-selfhosted-reported/1": {"cachedInputWithinInput": False, "cacheWriteBilled": False},
    },
    "providerProfiles": {"provider-a": "fixture-input-includes-cached/1", "provider-b": "fixture-disjoint/1",
                         "hosted_vllm": "fixture-selfhosted-reported/1"},
}
PRICES = {  # provider -> currency, model -> category -> (sku, price per 1M tokens); synthetic
    "provider-a": ("USD", {"model-large": {"input": ("pa-large-in", "2.5"), "cachedInput": ("pa-large-cin", "1.25"),
                                           "output": ("pa-large-out", "10")},
                           "model-small": {"input": ("pa-small-in", "0.15"), "cachedInput": ("pa-small-cin", "0.075"),
                                           "output": ("pa-small-out", "0.6")}}),
    "provider-b": ("EUR", {"model-medium": {"input": ("pb-med-in", "3"), "cachedInput": ("pb-med-cin", "0.3"),
                                            "cacheWrite": ("pb-med-cw", "3.75"), "output": ("pb-med-out", "15")}}),
}
ROUTES_BASE = {
    "routeMapVersion": "fixture-routes/1",
    "aliases": {"default-large": {"primary": "model-large", "fallbacks": ["model-small"]},
                "review-medium": {"primary": "model-medium", "fallbacks": []},
                "selfhosted-8b": {"primary": "selfhosted-llm-8b", "fallbacks": []}},
    "servedModelCanonical": {},
}
GPU_NODE, GPUS_PER_NODE = "gpu-node-1", 8
OWNERSHIP = {
    "workloads": {  # workload -> owning team (gateway tenant); "shared" marks platform capacity
        "triage-agent": {"team": "team-alpha"}, "review-agent": {"team": "team-beta"},
        "selfhosted-llm": {"team": "platform", "shared": True}, "finetune-code-review": {"team": "team-beta"},
        "eval-job": {"team": "team-beta"}, "embed-svc": {"team": "team-alpha"},
        "batch-summarizer": {"team": "team-alpha"}},
    "podLabels": {  # namespace/pod -> workload (from the Kubernetes API); notebook-x has no labels on purpose
        "inference/vllm-shared-0": "selfhosted-llm", "inference/vllm-shared-1": "selfhosted-llm",
        "team-beta/finetune-job-7": "finetune-code-review", "team-beta/eval-job-2": "eval-job",
        "team-alpha/embed-svc-1": "embed-svc", "team-alpha/batch-summarizer-0": "batch-summarizer"},
    "servedBy": {"selfhosted-llm-8b": "selfhosted-llm"},
    "nodes": {GPU_NODE: {"gpus": GPUS_PER_NODE, "gpuModel": "A100-80GB"}},
    "migProfiles": {"A100-80GB": {"1g.10gb": "1/7", "2g.20gb": "2/7", "3g.40gb": "3/7", "4g.40gb": "4/7",
                                  "7g.80gb": "1"}},  # VERIFY against your GPU model's MIG geometry
    "deviceSharing": {GPU_NODE: {"6": {"mode": "time-sliced", "replicas": 2}}},
}


def rate_cards() -> List[Dict[str, Any]]:
    cards = []
    for prov, (ccy, models) in PRICES.items():
        entries = [{"model": m, "sku": sku, "category": cat, "serviceTier": "standard", "unit": "per_1m_tokens",
                    "price": price}
                   for m, cats in models.items() for cat, (sku, price) in cats.items()]
        cards.append({"schemaVersion": "rate-card/1", "rateCardId": f"rc-fixture-{prov}", "version": 1,
                      "tenantId": TENANT, "provider": prov, "currency": ccy, "basis": "contract",
                      "effectiveFrom": "2026-11-01", "entries": entries,
                      "provenance": {"kind": "owner_entry", "reference": "fixture:synthetic-not-sourced",
                                     "retrievedOn": "2026-11-01"}})
    return cards


def gen_gateway_rows(rng: random.Random, sc: Dict[str, Any]) -> List[Dict[str, Any]]:
    t0 = FIXTURE_DAY + timedelta(hours=10)
    rows: List[Dict[str, Any]] = []

    def add(team: str, user: str, alias: str, model: str, provider: str, prompt: Optional[int],
            completion: Optional[int], minute: float, tags: List[str], trace: str, logical: Optional[str],
            attempt: int = 1, cache_read: int = 0, cache_write: int = 0, status: str = "success") -> Dict[str, Any]:
        i = len(rows) + 1
        meta: Dict[str, Any] = {"trace_id": trace}
        if logical is not None:
            meta.update({"logical_request_id": logical, "attempt": attempt})
        r = {"request_id": f"req-{i:04d}", "call_type": "acompletion", "model_group": alias, "model": model,
             "custom_llm_provider": provider, "prompt_tokens": prompt, "completion_tokens": completion,
             "cache_read_input_tokens": cache_read, "cache_creation_input_tokens": cache_write, "spend": None,
             "startTime": iso(t0 + timedelta(minutes=minute)),
             "endTime": iso(t0 + timedelta(minutes=minute, seconds=rng.randint(1, 20))),
             "team_id": team, "user": user, "status": status, "request_tags": tags, "metadata": meta}
        rows.append(r)
        return r

    for run in range(6):  # team-alpha support-triage agent runs
        for step in range(rng.randint(3, 5)):
            sh = step % 3 == 2
            add("team-alpha", f"user{run % 3}@example.test", "selfhosted-8b" if sh else "default-large",
                "selfhosted-llm-8b" if sh else "model-large", "hosted_vllm" if sh else "provider-a",
                rng.randint(800, 4000), rng.randint(100, 900), run * 7 + step,
                ["workflow:support-triage", f"agent_run:a-{run}", "workload:triage-agent"], f"trace-a-{run}",
                f"lr-a-{run}-{step}", cache_read=0 if sh else rng.choice([0, 0, 512]))
    for run in range(5):  # team-beta code-review agent runs (run b-3 has no logical-request grouping)
        for step in range(rng.randint(2, 4)):
            sh = step == 1 and run % 2 == 0
            add("team-beta", f"svc:ci-{run % 2}", "selfhosted-8b" if sh else "review-medium",
                "selfhosted-llm-8b" if sh else "model-medium", "hosted_vllm" if sh else "provider-b",
                rng.randint(1500, 6000), rng.randint(200, 1200), 60 + run * 9 + step * 2,
                ["workflow:code-review", f"agent_run:b-{run}", "workload:review-agent"], f"trace-b-{run}",
                None if run == 3 else f"lr-b-{run}-{step}",
                cache_read=0 if sh else rng.choice([0, 2048, 4096]),
                cache_write=0 if sh else rng.choice([0, 1024]))
    retry_tags = ["workflow:support-triage", "agent_run:a-retry", "workload:triage-agent"]
    first = add("team-alpha", "user0@example.test", "default-large", "model-large", "provider-a", None, None, 50,
                retry_tags, "trace-a-retry", "lr-a-retry", attempt=1, status="failure")
    first["error"] = {"type": "RateLimitError", "message": f"429 upstream echoed: {CANARY} {CANARY_EMAIL}"}
    add("team-alpha", "user0@example.test", "default-large", "model-large", "provider-a", 2100, 300, 50.2,
        retry_tags, "trace-a-retry", "lr-a-retry", attempt=2)
    add("team-alpha", "user1@example.test", "default-large", "model-small", "provider-a", 1200, 150, 55,
        ["workflow:support-triage", "agent_run:a-fallback", "workload:triage-agent"], "trace-a-fallback",
        "lr-a-fallback")
    add("team-beta", "svc:ci-0", "review-medium", "model-medium", "provider-b", None, None, 110,
        ["workflow:code-review", "agent_run:b-cut", "workload:review-agent"], "trace-b-cut", "lr-b-cut",
        status="unknown")
    # content canaries in places a careless adapter would copy
    rows[0]["messages"] = [{"role": "user", "content": f"{CANARY} please summarize"}]
    rows[1]["response"] = {"choices": [{"message": {"content": CANARY}}]}
    rows[2]["metadata"]["debug"] = {"prompt_preview": CANARY, "end_user_email": CANARY_EMAIL}
    rows[3]["request_tags"] = rows[3]["request_tags"] + [f"note:{CANARY}", f"agent_run:Summarize {CANARY}"]
    rows[4]["end_user"] = CANARY_EMAIL
    # dated served-model ids (alias scenarios)
    if sc.get("dated"):
        n = 0
        for r in rows:
            if r["model"] == "model-large" and r["prompt_tokens"] is not None and n < sc["dated"]:
                r["model"] = "model-large@20261001"
                n += 1
    # late arrivals (delay scenarios): fixture-only ingestion stamp; real receivedAt is set at ingestion
    if sc.get("late"):
        n = 0
        for r in rows:
            if r["model"] == "model-large" and r["prompt_tokens"] is not None and n < sc["late"]:
                r["_ingest"] = {"receivedAt": "2026-11-07T00:00:00Z"}
                n += 1
    return rows


def gen_gpu_samples(rng: random.Random, sc: Dict[str, Any]) -> List[Dict[str, str]]:
    """Join of kubelet pod-resources claims and dcgm-exporter samples, every 15 s for 2 hours (VERIFY)."""
    out: List[Dict[str, str]] = []
    start = FIXTURE_DAY + timedelta(hours=10)
    for s in range(0, 2 * 3600, SAMPLE_INTERVAL_S):
        ts = iso(start + timedelta(seconds=s))

        def row(gpu: int, inst: str, mode: str, frac: str, pod: str, active: Optional[float]) -> None:
            ns, name = pod.split("/") if pod else ("", "")
            out.append({"timestamp": ts, "Hostname": GPU_NODE, "gpu": str(gpu), "UUID": f"GPU-fixture-{gpu}",
                        "gpuInstance": inst, "sharingMode": mode, "allocatedFraction": frac, "namespace": ns,
                        "pod": name, "DCGM_FI_PROF_GR_ENGINE_ACTIVE": "" if active is None else f"{active:.3f}"})

        busy = lambda: rng.uniform(0.3, 0.9)  # noqa: E731
        row(0, "", "exclusive", "1", "inference/vllm-shared-0", busy())
        row(1, "", "exclusive", "1", "inference/vllm-shared-0", busy())
        row(2, "", "exclusive", "1", "inference/vllm-shared-1", busy())
        row(3, "3g.40gb", "mig", "3/7", "team-beta/eval-job-2", busy())
        row(3, "2g.20gb", "mig", "2/7", "team-alpha/embed-svc-1", 0.04)  # held, mostly inactive (diagnostic)
        for g in (4, 5):
            if s < 5400:
                row(g, "", "exclusive", "1", "team-beta/finetune-job-7", busy())
            else:
                row(g, "", "none", "0", "", 0.0)
        row(6, "", "time-sliced", "1", "research/notebook-x", None)       # device plugin reports a full GPU
        row(6, "", "time-sliced", "1", "team-alpha/batch-summarizer-0", None)
        if not (3600 + 600 <= s < 3600 + 1200):                           # GPU 7: 10-minute telemetry gap
            row(7, "", "none", "0", "", 0.0)
    return out


def gen_billing(rows: List[Dict[str, Any]], sc: Dict[str, Any]) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
    """Provider-side truth, computed independently of the kit's profile code."""
    qty: Dict[Tuple[str, str, str], int] = defaultdict(int)
    for r in rows:
        prov = r["custom_llm_provider"]
        if prov not in PRICES or r["prompt_tokens"] is None:
            continue
        model = "model-large" if r["model"].startswith("model-large") else r["model"]
        cr, cw = r["cache_read_input_tokens"] or 0, r["cache_creation_input_tokens"] or 0
        if prov == "provider-a":  # provider-a bills uncached input and cached input separately
            qty[(prov, model, "input")] += r["prompt_tokens"] - cr
        else:                     # provider-b reports input excluding cache reads and writes
            qty[(prov, model, "input")] += r["prompt_tokens"]
        qty[(prov, model, "cachedInput")] += cr
        qty[(prov, model, "cacheWrite")] += cw
        qty[(prov, model, "output")] += r["completion_tokens"]
    for cat, n in (sc.get("billedOnly") or {}).items():
        qty[("provider-a", "model-large", cat)] += n
    day0, day1 = iso(FIXTURE_DAY), iso(FIXTURE_DAY + timedelta(days=1))
    focus: List[Dict[str, str]] = []
    inv: Dict[str, Tuple[str, Decimal]] = {}

    def add(row: Dict[str, str]) -> None:
        focus.append(row)
        ccy, amt = inv.get(row["InvoiceId"], (row["BillingCurrency"], Decimal(0)))
        inv[row["InvoiceId"]] = (ccy, amt + Decimal(row["BilledCost"]))

    for (prov, model, cat), n in sorted(qty.items()):
        if n == 0:
            continue
        ccy, models = PRICES[prov]
        sku, price = models[model][cat]
        cost = (Decimal(n) * Decimal(price) / Decimal(1_000_000)).quantize(MIN_PRECISION)
        add({"BilledCost": str(cost), "EffectiveCost": str(cost), "ListCost": str(cost), "BillingCurrency": ccy,
             "BillingAccountId": f"{prov}-billing-fixture", "SubAccountId": CONNECTION["providerAccounts"][prov],
             "ChargePeriodStart": day0, "ChargePeriodEnd": day1, "ChargeCategory": "Usage",
             "ServiceCategory": "AI and Machine Learning", "ServiceName": f"{prov} API", "ServiceProviderName": prov,
             "ResourceId": f"{prov}:{CONNECTION['providerAccounts'][prov]}", "SkuId": sku,
             "SkuPriceId": f"{sku}@rc-fixture-{prov}/1", "ConsumedQuantity": str(n), "ConsumedUnit": "Tokens",
             "PricingQuantity": str(Decimal(n) / Decimal(1_000_000)), "PricingUnit": "1M Tokens",
             "InvoiceId": f"INV-{prov}-2026-11", "Tags": json.dumps({"ratio.fixture": "true"})})
    for h in range(2):
        st = FIXTURE_DAY + timedelta(hours=10 + h)
        add({"BilledCost": "32.770000", "EffectiveCost": "21.300500", "ListCost": "32.770000",
             "BillingCurrency": "USD", "BillingAccountId": "cloud-billing-fixture",
             "SubAccountId": "cloud-sub-fixture", "ChargePeriodStart": iso(st),
             "ChargePeriodEnd": iso(st + timedelta(hours=1)), "ChargeCategory": "Usage",
             "ServiceCategory": "Compute", "ServiceName": "GPU Virtual Machines",
             "ServiceProviderName": "cloud-fixture", "ResourceId": GPU_NODE, "SkuId": "gpu-8x-fixture",
             "SkuPriceId": "gpu-8x-fixture@commit-1y", "ConsumedQuantity": "1", "ConsumedUnit": "Hours",
             "PricingQuantity": "1", "PricingUnit": "Hours", "InvoiceId": "INV-cloud-2026-11",
             "Tags": json.dumps({"ratio.fixture": "true"})})
    return focus, {k: {"currency": c, "amount": canonical(a)} for k, (c, a) in sorted(inv.items())}


def write_gateway_jsonl(path: Path, rows: List[Dict[str, Any]]) -> None:
    """provider-a spend is written as JSON numbers, others as strings: both must parse exactly."""
    with open(path, "w") as f:
        for r in rows:
            r = dict(r)
            num = None
            if r["spend"] is not None and r["custom_llm_provider"] == "provider-a":
                num, r["spend"] = r["spend"], "__NUM__"
            line = json.dumps(r, sort_keys=True)
            if num is not None:
                line = line.replace('"__NUM__"', num)
            f.write(line + "\n")


def write_csv(path: Path, rows: List[Dict[str, str]]) -> None:
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


def generate(fixtures: Path, seed: int, scenario: str) -> None:
    sc = SCENARIOS[scenario]
    rng = random.Random(seed)
    fixtures.mkdir(parents=True, exist_ok=True)
    rows = gen_gateway_rows(rng, sc)
    for r in rows:  # gateway's own estimate (its price table, rounded to 4 dp, always USD here)
        if r["custom_llm_provider"] in PRICES and r["prompt_tokens"] is not None:
            _, models = PRICES[r["custom_llm_provider"]]
            m = models["model-large" if r["model"].startswith("model-large") else r["model"]]
            cr, cw = r["cache_read_input_tokens"], r["cache_creation_input_tokens"]
            uncached = r["prompt_tokens"] - (cr if r["custom_llm_provider"] == "provider-a" else 0)
            est = (Decimal(uncached) * Decimal(m["input"][1]) + Decimal(cr) * Decimal(m["cachedInput"][1])
                   + Decimal(cw) * Decimal(m.get("cacheWrite", ("", "0"))[1])
                   + Decimal(r["completion_tokens"]) * Decimal(m["output"][1])) / Decimal(1_000_000)
            r["spend"] = str(est.quantize(Decimal("0.0001")))
    focus, invoices = gen_billing(rows, sc)
    rng_gpu = random.Random(seed + 1)
    write_gateway_jsonl(fixtures / "gateway_spend_logs.jsonl", rows)
    write_csv(fixtures / "gpu_samples.csv", gen_gpu_samples(rng_gpu, sc))
    write_csv(fixtures / "focus_billing.csv", focus)
    routes = json.loads(json.dumps(ROUTES_BASE))
    if sc.get("canonicalMap"):
        routes["servedModelCanonical"] = {"model-large@20261001": "model-large"}
        routes["routeMapVersion"] = "fixture-routes/2"
    profiles = json.loads(json.dumps(PROFILES))
    if sc.get("wrongProfile"):
        profiles["providerProfiles"]["provider-a"] = "fixture-disjoint/1"
    own = json.loads(json.dumps(OWNERSHIP))
    if sc.get("dropTimeSlice"):
        own["deviceSharing"] = {}
    dump = lambda p, o: (fixtures / p).write_text(json.dumps(o, indent=2, sort_keys=True) + "\n")  # noqa: E731
    dump("rate_cards.json", rate_cards())
    dump("routes.json", routes)
    dump("accounting_profiles.json", profiles)
    dump("ownership.json", own)
    dump("connection.json", CONNECTION)
    dump("invoices.json", invoices)
    dump("scenario.json", {"scenario": scenario, "seed": seed, "about": sc["about"], "asOf": sc.get("asOf"),
                           "provenance": "synthetic fixture generated by ratio_telemetry_check.py",
                           "kitVersion": KIT_VERSION})


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
ALLOWED_TAG_KEYS = {"workflow", "agent_run", "workload"}
TAG_VALUE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
STATUS_MAP = {"success": "succeeded", "failure": "failed", "cancelled": "cancelled", "canceled": "cancelled"}
# Note: 'cancelled' is the serialized v1 contract value; prose in this kit uses en-US 'canceled'.


class Inputs:
    def __init__(self, fixtures: Path):
        rd = lambda p: load_json_precise((fixtures / p).read_text())  # noqa: E731
        self.rows = [load_json_precise(l) for l in (fixtures / "gateway_spend_logs.jsonl").read_text().splitlines()
                     if l.strip()]
        self.cards = rd("rate_cards.json")
        self.routes, self.profiles = rd("routes.json"), rd("accounting_profiles.json")
        self.own, self.conn, self.invoices, self.scenario = (rd("ownership.json"), rd("connection.json"),
                                                             rd("invoices.json"), rd("scenario.json"))
        with open(fixtures / "focus_billing.csv") as f:
            self.focus = list(csv.DictReader(f))
        with open(fixtures / "gpu_samples.csv") as f:
            self.gpu = list(csv.DictReader(f))
        self.price: Dict[Tuple[str, str, str], Tuple[Dict[str, Any], Dict[str, Any]]] = {}
        self.sku: Dict[str, Tuple[str, str, str]] = {}
        for c in self.cards:
            for e in c["entries"]:
                self.price[(c["provider"], e["model"], e["category"])] = (c, e)
                self.sku[e["sku"]] = (c["provider"], e["model"], e["category"])


def billable_quantities(usage: Dict[str, int], prof: Dict[str, Any]) -> Dict[str, int]:
    cin, cw, inp = usage.get("cachedInput", 0), usage.get("cacheWrite", 0), usage.get("input", 0)
    if prof["cachedInputWithinInput"]:
        if cin > inp:
            raise MappingError("CACHED_EXCEEDS_INPUT", "cachedInput exceeds input under an overlapping profile")
        q = {"input": inp - cin, "cachedInput": cin}
    else:
        q = {"input": inp, "cachedInput": cin}
    if cw:
        if not prof["cacheWriteBilled"]:
            raise MappingError("CACHE_WRITE_UNEXPECTED", "cacheWrite reported for a profile that does not bill it")
        q["cacheWrite"] = cw
    q["output"] = usage.get("output", 0)
    return {k: v for k, v in q.items() if v}


def normalize(inp: Inputs, pz: Pseudonymizer) -> Dict[str, Any]:
    conn, routes = inp.conn, inp.routes
    canon = routes.get("servedModelCanonical", {})
    events, valuations, src_est, corr, quarantine = [], [], [], [], []
    counters: Dict[str, int] = defaultdict(int)
    billable: Dict[str, Dict[str, int]] = {}
    tags_by_event: Dict[str, Dict[str, str]] = {}
    default_received = iso(FIXTURE_DAY + timedelta(days=1))
    for r in inp.rows:
        try:
            rid = r.get("request_id")
            if not _is("id", rid):
                raise MappingError("SOURCE_ID_INVALID", f"request_id {rid!r}")
            tags: Dict[str, str] = {}
            for t in r.get("request_tags") or []:
                k, _, v = str(t).partition(":")
                if k not in ALLOWED_TAG_KEYS:
                    counters["droppedTagKeys"] += 1
                elif not TAG_VALUE.match(v):
                    counters["rejectedTagValues"] += 1
                else:
                    tags[k] = v
            provider = r.get("custom_llm_provider")
            served_raw = r.get("model")
            served = canon.get(served_raw, served_raw)
            subject = r.get("user") or ""
            if subject.startswith("svc:") and _is("svc", subject):
                actor_type, actor_ref = "service", subject
            elif subject:
                actor_type, actor_ref = "human", pz.ref(conn["tenantId"], conn["issuer"], subject)
            else:
                actor_type, actor_ref = "unknown", None
            usage: Dict[str, int] = {}
            for src, dst in (("prompt_tokens", "input"), ("completion_tokens", "output"),
                             ("cache_read_input_tokens", "cachedInput"),
                             ("cache_creation_input_tokens", "cacheWrite")):
                n = source_count(r.get(src), src)
                if n is not None and (n > 0 or dst in ("input", "output")):
                    usage[dst] = n
            profile_id = inp.profiles["providerProfiles"].get(provider)
            meta = r.get("metadata") or {}
            occurred = r["startTime"]
            received = (r.get("_ingest") or {}).get("receivedAt", default_received)
            ev: Dict[str, Any] = {
                "schemaVersion": "ai-usage-event/1",
                "eventId": "evt-" + short_id(conn["issuer"], rid),
                "tenantId": conn["tenantId"],                 # from the authenticated connection, never the payload
                "sourceConnectionId": conn["sourceConnectionId"],
                "dedupKey": f"{conn['issuer']}:{rid}",
                "occurredAt": occurred, "receivedAt": received,
                "actorType": actor_type, "provider": provider,
                "modelRequested": r.get("model_group"), "modelServed": served_raw,
                "providerRequestId": rid, "usageBasis": "reported",  # VERIFY: gateway relays provider usage
                "status": STATUS_MAP.get(r.get("status"), "unknown"),
                "evidenceRef": f"fixture:gateway_spend_logs.jsonl:{rid}",
            }
            if actor_ref:
                ev["actorRef"] = actor_ref
            if tags.get("workload"):
                ev["workloadId"] = tags["workload"]
            if meta.get("logical_request_id") and isinstance(meta.get("attempt"), int) and meta["attempt"] > 0:
                ev["attempt"] = meta["attempt"]
            else:
                counters["attemptUnknown"] += 1
            qty: Dict[str, int] = {}
            if usage:
                if profile_id is None:
                    raise MappingError("ACCOUNTING_PROFILE_MISSING", f"no profile for provider {provider}")
                ev["tokenUsage"] = {**{k: str(v) for k, v in usage.items()}, "accountingProfile": profile_id}
                qty = billable_quantities(usage, inp.profiles["profiles"][profile_id])
            problems = v_usage_event(ev)
            if problems:
                raise MappingError("CONTRACT_V1_INVALID", "; ".join(problems))
        except MappingError as exc:
            quarantine.append({"requestId": r.get("request_id"), "code": exc.code, "detail": str(exc)})
            continue
        events.append(ev)
        tags_by_event[ev["eventId"]] = tags
        billable[ev["eventId"]] = qty
        alias = routes["aliases"].get(ev["modelRequested"])
        route_class = ("UNMAPPED_ALIAS" if alias is None else "NO_SERVED_MODEL" if not served else
                       "PRIMARY" if served == alias["primary"] else
                       "DECLARED_FALLBACK" if served in alias["fallbacks"] else "UNDECLARED_SERVED_MODEL")
        c = {"schemaVersion": "ratio.usage-correlation/0-draft", "eventId": ev["eventId"],
             "routeMapVersion": routes["routeMapVersion"], "routeClass": route_class,
             "servedModelCanonical": served}
        if meta.get("trace_id"):
            c["traceId"] = meta["trace_id"]               # correlation only: not an id, key or credential
        if meta.get("logical_request_id"):
            c["logicalRequestId"] = meta["logical_request_id"]
        for k in ("workflow", "agent_run"):
            if k in tags:
                c[{"workflow": "workflow", "agent_run": "agentRun"}[k]] = tags[k]
        corr.append(c)
        # rate-card valuation as a linked ai-financial-record/1 (never part of the usage event)
        if qty and provider in PRICES:
            missing = [k for k in qty if (provider, served, k) not in inp.price]
            if missing:
                counters["unpricedEvents"] += 1
            else:
                card = inp.price[(provider, served, next(iter(qty)))][0]
                amount = sum((Decimal(n) * contract_decimal(inp.price[(provider, served, k)][1]["price"], "price")
                              / Decimal(1_000_000) for k, n in qty.items()), Decimal(0))
                day = occurred[:10]
                valuations.append({
                    "schemaVersion": "ai-financial-record/1", "recordId": "fin-est-" + short_id(ev["eventId"]),
                    "tenantId": ev["tenantId"], "sourceConnectionId": ev["sourceConnectionId"],
                    "kind": "estimated_invocation", "amount": canonical(amount), "currency": card["currency"],
                    "periodStart": day, "periodEnd": next_day(day), "provider": provider,
                    "providerAccount": conn["providerAccounts"][provider], "model": served,
                    "rateBasis": card["basis"],
                    "rateCardRef": {"rateCardId": card["rateCardId"], "version": card["version"]},
                    "linkedUsageEventIds": [ev["eventId"]], "evidenceRef": f"valuation:rate-card:{ev['eventId']}",
                    **({"workloadId": ev["workloadId"]} if "workloadId" in ev else {})})
        if r.get("spend") is not None:
            amt, rep = source_decimal(r["spend"], "spend")
            src_est.append({"schemaVersion": "ratio.source-estimate/0-draft", "eventId": ev["eventId"],
                            "source": "gateway", "amount": canonical(amt),
                            "currency": conn["gatewayEstimateCurrency"], "sourceRepresentation": rep,
                            "note": "never summed with billed, effective or valuation amounts"})
    return {"events": events, "valuations": valuations, "sourceEstimates": src_est, "correlation": corr,
            "quarantine": quarantine, "counters": dict(counters), "billable": billable, "tags": tags_by_event}


def focus_financial_records(inp: Inputs) -> List[Dict[str, Any]]:
    out = []
    for i, row in enumerate(inp.focus):
        day0 = row["ChargePeriodStart"][:10]
        end = parse_ts(row["ChargePeriodEnd"])
        day1 = end.strftime("%Y-%m-%d") if end.time() == datetime.min.time() and end.strftime("%Y-%m-%d") > day0 \
            else next_day(day0)
        for kind, col in (("billed", "BilledCost"), ("effective", "EffectiveCost")):
            amt, _ = source_decimal(row[col], col)
            rec = {"schemaVersion": "ai-financial-record/1", "recordId": f"fin-{kind}-" + short_id(str(i), row["SkuId"],
                                                                                                   row["ChargePeriodStart"]),
                   "tenantId": TENANT, "sourceConnectionId": "conn-focus-fixture", "kind": kind,
                   "amount": canonical(amt), "currency": row["BillingCurrency"], "periodStart": day0,
                   "periodEnd": day1, "provider": row["ServiceProviderName"], "providerAccount": row["SubAccountId"],
                   "sku": row["SkuId"], "rateBasis": "not_applicable",
                   "evidenceRef": f"fixture:focus_billing.csv:row-{i + 1}"}
            if row["SkuId"] in inp.sku:
                rec["model"] = inp.sku[row["SkuId"]][1]
            out.append(rec)
    return out


# ---------------------------------------------------------------------------
# GPU allocation: allocated capacity x duration
# ---------------------------------------------------------------------------
def gpu_claims(inp: Inputs) -> Tuple[Dict[Tuple[str, str], Dict[str, Fraction]], Dict[str, Any], List[str]]:
    """Return per (node, hour) GPU-seconds by owner, diagnostics and capacity violations."""
    own = inp.own
    per: Dict[Tuple[str, str], Dict[str, Fraction]] = defaultdict(lambda: defaultdict(Fraction))
    observed: Dict[Tuple[str, str], set] = defaultdict(set)
    claim_sum: Dict[Tuple[str, str, str], Fraction] = defaultdict(Fraction)
    inactive: Dict[str, Fraction] = defaultdict(Fraction)
    inactive_na: Dict[str, int] = defaultdict(int)
    violations: List[str] = []
    for s in inp.gpu:
        node, gpu, ts = s["Hostname"], s["gpu"], s["timestamp"]
        hour = iso(parse_ts(ts).replace(minute=0, second=0))
        observed[(node, hour)].add((ts, gpu))
        mode = s["sharingMode"]
        if mode == "none" or not s["pod"]:
            continue
        ref = f"{s['namespace']}/{s['pod']}"
        if mode == "exclusive":
            frac = parse_fraction(s["allocatedFraction"], ref)
            if frac != 1:
                violations.append(f"{node}/{gpu} {ts}: exclusive claim with fraction {frac}")
        elif mode == "mig":
            model = own["nodes"][node]["gpuModel"]
            prof = own["migProfiles"].get(model, {}).get(s["gpuInstance"])
            if prof is None:
                raise MappingError("GPU_FRACTION_INVALID", f"unknown MIG profile {s['gpuInstance']} on {model}")
            frac = parse_fraction(prof, "mig profile")
        elif mode == "time-sliced":
            cfg = own.get("deviceSharing", {}).get(node, {}).get(gpu)
            # without a replica config the device plugin's per-replica view (a full GPU) is all we have
            frac = Fraction(1, cfg["replicas"]) if cfg and cfg.get("mode") == "time-sliced" \
                else parse_fraction(s["allocatedFraction"], ref)
        else:
            raise MappingError("GPU_SHARING_MODE_UNKNOWN", mode)
        claim_sum[(node, gpu, ts)] += frac
        workload = own["podLabels"].get(ref)
        owner = f"workload:{workload}" if workload else f"missing-labels:{ref}"
        per[(node, hour)][owner] += frac * SAMPLE_INTERVAL_S
        if s["DCGM_FI_PROF_GR_ENGINE_ACTIVE"] and mode != "time-sliced":
            act = Fraction(s["DCGM_FI_PROF_GR_ENGINE_ACTIVE"])
            inactive[owner] += frac * SAMPLE_INTERVAL_S * (1 - act)
        else:
            inactive_na[owner] += 1
    for (node, gpu, ts), total in sorted(claim_sum.items()):
        if total > 1:
            violations.append(f"{node}/gpu{gpu} {ts}: claims sum to {frac_text(total)} of one GPU")
    for (node, hour), owners in per.items():
        cap = Fraction(own["nodes"][node]["gpus"] * 3600)
        obs = Fraction(len(observed[(node, hour)]) * SAMPLE_INTERVAL_S)
        claimed = sum(owners.values(), Fraction(0))
        if claimed <= obs:
            owners["unallocated:idle"] = obs - claimed
        owners["unallocated:no-telemetry"] = cap - obs
    diag = {"note": "diagnostic only: not a cost adjustment and not a shutdown recommendation",
            "reservedButInactiveGpuSeconds": {k: f"{float(v):.1f}" for k, v in sorted(inactive.items())},
            "engineActivityUnavailableSamples": dict(sorted(inactive_na.items()))}
    return per, diag, violations


REASON = {"unallocated:idle": "GPU_IDLE_CAPACITY", "unallocated:no-telemetry": "GPU_NO_TELEMETRY",
          "missing-labels": "MISSING_OWNERSHIP_LABELS", "shared-no-usage": "SHARED_CAPACITY_NO_USAGE"}


def allocate_gpu(inp: Inputs, per: Dict[Tuple[str, str], Dict[str, Fraction]], basis: str) -> Dict[str, Any]:
    col = {"effective": "EffectiveCost", "billed": "BilledCost"}[basis]
    hourly, days = [], defaultdict(lambda: {"source": Decimal(0), "shares": defaultdict(Decimal),
                                             "unalloc": Decimal(0), "reasons": set(), "currency": None})
    for row in inp.focus:
        if row["ServiceCategory"] != "Compute" or row["ResourceId"] not in inp.own["nodes"]:
            continue
        node, hour = row["ResourceId"], row["ChargePeriodStart"]
        amount, _ = source_decimal(row[col], col)
        weights = dict(per.get((node, hour)) or {"unallocated:no-telemetry": Fraction(1)})
        prec = precision_for([amount])
        parts = allocate_exact(amount, weights, prec)
        hourly.append({"resourceId": node, "chargePeriodStart": hour, "basis": basis, "currency": row["BillingCurrency"],
                       "sourceAmount": canonical(amount), "billedCost": row["BilledCost"],
                       "effectiveCost": row["EffectiveCost"], "precision": canonical(prec), "tieBreak": TIE_BREAK,
                       "gpuSeconds": {k: frac_text(v) for k, v in sorted(weights.items())},
                       "parts": {k: canonical(v) for k, v in sorted(parts.items())}})
        d = days[(node, hour[:10], row["BillingCurrency"])]
        d["source"] += amount
        d["currency"] = row["BillingCurrency"]
        for k, v in parts.items():
            if k.startswith("workload:"):
                d["shares"][k.split(":", 1)[1]] += v
            else:
                d["unalloc"] += v
                if v:
                    d["reasons"].add(REASON["missing-labels" if k.startswith("missing-labels:") else k])
    allocs = []
    for (node, day, ccy), d in sorted(days.items()):
        allocs.append({"schemaVersion": "allocation/1", "allocationId": "alloc-gpu-" + short_id(node, day, basis),
                       "tenantId": TENANT,
                       "methodology": {"ruleSetId": "gpu-allocated-capacity-seconds", "version": 1},
                       "periodStart": day, "periodEnd": next_day(day), "currency": ccy, "basis": basis,
                       "sourceAmount": canonical(d["source"]),
                       "shares": [{"targetKind": "workload", "targetRef": w, "amount": canonical(a),
                                   "ruleId": "gpu-allocated-capacity-seconds/1"} for w, a in sorted(d["shares"].items())],
                       "unallocated": canonical(d["unalloc"]), "unallocatedReasons": sorted(d["reasons"]),
                       "evidenceRef": f"fixture:focus_billing.csv:{node}:{day}"})
    return {"hourly": hourly, "allocations": allocs}


def allocate_shared(inp: Inputs, norm: Dict[str, Any], gpu: Dict[str, Any], weights_cfg: Dict[str, str]
                    ) -> Dict[str, Any]:
    own = inp.own
    shared = {w for w, v in own["workloads"].items() if v.get("shared")}
    win, wout = Fraction(weights_cfg["input"]), Fraction(weights_cfg["output"])
    tokens: Dict[Tuple[str, str], Dict[str, Fraction]] = defaultdict(lambda: defaultdict(Fraction))
    runs: Dict[Tuple[str, str], Dict[str, Fraction]] = defaultdict(lambda: defaultdict(Fraction))
    for ev in norm["events"]:
        wl = own["servedBy"].get(ev.get("modelServed", ""))
        if wl not in shared or "tokenUsage" not in ev or "workloadId" not in ev:
            continue
        hour = iso(parse_ts(ev["occurredAt"]).replace(minute=0, second=0))
        tu = ev["tokenUsage"]
        w = Fraction(int(tu.get("input", "0"))) * win + Fraction(int(tu.get("output", "0"))) * wout
        tokens[(wl, hour)][ev["workloadId"]] += w
        tags = norm["tags"][ev["eventId"]]
        runs[(wl, hour)][f"{ev['workloadId']}|{tags.get('workflow', 'unknown')}|{tags.get('agent_run', 'unknown')}"] += w
    days = defaultdict(lambda: {"source": Decimal(0), "shares": defaultdict(Decimal), "unalloc": Decimal(0)})
    run_est = []
    for h in gpu["hourly"]:
        for owner, amt_s in h["parts"].items():
            wl = owner.split(":", 1)[1] if owner.startswith("workload:") else None
            if wl not in shared:
                continue
            amt = contract_decimal(amt_s, "stage-1 share")
            prec = precision_for([amt])
            d = days[(wl, h["chargePeriodStart"][:10], h["currency"], h["basis"])]
            d["source"] += amt
            w = tokens.get((wl, h["chargePeriodStart"]))
            if not w:
                d["unalloc"] += amt
                continue
            for k, v in allocate_exact(amt, dict(w), prec).items():
                d["shares"][k] += v
            for k, v in sorted(allocate_exact(amt, dict(runs[(wl, h["chargePeriodStart"])]), prec).items()):
                workload, workflow, agent_run = k.split("|")
                run_est.append({"schemaVersion": "ratio.agent-run-cost-estimate/0-draft", "estimate": True,
                                "sharedWorkload": wl, "hour": h["chargePeriodStart"], "workloadId": workload,
                                "workflow": workflow, "agentRun": agent_run, "amount": canonical(v),
                                "currency": h["currency"], "basis": h["basis"],
                                "method": {"ruleSetId": "shared-inference-weighted-token-share", "version": 1,
                                           "weights": weights_cfg}})
    allocs, chain = [], []
    stage1 = {(a["periodStart"], a["currency"]): a for a in gpu["allocations"]}
    for (wl, day, ccy, basis), d in sorted(days.items()):
        aid = "alloc-shared-" + short_id(wl, day, basis)
        allocs.append({"schemaVersion": "allocation/1", "allocationId": aid, "tenantId": TENANT,
                       "methodology": {"ruleSetId": "shared-inference-weighted-token-share", "version": 1},
                       "periodStart": day, "periodEnd": next_day(day), "currency": ccy, "basis": basis,
                       "sourceAmount": canonical(d["source"]),
                       "shares": [{"targetKind": "workload", "targetRef": k, "amount": canonical(v),
                                   "ruleId": "shared-inference-weighted-token-share/1"}
                                  for k, v in sorted(d["shares"].items())],
                       "unallocated": canonical(d["unalloc"]),
                       "unallocatedReasons": ["SHARED_CAPACITY_NO_USAGE"] if d["unalloc"] else [],
                       "evidenceRef": f"allocation:stage-2:{wl}:{day}"})
        parent = stage1.get((day, ccy))
        chain.append({"schemaVersion": "ratio.allocation-chain/0-draft", "allocationId": aid,
                      "reallocates": {"allocationId": parent["allocationId"] if parent else None,
                                      "targetKind": "workload", "targetRef": wl},
                      "estimate": True, "weights": weights_cfg,
                      "note": "re-allocates a stage-1 share; never sum stage-1 and stage-2 shares"})
    return {"allocations": allocs, "chain": chain, "agentRunEstimates": run_est}


# ---------------------------------------------------------------------------
# Reconciliation (aggregate) and invoice check
# ---------------------------------------------------------------------------
def reconcile(inp: Inputs, norm: Dict[str, Any], as_of: Optional[str]) -> Dict[str, Any]:
    conn = inp.conn
    canon = inp.routes.get("servedModelCanonical", {})
    observed: Dict[Tuple, int] = defaultdict(int)
    excluded: Dict[Tuple, int] = defaultdict(int)
    unmapped = 0
    missing_usage: Dict[Tuple[str, str], int] = defaultdict(int)
    for ev in norm["events"]:
        prov = ev["provider"]
        if prov not in PRICES:
            continue
        served = canon.get(ev.get("modelServed", ""), ev.get("modelServed", ""))
        if "tokenUsage" not in ev:
            missing_usage[(prov, served)] += 1
            continue
        for cat, n in norm["billable"][ev["eventId"]].items():
            hit = inp.price.get((prov, served, cat))
            if hit is None:
                unmapped += 1
                continue
            card, entry = hit
            key = (conn["providerAccounts"][prov], prov, served, entry["sku"], cat, card["currency"],
                   ev["occurredAt"][:10])
            if as_of and ev["receivedAt"] > as_of:
                excluded[key] += 1
                continue
            observed[key] += n
    billed: Dict[Tuple, Tuple[int, Decimal]] = {}
    for row in inp.focus:
        if row["SkuId"] not in inp.sku:
            continue
        prov, model, cat = inp.sku[row["SkuId"]]
        key = (row["SubAccountId"], row["ServiceProviderName"], model, row["SkuId"], cat, row["BillingCurrency"],
               row["ChargePeriodStart"][:10])
        q = source_count(row["ConsumedQuantity"], "ConsumedQuantity") or 0
        c, _ = source_decimal(row["BilledCost"], "BilledCost")
        pq, pc = billed.get(key, (0, Decimal(0)))
        billed[key] = (pq + q, pc + c)
    rows = []
    for key in sorted(set(observed) | set(billed)):
        acct, prov, model, sku, cat, ccy, day = key
        bq, bc = billed.get(key, (0, Decimal(0)))
        oq = observed.get(key, 0)
        price = contract_decimal(inp.price[(prov, model, cat)][1]["price"], "price")
        if key not in billed:
            status, code, msg = "UNRESOLVED", "OBSERVED_WITHOUT_BILLING", MSG_OBSERVED_UNBILLED
        elif abs(Fraction(bq - oq)) <= RECON_TOLERANCE * bq:
            status, code, msg = "MATCHED", "", ""
        elif bq > oq:
            status, code, msg = "UNRESOLVED", "GATEWAY_COVERAGE_DISCREPANCY", MSG_BILLED_EXCEEDS
        else:
            status, code, msg = "UNRESOLVED", "OBSERVED_EXCEEDS_BILLED", MSG_OBSERVED_EXCEEDS
        rows.append({"providerAccount": acct, "provider": prov, "model": model, "sku": sku, "tokenCategory": cat,
                     "currency": ccy, "day": day, "billedQuantity": str(bq), "observedQuantity": str(oq),
                     "quantityDifference": str(bq - oq), "billedCost": canonical(bc),
                     "estimatedCostOfObserved": canonical((Decimal(oq) * price / Decimal(1_000_000))),
                     "status": status, "code": code, "message": msg,
                     "cause": "NOT_ESTABLISHED" if status != "MATCHED" else None,
                     "context": {"eventsReceivedAfterAsOf": excluded.get(key, 0),
                                 "eventsMissingUsageSameModel": missing_usage.get((prov, model), 0)}})
    cov: Dict[str, Dict[str, Decimal]] = defaultdict(lambda: {"billed": Decimal(0), "matched": Decimal(0)})
    for r in rows:
        b = Decimal(r["billedCost"])
        cov[r["currency"]]["billed"] += b
        if r["status"] == "MATCHED":
            cov[r["currency"]]["matched"] += b
    return {
        "asOf": as_of, "tolerance": f"{float(RECON_TOLERANCE) * 100:.0f}% of billed quantity",
        "aggregationKey": ["providerAccount", "provider", "model", "sku", "tokenCategory", "currency", "day"],
        "rows": rows, "candidateExplanations": CANDIDATE_EXPLANATIONS,
        "observedCategoriesWithoutSkuMapping": unmapped,
        "matchedBilledShareByCurrency": {
            c: {"billed": canonical(v["billed"]), "matched": canonical(v["matched"]),
                "share": canonical((v["matched"] / v["billed"]).quantize(Decimal("0.0001"))) if v["billed"] else "N/A"}
            for c, v in sorted(cov.items())},
        "note": ("Provider billing is the financial source of record. Missing usage is never reconstructed as "
                 "billing. The share above covers only the fixture's provider accounts; it is not a measure of "
                 "enterprise traffic protected."),
    }


def check_invoices(inp: Inputs) -> List[Dict[str, Any]]:
    sums: Dict[str, Money] = {}
    for row in inp.focus:
        m = Money(source_decimal(row["BilledCost"], "BilledCost")[0], row["BillingCurrency"])
        sums[row["InvoiceId"]] = sums[row["InvoiceId"]] + m if row["InvoiceId"] in sums else m
    out = []
    for inv, want in sorted(inp.invoices.items()):
        got = sums.get(inv)
        ok = got is not None and got.currency == want["currency"] and got.amount == Decimal(str(want["amount"]))
        out.append({"invoiceId": inv, "sumBilledCost": f"{canonical(got.amount)} {got.currency}" if got else "N/A",
                    "payable": f"{want['amount']} {want['currency']}", "status": "MATCHED" if ok else "MISMATCH",
                    "note": "tax handling (FOCUS 1.4) not modeled"})
    return out


def source_estimate_drift(norm: Dict[str, Any]) -> Dict[str, Any]:
    val = {v["linkedUsageEventIds"][0]: v for v in norm["valuations"]}
    groups: Dict[Tuple[str, str], List[Decimal]] = defaultdict(lambda: [Decimal(0), Decimal(0)])
    not_compared = 0
    for s in norm["sourceEstimates"]:
        v = val.get(s["eventId"])
        if v is None or v["currency"] != s["currency"]:
            not_compared += 1
            continue
        g = groups[(v["provider"], v["currency"])]
        g[0] += Decimal(s["amount"])
        g[1] += Decimal(v["amount"])
    rows = []
    for (prov, ccy), (src, ours) in sorted(groups.items()):
        rel = abs(Fraction(src - ours) / Fraction(ours)) if ours else Fraction(0)
        rows.append({"provider": prov, "currency": ccy, "sourceEstimate": canonical(src), "valuation": canonical(ours),
                     "relativeDifference": f"{float(rel):.4f}", "withinTolerance": rel <= DRIFT_TOLERANCE})
    return {"rows": rows, "notComparedCurrencyOrValuationMissing": not_compared}


# ---------------------------------------------------------------------------
# Metrics with bounded cardinality
# ---------------------------------------------------------------------------
LABEL_LIMITS = {"team": 50, "provider": 20, "model_served": 50, "token_type": 6}
LABEL_VALUE = re.compile(r"^[a-z0-9][a-z0-9._@-]{0,63}$")
MAX_SERIES = 2000
DENIED_LABELS = {"actor", "user", "request_id", "trace_id", "agent_run", "session", "email"}


def bounded_series(samples: List[Tuple[Dict[str, str], int]]) -> Tuple[Dict[Tuple, int], Dict[str, Any]]:
    labels_used = set()
    volume: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    clean = []
    for lab, n in samples:
        labels_used |= set(lab)
        lab = {k: ("unknown" if not v else v if LABEL_VALUE.match(v) else "invalid") for k, v in lab.items()}
        clean.append((lab, n))
        for k, v in lab.items():
            volume[k][v] += n
    keep = {k: {v for v, _ in sorted(vs.items(), key=lambda x: (-x[1], x[0]))[:LABEL_LIMITS.get(k, 0) - 1]}
            | {"unknown", "invalid"} for k, vs in volume.items()}
    overflow: Dict[str, int] = defaultdict(int)
    series: Dict[Tuple, int] = defaultdict(int)
    for lab, n in clean:
        out = []
        for k in sorted(lab):
            v = lab[k] if lab[k] in keep[k] else "other"
            if v == "other":
                overflow[k] += 1
            out.append((k, v))
        series[tuple(out)] += n
    info = {"deniedLabelsUsed": sorted(labels_used & DENIED_LABELS),
            "labelsOutsideLimits": sorted(labels_used - set(LABEL_LIMITS)),
            "overflowCollapsedToOther": dict(overflow), "series": len(series), "maxSeries": MAX_SERIES,
            "limits": LABEL_LIMITS}
    return series, info


def prom_textfile(inp: Inputs, norm: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    samples = []
    for ev in norm["events"]:
        team = inp.own["workloads"].get(ev.get("workloadId", ""), {}).get("team", "")
        qty = norm["billable"][ev["eventId"]]
        for cat, n in qty.items():
            samples.append(({"team": team, "provider": ev["provider"], "model_served": ev.get("modelServed", ""),
                             "token_type": cat}, n))
    series, info = bounded_series(samples)
    lines = ["# HELP ratio_ai_tokens_total Billable tokens by team/provider/model/category; categories are disjoint "
             "(input excludes cached input). Fixture data; display only, not a financial record.",
             "# TYPE ratio_ai_tokens_total counter"]
    for labs, n in sorted(series.items()):
        lines.append("ratio_ai_tokens_total{" + ",".join(f'{k}="{v}"' for k, v in labs) + f"}} {n}")
    return "\n".join(lines) + "\n", info


# ---------------------------------------------------------------------------
# OTLP payloads with canaries, for the runtime harness
# ---------------------------------------------------------------------------
def _a(k: str, v: Any) -> Dict[str, Any]:
    if isinstance(v, bool):
        return {"key": k, "value": {"boolValue": v}}
    if isinstance(v, int):
        return {"key": k, "value": {"intValue": str(v)}}
    if isinstance(v, dict):
        return {"key": k, "value": {"kvlistValue": {"values": [_a(kk, vv) for kk, vv in v.items()]}}}
    return {"key": k, "value": {"stringValue": str(v)}}


def usage_log_attributes(ev: Dict[str, Any]) -> List[Dict[str, Any]]:
    attrs = [_a("event.name", "ratio.ai_usage")]
    for k, v in ev.items():
        if k == "tokenUsage":
            attrs += [_a(f"ratio.usage.tokenUsage.{kk}", vv) for kk, vv in v.items()]
        else:
            attrs.append(_a(f"ratio.usage.{k}", v))
    return attrs


USAGE_LOG_KEYS = sorted({"event.name"} | {f"ratio.usage.{k}" for k in USAGE_KEYS - {"tokenUsage", "units"}}
                        | {f"ratio.usage.tokenUsage.{k}" for k in TOKEN_KEYS})


def collector_payloads(norm: Dict[str, Any], out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    resource_clean = {"attributes": [_a("service.name", "ratio-runtime-probe")]}
    resource_dirty = {"attributes": [_a("service.name", "ratio-runtime-probe"), _a("host.note", CANARY),
                                     _a("deployment.owner_email", CANARY_EMAIL)]}
    nanos = lambda ts: str(int(parse_ts(ts).timestamp()) * 1_000_000_000)  # noqa: E731
    records = []
    for i, ev in enumerate(norm["events"]):
        rec: Dict[str, Any] = {"timeUnixNano": nanos(ev["occurredAt"]), "attributes": usage_log_attributes(ev)}
        if i == 0:
            rec["body"] = {"stringValue": f"{CANARY} usage body must be cleared"}
            rec["attributes"] += [_a("ratio.debug.prompt", CANARY), _a("ratio.extra", {"content": CANARY})]
        records.append(rec)
    records.append({"timeUnixNano": nanos(norm["events"][0]["occurredAt"]),  # content event: must be dropped
                    "attributes": [_a("event.name", "gen_ai.user.message")], "body": {"stringValue": CANARY}})
    logs = {"resourceLogs": [{"resource": resource_dirty,
                              "scopeLogs": [{"scope": {"name": "ratio.usage"}, "logRecords": records}]}]}
    t0 = int(FIXTURE_DAY.timestamp()) * 1_000_000_000 + 10 * 3600 * 1_000_000_000

    def span(i: int, kind: str) -> Dict[str, Any]:
        tid = hashlib.sha256(f"trace-{kind}-{i}".encode()).hexdigest()[:32]
        dur = 6_000_000_000 if kind == "slow" else 400_000_000
        s = {"traceId": tid, "spanId": hashlib.sha256(f"span-{kind}-{i}".encode()).hexdigest()[:16],
             "name": "chat default-large", "kind": 3, "startTimeUnixNano": str(t0 + i * 1_000_000),
             "endTimeUnixNano": str(t0 + i * 1_000_000 + dur),
             "status": {"code": 2, "message": f"{CANARY} upstream echoed prompt"} if kind == "error" else {"code": 1},
             "attributes": [_a("gen_ai.operation.name", "chat"), _a("gen_ai.provider.name", "provider-a"),
                            _a("gen_ai.request.model", "default-large"), _a("gen_ai.response.model", "model-large"),
                            _a("gen_ai.usage.input_tokens", 1200), _a("gen_ai.usage.output_tokens", 150),
                            _a("ratio.workload_id", "triage-agent"), _a("ratio.team", "team-alpha"),
                            _a("gen_ai.input.messages", CANARY), _a("gen_ai.output.messages", CANARY),
                            _a("gen_ai.prompt.0.content", CANARY), _a("input.value", CANARY),
                            _a("user.email", CANARY_EMAIL), _a("ratio.nested", {"prompt": CANARY})],
             "events": [{"timeUnixNano": str(t0), "name": "gen_ai.content.prompt",
                         "attributes": [_a("gen_ai.prompt", CANARY)]},
                        {"timeUnixNano": str(t0), "name": "exception",
                         "attributes": [_a("exception.type", "UpstreamError"),
                                        _a("exception.message", f"{CANARY} {CANARY_EMAIL}"),
                                        _a("exception.stacktrace", CANARY)]}]}
        return s

    groups = {"error": 5, "slow": 5, "ok": 100}
    spans = {k: [span(i, k) for i in range(n)] for k, n in groups.items()}
    traces = {"resourceSpans": [{"resource": resource_dirty, "scopeSpans": [
        {"scope": {"name": "ratio.probe"}, "spans": [s for v in spans.values() for s in v]}]}]}
    metrics = {"resourceMetrics": [{"resource": resource_dirty, "scopeMetrics": [{"scope": {"name": "ratio.probe"},
               "metrics": [{"name": "ratio.fixture.probe", "gauge": {"dataPoints": [
                   {"timeUnixNano": str(t0), "asInt": "42",
                    "attributes": [_a("team", "team-alpha"), _a("note", CANARY)]}]}}]}]}]}
    (out / "usage_logs.otlp.json").write_text(json.dumps(logs))
    (out / "traces.otlp.json").write_text(json.dumps(traces))
    (out / "metrics.otlp.json").write_text(json.dumps(metrics))
    (out / "manifest.json").write_text(json.dumps({
        "kitVersion": KIT_VERSION, "canaries": [CANARY, CANARY_EMAIL],
        "usageEventIds": [e["eventId"] for e in norm["events"]],
        "traceIds": {k: [s["traceId"] for s in v] for k, v in spans.items()},
        "tracePolicy": {"error": "all kept", "slow": "all kept", "ok": "probabilistic 10 %"},
        "probeMetric": {"name": "ratio_fixture_probe", "labels": {"team": "team-alpha"}, "value": 42},
        "usageLogKeys": USAGE_LOG_KEYS,
        "mustSurvive": {"traces": ["gen_ai.usage.input_tokens", "gen_ai.response.model"],
                        "logs": ["ratio.usage.eventId", "ratio.usage.tokenUsage.input"]},
    }, indent=2, sort_keys=True) + "\n")


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
def scan_for_content(paths: List[Path], extra_text: str = "") -> List[str]:
    hits = []
    for p in paths:
        text = p.read_text(errors="replace")
        for needle in (CANARY, CANARY_EMAIL):
            if needle in text:
                hits.append(f"{p.name}: {needle}")
        m = EMAIL_RE.search(text)
        if m:
            hits.append(f"{p.name}: email-shaped value")
    for needle in (CANARY, CANARY_EMAIL):
        if needle in extra_text:
            hits.append(f"stdout: {needle}")
    return sorted(set(hits))


def jsonl(path: Path, rows: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")


def check(fixtures: Path, out: Path, pz: Pseudonymizer, basis: str = "effective",
          weights: Optional[Dict[str, str]] = None, as_of: Optional[str] = None) -> Dict[str, Any]:
    weights = weights or {"input": "1", "output": "1"}
    inp = Inputs(fixtures)
    as_of = as_of or inp.scenario.get("asOf")
    checks: Dict[str, Dict[str, str]] = {}

    def put(cid: str, status: str, code: str = "", detail: str = "") -> None:
        checks[cid] = {"status": status, "code": code, "detail": detail}

    missing = [f"row {i}" for i, r in enumerate(inp.focus)
               if any(not r.get(c) for c in ("BilledCost", "EffectiveCost", "BillingCurrency", "ChargePeriodStart",
                                             "ChargePeriodEnd", "ServiceCategory", "SkuId", "ConsumedQuantity",
                                             "InvoiceId", "ServiceProviderName", "SubAccountId"))]
    put("FOCUS_COLUMNS", "FAIL" if missing else "PASS", "FOCUS_COLUMNS_MISSING" if missing else "",
        f"{len(inp.focus)} rows; required-column subset only (use the FOCUS validator for conformance)")
    norm = normalize(inp, pz)
    fin = focus_financial_records(inp)
    rep: Dict[str, Any] = {"kitVersion": KIT_VERSION, "kitStatus": KIT_STATUS, "scenario": inp.scenario,
                           "quarantine": norm["quarantine"], "counters": norm["counters"]}
    try:
        per, diag, violations = gpu_claims(inp)
        put("GPU_CAPACITY", "FAIL" if violations else "PASS", "CAPACITY_OVERCLAIM" if violations else "",
            f"{len(violations)} GPU-interval(s) where claims exceed one GPU" if violations else
            "claims never exceed one physical GPU per interval (exclusive, MIG and time-sliced)")
    except MappingError as exc:
        per, diag, violations = {}, {}, [str(exc)]
        put("GPU_CAPACITY", "FAIL", exc.code, str(exc))
    gpu = shared = None
    if violations:
        put("GPU_ALLOCATION_EXACT", "SKIP", "BLOCKED_BY_CAPACITY_FAILURE", "allocation not computed")
    else:
        gpu = allocate_gpu(inp, per, basis)
        shared = allocate_shared(inp, norm, gpu, weights)
        exact = all(sum((Decimal(v) for v in h["parts"].values()), Decimal(0)) == Decimal(h["sourceAmount"])
                    for h in gpu["hourly"])
        put("GPU_ALLOCATION_EXACT", "PASS" if exact else "FAIL", "" if exact else "ALLOCATION_NOT_EXACT",
            f"{len(gpu['hourly'])} node-hours; parts sum exactly; precision and tie-break recorded")
    allocations = (gpu["allocations"] + shared["allocations"]) if gpu else []
    problems = [f"usage {e['eventId']}: {p}" for e in norm["events"] for p in v_usage_event(e)]
    problems += [f"financial {r['recordId']}: {p}" for r in norm["valuations"] + fin for p in v_financial(r)]
    problems += [f"allocation {a['allocationId']}: {p}" for a in allocations for p in v_allocation(a)]
    problems += [f"quarantine {q['requestId']}: {q['code']}" for q in norm["quarantine"]]
    put("CONTRACT_V1", "FAIL" if problems else "PASS", "CONTRACT_V1_INVALID" if problems else "",
        "; ".join(problems[:3]) or f"{len(norm['events'])} usage events, {len(norm['valuations']) + len(fin)} "
        f"financial records, {len(allocations)} allocations pass the v1 shape checks")
    multi = defaultdict(set)
    for c in norm["correlation"]:
        if "logicalRequestId" in c:
            multi[c["logicalRequestId"]].add(c["eventId"])
    retried = [k for k, v in multi.items() if len(v) > 1]
    put("ATTEMPTS", "PASS", "", f"{len(retried)} logical request(s) with more than one attempt, each a separate "
        f"event; {norm['counters'].get('attemptUnknown', 0)} event(s) have no logical-request grouping, so "
        "attempt is left unknown")
    classes: Dict[str, int] = defaultdict(int)
    for c in norm["correlation"]:
        classes[c["routeClass"]] += 1
    gap = classes.get("UNDECLARED_SERVED_MODEL", 0) + classes.get("UNMAPPED_ALIAS", 0)
    put("ROUTING", "WARN" if gap else "PASS", "ROUTE_MAPPING_GAP" if gap else "",
        f"route map {inp.routes['routeMapVersion']}: {dict(sorted(classes.items()))}; a mapping gap is not "
        "evidence of fallback or unauthorized routing")
    unpriced = norm["counters"].get("unpricedEvents", 0)
    put("PRICING", "WARN" if unpriced else "PASS", "UNPRICED_USAGE" if unpriced else "",
        f"{unpriced} event(s) with usage but no rate-card entry for the served model")
    recon = reconcile(inp, norm, as_of)
    codes = sorted({r["code"] for r in recon["rows"] if r["code"]})
    put("RECONCILIATION", "WARN" if codes else "PASS", "+".join(codes),
        "; ".join(sorted({r["message"] for r in recon["rows"] if r["message"]})) or
        "every billed aggregate matches observed gateway usage within tolerance")
    inv = check_invoices(inp)
    bad_inv = [i for i in inv if i["status"] != "MATCHED"]
    put("INVOICE_SUM", "FAIL" if bad_inv else "PASS", "INVOICE_MISMATCH" if bad_inv else "",
        f"{len(inv)} invoice(s): sum(BilledCost) per InvoiceId vs payable")
    drift = source_estimate_drift(norm)
    drifted = [r for r in drift["rows"] if not r["withinTolerance"]]
    put("SOURCE_ESTIMATE_DRIFT", "WARN" if drifted else "PASS", "SOURCE_ESTIMATE_DRIFT" if drifted else "",
        f"{len(drift['rows'])} provider/currency group(s) compared; "
        f"{drift['notComparedCurrencyOrValuationMissing']} estimate(s) not compared (currency differs or no valuation)")
    prom, card = prom_textfile(inp, norm)
    if card["deniedLabelsUsed"] or card["labelsOutsideLimits"] or card["series"] > MAX_SERIES:
        put("METRIC_CARDINALITY", "FAIL", "LABEL_POLICY_VIOLATION", json.dumps(card))
    elif card["overflowCollapsedToOther"]:
        put("METRIC_CARDINALITY", "WARN", "CARDINALITY_OVERFLOW", json.dumps(card["overflowCollapsedToOther"]))
    else:
        put("METRIC_CARDINALITY", "PASS", "", f"{card['series']} series within per-label limits {LABEL_LIMITS}")
    # write outputs, then scan every one of them (and the summary) for content
    if out.exists():
        shutil.rmtree(out)
    rec = out / "records"
    jsonl(rec / "usage_events.jsonl", norm["events"])
    jsonl(rec / "financial_records.jsonl", norm["valuations"] + fin)
    jsonl(rec / "allocations.jsonl", allocations)
    (rec / "rate_cards.json").write_text(json.dumps(inp.cards, indent=2, sort_keys=True) + "\n")
    prop = out / "proposals"
    jsonl(prop / "source_estimates.jsonl", norm["sourceEstimates"])
    jsonl(prop / "usage_correlation.jsonl", norm["correlation"])
    jsonl(prop / "reconciliation_links.jsonl", [
        {"schemaVersion": "ratio.reconciliation-link/0-draft", **{k: r[k] for k in (
            "providerAccount", "provider", "model", "sku", "tokenCategory", "currency", "day", "billedQuantity",
            "observedQuantity", "quantityDifference", "status", "code", "cause")}} for r in recon["rows"]])
    if shared:
        jsonl(prop / "allocation_chain.jsonl", shared["chain"])
        jsonl(prop / "agent_run_cost_estimates.jsonl", shared["agentRunEstimates"])
    (out / "ratio_ai.prom").write_text(prom)
    rep.update({"checks": checks, "reconciliation": recon, "invoices": inv, "sourceEstimateDrift": drift,
                "gpu": {"hourly": gpu["hourly"] if gpu else [], "diagnostics": diag, "capacityViolations": violations[:20]},
                "cardinality": card, "coverage": coverage(gpu, shared, recon, norm)})
    summary = summarize(rep)
    leaks = scan_for_content(sorted(p for p in out.rglob("*") if p.is_file()), summary)
    put("CONTENT_CANARIES", "FAIL" if leaks else "PASS", "CONTENT_LEAK" if leaks else "",
        "; ".join(leaks[:3]) or "no canary, prompt/response content or email-shaped value in any output")
    rep["checks"] = {k: checks[k] for k in CHECK_ORDER}
    (out / "report.json").write_text(json.dumps(rep, indent=2, sort_keys=True) + "\n")
    rep["_summary"] = summarize(rep)
    return rep


CHECK_ORDER = ["FOCUS_COLUMNS", "CONTRACT_V1", "CONTENT_CANARIES", "ATTEMPTS", "ROUTING", "PRICING", "GPU_CAPACITY",
               "GPU_ALLOCATION_EXACT", "RECONCILIATION", "INVOICE_SUM", "SOURCE_ESTIMATE_DRIFT", "METRIC_CARDINALITY"]


def coverage(gpu, shared, recon, norm) -> Dict[str, Any]:
    out: Dict[str, Any] = {"note": "synthetic fixture values; allocation and reconciliation coverage are separate"}
    if gpu:
        by: Dict[str, Dict[str, Decimal]] = defaultdict(lambda: defaultdict(Decimal))
        for h in gpu["hourly"]:
            for k, v in h["parts"].items():
                bucket = ("attributed" if k.startswith("workload:") else "missingLabels"
                          if k.startswith("missing-labels:") else k.split(":", 1)[1])
                by[h["currency"]][bucket] += Decimal(v)
                by[h["currency"]]["total"] += Decimal(v)
        for a in (shared or {}).get("allocations", []):
            u = Decimal(a["unallocated"])
            by[a["currency"]]["attributed"] -= u
            by[a["currency"]]["sharedNoUsage"] += u
        out["gpuAllocationByCurrency"] = {c: {**{k: canonical(v) for k, v in sorted(d.items())},
                                              "allocationCoverage": canonical((d["attributed"] / d["total"])
                                                                              .quantize(Decimal("0.0001")))}
                                          for c, d in by.items()}
    out["reconciliation"] = recon["matchedBilledShareByCurrency"]
    with_usage = sum(1 for e in norm["events"] if "tokenUsage" in e)
    out["usageTelemetry"] = {"events": len(norm["events"]), "withReportedUsage": with_usage,
                             "missingUsageShownAsNA": len(norm["events"]) - with_usage}
    return out


def summarize(rep: Dict[str, Any]) -> str:
    b = io.StringIO()
    p = lambda s="": b.write(s + "\n")  # noqa: E731
    p(f"== Ratio telemetry discovery kit {KIT_VERSION} ({KIT_STATUS}) ==")
    p(f"   scenario: {rep['scenario']['scenario']} - {rep['scenario']['about']}")
    for cid, c in rep["checks"].items():
        code = f" [{c['code']}]" if c["code"] else ""
        p(f"  {c['status']:4} {cid:22}{code} {c['detail']}")
    cov = rep.get("coverage", {})
    for c, d in cov.get("gpuAllocationByCurrency", {}).items():
        p(f"  GPU allocation coverage {c} (synthetic fixture): {d['allocationCoverage']}")
    for c, d in cov.get("reconciliation", {}).items():
        p(f"  Billed cost matched within tolerance {c}: {d['share']} (fixture provider accounts only)")
    for r in rep.get("reconciliation", {}).get("rows", []):
        if r["status"] != "MATCHED":
            p(f"    {r['code']}: {r['providerAccount']}/{r['model']}/{r['tokenCategory']} {r['day']} billed "
              f"{r['billedQuantity']} observed {r['observedQuantity']} (cause: not established)")
    return b.getvalue()


def compare_expected(rep: Dict[str, Any], expected: Dict[str, Any]) -> Tuple[List[str], str]:
    sc = rep["scenario"]["scenario"]
    want = expected["scenarios"].get(sc)
    if want is None:
        return [f"no expectation for scenario {sc}"], ""
    diffs = []
    for cid in CHECK_ORDER:
        got = rep["checks"][cid]
        w = want["checks"].get(cid, ["PASS", ""])
        if [got["status"], got["code"]] != w:
            diffs.append(f"{cid}: expected {w[0]} {w[1] or '-'}, got {got['status']} {got['code'] or '-'}")
    return diffs, want.get("message", "")


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
def self_test() -> int:
    results: List[Tuple[bool, str]] = []

    def expect(cond: bool, name: str) -> None:
        results.append((bool(cond), name))

    def raises(fn, code: str) -> bool:
        try:
            fn()
        except MappingError as exc:
            return exc.code == code
        return False

    rng = random.Random(7)
    ok = True
    for _ in range(300):
        total = Decimal(rng.randint(-10 ** 9, 10 ** 9)) * MIN_PRECISION
        w = {f"k{i}": Fraction(rng.randint(0, 10 ** 6), rng.randint(1, 7)) for i in range(rng.randint(1, 12))}
        if sum(w.values()) == 0:
            w["k0"] = Fraction(1)
        ok &= sum(allocate_exact(total, w, MIN_PRECISION).values(), Decimal(0)) == total
    expect(ok, "allocate_exact sums exactly (300 random cases, fractional weights, negatives)")
    tie = allocate_exact(Decimal("0.000002"), {"b": Fraction(1), "a": Fraction(1), "c": Fraction(1)}, MIN_PRECISION)
    expect(tie == {"a": Decimal("0.000001"), "b": Decimal("0.000001"), "c": Decimal("0")},
           "tie-break is deterministic (ascending key)")
    expect(raises(lambda: Money(Decimal(1), "USD") + Money(Decimal(1), "EUR"), "CROSS_CURRENCY"),
           "cross-currency addition refused")
    expect(raises(lambda: source_decimal(0.1, "x"), "SOURCE_NUMBER_LOSSY"), "binary float refused at the adapter")
    expect(raises(lambda: contract_decimal(0.1, "x"), "CONTRACT_DECIMAL_INVALID"),
           "only canonical strings enter the normalized contract")
    v = load_json_precise('{"spend": 0.1, "big": 12345678901234567890.123456789}')
    expect(source_decimal(v["spend"], "s")[0] == Decimal("0.1") and canonical(v["big"]) ==
           "12345678901234567890.123456789", "JSON numbers parse exactly (no binary rounding)")
    expect(raises(lambda: load_json_precise('{"x": NaN}'), "SOURCE_NUMBER_NONFINITE"), "NaN/Infinity refused")
    expect(canonical(Decimal("1.50E+2")) == "150" and canonical(Decimal("-0.000")) == "0",
           "exponent and negative-zero canonicalized")
    inc, dis = PROFILES["profiles"]["fixture-input-includes-cached/1"], PROFILES["profiles"]["fixture-disjoint/1"]
    expect(raises(lambda: billable_quantities({"input": 10, "cachedInput": 11}, inc), "CACHED_EXCEEDS_INPUT"),
           "cachedInput > input refused under an overlapping profile")
    expect(billable_quantities({"input": 100, "cachedInput": 40, "output": 5}, inc) ==
           {"input": 60, "cachedInput": 40, "output": 5}, "overlapping profile bills cached tokens once")
    expect(billable_quantities({"input": 100, "cachedInput": 40, "output": 5}, dis) ==
           {"input": 100, "cachedInput": 40, "output": 5}, "disjoint profile keeps categories additive")
    pz = fixture_pseudonymizer()
    r1 = pz.ref("t1", "iss", "alice")
    expect(RX["ps1"].match(r1) is not None and r1.startswith("ps1:fixture-k1:"), "actorRef is ps1:<keyId>:<64 hex>")
    expect(r1 != pz.ref("t2", "iss", "alice"), "pseudonyms are tenant-scoped")
    other = Pseudonymizer(hashlib.sha256(b"ratio-telemetry-kit/fixture-key-derivation/v1").digest(), "fixture-k2")
    expect(r1 != other.ref("t1", "iss", "alice"), "key rotation (new keyId) changes the pseudonym")
    many = [({"team": f"team-{i:03d}", "provider": "p", "model_served": "m", "token_type": "input"}, 1000 - i)
            for i in range(120)]
    ser, info = bounded_series(many)
    expect(info["series"] <= LABEL_LIMITS["team"] + 2 and info["overflowCollapsedToOther"].get("team", 0) > 0,
           "label overflow collapses to 'other' within limits")
    expect(bounded_series([({"user": "x"}, 1)])[1]["deniedLabelsUsed"] == ["user"], "denied labels detected")
    expect(v_usage_event({"schemaVersion": "ai-usage-event/1"}) != [], "v1 validator rejects incomplete events")

    expected_path = HERE / "expected-results.json"
    expected = json.loads(expected_path.read_text()) if expected_path.exists() else None
    expect(expected is not None, "expected-results.json present")
    with tempfile.TemporaryDirectory() as td:
        reports = {}
        for sc in SCENARIOS:
            base = Path(td) / sc
            generate(base / "fixtures", 42, sc)
            rep = check(base / "fixtures", base / "out", pz)
            reports[sc] = rep
            diffs, _ = compare_expected(rep, expected) if expected else (["no expectations"], "")
            expect(not diffs, f"scenario {sc}: exact expected outcome" + (f" ({'; '.join(diffs)})" if diffs else ""))
        src = (Path(td) / "bypass" / "fixtures" / "gateway_spend_logs.jsonl").read_text()
        expect(CANARY in src and CANARY_EMAIL in src and '"spend": 0.' in src,
               "fixtures carry canaries and JSON-number amounts (preconditions)")
        b = reports["bypass"]
        expect(len([e for e in b["reconciliation"]["rows"] if e["code"] == "GATEWAY_COVERAGE_DISCREPANCY"]) == 2
               and all(r["cause"] == "NOT_ESTABLISHED" for r in b["reconciliation"]["rows"] if r["code"]),
               "bypass: discrepancies reported with cause not established")
        d = reports["delay"]
        expect(any(r["context"]["eventsReceivedAfterAsOf"] > 0 for r in d["reconciliation"]["rows"]),
               "delay: late arrivals visible in discrepancy context")
        alloc = [json.loads(l) for l in (Path(td) / "bypass" / "out" / "records" / "allocations.jsonl")
                 .read_text().splitlines()]
        expect(all(not v_allocation(a) for a in alloc) and len(alloc) == 2, "allocation/1 records exact (stage 1 and 2)")
        stage1 = next(a for a in alloc if a["methodology"]["ruleSetId"] == "gpu-allocated-capacity-seconds")
        expect(set(stage1["unallocatedReasons"]) == {"GPU_IDLE_CAPACITY", "GPU_NO_TELEMETRY",
                                                     "MISSING_OWNERSHIP_LABELS"},
               "idle, no-telemetry and missing-labels stay explicit")
        h0 = b["gpu"]["hourly"][0]["gpuSeconds"]
        expect(h0.get("workload:eval-job") == "10800/7" and h0.get("workload:batch-summarizer") == "1800",
               "MIG (3/7) and time-sliced (1/2) claims use allocated capacity x duration")
        evs = [json.loads(l) for l in (Path(td) / "bypass" / "out" / "records" / "usage_events.jsonl")
               .read_text().splitlines()]
        expect(sum(1 for e in evs if "tokenUsage" not in e) == 2, "missing usage stays absent (N/A), never 0")
        expect(not any("@" in e.get("actorRef", "") for e in evs) and
               any(e["actorType"] == "service" for e in evs), "humans pseudonymized; services by registered id")
        corr = [json.loads(l) for l in (Path(td) / "bypass" / "out" / "proposals" / "usage_correlation.jsonl")
                .read_text().splitlines()]
        expect(sum(1 for c in corr if c["routeClass"] == "DECLARED_FALLBACK") == 1, "declared fallback classified")
        golden = HERE / "expected" / "bypass"
        if golden.exists():
            gen = Path(td) / "bypass" / "out"
            same = all((gen / rel).read_bytes() == (golden / rel).read_bytes() for rel in golden_files(golden))
            expect(same, "committed goldens match regeneration")
    cfg = HERE / "otel-collector.yaml"
    if cfg.exists():
        text = cfg.read_text()
        missing_keys = [k for k in USAGE_LOG_KEYS if f'"{k}"' not in text]
        expect(not missing_keys, f"collector log allowlist covers every usage attribute {missing_keys or ''}")
    n = len(results)
    if expected is not None:
        expect(expected.get("selfTestChecks") == n + 1, f"check count pinned in expected-results.json ({n + 1})")
    for good, name in results:
        print(f"  {'PASS' if good else 'FAIL'} {name}")
    fails = sum(1 for g, _ in results if not g)
    print(f"self-test: {'OK' if not fails else f'{fails} FAILURE(S)'} ({len(results)} checks)")
    return 1 if fails else 0


def golden_files(root: Path) -> List[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())


def load_pseudonymizer() -> Pseudonymizer:
    raw = os.environ.get("RATIO_PSEUDONYM_KEY_HEX")
    if raw:
        return Pseudonymizer(bytes.fromhex(raw), os.environ.get("RATIO_PSEUDONYM_KEY_ID", "local-k1"))
    print("note: RATIO_PSEUDONYM_KEY_HEX unset; using a random per-run key (key id 'ephemeral')", file=sys.stderr)
    return Pseudonymizer(os.urandom(32), "ephemeral")


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="generate a scenario's fixtures and check them")
    r.add_argument("--workdir", type=Path, default=Path("./ratio-telemetry-run"))
    r.add_argument("--scenario", choices=sorted(SCENARIOS), default="bypass")
    r.add_argument("--seed", type=int, default=42)
    r.add_argument("--gpu-basis", choices=["effective", "billed"], default="effective",
                   help="effective (EffectiveCost) for showback/chargeback; billed (BilledCost) for invoice tie-out")
    r.add_argument("--output-token-weight", default="1", help="stage-2 weight for output tokens; >1 is an estimate")
    r.add_argument("--expect", type=Path, default=HERE / "expected-results.json")
    r.add_argument("--no-expect", action="store_true")
    r.add_argument("--fixture-key", action="store_true", help="use the deterministic fixture key (goldens)")
    g = sub.add_parser("golden", help="regenerate committed golden records (bypass scenario, fixture key)")
    g.add_argument("--out", type=Path, default=HERE / "expected")
    sub.add_parser("self-test")
    sub.add_parser("scenarios")
    a = ap.parse_args(argv)
    if a.cmd == "self-test":
        return self_test()
    if a.cmd == "scenarios":
        for k, v in SCENARIOS.items():
            print(f"{k:20} {v['about']}")
        return 0
    if a.cmd == "golden":
        with tempfile.TemporaryDirectory() as td:
            generate(Path(td) / "fixtures", 42, "bypass")
            check(Path(td) / "fixtures", Path(td) / "out", fixture_pseudonymizer())
            dest = a.out / "bypass"
            if dest.exists():
                shutil.rmtree(dest)
            for sub_dir in ("records", "proposals"):
                shutil.copytree(Path(td) / "out" / sub_dir, dest / sub_dir)
            shutil.copy(Path(td) / "out" / "ratio_ai.prom", dest / "ratio_ai.prom")
        print(f"goldens written to {dest}")
        return 0
    fixtures, out = a.workdir / "fixtures", a.workdir / "out"
    generate(fixtures, a.seed, a.scenario)
    pz = fixture_pseudonymizer() if a.fixture_key else load_pseudonymizer()
    rep = check(fixtures, out, pz, a.gpu_basis, {"input": "1", "output": a.output_token_weight})
    norm = normalize(Inputs(fixtures), pz)
    collector_payloads(norm, a.workdir / "collector-canary-payloads")
    print(rep["_summary"], end="")
    print(f"  outputs: {out}  (collector canary payloads: {a.workdir / 'collector-canary-payloads'})")
    if a.no_expect or not a.expect.exists():
        print("  UNVERIFIED: no expectation file used")
        return 1 if any(c["status"] == "FAIL" for c in rep["checks"].values()) else 0
    diffs, message = compare_expected(rep, json.loads(a.expect.read_text()))
    if diffs:
        print("  UNEXPECTED OUTCOME (exact expectation not met):")
        for d in diffs:
            print(f"    {d}")
        return 3
    print(f"  EXPECTED OUTCOME MET. {message}".rstrip())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
