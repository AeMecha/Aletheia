/** Stream a CI command normally and attach its final output to a check annotation
 * on failure. This makes packaging failures visible in the build summary. */
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Specify a command to run.');
let tail = '';
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
function capture(chunk, output) { output.write(chunk); tail = (tail + chunk.toString()).slice(-12000); }
child.stdout.on('data', chunk => capture(chunk, process.stdout));
child.stderr.on('data', chunk => capture(chunk, process.stderr));
function annotate(message) {
    const clean = message.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    // Individual annotations are truncated at 4096 characters. Split the tail so
    // the final exception cannot be hidden by package installation output.
    for (let offset = 0; offset < clean.length; offset += 2000) {
        const part = clean.slice(offset, offset + 2000).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
        console.log('::error title=Release build command failed::' + part);
    }
}
child.on('error', error => { annotate(error.message); process.exitCode = 1; });
child.on('close', code => {
    if (code !== 0) annotate(tail);
    process.exitCode = code === 0 ? 0 : Number.isInteger(code) ? code : 1;
});
