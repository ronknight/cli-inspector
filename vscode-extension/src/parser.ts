// Port of cli_inspector.py — counts FULL shell command lines, tracks where they
// ran by replaying `cd` commands, and builds the data injected into the webview.

import * as os from "os";
import * as path from "path";

export interface ParseOptions {
  topN: number;
  recentN: number;
  /** If set, only keep commands whose recorded directory is inside this folder. */
  workspaceFilter?: string;
}

export interface NodeData {
  cmd: string;
  label: string;
  count: number;
  dirs: [string, number][];
  w: number;
}

export interface RowData {
  cmd: string;
  count: number;
  dirs: [string, number][];
}

export interface BuildResult {
  nodes: NodeData[];
  rows: RowData[];
  totalCommands: number;
  uniqueCommands: number;
}

// any venv activation, any path/prefix style -> one canonical command
const ACTIVATE_RE =
  /^(?:&\s*)?['"]?[^'"]*venv[\\/]scripts[\\/]activate(?:\.ps1|\.bat)?['"]?$/i;

const CD_RE = /^(?:cd|chdir|sl|set-location|pushd)\s+(.+)$/i;

function normalize(line: string): string | null {
  line = line.trim();
  if (!line || line.startsWith("#")) {
    return null;
  }
  // collapse internal whitespace so same command counts as one
  line = line.replace(/\s+/g, " ");
  if (ACTIVATE_RE.test(line)) {
    return ".\\venv\\Scripts\\Activate.ps1";
  }
  return line;
}

interface Counts {
  counts: Map<string, number>;
  dirs: Map<string, Map<string, number>>;
  recent: string[];
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Count commands AND track where they ran by replaying cd commands. */
export function collectCounts(text: string, recentN: number): Counts {
  const counts = new Map<string, number>();
  const dirs = new Map<string, Map<string, number>>();
  const commands: string[] = [];
  let cwd: string | null = null;

  // Match Python's Path.read_text(): translate universal newlines (\r\n, \r)
  // to \n FIRST, so the backtick-continuation join below catches \r\n files.
  text = text.replace(/\r\n?/g, "\n");
  // join PSReadLine multi-line continuations (trailing backtick)
  text = text.split("`\n").join(" ");

  for (const raw of text.split("\n")) {
    const cmd = normalize(raw);
    if (!cmd) {
      continue;
    }
    commands.push(cmd);
    bump(counts, cmd);
    if (cwd) {
      let inner = dirs.get(cmd);
      if (!inner) {
        inner = new Map();
        dirs.set(cmd, inner);
      }
      bump(inner, cwd);
    }
    const m = CD_RE.exec(cmd);
    if (m) {
      let target = m[1].trim();
      const quote = target[0];
      if (quote === "'" || quote === '"') {
        // quoted path: take quoted span
        target = target.slice(1).split(quote)[0];
      } else {
        // unquoted: stop at chain operator
        target = target.split(/\s*[;&|]/)[0].trim();
      }
      if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\")) {
        cwd = path.win32.normalize(target); // absolute -> jump
      } else if (target.startsWith("~")) {
        cwd = path.win32.normalize(os.homedir() + target.slice(1));
      } else if (cwd) {
        cwd = path.win32.normalize(path.win32.join(cwd, target)); // relative -> walk
      }
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

function isInside(child: string, parent: string): boolean {
  const c = path.win32.normalize(child).toLowerCase();
  const p = path.win32.normalize(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith("\\") ? p : p + "\\");
}

export function build(text: string, opts: ParseOptions): BuildResult {
  const { counts, dirs, recent } = collectCounts(text, opts.recentN);

  // Optional: restrict to commands recorded inside the workspace folder.
  let effectiveCounts = counts;
  let effectiveDirs = dirs;
  if (opts.workspaceFilter) {
    const wf = opts.workspaceFilter;
    effectiveCounts = new Map();
    effectiveDirs = new Map();
    for (const [cmd, dirCounts] of dirs) {
      let total = 0;
      const kept = new Map<string, number>();
      for (const [dir, n] of dirCounts) {
        if (isInside(dir, wf)) {
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

  const nodeCmds = new Map<string, number>(top);
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

  const nodes: NodeData[] = ordered.map(([cmd, n]) => ({
    cmd,
    label: cmd.length <= 44 ? cmd : cmd.slice(0, 42) + "…",
    count: n,
    dirs: dirMostCommon(effectiveDirs.get(cmd), 6),
    w: (Math.log(n) - lmin) / span,
  }));

  const rows: RowData[] = mostCommon(effectiveCounts).map(([cmd, n]) => ({
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
