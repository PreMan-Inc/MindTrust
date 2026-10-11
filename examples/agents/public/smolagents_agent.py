"""Real smolagents ToolCallingAgent. No generated code or shell tool is exposed."""

from __future__ import annotations

from typing import ClassVar

import braintrust
from common import SYSTEM, RunEvidence, prompt
from smolagents import LiteLLMModel, OpenAIServerModel, Tool, ToolCallingAgent


def run(input, model_name, provider, variant="baseline"):
    evidence = RunEvidence(model_name, variant)

    class MetricsTool(Tool):
        name = "get_release_metrics"
        description = "Read measured requests, errors, and p95 latency for one service."
        inputs: ClassVar[dict] = {
            "service": {
                "type": "string",
                "description": "The synthetic service identifier",
            }
        }
        output_type = "object"

        def forward(self, service: str) -> dict:
            return evidence.call_tool(self.name, {"service": service})

    class PolicyTool(Tool):
        name = "get_release_policy"
        description = (
            "Read maximum error percentage and p95 latency allowed for a service."
        )
        inputs: ClassVar[dict] = {
            "service": {
                "type": "string",
                "description": "The synthetic service identifier",
            }
        }
        output_type = "object"

        def forward(self, service: str) -> dict:
            return evidence.call_tool(self.name, {"service": service})

    class ErrorRateTool(Tool):
        name = "calculate_error_rate"
        description = (
            "Calculate measured error_rate_pct from error count and request count."
        )
        inputs: ClassVar[dict] = {
            "errors": {"type": "integer", "description": "Measured error count"},
            "requests": {"type": "integer", "description": "Measured request count"},
        }
        output_type = "object"

        def forward(self, errors: int, requests: int) -> dict:
            return evidence.call_tool(
                self.name, {"errors": errors, "requests": requests}
            )

    Model = LiteLLMModel if provider == "anthropic" else OpenAIServerModel

    class TracedModel(Model):
        def generate(self, messages, **kwargs):
            evidence.begin_model()
            with braintrust.start_span(
                name="smolagents.model",
                type="llm",
                input={"message_count": len(messages)},
                metadata={"model": model_name, "provider": provider},
            ) as span:
                response = super().generate(messages, **kwargs)
                usage = response.token_usage
                if usage:
                    evidence.record_usage(usage.input_tokens, usage.output_tokens)
                    span.log(
                        metrics={
                            "prompt_tokens": usage.input_tokens,
                            "completion_tokens": usage.output_tokens,
                        }
                    )
                span.log(
                    output={
                        "content": response.content,
                        "tool_calls": [str(call) for call in response.tool_calls or []],
                    }
                )
                return response

    model_id = f"anthropic/{model_name}" if provider == "anthropic" else model_name
    options = {"max_tokens": 800}
    if provider == "anthropic":
        options.update({"timeout": 45, "num_retries": 0})
    else:
        options["client_kwargs"] = {"timeout": 45, "max_retries": 0}
    model = TracedModel(model_id=model_id, **options)
    agent = ToolCallingAgent(
        tools=[MetricsTool(), PolicyTool(), ErrorRateTool()],
        model=model,
        instructions=SYSTEM,
        max_steps=6,
        max_tool_threads=1,
        add_base_tools=False,
        verbosity_level=-1,
    )
    result = agent.run(prompt(input))
    return evidence.finish(result)
