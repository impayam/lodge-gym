// SPEC-v8 §7: every list and chart has a loading state (skeleton in card shape), an empty state (one line + action)
// and an error state (what failed + Retry). Built from the library's .skeleton and .state.

import type { ComponentChildren } from "preact";
import { errorText, NetworkError } from "../api";

/** Card-shaped skeletons in place of a list or chart that is loading. */
export function Loading({ label, heights = [76, 76] }: { label: string; heights?: number[] }) {
  return (
    <div class="l-col l-gap-8" role="status" aria-label={label} data-testid="loading">
      {heights.map((h, i) => (
        <span key={i} class="skeleton" style={{ height: `${h}px` }} />
      ))}
    </div>
  );
}

export interface StateAction {
  label: string;
  onClick: () => void;
  testId?: string;
}

/** One line on what is missing, and the action that fills it. */
export function Empty({ children, action, testId }: { children: ComponentChildren; action?: StateAction; testId?: string }) {
  return (
    <div class="state" data-testid={testId}>
      <span>{children}</span>
      {action ? (
        <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid={action.testId} onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** What failed, why, and Retry. `what` is a whole sentence, e.g. "Couldn't load your photos." */
export function LoadError({ what, error, onRetry, testId }: { what: string; error: unknown; onRetry: () => void; testId?: string }) {
  return (
    <div class="state" role="alert" data-testid={testId ?? "load-error"}>
      <span>
        <b class="t-orange">{what}</b> {errorText(error)}
      </span>
      <button type="button" class="clay press btn-sm btn--fit t-muted" data-testid="retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** The request never reached the server (as opposed to the server answering with an error). */
export const isOffline = (e: unknown) => e instanceof NetworkError;
