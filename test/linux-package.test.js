// Exercise the cross-platform package writer with real TAR decoding. Linux
// executable permissions must survive even when the build host uses NTFS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { writeTarGz, writeDeb, assertLinuxExecutable, postinst } from '../scripts/package-linux.js';

test('Linux package streams preserve Unix ownership, executable modes, links and Debian container headers', async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aletheia-deb-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(home).startsWith('aletheia-deb-'));
        fs.rmSync(home, { recursive: true, force: true });
    });
    const filename = path.join(home, 'control.tar.gz');
    await writeTarGz(filename, [{ name: './postinst', content: postinst, mode: 0o755 }, { name: './link', type: 'symlink', linkname: '/opt/Aletheia/aletheia', mode: 0o777 }]);
    const entries = [];
    const extract = tar.extract();
    extract.on('entry', (header, stream, next) => { entries.push(header); stream.resume(); stream.once('end', next); });
    await pipeline(fs.createReadStream(filename), createGunzip(), extract);
    assert.equal(entries[0].uid, 0); assert.equal(entries[0].gid, 0);
    assert.equal(entries[0].mode, 0o755);
    assert.equal(entries[1].type, 'symlink');
    assert.equal(entries[1].linkname, '/opt/Aletheia/aletheia');
    const deb = path.join(home, 'test.deb');
    await writeDeb(deb, [{ name: 'debian-binary', content: '2.0\n' }, { name: 'control.tar.gz', filename }]);
    const buffer = fs.readFileSync(deb);
    assert.equal(buffer.subarray(0, 8).toString(), '!<arch>\n');
    assert.equal(buffer.subarray(8, 24).toString().trim(), 'debian-binary/');
    assert.equal(buffer.subarray(68, 72).toString(), '2.0\n');
    assert.equal(buffer.subarray(72, 88).toString().trim(), 'control.tar.gz/');
    // Reject an accidentally packaged Windows executable before distributing it.
    const wrong = path.join(home, 'wrong'); fs.writeFileSync(wrong, 'MZ Windows executable');
    assert.throws(() => assertLinuxExecutable(wrong), /Linux x64/);
});
