// The header of a pushed screen (SPEC-v8 §5): Back, then the title with an optional line above it, then an optional
// action on the right.

import type { ComponentChildren } from "preact";
import { goBack } from "../store";
import { IconBack } from "./PulseIcons";

interface Props {
  title: ComponentChildren;
  /** The line above the title (where the screen sits, or what it is). */
  sub?: ComponentChildren;
  onBack?: () => void;
  backLabel?: string;
  /** An action on the right, e.g. Save. */
  children?: ComponentChildren;
}

export function ScreenHead({ title, sub, onBack = goBack, backLabel = "Back", children }: Props) {
  return (
    <header class="screen-head">
      <button type="button" class="clay press btn-icon t-muted" aria-label={backLabel} data-testid="back" onClick={onBack}>
        <IconBack size={20} />
      </button>
      <div class="l-col l-grow">
        {sub ? <span class="screen-head__sub">{sub}</span> : null}
        <h1 class="screen-head__title l-m0">{title}</h1>
      </div>
      {children}
    </header>
  );
}
