# Configurable AI verification

Checked on October 24, 2026 for version 0.2.0.

The 29 deterministic tests cover existing archive behavior plus legacy connection migration, custom GGUF selection, default-download preservation, local runtime arguments, API model IDs/aliases, authentication headers, missing model discovery, response-format negotiation, output-budget selection and unchanged metadata/citation validation. Tests use temporary directories, synthetic GGUF headers and simulated HTTP responses.

The Windows Electron desktop check uses the real renderer, preload, application, BGE search and a local synthetic HTTP server. It verifies model discovery, saving a non-Qwen API model and response budget, document preparation that preserves the original input, and a Librarian answer with a real archive citation. Both themes, saved preferences, inventory and title edits remain covered. No paid or external model API was called.

Real local CPU checks with synthetic source text passed for the default Qwen GGUF and a separate Llama-based GGUF. Both produced completed document metadata and an answer citing the supplied source. The Llama file's JSON grammar initialization rejection exposed the need for bounded format fallback. A separate Gemma 2 9B GGUF loaded successfully but timed out during generation; its completed-output behavior remains unverified. These checks do not establish that every GGUF or model architecture works.

Run `node scripts/model-smoke.js /absolute/path/to/model.gguf` to check another local model without copying its weights or changing the normal app profile. Only synthetic text is sent to the owned CPU engine, which closes afterward. The default Qwen download remains pinned and verified separately by the existing resumable-download checks.

Tagged releases additionally run the regression suite and native Windows/Ubuntu packaged-archive checks in GitHub Actions. Those Linux checks do not run a large generation model. Release status and installer digests are available on the matching GitHub release/workflow run.
