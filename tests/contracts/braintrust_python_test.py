"""Real HTTP contracts with the pinned, unmodified official Python SDK.

Run from the repository root after npm ci and pip install -r tests/contracts/requirements.txt:
    python -m unittest discover -s tests/contracts -p '*_test.py' -v
No Braintrust account, external service, LLM, or real API key is used.
"""
import asyncio
import concurrent.futures
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import selectors
import unittest
from urllib.parse import urlsplit

import requests
import braintrust

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "synthetic-python-contract-key"


class OfficialPythonContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if importlib.metadata.version("braintrust") != "0.45.0":
            raise RuntimeError("Contracts require exactly braintrust==0.45.0")
        clean_env = {k: v for k, v in os.environ.items() if not k.startswith(("BRAINTRUST_", "MINDTRUST_", "OPENAI_", "ANTHROPIC_", "OTEL_"))}
        cls.server = subprocess.Popen(
            ["node", "--import", "tsx", "tests/contracts/server.ts"],
            cwd=ROOT, env=clean_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        with selectors.DefaultSelector() as ready:
            ready.register(cls.server.stdout, selectors.EVENT_READ)
            if not ready.select(timeout=15):
                cls.server.kill()
                cls.server.wait()
                raise RuntimeError("Local fixture did not start within 15 seconds")
        line = cls.server.stdout.readline()
        if not line:
            raise RuntimeError(cls.server.stderr.read())
        cls.base = json.loads(line)["url"]
        cls.network = []
        cls.original_request = requests.Session.request
        def local_only(session, method, url, *args, **kwargs):
            if urlsplit(url).netloc != urlsplit(cls.base).netloc:
                raise AssertionError("SDK attempted an external request: " + urlsplit(url).netloc)
            response = cls.original_request(session, method, url, *args, **kwargs)
            cls.network.append((method, urlsplit(url).path, response.status_code, response.text if response.status_code >= 400 else ""))
            return response
        requests.Session.request = local_only
        # Public configuration, not private SDK state or modified SDK source.
        os.environ["BRAINTRUST_API_URL"] = cls.base
        os.environ["BRAINTRUST_APP_URL"] = cls.base
        os.environ["BRAINTRUST_API_KEY"] = TOKEN
        os.environ["BRAINTRUST_ORG_NAME"] = "MindTrust"
        braintrust.login(app_url=cls.base, api_key=TOKEN, org_name="MindTrust", force_login=True)

    @classmethod
    def tearDownClass(cls):
        requests.Session.request = cls.original_request
        cls.server.terminate()
        try:
            cls.server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.server.kill()
            cls.server.wait()
        cls.server.stdout.close()
        cls.server.stderr.close()

    def api(self, path, body=None):
        response = requests.request("GET" if body is None else "POST", self.base + path,
                                    headers={"Authorization": "Bearer " + TOKEN}, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_official_logger_dataset_eval_and_export(self):
        logger = braintrust.init_logger(project="Python contracts", async_flush=False)
        @braintrust.traced(name="uppercase child")
        def child(value):
            return value.upper()
        def task_trace(value):
            with logger.start_span(name=value, input=value) as span:
                result = child(value)
                span.log(output=result)
                return span.id
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(task_trace, ["one", "two"]))
        with self.assertRaisesRegex(ValueError, "synthetic failure"):
            with logger.start_span(name="failure", input="fail"):
                raise ValueError("synthetic failure")
        logger.log_feedback(id=ids[0], scores={"human": 1}, comment="Synthetic review", metadata={"reviewer": "contract"})
        logger.flush()
        project_id = logger.project.id
        exported = self.api(f"/v1/project_logs/{project_id}/fetch")
        self.assertEqual(next(r for r in exported["events"] if r["id"] == ids[0])["scores"]["human"], 1)
        traces = self.api(f"/api/traces?projectId={project_id}")
        self.assertEqual(len(traces["items"]), 3)
        for root in [r for r in traces["items"] if r["name"] in ("one", "two")]:
            detail = self.api(f"/api/traces/{root['id']}")
            children = [s for s in detail["spans"] if s["name"] == "uppercase child"]
            self.assertEqual(len(children), 1)
            parent = next(s for s in detail["spans"] if s["name"] == root["name"])
            self.assertEqual(children[0]["parentId"], parent["id"])

        dataset = braintrust.init_dataset(project="Python contracts", name="fixtures")
        dataset.insert(id="a", input="a", expected="A", metadata={"nested": {"a": 1}}, tags=["initial"])
        dataset.insert(id="b", input="b", expected="B")
        dataset.insert(id="null", input=None, expected=None)
        dataset.flush()
        original_version = dataset.version
        original = list(dataset.fetch(batch_size=1))
        self.assertEqual(len(original), 3)
        dataset.update(id="a", metadata={"nested": {"b": 2}}, tags=["updated"])
        dataset.delete("null")
        dataset.flush()
        current = list(dataset.fetch(batch_size=1))
        self.assertEqual(len(current), 2)
        a = next(r for r in current if r["id"] == "a")
        self.assertEqual(a["metadata"], {"nested": {"a": 1, "b": 2}})
        self.assertEqual(a["tags"], ["initial", "updated"])
        pinned = braintrust.init_dataset(dataset_id=dataset.id, version=original_version)
        self.assertEqual(len(list(pinned)), 3)
        self.assertEqual(dataset.summarize().data_summary.total_records, 2)

        active = 0
        maximum_active = 0
        async def task(input):
            nonlocal active, maximum_active
            active += 1
            maximum_active = max(active, maximum_active)
            await asyncio.sleep(0.01)
            active -= 1
            return input.upper()
        def Exact(output, expected):
            return 1 if output == expected else 0
        result = braintrust.Eval("Python contracts", data=dataset, task=task, scores=[Exact],
                                 experiment_name="uppercase", max_concurrency=2)
        self.assertEqual(maximum_active, 2)
        self.assertEqual(result.summary.scores["Exact"].score, 1)
        experiments = self.api(f"/api/experiments?projectId={project_id}")
        experiment = next(e for e in experiments if e["name"] == "uppercase")
        self.assertEqual(experiment["executionSource"], "sdk-import")
        self.assertEqual(experiment["completedCases"], 2)
        self.assertEqual(experiment["status"], "completed")
        raw_eval = self.api(f"/v1/experiment/{experiment['id']}/fetch")
        self.assertTrue(any(r.get("output") == "A" for r in raw_eval["events"]))
        # Export/insert/fetch uses preserved row IDs and raw unknown columns.
        copy_dataset = braintrust.init_dataset(project="Python contracts", name="copy")
        raw = self.api(f"/v1/dataset/{dataset.id}/fetch")["events"]
        for row in raw:
            row.pop("dataset_id", None)
            row["source_xact_id"] = row.pop("_xact_id")
        self.api(f"/v1/dataset/{copy_dataset.id}/insert", {"events": raw})
        copied = self.api(f"/v1/dataset/{copy_dataset.id}/fetch")["events"]
        self.assertEqual([r["id"] for r in raw], [r["id"] for r in copied])
        self.assertEqual([r["source_xact_id"] for r in raw], [r["source_xact_id"] for r in copied])
        failures = [(m, p, s, body) for m, p, s, body in self.network if s >= 400]
        self.assertEqual(failures, [], "SDK errors must not be swallowed as a successful test")


if __name__ == "__main__":
    unittest.main()
