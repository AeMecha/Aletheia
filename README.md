# Aletheia desktop

A standalone Windows and Linux x64 personal knowledge library. Open Aletheia to use the Librarian, prepare documents with the Archivist, browse original Markdown, and run `qwen3.8-9b-hermes-fc-tooluse` locally. SillyTavern, Python, Node.js and LM Studio are not required by the installed app.

This repository contains the application source. The build commands below create installers in `dist/`; generated binaries, user profiles and Qwen weights are excluded from Git.

## Run the packaged app

Run `dist/Aletheia-Setup-0.1.2.exe`, or open `dist/win-unpacked/Aletheia.exe` while keeping the entire `win-unpacked` directory together. Close a running older version before installing the update. The installer is unsigned.

On first launch, choose the existing `qwen3.8-9b-hermes-fc-tooluse.Q4_K_S.gguf`, or download it in the app (5,487,183,744 bytes). The exact file is verified by SHA-256. Interrupted downloads resume. Subsequent launches load it automatically. The app ships its own GPU and CPU engines and the small search model; after model setup, built-in mode requires no network access.

The installer excludes the 5.5 GB Qwen weights. A distributor can supply that file alongside the installer for offline setup. Selecting an existing model references it in place; keep that file available. Copy it into a permanent folder before selection if it is on removable or network storage.

Settings > AI connection > LM Studio switches to an optional OpenAI-compatible server. Default address: `http://127.0.0.1:1234/v1`. The selected server must expose the exact ID `qwen3.8-9b-hermes-fc-tooluse`. A remote server receives the current input and retrieved excerpts. Built-in mode stays on the computer.

## Install on Ubuntu or Debian

The Linux build targets **Ubuntu 24.04+ or Debian 12+, x64/amd64** with a desktop environment. Download/copy `dist/Aletheia-0.1.2-linux-amd64.deb` onto that computer, open a terminal in its directory, and run:

```sh
sudo apt install ./Aletheia-0.1.2-linux-amd64.deb
```

Open **Aletheia** from the applications menu, or run `aletheia`. The installer supplies the desktop app, native search libraries, and both Linux inference engines. Apt installs system desktop libraries if needed. Choose/download the same Qwen GGUF on first launch. LM Studio remains optional. The model and archive do not have to live inside the installation directory.

The package installs into `/opt/Aletheia` and preserves the Chromium sandbox. It includes an application-specific AppArmor profile for Ubuntu and the standard root-owned sandbox helper. Removal via `sudo apt remove aletheia` leaves the user's library, settings and models in place. ARM64 and older distributions are not included in this release.

**Verification limit:** this release was cross-built on Windows. Its Debian archive, Linux x64 binaries, dependency selection, ownership, executable permissions and desktop launcher were checked; launching the app on an Ubuntu/Debian desktop still needs a native Linux check. The Windows app was exercised directly.

## Bring your archive

Use Your library > Import documents / Import folder to copy Markdown into the app. Imported Metadata IDs and original content are preserved where present; conflicting IDs produce errors. The original files are left in place. The legacy Binder's `knowledge/` directory can be imported this way; this app does not automatically reach into the remote Binder service.

The default data directory is `%APPDATA%/Aletheia/` on Windows, or `$XDG_CONFIG_HOME/Aletheia/` (normally `~/.config/Aletheia/`) on Linux. Settings displays the actual path. It contains `knowledge/` (authoritative Markdown), `archive.sqlite3` (derived search index), `models/` (downloaded Qwen weights), and conversation JSON files. Back up this directory and any externally selected model. New conversations preserve their prior messages in `conversations/`. Uninstalling does not delete app data.

The app rescans Markdown every 15 seconds and before a Librarian answer. Topical search combines SQLite FTS5 with Porter stemming and local BGE embeddings; it retrieves selected passages. Broad questions such as **"What does my archive contain?"** and the **Archive overview** button instead read the complete index: exact document count, common types, explicit metadata topics, and up to 12 real titles with source buttons. No Qwen connection is needed for this overview. It identifies empty archives directly and fails visibly if the index is unavailable. A similarity threshold of 0.65 is preliminary and should be calibrated for a real archive. Original text is never rewritten by searching. The BGE ONNX index is distinct from the old Python/FastEmbed index and is rebuilt from the Markdown imports.

Librarian generation follows an awaited search and validates the entire structured answer and source IDs before displaying it. Retrieved documents remain quoted data. Prepare document asks Qwen for a title, short summary, keywords, and document type; the app retains the complete original text as the document body. Longer inputs use bounded excerpts for metadata generation, shown in the review status, while all original text remains in the draft. Rejected responses get one bounded retry. A separate Save action is required; review the generated metadata before saving. Generation can be stopped. The runtime binds to loopback on a dynamic port with a per-session key and is stopped when the app closes. GPU mode falls back to the bundled CPU engine if loading fails.

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

This check uses the real preload bridge, bundled BGE, native ONNX and SQLite, writes one synthetic document into that isolated profile, checks the archive overview and saves its result/screenshot there. It does not load Qwen. Full engine verification is available with `--verify-installation` and an isolated profile configured with the verified model.

See [ARCHITECTURE.md](ARCHITECTURE.md) for module responsibilities, data flow and the invariants explained by the inline comments.

`assets.json` pins official llama.cpp release archives and all model assets with SHA-256. The small embedding model is bundled; the large Qwen model downloads at runtime. Build output includes an installer and the unpacked executable. Keep the project source, dependency lockfile and notices with redistributions under the included license. Signing a public release requires your own code-signing identity.

`ALETHEIA_HOME` selects an alternate app data directory. For development it can point to `.local/` inside this project. A real-model check (`npm.cmd run smoke`) uses the model setting in `.local/settings.json`, creates an isolated test library under `test-output/`, and checks retrieval, citations, follow-up, no-match behavior, drafting and saving. It never modifies your normal archive or model file.

For the Electron UI check, set `ALETHEIA_UI_TEST=1` and `ALETHEIA_HOME` to a **new empty test directory**, then run `npm.cmd start`. The development-only check exercises the real preload bridge, writes a clearly labeled fixture into that test profile, and saves screenshots to `test-output/desktop/`. This harness is excluded from the installer.

`node scripts/draft-smoke.js` checks short text, existing Markdown and a long note against the local engine using CPU mode. Add `--lmstudio http://127.0.0.1:1234/v1` to check an optional server. Synthetic response captures and results stay in `test-output/`.

This repository contains the standalone desktop app. Legacy SillyTavern services, cards, chats and Binder files are not migrated or removed by building it.

## License

Aletheia is licensed under [AGPL-3.0-only](LICENSE), retaining the license used by the adapted integration. See [NOTICE](NOTICE) for attribution and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for dependency and model licenses. Release history is in [CHANGELOG.md](CHANGELOG.md).
