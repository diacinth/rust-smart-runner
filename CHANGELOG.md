# Changelog

All notable changes to this project will be documented in this file.

## [0.2.3] - v1.9

### Added
- Added `Explain Manifest Resolution` command
- Added manifest resolution trace output
- Added target/package conflict diagnostics
- Added richer reveal output with manifest selection reason
- Added diagnostics for candidate count before and after deduplication

## [0.2.2] - v1.8

### Added
- Added automatic `-p <package>` support when using workspace root manifests
- Added `rustSmartRunner.addPackageArgInWorkspaceRoot` setting
- Added package-aware debug cargo filter support

### Changed
- Run and debug cargo arguments now use the selected manifest path consistently

## [0.2.1] - v1.7

### Added
- Added Cargo workspace member-aware manifest resolution
- Added `rustSmartRunner.manifestSelectionStrategy` setting
- Added strategies: `auto`, `nearest`, `workspaceRoot`
- Added smarter manifest evaluation using Cargo metadata

### Changed
- Improved manifest selection in Cargo workspace scenarios

## [0.2.0] - v1.6

### Added
- Added multi-root workspace and monorepo improvements
- Added workspace-aware manifest lookup bounded by workspace folder
- Added richer workspace context reporting in resolved target output
- Added workspace folder change listener for cache invalidation

## [0.1.9] - v1.5

### Added
- Added `Refresh Metadata Cache` command
- Added `Reveal Resolved Target` command
- Added `rustSmartRunner.debugLogging` setting

### Changed
- Improved cache refresh and debugging diagnostics

## [0.1.0] - Initial release

### Added
- Run Rust command
- Debug Rust command
- Copy Cargo Command command
- Runnable target detection for Cargo `bin` and `example` targets
- Status bar buttons for runnable Rust targets
- Output channel logging
- Cargo metadata caching
- Cargo validation caching
