# Distribution

This is a native OMP package: package.json declares `omp.extensions` and skills live
in `skills/`. It is not a Codex plugin and it is not a Claude marketplace manifest.
The upstream Pi adapter has not been validated.

GitHub release process:

1. Run `bun run check` and inspect the changes, license notices and package contents.
2. Commit the source and generated dist/index.js together.
3. Push the repository and tag the release (annotated); keep releases marked pre-release.
4. Install with `omp plugin install github:Clientik/omp-huimem#v0.7.0`.
5. Test installation under an isolated OMP profile/agent directory, not by updating the
   plugin used by the running development session. Native install is user-scoped.
6. In a disposable project run /huimem init, inspect /huimem and index status, then
   exercise actual save/recall, Wiki and scoped reads. Resume an older dialogue;
   check both upgrade and 0.6.10 rollback against the same primary database.

GitHub hosting and release creation do not imply npm publication or successful
installer acceptance. package.json stays private until npm publishing is separately
requested and the package name/account permissions have been checked.

OMP 18.11.0's native git/npm installation is user-scoped. Its link command creates a
symlink and ignores a project-scope argument; Windows permissions can reject it.
Do not work around this with hidden profile rewrites or administrator scripts.

Primary-source findings and links are in OMP-SOURCES.md.

The build keeps `@oh-my-pi/pi-coding-agent` external: it is supplied by the OMP host,
not an npm runtime dependency of this package. Standalone fixtures inject agentDir.
Factory validation must not create project databases or profile permissions.

For 0.7.0, publish the existing README/i18n release notes and a compact validation asset;
never upload authentication files, raw provider traces or private dialogue databases.
The asset records measured source hashes, timings, context counts, compatibility and
same-model acceptance outcomes, not an external benchmark ranking.

