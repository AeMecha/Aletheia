/** Shared packaging rules. Only the selected platform's native libraries and
 * engine are shipped. Keeping this as JavaScript allows the rules to be
 * documented rather than hiding platform decisions inside package.json. */
module.exports = function packaging(platform) {
    const otherPlatforms = platform === 'linux' ? ['win32', 'darwin'] : ['linux', 'darwin'];
    return {
        appId: 'app.aletheia.library', productName: 'Aletheia',
        asar: true, npmRebuild: false,
        asarUnpack: ['node_modules/onnxruntime-node/**', 'node_modules/sharp/**', 'node_modules/@img/**'],
        directories: { output: 'dist' },
        files: [
            'src/**', 'renderer/**', 'prompts/**', 'assets.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'package.json',
            ...otherPlatforms.map(name => `!**/node_modules/onnxruntime-node/bin/napi-v6/${name}/**`),
            `!**/node_modules/onnxruntime-node/bin/napi-v6/${platform}/arm64/**`,
            '!**/node_modules/onnxruntime-web/dist/**',
            '!**/node_modules/@huggingface/transformers/dist/transformers.web*',
        ],
        extraResources: [
            { from: 'resources/embedding', to: 'aletheia/embedding' },
            { from: 'resources/runtime/LICENSE', to: 'aletheia/runtime/LICENSE' },
            { from: `resources/runtime/${platform}-x64`, to: 'aletheia/runtime' },
        ],
        win: { target: 'nsis', signExecutable: false, icon: 'build-cache/icon.ico' },
        linux: { executableName: 'aletheia', category: 'Office', icon: 'build-cache/icon.png' },
        artifactName: 'Aletheia-Setup-${version}.${ext}',
        nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, deleteAppDataOnUninstall: false },
    };
};
