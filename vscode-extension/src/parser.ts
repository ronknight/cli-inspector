// Port of cli_inspector.py — counts FULL shell command lines, tracks where they
// ran by replaying `cd` commands, and builds the data injected into the webview.
//
// Cross-platform: understands PSReadLine (Windows), zsh extended history and
// plain bash history (macOS/Linux) and fish history, and replays `cd` using the
// path rules of the platform the history came from.

import * as os from "os";
import * as path from "path";

export type HistoryFormat = "psreadline" | "zsh" | "bash" | "fish";

export interface BuildOptions {
  topN: number;
  recentN: number;
  workspaceFilter?: string;
  /** Platform whose path rules apply to the history. Defaults to the host. */
  platform?: NodeJS.Platform;
  /** Home directory used to expand `~`. Defaults to the host's. */
  homeDir?: string;
  /** History file layout. Defaults to sniffing the text. */
  format?: HistoryFormat;
}

export interface NodeDatum {
  cmd: string;
  label: string;
  count: number;
  dirs: [string, number][];
  w: number;
}

export interface RowDatum {
  cmd: string;
  count: number;
  dirs: [string, number][];
}

export interface BuildResult {
  nodes: NodeDatum[];
  rows: RowDatum[];
  totalCommands: number;
  uniqueCommands: number;
}

// any venv activation, any path/prefix style -> one canonical command
const WIN_ACTIVATE_RE =
  /^(?:&\s*)?['"]?[^'"]*venv[\\/]scripts[\\/]activate(?:\.ps1|\.bat)?['"]?$/i;
// `source .venv/bin/activate`, `. ~/envs/venv/bin/activate.fish`, …
const POSIX_ACTIVATE_RE =
  /^(?:source|\.)\s+['"]?[^'"]*venv\/bin\/activate(?:\.\w+)?['"]?$/i;

const CD_RE = /^(cd|chdir|sl|set-location|pushd)(?:\s+(.+))?$/i;
const POPD_RE = /^(?:popd)(?:\s|$)/i;

/** zsh extended-history line: `: <started>:<elapsed>;<command>`. */
const ZSH_ENTRY_RE = /^:\s\d+:\d+;/;
/** `#1699999999` timestamp comments written by bash with HISTTIMEFORMAT set. */
const BASH_TIMESTAMP_RE = /^#\d+$/;

/** Path helpers for the platform the history was recorded on. */
function pathsFor(platform: NodeJS.Platform) {
  const win = platform === "win32";
  return {
    win,
    p: win ? path.win32 : path.posix,
    sep: win ? "\\" : "/",
    // Windows and macOS both compare paths case-insensitively by default.
    ignoreCase: win || platform === "darwin",
  };
}

/**
 * Decode a raw history file.
 *
 * zsh "metafies" bytes >= 0x80 as 0x83 followed by (byte ^ 32) when it writes
 * $HISTFILE, so a naive UTF-8 decode turns every accented character or emoji in
 * the history into mojibake. Undo that first, then decode as UTF-8 (lossy — a
 * history file may legitimately contain bytes from another encoding).
 */
export function decodeHistory(buf: Buffer): string {
  if (!buf.includes(0x83)) {
    return buf.toString("utf8");
  }
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x83 && i + 1 < buf.length) {
      out[n++] = buf[++i] ^ 32;
    } else {
      out[n++] = buf[i];
    }
  }
  return out.subarray(0, n).toString("utf8");
}

/** Guess the history layout from the file's own contents (and name). */
export function detectFormat(text: string, filePath?: string): HistoryFormat {
  const name = filePath ? path.basename(filePath).toLowerCase() : "";
  if (name.includes("fish")) {
    return "fish";
  }
  if (name.includes("consolehost_history")) {
    return "psreadline";
  }

  const sample = text.split("\n", 200);
  let zsh = 0;
  let fish = 0;
  let content = 0;
  for (const line of sample) {
    if (!line.trim()) {
      continue;
    }
    content++;
    if (ZSH_ENTRY_RE.test(line)) {
      zsh++;
    } else if (/^- cmd:\s/.test(line)) {
      fish++;
    }
  }
  if (content === 0) {
    return "bash";
  }
  if (fish / content > 0.2) {
    return "fish";
  }
  if (zsh / content > 0.2) {
    return "zsh";
  }
  return "bash";
}

/** Unescape one fish history `- cmd:` payload. */
function unescapeFish(value: string): string {
  return value.replace(/\\(n|t|\\|")/g, (_m, c: string) =>
    c === "n" ? " " : c === "t" ? " " : c
  );
}

/**
 * Split a history file into the raw command lines it records, undoing whatever
 * multi-line continuation and per-entry metadata the format uses.
 */
export function extractLines(text: string, format: HistoryFormat): string[] {
  // Match Python's Path.read_text(): translate universal newlines (\r\n, \r)
  // to \n FIRST, so the continuation joins below catch \r\n files.
  text = text.replace(/\r\n?/g, "\n");

  if (format === "fish") {
    const out: string[] = [];
    for (const line of text.split("\n")) {
      const m = /^- cmd:\s?(.*)$/.exec(line);
      if (m) {
        out.push(unescapeFish(m[1]));
      }
    }
    return out;
  }

  if (format === "psreadline") {
    // join PSReadLine multi-line continuations (trailing backtick)
    return text.split("`\n").join(" ").split("\n");
  }

  // zsh escapes an embedded newline as a trailing backslash; bash with
  // `shopt -s cmdhist` does the same for multi-line pipelines.
  const joined = text.replace(/\\\n/g, " ");
  const out: string[] = [];
  for (const line of joined.split("\n")) {
    if (format === "zsh") {
      const cut = ZSH_ENTRY_RE.test(line) ? line.indexOf(";") + 1 : 0;
      out.push(line.slice(cut));
    } else if (!BASH_TIMESTAMP_RE.test(line.trim())) {
      out.push(line);
    }
  }
  return out;
}

function normalize(line: string): string | null {
  line = line.trim();
  if (!line || line.startsWith("#")) {
    return null;
  }
  // collapse internal whitespace so same command counts as one
  line = line.replace(/\s+/g, " ");
  if (WIN_ACTIVATE_RE.test(line)) {
    return ".\\venv\\Scripts\\Activate.ps1";
  }
  if (POSIX_ACTIVATE_RE.test(line)) {
    return "source venv/bin/activate";
  }
  return line;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Strip one layer of matching quotes / stop at a chain operator. */
function cdTarget(arg: string): string {
  let target = arg.trim();
  const quote = target[0];
  if (quote === "'" || quote === '"') {
    // quoted path: take quoted span
    return target.slice(1).split(quote)[0];
  }
  // unquoted: stop at chain operator
  target = target.split(/\s*[;&|]/)[0].trim();
  // `cd -- foo`, `cd -P /tmp` — drop leading option words
  while (/^-[-\w]*\s/.test(target)) {
    target = target.replace(/^-[-\w]*\s+/, "");
  }
  return target;
}

export interface CollectResult {
  counts: Map<string, number>;
  dirs: Map<string, Map<string, number>>;
  recent: string[];
}

/** Count commands AND track where they ran by replaying cd commands. */
export function collectCounts(
  text: string,
  recentN: number,
  opts: { platform?: NodeJS.Platform; homeDir?: string; format?: HistoryFormat } = {}
): CollectResult {
  const platform = opts.platform ?? process.platform;
  const home = opts.homeDir ?? os.homedir();
  const { win, p } = pathsFor(platform);
  const format = opts.format ?? detectFormat(text);

  const counts = new Map<string, number>();
  const dirs = new Map<string, Map<string, number>>();
  const commands: string[] = [];
  let cwd: string | null = null;
  let previous: string | null = null;
  const stack: string[] = [];

  const isAbsolute = (t: string): boolean =>
    win ? /^[A-Za-z]:[\\/]/.test(t) || t.startsWith("\\\\") : t.startsWith("/");

  for (const raw of extractLines(text, format)) {
    const cmd = normalize(raw);
    if (!cmd) {
      continue;
    }
    commands.push(cmd);
    bump(counts, cmd);
    if (cwd) {
      let inner = dirs.get(cmd);
      if (!inner) {
        inner = new Map<string, number>();
        dirs.set(cmd, inner);
      }
      bump(inner, cwd);
    }

    if (POPD_RE.test(cmd)) {
      const back = stack.pop();
      if (back) {
        previous = cwd;
        cwd = back;
      }
      continue;
    }

    const m = CD_RE.exec(cmd);
    if (!m) {
      continue;
    }
    if (m[1].toLowerCase() === "pushd" && cwd) {
      stack.push(cwd);
    }

    const arg = m[2];
    if (arg === undefined) {
      // bare `cd` (and bare `pushd` on POSIX) goes home
      previous = cwd;
      cwd = p.normalize(home);
      continue;
    }

    let target = cdTarget(arg);
    if (!target) {
      continue;
    }
    if (target === "-") {
      const back = previous;
      if (back) {
        previous = cwd;
        cwd = back;
      }
      continue;
    }
    // `$HOME/src`, `${HOME}/src`, `%USERPROFILE%\src`
    target = target.replace(/^(?:\$HOME|\$\{HOME\}|%USERPROFILE%)(?=$|[\\/])/i, home);

    const next = isAbsolute(target)
      ? p.normalize(target) // absolute -> jump
      : target === "~" || /^~[\\/]/.test(target)
        ? p.normalize(home + target.slice(1))
        : cwd
          ? p.normalize(p.join(cwd, target)) // relative -> walk
          : null;
    if (next) {
      previous = cwd;
      cwd = next;
    }
  }

  const seen = new Set<string>();
  const recent: string[] = [];
  for (let i = commands.length - 1; i >= 0 && recent.length < recentN; i--) {
    if (!seen.has(commands[i])) {
      seen.add(commands[i]);
      recent.push(commands[i]);
    }
  }
  return { counts, dirs, recent };
}

/** Stable sort by count descending — mirrors Python Counter.most_common. */
function mostCommon(
  counts: Map<string, number>,
  n?: number
): [string, number][] {
  const arr = [...counts.entries()];
  arr.sort((a, b) => b[1] - a[1]);
  return n === undefined ? arr : arr.slice(0, n);
}

function dirMostCommon(
  dirCounts: Map<string, number> | undefined,
  n: number
): [string, number][] {
  if (!dirCounts) {
    return [];
  }
  return [...dirCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function isInside(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const { p, sep, ignoreCase } = pathsFor(platform);
  let c = p.normalize(child);
  let pa = p.normalize(parent);
  if (ignoreCase) {
    c = c.toLowerCase();
    pa = pa.toLowerCase();
  }
  return c === pa || c.startsWith(pa.endsWith(sep) ? pa : pa + sep);
}

export function build(text: string, opts: BuildOptions): BuildResult {
  const platform = opts.platform ?? process.platform;
  const { counts, dirs, recent } = collectCounts(text, opts.recentN, {
    platform,
    homeDir: opts.homeDir,
    format: opts.format,
  });

  // Optional: restrict to commands recorded inside the workspace folder.
  let effectiveCounts = counts;
  let effectiveDirs = dirs;
  if (opts.workspaceFilter) {
    const wf = opts.workspaceFilter;
    effectiveCounts = new Map<string, number>();
    effectiveDirs = new Map<string, Map<string, number>>();
    for (const [cmd, dirCounts] of dirs) {
      let total = 0;
      const kept = new Map<string, number>();
      for (const [dir, n] of dirCounts) {
        if (isInside(dir, wf, platform)) {
          kept.set(dir, n);
          total += n;
        }
      }
      if (total > 0) {
        effectiveCounts.set(cmd, total);
        effectiveDirs.set(cmd, kept);
      }
    }
  }

  const top = mostCommon(effectiveCounts, opts.topN);
  if (top.length === 0) {
    throw new Error(
      opts.workspaceFilter
        ? "No history found for this workspace — nothing to visualize."
        : "No history found — nothing to visualize."
    );
  }

  const nodeCmds = new Map(top);
  for (const cmd of recent) {
    if (!nodeCmds.has(cmd) && effectiveCounts.has(cmd)) {
      nodeCmds.set(cmd, effectiveCounts.get(cmd)!);
    }
  }

  const ordered = [...nodeCmds.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  const maxC = ordered[0][1];
  const minC = ordered[ordered.length - 1][1];
  const lmax = Math.log(maxC);
  const lmin = Math.log(minC);
  const span = Math.max(lmax - lmin, 1e-9);

  const nodes: NodeDatum[] = ordered.map(([cmd, n]) => ({
    cmd,
    label: cmd.length <= 44 ? cmd : cmd.slice(0, 42) + "…",
    count: n,
    dirs: dirMostCommon(effectiveDirs.get(cmd), 6),
    w: (Math.log(n) - lmin) / span,
  }));

  const rows: RowDatum[] = mostCommon(effectiveCounts).map(([cmd, n]) => ({
    cmd,
    count: n,
    dirs: dirMostCommon(effectiveDirs.get(cmd), 3),
  }));

  let total = 0;
  for (const n of effectiveCounts.values()) {
    total += n;
  }

  return {
    nodes,
    rows,
    totalCommands: total,
    uniqueCommands: effectiveCounts.size,
  };
}
