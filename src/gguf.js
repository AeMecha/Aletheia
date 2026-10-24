/** Check the container before replacing the working model selection. The bundled
 * llama.cpp engine checks architecture, tensors and chat-template support on load;
 * a GGUF header alone cannot guarantee that an arbitrary model is compatible. */
import fs from 'node:fs';
import path from 'node:path';

export function validateGguf(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.gguf') throw new Error('Choose a local GGUF model file.');
    const fd = fs.openSync(filename, 'r');
    try {
        const header = Buffer.alloc(24);
        if (!fs.fstatSync(fd).isFile() || fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.subarray(0, 4).toString() !== 'GGUF' || ![2, 3].includes(header.readUInt32LE(4))) throw new Error('This file is not a supported GGUF container (version 2 or 3). Choose an instruction/chat model compatible with llama.cpp.');
    } finally { fs.closeSync(fd); }
    return filename;
}
