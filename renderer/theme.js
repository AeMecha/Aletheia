// Restore the last applied theme before the page paints. The saved application
// setting is authoritative and refreshes this cache through the preload bridge.
try { document.documentElement.dataset.theme = localStorage.getItem('aletheia.theme') === 'dark' ? 'dark' : 'light'; }
catch { document.documentElement.dataset.theme = 'light'; }
