import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.name, 'omp-huimem');
assert.deepEqual(manifest.omp.extensions, ['./dist/index.js']);
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
for (const path of manifest.files) assert(existsSync(path), `Missing package file: ${path}`);
assert.equal(readdirSync('skills').filter(n => existsSync(join('skills', n, 'SKILL.md'))).length, 7);
assert(!existsSync('starter/.memory/runtime'), 'Starter must not contain runtime data');
const config = readFileSync('starter/.omp/config.yml', 'utf8');
assert(config.includes("backend: 'off'"));
assert(!config.includes('beellama') && !config.includes('127.0.0.1'));
// Sticky rules are a separate layer from AGENTS.md: OMP re-attaches RULES.md near the
// current turn, so it survives a long conversation. Losing this file loses that layer.
assert(readFileSync('starter/.omp/RULES.md', 'utf8').trim().length > 0, 'Starter must ship non-empty sticky rules');
// Unconfigured make targets must FAIL. An earlier version echoed "TODO" and returned 0,
// so an agent could run `make test`, get success, and report checks as passed.
const make = readFileSync('starter/Makefile', 'utf8');
assert(make.includes('exit 2'), 'Unconfigured make targets must fail, not exit 0');
console.log('Package manifest, seven skills, starter and dependency checks passed.');
