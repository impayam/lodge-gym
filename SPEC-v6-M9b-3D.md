# SPEC v6: M9b-3D, real 3D anatomy for the exercise picker

Status: model choice APPROVED by Payam on 2026-10-13 ("the free one, good for phone, good quality"). Everything else in this file needs his OK at the checkpoints marked **STOP**.
Same CLAUDE.md working rules. This replaces only the drawn body in M9b. The M9b parts Payam already approved stay: Body/Search tabs, the 8 regions and the region → muscle mapping, list order, filter defaults (Body tab, Strength (counted), All equipment), remembering the selection while the app is open. Start from the parked branch `claude/m9b-parked`.

---

## 1. The asset (verified 2026-10-13)
- Source: https://github.com/hpfrei/body-anatomy-3d-viewer, file `public/body.glb`, commit `0fc76a927aaf54c6fcc217cabdc3eb4d561130b7` (2026-02-10).
- SHA-256: `0886b6a068e655b284903664e2178d7964f80b1c0ce798461909ac806bcef2e3`, 8,249,484 bytes.
- Content: Z-Anatomy data, simplified and Draco-compressed (`KHR_draco_mesh_compression`). 1,872 nodes, 826 meshes, 290,886 triangles. 440 muscle nodes (222 unique names; left/right copies end in `.001`, `.002`, …), 1,223 bone nodes. Each node has `extras.type` (`muscle`/`bone`), `extras.name`, `extras.nameDetail`, `extras.wikiLink`, `extras.description`.
- Contains every muscle the app needs, with heads/parts, e.g. clavicular / sternocostal / abdominal part of pectoralis major; clavicular / acromial / scapular spinal part of deltoid; long / lateral / medial head of triceps brachii; long / short head of biceps brachii; latissimus dorsi; trapezius (3 parts); rectus abdominis; external/internal oblique; gluteus maximus/medius/minimus; rectus femoris, vastus lateralis/medialis/intermedius; biceps femoris, semitendinosus, semimembranosus; gastrocnemius (2 heads), soleus; adductors; forearm flexors/extensors, brachioradialis.
- **License: CC BY-SA 4.0** (repo LICENSE; Z-Anatomy is CC BY-SA 4.0). Required:
  - Settings → About → "3D anatomy model: Body Anatomy 3D Viewer by hpfrei, based on Z-Anatomy, CC BY-SA 4.0" with links to the repo, Z-Anatomy and the license.
  - Commit the asset with a `web/public/models/ANATOMY-SOURCE.md` (URL, commit, SHA-256, license text link, "used unmodified" or a list of changes).
- Verify the SHA-256 in a build step; fail the build if it differs.
- Do NOT use the repo's `viewer.js`, `index.html` or bundled libs. Only `body.glb`.

## 2. Libraries (show package.json diff before installing)
- `three` **0.186.1** exact (MIT). Use `GLTFLoader`, `DRACOLoader`, `OrbitControls` from `three/examples/jsm`.
- Draco decoder: copy from `three/examples/jsm/libs/draco/gltf/` into the app's own assets (self-hosted, no CDN).
- **STOP:** the Draco decoder uses WebAssembly. If the current CSP (SPEC v1 §13) blocks it (e.g. needs `'wasm-unsafe-eval'` in `script-src`), show Payam the exact CSP change and wait.
- Load three.js and the model **lazily**: only when the picker's Body tab opens. Report the gzip size added to the main bundle (target: zero) and the lazy chunk size.

## 3. Muscle mapping (single source of truth)
- New module `web/src/lib/anatomy-map.ts`: model base name (strip the `.NNN` suffix) → the app's existing muscle key (the 17 keys from `worker/lib/muscles.ts`; do not invent new keys) and → the M10 coverage region key where one exists (e.g. clavicular head → `chest_upper`, sternocostal → `chest_mid`, abdominal part → `chest_lower`; clavicular deltoid → `shoulders_front`, acromial → `shoulders_side`, scapular spinal → `rear_delts`; long head of triceps → `triceps_long`; gastrocnemius → `calves_gastroc`, soleus → `calves_soleus`).
- Every muscle mesh not in the map (face, eye, larynx, hand/foot intrinsics, deep spinal muscles…) stays visible but is **not tappable**.
- Unit tests: every one of the 17 app keys has ≥1 mapped mesh; every mapped name exists in the GLB (read the GLB JSON chunk in the test); no name maps to two keys.
- **STOP:** show Payam the full mapping table (model name → app muscle → region) before building the UI on it.

## 4. Picker UI (replaces the drawn figures)
- **Step 1, body:** 3D model, front view, centered, fits the screen width. Drag rotates around the vertical axis only; pinch zoom limited (no flying inside the body); no panning. Buttons **Front** / **Back** animate a 180° turn (≤400 ms).
- Tap a muscle → the whole app muscle group lights up on both sides (all mapped meshes for that key), a bottom chip shows the name ("Triceps") and **Show exercises**. Tapping empty space clears it.
- Region buttons (the 8 approved regions) stay as a row of chips under the model. Choosing a region animates the camera to a preset close-up of that region and keeps only that region's muscles tappable; the muscle chips for the region appear (accessible alternative, ≥44 pt).
- Step 3 (exercise list) and step 4 (add as extra) are unchanged from the approved M9b.
- Look: muscles in a muted base color; bones dimmed; selected group with the app accent (purple `#8B5CF6` once M11 lands) as emissive highlight; dark background. Tap hit area: raycast on the mesh; if the tap misses by a few px, pick the nearest mapped mesh within 24 px.
- Accessibility: the chips do everything the 3D does. VoiceOver users never need the canvas.

## 5. Performance and offline
- Targets on Payam's iPhone (measure, don't assume): first open on Wi-Fi ≤ 3 s to interactive; second open ≤ 1 s; rotation smooth (report FPS).
- Caching: the GLB and Draco decoder are cached by the service worker at **first use** (cache-first, versioned by the SHA-256), not in the install precache, so app install stays light. After one online open the 3D picker works offline.
- Fallback: if WebGL is unavailable, the model fails to load, or it takes > 10 s, show the region and muscle chips only (the picker still fully works) with a small "3D unavailable" note.
- Dispose the renderer, geometries and textures when the picker closes (no memory growth after open/close 20 times; test it).
- **STOP** if the targets are missed: report the numbers and propose options (e.g. a muscles-only GLB built by a script that drops bones and non-mapped meshes, recompressed). Do not modify the asset without Payam's OK; if modified, list the changes in `ANATOMY-SOURCE.md` (license requirement).

## 6. Tests
- Unit: mapping tests (§3); camera presets exist for all 8 regions.
- E2E (both projects): open picker → choose Arms via chip → Triceps chip → list shows triceps-primary first → add → extra exercise in session. Plus a canvas test through a test hook that simulates a tap on a known mesh (headless WebGL may be limited; if a project cannot render WebGL, assert the fallback instead and say so in the report).
- Offline: after one online open, reload offline → model still loads.
- Screenshots on iPhone size for approval before merge: whole body front, back, Arms close-up with Triceps selected, the triceps list, the fallback.

## 7. Out of scope (ask first)
- Replacing the Reports muscle map (PR #3) with the 3D model colored by weekly status. Payam said "even the whole body"; confirm with him whether that means this too, as a separate step after the picker.
