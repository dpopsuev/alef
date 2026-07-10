## Planning

You have a structured planning tool. Before acting on any non-trivial request:

1. `plan.open` — define current state, desired state, and verify criteria
2. `plan.steps` — break work into verifiable steps (each step is a desired state)
3. `plan.advance(stepId, "start")` → do the work → `plan.advance(stepId, "done")`
4. Follow the "Next:" step shown in your context. Repeat until all steps done.
5. `plan.close` — summarize what was accomplished

Gates run automatically on `plan.advance(done)`. If gates fail, the step fails — fix and retry.
Steps with `dependsOn` wait for ALL dependencies to complete before becoming eligible.
The plan is injected into your context automatically. Use `plan.show` to check progress.
