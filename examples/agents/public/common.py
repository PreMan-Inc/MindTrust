"""Synthetic release-readiness task and independent outcome/trajectory scorers."""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from typing import Any, Literal

import braintrust
from pydantic import BaseModel, ConfigDict

SYSTEM = """You are a release-readiness agent. Use get_release_metrics and get_release_policy for the requested service. For known services use calculate_error_rate on the measured errors and requests, then compare its returned error_rate_pct with the policy maximum (equality is allowed), and p95_ms with max_p95_ms. Treat tool results as authoritative; do not replace the calculator with mental arithmetic. Release only if both limits pass. If the service is not found, return needs_review with null rate and do not invent metrics. Return only a JSON object with service, decision (release, block or needs_review), error_rate_pct (number or null), and a short reason. No external actions are authorized."""

METRICS = {
    "checkout": {"requests": 1000, "errors": 23, "p95_ms": 210},
    "search": {"requests": 1000, "errors": 4, "p95_ms": 180},
    "billing": {"requests": 100, "errors": 3, "p95_ms": 240},
}
POLICIES = {
    "checkout": {"max_error_rate_pct": 1.0, "max_p95_ms": 300},
    "search": {"max_error_rate_pct": 1.0, "max_p95_ms": 300},
    "billing": {"max_error_rate_pct": 1.5, "max_p95_ms": 300},
}
# Hand-authored expectations. Never passed to the agent or derived from its tools.
CASES = [
    {
        "id": "checkout-error-budget",
        "input": {"service": "checkout"},
        "expected": {"service": "checkout", "decision": "block", "error_rate_pct": 2.3},
    },
    {
        "id": "search-healthy",
        "input": {"service": "search"},
        "expected": {"service": "search", "decision": "release", "error_rate_pct": 0.4},
    },
    {
        "id": "billing-custom-policy",
        "input": {"service": "billing"},
        "expected": {"service": "billing", "decision": "block", "error_rate_pct": 3.0},
    },
    {
        "id": "unknown-service",
        "input": {"service": "unknown-service"},
        "expected": {
            "service": "unknown-service",
            "decision": "needs_review",
            "error_rate_pct": None,
        },
    },
]


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    service: str
    decision: Literal["release", "block", "needs_review"]
    error_rate_pct: float | None
    reason: str


@dataclass
class RunEvidence:
    model: str
    variant: str = "baseline"
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    model_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    started: float = field(default_factory=time.perf_counter)
    parent: str = field(default_factory=lambda: braintrust.current_span().export())

    def begin_model(self):
        if self.model_calls >= 6:
            raise RuntimeError("Model request budget exhausted (6 requests)")
        self.model_calls += 1

    def record_usage(self, input_tokens: int, output_tokens: int):
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens

    def call_tool(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if len(self.tool_calls) >= 12:
            raise RuntimeError("Tool request budget exhausted (12 calls)")
        with braintrust.start_span(
            name=name, type="tool", input=args, parent=self.parent
        ) as span:
            if name == "get_release_metrics":
                service = args["service"]
                result = {
                    "service": service,
                    "found": service in METRICS,
                    **METRICS.get(service, {}),
                }
            elif name == "get_release_policy":
                service = args["service"]
                result = {
                    "service": service,
                    "found": service in POLICIES,
                    **POLICIES.get(service, {}),
                }
            elif name == "calculate_error_rate":
                errors, requests = args["errors"], args["requests"]
                if requests <= 0 or errors < 0 or errors > requests:
                    raise ValueError("Invalid synthetic metrics")
                multiplier = 1 if self.variant == "fraction-regression" else 100
                result = {"error_rate_pct": round(errors / requests * multiplier, 6)}
            else:
                raise ValueError("Unknown tool")
            self.tool_calls.append({"name": name, "input": args, "output": result})
            span.log(output=result)
            return result

    def finish(self, value: Any) -> dict[str, Any]:
        if isinstance(value, BaseModel):
            value = value.model_dump()
        if isinstance(value, str):
            value = value.strip()
            if value.startswith("```"):
                value = value.split("\n", 1)[1].rsplit("```", 1)[0]
            value = json.loads(value)
        decision = Decision.model_validate(value).model_dump()
        return {
            "decision": decision,
            "tool_calls": self.tool_calls,
            "model_calls": self.model_calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "duration_ms": round((time.perf_counter() - self.started) * 1000),
            "model": self.model,
            "variant": self.variant,
        }


def prompt(input: dict[str, Any]) -> str:
    return f"Evaluate release readiness for the synthetic service {input['service']}."


def CorrectDecision(output, expected):
    actual = (output or {}).get("decision", {})
    return float(
        actual.get("service") == expected["service"]
        and actual.get("decision") == expected["decision"]
    )


def CorrectRate(output, expected):
    actual = (output or {}).get("decision", {}).get("error_rate_pct")
    wanted = expected["error_rate_pct"]
    if wanted is None:
        return float(actual is None)
    return float(
        not isinstance(actual, bool)
        and isinstance(actual, (int, float))
        and math.isclose(actual, wanted, abs_tol=0.00001)
    )


def GroundedTools(output, expected):
    calls = (output or {}).get("tool_calls", [])
    names = {call["name"] for call in calls}
    if "get_release_metrics" not in names:
        return 0.0
    service_calls = [call for call in calls if "service" in call["input"]]
    if any(call["input"]["service"] != expected["service"] for call in service_calls):
        return 0.0
    if expected["error_rate_pct"] is None:
        return float("calculate_error_rate" not in names)
    if not {"get_release_policy", "calculate_error_rate"}.issubset(names):
        return 0.0
    metrics = METRICS[expected["service"]]
    calculators = [call for call in calls if call["name"] == "calculate_error_rate"]
    return float(
        all(
            call["input"]
            == {"errors": metrics["errors"], "requests": metrics["requests"]}
            for call in calculators
        )
    )
