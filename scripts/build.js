/** Build the desktop for Windows or Ubuntu/Debian. Native Node-API dependencies
 * are prebuilt upstream. Cross-building stages Linux production dependencies in
 * a separate app directory, so Windows development dependencies stay usable. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { build, Platform, Arch } from 'electron-builder';
import packaging from '../packaging.cjs';
import { packageDebian } from './package-linux.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--platform');
const platform = index < 0 ? process.platform : process.argv[index + 1];
if (!['win32', 'linux'].includes(platform) || process.arch !== 'x64') throw new Error('Supported build targets: win32/linux x64.');
function run(command, args, cwd = root) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    });
}
await run(process.execPath, [path.join(root, 'scripts/prepare-assets.js'), '--platform', platform]);
const config = packaging(platform);
if (platform === 'linux' && process.platform !== 'linux') {
    const stage = path.join(root, 'build-cache', 'linux-app');
    fs.mkdirSync(stage, { recursive: true });
    for (const name of ['src', 'renderer', 'prompts', 'assets.json', 'LICENSE', 'LICENSES', 'NOTICE', 'LICENSING.md', 'ATTRIBUTION.md', 'UPSTREAM-PROVENANCE.json', 'THIRD-PARTY-NOTICES.md', 'package.json', 'package-lock.json']) {
        fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
    }
    // Invoke npm's JS entry directly on Windows; .cmd cannot be spawned without
    // a shell, and shell interpolation would make paths needlessly fragile.
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Use npm run build:linux so the npm executable is available.');
    await run(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--os=linux', '--cpu=x64', '--libc=glibc', '--cache', path.join(root, 'build-cache/npm')], stage);
    config.directories.app = stage;
}
// Extra resource paths always refer to the project, even with a staged app dir.
for (const resource of config.extraResources) resource.from = path.join(root, resource.from);
config.directories.output = path.join(root, 'dist');
config.win.icon = path.join(root, config.win.icon);
config.linux.icon = path.join(root, config.linux.icon);
const target = platform === 'linux' ? Platform.LINUX : Platform.WINDOWS;
// electron-builder otherwise tries to publish automatically on tagged CI runs.
// Only the separate release job may upload after both platforms are verified.
await build({ projectDir: root, targets: target.createTarget(platform === 'linux' || process.argv.includes('--dir') ? ['dir'] : ['nsis'], Arch.x64), config, publish: 'never' });
if (platform === 'linux' && !process.argv.includes('--dir')) await packageDebian(root);
