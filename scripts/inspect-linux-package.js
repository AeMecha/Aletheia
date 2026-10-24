/** Independent read-back of the generated .deb. Inspect ar headers and TAR
 * metadata without extracting to disk or executing any foreign binaries. */
import fs from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import tar from 'tar-stream';

export async function inspectDeb(filename) {
    const file = fs.openSync(filename, 'r');
    const members = [];
    try {
        const magic = Buffer.alloc(8); fs.readSync(file, magic, 0, 8, 0);
        if (magic.toString() !== '!<arch>\n') throw new Error('Invalid Debian ar signature.');
        let offset = 8;
        while (offset < fs.statSync(filename).size) {
            const header = Buffer.alloc(60); fs.readSync(file, header, 0, 60, offset);
            if (header.subarray(58).toString() !== '`\n') throw new Error('Invalid ar member header.');
            const name = header.subarray(0, 16).toString().trim().replace(/\/$/, '');
            const size = Number(header.subarray(48, 58).toString().trim());
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid ar member size.');
            members.push({ name, start: offset + 60, end: offset + 60 + size - 1 });
            offset += 60 + size + size % 2;
        }
    } finally { fs.closeSync(file); }
    if (members.map(member => member.name).join(',') !== 'debian-binary,control.tar.gz,data.tar.gz') throw new Error('Unexpected Debian members.');
    let control = '';
    let files = 0;
    const executables = new Set();
    let desktop = false;
    for (const member of members.slice(1)) {
        const extract = tar.extract();
        extract.on('entry', (header, stream, next) => {
            const name = header.name.replace(/^\.\//, '');
            if (header.uid !== 0 || header.gid !== 0 || name.split('/').includes('..')) { extract.destroy(new Error('Invalid archive ownership/path.')); return; }
            const isControl = member.name === 'control.tar.gz';
            const expected = name === 'opt/Aletheia/aletheia' || /opt\/Aletheia\/resources\/aletheia\/runtime\/(cpu|vulkan)\/llama-server$/.test(name) || /onnxruntime_binding\.node$|sharp-linux-x64(?:-[\d.]+)?\.node$/.test(name);
            let prefix = Buffer.alloc(0);
            stream.on('data', chunk => {
                if (prefix.length < 2048) prefix = Buffer.concat([prefix, chunk.subarray(0, 2048 - prefix.length)]);
            });
            stream.on('end', () => {
                try {
                    if (isControl && name === 'control') control = prefix.toString();
                    if (isControl && /^post(inst|rm)$/.test(name) && (header.mode & 0o777) !== 0o755) throw new Error('Maintainer script is not executable.');
                    if (!isControl) {
                        files++;
                        if (/\.(exe|dll)$/i.test(name)) throw new Error('Windows binary leaked into Linux package.');
                        if (expected) {
                            if ((header.mode & 0o111) !== 0o111 || prefix.subarray(0, 4).toString('hex') !== '7f454c46' || prefix.readUInt16LE(18) !== 62) throw new Error(`Invalid Linux executable or permissions: ${name}`);
                            executables.add(name);
                        }
                        if (name === 'usr/share/applications/aletheia.desktop') desktop = prefix.toString().includes('Exec=/opt/Aletheia/aletheia');
                    }
                    next();
                } catch (error) { extract.destroy(error); }
            });
            stream.resume();
        });
        await pipeline(fs.createReadStream(filename, { start: member.start, end: member.end }), createGunzip(), extract);
    }
    if (!control.includes('Package: aletheia\n') || !control.includes('Architecture: amd64\n') || !desktop || executables.size !== 5) throw new Error('Required Linux package components are missing.');
    return { passed: true, package: path.basename(filename), files, executables: [...executables], desktopLauncher: desktop, control };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const filename = process.argv[2] || path.join(root, 'dist', `Aletheia-${version}-linux-amd64.deb`);
    const result = await inspectDeb(filename);
    fs.mkdirSync(path.join(root, 'test-output'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test-output', 'linux-package-verification.json'), JSON.stringify(result, null, 2));
    console.log(`PASS: Debian package, ${result.files} entries, 5 Linux native executables, root ownership, executable modes and desktop launcher.`);
}
