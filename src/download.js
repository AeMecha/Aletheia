/** Stream large downloads to resumable .part files. Publish the final filename
 * only after verifying SHA-256, so corrupt bytes never become a usable model. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export async function sha256(filename) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest('hex');
}

export async function downloadVerified(asset, destination, { signal, progress = () => {} } = {}) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (fs.existsSync(destination) && await sha256(destination) === asset.sha256) return destination;
    const partial = destination + '.part';
    let received = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (asset.size && received > asset.size) { fs.unlinkSync(partial); received = 0; }
    // A fully downloaded partial may remain after cancellation during verification.
    if (!asset.size || received !== asset.size) {
        const response = await fetch(asset.url, { headers: received ? { Range: `bytes=${received}-` } : {}, signal });
        if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}). Retry to continue setup.`);
        if (response.status !== 206) received = 0;
        else if (!response.headers.get('content-range')?.startsWith(`bytes ${received}-`)) throw new Error('The download server returned an unexpected range.');
        const total = asset.size || received + Number(response.headers.get('content-length'));
        const file = fs.openSync(partial, received ? 'a' : 'w');
        try {
            for await (const chunk of response.body) {
                signal?.throwIfAborted();
                fs.writeSync(file, chunk);
                received += chunk.length;
                progress({ received, total, phase: 'downloading' });
            }
        } finally { fs.closeSync(file); }
    }
    signal?.throwIfAborted();
    progress({ received, total: received, phase: 'verifying' });
    if ((asset.size && received !== asset.size) || await sha256(partial) !== asset.sha256) {
        fs.unlinkSync(partial);
        throw new Error('The downloaded file failed its integrity check. Please retry setup.');
    }
    signal?.throwIfAborted();
    fs.renameSync(partial, destination);
    return destination;
}
