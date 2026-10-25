import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  ClipboardCopyIcon,
  CodeXmlIcon,
  DownloadIcon,
  FolderOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useId, useState } from "react";
import { toast } from "sonner";

import type { AppSettings } from "@/bindings/AppSettings";
import type { EditorInfo } from "@/bindings/EditorInfo";
import type { EnvVar } from "@/bindings/EnvVar";
import type { RevealTarget } from "@/bindings/RevealTarget";
import type { SettingsPatch } from "@/bindings/SettingsPatch";
import { Button } from "@/components/ui/button";
import { Disclosure, NumberField, Segmented, Stepper, Switch } from "@/components/ui/controls";
import { Form } from "@/components/ui/form";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Card, Kbd, Section, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { AccountDot } from "@/features/accounts/AccountBits";
import { acceleratorFromEvent, formatAccelerator } from "@/lib/accelerator";
import { api, errorMessage } from "@/lib/ipc";
import { queryKeys, useAccounts, useSettings, useSystemInfo } from "@/lib/queries";
import { cn } from "@/lib/utils";

import { SystemWarnings } from "./SystemWarnings";

function useSaveSettings() {
  const client = useQueryClient();
  return async (patch: SettingsPatch): Promise<boolean> => {
    try {
      const next = await api.updateSettings(patch);
      client.setQueryData(queryKeys.settings, next);
      return true;
    } catch (err) {
      toast.error("Could not save the setting", { description: errorMessage(err) });
      return false;
    }
  };
}

function Row({
  label,
  description,
  control,
  htmlFor,
}: {
  label: string;
  description?: React.ReactNode;
  control: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-6 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <Label htmlFor={htmlFor} className="text-[13px] leading-5 font-normal">
          {label}
        </Label>
        {description && (
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <Row
      label={label}
      description={description}
      htmlFor={id}
      control={<Switch id={id} checked={checked} onCheckedChange={onChange} />}
    />
  );
}

export function SettingsView() {
  const { data: settings } = useSettings();
  if (!settings) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-3xl space-y-7 px-8 py-6">
      <h1 className="text-lg leading-6 font-semibold">Settings</h1>
      <GeneralSection settings={settings} />
      <AppearanceSection settings={settings} />
      <TerminalSection key={settings.terminalFontFamily} settings={settings} />
      <ClaudeCodeSection settings={settings} />
      <EditorsSection />
      <EnvironmentSection
        key={JSON.stringify([settings.extraPathEntries, settings.customEnv])}
        settings={settings}
      />
      <KeyboardSection settings={settings} />
      <StorageSection />
      <DiagnosticsSection />
    </div>
  );
}

const CLOSE_OPTIONS = [
  { value: "keep_running", label: "Keep sessions running" },
  { value: "quit", label: "Quit and stop sessions" },
] as const;

function GeneralSection({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const closeId = useId();
  return (
    <Section title="General">
      <Card className="divide-y">
        <Row
          label="When the window is closed"
          htmlFor={closeId}
          description="Sessions keep running in the background unless the app quits."
          control={
            <Select
              id={closeId}
              className="w-52"
              value={settings.closeBehavior}
              onValueChange={(v) => void save({ closeBehavior: v })}
              options={CLOSE_OPTIONS}
            />
          }
        />
        <ToggleRow
          label="Confirm before quitting with running sessions"
          checked={settings.confirmQuitWithRunningSessions}
          onChange={(v) => void save({ confirmQuitWithRunningSessions: v })}
        />
        <ToggleRow
          label="Check sign-in status at launch"
          description="Runs claude auth status once per account. It never sends a model request."
          checked={settings.checkAuthOnStartup}
          onChange={(v) => void save({ checkAuthOnStartup: v })}
        />
        <ToggleRow
          label="Notify when a session ends in the background"
          checked={settings.notifyOnSessionExit}
          onChange={(v) => void save({ notifyOnSessionExit: v })}
        />
        <ToggleRow
          label="Open at login"
          description="Starts in the menu bar without opening a window."
          checked={settings.launchAtLogin}
          onChange={(v) => void save({ launchAtLogin: v })}
        />
      </Card>
    </Section>
  );
}

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function AppearanceSection({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  return (
    <Section title="Appearance">
      <Card className="divide-y">
        <Row
          label="Theme"
          control={
            <Segmented
              label="Theme"
              value={settings.theme}
              onChange={(v) => void save({ theme: v })}
              options={THEME_OPTIONS}
            />
          }
        />
      </Card>
    </Section>
  );
}

function TerminalSection({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [font, setFont] = useState(settings.terminalFontFamily);
  const ids = { font: useId(), scroll: useId() };
  const commitFont = () => {
    if (font.trim() !== settings.terminalFontFamily) void save({ terminalFontFamily: font });
  };
  return (
    <Section title="Terminal">
      <Card className="divide-y">
        <Row
          label="Font size"
          control={
            <Stepper
              label="font size"
              value={settings.terminalFontSize}
              min={9}
              max={32}
              format={(v) => `${v} pt`}
              onChange={(v) => void save({ terminalFontSize: v })}
            />
          }
        />
        <Row
          label="Font family"
          htmlFor={ids.font}
          description="Leave empty for the default (SF Mono with fallbacks for Persian and Arabic script). Press Return to apply."
          control={
            <Input
              id={ids.font}
              className="w-60"
              placeholder="Default"
              value={font}
              onChange={(e) => {
                setFont(e.target.value);
              }}
              onBlur={commitFont}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitFont();
                }
              }}
            />
          }
        />
        <Row
          label="Scrollback lines"
          htmlFor={ids.scroll}
          description="Kept in memory only; terminal output is never written to disk."
          control={
            <NumberField
              key={settings.terminalScrollback}
              id={ids.scroll}
              value={settings.terminalScrollback}
              min={1000}
              max={100000}
              step={1000}
              onCommit={(v) => void save({ terminalScrollback: v })}
            />
          }
        />
        <ToggleRow
          label="Use Option as Meta key"
          description="Turn off to type special characters with Option. Shift+Return always inserts a newline in Claude Code."
          checked={settings.terminalOptionAsMeta}
          onChange={(v) => void save({ terminalOptionAsMeta: v })}
        />
      </Card>
    </Section>
  );
}

function ClaudeCodeSection({ settings }: { settings: AppSettings }) {
  const { data: system, isFetching } = useSystemInfo();
  const save = useSaveSettings();
  const client = useQueryClient();
  const [checking, setChecking] = useState(false);
  const cli = system?.cli;
  const ok = cli?.state === "found";

  const recheck = async () => {
    setChecking(true);
    try {
      await api.refreshCliDetection();
      await client.invalidateQueries({ queryKey: queryKeys.system });
    } catch (err) {
      toast.error("Could not check Claude Code", { description: errorMessage(err) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Section
      title="Claude Code"
      description="Claude Switch runs the official Claude Code CLI. It does not bundle or modify it."
    >
      <Card className="space-y-3 p-3.5">
        <div className="flex items-start gap-3">
          <span className="flex h-5 items-center">
            {ok ? (
              <CheckCircle2Icon className="size-4 text-success" />
            ) : (
              <TriangleAlertIcon className="size-4 text-warning" />
            )}
          </span>
          <div className="min-w-0 flex-1 text-[13px] leading-5">
            <div className="font-medium">
              {cli === undefined
                ? "Checking…"
                : ok
                  ? `Claude Code ${cli.version ?? ""}`
                  : cli.state === "invalid_configured"
                    ? "The chosen executable can’t be used"
                    : cli.state === "unsupported"
                      ? "Unsupported Claude Code executable"
                      : "Claude Code was not found"}
            </div>
            {cli?.path && (
              <div className="selectable font-mono text-xs break-all text-muted-foreground">
                {cli.path}
                <span className="font-sans">
                  {cli.source === "configured" ? " (chosen in Settings)" : " (auto-detected)"}
                </span>
              </div>
            )}
            {cli?.message && <p className="mt-1 text-xs text-muted-foreground">{cli.message}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              api
                .pickClaudeExecutable()
                .then(() => client.invalidateQueries({ queryKey: queryKeys.system }))
                .catch((err: unknown) => {
                  toast.error("Could not use that file", { description: errorMessage(err) });
                });
            }}
          >
            Choose Executable…
          </Button>
          {settings.claudeExecutablePath && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void save({ claudeExecutablePath: "" }).then(() =>
                  client.invalidateQueries({ queryKey: queryKeys.system }),
                )
              }
            >
              Use Auto-Detect
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={checking || isFetching}
            onClick={() => void recheck()}
          >
            <RefreshCwIcon className={cn(checking && "animate-spin")} />
            Check Again
          </Button>
        </div>
        {!ok && cli && (
          <div className="space-y-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Install Claude Code</p>
            <p>Run one of these in Terminal, then choose Check Again:</p>
            <pre className="selectable overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground">
              {"curl -fsSL https://claude.ai/install.sh | bash\nbrew install --cask claude-code"}
            </pre>
            <Disclosure title="Locations checked">
              <ul className="space-y-0.5 font-mono text-[11px] break-all">
                {cli.searched.map((p) => (
                  <li key={p} className="selectable">
                    {p}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        )}
      </Card>
    </Section>
  );
}

const PER_WINDOW = "window";
const CUSTOM = "custom";

export function EditorsSection() {
  const { data: system } = useSystemInfo();
  const editors = system?.editors ?? [];
  return (
    <Section
      title="Editors"
      description="Open a project in VS Code with an account: new editor windows run Claude Code, its extension, and terminals with that account’s profile."
    >
      {editors.length > 0 ? (
        <Card className="divide-y">
          {editors.map((editor) => (
            <Fragment key={editor.id}>
              <EditorAccountRow editor={editor} />
              <EditorExtensionRow
                editor={editor}
                appVersion={system?.appVersion ?? ""}
                available={system?.extensionPackageAvailable ?? false}
              />
            </Fragment>
          ))}
          <p className="px-3.5 py-2.5 text-xs leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">Per window</span>: each window keeps the
            account it was opened with; if the folder is already open, the editor focuses that
            window. <span className="font-medium text-foreground">One account</span>: new Claude
            tabs in every window use it, so you can switch accounts without reopening windows. Tabs
            that are already open keep their account.
          </p>
        </Card>
      ) : (
        <Card className="flex items-start gap-3 p-3.5">
          <span className="flex h-5 items-center">
            <CodeXmlIcon className="size-4 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1 text-[13px] leading-5">
            <div className="font-medium">No supported editor found</div>
            <p className="text-xs text-muted-foreground">
              Install VS Code, Cursor, or Windsurf in Applications to open projects from here.
            </p>
          </div>
        </Card>
      )}
    </Section>
  );
}

/** The Claude Switch extension: an account switcher inside the editor. */
function EditorExtensionRow({
  editor,
  appVersion,
  available,
}: {
  editor: EditorInfo;
  appVersion: string;
  available: boolean;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const installed = editor.extensionVersion;
  const outdated = installed !== null && installed !== appVersion;

  const install = async () => {
    setBusy(true);
    try {
      await api.installEditorExtension(editor.id);
      await client.invalidateQueries({ queryKey: queryKeys.system });
      toast.success(`Claude Switch extension ${installed ? "updated" : "installed"}`, {
        description: `In ${editor.name}, switch accounts with the button in the editor title bar or the account in the status bar.`,
      });
    } catch (err) {
      toast.error(`Could not install the extension in ${editor.name}`, {
        description: errorMessage(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const description = !installed
    ? `Adds an account switcher to ${editor.name}'s title bar and status bar, and continues a conversation with another account.`
    : outdated
      ? `Version ${installed} is installed; Claude Switch includes ${appVersion}.`
      : `Installed (${installed}). Switch accounts from the title bar or the status bar.`;

  return (
    <Row
      label={`${editor.name}: Claude Switch extension`}
      description={description}
      control={
        <Tooltip
          content="This build does not include the extension. Build it with pnpm ext:package."
          disabled={available}
        >
          <span className="inline-flex">
            <Button
              size="sm"
              variant={installed && !outdated ? "ghost" : "outline"}
              loading={busy}
              disabled={!available}
              onClick={() => void install()}
            >
              {!busy && <DownloadIcon />}
              {!installed ? "Install" : outdated ? "Update" : "Reinstall"}
            </Button>
          </span>
        </Tooltip>
      }
    />
  );
}

/** Which account an editor's Claude Code extension uses. */
function EditorAccountRow({ editor }: { editor: EditorInfo }) {
  const { data: accounts = [] } = useAccounts();
  const client = useQueryClient();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const { mode, accountId, detail } = editor.claudeAccount;
  const current = accounts.find((a) => a.id === accountId);
  const value =
    mode === "account" ? (accountId ?? PER_WINDOW) : mode === "custom" ? CUSTOM : PER_WINDOW;

  const description =
    mode === "account"
      ? `New Claude tabs in every ${editor.name} window use ${current?.name ?? "this account"}.`
      : mode === "custom"
        ? `Your ${editor.name} settings point Claude Code at ${detail ?? "another folder"}.`
        : mode === "unreadable"
          ? `${editor.name}'s settings.json could not be read. ${detail ?? ""}`
          : "Claude Code uses the account each window was opened with.";

  const change = async (next: string) => {
    if (next === value || next === CUSTOM) return;
    setBusy(true);
    try {
      await api.setEditorAccount({
        editorId: editor.id,
        ...(next === PER_WINDOW ? {} : { accountId: next }),
      });
      await client.invalidateQueries({ queryKey: queryKeys.system });
    } catch (err) {
      toast.error(`Could not change ${editor.name}`, { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      label={`${editor.name}: Claude Code account`}
      htmlFor={id}
      description={description}
      control={
        <Select
          id={id}
          className="w-52"
          value={value}
          disabled={busy || mode === "unreadable"}
          onValueChange={(v) => void change(v)}
          options={[
            { value: PER_WINDOW, label: "Per window" },
            ...(mode === "custom"
              ? [{ value: CUSTOM, label: "Custom folder", disabled: true }]
              : []),
            ...accounts.map((a) => ({
              value: a.id,
              label: (
                <span className="flex min-w-0 items-center gap-2">
                  <AccountDot color={a.color} />
                  <span className="truncate">{a.name}</span>
                </span>
              ),
            })),
          ]}
        />
      }
    />
  );
}

function EnvironmentSection({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [paths, setPaths] = useState(settings.extraPathEntries.join("\n"));
  const [vars, setVars] = useState<EnvVar[]>(settings.customEnv);
  const [busy, setBusy] = useState(false);
  const pathId = useId();

  const dirty =
    paths.trim() !== settings.extraPathEntries.join("\n").trim() ||
    JSON.stringify(vars) !== JSON.stringify(settings.customEnv);

  const submit = async (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    const ok = await save({
      extraPathEntries: paths
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean),
      customEnv: vars.filter((v) => v.name.trim() !== ""),
    });
    setBusy(false);
    if (ok) toast.success("Environment saved. It applies to new sessions.");
  };

  return (
    <Section
      title="Environment"
      description="Sessions get a deliberately minimal environment so each account uses its own login."
    >
      <SystemWarnings />
      <Card className="p-3.5">
        <Form className="space-y-4" onSubmit={(e) => void submit(e)}>
          <div className="grid gap-1.5">
            <Label htmlFor={pathId}>Additional PATH folders</Label>
            <Textarea
              id={pathId}
              className="font-mono text-xs"
              rows={3}
              placeholder={"/opt/tools/bin\n/Users/you/.cargo/bin"}
              value={paths}
              onChange={(e) => {
                setPaths(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              One absolute folder per line, added before the standard macOS locations. ⌘↩ saves.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label>Additional environment variables</Label>
            <p className="text-xs text-muted-foreground">
              For non-secret values only. Names that look like secrets, or that change how Claude
              Code authenticates (such as ANTHROPIC_API_KEY or CLAUDE_CONFIG_DIR), are rejected.
            </p>
            <div className="space-y-2 pt-1">
              {vars.map((v, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label="Variable name"
                    className="w-52 font-mono text-xs"
                    placeholder="NAME"
                    value={v.name}
                    onChange={(e) => {
                      setVars(vars.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)));
                    }}
                  />
                  <Input
                    aria-label="Variable value"
                    className="flex-1 font-mono text-xs"
                    placeholder="value"
                    value={v.value}
                    onChange={(e) => {
                      setVars(vars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)));
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${v.name || "variable"}`}
                    onClick={() => {
                      setVars(vars.filter((_, j) => j !== i));
                    }}
                  >
                    <XIcon />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setVars([...vars, { name: "", value: "" }]);
                }}
              >
                <PlusIcon />
                Add Variable
              </Button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!dirty}
              onClick={() => {
                setPaths(settings.extraPathEntries.join("\n"));
                setVars(settings.customEnv);
              }}
            >
              Revert
            </Button>
            <Button size="sm" type="submit" loading={busy} disabled={!dirty}>
              Save
            </Button>
          </div>
        </Form>
      </Card>
    </Section>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Switch account", "⌘P"],
  ["Select account 1–9", "⌘1 – ⌘9"],
  ["New Claude session", "⌘T"],
  ["New shell", "⇧⌘T"],
  ["Add account", "⇧⌘N"],
  ["Add project", "⌘O"],
  ["Close tab", "⌘W"],
  ["Next / previous tab", "⇧⌘] / ⇧⌘["],
  ["Clear terminal", "⌘K"],
  ["Toggle sidebar", "⌘\\"],
  ["Newline in Claude Code", "⇧↩"],
  ["Continue in another account", "⇧⌘C"],
  ["Settings", "⌘,"],
];

function KeyboardSection({ settings }: { settings: AppSettings }) {
  const save = useSaveSettings();
  const [recording, setRecording] = useState(false);
  return (
    <Section title="Keyboard">
      <Card className="divide-y">
        <Row
          label="Global shortcut"
          description="Brings Claude Switch forward and opens the account switcher from any app."
          control={
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Record global shortcut"
                onClick={() => {
                  setRecording(true);
                }}
                onBlur={() => {
                  setRecording(false);
                }}
                onKeyDown={(e) => {
                  if (!recording) return;
                  e.preventDefault();
                  if (e.key === "Escape") {
                    setRecording(false);
                    return;
                  }
                  const accel = acceleratorFromEvent(e.nativeEvent);
                  if (accel) {
                    setRecording(false);
                    void save({ globalShortcut: accel });
                  }
                }}
                className={cn(
                  "h-8 min-w-36 rounded-md border px-3 text-[13px] shadow-xs",
                  recording
                    ? "border-primary text-primary ring-2 ring-primary/30"
                    : "bg-background hover:bg-accent/40",
                )}
              >
                {recording
                  ? "Press keys…"
                  : settings.globalShortcut
                    ? formatAccelerator(settings.globalShortcut)
                    : "Click to set"}
              </button>
              {settings.globalShortcut && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Clear global shortcut"
                  onClick={() => void save({ globalShortcut: "" })}
                >
                  <XIcon />
                </Button>
              )}
            </div>
          }
        />
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-3.5 py-3">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label} className="flex min-w-0 items-center justify-between gap-3 text-xs">
              <span className="truncate text-muted-foreground">{label}</span>
              <Kbd>{keys}</Kbd>
            </div>
          ))}
        </div>
      </Card>
    </Section>
  );
}

function reveal(target: RevealTarget) {
  api.revealPath(target).catch((err: unknown) => {
    toast.error("Could not show the folder", { description: errorMessage(err) });
  });
}

function StorageSection() {
  const { data: system } = useSystemInfo();
  if (!system) return null;
  const rows: [string, string, RevealTarget][] = [
    ["App data", system.dataDir, { kind: "data_dir" }],
    ["Account profiles", system.profilesDir, { kind: "profiles_dir" }],
    ["Logs", system.logsDir, { kind: "logs_dir" }],
  ];
  return (
    <Section
      title="Storage & privacy"
      description="Everything stays on this Mac. Claude Switch has no server, analytics, or telemetry."
    >
      <Card className="divide-y">
        {rows.map(([label, path, target]) => (
          <div key={label} className="flex items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] leading-5">{label}</div>
              <div className="selectable truncate font-mono text-[11px] text-muted-foreground">
                {path}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                reveal(target);
              }}
            >
              <FolderOpenIcon />
              Show
            </Button>
          </div>
        ))}
        <div className="space-y-1.5 px-3.5 py-3 text-xs leading-snug text-muted-foreground">
          <p>
            The database stores account names, labels, colors, project folders, and session times.
            It never stores passwords, tokens, cookies, sign-in links, terminal output, or
            conversations. Claude Code keeps each login in the macOS Keychain.
          </p>
          {system.orphanedProfiles.length > 0 && (
            <p className="text-foreground">
              {system.orphanedProfiles.length} profile folder
              {system.orphanedProfiles.length === 1 ? " is" : "s are"} left from removed accounts.
              Delete them in Finder if you no longer need them.
            </p>
          )}
        </div>
      </Card>
    </Section>
  );
}

function DiagnosticsSection() {
  const { data: system } = useSystemInfo();
  const [report, setReport] = useState<string | null>(null);
  const load = async () => {
    try {
      const text = await api.getDiagnostics();
      setReport(text);
      try {
        await navigator.clipboard.writeText(text);
        toast.success("Diagnostics copied to the clipboard");
      } catch {
        toast("Diagnostics ready", { description: "Select the text below to copy it." });
      }
    } catch (err) {
      toast.error("Could not collect diagnostics", { description: errorMessage(err) });
    }
  };
  return (
    <Section
      title="Troubleshooting"
      description="The report contains versions, paths, counts, and redacted logs. It excludes names, emails, tokens, environment values, and terminal output."
    >
      <Card className="space-y-3 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0">
            Claude Switch {system?.appVersion} · macOS {system?.osVersion} ({system?.arch})
          </span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <ClipboardCopyIcon />
            Copy Diagnostics
          </Button>
        </div>
        {report !== null && (
          <pre className="selectable max-h-64 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {report}
          </pre>
        )}
      </Card>
    </Section>
  );
}
