import { useEffect, useRef } from "react";
import type * as React from "react";

const SUBMITS_ON_ENTER = new Set(["radio", "checkbox", "switch", "spinbutton"]);

function submitOnEnter(e: React.KeyboardEvent<HTMLFormElement>) {
  if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (target instanceof HTMLTextAreaElement) {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      e.currentTarget.requestSubmit();
    }
    return;
  }
  const role = target.getAttribute("role") ?? "";
  const isField = target instanceof HTMLInputElement || SUBMITS_ON_ENTER.has(role);
  if (!isField) return;
  e.preventDefault();
  e.currentTarget.requestSubmit();
}

/**
 * A form where Return submits from any text field or custom control
 * (radio cards, checkboxes, switches), not only native inputs. Textareas
 * keep Return for new lines (⌘Return submits), and buttons keep their own
 * action. With `autoFocus`, focus moves into the form when it mounts, so
 * multi-step dialogs stay keyboard-friendly.
 */
export function Form({
  onSubmit,
  autoFocus = false,
  children,
  ...props
}: Omit<React.ComponentProps<"form">, "onSubmit"> & {
  onSubmit: (e: React.SubmitEvent<HTMLFormElement>) => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const form = ref.current;
    const target =
      form?.querySelector<HTMLElement>("[data-autofocus]") ??
      form?.querySelector<HTMLElement>(
        'input:not([disabled]), [role="radio"][data-state="checked"], button[type="submit"]:not([disabled])',
      );
    target?.focus();
  }, [autoFocus]);

  return (
    // Event delegation: Return in any field or custom control submits.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <form
      ref={ref}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(e);
      }}
      onKeyDown={submitOnEnter}
      {...props}
    >
      {children}
    </form>
  );
}
