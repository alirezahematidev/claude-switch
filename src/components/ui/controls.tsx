/**
 * Custom form controls used instead of native ones (checkbox, number input,
 * segmented radio group, switch, disclosure), so they look and behave the
 * same everywhere.
 */
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, MinusIcon, PlusIcon } from "lucide-react";
import {
  Checkbox as CheckboxPrimitive,
  Collapsible,
  RadioGroup,
  Switch as SwitchPrimitive,
} from "radix-ui";
import { useId, useState } from "react";
import type * as React from "react";

import { cn } from "@/lib/utils";

import { fieldBase } from "./input";

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => {
          onCheckedChange(v === true);
        }}
        className="mt-px flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-background shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
      >
        <CheckboxPrimitive.Indicator>
          <CheckIcon className="size-3" strokeWidth={3} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="min-w-0 text-[13px] leading-4">
        {label}
        {description && (
          <span className="mt-1 block text-xs leading-snug text-muted-foreground">
            {description}
          </span>
        )}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[15px] data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Number field
// ---------------------------------------------------------------------------

/**
 * A numeric text field with stepper buttons. Commits on Enter, blur, or a
 * step; out-of-range input reverts. Remount (via `key`) to reset after the
 * stored value changes.
 */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  onCommit,
  id,
  className,
  "aria-label": ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (raw: string) => {
    const n = Number(raw.replaceAll(",", ""));
    if (raw.trim() !== "" && Number.isFinite(n) && n >= min && n <= max) {
      const rounded = Math.round(n);
      setDraft(String(rounded));
      if (rounded !== value) onCommit(rounded);
    } else {
      setDraft(String(value));
    }
  };
  const nudge = (delta: number) => {
    const current = Number(draft) || value;
    const next = Math.min(max, Math.max(min, current + delta));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <div className={cn("relative flex h-8 w-28", className)}>
      <input
        id={id}
        aria-label={ariaLabel}
        role="spinbutton"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value.replace(/[^\d]/g, ""));
        }}
        onBlur={() => {
          commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            nudge(step);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            nudge(-step);
          }
        }}
        className={cn(fieldBase, "h-8 pr-7 tabular-nums")}
      />
      <div className="absolute inset-y-px right-px flex w-6 flex-col overflow-hidden rounded-r-[5px] border-l">
        <button
          type="button"
          tabIndex={-1}
          aria-label="Increase"
          disabled={value >= max}
          onClick={() => {
            nudge(step);
          }}
          className="flex flex-1 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronUpIcon className="size-3" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="Decrease"
          disabled={value <= min}
          onClick={() => {
            nudge(-step);
          }}
          className="flex flex-1 items-center justify-center border-t text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDownIcon className="size-3" />
        </button>
      </div>
    </div>
  );
}

/** Compact minus/plus stepper for small ranges (for example, font size). */
export function Stepper({
  value,
  min,
  max,
  onChange,
  format = String,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-8 items-center rounded-md border shadow-xs"
    >
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => {
          onChange(value - 1);
        }}
        className="flex h-full w-8 items-center justify-center rounded-l-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <MinusIcon className="size-3.5" />
      </button>
      <span
        className="min-w-10 border-x px-2 text-center text-[13px] tabular-nums"
        aria-live="polite"
      >
        {format(value)}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => {
          onChange(value + 1);
        }}
        className="flex h-full w-8 items-center justify-center rounded-r-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: React.ReactNode }[];
  label: string;
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      orientation="horizontal"
      onValueChange={(v) => {
        const match = options.find((o) => o.value === v);
        if (match) onChange(match.value);
      }}
      className="inline-flex h-8 items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className="h-full rounded px-3 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=checked]:bg-background data-[state=checked]:font-medium data-[state=checked]:text-foreground data-[state=checked]:shadow-xs"
        >
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

// ---------------------------------------------------------------------------
// Option cards (radio group rendered as selectable cards)
// ---------------------------------------------------------------------------

export function OptionCards<T extends string>({
  value,
  onChange,
  options,
  label,
  tone = "primary",
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly {
    value: T;
    title: React.ReactNode;
    description?: React.ReactNode;
    danger?: boolean;
  }[];
  label: string;
  tone?: "primary";
}) {
  return (
    <RadioGroup.Root
      aria-label={label}
      value={value}
      onValueChange={(v) => {
        const match = options.find((o) => o.value === v);
        if (match) onChange(match.value);
      }}
      className="grid gap-2"
      data-tone={tone}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className={cn(
            // An inset ring stays visible inside scrolling lists.
            "flex w-full items-start gap-3 rounded-lg border p-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset",
            o.danger
              ? "data-[state=checked]:border-destructive data-[state=checked]:bg-destructive/5"
              : "data-[state=checked]:border-primary data-[state=checked]:bg-primary/5",
          )}
        >
          <span
            className={cn(
              "mt-px flex size-4 shrink-0 items-center justify-center rounded-full border",
              o.danger ? "text-destructive" : "text-primary",
            )}
          >
            <RadioGroup.Indicator className="size-2 rounded-full bg-current" />
          </span>
          <span className="min-w-0 space-y-0.5">
            <span className="block text-[13px] leading-4 font-medium">{o.title}</span>
            {o.description && (
              <span className="block text-xs leading-snug text-muted-foreground">
                {o.description}
              </span>
            )}
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

export function Disclosure({
  title,
  children,
  open,
  onOpenChange,
  defaultOpen = false,
  className,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={onOpenChange}
      defaultOpen={defaultOpen}
      className={cn("min-w-0", className)}
    >
      <Collapsible.Trigger className="group inline-flex items-center gap-1 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40">
        <ChevronDownIcon className="size-3.5 -rotate-90 transition-transform group-data-[state=open]:rotate-0" />
        {title}
      </Collapsible.Trigger>
      <Collapsible.Content className="pt-2">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
