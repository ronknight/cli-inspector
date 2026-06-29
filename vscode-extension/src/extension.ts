import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { build } from "./parser";

/** Candidate shell-history locations, in priority order, that actually exist. */
function autoDetectSources(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const appData =
      process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    candidates.push(
      path.join(
        appData,
        "Microsoft",
        "Windows",
        "PowerShell",
        "PSReadLine",
        "ConsoleHost_history.txt"
      )
    );
  }
  // cross-platform shells
  candidates.push(
    path.join(home, ".zsh_history"),
    path.join(home, ".bash_history"),
    path.join(home, ".local", "share", "fish", "fish_history")
  );

  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

async function resolveSource(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration("cliInspector")
    .get<string>("source", "")
    .trim();

  if (configured) {
    if (fs.existsSync(configured)) {
      return configured;
    }
    vscode.window.showErrorMessage(
      `CLI Inspector: configured history file not found:\n${configured}`
    );
    return undefined;
  }

  const found = autoDetectSources();
  if (found.length > 0) {
    return found[0];
  }

  const pick = await vscode.window.showWarningMessage(
    "CLI Inspector: couldn't auto-detect a shell history file. Pick one manually?",
    "Pick File…"
  );
  if (pick === "Pick File…") {
    return pickHistoryFile();
  }
  return undefined;
}

async function pickHistoryFile(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Use as history source",
    title: "Select shell history file",
  });
  if (!uris || uris.length === 0) {
    return undefined;
  }
  const chosen = uris[0].fsPath;
  await vscode.workspace
    .getConfiguration("cliInspector")
    .update("source", chosen, vscode.ConfigurationTarget.Global);
  return chosen;
}

/**
 * JSON for safe embedding inside an inline <script>. Escapes `<`/`>` so a
 * command line in the history containing `</script>` can't close the script
 * element and inject markup/code into the webview.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

function loadTemplate(context: vscode.ExtensionContext): string {
  const file = path.join(context.extensionPath, "media", "template.html");
  return fs.readFileSync(file, "utf8");
}

async function showCloud(
  context: vscode.ExtensionContext,
  workspaceOnly: boolean
): Promise<void> {
  const source = await resolveSource();
  if (!source) {
    return;
  }

  let workspaceFilter: string | undefined;
  if (workspaceOnly) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== "file") {
      vscode.window.showWarningMessage(
        "CLI Inspector: no local workspace folder is open to filter by."
      );
      return;
    }
    workspaceFilter = folder.uri.fsPath;
  }

  const cfg = vscode.workspace.getConfiguration("cliInspector");
  const topN = cfg.get<number>("topN", 100);
  const recentN = cfg.get<number>("recentN", 300);

  let text: string;
  try {
    text = fs.readFileSync(source, "utf8");
  } catch (err) {
    vscode.window.showErrorMessage(
      `CLI Inspector: failed to read ${source}: ${String(err)}`
    );
    return;
  }

  let result;
  try {
    result = build(text, { topN, recentN, workspaceFilter });
  } catch (err) {
    vscode.window.showWarningMessage(`CLI Inspector: ${String(err)}`);
    return;
  }

  const title = workspaceFilter
    ? `CLI Neuron Cloud — ${path.basename(workspaceFilter)}`
    : "CLI Neuron Cloud";

  const panel = vscode.window.createWebviewPanel(
    "cliInspector",
    title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const template = loadTemplate(context);
  // Pass a replacer FUNCTION (not a string) so `$&`/`$$` etc. inside commands
  // aren't interpreted as String.replace patterns and corrupt the JSON.
  panel.webview.html = template.replace("/*__DATA__*/[]", () =>
    safeJson(result.nodes)
  );

  panel.webview.onDidReceiveMessage(
    (msg) => {
      if (msg?.type === "copy" && typeof msg.text === "string") {
        vscode.env.clipboard.writeText(msg.text);
      }
    },
    undefined,
    context.subscriptions
  );

  vscode.window.setStatusBarMessage(
    `CLI Inspector: ${result.totalCommands} commands, ${result.uniqueCommands} unique`,
    5000
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("cliInspector.show", () =>
      showCloud(context, false)
    ),
    vscode.commands.registerCommand("cliInspector.showForWorkspace", () =>
      showCloud(context, true)
    ),
    vscode.commands.registerCommand("cliInspector.pickHistoryFile", () =>
      pickHistoryFile()
    )
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}
