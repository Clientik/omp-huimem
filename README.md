<p align="center">
  <img src="docs/assets/huimem.png" alt="huimem" width="392">
</p>
<h1 align="center">omp-huimem</h1>
<p align="center">Project memory for oh-my-pi. Decisions, reasons, and the next step.</p>
<p align="center">
  <strong>English</strong> · <a href="docs/i18n/README.ru.md">Русский</a> · <a href="docs/i18n/README.zh-CN.md">简体中文</a>
</p>

Keep project knowledge across sessions without a second model. Current facts live in readable files; evidence and revision history live in local SQLite. One OMP extension, no memory server, embeddings service, or separate memory model; the optional curator is one side request of the model your session already uses.

> **Preview v0.9.1 · Runtime checked with OMP 18.12.6; earlier releases also tested with 18.11.0.** Upstream Pi is not supported. Memory makes context easier to recover and inspect; it does not eliminate hallucinations.

## Why use it?

For developers working with an AI agent who want to stop explaining the same project in every session. Especially useful when a local model already uses the available compute.

- **Knowledge next to your code.** Read, edit, and version facts, decisions, and tasks with Git.
- **Evidence you can inspect.** Records require a checked quote from a message or file. Code supplies message IDs and file hashes.
- **Corrections with history.** Updates create another version of the same record instead of silently replacing its history.
- **Visible staleness.** Changed sources or core documents mark previous records `STALE` for review.
- **Bounded context.** The extension supplies a memory block of up to 9,000 characters: the rules, a list of the canonical files, and the records that match the question. The agent reads full sources when it needs them.

## Install

**New in v0.9.1 — what was checked, whether it still holds, and how it was fixed:**

- **Passed checks.** A successful `bash` check (`bun test`, `npm run typecheck`, `cargo clippy`,
  `make check`…) after an edit is recorded with the hashes of the files the run changed by then.
  The journal says `files unchanged since` or `changed since: <files>; rerun before relying on it`.
  A later pass of the same command removes its earlier failure, a later failure removes its pass.
  Reads, git, timed-out and backgrounded commands are not checks. Idea from
  [MemTrace](https://arxiv.org/abs/2610.04838); navigation only, not evidence or registry records.
- **After compaction** the block shows the journal of the compacted run even if a checkpoint was
  saved: the summary may be older than the last observed check.
- **Procedure from an observed fix.** When the same check failed and then passed and the checked
  files are unchanged, the curator runs even after a checkpoint and may propose one `procedure`
  (Symptom; Cause; Fix; Applies when). Its quote must be in the agent's own reply of that request,
  so it stays `proposed`. Code appends the observed verification and pins the record to the checked
  file hashes: changing those files makes it STALE. Idea from [REM](https://arxiv.org/abs/2610.27377).
- **Curator wait fits OMP's 30-second handler budget:** 25 seconds in `-p`/RPC and before
  compaction (was 45 before compaction). A slower answer is reported and not saved.
- **A STALE match brings its new basis.** When a matching record is STALE because a record it
  depends on changed, the block now adds that basis in its current version, marked
  `relation: "changed basis of STALE <id>: version a -> b"`; other related rows say
  `basis of <id>` or `linked from <id>`. On a copy of the same project, 0.9.0 answered "CSV, the
  client requires it" from the stale decision; with this change the model answered JSON from the
  changed basis. Ideas from [MemDerive](https://arxiv.org/abs/2610.25373) and
  [QEMem](https://arxiv.org/abs/2610.22668v1).
- **Tasks due when a file is touched.** A task may carry `when={paths:["src/db/*.ts"]}` (1-5
  project globs). While it is open, the first read or edit of a matching file in a request starts
  with `MEMORY_INTENTION_DUE`: code finds the moment, the model decides what to do. A one-off task is
  then saved as done, a standing rule stays open. Idea from
  [Prospective Intention Store](https://arxiv.org/abs/2609.01272); no time-based reminders.
- **The question type breaks ties.** Among matches equal on every earlier signal, "how/steps"
  prefers procedures, "why" decisions, "what next/status" tasks and open questions (Russian cues
  too). Before, the ID alphabet decided: with 24 equally matching decisions and facts, 0.9.0 showed
  no deployment steps; the new build put the procedure first. Idea from
  [MemoType](https://arxiv.org/abs/2610.11573), without its trained router.

**New in v0.9.0 — memory that does not depend on the model remembering to save:**

- **Fixed: the agent ignored the task.** Every earlier release put the memory block after the
  user's request. On OMP 18.12.6 with Opus in `-p` mode the model answered the block ("I'm ready.
  What would you like to work on?") and did nothing; without the plugin the same request worked.
  The block now goes right before the latest user request, so the request is always last.
- **Automatic work journal.** Code records the agent's todo progress, changed files and failed
  commands from tool calls. If a run ends without a saved checkpoint, the next run sees an
  `AUTOMATIC WORK JOURNAL` line; a checkpoint saved by the agent replaces it. Navigation only.
- **Curator, on by default.** After a turn that changed something and saved nothing, and before
  compaction, one side request of the session model (`runEphemeralTurn`, lowest effort that keeps
  the prompt cache) names durable facts and decisions from your own messages. Code finds the user
  message that contains each quote verbatim; invented quotes are dropped. Records are saved as
  `auto:<slug>` with status `proposed`, never accepted, and without a checkpoint. The cost is one
  extra model request over the cached conversation per such turn; `/huimem curator off` stops it.
- **Before compaction, not after.** Near the estimated compaction point the block says
  `CONTEXT_NEARLY_FULL` once per compaction cycle, until the agent saves.
- **Backlog hint.** With 30 or more unreviewed messages, the user is told once per process that
  `/huimem learn` can review them. The model is not told and nothing starts by itself.
- **One memory per project.** `/huimem init` sets `memory.backend: 'off'` in the project's
  `.omp/config.yml`, also in an existing file: one line is edited, comments and other keys stay.
  OMP's own `local` memory is not "off": it injects summaries of up to 5,000 tokens and runs
  background model calls. The global config is left to you.

**New in v0.8.7 — works out of the box:**

- `/huimem init` sets `plan.defaultOnStartup: false` in the new project's `.omp/config.yml`.
  With plan mode on at startup, OMP 18.12.6 snapshots the tool set before plugins load and
  restores it after plan approval without `project_memory`. Enter plan mode with `/plan` or
  Shift+Tab. Existing projects are not rewritten; see [the fix](docs/GUIDE.md#tool-availability).
- When OMP still hides the tool, the memory block says `PROJECT_MEMORY_TOOL_UNAVAILABLE` instead
  of inviting a commit, and `/huimem` shows the warning. The model no longer hunts for the tool.
- `/huimem` opens a short screen: memory on/off, check, Wiki curation. Limits, required records,
  architecture and diagnostics moved to *Advanced settings* and *Diagnostics*; nothing was removed.
- The unconfigured-architecture notice no longer appears after answers; `/huimem` still shows it.

**New in v0.8.6 — valid OMP settings, unchanged memory architecture:**

- The starter keeps `defaultThinkingLevel: auto` but uses the supported ceiling
  `providers.autoThinkingMaxEffort: xhigh`. OMP 18.12.6 ignores `high` and falls back to `xhigh`.
  Updating the plugin does not rewrite existing project configs.
- If memory hooks work but `project_memory` is unavailable, reopen the dialogue in a fresh
  OMP process and check the native tool. A resumed copy of the affected 400-message dialogue
  exposed the tool correctly. No forced tool activation or permission bypass was added.
  See [diagnosis and recovery](docs/GUIDE.md#tool-availability).

**New in v0.8.5 — what memory says about the file you are touching:**

- The first `read` or edit of a code file in a request starts with `MEMORY_FILE_RECORDS` when
  current records cite that file as their source or `dependsOn` path: ID, version, kind/status
  and STALE. Up to five records, once per file and access kind per request; `.memory/` files are
  left to the memory block. Idea from [@vshulcz/pi-deja](https://www.npmjs.com/package/@vshulcz/pi-deja);
  this is navigation only, record text is not injected. Measured cost on a copy of a real
  project: 0.04 ms for an uncited file, 6 ms once for a cited one.
- [Comparison of all 39 memory packages](docs/RETRIEVAL-RESEARCH.md#catalog-085) on pi.dev.

**New in v0.8.4 — commit follow-ups measured on a local model:**

- A commit result lists `wikiStale` pages that cite a record the commit just changed and are now
  STALE, with each page's hash and read address. On `ai1/qwen38-flash-next` a `/huimem learn`
  run inspected the Wiki plan before its own commit and finished without refreshing the page.
- A commit result lists `sameText` when another current record of the same kind already has the
  same normalized text (idea from pi-hermes-memory `bb58c12e`). Nothing is merged or rejected:
  huimem records carry separate evidence.
- Inside `/huimem learn`, `op=learn` status says `suppliedPacket.acknowledged:false` until
  `action=complete` succeeds. A local-model run called status and reported completion.
- Storage schema 2, record formats and the memory block are unchanged.

**New in v0.8.3 — honest prompt roles and fewer page reads:**

- Prompts generated by the harness — OMP plan approval (`developer` role), synthetic or
  agent-attributed messages — are stored as assistant text and cannot back `origin=user`
  or an accepted decision. OMP 18.11 appends the prompt message after `before_agent_start`,
  so the role is read when the first model request is built. A prompt whose message is not
  observed keeps the previous user role. Episodes saved by earlier versions are not reclassified.
- `episodes id=<id>` honours `limit=<UTF-16 units>`: 200 to 12,000 units per page instead of a
  fixed 2400. Search honours `limit` of 1–10 hits. The schema declared `limit`; it was ignored.
- Wiki publication no longer creates `.memory/wiki/.<id>.lock`, which a crashed publisher left
  behind as a permanent `WIKI_CONFLICT`. The scope database's immediate writer transaction
  serialises publishers; a leftover lock file from 0.7.0–0.8.2 is ignored and may be deleted.
- Storage schema 2 and record formats are unchanged.

**New in v0.8.2 — reliable settlement and less repeated work:**

- `/huimem learn` waits for native OMP recovery to settle before releasing its source packet.
  User interruption still releases the command; unfinished review is not acknowledged.
- Argument errors remain recoverable and do not mark storage unhealthy just because an ID
  contains words such as `database`. Native SQLite and filesystem failures still affect health.
- Wiki read/list/lint reuse source checks within one synchronous SQLite read snapshot.
  The next operation checks files and versions again; publication keeps its independent guards.
  There is no TTL or frozen memory truth.
- A role/time index narrows capture deduplication to the existing time window.
  Primary schema 2, the eleven tables, original episodes and `WAL/FULL` remain unchanged.
- New captures redact recognized GitHub/Slack tokens, AWS access-key IDs, private-key blocks
  and credential-URL passwords in addition to the existing patterns. New records cannot copy
  secret-bearing quotes from old originals; choose a non-secret exact excerpt instead.
  Older history is **not** silently rewritten. This is pattern-based filtering, not a secrets vault.

**One source → record → Wiki learning cycle, introduced in v0.8.0 and refined in v0.8.1:**

- **Resumable review.** `project_memory op=learn action=next` offers the oldest unreviewed
  source packet: up to 12,000 UTF-16 units and eight sources, preserving roles, exact text
  and offsets. Reading makes no reservation or acknowledgement. Only a validated `complete`
  advances coverage; cancelled work stays pending and identical acknowledgements do not write.
- **Deliberate learning, not another model.** `/huimem learn` reads one bounded packet
  before starting the main agent, supplying exact source IDs, roles and text instead of asking
  the model to discover them. The runtime keeps the opaque acknowledgement token; the model
  completes the supplied packet without retyping it. Invalid review state stops before a model
  turn. The agent updates existing IDs, retains useful procedures and curates a Wiki topic before
  acknowledging once. `/huimem learn status` uses no model turn. Required rules remain
  human-controlled; assistant guesses and review coverage never become accepted facts.
- **An actionable Wiki workbench.** `op=wiki action=plan` separates supported uncovered
  records, stale pages, proposals needing review and possible same-text duplicates.
  `action=discover id=<page>` exposes shared sources, outgoing record links/dependencies and
  backlinks. Connections come from the existing record graph, not invented entities or prose.
- **One truth, compatible storage.** Observations use the existing versioned records;
  reflections use derived Wiki pages. Cursor/receipts occupy namespaced keys in the existing
  schema-2 database, without another transcript or new tables. The actual 0.6.10 and 0.7.0
  bundles still read and append after a round-trip upgrade; old Wiki pages keep their format.

The [pinned source audit](docs/RETRIEVAL-RESEARCH.md#unified-cycle-080) explains what was
taken from Hermes, Observational Memory and LLM Wiki, and what was deliberately excluded.
No background observer, reflector, dropper, auto-deletion, MCP or memory-model setting.
The ordinary context budget is unchanged; the explicit source packet is supplied only for curation.

**New in v0.7.0 — source-backed retrieval, lower write overhead, and explicit scopes:**

- Recall searches record text, rationale, saved source quotes, source paths and dependency paths.
  Short words (`Go`, `БД`), numbers and `C#`/`C++` match whole tokens; other words keep the
  existing ending heuristic. Score counts distinct terms, not repeated quotes. Within each
  priority class, corpus-aware sparse relevance ranks distinctive terms above common words,
  then coverage, freshness, exact words and ID break ties. History and retired records do not
  inflate corpus statistics. The same relevance selects relation seeds.
- Up to three fresh lexical matches can bring in six zero-score records through one outgoing
  `dependsOn`/`links` hop. Required records, matches and open work stay ahead of these neighbors.
  Relations do not accept proposals, refresh `STALE` records or change source authority.
- `project_memory op=episodes id=<id> offset=<hit.offset>` reads a verbatim original page.
  Follow `nextOffset` until `null` to read the remainder; without an offset, reading starts at 0.
  Offsets are safe non-negative UTF-16 positions and cannot split a surrogate pair. The default
  page is 2400 units; `limit=<units>` reads 200 to 12,000 units per page. Roles and full original
  length are preserved.

- **Rebuildable history search.** Lazy SQLite FTS5 in `.memory/runtime/search.sqlite` indexes
  tokens, not another transcript. Original messages stay authoritative in `state.sqlite`.
  Old writers are detected; an unavailable index gives a visible degraded state and a complete
  streaming fallback. `/huimem index` inspects it; `/huimem index rebuild` rebuilds derived data.
- **Less automatic noise.** Unrelated accepted decisions no longer fill every turn just because
  they are accepted. Required rules, meaningful matches and current work keep their priority.
  Explicit recall and ID reads remain available; corrections and changed sources are not frozen.
- **Curated Wiki/ADR pages.** `/huimem learn` starts an intentional main-agent curation turn.
  `project_memory op=wiki` lists, reads, publishes and lints derived pages with exact source
  record versions; changed evidence makes a page STALE. Pages cannot become evidence or
  promote proposals. `action=history path=<path>` reads local Git history, not proof of rationale.
- **Project, session, personal.** Old calls still use project scope. `scope=session` follows the
  native dialogue ID and is separate from project records. Personal memory is off by default;
  only the human `/huimem personal on` enables it in the active OMP profile. Saving with
  `scope=personal` copies only selected original evidence, never the whole project transcript.
- **Changed-only diagnostics.** Identical retrieval receipts, acknowledged projections and
  unchanged checkpoints skip redundant SQL changes. Real changes remain durable and observable.

The primary database stays schema 2; no MCP, server, embeddings or background model is added.
The default **total** context limit stays 9,000 UTF-16 units, including labelled scoped records.
The [20-plugin source audit and research](docs/RETRIEVAL-RESEARCH.md) explain what was selected
and rejected; [validation](docs/VALIDATION.md) separates retrieval, latency, compatibility and
actual-model checks. These are not a claim to cover every possible task or beat other systems.

**New in v0.6.10**, from the same test session:

- **Editing a memory document no longer stales a record that quotes a message.** Ordinary work
  edits `.memory`, and every record without `dependsOn` turned STALE; the only possible answer was
  to save them again with the same text — ten records in the measured project, four in the test
  one, a minute and forty-four seconds of a six-minute turn. A signal cleared by ritual stops
  being a signal. A user's words cannot change with a document, so those records are left alone;
  a file source keeps the old rule, an explicit `dependsOn` still decides for itself, and
  tampering with the message is still caught by doctor and `op=evidence`. On the test project's
  own records: one ordinary edit of `MEMORY.md` staled 7 of 7 before, 0 of 7 now.
- **The refusal names the third source form.** Citing the answer from the previous turn, the model
  was told to "copy an exact excerpt from the current user message" and nothing else; finding that
  message and citing it with `origin="episode"` was not mentioned, and it spent a minute getting
  there alone.

**New in v0.6.9**, measured on a test project driven by a model on the user's own inference
server (`ai1/qwen38-flash-next`, 131K context) rather than a frontier one:

- **A question asked right now rests on the request that left the gap.** Saving its three
  questions, the model passed `source.origin="episode"` with no episode — for a question the
  description said "source = your own message", and a question being asked has no saved message
  yet. The refusal then offered only `user` and `file`, neither of which fits a question. Now the
  normal form is `origin="user"` with the exact words it cannot act on, `origin="episode"` is for
  a question asked in an earlier turn, and the refusal names all three forms.
- **The design document the starter creates is part of the canonical set.** `/huimem init` writes
  `.memory/DESIGN.md` while the set never included it, and the block still called its list
  complete — the same mismatch that needed a manual `/huimem include` in the measured project,
  shipped into every new one. Init registers the file when that init created it; a project with
  records is left alone, since adding a document marks records without `dependsOn` STALE once.

That session is also the first evidence that the 0.6.8 operations are reachable without a frontier
model: asked to check a quote and diagnose the memory, the model called `op=evidence` and
`op=doctor` on the first attempt and wrote no SQL of its own.

**New in v0.6.8**, all of it measured on a real project (see [validation](docs/VALIDATION.md)):

- **Check a saved quote without writing SQL.** `op=evidence` knew only files, so to verify the
  registry's quotes against the stored messages the model opened `state.sqlite` itself 17 times
  with its own SQL: the central check of the whole evidence model happened outside the plugin and
  left nothing in the receipts. Now `evidence id=<record>` re-checks one record against its
  source, `evidence id=<episode> quote=<text>` says whether that message really contains the
  quote, and `evidence` with neither re-checks every record and names the unconfirmed ones. Every
  check is written to the journal.
- **The block names the records it had to leave out.** With 20 records saved, 7 reached the block
  and 13 were dropped by budget on every one of 43 turns, while the line only said that some were
  dropped — and the only full list of IDs was the generated `RECORDS.md`. The notice now names
  them with their status, and `recall id=` takes up to ten IDs separated by commas, which is what
  `expectedVersion` needs.
- **A proposed decision is a proposal.** "Proposed facts require checking" is something a decision
  cannot satisfy: only the user accepts it. In the measured session two proposed decisions carried
  a 45 KB architecture document whose nine determining questions were asked only at the end.
- **A question you are waiting on the user for is a record**: `kind=question`, `open | answered |
  dropped`. Those nine questions existed nowhere in memory — they survived as prose in a checkpoint
  summary and in the documents, which the rules say not to trust. An open question stays in the
  block until it is saved as answered with links to the records the answer produced; doctor reports
  what is open and warns when an answer changed nothing.
- **A numbered answer carries the question it answers.** `source.answers=<ID of your message>`:
  "2. It is the repository" proves nothing on its own, and the model had been restoring the link by
  hand in `MEMORY.md` and an ADR, marked as an inference.
- **A checkpoint keeps its next step.** It reached the model cut to 218 characters of 780, losing
  the part that says what to do next. Checkpoints now have a floor in the block and each line is
  clipped from both ends with the gap named in place.
- **Less noise, fewer duplicates.** A turn OMP delivers twice is one episode, not two IDs for the
  same words; the subagent line is logged once per request instead of once per model call, where
  it had filled 157 of 169 journal entries.

**Since v0.6.7:** a subagent's brief is captured as an assistant message rather than the user's
words (nine of twenty-one episodes in the measured project were briefs), and a subagent gets a
short block without the saving rules (`subagentBlock: short | full | off`). The commit contract
lives in the tool description, after the model made 34 calls into the installed plugin source to
learn it. `project_memory op=doctor` gives the model the same read-only diagnosis as
`/huimem doctor`. Episode search ranks matches, shows the part of a long message that matched,
takes `role=user|assistant` and reads original episode pages by id (see the paging contract above). The canonical section is a list of
files rather than their text, and a project adds its own documents with `/huimem include`.
`CHECKPOINT_MISSING` is advice, not an error, and one-shot notices go to an events log that a
fan-out of subagents cannot wipe (`/huimem context` prints it).

**Since v0.6.5:** a plugin upgrade reaches a conversation that is already running. The database
records which build wrote it, and after an upgrade the next memory block states once what changed in
the memory rules, so a resumed session stops following the rules it saw on earlier turns. Settings
keep keys this version does not know. An empty registry is stated in one line instead of looking
like a search that found nothing. `/huimem` shows the running build and what wrote the database.

**Since v0.6.4:** `/huimem off` and `/huimem on` switch project memory off and back on, and the
commit rules now say plainly that durable facts belong in the registry rather than in hand-written
`.memory` documents. **Since v0.6.3:** `/huimem doctor` reports stale or missing evidence, unavailable required records, ADRs without a basis section and task-file drift. It opens the existing database read-only and applies no repairs. See the [diagnostic guide](docs/GUIDE.md#doctor). Check results and the fixes that followed are in [validation](docs/VALIDATION.md).

You need [OMP](https://github.com/can1357/oh-my-pi) with a configured main model. Local models are supported.

**mnemopi is not required.** huimem uses its own local SQLite through OMP's runtime. `/huimem init` sets `memory.backend: off` for the project; no separate memory service or model is needed.

**Readable registry:** commits automatically publish `.memory/RECORDS.md`, a readable registry snapshot. `/huimem` shows its sync state; `/huimem sync` retries publication without another model call. `/huimem context` shows the last prepared memory block's size, hash and complete record IDs/versions; it does not prove the model used them. The diagnostic log retains at most 100 entries without copying fact text. Databases from v0.3.x or earlier migrate to schema 2; back up `.memory` with OMP stopped before upgrading. Schema 1 plugin versions cannot open the migrated database.

**Legacy ADRs:** `/huimem adr-audit` lists ADRs without a basis section that can be moved into the contract, and writes nothing. `/huimem adr-audit apply` inserts the user's quote from the registry as the basis and keeps every original line under an "Interpretation [?]" heading, after a byte-exact backup to `.memory/adr-backup/`. A document is migrated only when exactly one accepted decision names it by path, its rationale is an exact excerpt of the quote, and the quote is re-checked at migration time against the stored message, which must exist and belong to the user; otherwise it is reported as `UNVERIFIED` and nothing is written. v0.5.0 skipped that last check: if you ran `apply` with it on an edited, merged or restored database, compare each migrated basis with the original message. Linked conversation decisions show STALE afterwards. In a preregistered 20-vs-20 test the migrated documents had no outright misattribution, but a reliability gain over unmigrated ones was not statistically proven.

```sh
omp plugin install github:Clientik/omp-huimem#v0.9.1
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

Installation is user-scoped, so the extension loads in every project. Project memory stays off without `/huimem init`: no project database or transcript capture, and default `project_memory` calls return `PROJECT_MEMORY_NOT_ENABLED`. Explicitly opted-in personal memory is independent and can work without creating a project `.memory`. The project enable marker is `.memory/MEMORY.md`.

After `init`, ask the agent to use the `initmem` skill to map the actual code. Define architecture rules for your project (`/huimem arch`); none are configured by default.

**Installation status:** installing from GitHub was tested end to end on Windows with OMP 18.1.5 and again with 18.11.0 — the plugin installed, registered, and ran across live sessions. Direct loading also works:

```sh
git clone --branch v0.9.1 https://github.com/Clientik/omp-huimem.git
# Run from your working project, using the cloned repository's absolute path:
omp --extension /absolute/path/omp-huimem/dist/index.js
```

On Windows, quote the path. With direct loading, copy `skills/` to the project's `.omp/skills` if desired. Do not also load an older `project-memory.ts` extension.

Native GitHub installation in OMP is user-scoped; `--scope project` does not apply. Project/session data stays in the project's `.memory`; optional personal data belongs to the active OMP profile. See the [user guide (Russian)](docs/GUIDE.md) for setup and troubleshooting.

**Settings screen:** in the terminal, `/huimem` opens a screen built from OMP's own dialogs.
Each row shows the current value; Enter changes it or runs the action, Esc closes. From there
you can switch memory off and on for this project, pause commits, set the recall budget and
injection limit, pick required records from
the registry, republish `RECORDS.md`, inspect the last memory block and the events log, migrate
legacy ADRs and reset limits. In a project without memory the same screen offers to enable it. Values are
stored per project in `.memory/settings.json`.

**Switch (since v0.6.4):** `/huimem off` silences memory in this project — no memory block, no
project transcript capture or project commits — and `/huimem on` brings it back. Saved records
and files stay untouched; the state lives in `.memory/settings.json` and survives a restart.
Personal permission is independent: use `/huimem personal off` to disable that scope too.
`/huimem pause` blocks record/checkpoint commits, review acknowledgements, Wiki publication
and index rebuild in the running process; reads remain available. In RPC and `-p` modes `/huimem` prints the state
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
Automatic context then selects meaningful question matches, current work and bounded related
bases, not every unrelated accepted decision. Explicit recall keeps its broader overview.

**Canonical documents (since v0.6.7):** the set is `MEMORY.md`, `PROJECT.md`, `todo.json`,
`architecture.json` and `.memory/adr/**`. `/huimem include <path>` adds another document inside
`.memory` to it, `/huimem exclude` removes it, up to ten. An added document is listed in the block,
hashed with the set and tracked for staleness. In the measured project a 17 KB `.memory/DESIGN.md`
was a live memory document outside the set, while the block told the model that nothing else was
project memory. Adding a document changes the set hash: file-backed records without explicit
`dependsOn` may become STALE; conversation-backed records retain their original evidence.
Generated `RECORDS.md`, Wiki pages and runtime files cannot be added as canonical documents.

**Open questions (since v0.6.8):** a question you are waiting on the user for is a record with
`kind=question` and `status=open`, its text the question as you asked it and its source your own
message. An open question is pinned into the block beside the current work, so what blocks
progress travels with the memory instead of the conversation. Saving it again as `answered`, with
`links` to the records the answer produced, unpins it; `dropped` closes it without an answer.
`project_memory op=doctor` lists what is open and warns about an answered question that links to
no record. When the user answers by number, `source.answers=<ID of your message with the
question>` keeps the pair together: a quote like "2. It is the repository" proves nothing alone.

**Evidence checks (since v0.6.8):** `op=evidence` re-checks what is already saved. With
`id=<record>` it compares that record with its own source — quote present, file unchanged, role
still admissible for an accepted decision. With `id=<episode> quote=<text>` it answers whether
that message contains the quote, and shows the part of it that matched. With neither it checks
every record and lists the unconfirmed ones. Each check is a receipt in the journal, which a
script over the SQLite file is not.

**Subagents (since v0.6.7):** a subagent's prompt is written by the model, so it is recorded as an
assistant message and can never become the user evidence an accepted decision requires. Its block
keeps the evidence rules, the file list and the records, and drops the saving rules;
`subagentBlock` in `.memory/settings.json` chooses `short` (default), `full` or `off`.

**Explainable staleness:** a record can list what it relies on, `dependsOn: [{id}]` or
`[{path}]`; code pins the current version or file hash. Such a record turns STALE only when one
of those changes, is retired or goes missing, and the reason is shown (`db changed: version
1 -> 2`), also along a chain of records. Independent records are untouched. STALE clears only
through a new version saved with the current basis. Without `dependsOn`, conversation-backed
records stay tied to their immutable source; file-backed records also track canonical changes.

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
| `.memory/runtime/state.sqlite` | Episodes, evidence versions, checkpoints and review cursor/receipts |
| `.memory/runtime/search.sqlite` | Rebuildable history index; not evidence |
| `.memory/wiki/` | Derived source-linked Wiki/ADR pages; not canonical evidence |
| `.memory/runtime/scopes/<session hash>/` | Isolated records for one native dialogue |
| `.omp/RULES.md` | Short hard requirements, re-attached near the current turn |
| `AGENTS.md` | Background and conventions, given once when the session opens |

A starter project has two support folders, `.memory` and `.omp`, plus root `AGENTS.md` and `.gitignore` files. Installed plugin code is separate from project data.

## A typical session

You say: “Use PostgreSQL because orders and payments need transactions.”

The extension captures the message. The agent updates the project facts and decision, then can commit evidence to the registry. In a new session, the extension supplies a short memory context so the agent can recover the choice and its reason.

When a decision changes, the agent updates the files and creates a new record version. A past quote does not make an old decision current: conflicting information must be checked against primary sources.

**Transcript capture is automatic; selecting and maintaining useful knowledge depends on the main model.** There is no second LLM process and no forced save loop at session end.

## Trade-offs

This is an inspectable project-first memory system with opt-in personal and session scopes. It offers checked evidence and local persistence without a separate extraction service. It has not been shown to outperform other memory systems in comparative benchmarks.

Search is lexical, not semantic. Architecture checks match configured strings, not full dependency graphs. Source quotes establish provenance, not truth. File changes and SQLite writes are not one transaction. Real compaction, crashes, concurrent sessions, and branch changes need more live testing.

The 9,000-character limit is not a token limit or a measured savings percentage. Memory still consumes main-model context. If you use a cloud model, the memory context sent to it reaches that provider.

Keep runtime SQLite out of Git. To back up history, stop active sessions and copy all of `.memory`, including existing WAL/SHM files. Back up the profile's `huimem/` separately if personal memory is enabled. There is no automatic history cleanup.

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
