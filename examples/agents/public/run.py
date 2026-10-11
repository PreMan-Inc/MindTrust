"""Run bounded real public-framework agents into MindTrust via official Braintrust SDK.

All inputs, tools and expectations are synthetic. Provider credentials stay in the
child process; --env-file reads only the selected provider key, never executes it.
"""

from __future__ import annotations

import argparse
import atexit
import importlib
import importlib.metadata
import json
import os
import re
import sys
import time
from datetime import UTC, datetime, timedelta
from io import StringIO
from pathlib import Path
from urllib.parse import urlsplit

import braintrust
import requests
from braintrust.git_fields import GitMetadataSettings
from common import CASES, CorrectDecision, CorrectRate, GroundedTools
from dotenv import dotenv_values

HERE = Path(__file__).resolve().parent
FRAMEWORKS = {
    "langgraph": "langgraph_agent",
    "pydantic-ai": "pydantic_agent",
    "smolagents": "smolagents_agent",
}


def configuration(args, project_name):
    parsed = urlsplit(args.mindtrust_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("MINDTRUST_URL must be an http(s) URL")
    key_name = "ANTHROPIC_API_KEY" if args.provider == "anthropic" else "OPENAI_API_KEY"
    if args.env_file:
        selected = (
            {key_name, "CLUDE_API_KEY"} if args.provider == "anthropic" else {key_name}
        )
        lines = [
            line
            for line in args.env_file.read_text().splitlines()
            if re.match(
                r"^(?:export\s+)?(" + "|".join(selected) + r")\s*=", line.strip()
            )
        ]
        values = dotenv_values(stream=StringIO("\n".join(lines)))
        value = values.get(key_name)
        if not value and args.provider == "anthropic":
            value = values.get("CLUDE_API_KEY")  # explicit legacy PreMan variable
        if value:
            os.environ[key_name] = value
    if not os.environ.get(key_name):
        raise ValueError(
            f"Set {key_name} or supply --env-file; no model calls were made"
        )
    token = os.environ.get("MINDTRUST_API_KEY", "")
    if not token:
        if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("A remote MindTrust server requires MINDTRUST_API_KEY")
        response = requests.get(args.mindtrust_url + "/api/auth/status", timeout=10)
        response.raise_for_status()
        if response.json().get("enabled"):
            raise ValueError("Authenticated server requires MINDTRUST_API_KEY")
        response = requests.get(args.mindtrust_url + "/api/projects", timeout=10)
        response.raise_for_status()
        matches = [
            project for project in response.json() if project["name"] == project_name
        ]
        if len(matches) > 1:
            raise ValueError("Project name is ambiguous; choose a unique project name")
        if matches:
            project_id = matches[0]["id"]
        else:
            response = requests.post(
                args.mindtrust_url + "/api/projects",
                timeout=10,
                json={
                    "name": project_name,
                    "description": "Real public agent evaluations using synthetic read-only tools",
                },
            )
            response.raise_for_status()
            project_id = response.json()["id"]
        response = requests.post(
            args.mindtrust_url + "/api/keys",
            timeout=10,
            json={
                "name": "Temporary public agent eval runner",
                "role": "editor",
                "projectIds": [project_id],
                "expiresAt": (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
            },
        )
        response.raise_for_status()
        credential = response.json()
        token = credential["key"]

        def revoke():
            requests.delete(
                args.mindtrust_url + "/api/keys/" + credential["id"], timeout=10
            ).raise_for_status()

        atexit.register(revoke)
    os.environ.update(
        {
            "BRAINTRUST_API_URL": args.mindtrust_url,
            "BRAINTRUST_APP_URL": args.mindtrust_url,
            "BRAINTRUST_API_KEY": token,
            "BRAINTRUST_ORG_NAME": "MindTrust",
            "LANGCHAIN_TRACING_V2": "false",
            "LANGSMITH_TRACING": "false",
            "LITELLM_LOCAL_MODEL_COST_MAP": "True",
        }
    )
    # Protect the migration example from accidentally routing SDK logs to hosted Braintrust.
    original = requests.Session.request

    def same_destination(session, method, url, *a, **kw):
        if urlsplit(url).netloc != parsed.netloc:
            raise RuntimeError("Blocked non-MindTrust SDK HTTP destination")
        return original(session, method, url, *a, **kw)

    requests.Session.request = same_destination
    braintrust.login(
        app_url=args.mindtrust_url,
        api_key=token,
        org_name="MindTrust",
        force_login=True,
    )
    return token


def api(args, token, path):
    response = requests.get(
        args.mindtrust_url + path,
        headers={"Authorization": "Bearer " + token},
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def make_task(agent_run, model, provider, variant):
    def task(input):
        return agent_run(input, model, provider, variant)

    return task


def run(args):
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    project_name = args.project or f"Public agent evals · {stamp}"
    token = configuration(args, project_name)
    dataset = braintrust.init_dataset(
        project=project_name,
        name="release-readiness-v1",
        description="Four synthetic outcomes and tool-trajectory checks; real model inference.",
    )
    for case in CASES:
        dataset.insert(
            **case,
            metadata={"source": "MindTrust synthetic release task", "suite_version": 1},
        )
    dataset.flush()
    pinned = braintrust.init_dataset(dataset_id=dataset.id, version=dataset.version)
    project_id = dataset.project.id
    results = []
    frameworks = list(FRAMEWORKS) if args.framework == "all" else [args.framework]
    runs = [(framework, "baseline") for framework in frameworks]
    if args.control:
        runs.append((frameworks[0], "fraction-regression"))
    baseline_name = None
    run_error = False
    for framework, variant in runs:
        name = f"{framework}-{variant}-{stamp}"
        module = importlib.import_module(FRAMEWORKS[framework])

        task = make_task(module.run, args.model, args.provider, variant)

        print(f"Running {framework}/{variant} ({len(CASES)} cases)", flush=True)
        started = time.perf_counter()
        result = braintrust.Eval(
            project_name,
            data=pinned,
            task=task,
            scores=[CorrectDecision, CorrectRate, GroundedTools],
            experiment_name=name,
            base_experiment_name=baseline_name if variant != "baseline" else None,
            max_concurrency=1,
            timeout=300,
            git_metadata_settings=GitMetadataSettings(collect="none"),
            metadata={
                "framework": framework,
                "variant": variant,
                "model": args.model,
                "provider": args.provider,
                "real_model": True,
                "synthetic_tools": True,
                "dataset_version": dataset.version,
                "upstream": json.loads((HERE / "upstream.json").read_text())[framework],
            },
            description="Real model/tool agent run with synthetic read-only tools; control intentionally introduces a units bug.",
        )
        braintrust.flush()
        experiments = api(args, token, f"/api/experiments?projectId={project_id}")
        experiment = next(e for e in experiments if e["name"] == name)
        detail = api(args, token, f"/api/experiments/{experiment['id']}")
        raw = api(args, token, f"/v1/experiment/{experiment['id']}/fetch")["events"]
        cases = detail["cases"]
        # Round-trip persistence checks are part of the run, not just console success.
        if len(cases) != len(CASES):
            raise RuntimeError("MindTrust did not persist every evaluation case")
        llm_rows = [r for r in raw if r.get("span_attributes", {}).get("type") == "llm"]
        tool_rows = [
            r for r in raw if r.get("span_attributes", {}).get("type") == "tool"
        ]
        if not any(c.get("error") for c in cases) and (not llm_rows or not tool_rows):
            raise RuntimeError("MindTrust did not persist model/tool trace spans")
        errors = [c["error"] for c in cases if c.get("error")]
        scores = {key: value.score for key, value in result.summary.scores.items()}
        if not errors and scores != experiment["scores"]:
            raise RuntimeError(
                "SDK summary did not match MindTrust persisted scores; see SDK diagnostics"
            )
        output = {
            "framework": framework,
            "variant": variant,
            "experiment_id": experiment["id"],
            "experiment_name": name,
            "base_experiment_name": baseline_name if variant != "baseline" else None,
            "status": experiment["status"],
            "cases": len(cases),
            "errors": errors,
            "scores": scores,
            "llm_spans": len(llm_rows),
            "tool_spans": len(tool_rows),
            "input_tokens": sum(
                r.get("metrics", {}).get("prompt_tokens", 0) for r in llm_rows
            ),
            "output_tokens": sum(
                r.get("metrics", {}).get("completion_tokens", 0) for r in llm_rows
            ),
            "duration_seconds": round(time.perf_counter() - started, 3),
            "cost_usd": None,
            "outcomes": [
                {
                    "row_id": c["rowId"],
                    "decision": (c.get("output") or {}).get("decision"),
                    "scores": c["scores"],
                    "error": c.get("error"),
                }
                for c in cases
            ],
        }
        results.append(output)
        if errors or (
            variant == "baseline" and any(score != 1 for score in scores.values())
        ):
            run_error = True
        if variant == "fraction-regression" and scores.get("CorrectRate", 1) >= 1:
            raise RuntimeError("Regression control was not detected")
        if not baseline_name:
            baseline_name = name
        print(
            json.dumps(
                {k: v for k, v in output.items() if k != "outcomes"}, sort_keys=True
            ),
            flush=True,
        )
    report = {
        "executed_at": datetime.now(UTC).isoformat(),
        "project_name": project_name,
        "project_id": project_id,
        "dataset_id": dataset.id,
        "dataset_version": dataset.version,
        "model": args.model,
        "provider": args.provider,
        "real_model": True,
        "synthetic_tools": True,
        "cost_usd": None,
        "runs": results,
        "packages": {
            p: importlib.metadata.version(p)
            for p in (
                "braintrust",
                "langgraph",
                "langchain-anthropic",
                "pydantic-ai-slim",
                "smolagents",
                "litellm",
            )
        },
        "limits": {
            "max_model_requests_per_case": 6,
            "max_output_tokens_per_request": 800,
            "max_tool_calls_per_case": 12,
            "max_concurrency": 1,
        },
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Saved verified report: {args.report}", flush=True)
    return int(run_error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mindtrust-url",
        default=os.environ.get("MINDTRUST_URL", "http://127.0.0.1:4310"),
    )
    parser.add_argument(
        "--provider", choices=["anthropic", "openai"], default="anthropic"
    )
    parser.add_argument("--model", default="claude-haiku-5-5")
    parser.add_argument("--framework", choices=["all", *FRAMEWORKS], default="all")
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--project")
    parser.add_argument(
        "--control", action=argparse.BooleanOptionalAction, default=True
    )
    parser.add_argument("--report", type=Path, default=HERE / "latest-results.json")
    return run(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
