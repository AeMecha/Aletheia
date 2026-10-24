/** Prepare hash-verified offline search and inference assets for one platform.
 * The large Qwen GGUF is selected/downloaded at first run, not in the installer.
 * --platform allows Linux packaging from a Windows development host. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { downloadVerified } from '../src/download.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets.json'), 'utf8'));
const platformIndex = process.argv.indexOf('--platform');
const platform = platformIndex < 0 ? process.platform : process.argv[platformIndex + 1];
if (!['win32', 'linux'].includes(platform) || process.arch !== 'x64') throw new Error('Supported targets: Windows x64 and Linux x64.');
function execute(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: 'inherit', env: { ...process.env, ...env } });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    });
}

// Reject paths outside the build directory before extracting any archive entry.
function containedPath(directory, name) {
    const destination = path.resolve(directory, name);
    const relative = path.relative(directory, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe runtime archive path.');
    return destination;
}
async function extractLinux(archive, directory) {
    const extract = tar.extract();
    const links = [];
    extract.on('entry', (header, stream, next) => {
        (async () => {
            const destination = containedPath(directory, header.name);
            if (header.type === 'directory') fs.mkdirSync(destination, { recursive: true });
            else if (header.type === 'file') {
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                await pipeline(stream, fs.createWriteStream(destination, { mode: header.mode & 0o777 }));
                if (process.platform !== 'win32') fs.chmodSync(destination, header.mode & 0o777);
                next(); return;
            } else if (header.type === 'symlink' || header.type === 'link') {
                // Materialize Unix library links after extraction. This also works
                // on Windows hosts that cannot create Unix symbolic links.
                const target = containedPath(directory, header.type === 'link' ? header.linkname : path.relative(directory, path.resolve(path.dirname(destination), header.linkname)));
                links.push({ destination, target });
            } else throw new Error(`Unsupported runtime archive entry: ${header.type}`);
            stream.resume(); stream.once('end', next);
        })().catch(error => extract.destroy(error));
    });
    await pipeline(fs.createReadStream(archive), createGunzip(), extract);
    for (let pass = 0; links.length && pass < 10; pass++) {
        for (let index = links.length - 1; index >= 0; index--) {
            const { destination, target } = links[index];
            if (!fs.existsSync(target)) continue;
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(target, destination); links.splice(index, 1);
        }
    }
    if (links.length) throw new Error('Unresolved runtime library links.');
}

function flattenRuntime(directory, executable) {
    if (!fs.existsSync(directory)) return;
    const nested = fs.readdirSync(directory, { withFileTypes: true }).find(item => item.isDirectory() && fs.existsSync(path.join(directory, item.name, executable)));
    if (!nested) return;
    const target = path.resolve(directory, nested.name);
    // Delete only this verified, generated extraction subdirectory, after copying
    // its files. Avoid shipping a duplicate runtime inside its original wrapper.
    if (path.dirname(target) !== path.resolve(directory)) throw new Error('Unsafe runtime wrapper directory.');
    for (const file of fs.readdirSync(target)) fs.cpSync(path.join(target, file), path.join(directory, file), { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
}

for (const backend of ['vulkan', 'cpu']) {
    const asset = platform === 'linux' ? manifest.linuxRuntime[backend] : manifest.runtime[backend];
    const directory = path.join(root, 'resources', 'runtime', platform + '-x64', backend);
    const executable = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const stamp = path.join(directory, 'release.json');
    flattenRuntime(directory, executable);
    if (fs.existsSync(stamp) && JSON.parse(fs.readFileSync(stamp)).sha256 === asset.sha256 && fs.existsSync(path.join(directory, executable))) continue;
    const extension = platform === 'linux' ? 'tar.gz' : 'zip';
    const archive = await downloadVerified(asset, path.join(root, 'build-cache', `llama-${manifest.runtime.version}-${platform}-${backend}.${extension}`));
    fs.mkdirSync(directory, { recursive: true });
    if (platform === 'linux') await extractLinux(archive, directory);
    else if (process.platform === 'win32') {
        // Environment values avoid interpolating filesystem paths as shell code.
        await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:ALETHEIA_ASSET_ZIP -DestinationPath $env:ALETHEIA_ASSET_DEST -Force'], { ALETHEIA_ASSET_ZIP: archive, ALETHEIA_ASSET_DEST: directory });
    } else await execute('unzip', ['-o', archive, '-d', directory]);
    flattenRuntime(directory, executable);
    if (!fs.existsSync(path.join(directory, executable))) throw new Error(`The runtime archive does not contain ${executable}.`);
    fs.writeFileSync(stamp, JSON.stringify({ version: manifest.runtime.version, platform, arch: 'x64', sha256: asset.sha256 }));
    console.log(`Prepared ${platform} ${backend} runtime ${manifest.runtime.version}`);
}
for (const asset of manifest.embedding.files ?? []) {
    await downloadVerified(asset, path.join(root, 'resources', 'embedding', asset.filename));
    console.log(`Prepared search model: ${asset.filename}`);
}
if (!manifest.embedding.files?.length) throw new Error('The pinned embedding file manifest is missing.');
for (const [url, filename] of [
    [`https://raw.githubusercontent.com/ggml-org/llama.cpp/${manifest.runtime.version}/LICENSE`, 'runtime/LICENSE'],
    ['https://raw.githubusercontent.com/FlagOpen/FlagEmbedding/master/LICENSE', 'embedding/LICENSE'],
]) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not retrieve notice ${filename}: ${response.status}`);
    fs.writeFileSync(path.join(root, 'resources', filename), await response.text());
}

// One artwork source supplies Windows ICO and Linux desktop/installer PNGs.
const { default: sharp } = await import('sharp');
const png = await sharp(path.join(root, 'artwork', 'icon.svg')).resize(256, 256).png().toBuffer();
fs.mkdirSync(path.join(root, 'build-cache'), { recursive: true });
fs.writeFileSync(path.join(root, 'build-cache', 'icon.png'), png);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(root, 'build-cache', 'icon.ico'), Buffer.concat([header, png]));
console.log(`${platform} runtime and offline search assets are ready.`);
