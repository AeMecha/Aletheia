# Third-party components

Aletheia is distributed under AGPL-3.0-only. Its Librarian protocol and prompts were adapted from the local Aletheia integration in SillyTavern. See LICENSE for the license text.

The installer includes Electron (MIT), llama.cpp (MIT), Transformers.js (Apache-2.0), ONNX Runtime (MIT), and the ONNX conversion of BAAI/bge-small-en-v1.5 (MIT). Their notices and license files are retained in the dependency and resource directories. See https://github.com/electron/electron, https://github.com/ggml-org/llama.cpp, https://github.com/huggingface/transformers.js, https://github.com/microsoft/onnxruntime, and https://huggingface.co/BAAI/bge-small-en-v1.5.

The Qwen model is obtained separately during setup or imported from an existing local GGUF. Its publisher identifies it as Apache-2.0: https://huggingface.co/JamieBradfield/qwen3.8-9b-hermes-fc-tooluse. The exact quantized artifact is pinned in assets.json. Model notices are saved alongside downloaded weights.

Redistributions must include the corresponding Aletheia source and preserve applicable notices. The app's source, dependency lockfile, and build instructions are supplied in this project.
