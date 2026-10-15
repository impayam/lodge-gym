// A select in a well with a chevron, so it reads as a choice (the native arrow is hidden by .input).

import type { SelectHTMLAttributes } from "preact";
import { IconChevron } from "./PulseIcons";

export function Select({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span class="select-field">
      <select class="input" {...rest}>
        {children}
      </select>
      <IconChevron size={16} />
    </span>
  );
}
