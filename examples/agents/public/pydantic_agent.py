"""Real PydanticAI tools + typed output with per-request MindTrust spans."""

from __future__ import annotations

import asyncio

import braintrust
from common import SYSTEM, Decision, RunEvidence, prompt
from pydantic_ai import Agent
from pydantic_ai.usage import UsageLimits


def run(input, model_name, provider, variant="baseline"):
    return asyncio.run(run_async(input, model_name, provider, variant))


async def run_async(input, model_name, provider, variant="baseline"):
    evidence = RunEvidence(model_name, variant)
    if provider == "anthropic":
        from anthropic import AsyncAnthropic
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        client = AsyncAnthropic(max_retries=0, timeout=45)
        model_provider = AnthropicProvider(anthropic_client=client)
        Model = AnthropicModel
    else:
        from openai import AsyncOpenAI
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        client = AsyncOpenAI(max_retries=0, timeout=45)
        model_provider = OpenAIProvider(openai_client=client)
        Model = OpenAIChatModel

    class TracedModel(Model):
        async def request(self, messages, model_settings, model_request_parameters):
            evidence.begin_model()
            with braintrust.start_span(
                name="pydantic-ai.model",
                type="llm",
                input={"message_count": len(messages)},
                metadata={"model": model_name, "provider": provider},
            ) as span:
                response = await super().request(
                    messages, model_settings, model_request_parameters
                )
                evidence.record_usage(
                    response.usage.input_tokens, response.usage.output_tokens
                )
                # Preserve public message/tool results; exclude internal thinking parts.
                public_parts = [
                    part for part in response.parts if part.part_kind != "thinking"
                ]
                span.log(
                    output=[str(part) for part in public_parts],
                    metrics={
                        "prompt_tokens": response.usage.input_tokens,
                        "completion_tokens": response.usage.output_tokens,
                    },
                )
                return response

    agent = Agent(
        TracedModel(model_name, provider=model_provider),
        output_type=Decision,
        instructions=SYSTEM,
        retries=0,
        model_settings={"max_tokens": 800, "timeout": 45},
        tool_timeout=5,
    )

    @agent.tool_plain
    def get_release_metrics(service: str) -> dict:
        """Read measured requests, errors, and p95 latency for one service."""
        return evidence.call_tool("get_release_metrics", {"service": service})

    @agent.tool_plain
    def get_release_policy(service: str) -> dict:
        """Read maximum error percentage and p95 latency allowed for a service."""
        return evidence.call_tool("get_release_policy", {"service": service})

    @agent.tool_plain
    def calculate_error_rate(errors: int, requests: int) -> dict:
        """Calculate measured error_rate_pct from error count and request count."""
        return evidence.call_tool(
            "calculate_error_rate", {"errors": errors, "requests": requests}
        )

    try:
        result = await agent.run(
            prompt(input),
            usage_limits=UsageLimits(request_limit=6, tool_calls_limit=12),
        )
        return evidence.finish(result.output)
    finally:
        await client.close()
