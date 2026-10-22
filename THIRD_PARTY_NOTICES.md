# Third-party notices

## Bundled skills

All seven skills remain available. Local adaptations may differ from upstream;
skills-lock.json records source identifiers and original hashes, not a guarantee
that adapted content has those hashes.

| Skills | Upstream | License notice |
| --- | --- | --- |
| systematic-debugging, test-driven-development | https://github.com/obra/superpowers | licenses/superpowers.txt |
| grill-me, to-spec | https://github.com/mattpocock/skills | licenses/skills.txt |
| design-taste-frontend, full-output-enforcement | https://github.com/Leonxlnx/taste-skill | licenses/taste-skill.txt |
| initmem | This project | LICENSE |

Upstream skills are MIT licensed; their full notices are retained in licenses/.

## Memory design references

The 0.8.0 learning lifecycle was informed by source audits of these MIT-licensed
projects. They are design references, not bundled engines or a forked runtime;
huimem implements the mechanisms through its existing records, evidence and Wiki.
No upstream model worker, prompt collection, MCP server or dependency was vendored.

| Project | Audited commit | Upstream copyright and license |
| --- | --- | --- |
| [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) | `d09bc48564129b06dc4541f6aad50396524b7b60` | Copyright (c) 2025 Chandra Teja · [MIT](https://github.com/chandra447/pi-hermes-memory/blob/d09bc48564129b06dc4541f6aad50396524b7b60/LICENSE) |
| [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) | `022da5e5554d04dfdc876ed7dac4a42c6b83dfd4` | Copyright (c) 2026 pi-observational-memory contributors · [MIT](https://github.com/elpapi42/pi-observational-memory/blob/022da5e5554d04dfdc876ed7dac4a42c6b83dfd4/LICENSE) |
| [pi-llm-wiki](https://github.com/zosmaai/pi-llm-wiki) | `46bd677041ba01f0298e5afc22e6a8b592f5f835` | Copyright (c) 2026 zosmaai · [MIT](https://github.com/zosmaai/pi-llm-wiki/blob/46bd677041ba01f0298e5afc22e6a8b592f5f835/LICENSE) |

See [the source audit](docs/RETRIEVAL-RESEARCH.md#unified-cycle-080) for the exact
mechanisms retained and excluded. Upstream copyright notices and licenses apply
to upstream code; the local implementation remains covered by this repository's LICENSE.

