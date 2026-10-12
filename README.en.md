# dsh-plugin-future-session

Reality/future session split for DeepSeek Harness (dsh): keep the reality session's context clean — every tool call transparently forks a context-inheriting "future session" that does the heavy work and decides itself whether to return only the conclusion or promote itself to become the new reality.

```
Normal flow: understand → search (raw results flood the context) → analyze →
             read local files (listings flood the context) → compare → answer
This plugin: understand → call a tool (session parks) → future session inherits
             the full context, searches + reads + digests → returns only the
             conclusion as that tool call's result → compare → answer
```

The reality session's context holds only "one tool call + one conclusion". The future session is spawned through the native subagent **fork provider** and inherits the reality session's completed-turn prefix — system prompt and tool surface are **identical in shape**, so the prefix cache stays hot end to end.

## How it works

1. `/future on` marks the session as a **reality session**: every tool it can see is shadowed by a **same-name, same-description, same-parameters shadow tool** (scoped registration; indistinguishable on the wire).
2. The model calls tools as usual. The shadow tool does no real work — it starts a future session via `ctx.subagents.start('fork', …)` and awaits the result. The reality session parks on that single call (naturally serial; no concurrency).
3. The future session (cache-hit prefix inherited) freely uses real tools to finish the whole phase.
4. **The future session decides how to close out**:
   - intermediates are worthless (file listings, noise) → `future_return(summary)`: the conclusion becomes the tool result in the reality session (tagged `[future-session]`), future session sealed;
   - the process matters later → `future_promote(report)`: the future session promotes itself; the original reality session is sealed (open the child in the Desktop session list to continue).
5. **Identity is not declared by diverging prompts** (that would break caching): both sides see the same protocol section and the same tool names. The model self-detects from tool results — raw data means it is the future session; a `[future-session]`-tagged conclusion means it is the reality session.
6. Safety net: the reality session may call `future_peek(sessionId)` for a step-by-step summary of a future session (the prompt says: avoid if possible).

Future sessions are persisted child sessions in the `subagentCatalog` — the Desktop client renders them natively as expandable rows inside the parent transcript. Zero client-side code.

## Install

```powershell
node <dsh>/lib/bin.js plugin --profile <profile> add D:\dsh\plugins\dsh-plugin-future-session
```

Restart the Desktop client afterwards (the startup log must not contain `skipping profile bundle "dsh-plugin-future-session"`).

## Usage

```
/future on      # enter reality mode (all tools delegated to future sessions)
/future off     # leave; tools execute locally again
/future status  # current mode + accumulated future sessions
```

Config: `enabled` (default true), `protocolSection` (default true), `maxDepth` (default 1).

## Design boundaries

- **Identical shape**: shadow tools, real tools, and the shared protocol section are byte-identical across reality/future. Identity is judged only from results. Never fork the prompt per session.
- **Serial parking**: the reality session waits as a whole during one delegation.
- **Promotion never hard-deletes**: `future_promote` seals and registers; it does not destroy.
- Provider preference: `fork` (context inheritance), falling back to `spawn`.
- Persistence: `$DSH_HOME/dsh-plugin-future-session.json` (UTF-8 no BOM, atomic writes).

## Self-check

```powershell
npm run selfcheck
```

## License

MIT
