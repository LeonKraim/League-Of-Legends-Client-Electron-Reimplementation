/**
 * Test Patch 2: CSS color override for lol-uikit
 *
 * Targets the main CSS file of rcp-fe-lol-uikit (extracted from WAD)
 * and overrides the root background color to a very dark blue.
 *
 * Since we don't know the exact .css content without extracting first,
 * this patch tries multiple common CSS patterns for the body/root background.
 */

// target: "asset" — this patch modifies WAD-extracted CSS assets on-the-fly
module.exports = {
  id: "uikit-dark-bg",
  description: "Overrides body background color in lol-uikit CSS",
  target: "asset",
  enabled: true,

  match: {
    pluginPrefix: "rcp-fe-lol-uikit",
    file: "main.css",
  },

  transforms: [
    {
      type: "regex",
      pattern: /background(?:\-color)?\s*:\s*#[0-9a-fA-F]{3,6}\s*(?:!important)?\s*;?\s*\}/g,
      replace: "background: #050d1a !important; }",
      flags: "g",
    },
    {
      type: "prepend-once",
      marker: "/* FE-PATCHER:dark-bg */",
      content: "/* FE-PATCHER:dark-bg */ body, html { background: #050d1a !important; }\n",
    }
  ]
};
