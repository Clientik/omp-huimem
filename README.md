# omp-huimem

Project-local memory for **oh-my-pi (OMP)**. One extension, plain project files,
SQLite evidence history, and seven optional bundled skills. No server, embedding
service, background model, or runtime npm dependencies.

**Preview release. Tested with OMP 18.1.5.** This adapter uses OMP APIs;
upstream Pi is not currently supported.

## Install

Requires OMP with a configured model. Local models are supported.

```sh
omp plugin install github:Clientik/omp-huimem#v0.1.0
```

OMP installs GitHub/npm plugins into its user plugin directory. In OMP 18.1.5,
`--scope project` is not supported for this installation route. Project data still
lives in the working project's `.memory`, not inside the installed package.

For a new project, copy the **contents** of `starter/` into its root once. For an
existing project, merge those files carefully. Do not overwrite existing knowledge
or model settings. Start `omp` in that root, then check `/project-memory-status`.
Ask the agent to use the bundled `initmem` skill. Configure architecture rules for your project.

Do not load this plugin together with an older `.omp/extensions/project-memory.ts`.
Both register the same tool and event handlers. Preserve `.memory` when upgrading.

### Direct local loading

```sh
omp --extension /absolute/path/omp-huimem/dist/index.js
```

This loads the extension only. Copy the bundled skills into `.omp/skills` to use
them with this route. Direct bundle loading was tested with a real local model.
`omp plugin link` failed with a Windows symlink EPERM in our environment; it is not
the recommended installation path. GitHub installation uses a different OMP path.

## What is remembered

| Layer | Location | Purpose |
| --- | --- | --- |
| Current facts | `.memory/MEMORY.md` | Authoritative current state |
| Decisions | `.memory/adr/` | Choices, reasons and evidence |
| Tasks | `.memory/todo.json` | Work state |
| Navigation and invariants | `.memory/PROJECT.md`, `architecture.json` | Where to look and what to preserve |
| Evidence and episodes | `.memory/runtime/state.sqlite` | Versioned records, transcript capture, checkpoints |

The extension automatically captures episodes and supplies a bounded memory block
before requests (up to 8000 characters). The **main model** still has to maintain
meaningful facts and decisions. There is no second model and no forced continuation
at session end. The starter disables OMP's separate `mnemopi` memory backend.

`project_memory` is directly visible to the model. User evidence uses an exact
quote and an extension-supplied episode ID. File evidence is checked against the
file and hashed by the extension. Corrections preserve the record ID and increment
its version. Changed authoritative files mark old records `STALE`.

## Development

With Bun installed:

```sh
bun run build
bun run check
```

No dependency installation is required to bundle or run the tests. OMP supplies
its extension API at runtime; the source import is type-only. `dist/index.js` is
committed for GitHub installation. CI checks source tests, bundle tests, package
contents and that the committed bundle matches the source.

## Limits and status

20 source tests and 8 bundle tests passed. A real local Qwen model passed one
four-session sequence: save decisions, recall, correct a decision, recall again.
The first save needed two validation retries. This is not a broad reliability study.

Quote checks do not establish semantic truth or causal reasoning. Architecture
checks require project-specific configuration and are not an OS sandbox. Branch
isolation, real compaction, crash recovery and concurrent OMP sessions need more
live testing. File writes and SQLite do not form one transaction. History has no
automatic retention policy. Transcripts may contain sensitive information; runtime
is gitignored. Stop sessions before backing it up, including SQLite WAL files.

See [validation](docs/VALIDATION.md) and [publishing](docs/PUBLISHING.md).
The package is intentionally marked `private` to prevent accidental npm publication;
GitHub distribution does not require npm publication.

## License

MIT for the memory code. Bundled third-party skills retain their MIT notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/`.
