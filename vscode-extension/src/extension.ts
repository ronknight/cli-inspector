import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { build, decodeHistory, detectFormat, BuildResult } from "./parser";

/** Candidate shell-history locations, in priority order, that actually exist. */
export function autoDetectSources(
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const candidates: string[] = [];

  // An explicit $HISTFILE always wins — it is the shell's own answer.
  if (env.HISTFILE) {
    candidates.push(
      path.isAbsolute(env.HISTFILE) ? env.HISTFILE : path.join(home, env.HISTFILE)
    );
  }

  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
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

  // zsh is the default shell on macOS; bash still the default on most Linux.
  const zsh = [
    path.join(home, ".zsh_history"),
    path.join(home, ".zhistory"),
    path.join(home, ".histfile"),
  ];
  const bash = [path.join(home, ".bash_history")];
  candidates.push(...(platform === "darwin" ? [...zsh, ...bash] : [...bash, ...zsh]));

  const xdgData = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  candidates.push(
    path.join(xdgData, "fish", "fish_history"),
    path.join(home, ".local", "share", "fish", "fish_history")
  );

  const seen = new Set<string>();
  return candidates.filter((p) => {
    if (seen.has(p)) {
      return false;
    }
    seen.add(p);
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Pick the history file to read. $HISTFILE, when set, is authoritative;
 * otherwise prefer the file the user has actually been writing to — several
 * candidates commonly exist side by side (a stale ~/.bash_history left over on
 * a Mac that has used zsh for years, say), so the newest one wins.
 */
export function bestSource(found: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (found.length === 0) {
    return undefined;
  }
  if (env.HISTFILE) {
    const explicit = path.isAbsolute(env.HISTFILE)
      ? env.HISTFILE
      : path.join(os.homedir(), env.HISTFILE);
    if (found.includes(explicit)) {
      return explicit;
    }
  }
  let best = found[0];
  let bestTime = -Infinity;
  for (const p of found) {
    let mtime = 0;
    try {
      const st = fs.statSync(p);
      if (st.size === 0) {
        continue;
      }
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    if (mtime > bestTime) {
      best = p;
      bestTime = mtime;
    }
  }
  return best;
}

async function resolveSource(): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration("cliInspector")
    .get<string>("source", "")
    .trim();

  if (configured) {
    const expanded = expandHome(configured);
    if (fs.existsSync(expanded)) {
      return expanded;
    }
    vscode.window.showErrorMessage(
      `CLI Inspector: configured history file not found:\n${expanded}`
    );
    return undefined;
  }

  const chosen = bestSource(autoDetectSources());
  if (chosen) {
    return chosen;
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

/** `~/.zsh_history` in settings should work as well as an absolute path. */
export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(home, p.slice(2));
  }
  return p;
}

async function pickHistoryFile(): Promise<string | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Use as history source",
    title: "Select shell history file",
    // Dotfiles live in $HOME on macOS/Linux; start the dialog there.
    defaultUri: vscode.Uri.file(os.homedir()),
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
  return JSON.stringify(value).replace(
    /[<>]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
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
    text = decodeHistory(fs.readFileSync(source));
  } catch (err) {
    vscode.window.showErrorMessage(
      `CLI Inspector: failed to read ${source}: ${String(err)}`
    );
    return;
  }

  const format = detectFormat(text, source);

  let result: BuildResult;
  try {
    result = build(text, { topN, recentN, workspaceFilter, format });
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
  // DATA = cloud nodes (top/recent subset); ROWS = every command, for search.
  panel.webview.html = template
    .replace("/*__DATA__*/[]", () => safeJson(result.nodes))
    .replace("/*__ALL__*/[]", () => safeJson(result.rows));

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
    `CLI Inspector: ${result.totalCommands} commands, ${result.uniqueCommands} unique (${path.basename(source)})`,
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
