import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

type TargetKind = 'bin' | 'example';
type ManifestSelectionStrategy = 'auto' | 'nearest' | 'workspaceRoot';

interface RunnerConfig {
    cargoPath: string;
    cargoCommandArgs: string[];
    cargoSubcommandArgs: string[];
    legacyCargoExtraArgs: string[];
    runArgs: string[];
    env: Record<string, string>;
    autoSaveBeforeRun: boolean;
    requireMainRsOnly: boolean;
    revealOutputOnError: boolean;
    showStatusBarButtons: boolean;
    metadataCacheTtlMs: number;
    cargoValidationCacheTtlMs: number;
    uiRefreshDebounceMs: number;
    debugLogging: boolean;
    manifestSelectionStrategy: ManifestSelectionStrategy;
    addPackageArgInWorkspaceRoot: boolean;
}

interface CargoTarget {
    name: string;
    kind: string[];
    src_path: string;
}

interface CargoPackage {
    id?: string;
    name: string;
    manifest_path: string;
    targets: CargoTarget[];
}

interface CargoWorkspaceMetadata {
    packages: CargoPackage[];
    workspace_members?: string[];
    workspace_root?: string;
}

interface ResolvedTarget {
    packageName: string;
    manifestPath: string;
    manifestDir: string;
    targetName: string;
    kind: TargetKind;
    srcPath: string;
}

interface WorkspaceContextInfo {
    workspaceFolder?: vscode.WorkspaceFolder;
    workspaceFolderName?: string;
    workspaceFolderPath?: string;
    relativeFilePath?: string;
    manifestRelativePath?: string;
    isExternalFile: boolean;
}

interface CandidateManifestInfo {
    manifestPath: string;
    source: 'nearest' | 'workspaceRoot';
}

interface ManifestEvaluationTrace {
    manifestPath: string;
    source: 'nearest' | 'workspaceRoot';
    matches: boolean;
    matchedPackageManifest?: string;
    matchedPackageName?: string;
    candidateCount: number;
    uniqueCandidateCount: number;
    candidateDescriptions: string[];
    workspaceRoot?: string;
    workspaceMembers: string[];
    error?: string;
}

interface ResolutionTrace {
    strategy: ManifestSelectionStrategy;
    nearestManifest?: string;
    workspaceRootManifest?: string;
    candidateManifests: CandidateManifestInfo[];
    evaluations: ManifestEvaluationTrace[];
    selectedManifest?: string;
    selectedManifestSource?: 'nearest' | 'workspaceRoot';
    selectedManifestIsWorkspaceRoot: boolean;
    reason: string;
}

interface TargetConflictDiagnostics {
    targetName: string;
    targetKind: TargetKind;
    packageName: string;
    selectedManifest: string;
    selectedManifestIsWorkspaceRoot: boolean;
    sameNameInOtherPackages: string[];
    sameNameInSamePackageOtherKinds: string[];
    candidateCountBeforeDedupe: number;
    candidateCountAfterDedupe: number;
}

interface ExecutionContextData {
    config: RunnerConfig;
    filePath: string;
    cargoPath: string;
    resolvedTarget: ResolvedTarget;
    source: 'editor' | 'explorer' | 'unknown';
    workspace: WorkspaceContextInfo;
    selectedManifest: string;
    selectedManifestSource: 'nearest' | 'workspaceRoot';
    candidateManifests: CandidateManifestInfo[];
    selectedManifestIsWorkspaceRoot: boolean;
    resolutionTrace: ResolutionTrace;
    conflictDiagnostics: TargetConflictDiagnostics;
}

interface MetadataCacheEntry {
    timestamp: number;
    metadata: CargoWorkspaceMetadata;
}

interface CargoValidationCacheEntry {
    timestamp: number;
    ok: boolean;
}

let outputChannel: vscode.OutputChannel;
let statusRunButton: vscode.StatusBarItem;
let statusDebugButton: vscode.StatusBarItem;
let statusCopyButton: vscode.StatusBarItem;

const metadataCache = new Map<string, MetadataCacheEntry>();
const cargoValidationCache = new Map<string, CargoValidationCacheEntry>();

let uiRefreshSequence = 0;
let uiRefreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Rust Smart Runner');

    statusRunButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    statusRunButton.command = 'rustSmartRunner.runRust';
    statusRunButton.text = '$(play) Rust Run';
    statusRunButton.tooltip = 'Run current Rust target';

    statusDebugButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999);
    statusDebugButton.command = 'rustSmartRunner.debugRust';
    statusDebugButton.text = '$(debug-alt) Rust Debug';
    statusDebugButton.tooltip = 'Debug current Rust target';

    statusCopyButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 998);
    statusCopyButton.command = 'rustSmartRunner.copyCargoCommand';
    statusCopyButton.text = '$(copy) Cargo Cmd';
    statusCopyButton.tooltip = 'Copy current Cargo command';

    logHeader('Extension Activated');
    log('Rust Smart Runner is active.');

    const runCmd = vscode.commands.registerCommand('rustSmartRunner.runRust', async (uri?: vscode.Uri) => {
        await executeRun(uri);
    });

    const debugCmd = vscode.commands.registerCommand('rustSmartRunner.debugRust', async (uri?: vscode.Uri) => {
        await executeDebug(uri);
    });

    const copyCmd = vscode.commands.registerCommand('rustSmartRunner.copyCargoCommand', async (uri?: vscode.Uri) => {
        await executeCopyCargoCommand(uri);
    });

    const refreshCacheCmd = vscode.commands.registerCommand('rustSmartRunner.refreshMetadataCache', async () => {
        await executeRefreshMetadataCache();
    });

    const revealTargetCmd = vscode.commands.registerCommand('rustSmartRunner.revealResolvedTarget', async (uri?: vscode.Uri) => {
        await executeRevealResolvedTarget(uri);
    });

    const explainManifestCmd = vscode.commands.registerCommand('rustSmartRunner.explainManifestResolution', async (uri?: vscode.Uri) => {
        await executeExplainManifestResolution(uri);
    });

    const runMenuCmd = vscode.commands.registerCommand('rustSmartRunner.runRustMenu', async (uri?: vscode.Uri) => {
        await vscode.commands.executeCommand('rustSmartRunner.runRust', uri);
    });

    const debugMenuCmd = vscode.commands.registerCommand('rustSmartRunner.debugRustMenu', async (uri?: vscode.Uri) => {
        await vscode.commands.executeCommand('rustSmartRunner.debugRust', uri);
    });

    const copyMenuCmd = vscode.commands.registerCommand('rustSmartRunner.copyCargoCommandMenu', async (uri?: vscode.Uri) => {
        await vscode.commands.executeCommand('rustSmartRunner.copyCargoCommand', uri);
    });

    const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
        scheduleUiRefresh();
    });

    const openDocListener = vscode.workspace.onDidOpenTextDocument(() => {
        scheduleUiRefresh();
    });

    const closeDocListener = vscode.workspace.onDidCloseTextDocument(() => {
        scheduleUiRefresh();
    });

    const saveDocListener = vscode.workspace.onDidSaveTextDocument((document) => {
        invalidateMetadataCacheForFile(document.uri.fsPath);
        scheduleUiRefresh();
    });

    const createFileListener = vscode.workspace.onDidCreateFiles((event) => {
        for (const file of event.files) {
            invalidateMetadataCacheForFile(file.fsPath);
        }
        scheduleUiRefresh();
    });

    const deleteFileListener = vscode.workspace.onDidDeleteFiles((event) => {
        for (const file of event.files) {
            invalidateMetadataCacheForFile(file.fsPath);
        }
        scheduleUiRefresh();
    });

    const renameFileListener = vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
            invalidateMetadataCacheForFile(file.oldUri.fsPath);
            invalidateMetadataCacheForFile(file.newUri.fsPath);
        }
        scheduleUiRefresh();
    });

    const workspaceFolderListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        metadataCache.clear();
        cargoValidationCache.clear();
        scheduleUiRefresh();
    });

    const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('rustSmartRunner')) {
            metadataCache.clear();
            cargoValidationCache.clear();
            scheduleUiRefresh();
        }
    });

    context.subscriptions.push(
        outputChannel,
        statusRunButton,
        statusDebugButton,
        statusCopyButton,
        runCmd,
        debugCmd,
        copyCmd,
        refreshCacheCmd,
        revealTargetCmd,
        explainManifestCmd,
        runMenuCmd,
        debugMenuCmd,
        copyMenuCmd,
        activeEditorListener,
        openDocListener,
        closeDocListener,
        saveDocListener,
        createFileListener,
        deleteFileListener,
        renameFileListener,
        workspaceFolderListener,
        configListener,
        new vscode.Disposable(() => {
            if (uiRefreshTimer) {
                clearTimeout(uiRefreshTimer);
                uiRefreshTimer = undefined;
            }
        })
    );

    scheduleUiRefresh(0);

    setTimeout(() => {
        scheduleUiRefresh(200);
    }, 200);
}

export function deactivate() {}

async function executeRun(uri?: vscode.Uri): Promise<void> {
    try {
        const ctx = await prepareExecutionContext(uri);
        if (!ctx) {
            return;
        }

        const {
            config,
            filePath,
            cargoPath,
            resolvedTarget,
            source,
            workspace,
            selectedManifestSource,
            selectedManifest,
            selectedManifestIsWorkspaceRoot
        } = ctx;

        logHeader('Run Rust');
        log(`Source: ${source}`);
        log(`Active target file: ${filePath}`);
        log(`Cargo path: ${cargoPath}`);
        log(`Manifest: ${resolvedTarget.manifestPath}`);
        log(`Selected manifest source: ${selectedManifestSource}`);
        log(`Selected manifest path: ${selectedManifest}`);
        log(`Selected manifest is workspace root: ${selectedManifestIsWorkspaceRoot}`);
        log(`Target: ${resolvedTarget.kind}:${resolvedTarget.targetName}`);
        log(`Target src: ${resolvedTarget.srcPath}`);
        debugLog(`Workspace: ${workspace.workspaceFolderName ?? '(external file)'}`);
        debugLog(`Env keys: ${Object.keys(config.env).join(', ') || '(none)'}`);

        const cargoArgs = buildRunCargoArgs(config, ctx);
        const fullCommand = quoteCommand(cargoPath, cargoArgs);

        log(`Run command: ${fullCommand}`);

        const terminal = vscode.window.createTerminal({
            name: `Rust Run: ${resolvedTarget.targetName}`,
            cwd: resolvedTarget.manifestDir,
            env: config.env
        });

        terminal.show(true);
        terminal.sendText(fullCommand, true);
        vscode.window.setStatusBarMessage(`Running Rust target: ${resolvedTarget.targetName}`, 3000);
    } catch (err) {
        await handleError('Failed to start Rust run command.', err);
    }
}

async function executeDebug(uri?: vscode.Uri): Promise<void> {
    try {
        const ctx = await prepareExecutionContext(uri);
        if (!ctx) {
            return;
        }

        const {
            config,
            filePath,
            resolvedTarget,
            source,
            workspace,
            selectedManifestSource,
            selectedManifest,
            selectedManifestIsWorkspaceRoot
        } = ctx;

        logHeader('Debug Rust');
        log(`Source: ${source}`);
        log(`Active target file: ${filePath}`);
        log(`Manifest: ${resolvedTarget.manifestPath}`);
        log(`Selected manifest source: ${selectedManifestSource}`);
        log(`Selected manifest path: ${selectedManifest}`);
        log(`Selected manifest is workspace root: ${selectedManifestIsWorkspaceRoot}`);
        log(`Target: ${resolvedTarget.kind}:${resolvedTarget.targetName}`);
        log(`Target src: ${resolvedTarget.srcPath}`);
        debugLog(`Workspace: ${workspace.workspaceFolderName ?? '(external file)'}`);
        debugLog(`Env keys: ${Object.keys(config.env).join(', ') || '(none)'}`);

        const codelldbInstalled = Boolean(
            vscode.extensions.getExtension('vadimcn.vscode-lldb') ||
            vscode.extensions.getExtension('llvm-vs-code-extensions.lldb-dap')
        );

        if (!codelldbInstalled) {
            vscode.window.showErrorMessage('Debug Rust requires the CodeLLDB extension. Please install it first.');
            return;
        }

        const cargoBuildArgs = buildDebugCargoBuildArgs(config, ctx);
        const debugConfiguration: vscode.DebugConfiguration = {
            type: 'lldb',
            request: 'launch',
            name: `Debug Rust: ${resolvedTarget.targetName}`,
            cwd: resolvedTarget.manifestDir,
            args: config.runArgs,
            env: config.env,
            cargo: {
                args: cargoBuildArgs,
                filter: buildDebugCargoFilter(ctx)
            }
        };

        log(`Debug cargo args: ${JSON.stringify(cargoBuildArgs)}`);
        debugLog(`Debug configuration: ${JSON.stringify(safeDebugConfigForLog(debugConfiguration))}`);

        const started = await vscode.debug.startDebugging(undefined, debugConfiguration);
        if (!started) {
            vscode.window.showErrorMessage('Failed to start Rust debug command.');
            return;
        }

        vscode.window.setStatusBarMessage(`Debugging Rust target: ${resolvedTarget.targetName}`, 3000);
    } catch (err) {
        await handleError('Failed to start Rust debug command.', err);
    }
}

async function executeCopyCargoCommand(uri?: vscode.Uri): Promise<void> {
    try {
        const ctx = await prepareExecutionContext(uri);
        if (!ctx) {
            return;
        }

        const { config, cargoPath } = ctx;
        const cargoArgs = buildRunCargoArgs(config, ctx);
        const fullCommand = quoteCommand(cargoPath, cargoArgs);

        await vscode.env.clipboard.writeText(fullCommand);

        logHeader('Copy Cargo Command');
        log(`Copied command: ${fullCommand}`);

        vscode.window.showInformationMessage(`Cargo command copied: ${fullCommand}`);
        vscode.window.setStatusBarMessage('Cargo command copied to clipboard', 2500);
    } catch (err) {
        await handleError('Failed to copy Cargo command.', err);
    }
}

async function executeRefreshMetadataCache(): Promise<void> {
    metadataCache.clear();
    cargoValidationCache.clear();

    logHeader('Refresh Metadata Cache');
    log('Cleared cargo metadata cache.');
    log('Cleared cargo validation cache.');

    await refreshUiContext();

    vscode.window.showInformationMessage('Rust Smart Runner cache refreshed.');
}

async function executeRevealResolvedTarget(uri?: vscode.Uri): Promise<void> {
    try {
        const ctx = await prepareExecutionContext(uri);
        if (!ctx) {
            return;
        }

        const {
            config,
            filePath,
            cargoPath,
            resolvedTarget,
            source,
            workspace,
            selectedManifest,
            selectedManifestSource,
            candidateManifests,
            selectedManifestIsWorkspaceRoot,
            resolutionTrace,
            conflictDiagnostics
        } = ctx;

        const runArgs = buildRunCargoArgs(config, ctx);
        const debugCargoArgs = buildDebugCargoBuildArgs(config, ctx);
        const fullRunCommand = quoteCommand(cargoPath, runArgs);

        const lines = [
            `Source: ${source}`,
            `File: ${filePath}`,
            `Workspace Folder: ${workspace.workspaceFolderName ?? '(external file)'}`,
            `Workspace Folder Path: ${workspace.workspaceFolderPath ?? '(none)'}`,
            `File Relative Path: ${workspace.relativeFilePath ?? '(none)'}`,
            `Manifest Selection Strategy: ${config.manifestSelectionStrategy}`,
            `Selected Manifest Source: ${selectedManifestSource}`,
            `Selected Manifest: ${selectedManifest}`,
            `Selected Manifest Is Workspace Root: ${selectedManifestIsWorkspaceRoot}`,
            `Manifest Selection Reason: ${resolutionTrace.reason}`,
            `Candidate Manifests: ${candidateManifests.map(x => `${x.source}:${x.manifestPath}`).join(' | ') || '(none)'}`,
            `Manifest: ${resolvedTarget.manifestPath}`,
            `Manifest Relative Path: ${workspace.manifestRelativePath ?? '(none)'}`,
            `Manifest Dir: ${resolvedTarget.manifestDir}`,
            `Package: ${resolvedTarget.packageName}`,
            `Target Kind: ${resolvedTarget.kind}`,
            `Target Name: ${resolvedTarget.targetName}`,
            `Target Source: ${resolvedTarget.srcPath}`,
            `Cargo Path: ${cargoPath}`,
            `Will Add -p Package Arg: ${shouldAddPackageArg(ctx)}`,
            `Run Command: ${fullRunCommand}`,
            `Debug Cargo Args: ${JSON.stringify(debugCargoArgs)}`,
            `Run Args: ${JSON.stringify(config.runArgs)}`,
            `Conflict: Same target name in other packages: ${conflictDiagnostics.sameNameInOtherPackages.join(', ') || '(none)'}`,
            `Conflict: Same target name in same package other kinds: ${conflictDiagnostics.sameNameInSamePackageOtherKinds.join(', ') || '(none)'}`,
            `Candidates Before Dedupe: ${conflictDiagnostics.candidateCountBeforeDedupe}`,
            `Candidates After Dedupe: ${conflictDiagnostics.candidateCountAfterDedupe}`
        ];

        logHeader('Reveal Resolved Target');
        for (const line of lines) {
            log(line);
        }

        outputChannel.show(true);

        const picked = await vscode.window.showQuickPick(
            [
                { label: 'Copy full run command', action: 'copyRunCommand' },
                { label: 'Copy target info as text', action: 'copyTargetInfo' },
                { label: 'Open output channel', action: 'openOutput' }
            ],
            {
                placeHolder: 'Resolved target information written to the output channel.'
            }
        );

        if (!picked) {
            return;
        }

        if (picked.action === 'copyRunCommand') {
            await vscode.env.clipboard.writeText(fullRunCommand);
            vscode.window.showInformationMessage('Full run command copied.');
            return;
        }

        if (picked.action === 'copyTargetInfo') {
            await vscode.env.clipboard.writeText(lines.join('\n'));
            vscode.window.showInformationMessage('Resolved target info copied.');
            return;
        }

        outputChannel.show(true);
    } catch (err) {
        await handleError('Failed to reveal resolved target.', err);
    }
}

async function executeExplainManifestResolution(uri?: vscode.Uri): Promise<void> {
    try {
        const targetInfo = await resolveTargetFile(uri);
        if (!targetInfo) {
            return;
        }

        const { filePath, source } = targetInfo;
        const config = getConfig();
        const workspace = getWorkspaceContext(filePath);

        if (!filePath.endsWith('.rs')) {
            vscode.window.showErrorMessage('Current file is not a Rust source file.');
            return;
        }

        const cargoPath = await resolveCargoPath(config.cargoPath);
        if (!cargoPath) {
            vscode.window.showErrorMessage('Cargo executable was not found. Please install Rust/Cargo or configure rustSmartRunner.cargoPath.');
            return;
        }

        const cargoOk = await validateCargoCached(cargoPath, config.cargoValidationCacheTtlMs);
        if (!cargoOk) {
            vscode.window.showErrorMessage('Cargo executable was not found or is invalid. Please check rustSmartRunner.cargoPath or your system PATH.');
            return;
        }

        const manifestResolution = await selectManifestForFile(filePath, cargoPath, config);
        if (!manifestResolution) {
            vscode.window.showErrorMessage('No suitable Cargo.toml manifest was found for the current file.');
            return;
        }

        const trace = manifestResolution.resolutionTrace;

        const lines: string[] = [
            `Source: ${source}`,
            `File: ${filePath}`,
            `Workspace Folder: ${workspace.workspaceFolderName ?? '(external file)'}`,
            `Workspace Folder Path: ${workspace.workspaceFolderPath ?? '(none)'}`,
            `File Relative Path: ${workspace.relativeFilePath ?? '(none)'}`,
            `Manifest Selection Strategy: ${trace.strategy}`,
            `Nearest Manifest: ${trace.nearestManifest ?? '(none)'}`,
            `Workspace Root Manifest: ${trace.workspaceRootManifest ?? '(none)'}`,
            `Candidate Manifests: ${trace.candidateManifests.map(x => `${x.source}:${x.manifestPath}`).join(' | ') || '(none)'}`,
            `Selected Manifest: ${trace.selectedManifest ?? '(none)'}`,
            `Selected Manifest Source: ${trace.selectedManifestSource ?? '(none)'}`,
            `Selected Manifest Is Workspace Root: ${trace.selectedManifestIsWorkspaceRoot}`,
            `Selection Reason: ${trace.reason}`,
            ''
        ];

        for (const evaluation of trace.evaluations) {
            lines.push(`Evaluation: ${evaluation.source}:${evaluation.manifestPath}`);
            lines.push(`  Matches Current File: ${evaluation.matches}`);
            lines.push(`  Matched Package Manifest: ${evaluation.matchedPackageManifest ?? '(none)'}`);
            lines.push(`  Matched Package Name: ${evaluation.matchedPackageName ?? '(none)'}`);
            lines.push(`  Candidate Count: ${evaluation.candidateCount}`);
            lines.push(`  Unique Candidate Count: ${evaluation.uniqueCandidateCount}`);
            lines.push(`  Candidate Descriptions: ${evaluation.candidateDescriptions.join(' | ') || '(none)'}`);
            lines.push(`  Workspace Root: ${evaluation.workspaceRoot ?? '(none)'}`);
            lines.push(`  Workspace Members: ${evaluation.workspaceMembers.join(' | ') || '(none)'}`);
            lines.push(`  Error: ${evaluation.error ?? '(none)'}`);
            lines.push('');
        }

        logHeader('Explain Manifest Resolution');
        for (const line of lines) {
            log(line);
        }

        outputChannel.show(true);

        const picked = await vscode.window.showQuickPick(
            [
                { label: 'Copy explanation as text', action: 'copyExplanation' },
                { label: 'Open output channel', action: 'openOutput' }
            ],
            {
                placeHolder: 'Manifest resolution explanation written to the output channel.'
            }
        );

        if (!picked) {
            return;
        }

        if (picked.action === 'copyExplanation') {
            await vscode.env.clipboard.writeText(lines.join('\n'));
            vscode.window.showInformationMessage('Manifest resolution explanation copied.');
            return;
        }

        outputChannel.show(true);
    } catch (err) {
        await handleError('Failed to explain manifest resolution.', err);
    }
}

async function prepareExecutionContext(uri?: vscode.Uri): Promise<ExecutionContextData | undefined> {
    const targetInfo = await resolveTargetFile(uri);
    if (!targetInfo) {
        return undefined;
    }

    const { filePath, source } = targetInfo;
    const config = getConfig();
    const workspace = getWorkspaceContext(filePath);

    logHeader('Prepare Execution');
    debugLog(`Command source: ${source}`);
    debugLog(`Requested file: ${filePath}`);
    debugLog(`Workspace folder: ${workspace.workspaceFolderName ?? '(external file)'}`);

    if (!filePath.endsWith('.rs')) {
        vscode.window.showErrorMessage('Current file is not a Rust source file.');
        return undefined;
    }

    if (config.requireMainRsOnly && path.basename(filePath) !== 'main.rs') {
        vscode.window.showErrorMessage('This command is restricted to main.rs by rustSmartRunner.requireMainRsOnly.');
        return undefined;
    }

    if (!fs.existsSync(filePath)) {
        vscode.window.showErrorMessage('The selected Rust file does not exist on disk.');
        return undefined;
    }

    const activeDoc = vscode.window.activeTextEditor?.document;
    if (activeDoc && normalizeFsPath(activeDoc.uri.fsPath) === normalizeFsPath(filePath)) {
        if (activeDoc.isUntitled) {
            vscode.window.showErrorMessage('Please save the current file before running Rust target.');
            return undefined;
        }

        if (config.autoSaveBeforeRun && activeDoc.isDirty) {
            debugLog('Auto-saving active document before execution.');
            await activeDoc.save();
        }
    }

    const cargoPath = await resolveCargoPath(config.cargoPath);
    if (!cargoPath) {
        vscode.window.showErrorMessage('Cargo executable was not found. Please install Rust/Cargo or configure rustSmartRunner.cargoPath.');
        return undefined;
    }

    debugLog(`Resolved cargo path candidate: ${cargoPath}`);

    const cargoOk = await validateCargoCached(cargoPath, config.cargoValidationCacheTtlMs);
    if (!cargoOk) {
        vscode.window.showErrorMessage('Cargo executable was not found or is invalid. Please check rustSmartRunner.cargoPath or your system PATH.');
        return undefined;
    }

    const manifestResolution = await selectManifestForFile(filePath, cargoPath, config);
    if (!manifestResolution) {
        vscode.window.showErrorMessage('No suitable Cargo.toml manifest was found for the current file.');
        return undefined;
    }

    const {
        selectedManifest,
        selectedManifestSource,
        candidateManifests,
        selectedManifestIsWorkspaceRoot,
        resolutionTrace
    } = manifestResolution;

    debugLog(`Selected manifest (${selectedManifestSource}): ${selectedManifest}`);

    const metadata = await getCargoMetadataCached(cargoPath, selectedManifest, config.metadataCacheTtlMs);
    const resolvedTargetResult = await resolveTargetFromMetadataWithDiagnostics(metadata, selectedManifest, filePath, true);

    if (!resolvedTargetResult.resolvedTarget) {
        vscode.window.showErrorMessage('The current file does not match any runnable Cargo target in the selected manifest.');
        return undefined;
    }

    const resolvedTarget = resolvedTargetResult.resolvedTarget;

    workspace.manifestRelativePath = workspace.workspaceFolderPath
        ? toRelativeOrSelf(workspace.workspaceFolderPath, resolvedTarget.manifestPath)
        : undefined;

    const conflictDiagnostics = buildConflictDiagnostics(
        metadata,
        resolvedTarget,
        selectedManifest,
        selectedManifestIsWorkspaceRoot,
        resolvedTargetResult.candidateCountBeforeDedupe,
        resolvedTargetResult.candidateCountAfterDedupe
    );

    debugLog(`Resolved target: ${resolvedTarget.kind}:${resolvedTarget.targetName}`);
    debugLog(`Resolved package: ${resolvedTarget.packageName}`);
    debugLog(`Resolved target manifest: ${resolvedTarget.manifestPath}`);
    debugLog(`Will add package arg: ${shouldAddPackageArg({
        config,
        filePath,
        cargoPath,
        resolvedTarget,
        source,
        workspace,
        selectedManifest,
        selectedManifestSource,
        candidateManifests,
        selectedManifestIsWorkspaceRoot,
        resolutionTrace,
        conflictDiagnostics
    })}`);

    return {
        config,
        filePath,
        cargoPath,
        resolvedTarget,
        source,
        workspace,
        selectedManifest,
        selectedManifestSource,
        candidateManifests,
        selectedManifestIsWorkspaceRoot,
        resolutionTrace,
        conflictDiagnostics
    };
}

async function selectManifestForFile(
    filePath: string,
    cargoPath: string,
    config: RunnerConfig
): Promise<{
    selectedManifest: string;
    selectedManifestSource: 'nearest' | 'workspaceRoot';
    candidateManifests: CandidateManifestInfo[];
    selectedManifestIsWorkspaceRoot: boolean;
    resolutionTrace: ResolutionTrace;
} | undefined> {
    const nearestManifest = findNearestCargoTomlBounded(filePath);
    const workspaceRootManifest = findWorkspaceRootCargoToml(filePath);

    const candidateManifests = dedupeCandidateManifests([
        nearestManifest
            ? { manifestPath: nearestManifest, source: 'nearest' as const }
            : undefined,
        workspaceRootManifest
            ? { manifestPath: workspaceRootManifest, source: 'workspaceRoot' as const }
            : undefined
    ]);

    const trace: ResolutionTrace = {
        strategy: config.manifestSelectionStrategy,
        nearestManifest,
        workspaceRootManifest,
        candidateManifests,
        evaluations: [],
        selectedManifestIsWorkspaceRoot: false,
        reason: ''
    };

    debugLog(`Manifest strategy: ${config.manifestSelectionStrategy}`);
    debugLog(`Manifest candidates: ${candidateManifests.map(x => `${x.source}:${x.manifestPath}`).join(' | ') || '(none)'}`);

    if (candidateManifests.length === 0) {
        trace.reason = 'No candidate manifests were found.';
        return undefined;
    }

    if (config.manifestSelectionStrategy === 'nearest') {
        const nearest = candidateManifests.find(x => x.source === 'nearest') ?? candidateManifests[0];
        trace.selectedManifest = nearest.manifestPath;
        trace.selectedManifestSource = nearest.source;
        trace.selectedManifestIsWorkspaceRoot = nearest.source === 'workspaceRoot';
        trace.reason = 'Strategy is nearest, so the nearest available manifest was selected.';
        return {
            selectedManifest: nearest.manifestPath,
            selectedManifestSource: nearest.source,
            candidateManifests,
            selectedManifestIsWorkspaceRoot: nearest.source === 'workspaceRoot',
            resolutionTrace: trace
        };
    }

    if (config.manifestSelectionStrategy === 'workspaceRoot') {
        const root = candidateManifests.find(x => x.source === 'workspaceRoot')
            ?? candidateManifests.find(x => x.source === 'nearest');

        if (!root) {
            trace.reason = 'Strategy is workspaceRoot, but no usable candidate manifest was found.';
            return undefined;
        }

        trace.selectedManifest = root.manifestPath;
        trace.selectedManifestSource = root.source;
        trace.selectedManifestIsWorkspaceRoot = root.source === 'workspaceRoot';
        trace.reason = root.source === 'workspaceRoot'
            ? 'Strategy is workspaceRoot, so the workspace root manifest was selected.'
            : 'Strategy is workspaceRoot, but no workspace root manifest existed, so nearest manifest was used as fallback.';

        return {
            selectedManifest: root.manifestPath,
            selectedManifestSource: root.source,
            candidateManifests,
            selectedManifestIsWorkspaceRoot: root.source === 'workspaceRoot',
            resolutionTrace: trace
        };
    }

    return await selectManifestAuto(filePath, cargoPath, config, candidateManifests, trace);
}

async function selectManifestAuto(
    filePath: string,
    cargoPath: string,
    config: RunnerConfig,
    candidateManifests: CandidateManifestInfo[],
    trace: ResolutionTrace
): Promise<{
    selectedManifest: string;
    selectedManifestSource: 'nearest' | 'workspaceRoot';
    candidateManifests: CandidateManifestInfo[];
    selectedManifestIsWorkspaceRoot: boolean;
    resolutionTrace: ResolutionTrace;
} | undefined> {
    if (candidateManifests.length === 1) {
        trace.selectedManifest = candidateManifests[0].manifestPath;
        trace.selectedManifestSource = candidateManifests[0].source;
        trace.selectedManifestIsWorkspaceRoot = candidateManifests[0].source === 'workspaceRoot';
        trace.reason = 'Only one candidate manifest was available.';
        return {
            selectedManifest: candidateManifests[0].manifestPath,
            selectedManifestSource: candidateManifests[0].source,
            candidateManifests,
            selectedManifestIsWorkspaceRoot: candidateManifests[0].source === 'workspaceRoot',
            resolutionTrace: trace
        };
    }

    const evaluations: Array<CandidateManifestInfo & { matches: boolean; matchedPackageManifest?: string; matchedPackageName?: string }> = [];

    for (const candidate of candidateManifests) {
        try {
            const metadata = await getCargoMetadataCached(cargoPath, candidate.manifestPath, config.metadataCacheTtlMs);
            const diag = await resolveTargetFromMetadataWithDiagnostics(metadata, candidate.manifestPath, filePath, false);

            evaluations.push({
                ...candidate,
                matches: Boolean(diag.resolvedTarget),
                matchedPackageManifest: diag.resolvedTarget?.manifestPath,
                matchedPackageName: diag.resolvedTarget?.packageName
            });

            trace.evaluations.push({
                manifestPath: candidate.manifestPath,
                source: candidate.source,
                matches: Boolean(diag.resolvedTarget),
                matchedPackageManifest: diag.resolvedTarget?.manifestPath,
                matchedPackageName: diag.resolvedTarget?.packageName,
                candidateCount: diag.candidateCountBeforeDedupe,
                uniqueCandidateCount: diag.candidateCountAfterDedupe,
                candidateDescriptions: diag.candidateDescriptions,
                workspaceRoot: metadata.workspace_root,
                workspaceMembers: metadata.workspace_members ?? []
            });
        } catch (err) {
            const error = errorToString(err);
            debugLog(`Auto manifest evaluation failed for ${candidate.manifestPath}: ${error}`);

            evaluations.push({
                ...candidate,
                matches: false
            });

            trace.evaluations.push({
                manifestPath: candidate.manifestPath,
                source: candidate.source,
                matches: false,
                candidateCount: 0,
                uniqueCandidateCount: 0,
                candidateDescriptions: [],
                workspaceRoot: undefined,
                workspaceMembers: [],
                error
            });
        }
    }

    debugLog(`Manifest auto evaluations: ${evaluations.map(x => `${x.source}:${x.matches}:${x.matchedPackageManifest ?? '-'}`).join(' | ')}`);

    const matching = evaluations.filter(x => x.matches);

    if (matching.length === 0) {
        const nearest = candidateManifests.find(x => x.source === 'nearest') ?? candidateManifests[0];
        trace.selectedManifest = nearest.manifestPath;
        trace.selectedManifestSource = nearest.source;
        trace.selectedManifestIsWorkspaceRoot = nearest.source === 'workspaceRoot';
        trace.reason = 'No candidate manifest matched the current file, so the nearest manifest was selected as fallback.';
        return {
            selectedManifest: nearest.manifestPath,
            selectedManifestSource: nearest.source,
            candidateManifests,
            selectedManifestIsWorkspaceRoot: nearest.source === 'workspaceRoot',
            resolutionTrace: trace
        };
    }

    if (matching.length === 1) {
        trace.selectedManifest = matching[0].manifestPath;
        trace.selectedManifestSource = matching[0].source;
        trace.selectedManifestIsWorkspaceRoot = matching[0].source === 'workspaceRoot';
        trace.reason = 'Exactly one candidate manifest matched the current file.';
        return {
            selectedManifest: matching[0].manifestPath,
            selectedManifestSource: matching[0].source,
            candidateManifests,
            selectedManifestIsWorkspaceRoot: matching[0].source === 'workspaceRoot',
            resolutionTrace: trace
        };
    }

    const exactNearest = matching.find(x =>
        x.source === 'nearest' && normalizeFsPath(x.manifestPath) === normalizeFsPath(x.matchedPackageManifest ?? '')
    );

    if (exactNearest) {
        trace.selectedManifest = exactNearest.manifestPath;
        trace.selectedManifestSource = exactNearest.source;
        trace.selectedManifestIsWorkspaceRoot = exactNearest.source === 'workspaceRoot';
        trace.reason = 'Multiple manifests matched, and the nearest manifest exactly matched the resolved package manifest, so it was preferred.';
        return {
            selectedManifest: exactNearest.manifestPath,
            selectedManifestSource: exactNearest.source,
            candidateManifests,
            selectedManifestIsWorkspaceRoot: exactNearest.source === 'workspaceRoot',
            resolutionTrace: trace
        };
    }

    const workspaceRoot = matching.find(x => x.source === 'workspaceRoot');
    if (workspaceRoot) {
        trace.selectedManifest = workspaceRoot.manifestPath;
        trace.selectedManifestSource = workspaceRoot.source;
        trace.selectedManifestIsWorkspaceRoot = true;
        trace.reason = 'Multiple manifests matched, no exact nearest package-manifest match was found, so workspace root manifest was preferred.';
        return {
            selectedManifest: workspaceRoot.manifestPath,
            selectedManifestSource: workspaceRoot.source,
            candidateManifests,
            selectedManifestIsWorkspaceRoot: true,
            resolutionTrace: trace
        };
    }

    trace.selectedManifest = matching[0].manifestPath;
    trace.selectedManifestSource = matching[0].source;
    trace.selectedManifestIsWorkspaceRoot = matching[0].source === 'workspaceRoot';
    trace.reason = 'Multiple manifests matched, and the first matching candidate was selected as fallback.';
    return {
        selectedManifest: matching[0].manifestPath,
        selectedManifestSource: matching[0].source,
        candidateManifests,
        selectedManifestIsWorkspaceRoot: matching[0].source === 'workspaceRoot',
        resolutionTrace: trace
    };
}

function shouldAddPackageArg(ctx: ExecutionContextData): boolean {
    if (!ctx.config.addPackageArgInWorkspaceRoot) {
        return false;
    }

    if (!ctx.selectedManifestIsWorkspaceRoot) {
        return false;
    }

    if (!ctx.resolvedTarget.packageName || ctx.resolvedTarget.packageName.trim() === '') {
        return false;
    }

    return true;
}

function buildDebugCargoFilter(ctx: ExecutionContextData): Record<string, unknown> {
    const filter: Record<string, unknown> = {
        name: ctx.resolvedTarget.targetName,
        kind: ctx.resolvedTarget.kind
    };

    if (shouldAddPackageArg(ctx)) {
        filter.package = ctx.resolvedTarget.packageName;
    }

    return filter;
}

function buildConflictDiagnostics(
    metadata: CargoWorkspaceMetadata,
    resolvedTarget: ResolvedTarget,
    selectedManifest: string,
    selectedManifestIsWorkspaceRoot: boolean,
    candidateCountBeforeDedupe: number,
    candidateCountAfterDedupe: number
): TargetConflictDiagnostics {
    const sameNameInOtherPackages = new Set<string>();
    const sameNameInSamePackageOtherKinds = new Set<string>();

    for (const pkg of metadata.packages) {
        for (const target of pkg.targets) {
            if (target.name !== resolvedTarget.targetName) {
                continue;
            }

            const targetKinds = target.kind.filter(k => k === 'bin' || k === 'example') as TargetKind[];
            if (targetKinds.length === 0) {
                continue;
            }

            if (pkg.name !== resolvedTarget.packageName) {
                sameNameInOtherPackages.add(`${pkg.name}:${targetKinds.join(',')}`);
                continue;
            }

            for (const kind of targetKinds) {
                if (kind !== resolvedTarget.kind) {
                    sameNameInSamePackageOtherKinds.add(kind);
                }
            }
        }
    }

    return {
        targetName: resolvedTarget.targetName,
        targetKind: resolvedTarget.kind,
        packageName: resolvedTarget.packageName,
        selectedManifest,
        selectedManifestIsWorkspaceRoot,
        sameNameInOtherPackages: Array.from(sameNameInOtherPackages).sort(),
        sameNameInSamePackageOtherKinds: Array.from(sameNameInSamePackageOtherKinds).sort(),
        candidateCountBeforeDedupe,
        candidateCountAfterDedupe
    };
}

function dedupeCandidateManifests(
    candidates: Array<CandidateManifestInfo | undefined>
): CandidateManifestInfo[] {
    const result: CandidateManifestInfo[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        const key = normalizeFsPath(candidate.manifestPath);
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(candidate);
    }

    return result;
}

async function resolveTargetFile(uri?: vscode.Uri): Promise<{ filePath: string; source: 'editor' | 'explorer' | 'unknown' } | undefined> {
    if (uri?.scheme === 'file') {
        return {
            filePath: uri.fsPath,
            source: 'explorer'
        };
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found.');
        return undefined;
    }

    const document = editor.document;
    if (document.isUntitled) {
        vscode.window.showErrorMessage('Please save the current file before running Rust target.');
        return undefined;
    }

    return {
        filePath: document.uri.fsPath,
        source: 'editor'
    };
}

function getConfig(): RunnerConfig {
    const config = vscode.workspace.getConfiguration('rustSmartRunner');

    const cargoCommandArgs = config.get<string[]>('cargoCommandArgs', []);
    const cargoSubcommandArgs = config.get<string[]>('cargoSubcommandArgs', []);
    const legacyCargoExtraArgs = config.get<string[]>('cargoExtraArgs', []);

    const effectiveCommandArgs =
        cargoCommandArgs.length === 0 && cargoSubcommandArgs.length === 0
            ? legacyCargoExtraArgs
            : cargoCommandArgs;

    return {
        cargoPath: config.get<string>('cargoPath', ''),
        cargoCommandArgs: effectiveCommandArgs,
        cargoSubcommandArgs,
        legacyCargoExtraArgs,
        runArgs: config.get<string[]>('runArgs', []),
        env: normalizeEnvConfig(config.get<Record<string, unknown>>('env', {})),
        autoSaveBeforeRun: config.get<boolean>('autoSaveBeforeRun', true),
        requireMainRsOnly: config.get<boolean>('requireMainRsOnly', false),
        revealOutputOnError: config.get<boolean>('revealOutputOnError', true),
        showStatusBarButtons: config.get<boolean>('showStatusBarButtons', true),
        metadataCacheTtlMs: config.get<number>('metadataCacheTtlMs', 3000),
        cargoValidationCacheTtlMs: config.get<number>('cargoValidationCacheTtlMs', 10000),
        uiRefreshDebounceMs: config.get<number>('uiRefreshDebounceMs', 120),
        debugLogging: config.get<boolean>('debugLogging', false),
        manifestSelectionStrategy: config.get<ManifestSelectionStrategy>('manifestSelectionStrategy', 'auto'),
        addPackageArgInWorkspaceRoot: config.get<boolean>('addPackageArgInWorkspaceRoot', true)
    };
}

function getWorkspaceContext(filePath: string): WorkspaceContextInfo {
    const fileUri = vscode.Uri.file(filePath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);

    if (!workspaceFolder) {
        return {
            isExternalFile: true
        };
    }

    return {
        workspaceFolder,
        workspaceFolderName: workspaceFolder.name,
        workspaceFolderPath: workspaceFolder.uri.fsPath,
        relativeFilePath: toRelativeOrSelf(workspaceFolder.uri.fsPath, filePath),
        isExternalFile: false
    };
}

function scheduleUiRefresh(delayMs?: number): void {
    const config = getConfig();
    const debounceMs = delayMs ?? config.uiRefreshDebounceMs;

    if (uiRefreshTimer) {
        clearTimeout(uiRefreshTimer);
        uiRefreshTimer = undefined;
    }

    uiRefreshTimer = setTimeout(() => {
        uiRefreshTimer = undefined;
        void refreshUiContext();
    }, debounceMs);
}

async function refreshUiContext(): Promise<void> {
    const seq = ++uiRefreshSequence;
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        await vscode.commands.executeCommand('setContext', 'rustSmartRunner.isRunnableTarget', false);
        updateStatusBarVisibility(false);
        return;
    }

    const document = editor.document;
    const isRust = document.languageId === 'rust' || document.fileName.toLowerCase().endsWith('.rs');

    if (!isRust || document.isUntitled) {
        await vscode.commands.executeCommand('setContext', 'rustSmartRunner.isRunnableTarget', false);
        updateStatusBarVisibility(false);
        return;
    }

    const isRunnable = await isStrictRunnableTargetFile(document);

    if (seq !== uiRefreshSequence) {
        return;
    }

    debugLog(`UI refresh resolved runnable target = ${isRunnable} for ${document.uri.fsPath}`);

    await vscode.commands.executeCommand('setContext', 'rustSmartRunner.isRunnableTarget', isRunnable);
    updateStatusBarVisibility(isRunnable);
}

function updateStatusBarVisibility(isRunnableTarget: boolean): void {
    const config = getConfig();

    if (!config.showStatusBarButtons) {
        statusRunButton.hide();
        statusDebugButton.hide();
        statusCopyButton.hide();
        return;
    }

    if (!isRunnableTarget) {
        statusRunButton.hide();
        statusDebugButton.hide();
        statusCopyButton.hide();
        return;
    }

    statusRunButton.show();
    statusDebugButton.show();
    statusCopyButton.show();
}

async function isStrictRunnableTargetFile(document: vscode.TextDocument): Promise<boolean> {
    const filePath = document.uri.fsPath;
    const normalizedFilePath = normalizeFsPath(filePath);

    if (!normalizedFilePath.endsWith('.rs')) {
        return false;
    }

    const config = getConfig();
    const cargoPath = await resolveCargoPath(config.cargoPath);
    if (!cargoPath) {
        return false;
    }

    const cargoOk = await validateCargoCached(cargoPath, config.cargoValidationCacheTtlMs);
    if (!cargoOk) {
        return false;
    }

    try {
        const manifestResolution = await selectManifestForFile(filePath, cargoPath, config);
        if (!manifestResolution) {
            return false;
        }

        const metadata = await getCargoMetadataCached(cargoPath, manifestResolution.selectedManifest, config.metadataCacheTtlMs);
        const target = await resolveTargetFromMetadataWithDiagnostics(metadata, manifestResolution.selectedManifest, filePath, false);
        return Boolean(target.resolvedTarget);
    } catch (err) {
        debugLog(`Strict runnable target detection failed: ${errorToString(err)}`);
        return false;
    }
}

function normalizeEnvConfig(input: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string') {
            result[key] = value;
        } else if (value !== undefined && value !== null) {
            result[key] = String(value);
        }
    }
    return result;
}

function findNearestCargoTomlBounded(filePath: string): string | undefined {
    const workspace = getWorkspaceContext(filePath);
    const stopDir = workspace.workspaceFolderPath
        ? path.resolve(workspace.workspaceFolderPath)
        : undefined;

    let current = path.resolve(path.dirname(filePath));

    while (true) {
        const candidate = path.join(current, 'Cargo.toml');
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }

        if (stopDir && normalizeFsPath(current) === normalizeFsPath(stopDir)) {
            return undefined;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return undefined;
        }

        current = parent;
    }
}

function findWorkspaceRootCargoToml(filePath: string): string | undefined {
    const workspace = getWorkspaceContext(filePath);
    if (!workspace.workspaceFolderPath) {
        return undefined;
    }

    const candidate = path.join(workspace.workspaceFolderPath, 'Cargo.toml');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
    }

    return undefined;
}

async function resolveCargoPath(configuredCargoPath: string): Promise<string | undefined> {
    if (configuredCargoPath.trim() !== '') {
        return configuredCargoPath.trim();
    }

    return process.platform === 'win32' ? 'cargo.exe' : 'cargo';
}

function getCargoValidationCacheKey(cargoPath: string): string {
    return cargoPath.trim().toLowerCase();
}

async function validateCargoCached(cargoPath: string, ttlMs: number): Promise<boolean> {
    const cacheKey = getCargoValidationCacheKey(cargoPath);
    const now = Date.now();
    const existing = cargoValidationCache.get(cacheKey);

    if (existing && (ttlMs <= 0 || now - existing.timestamp <= ttlMs)) {
        debugLog(`cargo validation cache hit: ${cargoPath} => ${existing.ok}`);
        return existing.ok;
    }

    const ok = await validateCargo(cargoPath);
    cargoValidationCache.set(cacheKey, {
        timestamp: now,
        ok
    });

    debugLog(`cargo validation cache miss: ${cargoPath} => ${ok}`);
    return ok;
}

async function validateCargo(cargoPath: string): Promise<boolean> {
    try {
        const result = await execFileAsync(cargoPath, ['--version']);
        debugLog(`Cargo version check ok: ${result.stdout.trim() || result.stderr.trim()}`);
        return true;
    } catch (err) {
        debugLog(`Cargo validation failed: ${errorToString(err)}`);
        return false;
    }
}

function getMetadataCacheKey(manifestPath: string): string {
    return normalizeFsPath(manifestPath);
}

async function getCargoMetadataCached(
    cargoPath: string,
    manifestPath: string,
    ttlMs: number
): Promise<CargoWorkspaceMetadata> {
    const cacheKey = getMetadataCacheKey(manifestPath);
    const now = Date.now();
    const existing = metadataCache.get(cacheKey);

    if (existing && (ttlMs <= 0 || now - existing.timestamp <= ttlMs)) {
        debugLog(`cargo metadata cache hit: ${manifestPath}`);
        return existing.metadata;
    }

    debugLog(`cargo metadata cache miss: ${manifestPath}`);
    const metadata = await getCargoMetadata(cargoPath, manifestPath);

    metadataCache.set(cacheKey, {
        timestamp: now,
        metadata
    });

    return metadata;
}

function invalidateMetadataCacheForFile(filePath: string): void {
    const nearest = findNearestCargoTomlBounded(filePath);
    const root = findWorkspaceRootCargoToml(filePath);

    for (const manifestPath of [nearest, root]) {
        if (!manifestPath) {
            continue;
        }

        const cacheKey = getMetadataCacheKey(manifestPath);
        if (metadataCache.delete(cacheKey)) {
            debugLog(`cargo metadata cache invalidated: ${manifestPath}`);
        }
    }
}

async function getCargoMetadata(cargoPath: string, manifestPath: string): Promise<CargoWorkspaceMetadata> {
    const args = ['metadata', '--manifest-path', manifestPath, '--no-deps', '--format-version', '1'];
    debugLog(`cargo metadata command: ${quoteCommand(cargoPath, args)}`);

    try {
        const result = await execFileAsync(cargoPath, args, {
            cwd: path.dirname(manifestPath)
        });

        const stdout = result.stdout.trim();
        return JSON.parse(stdout) as CargoWorkspaceMetadata;
    } catch (err) {
        debugLog(`cargo metadata failed: ${errorToString(err)}`);
        throw new Error('Failed to parse Cargo metadata for the detected manifest.');
    }
}

async function resolveTargetFromMetadataWithDiagnostics(
    metadata: CargoWorkspaceMetadata,
    manifestPath: string,
    currentFilePath: string,
    allowUserPick = true
): Promise<{
    resolvedTarget?: ResolvedTarget;
    candidateCountBeforeDedupe: number;
    candidateCountAfterDedupe: number;
    candidateDescriptions: string[];
}> {
    const normalizedManifestPath = normalizeFsPath(manifestPath);
    const normalizedCurrentFilePath = normalizeFsPath(currentFilePath);

    const candidatePackages = metadata.packages;

    debugLog(`Resolving target from metadata for current file: ${currentFilePath}`);
    debugLog(`Selected manifest for resolution: ${manifestPath}`);
    debugLog(`Metadata workspace root: ${metadata.workspace_root ?? '(none)'}`);
    debugLog(`Metadata package count: ${metadata.packages.length}`);
    debugLog(`Candidate package count considered for target resolution: ${candidatePackages.length}`);

    const runnableCandidates: ResolvedTarget[] = [];

    for (const pkg of candidatePackages) {
        const normalizedPackageManifest = normalizeFsPath(pkg.manifest_path);
        const packageTargets = pkg.targets ?? [];

        debugLog(
            `Inspecting package: ${pkg.name} | manifest=${pkg.manifest_path} | ` +
            `manifestMatchesSelected=${normalizedPackageManifest === normalizedManifestPath} | ` +
            `targetCount=${packageTargets.length}`
        );

        for (const target of packageTargets) {
            const runnableKinds = target.kind.filter(k => k === 'bin' || k === 'example') as TargetKind[];
            if (runnableKinds.length === 0) {
                continue;
            }

            const normalizedTargetSrcPath = normalizeFsPath(target.src_path);
            const srcMatches = normalizedTargetSrcPath === normalizedCurrentFilePath;

            debugLog(
                `  Target: ${target.name} | kinds=${target.kind.join(',')} | src=${target.src_path} | ` +
                `srcMatchesCurrent=${srcMatches}`
            );

            if (srcMatches) {
                runnableCandidates.push({
                    packageName: pkg.name,
                    manifestPath: pkg.manifest_path,
                    manifestDir: path.dirname(pkg.manifest_path),
                    targetName: target.name,
                    kind: runnableKinds[0],
                    srcPath: target.src_path
                });
            }
        }
    }

    const uniqueCandidates = dedupeResolvedTargets(runnableCandidates);
    const candidateDescriptions = uniqueCandidates.map(candidate =>
        `${candidate.packageName}:${candidate.kind}:${candidate.targetName}:${candidate.srcPath}`
    );

    debugLog(`Resolved ${runnableCandidates.length} runnable target candidate(s) from metadata rooted at ${manifestPath}.`);
    debugLog(`Unique candidate count after dedupe: ${uniqueCandidates.length}`);

    if (uniqueCandidates.length === 0) {
        return {
            candidateCountBeforeDedupe: runnableCandidates.length,
            candidateCountAfterDedupe: uniqueCandidates.length,
            candidateDescriptions
        };
    }

    if (uniqueCandidates.length === 1 || !allowUserPick) {
        return {
            resolvedTarget: uniqueCandidates[0],
            candidateCountBeforeDedupe: runnableCandidates.length,
            candidateCountAfterDedupe: uniqueCandidates.length,
            candidateDescriptions
        };
    }

    const picked = await vscode.window.showQuickPick(
        uniqueCandidates.map(candidate => ({
            label: `${candidate.kind}: ${candidate.targetName}`,
            description: candidate.srcPath,
            detail: `package: ${candidate.packageName}`,
            candidate
        })),
        {
            placeHolder: 'Multiple Rust runnable targets found. Please select one.'
        }
    );

    if (!picked) {
        debugLog('User cancelled target selection.');
        return {
            candidateCountBeforeDedupe: runnableCandidates.length,
            candidateCountAfterDedupe: uniqueCandidates.length,
            candidateDescriptions
        };
    }

    return {
        resolvedTarget: picked.candidate,
        candidateCountBeforeDedupe: runnableCandidates.length,
        candidateCountAfterDedupe: uniqueCandidates.length,
        candidateDescriptions
    };
}

function dedupeResolvedTargets(targets: ResolvedTarget[]): ResolvedTarget[] {
    const result: ResolvedTarget[] = [];
    const seen = new Set<string>();

    for (const target of targets) {
        const key = [
            normalizeFsPath(target.manifestPath),
            target.kind,
            target.targetName,
            normalizeFsPath(target.srcPath)
        ].join('|');

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push(target);
    }

    return result;
}

function buildRunCargoArgs(config: RunnerConfig, ctx: ExecutionContextData): string[] {
    const args: string[] = [];

    args.push(...config.cargoCommandArgs);
    args.push('run');
    args.push(...config.cargoSubcommandArgs);
    args.push('--manifest-path', ctx.selectedManifest);

    if (shouldAddPackageArg(ctx)) {
        args.push('-p', ctx.resolvedTarget.packageName);
    }

    if (ctx.resolvedTarget.kind === 'bin') {
        args.push('--bin', ctx.resolvedTarget.targetName);
    } else {
        args.push('--example', ctx.resolvedTarget.targetName);
    }

    if (config.runArgs.length > 0) {
        args.push('--', ...config.runArgs);
    }

    return args;
}

function buildDebugCargoBuildArgs(config: RunnerConfig, ctx: ExecutionContextData): string[] {
    const args: string[] = [];

    args.push(...config.cargoCommandArgs);
    args.push('build');
    args.push(...config.cargoSubcommandArgs);
    args.push('--manifest-path', ctx.selectedManifest);

    if (shouldAddPackageArg(ctx)) {
        args.push('-p', ctx.resolvedTarget.packageName);
    }

    if (ctx.resolvedTarget.kind === 'bin') {
        args.push('--bin', ctx.resolvedTarget.targetName);
    } else {
        args.push('--example', ctx.resolvedTarget.targetName);
    }

    return args;
}

function quoteCommand(command: string, args: string[]): string {
    const all = [command, ...args];
    return all.map(shellQuote).join(' ');
}

function shellQuote(value: string): string {
    if (value.length === 0) {
        return process.platform === 'win32' ? '""' : "''";
    }

    if (process.platform === 'win32') {
        if (/[\s"]/g.test(value)) {
            return `"${value.replace(/"/g, '\\"')}"`;
        }
        return value;
    }

    if (/[^A-Za-z0-9_./:=+-]/.test(value)) {
        return `'${value.replace(/'/g, `'\\''`)}'`;
    }

    return value;
}

function toRelativeOrSelf(basePath: string, targetPath: string): string {
    const relative = path.relative(basePath, targetPath);
    return relative === '' ? '.' : relative;
}

function normalizeFsPath(p: string): string {
    const normalized = path.normalize(p);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function execFileAsync(
    file: string,
    args: string[],
    options?: { cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            {
                cwd: options?.cwd,
                env: process.env
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject({
                        error,
                        stdout: stdout?.toString() ?? '',
                        stderr: stderr?.toString() ?? ''
                    });
                    return;
                }

                resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString()
                });
            }
        );
    });
}

function safeDebugConfigForLog(config: vscode.DebugConfiguration): unknown {
    return {
        ...config,
        env: config.env ? Object.keys(config.env as Record<string, string>) : {},
        cargo: config.cargo
    };
}

function logHeader(title: string): void {
    outputChannel.appendLine('');
    outputChannel.appendLine(`=== ${title} ===`);
}

function log(message: string): void {
    outputChannel.appendLine(message);
}

function debugLog(message: string): void {
    if (!getConfig().debugLogging) {
        return;
    }

    outputChannel.appendLine(`[debug] ${message}`);
}

async function handleError(userMessage: string, err: unknown): Promise<void> {
    log(`${userMessage} ${errorToString(err)}`);

    const reveal = vscode.workspace
        .getConfiguration('rustSmartRunner')
        .get<boolean>('revealOutputOnError', true);

    if (reveal) {
        outputChannel.show(true);
    }

    vscode.window.showErrorMessage(userMessage);
}

function errorToString(err: unknown): string {
    if (err instanceof Error) {
        return err.stack || err.message;
    }

    try {
        return JSON.stringify(err, null, 2);
    } catch {
        return String(err);
    }
}