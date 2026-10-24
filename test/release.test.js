// A public release must never accept partial uploads or altered installer bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetPlan, matchingAsset } from '../scripts/publish-release.js';

test('release planning requires complete assets and verifies remote size/state/digests', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-release-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(home).startsWith('aletheia-release-'));
        fs.rmSync(home, { recursive: true, force: true });
    });
    await assert.rejects(assetPlan(home, '0.1.2'), /ENOENT/);
    for (const name of ['Aletheia-Setup-0.1.2.exe', 'Aletheia-0.1.2-linux-amd64.deb', 'Aletheia-Source-0.1.2.zip']) fs.writeFileSync(path.join(home, name), name);
    const files = await assetPlan(home, '0.1.2');
    assert.equal(files.length, 4);
    assert.match(fs.readFileSync(path.join(home, 'SHA256SUMS.txt'), 'utf8'), /Aletheia-0\.1\.2-linux-amd64\.deb/);
    const file = files[0];
    assert.equal(file.sha256, createHash('sha256').update(file.name).digest('hex'));
    const remote = { name: file.name, state: 'uploaded', size: file.size, digest: 'sha256:' + file.sha256 };
    assert.equal(matchingAsset(file, [remote]), remote);
    for (const changed of [{ ...remote, size: file.size - 1 }, { ...remote, state: 'starter' }, { ...remote, digest: 'sha256:' + '0'.repeat(64) }]) assert.throws(() => matchingAsset(file, [changed]));
    assert.throws(() => matchingAsset(file, [remote, remote]));
});
