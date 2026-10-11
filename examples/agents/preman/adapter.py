#!/usr/bin/env python3
"""Run the installed PreMan shared agent loop in a synthetic read-only workspace.

No PreMan implementation or system prompt is vendored. PREMAN_BACKEND_DIR must
point to an authorized checkout with its Python dependencies already installed.
The only external requests made by a case are its configured model calls.
"""
from __future__ import annotations

import asyncio
from contextlib import redirect_stdout
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
from io import StringIO
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def backend_imports():
    backend = Path(os.environ["PREMAN_BACKEND_DIR"]).expanduser().resolve()
    if not (backend / "flowtest/services/workbench/agent_loop.py").is_file():
        raise ValueError("PREMAN_BACKEND_DIR does not contain the PreMan workbench agent")
    sys.path.insert(0, str(backend))
    # Disable repository dotenv/database discovery before importing production code.
    os.environ["PREMAN_SKIP_DEV_DOTENV"] = "1"
    os.environ["IGNORE_DOTENV_DATABASE_URL"] = "1"
    os.environ["SKIP_DATABASE"] = "1"
    for name in ("DATABASE_URL", "POSTGRES_URL", "MCP_USE_DATABASE_URL"):
        os.environ.pop(name, None)
    with patch("dotenv.load_dotenv", return_value=False), redirect_stdout(sys.stderr):
        from flowtest.clients.llm import complete_turn, Turn, ToolResultBlock
        from flowtest.services.workbench import agent_loop, chat_tools, chat_service
    return backend, complete_turn, Turn, ToolResultBlock, agent_loop, chat_tools, chat_service


def provider_key(provider):
    name = "ANTHROPIC_API_KEY" if provider == "anthropic" else "OPENAI_API_KEY"
    key = os.environ.get(name)
    # This opt-in reads only the named credential; it never loads a whole env file.
    filename = os.environ.get("PREMAN_ENV_FILE")
    if not key and filename:
        from dotenv import dotenv_values
        selected_names = {name, "CLUDE_API_KEY"} if provider == "anthropic" else {name}
        selected = []
        for line in Path(filename).read_text().splitlines():
            match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=", line)
            if match and match[1] in selected_names:
                selected.append(line)
        values = dotenv_values(stream=StringIO("\n".join(selected)), interpolate=False)
        key = values.get(name)
        if provider == "anthropic" and not key:
            key = values.get("CLUDE_API_KEY")  # Existing PreMan local naming.
    if not key:
        raise ValueError(f"{name} is required (or set PREMAN_ENV_FILE explicitly)")
    return key


async def evaluate_case(payload):
    backend, complete_turn, Turn, ToolResultBlock, loop, chat_tools, chat_service = backend_imports()
    provider = os.environ.get("PREMAN_EVAL_PROVIDER", "anthropic")
    if provider not in {"anthropic", "openai"}:
        raise ValueError("This example supports anthropic or openai")
    model = os.environ.get("PREMAN_EVAL_MODEL", "claude-haiku-5-5" if provider == "anthropic" else "gpt-4.1-mini")
    key = provider_key(provider)
    case = payload["input"]
    prompt = str(case["prompt"])
    rows = deepcopy(case["workspace"]["requests"])
    latest = deepcopy(case["workspace"]["latestRuns"])
    spans, tool_calls, requested_tools = [], [], []
    variant = os.environ.get("PREMAN_EVAL_VARIANT", "baseline")
    if variant not in {"baseline", "corrupt-tool-result"}:
        raise ValueError("Unknown PREMAN_EVAL_VARIANT")
    system = chat_service._system_with_status(
        {"connected": False, "status": "disconnected", "agent_label": "Claude Code", "project_path": "synthetic-workspace"},
        len(rows),
    )
    ctx = chat_tools.ToolContext(
        user_id=0,
        workspace_id="mindtrust-synthetic-workspace",
        conversation_id="mindtrust-synthetic-conversation",
        link={"connected": False},
        surface="slack",
        user_message=prompt,
        saved_requests=tuple(rows),
    )
    turns = [Turn.user_text(prompt)]
    max_rounds = max(0, min(int(loop.MAX_TOOL_ROUNDS), 4))
    root_id = "preman-agent"
    root_start = timestamp()
    spans.append({
        "id": root_id, "name": "PreMan shared agent loop", "kind": "agent", "status": "ok",
        "startTime": root_start, "endTime": root_start, "input": {"prompt": prompt},
        "metadata": {"runtime": "production-shared-tool-loop", "workspace": "synthetic-read-only", "variant": variant, "maxToolRounds": max_rounds},
    })

    async def complete(**kwargs):
        start = timestamp()
        span_id = f"model-{sum(s['kind'] == 'llm' for s in spans) + 1}"
        span = {
            "id": span_id, "parentId": root_id, "name": "PreMan model turn", "kind": "llm", "status": "ok",
            "startTime": start, "endTime": start, "model": model,
            # Do not export proprietary prompts, raw provider responses or keys.
            "input": {"conversationTurns": len(kwargs["turns"]), "toolNames": [t.name for t in kwargs["tools"]]},
            "metadata": {"provider": provider, "systemPromptSha256": hashlib.sha256(system.encode()).hexdigest()},
        }
        spans.append(span)
        try:
            result = await complete_turn(**kwargs)
            requested_tools.extend(use.name for use in result.tool_uses)
            span.update({
                "output": {"text": result.text, "toolCalls": [{"name": u.name, "arguments": u.input} for u in result.tool_uses]},
                "inputTokens": result.usage.input_tokens,
                "outputTokens": result.usage.output_tokens,
                "model": result.model,
            })
            return result
        except Exception as error:
            span.update({"status": "error", "output": {"errorType": type(error).__name__}})
            raise
        finally:
            span["endTime"] = timestamp()

    async def list_requests(*_args, **_kwargs):
        return deepcopy(rows)

    async def latest_test_runs(*_args, **_kwargs):
        return deepcopy(latest)

    original_broker = loop.action_broker.execute_or_propose

    async def execute(name, args, context):
        start = timestamp()
        span = {
            "id": f"tool-{len(tool_calls) + 1}", "parentId": root_id,
            "name": name, "kind": "tool", "status": "ok", "startTime": start, "endTime": start,
            "input": args, "metadata": {"storage": "synthetic-in-memory"},
        }
        spans.append(span)
        try:
            if name not in {"list_endpoints", "preman_setup"}:
                outcome = chat_tools.ToolOutcome(result={"error": "Tool unavailable in this isolated evaluation workspace"})
                span["metadata"]["blockedByHarness"] = True
            else:
                # Keep PreMan's actual policy classification and tool handler.
                outcome = await original_broker(name, args, context)
                if variant == "corrupt-tool-result" and name == "list_endpoints":
                    outcome.result["endpoints"] = []
                    outcome.result["count"] = 0
                    outcome.result["matched_count"] = 0
                    span["metadata"]["negativeControlFault"] = "removed-matching-endpoints"
            span["output"] = outcome.result
            tool_calls.append({"name": name, "arguments": args, "result": outcome.result, "blocked": bool(span["metadata"].get("blockedByHarness"))})
            return outcome
        except Exception as error:
            span.update({"status": "error", "output": {"errorType": type(error).__name__}})
            raise
        finally:
            span["endTime"] = timestamp()

    error = None
    reply = ""
    try:
        with patch.object(chat_tools.workbench_db, "list_requests", list_requests), patch.object(chat_tools.workbench_db, "latest_test_runs", latest_test_runs), patch.object(loop.action_broker, "execute_or_propose", execute):
            reply, _artifacts = await asyncio.wait_for(loop.run_complete_tool_loop(
                provider=provider, api_key=key, model=model, system=system, turns=turns, ctx=ctx,
                allow_mutations=False, max_rounds=max_rounds, max_tokens=800, timeout=40, complete=complete,
            ), timeout=175)
    except Exception as cause:
        # Provider exceptions may contain sensitive URLs/body text. Persist type only.
        error = f"PreMan agent failed ({type(cause).__name__}); check provider credentials and local runtime"
        spans[0]["status"] = "error"
    tool_results = [json.loads(b.content) for turn in turns for b in turn.blocks if isinstance(b, ToolResultBlock)]
    output = {
        "reply": reply,
        "toolCalls": tool_calls,
        "requestedTools": requested_tools,
        "mutationBlocked": any("Only the Slack member" in str(r.get("error", "")) for r in tool_results),
        "modelCalls": sum(s["kind"] == "llm" for s in spans),
        "variant": variant,
        "execution": "real-model-production-loop-synthetic-workspace",
    }
    spans[0].update({"endTime": timestamp(), "output": output})
    try:
        revision = subprocess.run(["git", "-C", str(backend), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5, check=True).stdout.strip()
        spans[0]["metadata"]["backendRevision"] = revision
    except (OSError, subprocess.SubprocessError):
        pass
    return {"output": output, "spans": spans, **({"error": error} if error else {})}


def main():
    payload = json.load(sys.stdin)
    try:
        with redirect_stdout(sys.stderr):
            result = asyncio.run(evaluate_case(payload))
    except Exception as error:
        result = {"error": f"PreMan adapter initialization failed ({type(error).__name__}); verify configuration", "output": None}
    json.dump(result, sys.stdout, allow_nan=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
