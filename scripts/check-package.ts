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
console.log('Package manifest, seven skills, starter and dependency checks passed.');
