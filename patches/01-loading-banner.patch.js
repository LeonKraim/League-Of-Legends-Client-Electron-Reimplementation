/**
 * Test Patch 1: Loading Screen Banner
 *
 * Modifies the in-memory generated index.html (our code) to show a banner.
 * This is the simplest possible patch — pure CSS injection into HTML.
 *
 * The HTML_PATCHES system in fe-patcher.js handles this separate from WAD assets.
 * This patch is registered via `addHtmlPatch()` in main.js.
 */

// target: "html" — this patch is applied to the generated index.html (our code)
// NOT to WAD assets. HTML patches are applied via patchHtml() in fe-patcher.js.
module.exports = {
  id: "html-test-banner",
  description: "Injects a 'PATCHED' indicator into the loading screen",
  target: "html",
  enabled: true,

  transforms: [
    {
      type: "replace",
      find: "<h1>Starting Electron League Client</h1>",
      replace: "<h1>⚡ Patched Electron League Client</h1>"
    },
    {
      type: "inject-css",
      position: "before",
      content: `
        .patch-indicator {
          position: fixed;
          bottom: 8px;
          right: 12px;
          padding: 3px 10px;
          background: rgba(200, 170, 110, 0.15);
          border: 1px solid rgba(200, 170, 110, 0.3);
          color: #c8aa6e;
          font-family: monospace;
          font-size: 11px;
          border-radius: 3px;
          z-index: 99999;
          pointer-events: none;
          letter-spacing: 0.05em;
        }
      `
    },
    {
      type: "append",
      content: '<div class="patch-indicator">PATCHED v1.0</div>'
    }
  ]
};
