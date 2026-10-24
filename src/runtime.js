import fs from 'node:fs';
import path from 'node:path';

/** Development keeps platforms side by side; installers include one platform.
 * Selecting the executable by platform prevents a mixed development checkout
 * from accidentally launching Windows binaries on Linux or vice versa. */
export function runtimeExecutable(resources, backend, platform = process.platform, arch = process.arch) {
    if (!['win32', 'linux'].includes(platform) || arch !== 'x64' || !['cpu', 'vulkan'].includes(backend)) throw new Error('Unsupported model engine platform or backend.');
    const name = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const development = path.join(resources, 'runtime', `${platform}-${arch}`, backend, name);
    return fs.existsSync(development) ? development : path.join(resources, 'runtime', backend, name);
}
