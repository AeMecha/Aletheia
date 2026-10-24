/**
 * Write a standard Debian binary package from electron-builder's Linux folder.
 * A .deb is an ar container with three members: debian-binary, control.tar.gz,
 * data.tar.gz. Using Node streams preserves executable modes when cross-built
 * on Windows, and avoids needing Docker, WSL or a foreign fpm executable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import tar from 'tar-stream';

export function assertLinuxExecutable(filename) {
    const fd = fs.openSync(filename, 'r');
    const header = Buffer.alloc(20);
    try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
    if (header.subarray(0, 4).toString('hex') !== '7f454c46' || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) throw new Error(`Expected a Linux x64 ELF executable: ${filename}`);
}

// Permissions are set in the TAR, not inferred from NTFS. ELF libraries and
// executable helpers need their Unix executable bits after installation.
function fileMode(filename) {
    const fd = fs.openSync(filename, 'r');
    const header = Buffer.alloc(4);
    try { fs.readSync(fd, header); } finally { fs.closeSync(fd); }
    return header.toString('hex') === '7f454c46' || header.subarray(0, 2).toString() === '#!' ? 0o755 : 0o644;
}
function* tree(directory, prefix, root = directory) {
    yield { name: prefix, type: 'directory', mode: 0o755 };
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const filename = path.join(directory, entry.name);
        const name = prefix + '/' + entry.name;
        if (entry.isDirectory()) yield* tree(filename, name, root);
        else if (entry.isSymbolicLink()) {
            const linkname = fs.readlinkSync(filename);
            const relative = path.relative(root, path.resolve(path.dirname(filename), linkname));
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('A packaged symlink escapes the application directory.');
            yield { name, type: 'symlink', linkname, mode: 0o777 };
        } else if (entry.isFile()) yield { name, filename, size: fs.statSync(filename).size, mode: fileMode(filename) };
    }
}

export async function writeTarGz(destination, entries) {
    const pack = tar.pack();
    const output = pipeline(pack, createGzip({ level: 9 }), fs.createWriteStream(destination));
    // Attach a rejection handler while files are being fed to avoid an unhandled
    // rejection if a disk error closes the output before the input loop finishes.
    output.catch(() => {});
    try {
        for (const entry of entries) {
            const { filename, content, ...header } = entry;
            const body = content === undefined ? undefined : Buffer.from(content);
            const stream = pack.entry({ uid: 0, gid: 0, uname: 'root', gname: 'root', mtime: new Date(0), ...header, ...(body ? { size: body.length } : {}) });
            if (filename) await pipeline(fs.createReadStream(filename), stream);
            else { stream.end(body); await new Promise((resolve, reject) => { stream.once('finish', resolve); stream.once('error', reject); }); }
        }
        pack.finalize();
        await output;
    } catch (error) { pack.destroy(error); await output.catch(() => {}); throw error; }
}

export async function writeDeb(destination, members) {
    async function* bytes() {
        yield Buffer.from('!<arch>\n');
        for (const { name, filename, content } of members) {
            const data = content === undefined ? undefined : Buffer.from(content);
            const size = data ? data.length : fs.statSync(filename).size;
            // System V ar fixed-width header. Debian member names fit in 16 bytes.
            yield Buffer.from((name + '/').padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(size).padEnd(10) + '`\n');
            if (data) yield data;
            else for await (const chunk of fs.createReadStream(filename)) yield chunk;
            if (size % 2) yield Buffer.from('\n');
        }
    }
    await pipeline(Readable.from(bytes()), fs.createWriteStream(destination));
}

// Match Electron's packaging convention: keep Chromium's sandbox enabled. On
// Ubuntu 24+ a narrowly scoped AppArmor profile permits this app's user namespace
// sandbox. Older systems can use the root-owned SUID sandbox helper instead.
export const postinst = `#!/bin/sh
set -e
if [ "$1" = configure ]; then
    chown root:root /opt/Aletheia/chrome-sandbox
    chmod 4755 /opt/Aletheia/chrome-sandbox
    # Copy/load the Ubuntu 24 profile only when the installed parser supports it.
    # Leaving unsupported userns syntax in /etc would break older AppArmor boots.
    if command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser --skip-kernel-load --debug /opt/Aletheia/resources/apparmor-profile >/dev/null 2>&1; then
        install -m 644 /opt/Aletheia/resources/apparmor-profile /etc/apparmor.d/aletheia
        apparmor_parser -r /etc/apparmor.d/aletheia || true
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
fi
`;
const postrm = `#!/bin/sh
set -e
case "$1" in
    remove|purge)
        if [ -f /etc/apparmor.d/aletheia ]; then
            if command -v apparmor_parser >/dev/null 2>&1; then apparmor_parser -R /etc/apparmor.d/aletheia 2>/dev/null || true; fi
            rm -f /etc/apparmor.d/aletheia
        fi
        ;;
esac
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
`;
export async function packageDebian(root) {
    const directory = path.join(root, 'dist', 'linux-unpacked');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    assertLinuxExecutable(path.join(directory, 'aletheia'));
    for (const backend of ['cpu', 'vulkan']) assertLinuxExecutable(path.join(directory, 'resources/aletheia/runtime', backend, 'llama-server'));
    // Fail early if cross-building accidentally retained the host's native addon.
    const unpacked = path.join(directory, 'resources/app.asar.unpacked/node_modules');
    assertLinuxExecutable(path.join(unpacked, 'onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node'));
    const sharpDirectory = path.join(unpacked, '@img/sharp-linux-x64/lib');
    const sharpAddon = fs.readdirSync(sharpDirectory).find(name => /^sharp-linux-x64(?:-[\d.]+)?\.node$/.test(name));
    if (!sharpAddon) throw new Error('The Linux sharp native addon is missing.');
    assertLinuxExecutable(path.join(sharpDirectory, sharpAddon));
    const cache = path.join(root, 'build-cache', 'debian');
    fs.mkdirSync(cache, { recursive: true });
    const data = path.join(cache, 'data.tar.gz');
    const control = path.join(cache, 'control.tar.gz');
    const desktop = '[Desktop Entry]\nType=Application\nName=Aletheia\nComment=Your local knowledge archive\nExec=/opt/Aletheia/aletheia\nIcon=aletheia\nTerminal=false\nCategories=Office;Utility;\nStartupWMClass=Aletheia\n';
    const profile = 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile aletheia /opt/Aletheia/aletheia flags=(unconfined) {\n  userns,\n  include if exists <local/aletheia>\n}\n';
    const parents = ['.', './opt', './usr', './usr/bin', './usr/share', './usr/share/applications', './usr/share/icons', './usr/share/icons/hicolor', './usr/share/icons/hicolor/256x256', './usr/share/icons/hicolor/256x256/apps', './usr/share/doc', './usr/share/doc/aletheia', './etc', './etc/apparmor.d'];
    const entries = [...parents.map(name => ({ name, type: 'directory', mode: 0o755 })), ...tree(directory, './opt/Aletheia'),
        { name: './usr/bin/aletheia', type: 'symlink', linkname: '/opt/Aletheia/aletheia', mode: 0o777 },
        { name: './usr/share/applications/aletheia.desktop', content: desktop, mode: 0o644 },
        { name: './usr/share/icons/hicolor/256x256/apps/aletheia.png', filename: path.join(root, 'build-cache/icon.png'), size: fs.statSync(path.join(root, 'build-cache/icon.png')).size, mode: 0o644 },
        { name: './opt/Aletheia/resources/apparmor-profile', content: profile, mode: 0o644 },
        { name: './usr/share/doc/aletheia/copyright', filename: path.join(root, 'LICENSE'), size: fs.statSync(path.join(root, 'LICENSE')).size, mode: 0o644 },
    ];
    await writeTarGz(data, entries);
    const installedSize = Math.ceil(entries.reduce((sum, entry) => sum + (entry.size || Buffer.byteLength(entry.content || '')), 0) / 1024);
    // Both libasound names are accepted across Ubuntu's t64 transition. Vulkan
    // is recommended; the bundled CPU engine supports machines without a GPU.
    const metadata = `Package: aletheia
Version: ${version}
Section: utils
Priority: optional
Architecture: amd64
Maintainer: Aletheia contributors <aletheia@localhost>
Installed-Size: ${installedSize}
Depends: libc6 (>= 2.36), libstdc++6 (>= 12), libgcc-s1, libgomp1, libssl3 (>= 3.0) | libssl3t64 (>= 3.0), libdbus-1-3, libexpat1, libudev1, libxkbcommon0, libglib2.0-0 | libglib2.0-0t64, libatspi2.0-0 | libatspi2.0-0t64, libgtk-3-0 | libgtk-3-0t64, libnss3, libnspr4, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libdrm2, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libgbm1, libasound2 | libasound2t64, libpango-1.0-0, libcairo2, libcups2 | libcups2t64
Recommends: libvulkan1
Description: A standalone local personal knowledge archive
 Run Qwen locally, prepare Markdown records, and search your own library.
 Supports an optional LM Studio connection. Model weights are selected or
 downloaded on first launch. Original documents stay in your user profile.
`;
    await writeTarGz(control, [
        { name: './control', content: metadata, mode: 0o644 },
        { name: './postinst', content: postinst, mode: 0o755 },
        { name: './postrm', content: postrm, mode: 0o755 },
    ]);
    const output = path.join(root, 'dist', `Aletheia-${version}-linux-amd64.deb`);
    await writeDeb(output, [{ name: 'debian-binary', content: '2.0\n' }, { name: 'control.tar.gz', filename: control }, { name: 'data.tar.gz', filename: data }]);
    console.log(`Built Ubuntu/Debian installer: ${output}`);
}
