# omp-huimem: OMP package and publication

Integration rechecked 2026-10-21 against the packaged OMP extension/loading/plugin-manager, compaction, session and environment documentation; the installed executable reports **18.11.0**. Earlier 2026-09-08 findings used source commit `1adcef9762b065c0cef15703fd3e78ecaaa52a3b`. Documentation review and runtime acceptance are separate evidence; see VALIDATION.md.

## Recommended distribution

Use a native OMP package at the root of the GitHub repository. Commit the compiled entry so consumers need no build lifecycle scripts:

```json
{
  "name": "omp-huimem",
  "version": "0.7.0",
  "type": "module",
  "files": ["dist", "skills", "starter", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"],
  "omp": { "extensions": ["./dist/index.js"] }
}
```

Manifest `omp` is used before legacy `pi`; the loader resolves declared extensions. This proposal needs no Claude/Codex plugin manifest. Conventional package `skills/` is separately discovered. [Official package plumbing](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md).

After publishing the repository and a matching tag:

```sh
omp plugin install github:Clientik/omp-huimem#v0.7.0
omp plugin list --json
omp plugin doctor
```

Restart OMP before validating tools and skills. Git sources and refs are accepted by `PluginManager.install`; it delegates dependency retrieval to Bun, validates extension registration, then records enabled runtime state. GitHub distribution does not require npm publication. If npm is desired later, choose an available npm name/account and remove `private: true`; publishing a GitHub repository alone never creates an npm package. [Manager implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/plugins/manager.ts).

## Scope and Windows

Native npm/git installation uses the user plugin root. CLI `--scope project` applies to marketplace installation, not native npm/git/local packages; do not advertise that flag for the command above. [CLI implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/cli/plugin-cli.ts).

`omp plugin link PATH` uses `fs.promises.symlink` in the user plugin root. Our previous Windows link test failed with EPERM. That does not establish failure of GitHub installation: the latter runs Bun install through a distinct path and still requires a real acceptance test. Do not alter Windows privileges or silently substitute project scope. The previous local bundle can also be loaded with the separately tested explicit extension path for development. [Manager link implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/plugins/manager.ts).

Marketplace distribution is an optional future route if native project-scoped installation becomes necessary; it adds a catalog, registry and cached-package links. It is unnecessary for the requested first GitHub release. [Official marketplace documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md).

## 0.7.0 integration decisions

- Factory load only registers tools, commands and hooks. No database, permissions file or
  profile directory is created during installer validation. Each factory owns its live handles;
  imported modules do not hold a shared mutable memory session.
- Schemas use injected `pi.zod`; tool execution keeps the native
  `(id, params, signal, onUpdate, ctx)` shape. Nullable unused page/task/hash fields allow
  strict provider schemas without inventing an address or target.
- `context` replaces only this extension's temporary custom block, not stored messages.
  Project and explicitly enabled scoped records share one bounded allocation.
- `ctx.agent.kind` is authoritative; older hosts lacking it retain the session-file fallback.
  Native custom/agent-attributed messages are not user evidence. `input` is not used as
  the sole capture source because print/programmatic inputs do not necessarily emit it.
- `session_start`, switch/branch/tree boundaries and shutdown close handles/reset transient
  state. Native session ID, not transcript filename, owns session scope. Resume keeps that ID.
- Compaction adds provenance guidance to native summarization and probes real storage;
  it does not replace the compactor or schedule a save loop at session_stop.
- `/huimem learn` intentionally sends an agent-attributed custom message to the main agent.
  Synthetic-only turns need explicit run initialization, not a fabricated user episode.
  `sendMessage` returns void; idle-only waiting races startup in print mode. An
  agent_start/agent_end gate first observes the triggered turn. Since 0.8.2 the command
  then calls public `ctx.waitForIdle()` outside event handlers to drain native recovery;
  the first agent_end is notification, not proof of settlement. Lifecycle reset and user
  interruption release their own cancellation promise. No timer/LLM worker or private
  runtime mutation is added.
  Notifications use `pi.logger`, not raw stdout.
- Personal permission resolves through public `getAgentDir()`, preserving OMP profiles and
  environment routing. The host-only module is loaded lazily because standalone core/tests
  have no coding-agent package; the build externalizes `@oh-my-pi/pi-coding-agent`.
  Embedders/tests may inject `agentDir`; the model cannot choose that root through a tool.
- Primary schema 2/table allowlist remains unchanged for 0.6.10 rollback. History FTS is
  a separate derived sidecar; personal/session bases do not mix into the project database.

Primary references: [extension authoring](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md),
[extension loading](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md),
[plugin installer](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md),
[compaction](https://github.com/can1357/oh-my-pi/blob/main/docs/compaction.md),
[environment routing](https://github.com/can1357/oh-my-pi/blob/main/docs/environment-variables.md).
Main-branch documentation may describe more than the installed host; actual source/bundle,
native command and same-model checks are recorded separately in VALIDATION.md.


## Existing skill redistribution

All three checked upstream repositories supply MIT licenses permitting redistribution with their copyright and permission notices retained. Full upstream license files are included unchanged in `licenses/`, with skill-to-upstream attribution in THIRD_PARTY_NOTICES.md:

- `superpowers.txt`: Jesse Vincent, 2025. [obra/superpowers LICENSE](https://github.com/obra/superpowers/blob/main/LICENSE).
- `skills.txt`: Matt Pocock, 2026. [mattpocock/skills LICENSE](https://github.com/mattpocock/skills/blob/main/LICENSE).
- `taste-skill.txt`: Leonxlnx, 2026. [Leonxlnx/taste-skill LICENSE](https://github.com/Leonxlnx/taste-skill/blob/main/LICENSE).

This verifies repository-level licenses, not a byte-for-byte audit of every copied skill or nested third-party asset.

## Pi compatibility boundary

The requested repository name is now `Clientik/omp-huimem`; that name does not establish compatibility. Current code must be described as OMP-only:

- Adapter uses OMP `pi.zod`; current upstream Pi documentation uses TypeBox tool parameters.
- `execute(id, params, signal, onUpdate, ctx)` matches the documented Pi signature, but that alone does not make the adapter portable.
- Pi documents `agent_end` / `agent_settled` and `session_shutdown`; our checkpoint warning uses OMP `session_stop`. No `session_stop` or `loadMode` entries were found in current Pi extension documentation.
- Core imports `bun:sqlite`; this cannot run unchanged in a standard Node-based Pi runtime.
- Pi packages use their own `pi` manifest, installation syntax and `.pi` discovery. Adding a second manifest pointing to the same OMP bundle would not resolve the schema/runtime issues.

These are source-level findings, not a Pi runtime test. A future Pi adapter can reuse the memory model but needs a portable database implementation or explicit Bun runtime support, schema/lifecycle mapping and its own end-to-end tests. [Pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md), [Pi packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
