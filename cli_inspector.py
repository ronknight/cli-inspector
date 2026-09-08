"""CLI Inspector — neuron tag cloud of most-used shell command lines.

Reads your shell history, counts FULL command lines (command + arguments) and
generates an interactive HTML brain-neuron visualization. Click node = copy
full command.

Cross-platform: PSReadLine (Windows), zsh extended history, plain bash history
and fish history (macOS/Linux). The history file is auto-detected; override it
with --source, or with SOURCE in a .env next to this script.
"""

import argparse
import json
import math
import ntpath
import os
import posixpath
import re
import sys
import webbrowser
from collections import Counter, defaultdict
from pathlib import Path

TOP_N = 100
RECENT_N = 300

# ---------------------------------------------------------------- source ----


def env_source() -> Path | None:
    """SOURCE=... from a .env next to this script, if present."""
    env = Path(__file__).with_name(".env")
    if env.is_file():
        for line in env.read_text(encoding="utf-8").splitlines():
            key, _, val = line.partition("=")
            if key.strip() == "SOURCE" and val.strip():
                return Path(os.path.expanduser(val.strip().strip('"')))
    return None


def default_sources() -> list[Path]:
    """Candidate history files for this platform, in priority order."""
    home = Path.home()
    candidates: list[Path] = []

    # An explicit $HISTFILE is the shell's own answer — trust it first.
    histfile = os.environ.get("HISTFILE")
    if histfile:
        candidates.append(Path(os.path.expanduser(histfile)))

    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
        candidates.append(
            appdata
            / "Microsoft"
            / "Windows"
            / "PowerShell"
            / "PSReadLine"
            / "ConsoleHost_history.txt"
        )

    zsh = [home / ".zsh_history", home / ".zhistory", home / ".histfile"]
    bash = [home / ".bash_history"]
    # zsh is the default shell on macOS; bash still is on most Linux boxes.
    candidates += zsh + bash if sys.platform == "darwin" else bash + zsh

    xdg = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    candidates.append(xdg / "fish" / "fish_history")
    candidates.append(home / ".local" / "share" / "fish" / "fish_history")

    seen: set[Path] = set()
    found: list[Path] = []
    for p in candidates:
        if p in seen:
            continue
        seen.add(p)
        if p.is_file():
            found.append(p)
    return found


def resolve_source(explicit: str | None) -> Path:
    """--source, then .env SOURCE, then auto-detection."""
    if explicit:
        p = Path(os.path.expanduser(explicit))
        if not p.is_file():
            raise SystemExit(f"History file not found: {p}")
        return p

    from_env = env_source()
    if from_env:
        if not from_env.is_file():
            raise SystemExit(f"SOURCE file not found: {from_env}")
        return from_env

    found = default_sources()
    if not found:
        raise SystemExit(
            "No shell history file found. Pass --source /path/to/history "
            "(or set SOURCE in .env)."
        )
    if os.environ.get("HISTFILE") and found[0] == Path(
        os.path.expanduser(os.environ["HISTFILE"])
    ):
        return found[0]
    # Several usually exist side by side (a stale ~/.bash_history next to a live
    # ~/.zsh_history); the one written most recently is the one in use.
    non_empty = [p for p in found if p.stat().st_size > 0]
    return max(non_empty or found, key=lambda p: p.stat().st_mtime)


# ---------------------------------------------------------------- reading ---

ZSH_ENTRY_RE = re.compile(r"^:\s\d+:\d+;")
BASH_TIMESTAMP_RE = re.compile(r"^#\d+$")
FISH_ENTRY_RE = re.compile(r"^- cmd:\s?(.*)$")


def read_history(source: Path) -> str:
    """
    Read a history file as text.

    zsh "metafies" bytes >= 0x80 as 0x83 followed by (byte ^ 32) when it writes
    $HISTFILE, so a naive decode turns every accented character or emoji into
    mojibake. Undo that first, then decode as UTF-8 (lossy — history files can
    hold bytes from any encoding).
    """
    raw = source.read_bytes()
    if 0x83 in raw:
        out = bytearray()
        i = 0
        while i < len(raw):
            if raw[i] == 0x83 and i + 1 < len(raw):
                out.append(raw[i + 1] ^ 32)
                i += 2
            else:
                out.append(raw[i])
                i += 1
        raw = bytes(out)
    return raw.decode("utf-8", errors="replace")


def detect_format(text: str, source: Path | None = None) -> str:
    """Guess the history layout: zsh | bash | fish | psreadline."""
    name = source.name.lower() if source else ""
    if "fish" in name:
        return "fish"
    if "consolehost_history" in name:
        return "psreadline"

    zsh = fish = content = 0
    for line in text.split("\n")[:200]:
        if not line.strip():
            continue
        content += 1
        if ZSH_ENTRY_RE.match(line):
            zsh += 1
        elif line.startswith("- cmd: "):
            fish += 1
    if not content:
        return "bash"
    if fish / content > 0.2:
        return "fish"
    if zsh / content > 0.2:
        return "zsh"
    return "bash"


def extract_lines(text: str, fmt: str) -> list[str]:
    """Undo per-entry metadata and multi-line continuations."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    if fmt == "fish":
        return [
            m.group(1).replace("\\n", " ").replace("\\t", " ").replace("\\\\", "\\")
            for m in (FISH_ENTRY_RE.match(line) for line in text.split("\n"))
            if m
        ]

    if fmt == "psreadline":
        # join PSReadLine multi-line continuations (trailing backtick)
        return text.replace("`\n", " ").split("\n")

    # zsh escapes an embedded newline as a trailing backslash; so does bash
    # with `shopt -s cmdhist`.
    joined = text.replace("\\\n", " ")
    lines = []
    for line in joined.split("\n"):
        if fmt == "zsh" and ZSH_ENTRY_RE.match(line):
            lines.append(line[line.index(";") + 1 :])
        elif fmt == "zsh":
            lines.append(line)
        elif not BASH_TIMESTAMP_RE.match(line.strip()):
            lines.append(line)
    return lines


# --------------------------------------------------------------- counting ---

# any venv activation, any path/prefix style -> one canonical command
WIN_ACTIVATE_RE = re.compile(
    r"^(?:&\s*)?['\"]?[^'\"]*venv[\\/]scripts[\\/]activate(?:\.ps1|\.bat)?['\"]?$",
    re.IGNORECASE,
)
POSIX_ACTIVATE_RE = re.compile(
    r"^(?:source|\.)\s+['\"]?[^'\"]*venv/bin/activate(?:\.\w+)?['\"]?$",
    re.IGNORECASE,
)


def normalize(line: str) -> str | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    # collapse internal whitespace so same command counts as one
    line = re.sub(r"\s+", " ", line)
    if WIN_ACTIVATE_RE.match(line):
        return r".\venv\Scripts\Activate.ps1"
    if POSIX_ACTIVATE_RE.match(line):
        return "source venv/bin/activate"
    return line


CD_RE = re.compile(r"^(cd|chdir|sl|set-location|pushd)(?:\s+(.+))?$", re.IGNORECASE)
POPD_RE = re.compile(r"^popd(?:\s|$)", re.IGNORECASE)


def cd_target(arg: str) -> str:
    """Strip one layer of quotes / stop at a chain operator."""
    target = arg.strip()
    if target[:1] in "'\"":
        return target[1:].split(target[0], 1)[0]
    target = re.split(r"\s*[;&|]", target, maxsplit=1)[0].strip()
    # `cd -- foo`, `cd -P /tmp` — drop leading option words
    while re.match(r"^-[-\w]*\s", target):
        target = re.sub(r"^-[-\w]*\s+", "", target)
    return target


def collect_counts(
    source: Path, recent_n: int = RECENT_N
) -> tuple[Counter, dict[str, Counter], list[str]]:
    """Count commands AND track where they ran by replaying cd commands."""
    if not source.is_file():
        raise SystemExit(f"History file not found: {source}")

    windows = sys.platform == "win32"
    pathmod = ntpath if windows else posixpath
    home = str(Path.home())

    counts: Counter = Counter()
    dirs: dict[str, Counter] = defaultdict(Counter)
    commands: list[str] = []
    cwd: str | None = None
    previous: str | None = None
    stack: list[str] = []

    text = read_history(source)
    for raw in extract_lines(text, detect_format(text, source)):
        cmd = normalize(raw)
        if not cmd:
            continue
        commands.append(cmd)
        counts[cmd] += 1
        if cwd:
            dirs[cmd][cwd] += 1

        if POPD_RE.match(cmd):
            if stack:
                previous, cwd = cwd, stack.pop()
            continue

        m = CD_RE.match(cmd)
        if not m:
            continue
        if m.group(1).lower() == "pushd" and cwd:
            stack.append(cwd)

        arg = m.group(2)
        if arg is None:                              # bare `cd` -> home
            previous, cwd = cwd, pathmod.normpath(home)
            continue

        target = cd_target(arg)
        if not target:
            continue
        if target == "-":                            # `cd -` -> previous
            if previous:
                previous, cwd = cwd, previous
            continue
        target = re.sub(
            r"^(?:\$HOME|\$\{HOME\}|%USERPROFILE%)(?=$|[\\/])", home, target,
            flags=re.IGNORECASE,
        )

        if windows:
            absolute = bool(re.match(r"^[A-Za-z]:[\\/]", target)) or target.startswith("\\\\")
        else:
            absolute = target.startswith("/")

        if absolute:
            previous, cwd = cwd, pathmod.normpath(target)      # absolute -> jump
        elif target == "~" or re.match(r"^~[\\/]", target):
            previous, cwd = cwd, pathmod.normpath(home + target[1:])
        elif cwd:
            previous, cwd = cwd, pathmod.normpath(pathmod.join(cwd, target))  # relative -> walk

    recent = list(dict.fromkeys(reversed(commands)))[:recent_n]
    return counts, dirs, recent


def build_html(
    counts: Counter,
    dirs: dict[str, Counter],
    recent: list[str],
    top_n: int = TOP_N,
) -> str:
    top = counts.most_common(top_n)
    if not top:
        raise SystemExit("No history found — nothing to visualize.")
    node_cmds = dict(top)
    for cmd in recent:
        node_cmds.setdefault(cmd, counts[cmd])
    top = sorted(node_cmds.items(), key=lambda item: (-item[1], item[0]))
    max_c, min_c = top[0][1], top[-1][1]
    nodes = [
        {
            "cmd": cmd,
            "label": cmd if len(cmd) <= 44 else cmd[:42] + "…",
            "count": n,
            "dirs": dirs.get(cmd, Counter()).most_common(6),
            # log scale 0..1
            "w": (math.log(n) - math.log(min_c))
            / max(math.log(max_c) - math.log(min_c), 1e-9),
        }
        for cmd, n in top
    ]
    allrows = [
        {"cmd": cmd, "count": n, "dirs": dirs.get(cmd, Counter()).most_common(3)}
        for cmd, n in counts.most_common()
    ]
    # Escape < and > so a command containing </script> can't break out of the
    # inline <script> and inject markup into the page.
    def safe(value: object) -> str:
        return json.dumps(value).replace("<", "\\u003c").replace(">", "\\u003e")

    html = TEMPLATE.replace("/*__DATA__*/[]", safe(nodes))
    return html.replace("/*__ALL__*/[]", safe(allrows))


TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CLI Neuron Cloud</title>
<style>
  html, body { margin:0; height:100%; overflow:hidden; background:#04060f;
               font-family:"Cascadia Code","Fira Code",Consolas,monospace; }
  #web   { position:absolute; inset:0; }
  #cloud { position:absolute; inset:0; }
  .node  { position:absolute; transform:translate(-50%,-50%); cursor:pointer;
           color:#9fd8ff; white-space:nowrap; user-select:none;
           text-shadow:0 0 8px rgba(80,180,255,.8), 0 0 24px rgba(60,140,255,.45);
           transition:color .15s, text-shadow .15s; animation:pulse 3s ease-in-out infinite; }
  .node:hover { color:#fff;
           text-shadow:0 0 12px #7df9ff, 0 0 36px #41c7ff, 0 0 60px #1f8fff; }
  .node small { display:none; }
  .node:hover small { display:block; position:absolute; left:50%; top:100%;
           transform:translateX(-50%); font-size:11px; color:#5e89b8; }
  @keyframes pulse { 0%,100% { opacity:.82 } 50% { opacity:1 } }
  #toast { position:fixed; bottom:28px; left:50%; transform:translateX(-50%) translateY(80px);
           background:#0c1830; color:#7df9ff; border:1px solid #1f8fff; border-radius:8px;
           padding:10px 22px; font-size:14px; transition:transform .25s; pointer-events:none;
           box-shadow:0 0 24px rgba(31,143,255,.5); z-index:10; }
  #toast.show { transform:translateX(-50%) translateY(0); }
  h1 { position:fixed; top:14px; left:22px; margin:0; font-size:14px; font-weight:400;
       color:#3d6fa3; letter-spacing:3px; }
  #search { position:fixed; top:10px; right:22px; width:260px; padding:8px 14px;
       background:rgba(10,24,48,.85); color:#9fd8ff; border:1px solid #1f5fa8;
       border-radius:20px; outline:none; font:13px inherit; font-family:inherit;
       box-shadow:0 0 14px rgba(31,143,255,.25); }
  #search:focus { border-color:#41c7ff; box-shadow:0 0 22px rgba(65,199,255,.5); }
  #search::placeholder { color:#3d6fa3; }
  #hits { position:fixed; top:42px; right:36px; font-size:11px; color:#3d6fa3; }
  #results { position:fixed; top:62px; right:22px; width:min(720px, calc(100vw - 44px));
       max-height:42vh; overflow:auto; display:none; z-index:9;
       background:rgba(8,18,40,.96); border:1px solid #1f5fa8; border-radius:10px;
       box-shadow:0 0 26px rgba(31,143,255,.28); }
  .result { display:flex; gap:12px; align-items:flex-start; padding:8px 10px;
       color:#9fd8ff; font-size:12px; line-height:1.35; cursor:pointer;
       border-top:1px solid rgba(31,95,168,.35); }
  .result:first-child { border-top:0; }
  .result:hover { background:rgba(65,199,255,.14); color:#fff; }
  .result b { color:#3d6fa3; font-weight:400; flex:0 0 auto; }
  .result span { word-break:break-all; }
  .node.dim { opacity:.06 !important; animation:none; pointer-events:none; }
  #backdrop { position:fixed; inset:0; background:rgba(2,4,12,.65); display:none;
       backdrop-filter:blur(2px); }
  #panel { position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
       min-width:440px; max-width:72vw; display:none;
       background:rgba(8,18,40,.96); border:1px solid #1f8fff; border-radius:14px;
       padding:20px 24px; box-shadow:0 0 50px rgba(31,143,255,.45); }
  #panel .cmd { color:#7df9ff; font-size:16px; word-break:break-all; cursor:pointer;
       padding:8px 10px; border-radius:8px; border:1px dashed rgba(65,199,255,.35); }
  #panel .cmd:hover { background:rgba(65,199,255,.12); }
  #panel .meta { color:#3d6fa3; font-size:11px; margin:10px 0 6px; letter-spacing:2px; }
  #panel .dir { color:#9fd8ff; font-size:13px; padding:6px 10px; border-radius:6px;
       cursor:pointer; display:flex; justify-content:space-between; gap:18px; }
  #panel .dir:hover { background:rgba(65,199,255,.14); color:#fff; }
  #panel .dir b { color:#3d6fa3; font-weight:400; flex-shrink:0; }
  #panel .none { color:#3d6fa3; font-size:12px; font-style:italic; padding:4px 10px; }
  #panel .close { position:absolute; top:8px; right:14px; color:#3d6fa3; cursor:pointer;
       font-size:18px; } #panel .close:hover { color:#7df9ff; }
  #panel .hint { color:#28507c; font-size:10px; margin-top:12px; letter-spacing:1px; }
</style>
</head>
<body>
<canvas id="web"></canvas>
<div id="cloud"></div>
<h1>⚡ CLI NEURON CLOUD — click to copy</h1>
<input id="search" type="text" placeholder="search commands…  ( / )">
<div id="hits"></div>
<div id="results"></div>
<div id="backdrop"></div>
<div id="panel"></div>
<div id="toast">copied</div>
<script>
const DATA = /*__DATA__*/[];
const canvas = document.getElementById('web'), ctx = canvas.getContext('2d');
const cloud = document.getElementById('cloud');
let W, H, nodes = [];

function resize() {
  W = canvas.width = innerWidth; H = canvas.height = innerHeight;
}
resize();

// --- mouse state (drives repel + glow animation) ---
const mouse = {x: -9999, y: -9999};
addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
addEventListener('mouseleave', () => { mouse.x = -9999; mouse.y = -9999; });

// --- place nodes: biggest near center, spiral outward, collision-avoid ---
function layout() {
  cloud.innerHTML = ''; nodes = [];
  const placed = [];
  DATA.forEach((d, i) => {
    const el = document.createElement('div');
    el.className = 'node';
    const size = 12 + d.w * 34;                        // 12px .. 46px (full lines are long)
    el.style.fontSize = size + 'px';
    const hue = 195 + (1 - d.w) * 45;                  // big=cyan, small=violet-blue
    el.style.color = `hsl(${hue} 90% ${62 + d.w * 18}%)`;
    el.innerHTML = d.label + '<small>' + d.count + '× — click copies full</small>';
    el.title = d.cmd;
    cloud.appendChild(el);
    const bw = el.offsetWidth / 2 + 14, bh = el.offsetHeight / 2 + 10;
    // archimedean spiral from center until no overlap
    let x = W/2, y = H/2, a = Math.random() * Math.PI * 2, r = 0, ok = false;
    for (let t = 0; t < 3000 && !ok; t++) {
      x = W/2 + r * Math.cos(a); y = H/2 + r * Math.sin(a) * 0.62;
      ok = x - bw > 10 && x + bw < W - 10 && y - bh > 40 && y + bh < H - 10 &&
           placed.every(p => Math.abs(p.x - x) > p.bw + bw || Math.abs(p.y - y) > p.bh + bh);
      a += 0.35; r += 1.1;
    }
    el.style.animationDelay = (Math.random() * 3) + 's';
    el.onclick = () => openPanel(d, el);
    placed.push({x, y, bw, bh});
    // dx/dy = eased cursor-repel offset, applied each frame
    nodes.push({x, y, bw, bh, dx: 0, dy: 0, w: d.w, el, cmd: d.cmd, dim: false});
  });
  buildEdges();
}

// --- synapses: connect each node to its 2-3 nearest neighbors ---
let edges = [], pulses = [];
function buildEdges() {
  edges = []; pulses = [];
  nodes.forEach((n, i) => {
    const near = nodes.map((m, j) => ({j, d: Math.hypot(m.x - n.x, m.y - n.y)}))
      .filter(o => o.j !== i).sort((a, b) => a.d - b.d)
      .slice(0, 2 + Math.round(n.w * 2));
    near.forEach(o => {
      if (!edges.some(e => (e.a === o.j && e.b === i)))
        edges.push({a: i, b: o.j, d: o.d});
    });
  });
  // travelling signal pulses on random synapses
  for (let k = 0; k < 26; k++) spawnPulse();
}
function spawnPulse() {
  pulses.push({e: edges[Math.random() * edges.length | 0], t: 0,
               speed: 0.004 + Math.random() * 0.01});
}

const REPEL_R = 180, REPEL_F = 34;
function draw(ts) {
  ctx.clearRect(0, 0, W, H);
  // cursor-repel: nodes shy away from mouse — EXCEPT the one being pointed at
  nodes.forEach(n => {
    const pointed = Math.abs(mouse.x - n.x) < n.bw + 12 &&
                    Math.abs(mouse.y - n.y) < n.bh + 12;
    const ddx = n.x - mouse.x, ddy = n.y - mouse.y;
    const dist = Math.hypot(ddx, ddy);
    let tx = 0, ty = 0;
    if (!pointed && dist < REPEL_R && dist > 0.01) {
      const f = (1 - dist / REPEL_R) * REPEL_F * (1.3 - n.w * 0.6); // small nodes flee more
      tx = ddx / dist * f; ty = ddy / dist * f;
    }
    n.dx += (tx - n.dx) * 0.12; n.dy += (ty - n.dy) * 0.12;
    n.px = n.x + n.dx; n.py = n.y + n.dy;
    n.el.style.left = n.px + 'px'; n.el.style.top = n.py + 'px';
  });
  // synapse lines (brighter near cursor, faded if endpoint filtered out)
  edges.forEach(e => {
    const A = nodes[e.a], B = nodes[e.b];
    const fade = (A.dim || B.dim) ? 0.12 : 1;
    const flicker = 0.5 + 0.5 * Math.sin(ts / 900 + e.a * 1.7 + e.b);
    const mx = (A.px + B.px) / 2 + Math.sin(e.a + e.b) * 28;
    const my = (A.py + B.py) / 2 + Math.cos(e.a * 2.1) * 28;
    const prox = Math.max(0, 1 - Math.hypot(mx - mouse.x, my - mouse.y) / 260);
    ctx.strokeStyle = `rgba(${45 + prox * 90},${120 + prox * 90},${220 + prox * 35},${(0.05 + 0.10 * flicker + prox * 0.45) * fade})`;
    ctx.lineWidth = 0.8 + (A.w + B.w) * 0.8 + prox * 1.2;
    ctx.beginPath(); ctx.moveTo(A.px, A.py);
    ctx.quadraticCurveTo(mx, my, B.px, B.py); ctx.stroke();
    e.mx = mx; e.my = my; e.prox = prox; e.fade = fade;
  });
  // travelling pulses (neural signals) — speed up near cursor
  pulses.forEach(p => {
    p.t += p.speed * (1 + (p.e.prox || 0) * 2.5);
    if (p.t >= 1) {
      p.t = 0;
      // prefer synapses between visible (non-filtered) nodes
      for (let tries = 0; tries < 8; tries++) {
        p.e = edges[Math.random() * edges.length | 0];
        if (p.e.fade === undefined || p.e.fade === 1) break;
      }
    }
    const A = nodes[p.e.a], B = nodes[p.e.b], t = p.t, u = 1 - t;
    const x = u*u*A.px + 2*u*t*p.e.mx + t*t*B.px;
    const y = u*u*A.py + 2*u*t*p.e.my + t*t*B.py;
    ctx.globalAlpha = p.e.fade ?? 1;
    const g = ctx.createRadialGradient(x, y, 0, x, y, 7);
    g.addColorStop(0, 'rgba(140,235,255,.95)');
    g.addColorStop(1, 'rgba(140,235,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  });
  requestAnimationFrame(draw);
}

// --- search: live filter, matches stay lit, rest fade ---
const searchBox = document.getElementById('search');
const hits = document.getElementById('hits');
const results = document.getElementById('results');
searchBox.addEventListener('input', () => {
  const q = searchBox.value.trim().toLowerCase();
  let shown = 0;
  const matches = [];
  nodes.forEach(n => {
    n.dim = !!q && !n.cmd.toLowerCase().includes(q);
    n.el.classList.toggle('dim', n.dim);
    if (!n.dim) {
      shown++;
      if (q) matches.push(n);
    }
  });
  hits.textContent = q ? shown + ' / ' + nodes.length : '';
  results.style.display = q ? 'block' : 'none';
  results.innerHTML = matches.slice(0, 30).map(n =>
    '<div class="result" data-cmd="' + esc(n.cmd) + '"><b>' + n.count + '×</b><span>' + esc(n.cmd) + '</span></div>'
  ).join('');
});
results.addEventListener('click', e => {
  const row = e.target.closest('.result');
  if (!row) return;
  const d = DATA.find(item => item.cmd === row.dataset.cmd);
  const node = nodes.find(item => item.cmd === row.dataset.cmd);
  if (d && node) openPanel(d, node.el);
});
addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== searchBox) {
    e.preventDefault(); searchBox.focus();
  } else if (e.key === 'Escape') {
    if (panel.style.display === 'block') { closePanel(); return; }
    searchBox.value = ''; searchBox.dispatchEvent(new Event('input')); searchBox.blur();
  }
});

function copy(text, el) {
  navigator.clipboard.writeText(text);
  const toast = document.getElementById('toast');
  toast.textContent = 'copied: ' + (text.length > 70 ? text.slice(0, 68) + '…' : text);
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 1400);
  if (el) {
    el.style.textShadow = '0 0 20px #fff, 0 0 60px #41c7ff';
    setTimeout(() => el.style.textShadow = '', 350);
  }
}

// --- expand panel: full command + where it ran (click any line = copy) ---
const panel = document.getElementById('panel');
const backdrop = document.getElementById('backdrop');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function openPanel(d, nodeEl) {
  copy(d.cmd, nodeEl);                       // click still copies command instantly
  let html = '<span class="close">✕</span>'
    + '<div class="cmd" title="copy command">' + esc(d.cmd) + '</div>'
    + '<div class="meta">RAN ' + d.count + '× — WHERE:</div>';
  if (d.dirs.length) {
    d.dirs.forEach(([p, n]) => {
      html += '<div class="dir" title="copy path"><span>' + esc(p) + '</span><b>' + n + '×</b></div>';
    });
  } else {
    html += '<div class="none">location unknown (no cd trail before it)</div>';
  }
  html += '<div class="hint">CLICK COMMAND OR PATH TO COPY · ESC TO CLOSE</div>';
  panel.innerHTML = html;
  panel.style.display = 'block'; backdrop.style.display = 'block';
  panel.querySelector('.cmd').onclick = () => copy(d.cmd);
  panel.querySelector('.close').onclick = closePanel;
  panel.querySelectorAll('.dir').forEach((row, i) => {
    row.onclick = () => copy(d.dirs[i][0]);
  });
}
function closePanel() { panel.style.display = 'none'; backdrop.style.display = 'none'; }
backdrop.onclick = closePanel;

addEventListener('resize', () => { resize(); layout(); });
layout();
requestAnimationFrame(draw);
</script>
</body>
</html>
"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", help="history file to read (default: auto-detect)")
    ap.add_argument("--top", type=int, default=TOP_N, help=f"large nodes (default {TOP_N})")
    ap.add_argument("--recent", type=int, default=RECENT_N,
                    help=f"recent unique commands to include (default {RECENT_N})")
    ap.add_argument("--out", help="output HTML path (default: neuron_cloud.html next to this script)")
    ap.add_argument("--no-open", action="store_true", help="don't open the result in a browser")
    args = ap.parse_args()

    source = resolve_source(args.source)
    counts, dirs, recent = collect_counts(source, args.recent)
    out = Path(args.out).expanduser() if args.out else Path(__file__).with_name("neuron_cloud.html")
    out.write_text(build_html(counts, dirs, recent, args.top), encoding="utf-8")
    total = sum(counts.values())
    print(f"Read {source}")
    print(f"Parsed {total} commands, {len(counts)} unique. Top 10:")
    for cmd, n in counts.most_common(10):
        print(f"  {n:6d}  {cmd}")
    print(f"\nWrote {out}")
    if not args.no_open:
        webbrowser.open(out.as_uri())


if __name__ == "__main__":
    main()
