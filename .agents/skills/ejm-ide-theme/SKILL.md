---
name: ejm-ide-theme
description: Add or change colors, light and dark themes, the editor theme, or the Appearance preference in the app. Use for any visible color, overlay, status, graph, diff, or syntax change.
---

# Light and dark themes

The app has a System, Light, and Dark choice (Preferences, Appearance). Every
surface must work in both themes. Start with the committed tokens and theme
adapters listed below.

## Authority

`ejm-ui/packages/tokens` owns active shared tokens and generated themes through
the `@ejm/tokens` public exports. Shared visual primitives belong to `@ejm/ui`.
Read the owning package contract before a shared change, then adopt its public
output in the IDE. The public site already uses it; the desktop app has not moved
onto it yet.

This readiness snapshot still has the local definitions and adapters below.
They can be inspected in this checkout without a private brand directory. A
shared-package migration needs its own reviewed change and compatibility checks;
these instructions do not claim that migration is installed.

## What the app has today

| Piece | Location |
| --- | --- |
| Tokens | `app/theme.css`: `--k0` to `--k15` neutral ramp (deepest surface to strongest text), `--primary`, `--accent`, `--accent-light`, `--on-primary`, `--tint-1` to `--tint-3`, `--error`, `--warning`, `--success`, `--violet`, `--lane-1` to `--lane-6` |
| Alpha helpers | `--ov` (overlay RGB triplet) and `--primary-rgb`, `--error-rgb`, `--warning-rgb`, `--success-rgb` |
| Switching | `app/lib/theme.ts`: preference in `localStorage` key `workbench.theme`, `data-theme` on the root, `useTheme()` and `useThemePreference()` |
| Editor | `app/lib/editor-theme.ts` (`editorColors`, `editorColorsLight`, syntax rules, `monacoThemeNames`), `highlighting.ts` (one Shiki theme per mode), `monaco.ts` (sets `--vscode-*` variables and the Monaco theme on change) |
| Tailwind | `@theme inline` in `app/styles.css` maps utilities to the tokens |
| Graphs | `colorMode` on React Flow in `CallGraph.tsx` and `ChatBlocks.tsx`; chart colors use tokens |
| Extension panels | `extensionTheme()` in `app/lib/extensions.ts` copies current colors into the sandboxed frame when it is built |
| Window | `src-tauri/tauri.conf.json` `backgroundColor` is one fixed dark value, so a light launch may flash dark |

## Rules

1. No raw hex colors in CSS or TSX. Reuse a token. Shared token additions belong
   in `ejm-ui`; document any IDE-specific role in both themes before using it.
2. Hover and selection tints use `rgb(var(--ov) / 0.04)` so they flip with the theme.
   Status tints use `rgb(var(--error-rgb) / 0.1)` and the like. Translucent neutrals use
   `color-mix(in srgb, var(--k5) 50%, transparent)`.
3. The ramp mirrors: `--k0` is the deepest surface in dark and the lightest in
   light. Pick a step by its role, not by how it looks in one theme.
4. Text reaches 4.5:1 on every surface it sits on, in both themes. Sage is for
   lines and decoration, not small text on Paper. Primary actions use
   `--primary` with `--on-primary`.
5. Use blue only where the code means it (syntax and graph hues). Actions,
   selection, and focus use `--primary` and `--accent`.
6. Syntax colors keep their meaning across themes. The light editor theme darkens
   them to read on Paper. Add a new rule to both `editorTheme` and the light map.
7. Components that draw with SVG or canvas read tokens through CSS variables or
   `useTheme()`, never from a fixed palette.

## Verify

Check every changed surface in both themes, not only the one you built it in.
The browser preview reads the stored preference, so set it before load:
`localStorage.setItem('workbench.theme', 'light' | 'dark' | 'system')`. See
[the verify skill](../ejm-ide-verify/SKILL.md) for capture steps. Look at the
editor, a diff, the call graph, a chat chart, the Git graph, Preferences,
dialogs, menus, and an extension panel. Run `npm test` for the theme, editor,
and extension tests.
