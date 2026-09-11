<p align="center">
  <img src="docs/assets/huimem.png" alt="huimem" width="392">
</p>
<h1 align="center">omp-huimem</h1>
<p align="center">Project memory for oh-my-pi. Decisions, reasons, and the next step.</p>
<p align="center">
  <strong>English</strong> · <a href="docs/i18n/README.ru.md">Русский</a> · <a href="docs/i18n/README.zh-CN.md">简体中文</a>
</p>

Keep project knowledge across sessions without running another model. Current facts live in readable files; evidence and revision history live in local SQLite. One OMP extension, no memory server, embeddings service, or background LLM.

> **Preview v0.4.1 · Tested with OMP 18.1.5.** Upstream Pi is not supported. Memory makes project context easier to recover and inspect; it does not eliminate hallucinations.

## Why use it?

For developers working with an AI agent who want to stop explaining the same project in every session. Especially useful when a local model already uses the available compute.

- **Knowledge next to your code.** Read, edit, and version facts, decisions, and tasks with Git.
- **Evidence you can inspect.** Records require a checked quote from a message or file. Code supplies message IDs and file hashes.
- **Corrections with history.** Updates create another version of the same record instead of silently replacing its history.
- **Visible staleness.** Changed sources or core documents mark previous records `STALE` for review.
- **Bounded context.** The extension supplies a memory block of up to 8,000 characters. The agent can read full sources when needed.

## Install

You need [OMP](https://github.com/can1357/oh-my-pi) with a configured main model. Local models are supported.

**mnemopi is not required.** huimem uses its own local SQLite through OMP's runtime. Keep `memory.backend: off` from the starter; no separate memory service or model is needed.

**Development checkout:** commits now automatically publish `.memory/RECORDS.md`, a readable registry snapshot. `/huimem` shows its sync state; `/huimem sync` retries publication without another model call. `/huimem context` shows the last prepared memory block's size, hash and complete record IDs/versions; it does not prove the model used them. The diagnostic log retains at most 100 entries without copying fact text. These changes are not yet included in the tagged v0.4.1 release. Existing databases migrate to schema 2; back up `.memory` with OMP stopped before upgrading. Schema 1 plugin versions cannot open the migrated database.

```sh
omp plugin install github:Clientik/omp-huimem#v0.4.1
```

Installation is user-scoped, so the extension loads in every project you open with OMP. **Memory itself is opt-in per project:** without a `.memory/MEMORY.md` the extension stays inert — no database, no injected context, no notices — and `project_memory` answers `PROJECT_MEMORY_NOT_ENABLED`. Other repositories stay untouched, with no database file their `.gitignore` does not cover.

Copy the **contents of `starter/`** into a new project's root once, including hidden files. For an existing project, merge them with your current knowledge and configuration. Memory becomes active on your next message; restarting OMP is not required. Start `omp` in that root and run:

```text
/project-memory-status
```

Ask the agent to use the `initmem` skill to map the actual code. Define architecture rules for your project; the starter deliberately has none configured.

**Installation status:** installing from GitHub was tested end to end on Windows with OMP 18.1.5 — the plugin installed, registered, and ran across live sessions. Direct loading also works:

```sh
git clone --branch v0.4.1 https://github.com/Clientik/omp-huimem.git
# Run from your working project, using the cloned repository's absolute path:
omp --extension /absolute/path/omp-huimem/dist/index.js
```

On Windows, quote the path. With direct loading, copy `skills/` to the project's `.omp/skills` if desired. Do not also load an older `project-memory.ts` extension.

Native GitHub installation in OMP 18.1.5 is user-scoped; `--scope project` does not apply. Memory data stays in the current project's `.memory`. See the [user guide (Russian)](docs/GUIDE.md) for setup and troubleshooting.

`/huimem` shows the memory state of the current project and adjusts the recall budget and
the injected-context limit, stored in `.memory/settings.json`. `/huimem omp` lists the OMP
settings that affect memory; the plugin reports them and never rewrites that config.
`huimem` cannot be selected under `memory.backend`: that list is a closed enum in OMP and
there is no backend-registration API for extensions. It runs alongside any of them instead.

## Memory layers

| Location | Purpose |
| --- | --- |
| `.memory/MEMORY.md` | Current facts and constraints |
| `.memory/RECORDS.md` | Generated registry snapshot; do not edit or use as independent evidence (development checkout) |
| `.memory/adr/` | Decisions and their reasons |
| `.memory/todo.json` | Tasks and their state |
| `.memory/PROJECT.md` | Code map and working commands |
| `.memory/architecture.json` | Explicit, testable architecture restrictions |
| `.memory/DESIGN.md` | UI design agreements |
| `.memory/runtime/state.sqlite` | Episodes, evidence versions, and checkpoint summaries |
| `.omp/RULES.md` | Short hard requirements, re-attached near the current turn |
| `AGENTS.md` | Background and conventions, given once when the session opens |

A starter project has two support folders, `.memory` and `.omp`, plus root `AGENTS.md` and `.gitignore` files. Installed plugin code is separate from project data.

## A typical session

You say: “Use PostgreSQL because orders and payments need transactions.”

The extension captures the message. The agent updates the project facts and decision, then can commit evidence to the registry. In a new session, the extension supplies a short memory context so the agent can recover the choice and its reason.

When a decision changes, the agent updates the files and creates a new record version. A past quote does not make an old decision current: conflicting information must be checked against primary sources.

**Transcript capture is automatic; selecting and maintaining useful knowledge depends on the main model.** There is no second LLM process and no forced save loop at session end.

## Trade-offs

This is a small, inspectable memory system for one project. It offers checked evidence and local persistence without a separate extraction service. It has not been shown to outperform other memory systems in comparative benchmarks.

Search is lexical, not semantic. Architecture checks match configured strings, not full dependency graphs. Source quotes establish provenance, not truth. File changes and SQLite writes are not one transaction. Real compaction, crashes, concurrent sessions, and branch changes need more live testing.

The 8,000-character limit is not a token limit or a measured savings percentage. Memory still consumes main-model context. If you use a cloud model, the memory context sent to it reaches that provider.

Keep runtime SQLite out of Git. To back up history, stop active sessions and copy all of `.memory`, including existing WAL/SHM files. There is no automatic history cleanup.

## Documentation

Detailed user documentation is currently in Russian:

- [User guide](docs/GUIDE.md): setup, daily use, errors, backup, and disabling.
- [How the layers work](docs/LAYERS.md): diagram, authority, evidence, retrieval, and automation.
- [Approach comparison](docs/COMPARISON.md): strengths and trade-offs, with primary sources.
- [Validation](docs/VALIDATION.md): tested scenarios and remaining gaps.

Developer references in English: [publishing](docs/PUBLISHING.md) and [OMP sources](docs/OMP-SOURCES.md).

## Development and license

With Bun installed, `bun run build` produces the extension and `bun run check` runs tests plus package checks. One adapter contract runs against both source and bundle; see VALIDATION.md for current counts. No runtime npm dependencies are required; the built entry is committed.

All seven skills are retained. Code and bundled skills include [MIT license notices](THIRD_PARTY_NOTICES.md). `private` in package.json prevents accidental npm publication; GitHub distribution is supported.
