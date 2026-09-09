# Distribution

This is a native OMP package: package.json declares `omp.extensions` and skills live
in `skills/`. It is not a Codex plugin and it is not a Claude marketplace manifest.
The upstream Pi adapter has not been validated.

GitHub release process:

1. Run `bun run check` and inspect the changes, license notices and package contents.
2. Commit the source and generated dist/index.js together.
3. Push the repository and tag v0.2.2; keep the first release marked pre-release.
4. Install with `omp plugin install github:Clientik/omp-huimem#v0.2.2`.
5. In a disposable project, check discovery, /project-memory-status and a save/recall.

GitHub hosting and release creation do not imply npm publication or successful
installer acceptance. package.json stays private until npm publishing is separately
requested and the package name/account permissions have been checked.

OMP 18.1.5's native git/npm installation is user-scoped. Its link command creates a
symlink and ignores a project-scope argument; Windows permissions can reject it.
Do not work around this with hidden profile rewrites or administrator scripts.

Primary-source findings and links are in OMP-SOURCES.md.
