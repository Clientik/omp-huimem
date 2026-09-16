<p align="center">
  <img src="docs/assets/huimem.png" alt="huimem" width="392">
</p>
<h1 align="center">omp-huimem</h1>
<p align="center">Project memory for oh-my-pi. Decisions, reasons, and the next step.</p>
<p align="center">
  <strong>English</strong> · <a href="docs/i18n/README.ru.md">Русский</a> · <a href="docs/i18n/README.zh-CN.md">简体中文</a>
</p>

Keep project knowledge across sessions without running another model. Current facts live in readable files; evidence and revision history live in local SQLite. One OMP extension, no memory server, embeddings service, or background LLM.

> **Preview v0.6.3 · Tested with OMP 18.1.5.** Upstream Pi is not supported. Memory makes project context easier to recover and inspect; it does not eliminate hallucinations.

## Why use it?

For developers working with an AI agent who want to stop explaining the same project in every session. Especially useful when a local model already uses the available compute.

- **Knowledge next to your code.** Read, edit, and version facts, decisions, and tasks with Git.
- **Evidence you can inspect.** Records require a checked quote from a message or file. Code supplies message IDs and file hashes.
- **Corrections with history.** Updates create another version of the same record instead of silently replacing its history.
- **Visible staleness.** Changed sources or core documents mark previous records `STALE` for review.
- **Bounded context.** The extension supplies a memory block of up to 8,000 characters. The agent can read full sources when needed.

## Install

**New in v0.6.3:** `/huimem doctor` reports stale or missing evidence, unavailable required records, ADRs without a basis section and task-file drift. It opens the existing database read-only and applies no repairs. See the [diagnostic guide](docs/GUIDE.md#doctor). Check results and the fixes that followed are in [validation](docs/VALIDATION.md).

You need [OMP](https://github.com/can1357/oh-my-pi) with a configured main model. Local models are supported.

**mnemopi is not required.** huimem uses its own local SQLite through OMP's runtime. `/huimem init` sets `memory.backend: off` for the project; no separate memory service or model is needed.

**Readable registry:** commits automatically publish `.memory/RECORDS.md`, a readable registry snapshot. `/huimem` shows its sync state; `/huimem sync` retries publication without another model call. `/huimem context` shows the last prepared memory block's size, hash and complete record IDs/versions; it does not prove the model used them. The diagnostic log retains at most 100 entries without copying fact text. Databases from v0.3.x or earlier migrate to schema 2; back up `.memory` with OMP stopped before upgrading. Schema 1 plugin versions cannot open the migrated database.

**Legacy ADRs:** `/huimem adr-audit` lists ADRs without a basis section that can be moved into the contract, and writes nothing. `/huimem adr-audit apply` inserts the user's quote from the registry as the basis and keeps every original line under an "Interpretation [?]" heading, after a byte-exact backup to `.memory/adr-backup/`. A document is migrated only when exactly one accepted decision names it by path, its rationale is an exact excerpt of the quote, and the quote is re-checked at migration time against the stored message, which must exist and belong to the user; otherwise it is reported as `UNVERIFIED` and nothing is written. v0.5.0 skipped that last check: if you ran `apply` with it on an edited, merged or restored database, compare each migrated basis with the original message. Linked conversation decisions show STALE afterwards. In a preregistered 20-vs-20 test the migrated documents had no outright misattribution, but a reliability gain over unmigrated ones was not statistically proven.

```sh
omp plugin install github:Clientik/omp-huimem#v0.6.3
```

> [!IMPORTANT]
> **To start, run this once in your project.** Open `omp` in the project root and type:
>
> ```text
> /huimem init
> ```
>
> Memory stays off until you do. The command creates `.memory/`, `.omp/config.yml`,
> `.omp/RULES.md`, `AGENTS.md` and the `.gitignore` lines from the built-in starter. It never
> overwrites a file you already have and lists the ones it kept. Memory works from your next
> message; no restart and no copying needed.

Installation is user-scoped, so the extension loads in every project you open with OMP, but it does nothing where you have not run `/huimem init`: no database, no injected context, no notices, and `project_memory` answers `PROJECT_MEMORY_NOT_ENABLED`. Other repositories stay untouched, with no transcript database their `.gitignore` does not cover. The marker is `.memory/MEMORY.md`.

After `init`, ask the agent to use the `initmem` skill to map the actual code. Define architecture rules for your project (`/huimem arch`); none are configured by default.

**Installation status:** installing from GitHub was tested end to end on Windows with OMP 18.1.5 — the plugin installed, registered, and ran across live sessions. Direct loading also works:

```sh
git clone --branch v0.6.3 https://github.com/Clientik/omp-huimem.git
# Run from your working project, using the cloned repository's absolute path:
omp --extension /absolute/path/omp-huimem/dist/index.js
```

On Windows, quote the path. With direct loading, copy `skills/` to the project's `.omp/skills` if desired. Do not also load an older `project-memory.ts` extension.

Native GitHub installation in OMP 18.1.5 is user-scoped; `--scope project` does not apply. Memory data stays in the current project's `.memory`. See the [user guide (Russian)](docs/GUIDE.md) for setup and troubleshooting.

**Settings screen:** in the terminal, `/huimem` opens a screen built from OMP's own dialogs.
Each row shows the current value; Enter changes it or runs the action, Esc closes. From there
you can pause commits, set the recall budget and injection limit, pick required records from
the registry, republish `RECORDS.md`, inspect the last memory block, migrate legacy ADRs and
reset limits. In a project without memory the same screen offers to enable it. Values are
stored per project in `.memory/settings.json`. In RPC and `-p` modes `/huimem` prints the state
instead, and every action stays available as a subcommand (`/huimem help`). `/huimem omp` lists
the OMP settings that affect memory; the plugin reports them and never rewrites that config.
`huimem` cannot be selected under `memory.backend`: that list is a closed enum in OMP and
there is no backend-registration API for extensions. It runs alongside any of them instead.

**Required records:** `/huimem require <id>` makes a record arrive every turn, before
question matches, even when the question is unrelated; `/huimem unrequire <id>` undoes it
(at most 10). Only the user sets this list; the plugin blocks file-tool edits of
`.memory/settings.json`. Required records together take at most half of the recall budget. A
longer one is shown as the exact start of its quote, marked `quoteClipped`; if even that does
not fit, it is left out and named in a `REQUIRED records not shown in full` notice, so it is read
by ID and its space goes to records that match the request, if they fit. Missing or retired IDs are named there too. The
notice is never cut mid-ID: a long list becomes a count, and `project_memory status` returns
every required ID.
Other records are ranked by question match, then current `doing`/`blocked` tasks, then the
remaining accepted decisions; at equal rank a STALE record yields to a fresh one.

**Explainable staleness:** a record can list what it relies on, `dependsOn: [{id}]` or
`[{path}]`; code pins the current version or file hash. Such a record turns STALE only when one
of those changes, is retired or goes missing, and the reason is shown (`db changed: version
1 -> 2`), also along a chain of records. Independent records are untouched. STALE clears only
through a new version saved with the current basis. Records without `dependsOn`, including
all older ones, keep the earlier rule: any canonical document change marks them STALE.

**Parallel tasks:** a checkpoint summary belongs to a task when the commit changes exactly one
task record or passes `task=<task id>`. The memory block then lists `Task checkpoints` under
each task's ID, with the task that matches the request first, so the next step of one task
is not presented as another's. A summary without a task is shown separately with its time;
`project_memory recall` by a task ID returns its last checkpoint. The git branch is recorded
for diagnostics only. A separate `git worktree` has its own `.memory/runtime` and does not see
the main checkout's records.

## Memory layers

| Location | Purpose |
| --- | --- |
| `.memory/MEMORY.md` | Current facts and constraints |
| `.memory/RECORDS.md` | Generated registry snapshot; do not edit or use as independent evidence |
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
