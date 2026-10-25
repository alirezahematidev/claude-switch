import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangleIcon, CircleAlertIcon, InfoIcon, Loader2Icon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] leading-none font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        success: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/40 bg-warning/10 text-warning",
        danger: "border-destructive/30 bg-destructive/10 text-destructive",
        info: "border-primary/30 bg-primary/10 text-primary",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type Tone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Alert / callout
// ---------------------------------------------------------------------------

const alertTone: Record<"info" | "warning" | "danger", string> = {
  info: "border-primary/25 bg-primary/5",
  warning: "border-warning/40 bg-warning/10",
  danger: "border-destructive/30 bg-destructive/5",
};

const alertIcon = {
  info: <InfoIcon className="size-4 shrink-0 text-primary" />,
  warning: <AlertTriangleIcon className="size-4 shrink-0 text-warning" />,
  danger: <CircleAlertIcon className="size-4 shrink-0 text-destructive" />,
};

export function Alert({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: "info" | "warning" | "danger";
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border px-3 py-2.5",
        alertTone[tone],
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 basis-64 gap-2.5">
        <span className="flex h-[18px] items-center">{alertIcon[tone]}</span>
        <div className="min-w-0 flex-1 space-y-0.5 text-[13px] leading-[18px] wrap-break-word">
          {title && <div className="font-medium">{title}</div>}
          {children && <div className="text-muted-foreground">{children}</div>}
        </div>
      </div>
      {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spinner, Kbd, Section, Card, EmptyState
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2Icon
      aria-hidden
      className={cn("size-4 shrink-0 animate-spin text-muted-foreground", className)}
    />
  );
}

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded border bg-muted px-1 font-sans text-[11px] whitespace-nowrap text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 space-y-2.5", className)}>
      <div className="flex min-h-7 items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("min-w-0 rounded-lg border bg-card", className)} {...props} />;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center",
        className,
      )}
    >
      {icon && <div className="text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <div className="text-[13px] font-medium">{title}</div>
      {children && <div className="max-w-sm text-xs text-muted-foreground">{children}</div>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
