# pi-huimem: OMP package and publication

Checked 2026-09-08 against official upstream main and locally captured source commit `1adcef9762b065c0cef15703fd3e78ecaaa52a3b`. Installed OMP reported 18.1.5 in prior testing. Source compatibility is not proof of a successful installation on this machine.

## Recommended distribution

Use a native OMP package at the root of the GitHub repository. Commit the compiled entry so consumers need no build lifecycle scripts:

```json
{
  "name": "pi-huimem",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist", "skills", "starter", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"],
  "omp": { "extensions": ["./dist/index.js"] }
}
```

Manifest `omp` is used before legacy `pi`; the loader resolves declared extensions. This proposal needs no Claude/Codex plugin manifest. Conventional package `skills/` is separately discovered. [Official package plumbing](https://github.com/can1357/oh-my-pi/blob/main/docs/plugin-manager-installer-plumbing.md).

After publishing the repository and a matching tag:

```sh
omp plugin install github:Clientik/pi-huimem#v0.1.0
omp plugin list --json
omp plugin doctor
```

Restart OMP before validating tools and skills. Git sources and refs are accepted by `PluginManager.install`; it delegates dependency retrieval to Bun, validates extension registration, then records enabled runtime state. GitHub distribution does not require npm publication. If npm is desired later, choose an available npm name/account and remove `private: true`; publishing a GitHub repository alone never creates an npm package. [Manager implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/plugins/manager.ts).

## Scope and Windows

Native npm/git installation uses the user plugin root. CLI `--scope project` applies to marketplace installation, not native npm/git/local packages; do not advertise that flag for the command above. [CLI implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/cli/plugin-cli.ts).

`omp plugin link PATH` uses `fs.promises.symlink` in the user plugin root. Our previous Windows link test failed with EPERM. That does not establish failure of GitHub installation: the latter runs Bun install through a distinct path and still requires a real acceptance test. Do not alter Windows privileges or silently substitute project scope. The previous local bundle can also be loaded with the separately tested explicit extension path for development. [Manager link implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/plugins/manager.ts).

Marketplace distribution is an optional future route if native project-scoped installation becomes necessary; it adds a catalog, registry and cached-package links. It is unnecessary for the requested first GitHub release. [Official marketplace documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/marketplace.md).

## Existing skill redistribution

All three checked upstream repositories supply MIT licenses permitting redistribution with their copyright and permission notices retained. Full upstream license files are included unchanged in `licenses/`, with skill-to-upstream attribution in THIRD_PARTY_NOTICES.md:

- `superpowers.txt`: Jesse Vincent, 2025. [obra/superpowers LICENSE](https://github.com/obra/superpowers/blob/main/LICENSE).
- `skills.txt`: Matt Pocock, 2026. [mattpocock/skills LICENSE](https://github.com/mattpocock/skills/blob/main/LICENSE).
- `taste-skill.txt`: Leonxlnx, 2026. [Leonxlnx/taste-skill LICENSE](https://github.com/Leonxlnx/taste-skill/blob/main/LICENSE).

This verifies repository-level licenses, not a byte-for-byte audit of every copied skill or nested third-party asset.

## Pi compatibility boundary

The requested repository name is now `Clientik/pi-huimem`; that name does not establish compatibility. Current code must be described as OMP-only:

- Adapter uses OMP `pi.zod`; current upstream Pi documentation uses TypeBox tool parameters.
- `execute(id, params, signal, onUpdate, ctx)` matches the documented Pi signature, but that alone does not make the adapter portable.
- Pi documents `agent_end` / `agent_settled` and `session_shutdown`; our checkpoint warning uses OMP `session_stop`. No `session_stop` or `loadMode` entries were found in current Pi extension documentation.
- Core imports `bun:sqlite`; this cannot run unchanged in a standard Node-based Pi runtime.
- Pi packages use their own `pi` manifest, installation syntax and `.pi` discovery. Adding a second manifest pointing to the same OMP bundle would not resolve the schema/runtime issues.

These are source-level findings, not a Pi runtime test. A future Pi adapter can reuse the memory model but needs a portable database implementation or explicit Bun runtime support, schema/lifecycle mapping and its own end-to-end tests. [Pi extension API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md), [Pi packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
