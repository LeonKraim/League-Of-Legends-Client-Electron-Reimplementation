/**
 * example-showcase.patch.js
 * ==========================
 * Comprehensive example patch demonstrating ALL features of the
 * FE (Front-End) patching system.
 *
 * This file serves as both a working patch AND documentation for
 * patch authors. Every match rule, transform type, and configuration
 * option is demonstrated here with inline comments.
 *
 * ─── Quick Start ──────────────────────────────────────────────
 *
 *   1. Place .patch.js files in the `patches/` directory
 *   2. Files are auto-loaded at runtime (sorted alphabetically)
 *   3. Set `enabled: false` to disable a patch without deleting it
 *   4. Verify patches work:  node scripts/test-patcher.js
 *
 * ─── Patch File Format ────────────────────────────────────────
 *
 *   module.exports = {
 *     id: "unique-id",            // Required: unique identifier
 *     description: "what it does", // Optional: human-readable label
 *     enabled: true,              // Optional: false = disabled
 *     target: "html" | "asset",   // Optional: restrict to content type
 *     match: { ... },             // Optional: filter rules (AND logic)
 *     transforms: [ ... ]         // Required: ordered transform list
 *   };
 *
 * ─── Match Rule Reference ─────────────────────────────────────
 *
 *   (All rules in the `match` object are combined with AND logic.
 *    Omit the `match` field entirely to match all content.)
 *
 *   plugin: "rcp-fe-lol-uikit"       exact plugin name
 *   plugin: "*"                       wildcard — match any plugin
 *   pluginPrefix: "rcp-fe-lol-"      plugin name starts with prefix
 *   file: "main.css"                  exact filename match
 *   file: /\.css$/                    regex tested against filename/path
 *   ext: ".css"                       file extension (with dot)
 *   ext: [".js", ".mjs"]             array of extensions (OR logic)
 *   customMatch: (asset) => boolean   arbitrary predicate function
 *
 * ─── Transform Type Reference ─────────────────────────────────
 *
 *   replace       find (string|RegExp) → replace (string)
 *                 flags: 'g' for global, 'gi' for case-insensitive
 *
 *   regex         pattern (RegExp|string) → replace with backreferences
 *                 flags: 'g' (default), 'gi', etc.
 *
 *   prepend       content added unconditionally at the start
 *
 *   append        content added unconditionally at the end
 *
 *   prepend-once  like prepend, but skips if `marker` already exists
 *                 (idempotent — safe to run many times)
 *
 *   append-once   like append, but skips if `marker` already exists
 *
 *   inject-css    wraps content in <style data-fe-patcher> and inserts
 *                 position: 'before' (before </head>), 'after',
 *                 'prepend' (start), 'append' (end)
 *
 *   custom        fn: (content) → modifiedContent
 *                 arbitrary JavaScript function for complex logic
 *
 * ─── Important Notes ──────────────────────────────────────────
 *
 *   • Transforms execute in array order (top to bottom).
 *   • For `target: "html"` patches: match rules are IGNORED —
 *     all transforms run against the generated index.html.
 *   • For `target: "asset"` patches: match rules determine which
 *     WAD-extracted files are patched. Unmatched files pass through.
 *   • Original WAD files on disk are NEVER modified.
 *     All patching happens in-memory at extraction time.
 *   • Use prepend-once / append-once for modifications that may be
 *     applied across multiple sessions or restarts.
 */

module.exports = {
  id: "example-showcase",
  description:
    "Comprehensive example demonstrating all FE patching system capabilities",
  enabled: false,

  // ─── target ──────────────────────────────────────────────────
  // Not set → this patch applies to:
  //   • Generated index.html (match rules ignored, all transforms run)
  //   • WAD-extracted assets (match rules below determine which files)
  //
  // To restrict to HTML only, set:  target: "html"
  // To restrict to assets only, set: target: "asset"

  // ─── match ─────────────────────────────────────────────────────
  // For assets: only CSS files are matched (JS, images, fonts pass through).
  // For HTML: this is ignored and all transforms always run.
  match: {
    ext: ".css",
  },

  // ─── transforms ───────────────────────────────────────────────
  // Each transform demonstrates a different type. They run top-to-bottom.
  transforms: [
    // ═══════════════════════════════════════════════════════════════
    // TRANSFORM 1 — replace (literal string, single occurrence)
    // Replaces the FIRST occurrence of the find string.
    // Omit `flags` for single replacement, or use `flags: 'g'`.
    // ═══════════════════════════════════════════════════════════════
    {
      type: "replace",
      find: "Starting Electron League Client",
      replace: "Patched Electron League Client",
      // No flags → only replaces the first match
    },

    // ═══════════════════════════════════════════════════════════════
    // TRANSFORM 2 — replace (global, literal string)
    // Replaces ALL occurrences when `flags: 'g'` is set.
    // Also works with `flags: 'gi'` for case-insensitive global.
    // ═══════════════════════════════════════════════════════════════
    {
      type: "replace",
      find: "background: #010a13",
      replace: "background: #050d1a !important",
      flags: "g",
    },

    // ═══════════════════════════════════════════════════════════════
    // TRANSFORM 3 — regex (RegExp object with backreferences)
    // `pattern` can be a RegExp object or a string pattern.
    // Backreferences ($1, $2, …) come from capture groups.
    // ═══════════════════════════════════════════════════════════════
    {
      type: "regex",
      pattern: /background-color:\s*#[0-9a-fA-F]+/,
      replace: "background-color: #0a1428",
    },

    // ═══════════════════════════════════════════════════════════════
    // TRANSFORM 4 — prepend-once (idempotent insert at beginning)
    // Prepends `content` only if `marker` is NOT already in the text.
    // Idempotent: safe to run repeatedly without duplicating content.
    // ═══════════════════════════════════════════════════════════════
    {
      type: "prepend-once",
      marker: "/* FE-PATCHER:dark-bg */",
      content: "/* FE-PATCHER:dark-bg */\n",
    },

    // ═══════════════════════════════════════════════════════════════
    // TRANSFORM 5 — inject-css (inject styles into HTML)
    // Wraps `content` in <style data-fe-patcher> and inserts it.
    // `position`: 'before' (</head>), 'after', 'prepend', 'append'
    // In non-HTML files, falls back to prepending the <style> tag.
    // ═══════════════════════════════════════════════════════════════
    {
      type: "inject-css",
      position: "before",
      content: ".patch-indicator { display: none; }",
    },

    // ═══════════════════════════════════════════════════════════════
    // TRANSFORM 6 — custom (arbitrary function)
    // `fn` receives the full content string and returns the modified
    // version. Use for logic that can't be expressed with other types.
    // This example adds a data attribute to <html> for feature
    // detection, but only when the content looks like HTML.
    // ═══════════════════════════════════════════════════════════════
    {
      type: "custom",
      fn: (content) => {
        if (content.includes("<!doctype") || content.includes("<html")) {
          return content.replace(
            "<html>",
            '<html data-fe-patched="true">'
          );
        }
        return content;
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // TRANSFORM 7 — append-once (idempotent insert at end)
    // Appends `content` only if `marker` is NOT already present.
    // Pair with prepend-once to bracket patched content.
    // ═══════════════════════════════════════════════════════════════
    {
      type: "append-once",
      marker: "PATCHED v1.0",
      content: "\n<!-- PATCHED v1.0 -->",
    },

    // ─── Bonus: additional transform types not used above ──────────
    // Uncomment these to experiment:
    //
    // { type: "prepend", content: "/* injected at top */\n" },
    // { type: "append",  content: "\n/* injected at bottom */" },
    //
    // replace with RegExp find (regex literal as the `find` value):
    // { type: "replace", find: /oldName/g, replace: "newName" },
    //
    // match: { plugin: "*" }          — all plugins
    // match: { pluginPrefix: "rcp-fe-lol-" } — all LoL frontend plugins
    // match: { file: /\.js$/ }        — only JavaScript files
    // match: { ext: [".js", ".mjs"] } — JS and module JS
    // match: { customMatch: (a) => a.pluginName.includes("champ") }
  ],
};
