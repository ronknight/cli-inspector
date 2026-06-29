# CLI Inspector — Neuron Cloud (VSCode extension)

An interactive **neuron tag-cloud** of your most-used shell command lines, right
inside VSCode. Each node is a full command line (command + arguments); size and
colour scale with how often you've run it. Click a node to copy the full command
to your clipboard and see *where* it was run.

This is a TypeScript port of the standalone `cli_inspector.py` script — it needs
**no Python** and works in any workspace.

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and run:

| Command | What it does |
| --- | --- |
| **CLI Inspector: Show Neuron Cloud** | Visualize your entire shell history. |
| **CLI Inspector: Show Neuron Cloud (this workspace only)** | Only commands recorded as running inside the open workspace folder. |
| **CLI Inspector: Pick History File…** | Choose the history file manually and save it to settings. |

## History source

By default the extension auto-detects your shell history:

- **Windows** — PSReadLine `…\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`
- **macOS / Linux** — `~/.zsh_history`, then `~/.bash_history`, then fish history

Override it with the `cliInspector.source` setting (or the *Pick History File…*
command) if your history lives elsewhere.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cliInspector.source` | `""` | Absolute path to the history file. Empty = auto-detect. |
| `cliInspector.topN` | `100` | Most-frequent commands rendered as large nodes. |
| `cliInspector.recentN` | `300` | Recent unique commands also included as nodes. |

## Controls (in the cloud)

- **Click a node** — copies the full command, opens a panel with run-count and directories.
- **`/`** — focus the search box; matches stay lit, the rest fade.
- **`Esc`** — close the panel / clear the search.

## Develop

```bash
cd vscode-extension
npm install
npm run compile      # or: npm run watch
```

Press **F5** in VSCode to launch an Extension Development Host, then run one of
the commands above. Package a `.vsix` with `npx @vscode/vsce package`.

## How the "where did it run" works

The parser replays `cd` / `Set-Location` / `pushd` commands as it scans the
history, so each command is associated with the directory it most likely ran in.
That's also what powers the *(this workspace only)* view. Commands with no `cd`
trail before them show *location unknown*.
