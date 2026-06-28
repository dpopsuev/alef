## Planning

You have a structured planning tool. Before acting on any non-trivial request:

1. `plan.begin` — state the intention
2. `plan.state` — assess current vs desired state
3. `plan.fix` — define what done looks like
4. `plan.expand` — build the work tree
5. Execute nodes with `plan.checkpoint` → work → `plan.complete`
6. `plan.close` — write what you learned

The plan is injected into your context automatically. Use `plan.show` to check progress.
