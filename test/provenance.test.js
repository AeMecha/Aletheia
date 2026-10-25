// Distribution notices must retain the upstream license and original prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import packaging from '../packaging.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('upstream author, full license and original Librarian text are preserved', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'UPSTREAM-PROVENANCE.json')));
    const license = fs.readFileSync(path.join(root, manifest.license.path));
    assert.equal(createHash('sha256').update(license).digest('hex'), manifest.license.sha256);
    assert.equal(Buffer.compare(license, fs.readFileSync(path.join(root, 'prompts/LICENSE.txt'))), 0);
    const body = fs.readFileSync(path.join(root, 'prompts/librarian.md'), 'utf8').replace(/\r\n/g, '\n').split('-->\n\n').slice(1).join('-->\n\n');
    assert.equal(createHash('sha256').update(body).digest('hex'), manifest.original_prompts_normalized_lf_sha256['librarian.md']);
    assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /AdeptTel1\/Aletheia/);
    for (const platform of ['win32', 'linux']) {
        const config = packaging(platform);
        assert.equal(config.productName, 'Aletheia Scriptorium');
        for (const name of ['LICENSES/**', 'LICENSING.md', 'ATTRIBUTION.md', 'UPSTREAM-PROVENANCE.json']) assert.ok(config.files.includes(name));
    }
});
