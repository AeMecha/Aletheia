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
    const clean = message.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log('::error title=Release build command failed::' + clean);
}
child.on('error', error => { annotate(error.message); process.exitCode = 1; });
child.on('close', code => {
    if (code !== 0) annotate(tail);
    process.exitCode = code || process.exitCode || 0;
});
