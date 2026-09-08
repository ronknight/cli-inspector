const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// The extension module imports `vscode`, which only exists inside the editor
// host — stub it so the pure helpers can be unit-tested under plain node.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") {
    return {
      workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
      window: {},
      commands: {},
      Uri: { file: (p) => ({ fsPath: p }) },
      ConfigurationTarget: { Global: 1 },
    };
  }
  return load.call(this, request, ...rest);
};
const ext = require("../out/extension");

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-inspector-"));
  return home;
}

test("macOS auto-detect prefers zsh, then bash, then fish", () => {
  const home = fakeHome();
  fs.writeFileSync(path.join(home, ".bash_history"), "ls\n");
  fs.writeFileSync(path.join(home, ".zsh_history"), ": 1:0;ls\n");
  fs.mkdirSync(path.join(home, ".local", "share", "fish"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "share", "fish", "fish_history"), "- cmd: ls\n");

  const found = ext.autoDetectSources("darwin", home, {});
  assert.deepStrictEqual(found, [
    path.join(home, ".zsh_history"),
    path.join(home, ".bash_history"),
    path.join(home, ".local", "share", "fish", "fish_history"),
  ]);
});

test("auto-detect finds nothing when the home has no history files", () => {
  assert.deepStrictEqual(ext.autoDetectSources("darwin", fakeHome(), {}), []);
});

test("$HISTFILE wins over the default candidates", () => {
  const home = fakeHome();
  const custom = path.join(home, ".myhist");
  fs.writeFileSync(custom, ": 1:0;ls\n");
  fs.writeFileSync(path.join(home, ".zsh_history"), ": 1:0;ls\n");

  const found = ext.autoDetectSources("darwin", home, { HISTFILE: custom });
  assert.strictEqual(found[0], custom);
  assert.strictEqual(ext.bestSource(found, { HISTFILE: custom }), custom);
});

test("bestSource picks the most recently written non-empty file", () => {
  const home = fakeHome();
  const zsh = path.join(home, ".zsh_history");
  const bash = path.join(home, ".bash_history");
  fs.writeFileSync(zsh, ": 1:0;ls\n");
  fs.writeFileSync(bash, "ls\n");
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(zsh, old, old);

  assert.strictEqual(ext.bestSource([zsh, bash], {}), bash);

  // an empty file never wins, however fresh
  fs.writeFileSync(bash, "");
  assert.strictEqual(ext.bestSource([zsh, bash], {}), zsh);
});

test("expandHome resolves ~ in the source setting", () => {
  assert.strictEqual(ext.expandHome("~/.zsh_history", "/Users/ron"), "/Users/ron/.zsh_history");
  assert.strictEqual(ext.expandHome("~", "/Users/ron"), "/Users/ron");
  assert.strictEqual(ext.expandHome("/abs/path", "/Users/ron"), "/abs/path");
});
