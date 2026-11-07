# dsh-plugin-future-session (English)

Reality/future session split for DeepSeek Harness (dsh): keep the reality session's context clean — every tool call transparently forks a context-inheriting "future session" (a plugin-held mirror session) that does the heavy work and decides itself whether to return only the conclusion or merge its full process back into the reality session.

```
Normal flow: understand → search (raw results flood the context) → analyze →
             read local files (listings flood the context) → compare → answer
This plugin: understand → call a tool (session parks) → future session inherits
             the full context, searches + reads + digests → returns only the
             conclusion as that tool call's result → compare → answer
```

The reality session's context holds only "one tool call + one conclusion". The future session is forked directly through the core Agent factory (`ctx.agents.create`) — it does **not** go through the native subagent system (no `ctx.subagents`, no subagentCatalog/descriptor) — and inherits the reality session's completed-turn prefix. System prompt and tool surface are **identical in shape** on both sides, so the prefix cache stays hot end to end.

## How it works

1. A toggle (or `/future on`) marks the session as a **reality session**: every tool it can see is shadowed by a **same-name, same-description, same-parameters shadow tool** (scoped registration; indistinguishable on the wire).
2. The model calls tools as usual. The shadow tool does no real work — the plugin's `FutureSessionRuntime` forks a mirror session in the background via the core Agent factory and awaits it. The reality session parks on that single call (naturally serial; no concurrency).
3. The future session (cache-hit prefix inherited) freely uses real tools to finish the delegated call.
4. **The future session decides how to close out**:
   - intermediates are worthless (file listings, noise) → `future_return(summary[, raw])`: the conclusion becomes the tool result in the reality session (tagged `[future-session]`); an optional `raw` attachment can be fetched later with `future_fetch` without re-executing anything;
   - the process matters later (≥3 tool calls, structured detail, or user interaction needed) → `future_promote(report)`: the future session's full process (narrative + calls + results) is **merged into the reality session's context**; the reality session is not sealed and keeps running (0.5.0 semantics).
5. **Identity is not declared by diverging prompts** (that would break caching): both sides see the same protocol section and the same tool names. The model self-detects from tool results — raw data means it is the future session; a `[future-session]`-tagged conclusion means it is the reality session.
6. Safety net: the reality session may call `future_peek(sessionId)` for a step-by-step summary of a future session (the prompt says: avoid if possible). It shares the `/transcript` data pipeline (registration check → live snapshot / persisted file → only events after the fork point) and only accepts future sessions registered by this plugin. `future_fetch(sessionId)` retrieves raw output attached via `future_return`.

Interactive tools (`ask_user_question` / `ask_user_choice`) are **not** shadowed — they always run locally in the reality session. Inside a future session they become **relays**: the question surfaces as a card in the reality session's tool row; the user's answer wakes the future session in place.

### Collapsible panel (client UI)

The user interface always stays in the reality session. Each delegated tool call renders an inline collapsible panel that polls the future session's step-by-step transcript while running, then collapses to a one-line summary. Relay questions render as clickable cards inside the panel. While running, the child session id is resolved via the `GET /calls` fallback index (omitting `sessionId` returns a global union — the core keyed toolview owner carries no session identity), so the panel appears during the whole run (0.5.2). After the call settles, the panel folds into the core turn-process group (core layout design).

## Host routes (client data plane, loopback-only)

| Route | Purpose |
|---|---|
| `GET /mode?sessionId=` · `PUT /mode` | Mode read / switch (slider toggle) |
| `GET /tools[?sessionId=]` | Shadow tool name catalog (keyed client views) |
| `GET /calls[?sessionId=]` | `callId → future session id` index (fallback; omitting `sessionId` returns a global union, tail-capped at 2000) |
| `GET /transcript?sessionId=&limit=` | Future session transcript (**only sessions registered by this plugin**) |
| `POST /answer` | Relay-question answer submission |

## Install

```powershell
git clone https://github.com/Pasumao/dsh-plugin-future-session.git
node <dsh>/lib/bin.js plugin --profile <profile> add <clone-dir>\dsh-plugin-future-session
```

Or install from npm and mount it:

```powershell
npm install dsh-plugin-future-session
node <dsh>/lib/bin.js plugin --profile <profile> add <profile>\node_modules\dsh-plugin-future-session
```

Restart the Desktop client afterwards (the startup log must not contain `skipping profile bundle "dsh-plugin-future-session"`).

## Usage

Slider toggle next to the chat input (recommended), or:

```
/future on      # reality mode, summary returns (all tools delegated to future sessions)
/future raw     # verbatim merge mode (no summaries; all calls/results flow back as-is)
/future off     # leave; tools execute locally again
/future status  # current mode + accumulated future sessions
```

Config:

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `protocolSection` | `true` | Inject the shared protocol section |
| `maxDepth` | `1` | Delegation depth cap (no recursive forks) |

## Design boundaries

- **Identical shape**: shadow tools, real tools, and the shared protocol section are byte-identical across reality/future. Identity is judged only from results. Never fork the prompt per session.
- **Serial parking**: the reality session waits as a whole during one delegation.
- **Promotion = merge** (0.5.0): `future_promote` merges the process into the reality context; nothing is sealed or destroyed.
- **Policy inheritance**: forked future sessions pin the approval policy to `never` (delegation semantics) — with the host in "ask" approval mode, tool calls inside future sessions do **not** prompt; core policy/sandbox layers still apply.
- Persistence: `$DSH_HOME/dsh-plugin-future-session.json` (UTF-8 no BOM, atomic writes).

## Self-check

```powershell
npm run selfcheck
```

## Related plugins

| Plugin | Links |
|---|---|
| dsh-notify | [GitHub repo](https://github.com/Pasumao/dsh-plugin-notify) · [npm](https://www.npmjs.com/package/dsh-notify) |
| dsh-plugin-image-tools | [GitHub repo](https://github.com/Pasumao/dsh-plugin-image-tools) · [npm](https://www.npmjs.com/package/dsh-plugin-image-tools) |
| dsh-plugin-table-zoom | [GitHub repo](https://github.com/Pasumao/dsh-plugin-table-zoom) · [npm](https://www.npmjs.com/package/dsh-plugin-table-zoom) |
| dsh-plugin-windows-guard | [GitHub repo](https://github.com/Pasumao/dsh-plugin-windows-guard) · [npm](https://www.npmjs.com/package/dsh-plugin-windows-guard) |
| dsh-plugin-context-trim | [GitHub repo](https://github.com/Pasumao/dsh-plugin-context-trim) · [npm](https://www.npmjs.com/package/dsh-plugin-context-trim) |
| dsh-plugin-dev-kb | [GitHub repo](https://github.com/Pasumao/dsh-plugin-dev-kb) · [npm](https://www.npmjs.com/package/dsh-plugin-dev-kb) |

## License

MIT
