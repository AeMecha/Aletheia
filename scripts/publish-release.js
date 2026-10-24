/** Publish only complete, verified builds. GitHub Actions supplies a scoped
 * short-lived GH_TOKEN to gh; no personal credential is stored in this project.
 * Assets are uploaded to a draft, checked, then made public together. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

export async function assetPlan(directory, version) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable semantic version.');
    const names = [`Aletheia-Setup-${version}.exe`, `Aletheia-${version}-linux-amd64.deb`, `Aletheia-Source-${version}.zip`];
    const files = [];
    for (const name of names) {
        const filename = path.join(directory, name);
        const size = fs.statSync(filename).size;
        if (!size) throw new Error(`Empty release asset: ${name}`);
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
        files.push({ name, filename, size, sha256: hash.digest('hex') });
    }
    const filename = path.join(directory, 'SHA256SUMS.txt');
    fs.writeFileSync(filename, files.map(file => `${file.sha256}  ${file.name}\n`).join(''));
    const data = fs.readFileSync(filename);
    files.push({ name: 'SHA256SUMS.txt', filename, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    return files;
}

export function matchingAsset(file, assets) {
    const matches = assets.filter(asset => asset.name === file.name);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== file.size) throw new Error(`Missing, incomplete or wrong-sized release asset: ${file.name}`);
    const asset = matches[0];
    if (asset.digest && asset.digest !== 'sha256:' + file.sha256) throw new Error(`Release checksum mismatch: ${file.name}`);
    return asset;
}

function gh(args) {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}
async function remoteHash(repository, asset) {
    // Older API responses may omit digest. Stream the authenticated asset through
    // a hash instead of buffering hundreds of megabytes in the Node process.
    const child = spawn('gh', ['api', `repos/${repository}/releases/assets/${asset.id}`, '--header', 'Accept: application/octet-stream'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const hash = createHash('sha256');
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not verify the uploaded asset.'))); });
    exited.catch(() => {});
    for await (const chunk of child.stdout) hash.update(chunk);
    await exited;
    return hash.digest('hex');
}

async function publish() {
    const version = JSON.parse(fs.readFileSync('package.json')).version;
    const tag = 'v' + version;
    const repository = process.env.GITHUB_REPOSITORY;
    if (!process.env.GH_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Run publishing through the release workflow with its repository-scoped token.');
    const recovery = process.env.ALETHEIA_RELEASE_TAG === tag && /^\d+$/.test(process.env.ALETHEIA_BUILD_RUN_ID || '');
    if (recovery) await import('./verify-release-build.js');
    else if (process.env.GITHUB_REF_NAME !== tag || !process.env.GITHUB_REF?.startsWith('refs/tags/')) throw new Error('The release must run from the matching version tag.');
    const files = await assetPlan(path.resolve('release-assets'), version);
    const notes = path.join('docs', 'releases', tag + '.md');
    if (!fs.existsSync(notes)) throw new Error('Release notes are missing.');
    const releases = () => JSON.parse(gh(['api', `repos/${repository}/releases?per_page=100`, '--header', 'Accept: application/vnd.github+json']));
    let release = releases().find(item => item.tag_name === tag);
    if (!release) {
        gh(['release', 'create', tag, '--verify-tag', '--draft', '--title', `Aletheia ${version}`, '--notes-file', notes]);
        release = releases().find(item => item.tag_name === tag);
    }
    if (!release) throw new Error('GitHub did not return the draft release.');
    if (release.draft) {
        gh(['release', 'upload', tag, ...files.map(file => file.filename), '--clobber']);
        release = JSON.parse(gh(['api', `repos/${repository}/releases/${release.id}`]));
    }
    // A rerun can resume a draft, but never replaces an already public download
    // with different bytes. GitHub's asset digest verifies the actual upload.
    for (const file of files) {
        const asset = matchingAsset(file, release.assets);
        if (!asset.digest && await remoteHash(repository, asset) !== file.sha256) throw new Error(`Release checksum mismatch: ${file.name}`);
        console.log(`Verified ${file.name}: ${file.sha256}`);
    }
    if (release.draft) gh(['release', 'edit', tag, '--draft=false', '--latest']);
    const published = JSON.parse(gh(['api', `repos/${repository}/releases/${release.id}`]));
    if (published.draft || !published.published_at) throw new Error('The release was not published.');
    console.log('Published ' + published.html_url);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publish();
