import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";

import type { Account } from "@/bindings/Account";
import type { AccountColor } from "@/bindings/AccountColor";
import type { AuthStatus } from "@/bindings/AuthStatus";
import { Badge } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { ACCOUNT_COLOR_HEX } from "@/lib/account-colors";
import { AUTH_STATUS_META } from "@/lib/auth-status";
import { cn, formatRelative } from "@/lib/utils";

export function AccountDot({
  color,
  className,
  size = "sm",
}: {
  color: AccountColor;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block shrink-0 rounded-full",
        size === "sm" && "size-2",
        size === "md" && "size-2.5",
        size === "lg" && "size-3.5",
        className,
      )}
      style={{ backgroundColor: ACCOUNT_COLOR_HEX[color] }}
    />
  );
}

/** Large monogram used in account headers. */
export function AccountAvatar({ account, className }: { account: Account; className?: string }) {
  const initial = Array.from(account.name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl text-base font-semibold text-white",
        className,
      )}
      style={{ backgroundColor: ACCOUNT_COLOR_HEX[account.color] }}
    >
      {initial}
    </span>
  );
}

const STATUS_ICON: Record<AuthStatus, React.ReactNode> = {
  not_configured: <CircleDashedIcon />,
  auth_required: <TriangleAlertIcon />,
  authenticated: <CircleCheckIcon />,
  unknown: <CircleHelpIcon />,
  failed: <CircleAlertIcon />,
  unsupported_isolation: <ShieldAlertIcon />,
};

export function AuthStatusBadge({ account }: { account: Account }) {
  const meta = AUTH_STATUS_META[account.authStatus];
  const checked = account.authStatusCheckedAt
    ? `Checked ${formatRelative(account.authStatusCheckedAt)}`
    : "Not checked yet";
  return (
    <Tooltip content={`${meta.description} ${checked}.`}>
      <Badge tone={meta.tone} tabIndex={0}>
        {STATUS_ICON[account.authStatus]}
        {meta.label}
      </Badge>
    </Tooltip>
  );
}

/** Compact status glyph for dense lists such as the sidebar. */
export function AuthStatusIcon({ status, className }: { status: AuthStatus; className?: string }) {
  const meta = AUTH_STATUS_META[status];
  const color =
    meta.tone === "success"
      ? "text-success"
      : meta.tone === "warning"
        ? "text-warning"
        : meta.tone === "danger"
          ? "text-destructive"
          : "text-muted-foreground";
  return (
    <span
      role="img"
      aria-label={meta.label}
      className={cn("inline-flex [&_svg]:size-3.5", color, className)}
    >
      {STATUS_ICON[status]}
    </span>
  );
}
