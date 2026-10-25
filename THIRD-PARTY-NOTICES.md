# Third-party components

Aletheia Scriptorium includes original/adapted material from [Aletheia](https://github.com/AdeptTel1/Aletheia) by **Adeptus Telvannus (AdeptTel1)**. That covered material retains the [original custom license](LICENSES/LicenseRef-AdeptTel1-Aletheia.txt); it is not relicensed under the AGPL. See LICENSE, LICENSING.md, NOTICE and ATTRIBUTION.md for scope, provenance and material changes. The AGPL text retained for separately authored contributions is in LICENSES/AGPL-3.0-only.txt. Other components retain the following notices.

The installer includes Electron (MIT), llama.cpp (MIT), Transformers.js (Apache-2.0), ONNX Runtime (MIT), and the ONNX conversion of BAAI/bge-small-en-v1.5 (MIT). Their notices and license files are retained in the dependency and resource directories. See https://github.com/electron/electron, https://github.com/ggml-org/llama.cpp, https://github.com/huggingface/transformers.js, https://github.com/microsoft/onnxruntime, and https://huggingface.co/BAAI/bge-small-en-v1.5.

The optional default Qwen model is obtained separately during setup or imported from an existing local GGUF. Its publisher identifies it as Apache-2.0: https://huggingface.co/JamieBradfield/qwen3.8-9b-hermes-fc-tooluse. The exact quantized artifact is pinned in assets.json. Model notices are saved alongside downloaded weights.

Other user-selected models and API services retain their own licenses and terms; they are not bundled with Aletheia.

Redistributions must include the corresponding Aletheia source and preserve applicable notices. The app's source, dependency lockfile, and build instructions are supplied in this project.
