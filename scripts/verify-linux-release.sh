#!/usr/bin/env bash
# Exercise the installed package with native libraries, sandbox and renderer.
# The isolated test profile contains one synthetic document and no model weights.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y ./dist/Aletheia-*-linux-amd64.deb xvfb
engine=/opt/Aletheia/resources/aletheia/runtime/cpu
LD_LIBRARY_PATH="$engine" "$engine/llama-server" --version
# Xvfb has no physical graphics device. Software compositing affects only the
# desktop check; it does not change the app's separate Qwen GPU/CPU engines.
ALETHEIA_HOME="$(mktemp -d /tmp/aletheia-release-XXXXXX)" xvfb-run -a /opt/Aletheia/aletheia --disable-gpu --verify-archive
