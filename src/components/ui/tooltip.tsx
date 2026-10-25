import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

export const TooltipProvider = TooltipPrimitive.Provider;

/** Custom tooltip; native `title` tooltips are not used anywhere. */
export function Tooltip({
  content,
  children,
  side = "top",
  disabled = false,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
}) {
  // Disabled tooltips stay mounted (but closed) so the trigger never remounts.
  return (
    <TooltipPrimitive.Root {...(disabled ? { open: false } : {})}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-50 max-w-xs rounded-md bg-foreground px-2 py-1 text-xs wrap-break-word text-background shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
