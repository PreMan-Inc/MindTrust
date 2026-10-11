"""Real LangGraph StateGraph using a bounded model/tool loop, not a mock model.

Based on the public Graph API design documented by LangGraph; synthetic task is
MindTrust-authored. Upstream refs and licenses are recorded in upstream.json.
"""

from __future__ import annotations

import json
import operator
from typing import Annotated, TypedDict

import braintrust
from common import SYSTEM, RunEvidence, prompt
from langchain_core.messages import AnyMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph


class State(TypedDict):
    messages: Annotated[list[AnyMessage], operator.add]


def run(input, model_name, provider, variant="baseline"):
    evidence = RunEvidence(model_name, variant)

    @tool
    def get_release_metrics(service: str) -> dict:
        """Read measured requests, errors, and p95 latency for one service."""
        return evidence.call_tool("get_release_metrics", {"service": service})

    @tool
    def get_release_policy(service: str) -> dict:
        """Read maximum error percentage and p95 latency allowed for a service."""
        return evidence.call_tool("get_release_policy", {"service": service})

    @tool
    def calculate_error_rate(errors: int, requests: int) -> dict:
        """Calculate measured error_rate_pct from error count and request count."""
        return evidence.call_tool(
            "calculate_error_rate", {"errors": errors, "requests": requests}
        )

    tools = [get_release_metrics, get_release_policy, calculate_error_rate]
    by_name = {t.name: t for t in tools}
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        model = ChatAnthropic(
            model=model_name, max_tokens=800, timeout=45, max_retries=0
        )
    else:
        from langchain_openai import ChatOpenAI

        model = ChatOpenAI(
            model=model_name, temperature=0, max_tokens=800, timeout=45, max_retries=0
        )
    bound = model.bind_tools(tools)

    def llm(state):
        evidence.begin_model()
        with braintrust.start_span(
            name="langgraph.model",
            type="llm",
            input={"message_count": len(state["messages"])},
            metadata={"model": model_name, "provider": provider},
        ) as span:
            response = bound.invoke([SystemMessage(content=SYSTEM), *state["messages"]])
            usage = response.usage_metadata or {}
            input_tokens, output_tokens = (
                usage.get("input_tokens", 0),
                usage.get("output_tokens", 0),
            )
            evidence.record_usage(input_tokens, output_tokens)
            span.log(
                output={"tool_calls": response.tool_calls, "content": response.content},
                metrics={
                    "prompt_tokens": input_tokens,
                    "completion_tokens": output_tokens,
                },
            )
        return {"messages": [response]}

    def execute_tools(state):
        output = []
        for call in state["messages"][-1].tool_calls:
            result = by_name[call["name"]].invoke(call["args"])
            output.append(
                ToolMessage(content=json.dumps(result), tool_call_id=call["id"])
            )
        return {"messages": output}

    graph = StateGraph(State)
    graph.add_node("model", llm)
    graph.add_node("tools", execute_tools)
    graph.add_edge(START, "model")
    graph.add_conditional_edges(
        "model", lambda state: "tools" if state["messages"][-1].tool_calls else END
    )
    graph.add_edge("tools", "model")
    result = graph.compile().invoke(
        {"messages": [HumanMessage(content=prompt(input))]}, {"recursion_limit": 13}
    )
    content = result["messages"][-1].content
    if isinstance(content, list):
        content = "".join(
            block.get("text", "") for block in content if isinstance(block, dict)
        )
    return evidence.finish(content)
