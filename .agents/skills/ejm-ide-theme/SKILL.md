---
name: ejm-ide-theme
description: Add or change colors, light and dark themes, the editor theme, or the Appearance preference in the app. Use for any visible color, overlay, status, graph, diff, or syntax change.
---

# Light and dark themes

The app has a System, Light, and Dark choice (Preferences, Appearance). Every
surface must work in both themes. The palette comes from the ejmlabs design kit:
Ink, Paper, Forest, Sage, and Mist.

## Authority

The kit's `ui/theme.json` (`~/Desktop/ejmlabs/design-kit`) is the one source of
color for ejmlabs apps. Read its `UI.md`. The kit has a rename table that maps
this app's tokens to its `--ejm-ui-*` roles, and the "ejmlabs" session owns that
migration. Before changing token values or moving the app onto the kit, tell that
session. Do not edit generated kit files.

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

1. No raw hex colors in CSS or TSX. Use a token. Add a token in `app/theme.css`
   for both themes before using a new color.
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
