# Project memory

Install pi-huimem in OMP, then run omp from this project root.
MEMORY.md holds current facts; adr/ holds decisions and reasons; todo.json holds
tasks; PROJECT.md maps the project. architecture.json starts unconfigured: populate
it with agreed, verifiable rules. Do not claim architectural validation before that.

The extension captures episodes and injects bounded relevant context automatically.
The main model maintains semantic knowledge and commits evidence via project_memory.
Use exact source quotes. Changed authority files mark old registry records STALE;
verify the source before creating a new version with the same ID.

No background LLM is needed. memory.backend is off in the starter config; merge
this setting with existing OMP settings and retain your own provider configuration.
Seven skills are included in the plugin. Run /project-memory-status to diagnose it.
Do not load a second copy of the extension. Runtime SQLite is local and gitignored.
Back it up with WAL after stopping sessions; do not merge SQLite files with Git.
