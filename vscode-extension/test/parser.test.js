const test = require("node:test");
const assert = require("node:assert");
const parser = require("../out/parser");

const HOME = "/Users/ron";
const mac = { platform: "darwin", homeDir: HOME };

test("zsh extended history: strips the ': <ts>:<elapsed>;' prefix", () => {
  const text =
    ": 1690000000:0;git status\n" +
    ": 1690000001:0;git status\n" +
    ": 1690000002:12;npm test\n";
  const { counts } = parser.collectCounts(text, 10, mac);
  assert.strictEqual(counts.get("git status"), 2);
  assert.strictEqual(counts.get("npm test"), 1);
  assert.strictEqual(counts.size, 2);
});

test("zsh multi-line entries join on the trailing backslash", () => {
  const text = ": 1690000000:0;for f in *; do\\\n echo $f\\\ndone\n";
  const { counts } = parser.collectCounts(text, 10, mac);
  assert.deepStrictEqual([...counts.keys()], ["for f in *; do echo $f done"]);
});

test("bash history: plain lines, HISTTIMEFORMAT stamps ignored", () => {
  const text = "#1690000000\nls -la\n#1690000001\nls -la\n";
  const { counts } = parser.collectCounts(text, 10, { ...mac, format: "bash" });
  assert.strictEqual(counts.get("ls -la"), 2);
  assert.strictEqual(counts.size, 1);
});

test("fish history: reads the cmd entries only", () => {
  const text =
    "- cmd: brew upgrade\n  when: 1690000000\n" +
    "- cmd: echo a\\nb\n  when: 1690000001\n  paths:\n    - x\n";
  const { counts } = parser.collectCounts(text, 10, { ...mac, format: "fish" });
  assert.strictEqual(counts.get("brew upgrade"), 1);
  assert.strictEqual(counts.get("echo a b"), 1);
  assert.strictEqual(counts.size, 2);
});

test("POSIX cd replay records absolute, relative, ~ and $HOME targets", () => {
  const text = [
    ": 1:0;cd /Users/ron/Projects",
    ": 2:0;npm test",
    ": 3:0;cd cli-inspector",
    ": 4:0;npm test",
    ": 5:0;cd ~/Projects",
    ": 6:0;npm test",
    ": 7:0;cd $HOME/Projects/gps",
    ": 8:0;npm test",
    "",
  ].join("\n");
  const { dirs } = parser.collectCounts(text, 10, mac);
  assert.deepStrictEqual(
    [...dirs.get("npm test").keys()].sort(),
    [
      "/Users/ron/Projects",
      "/Users/ron/Projects/cli-inspector",
      "/Users/ron/Projects/gps",
    ]
  );
  assert.strictEqual(dirs.get("npm test").get("/Users/ron/Projects"), 2);
});

test("cd -, bare cd, pushd/popd walk the directory stack", () => {
  const text = [
    ": 1:0;cd /tmp/a",
    ": 2:0;pushd /tmp/b",
    ": 3:0;here",
    ": 4:0;popd",
    ": 5:0;here",
    ": 6:0;cd -",
    ": 7:0;here",
    ": 8:0;cd",
    ": 9:0;here",
    "",
  ].join("\n");
  const { dirs } = parser.collectCounts(text, 10, mac);
  // pushd -> /tmp/b, popd -> back to /tmp/a, `cd -` -> /tmp/b again, `cd` -> ~
  assert.deepStrictEqual([...dirs.get("here").keys()], ["/tmp/b", "/tmp/a", HOME]);
  assert.strictEqual(dirs.get("here").get("/tmp/b"), 2);
});

test("POSIX venv activations collapse to one canonical command", () => {
  const text = [
    ": 1:0;source venv/bin/activate",
    ": 2:0;. ./.venv/bin/activate",
    ": 3:0;source /Users/ron/envs/venv/bin/activate.fish",
    "",
  ].join("\n");
  const { counts } = parser.collectCounts(text, 10, mac);
  assert.strictEqual(counts.get("source venv/bin/activate"), 3);
});

test("workspace filter matches POSIX paths case-insensitively on macOS", () => {
  const text = [
    ": 1:0;cd /Users/ron/Projects/cli-inspector",
    ": 2:0;npm test",
    ": 3:0;cd /Users/ron/Projects/other",
    ": 4:0;npm run build",
    "",
  ].join("\n");
  const out = parser.build(text, {
    topN: 10,
    recentN: 10,
    workspaceFilter: "/Users/ron/Projects/CLI-Inspector",
    platform: "darwin",
    homeDir: HOME,
  });
  // `npm test` ran in the workspace; so did the `cd` that left it (a command is
  // recorded in the directory it was typed in). `npm run build` did not.
  assert.deepStrictEqual(out.rows.map((r) => r.cmd), [
    "npm test",
    "cd /Users/ron/Projects/other",
  ]);
  assert.strictEqual(out.totalCommands, 2);
});

test("isInside does not treat a sibling prefix as a child", () => {
  assert.ok(parser.isInside("/a/b/c", "/a/b", "darwin"));
  assert.ok(!parser.isInside("/a/bb", "/a/b", "darwin"));
  assert.ok(!parser.isInside("/a/b", "/a/b/c", "darwin"));
  assert.ok(parser.isInside("C:\\A\\B", "c:\\a", "win32"));
});

test("Windows history still parses with win32 rules", () => {
  const text = [
    "cd C:\\Projects",
    "npm test",
    "cd cli-inspector",
    "npm test",
    ".\\venv\\Scripts\\Activate.ps1",
    "& C:\\src\\venv\\Scripts\\activate.bat",
    "",
  ].join("\n");
  const { counts, dirs } = parser.collectCounts(text, 10, {
    platform: "win32",
    homeDir: "C:\\Users\\ron",
    format: "psreadline",
  });
  assert.strictEqual(counts.get(".\\venv\\Scripts\\Activate.ps1"), 2);
  assert.deepStrictEqual([...dirs.get("npm test").keys()], [
    "C:\\Projects",
    "C:\\Projects\\cli-inspector",
  ]);
});

test("PSReadLine backtick continuations still join", () => {
  const text = "git commit `\r\n  -m 'x'\r\n";
  const { counts } = parser.collectCounts(text, 10, {
    platform: "win32",
    format: "psreadline",
  });
  assert.deepStrictEqual([...counts.keys()], ["git commit -m 'x'"]);
});

test("detectFormat sniffs each layout", () => {
  assert.strictEqual(parser.detectFormat(": 1690000000:0;ls\n"), "zsh");
  assert.strictEqual(parser.detectFormat("- cmd: ls\n  when: 1\n"), "fish");
  assert.strictEqual(parser.detectFormat("ls -la\ngit status\n"), "bash");
  assert.strictEqual(
    parser.detectFormat("ls -la\n", "/x/ConsoleHost_history.txt"),
    "psreadline"
  );
  assert.strictEqual(parser.detectFormat("", "/x/fish_history"), "fish");
});

test("decodeHistory un-metafies zsh's 0x83-escaped bytes", () => {
  const utf8 = Buffer.from("echo café\n", "utf8");
  const meta = [];
  for (const b of utf8) {
    if (b >= 0x80) {
      meta.push(0x83, b ^ 32);
    } else {
      meta.push(b);
    }
  }
  assert.strictEqual(parser.decodeHistory(Buffer.from(meta)), "echo café\n");
  assert.strictEqual(parser.decodeHistory(utf8), "echo café\n");
});
