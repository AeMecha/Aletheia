# Aletheia desktop

A standalone Windows and Linux x64 personal knowledge library. Open Aletheia to use the Librarian, prepare documents with the Archivist, browse original Markdown, and use a compatible local AI model or a Chat Completions API. The default model download is `qwen3.8-9b-hermes-fc-tooluse`. SillyTavern, Python, Node.js and LM Studio are not required by the installed app.

Download the installers from [GitHub Releases](https://github.com/AeMecha/Aletheia/releases): [Windows setup](https://github.com/AeMecha/Aletheia/releases/download/v0.2.0/Aletheia-Setup-0.2.0.exe) or [Ubuntu/Debian amd64](https://github.com/AeMecha/Aletheia/releases/download/v0.2.0/Aletheia-0.2.0-linux-amd64.deb). Each release includes the corresponding source archive and SHA-256 checksums.

This repository contains the application source. The build commands below create installers in `dist/`; user profiles and Qwen weights are excluded from Git.

## Run the packaged app

Run `dist/Aletheia-Setup-0.2.0.exe`, or open `dist/win-unpacked/Aletheia.exe` while keeping the entire `win-unpacked` directory together. Close a running older version before installing the update. The installer is unsigned.

On first launch, choose a compatible instruction/chat GGUF, download the default `qwen3.8-9b-hermes-fc-tooluse.Q4_K_S.gguf` (5,487,183,744 bytes), or configure an API in Settings. The default download is verified by SHA-256 and interrupted downloads resume. User-selected GGUFs are checked as containers and then loaded by the engine; they do not have to match the default model. Subsequent launches restore the selected connection. The app ships its own GPU and CPU engines and the small search model; after model setup, built-in mode requires no network access.

The installer excludes the 5.5 GB Qwen weights. A distributor can supply that file alongside the installer for offline setup. Selecting an existing model references it in place; keep that file available. Copy it into a permanent folder before selection if it is on removable or network storage.

## Choose your AI model

**Local model:** choose a GGUF instruction/chat model supported by the bundled llama.cpp engine. It needs an embedded chat template and enough available RAM/VRAM for its weights and chosen context size. A GGUF extension alone does not make a base model, embedding model, projector, or unsupported architecture suitable. Other weight formats, such as safetensors, require a separate compatible server. Selecting a local file references it in place and does not copy or alter it. Qwen remains the optional default download, with its previously tested settings.

**API connection:** set an OpenAI-compatible **Chat Completions** base URL, API key if needed, and the model ID provided by that server. LM Studio and Ollama presets fill their usual local addresses (`http://127.0.0.1:1234/v1` and `http://localhost:11434/v1`). Custom local and hosted endpoints can use any base path. Do not append `/chat/completions`; Aletheia adds it. **Fetch available models** queries `/models` using the current form fields. Manual model IDs work with servers that do not implement discovery. Existing v0.1.x LM Studio settings migrate automatically.

The API must accept Chat Completions messages and return `choices[].message.content` with a completed response. APIs using only a different native protocol (for example, Messages, generateContent, or Responses) require a compatible endpoint or gateway; this version does not translate those protocols. Remote services can resolve model aliases to versioned response IDs; Aletheia sends your selected ID without requiring a Qwen identity.

Choose an instruction-following model that can produce faithful summaries and structured JSON. Tool calling is not required. **Model compatibility > Structured responses** defaults to automatic negotiation: JSON schema, then JSON mode, then a schema described in the prompt. Fallback happens only after an explicit format rejection (or a local grammar initialization error), not after authentication, quota, or malformed model-output failures. You can choose a format explicitly. All modes retain the same document, answer, and citation validators; weaker models can still fail these checks. For APIs that require it, select `max_completion_tokens` instead of the default `max_tokens` in Model compatibility.

Set context size to a value your model and deployment support. Model compatibility also offers a response token budget; reasoning models may need more than the 1,536-token default to finish, and the response is capped by the remaining context. Aletheia measures local context with the engine tokenizer and uses a conservative UTF-8 byte estimate for APIs. Larger local contexts consume more memory. The bundled offline search model stays the same when generation models change, so switching AI models does not require rebuilding the archive.

A remote API receives the current input and retrieved excerpts. Local-model mode keeps generation on the computer. API keys are saved in the user's local settings file; keep profile backups private. Model/provider licenses and service terms remain separate from Aletheia's license.

## Install on Ubuntu or Debian

The Linux build targets **Ubuntu 24.04+ or Debian 12+, x64/amd64** with a desktop environment and a CPU with **SSE4.2** (required by the bundled native search dependency). Download/copy `dist/Aletheia-0.2.0-linux-amd64.deb` onto that computer, open a terminal in its directory, and run:

```sh
sudo apt install ./Aletheia-0.2.0-linux-amd64.deb
```

Open **Aletheia** from the applications menu, or run `aletheia`. The installer supplies the desktop app, native search libraries, and both Linux inference engines. Apt installs system desktop libraries if needed. Choose a compatible GGUF, download the default Qwen, or configure an API on first launch. The model and archive do not have to live inside the installation directory.

The package installs into `/opt/Aletheia` and preserves the Chromium sandbox. It includes an application-specific AppArmor profile for Ubuntu and the standard root-owned sandbox helper. Removal via `sudo apt remove aletheia` leaves the user's library, settings and models in place. ARM64 and older distributions are not included in this release.

**Release checks:** tagged builds run on Windows and Ubuntu. The Linux job installs the Debian package, starts the bundled CPU engine and checks archive/search operations through the packaged renderer. These checks use synthetic records without downloading Qwen; full Qwen generation on Linux still requires a real-model check. The Windows Qwen engine was tested locally with the exact model.

## Bring your archive

Use Your library > Import documents / Import folder to copy Markdown into the app. Imported Metadata IDs and original content are preserved where present; conflicting IDs produce errors. The original files are left in place. The legacy Binder's `knowledge/` directory can be imported this way; this app does not automatically reach into the remote Binder service.

The default data directory is `%APPDATA%/Aletheia/` on Windows, or `$XDG_CONFIG_HOME/Aletheia/` (normally `~/.config/Aletheia/`) on Linux. Settings displays the actual path. It contains `knowledge/` (authoritative Markdown), `archive.sqlite3` (derived search index), `models/` (downloaded Qwen weights), and conversation JSON files. Back up this directory and any externally selected model. New conversations preserve their prior messages in `conversations/`. Uninstalling does not delete app data.

The app rescans Markdown every 15 seconds and before a Librarian answer. Topical search combines SQLite FTS5 with Porter stemming and local BGE embeddings; it retrieves selected passages. Broad questions such as **"What does my archive contain?"** and the **Archive overview** button instead read the complete index: exact document count, common types, explicit metadata topics, and up to 12 real titles with source buttons. No AI connection is needed for this overview. It identifies empty archives directly and fails visibly if the index is unavailable. A similarity threshold of 0.65 is preliminary and should be calibrated for a real archive. Original text is never rewritten by searching. The BGE ONNX index is distinct from the old Python/FastEmbed index and is rebuilt from the Markdown imports.

Librarian generation follows an awaited search and validates the entire structured answer and source IDs before displaying it. Retrieved documents remain quoted data. Prepare document asks the selected AI model for a title, short summary, keywords, and document type; the app retains the complete original text as the document body. Longer inputs use bounded excerpts for metadata generation, shown in the review status, while all original text remains in the draft. Rejected responses get one bounded retry. A separate Save action is required; review the generated metadata before saving. Generation can be stopped. The runtime binds to loopback on a dynamic port with a per-session key and is stopped when the app closes. GPU mode falls back to the bundled CPU engine if loading fails.

Open a document in Your library and choose **Edit title** to rename it. Saving updates the Markdown heading, modification time, search index and source buttons while keeping its ID and filename stable. If the file changed outside the app after it was opened, reopen it before editing.

The **Dark mode / Light mode** button in the sidebar applies immediately and saves the choice automatically. It is restored on the next launch and does not restart the AI or interrupt generation.

## Develop and build

Requires Windows or Linux x64, Node.js 24+, npm, and internet access for dependency and asset preparation. Use `npm.cmd` from PowerShell if `npm.ps1` is blocked by execution policy.

Clone the repository and enter its root directory:

```sh
git clone git@github.com:AeMecha/Aletheia.git
cd Aletheia
```

Then, on Windows:

```powershell
npm.cmd ci
# Lifecycle scripts are disabled; install Electron's verified distribution explicitly.
node node_modules/electron/install.js
npm.cmd run prepare:assets
npm.cmd start
npm.cmd test
npm.cmd run build
```

To build the Ubuntu/Debian installer on Linux:

```sh
npm ci
node node_modules/electron/install.js
npm test
npm run build:linux
node scripts/inspect-linux-package.js
```

`npm run build:linux` also supports cross-building from Windows. It stages Linux production dependencies separately, leaving the Windows development environment usable. `npm run build:linux:dir` produces the Linux application folder. `scripts/package-linux.js` writes standard Debian ar/TAR members with Unix permissions, so neither WSL nor Docker is required for cross-packaging.

For a native Linux packaged-app check, run the following with a **new, empty test profile** after installing the package:

```sh
ALETHEIA_HOME="$(mktemp -d /tmp/aletheia-verify-XXXXXX)" aletheia --verify-archive
```

This check uses the real preload bridge, bundled BGE, native ONNX and SQLite, writes one synthetic document into that isolated profile, checks the archive overview and saves its result/screenshot there. It does not load Qwen. Full engine verification is available with `--verify-installation` and an isolated profile configured with a compatible model.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module responsibilities, data flow and the invariants explained by the inline comments.

`assets.json` pins official llama.cpp release archives, the bundled search assets and the default Qwen download with SHA-256. The small embedding model is bundled; the large Qwen model downloads at runtime. Build output includes an installer and the unpacked executable. Keep the project source, dependency lockfile and notices with redistributions under the included license. Signing a public release requires your own code-signing identity.

`ALETHEIA_HOME` selects an alternate app data directory. For development it can point to `.local/` inside this project. A real-model check (`npm.cmd run smoke`) uses the model setting in `.local/settings.json`, creates an isolated test library under `test-output/`, and checks retrieval, citations, follow-up, no-match behavior, drafting and saving. It never modifies your normal archive or model file.

For the Electron UI check, set `ALETHEIA_UI_TEST=1` and `ALETHEIA_HOME` to a **new empty test directory**, then run `npm.cmd start`. The development-only check exercises the real preload bridge, writes a clearly labeled fixture into that test profile, and saves screenshots to `test-output/desktop/`. This harness is excluded from the installer.

`node scripts/draft-smoke.js` checks short text, existing Markdown and a long note against the local engine using CPU mode. The connection in `.local/settings.json` can instead point to an API and any selected model ID. `--lmstudio http://127.0.0.1:1234/v1` remains a shortcut for that endpoint. Synthetic response captures and results stay in `test-output/`. `node scripts/model-smoke.js /absolute/path/to/model.gguf` checks a selected GGUF with an owned CPU engine and synthetic drafting/citation requests, without changing the normal profile.

This repository contains the standalone desktop app. Legacy SillyTavern services, cards, chats and Binder files are not migrated or removed by building it.

## Publish a release

Update the version and release notes under `docs/releases/`, then push the matching `v<version>` tag. The release workflow tests and builds Windows and Ubuntu packages, checks the packaged applications, and creates a source ZIP from that exact commit. It uploads all assets to a draft, verifies their sizes and SHA-256 digests, and publishes the complete release. A repository-scoped GitHub Actions token handles publishing; a personal API token is not needed.

## License

Aletheia is licensed under [AGPL-3.0-only](LICENSE), retaining the license used by the adapted integration. See [NOTICE](NOTICE) for attribution and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for dependency and model licenses. Release history is in [CHANGELOG.md](CHANGELOG.md).
