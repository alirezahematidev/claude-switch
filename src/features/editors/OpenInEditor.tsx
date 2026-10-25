import { ChevronDownIcon, CodeXmlIcon } from "lucide-react";

import type { EditorInfo } from "@/bindings/EditorInfo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useEditors, useOpenInEditor } from "./useEditors";

/**
 * Opens a project in VS Code (or another detected VS Code–family editor)
 * with the chosen account's profile.
 */
export function OpenInEditorButton({
  projectId,
  accountId,
  disabled = false,
  iconOnly = false,
  size = "default",
  className,
}: {
  projectId: string;
  accountId: string | undefined;
  disabled?: boolean;
  iconOnly?: boolean;
  size?: "default" | "sm";
  className?: string;
}) {
  const { editors, preferred } = useEditors();
  const { open, busy } = useOpenInEditor();
  const unavailable = !preferred;
  const blocked = disabled || unavailable || !accountId;

  const launch = (editor: EditorInfo) => {
    if (accountId) void open(projectId, accountId, editor);
  };

  if (iconOnly) {
    return (
      <Tooltip
        content={
          unavailable
            ? "No supported editor found (VS Code, Cursor, Windsurf)"
            : `Open in ${preferred.name} with this account`
        }
      >
        <span className="inline-flex">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={preferred ? `Open in ${preferred.name}` : "Open in editor"}
            disabled={blocked}
            loading={busy}
            onClick={() => {
              if (preferred) launch(preferred);
            }}
            className={className}
          >
            {!busy && <CodeXmlIcon />}
          </Button>
        </span>
      </Tooltip>
    );
  }

  const label = preferred ? `Open in ${preferred.name}` : "Open in VS Code";
  const others = editors.filter((e) => e.id !== preferred?.id);

  return (
    <Tooltip
      content="VS Code, Cursor or Windsurf was not found in Applications."
      disabled={!unavailable}
    >
      <div className={cn("flex", className)}>
        <Button
          variant="outline"
          size={size}
          disabled={blocked}
          loading={busy}
          onClick={() => {
            if (preferred) launch(preferred);
          }}
          className={cn(others.length > 0 && "rounded-r-none")}
        >
          {!busy && <CodeXmlIcon />}
          {label}
        </Button>
        {others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size={size}
                disabled={blocked}
                aria-label="Choose editor"
                className="rounded-l-none border-l-0 px-1.5"
              >
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Open with</DropdownMenuLabel>
              {editors.map((editor) => (
                <DropdownMenuItem
                  key={editor.id}
                  onSelect={() => {
                    launch(editor);
                  }}
                >
                  <CodeXmlIcon />
                  {editor.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </Tooltip>
  );
}
