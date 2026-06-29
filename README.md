# Rust Smart Runner

Run, debug, and copy Cargo commands for Rust runnable targets with smart, workspace-aware `Cargo.toml` resolution.

![Run and debug Rust targets directly from VS Code](https://raw.githubusercontent.com/diacinth/rust-smart-runner/main/images/readme/hero-run-debug.png)

Rust Smart Runner helps you work with Rust executable targets directly from VS Code:

- ▶ Run the current Rust target
- 🐞 Debug the current Rust target with CodeLLDB
- 📋 Copy the generated Cargo command
- 🧭 Resolve the most appropriate Cargo manifest in workspace layouts
- 🔍 Explain manifest resolution with diagnostics
- 🧪 Diagnose target/package ambiguity in complex Cargo workspaces

---

## Why Rust Smart Runner?

Rust projects are wonderfully straightforward... until they become gloriously not straightforward.

When you work in:

- single-crate projects
- Cargo workspaces
- monorepos
- multi-root VS Code workspaces

it is not always obvious which `Cargo.toml` should be used for the current file.

Rust Smart Runner helps with exactly that:

- finds the right runnable target
- selects the most appropriate manifest
- adds `-p <package>` when needed in workspace-root scenarios
- explains its decision when things get complicated

---

## Features

### Run Rust

Run the current Rust runnable target directly from VS Code.

![Run Rust demo](https://raw.githubusercontent.com/diacinth/rust-smart-runner/main/images/readme/demo-run.gif)

Supported runnable target kinds:

- `bin`
- `example`

---

### Debug Rust

Start a debug session for the current Rust target using CodeLLDB-compatible debuggers.

Supported debugger extensions:

- `vadimcn.vscode-lldb`
- `llvm-vs-code-extensions.lldb-dap`

---

### Copy Cargo Command

Copy the exact generated Cargo command to the clipboard.

Example:

```bash
cargo run --manifest-path /repo/Cargo.toml -p app --bin app
```

---

### Reveal Resolved Target

Inspect how the current file was resolved.

![Reveal resolved target](https://raw.githubusercontent.com/diacinth/rust-smart-runner/main/images/readme/reveal-resolved-target.png)

This includes:

- selected manifest
- manifest source
- package name
- target kind
- target name
- target source path
- generated run/debug command data

---

### Explain Manifest Resolution

Understand why a specific manifest was selected.

![Explain manifest resolution](https://raw.githubusercontent.com/diacinth/rust-smart-runner/main/images/readme/demo-diagnostics.gif)

This includes:

- nearest manifest
- workspace root manifest
- candidate manifests
- selection strategy
- evaluation results
- final selection reason

---

### Workspace-aware package resolution

When `rustSmartRunner.manifestSelectionStrategy` is set to `workspaceRoot`, Rust Smart Runner can automatically add `-p <package>` for member targets.

![Workspace package-aware command generation](https://raw.githubusercontent.com/diacinth/rust-smart-runner/main/images/readme/demo-workspace-package.gif)

This helps make generated commands more explicit and more reliable in Cargo workspace scenarios.

---

### Context menu integration

Use Rust Smart Runner directly from the editor or explorer context menu.

![Context menu](https://raw.githubusercontent.com/diacinth/rust-smart-runner/main/images/readme/context-menu.png)

---

## Supported project layouts

Rust Smart Runner is designed to work well with:

- single-crate Rust projects
- Cargo workspaces
- monorepos
- multi-root VS Code workspaces

### Single crate

```text
app/
├─ Cargo.toml
└─ src/
   └─ main.rs
```

### Cargo workspace

```text
repo/
├─ Cargo.toml
├─ crates/
│  ├─ app/
│  │  ├─ Cargo.toml
│  │  └─ src/main.rs
│  └─ cli/
│     ├─ Cargo.toml
│     └─ src/bin/dev.rs
└─ examples/
   └─ top_demo.rs
```

### Multi-root workspace

```text
workspace.code-workspace
├─ service-a/
│  ├─ Cargo.toml
│  └─ src/main.rs
└─ service-b/
   ├─ Cargo.toml
   └─ examples/demo.rs
```

---

## Requirements

### Rust / Cargo

You need a working Rust toolchain with `cargo` available.

### For debugging

Install one of the following VS Code extensions:

- CodeLLDB: `vadimcn.vscode-lldb`
- LLDB DAP: `llvm-vs-code-extensions.lldb-dap`

---

## Commands

Rust Smart Runner contributes the following commands:

- `Rust Smart Runner: Run Rust`
- `Rust Smart Runner: Debug Rust`
- `Rust Smart Runner: Copy Cargo Command`
- `Rust Smart Runner: Refresh Metadata Cache`
- `Rust Smart Runner: Reveal Resolved Target`
- `Rust Smart Runner: Explain Manifest Resolution`

These commands are available from:

- Command Palette
- editor context menu
- explorer context menu
- editor title buttons for runnable targets

---

## How it works

Rust Smart Runner uses Cargo metadata to determine whether the current Rust file belongs to a runnable target.

Currently supported runnable target kinds:

- `bin`
- `example`

A file is considered runnable only if it matches a supported Cargo target in the selected manifest context.

---

## Manifest selection strategies

Use `rustSmartRunner.manifestSelectionStrategy` to control manifest selection behavior.

### `auto` (default)

Smart selection:

- checks the nearest manifest
- checks the workspace root manifest
- evaluates which one can resolve the current file
- picks the most reasonable manifest

### `nearest`

Always uses the nearest `Cargo.toml`.

### `workspaceRoot`

Prefers the workspace root `Cargo.toml` when available, otherwise falls back to the nearest manifest.

---

## Recommended settings

For most Cargo workspace users, this is the recommended setup:

```json
{
  "rustSmartRunner.manifestSelectionStrategy": "auto",
  "rustSmartRunner.addPackageArgInWorkspaceRoot": true
}
```

---

## Settings

### `rustSmartRunner.cargoPath`

Optional absolute path to the `cargo` executable.

Default:

```json
"rustSmartRunner.cargoPath": ""
```

If empty, Cargo is resolved from system `PATH`.

---

### `rustSmartRunner.cargoCommandArgs`

Arguments inserted between `cargo` and the subcommand.

Example:

```json
"rustSmartRunner.cargoCommandArgs": ["+nightly"]
```

Produces:

```bash
cargo +nightly run ...
```

---

### `rustSmartRunner.cargoSubcommandArgs`

Arguments inserted after the Cargo subcommand.

Example:

```json
"rustSmartRunner.cargoSubcommandArgs": ["--release"]
```

Produces:

```bash
cargo run --release ...
```

---

### `rustSmartRunner.cargoExtraArgs`

Legacy compatibility option.

If both `cargoCommandArgs` and `cargoSubcommandArgs` are empty, this value is treated as `cargoCommandArgs`.

---

### `rustSmartRunner.runArgs`

Arguments passed to the target program after `--`.

Example:

```json
"rustSmartRunner.runArgs": ["--port", "3000"]
```

---

### `rustSmartRunner.env`

Environment variables used for run/debug.

Example:

```json
"rustSmartRunner.env": {
  "RUST_LOG": "debug"
}
```

---

### `rustSmartRunner.autoSaveBeforeRun`

Automatically save the active file before run/debug.

Default:

```json
true
```

---

### `rustSmartRunner.requireMainRsOnly`

If enabled, commands only work on files named `main.rs`.

Default:

```json
false
```

---

### `rustSmartRunner.revealOutputOnError`

Reveal the output channel when an error occurs.

Default:

```json
true
```

---

### `rustSmartRunner.showStatusBarButtons`

Show status bar buttons for Run / Debug / Copy Cargo Command on runnable Rust targets.

Default:

```json
true
```

---

### `rustSmartRunner.metadataCacheTtlMs`

TTL in milliseconds for cached Cargo metadata.

Default:

```json
3000
```

---

### `rustSmartRunner.cargoValidationCacheTtlMs`

TTL in milliseconds for cached Cargo validation.

Default:

```json
10000
```

---

### `rustSmartRunner.uiRefreshDebounceMs`

Debounce delay in milliseconds for UI refresh.

Default:

```json
120
```

---

### `rustSmartRunner.debugLogging`

Enable verbose internal logging.

Default:

```json
false
```

---

### `rustSmartRunner.manifestSelectionStrategy`

Allowed values:

- `"auto"`
- `"nearest"`
- `"workspaceRoot"`

Default:

```json
"auto"
```

---

### `rustSmartRunner.addPackageArgInWorkspaceRoot`

When using a workspace root manifest, automatically add `-p <package>` for member targets.

Default:

```json
true
```

---

## Example configuration

```json
{
  "rustSmartRunner.cargoCommandArgs": [],
  "rustSmartRunner.cargoSubcommandArgs": ["--release"],
  "rustSmartRunner.runArgs": [],
  "rustSmartRunner.env": {
    "RUST_LOG": "info"
  },
  "rustSmartRunner.manifestSelectionStrategy": "auto",
  "rustSmartRunner.addPackageArgInWorkspaceRoot": true,
  "rustSmartRunner.debugLogging": false
}
```

---

## Usage

### Run a Rust target

Open a Rust file that belongs to a runnable target, then use one of:

- editor title button
- context menu
- Command Palette → `Rust Smart Runner: Run Rust`

### Debug a Rust target

Open a runnable Rust target file, then run:

- `Rust Smart Runner: Debug Rust`

### Copy the generated Cargo command

Use:

- `Rust Smart Runner: Copy Cargo Command`

### Reveal the resolved target

Use:

- `Rust Smart Runner: Reveal Resolved Target`

### Explain manifest selection

Use:

- `Rust Smart Runner: Explain Manifest Resolution`

### Refresh internal caches

Use:

- `Rust Smart Runner: Refresh Metadata Cache`

This is useful after changing:

- `Cargo.toml`
- workspace members
- `[[bin]]`
- `[[example]]`
- target paths

---

## Troubleshooting

### The Run/Debug buttons do not appear

Check that:

- the active file is a saved `.rs` file
- the file belongs to a runnable Cargo target
- Cargo is installed and available
- the file is not only a library target

You can also use:

- `Rust Smart Runner: Reveal Resolved Target`
- `Rust Smart Runner: Explain Manifest Resolution`

---

### Debug does not start

Make sure one of the following is installed:

- `vadimcn.vscode-lldb`
- `llvm-vs-code-extensions.lldb-dap`

---

### The wrong manifest was selected

Try:

1. `Rust Smart Runner: Explain Manifest Resolution`
2. changing `rustSmartRunner.manifestSelectionStrategy`
3. `Rust Smart Runner: Refresh Metadata Cache`

---

### A workspace target seems ambiguous

Enable:

```json
"rustSmartRunner.addPackageArgInWorkspaceRoot": true
```

This makes commands more explicit in workspace-root scenarios.

---

## Known limitations

- Only `bin` and `example` targets are supported as runnable targets.
- Library-only files are not runnable.
- Debugging behavior depends on the installed LLDB extension.
- In unusual Cargo workspace layouts, diagnostics may still be needed to understand manifest selection.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## License

MIT
