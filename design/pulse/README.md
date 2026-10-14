# design/pulse — handoff for Claude Code

Put this folder in the repo at `design/pulse/` and read in this order:

1. `DESIGN-SPEC-v8-Pulse.md` — what to build, rules, CONFIRM items.
2. `tokens.css` and `components.css` — the only source of colors, shadows, radii, fonts and components.
3. `COMPONENTS.md` — how to use each component.
4. `mockups/*.dc.html` — the approved screens (reference only; do not ship their runtime).

Add this line to CLAUDE.md under "Working rules":

> UI: build only from `design/pulse/tokens.css` and `design/pulse/components.css` per `design/pulse/DESIGN-SPEC-v8-Pulse.md`. No hex values, shadows or fonts anywhere else. Anything missing from the library: stop and ask Payam.

Live design canvas (Payam's): https://claude.ai/artifact/NbBcX3nhWyS6KYyphTDtKS
