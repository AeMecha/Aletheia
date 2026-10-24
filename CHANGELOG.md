# Changelog

## 0.2.0

- Accept compatible instruction/chat GGUF files instead of restricting selection to the default Qwen checksum.
- Add configurable Chat Completions API connections with model IDs, optional model discovery, LM Studio/Ollama presets and local settings migration.
- Add bounded schema/JSON/prompt response negotiation and an API output-token parameter choice while retaining all output and citation validation.
- Use the selected model's name throughout the interface; keep the verified Qwen download as the default option.
- Extend context choices and document model requirements, API compatibility and local/remote data behavior.
- Add model migration, transport, local-runtime and full desktop API checks.

## 0.1.2

- Answer broad archive questions using the full indexed inventory, including exact document totals, common metadata types/topics and real title examples with source links.
- Add an Archive overview button that works without a configured AI model.
- Offer useful next steps when topical search finds no matching passage.
- Add explanatory source comments and an architecture guide.
- Add Ubuntu 24.04+ and Debian 12+ x64 packaging, platform-specific CPU/Vulkan engines, native dependencies, desktop integration and sandbox setup.
- Add regression and package integrity checks, plus native Windows/Ubuntu release builds with packaged-app checks.
- Publish installers, corresponding source and verified checksums together through the release workflow.

## 0.1.1

- Remove personalized decorative quotes.
- Allow archived document titles to be edited while preserving IDs, filenames and original content.
- Repair document preparation by generating bounded metadata and retaining the complete original body for review.
- Add persistent light/dark mode.

## 0.1.0

- Introduce the standalone Windows desktop app with local Markdown storage, offline hybrid search, and the exact `qwen3.8-9b-hermes-fc-tooluse` model.
- Bundle the inference engine and search model, with Qwen weights selected or downloaded at first launch.
- Support LM Studio as an optional connection.
