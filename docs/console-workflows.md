# MindTrust console workflows

The console uses the PreMan workbench layout: a fixed project sidebar, compact neutral panels, and a single page scroller. Overview shows one recent-activity table at a time; detailed guidance stays in expandable sections. **Cmd/Ctrl+K** opens a searchable menu of pages and accessible projects; use arrow keys and Enter, or click a result. Project selection is remembered for the current browser session and still checked against the signed-in user's accessible projects.

## Find the failing run

1. Open **Logs** and search names, inputs, outputs, tags, or metadata. Filter to errors or successful runs.
2. Sort by a column heading. Sorting applies to the complete filtered result before pagination, with missing metrics last. Use **View** for columns, density, and optional auto refresh. Compact rows are the default.
3. Select a run to open its inspector next to the table. Use focused view for additional room, or the narrow-screen inspector with its close/back control. Auto refresh is optional and polls every 10 seconds while the page is visible.
4. Inspect the span hierarchy and timing bars, search span names, collapse branches, or jump to a failed span. Inputs, outputs, metadata, review history, and dataset curation have dedicated tabs.
5. Add a trace or selected span to a dataset only after choosing its input source and entering the expected result. A removed span cannot silently become a root-trace example.

Span timing is based on recorded timestamps, including timezone offsets. Large trees and nested objects expand progressively. Token counts and costs reflect submitted telemetry; missing costs remain unknown.

## Compare a change

1. Open **Experiments**. Search/filter runs, then choose **Compare** or select a table row checkbox to choose the baseline and candidate.
2. Choose **Open comparison** and check paired coverage, revision alignment, and provenance warnings before interpreting the scores.
3. Filter all metrics or one metric for improvements, regressions, mixed changes, unchanged values, missing paired scores, or unmatched cases.
4. Open a case for side-by-side inputs, expectations, outputs, costs, timings, and score deltas. Trace links expose the underlying execution.

Score deltas are candidate minus baseline. A positive delta means the numeric score increased, not that the evaluation methodology itself is correct. Missing values are never silently treated as zero.

## Maintain ground truth

Open **Datasets**, select a dataset, and filter examples by content, tag, or whether an expected result is present. An explicit JSON `null` expectation is distinct from a missing expectation. Inspect examples in place, edit/import/export data, or browse **Version history**. Historical snapshots stay read-only. **Run experiment** starts from the latest selected dataset.

## Iterate on prompts

**Prompts** supports searching saved names, descriptions, models, and instructions, and retains immutable versions. Load a prompt into **Playground**, provide JSON input, and run a deterministic template or a configured model provider. Each result links back to its persisted trace. Provider modes remain unavailable until server credentials are configured.

## Current boundaries

This pass improves the implemented workflows; it does not add custom dashboards, SQL exploration, topic clustering, multi-model playground columns, or a Loop-style assistant. Authentication, role restrictions, SDK compatibility, and deployment limits remain documented in the main README and production runbook.
