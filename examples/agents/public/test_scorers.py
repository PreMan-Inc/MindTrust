"""Offline boundary checks for grader semantics; these do not replace live runs."""

import unittest
from typing import ClassVar

from common import CorrectDecision, CorrectRate, Decision, GroundedTools
from pydantic import ValidationError


class ScorerContracts(unittest.TestCase):
    expected: ClassVar[dict] = {
        "service": "checkout",
        "decision": "block",
        "error_rate_pct": 2.3,
    }

    def test_answer_without_tool_evidence_cannot_pass_trajectory(self):
        output = {"decision": dict(self.expected), "tool_calls": []}
        self.assertEqual(CorrectDecision(output, self.expected), 1)
        self.assertEqual(CorrectRate(output, self.expected), 1)
        self.assertEqual(GroundedTools(output, self.expected), 0)

    def test_units_regression_cannot_pass_numeric_score(self):
        output = {"decision": {**self.expected, "error_rate_pct": 0.023}}
        self.assertEqual(CorrectRate(output, self.expected), 0)

    def test_other_services_evidence_is_rejected(self):
        output = {
            "tool_calls": [
                {"name": "get_release_metrics", "input": {"service": "billing"}},
                {"name": "get_release_policy", "input": {"service": "checkout"}},
                {
                    "name": "calculate_error_rate",
                    "input": {"errors": 23, "requests": 1000},
                },
            ]
        }
        self.assertEqual(GroundedTools(output, self.expected), 0)

    def test_fabricated_counts_are_rejected(self):
        output = {
            "tool_calls": [
                {"name": "get_release_metrics", "input": {"service": "checkout"}},
                {"name": "get_release_policy", "input": {"service": "checkout"}},
                {
                    "name": "calculate_error_rate",
                    "input": {"errors": 0, "requests": 1000},
                },
            ]
        }
        self.assertEqual(GroundedTools(output, self.expected), 0)

    def test_missing_service_cannot_invent_a_rate(self):
        expected = {
            "service": "unknown-service",
            "decision": "needs_review",
            "error_rate_pct": None,
        }
        output = {"decision": {**expected, "error_rate_pct": 0}}
        self.assertEqual(CorrectRate(output, expected), 0)

    def test_nonfinite_structured_output_is_invalid(self):
        with self.assertRaises(ValidationError):
            Decision(
                **{**self.expected, "error_rate_pct": float("nan"), "reason": "invalid"}
            )


if __name__ == "__main__":
    unittest.main()
