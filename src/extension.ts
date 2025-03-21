/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';
import * as path from 'path';

import {
    OutputChannel,
    ExtensionContext,
    languages,
    window,
    workspace,
    Hover,
    commands,
    MarkdownString
} from 'vscode';

import { LSIFBackend } from './lsifBackend';

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
    SocketTransport,
    Executable,
    Disposable,
    State
} from 'vscode-languageclient/node';

let client: LanguageClient;
let lsifChannel: OutputChannel;
let lsifBackend: LSIFBackend;
let lsifProviders: Disposable[] = [];
let lsifStarted: boolean;
let lspStartUp = false;

export function activate(context: ExtensionContext) {
    lsifChannel = window.createOutputChannel('Unicon Helper');
    lsifChannel.appendLine('Unicon Helper is now active!');

    //  Get current user settings and apply
    lsifBackend = new LSIFBackend(lsifChannel);
    const config = workspace.getConfiguration("uniconHelper");
    const mode = config.get<string>("mode") || "Both";
    const enableDebugLogs = config.get<boolean>("enableDebugLogs") ?? false;
    const lspLogLevel = config.get<number>("logLevel") ?? 7;
    lsifStarted = true;
    lsifChannel.appendLine(`[Config] Mode set to: ${mode}.`);
    lsifBackend.updateDebugSetting(enableDebugLogs);

    //  Check whether or not to skip LSP startup
    if (mode === "ULSP only" || mode === "Both") {
        lsifBackend.logger(`[Config] ULSP log level set to ${lspLogLevel}.`);
        startLSP(lspLogLevel);
    } else {
        lsifBackend.logger("[Config] Skipping ULSP client startup.");
    }
    //  Check whether or not to skip LSIF startup
    if (mode === "LSIF only" || mode === "Both") {
        startLSIF(context);
    } else {
        lsifBackend.logger("[Config] Skipping LSIF startup.");
        lsifStarted = false;
    }
    //  Listener for any change in user settings
    workspace.onDidChangeConfiguration(async event => {
        //  Listen for LSP Log Level change
        if (event.affectsConfiguration("uniconHelper.logLevel")) {
            const newLogLevel = workspace.getConfiguration("uniconHelper").get<number>("logLevel") ?? 7;
            lsifBackend.logger(`[Config] Updated log level to ${newLogLevel}.`);

            //  Check if a client exists and is running
            if (client && client.state === State.Running) {
                client.sendNotification("ulsp/changeLogLevel", { logLevel: newLogLevel });
                lsifBackend.logger(`[Config] Sent log level update notification (${newLogLevel}) to ULSP.`);
            } else {
                lsifBackend.logger("[Config] ULSP client is not running. Log level will be applied on next startup.");
            }
        }

        //  Listen for LSIF Debug Logs change
        if (event.affectsConfiguration("uniconHelper.enableDebugLogs")) {
            const newDebugLogs = workspace.getConfiguration("uniconHelper").get<boolean>("enableDebugLogs") ?? false;
            lsifChannel.appendLine(`[Config] LSIF Debug logs set to: ${newDebugLogs}`)
            lsifBackend.updateDebugSetting(newDebugLogs);
        }

        //  Listen for Mode change
        if (event.affectsConfiguration("uniconHelper.mode")) {
            const newMode = workspace.getConfiguration("uniconHelper").get<string>("mode") || "Both";
            lsifBackend.logger(`[Config] Mode changed to: ${newMode}`);

            //  If we don't want LSP and it is running then shut it down
            if ((newMode === "LSIF only" || newMode === "Neither") && client) {
                lsifChannel.appendLine("[Config] Stopping ULSP client.");
                client.stop();
                client = undefined;
            }
            //  If we don't want LSIF and it is running then shut it down
            if ((newMode === "ULSP only" || newMode === "Neither") && lsifStarted) {
                lsifChannel.appendLine("[Config] Stopping LSIF backend.");
                lsifBackend = undefined;
                lsifBackend = new LSIFBackend(lsifChannel)
                lsifProviders.forEach(provider => provider.dispose());
                lsifProviders = [];
                lsifStarted = false;
            }
            //  If we want LSP and it is not running then start it up
            const currentLogLevel = workspace.getConfiguration("uniconHelper").get<number>("logLevel") ?? 7;
            if ((newMode === "ULSP only" || newMode === "Both") && !client) {
                startLSP(currentLogLevel);
            }
            //  If we want LSIF and it is not running then start it up
            if ((newMode === "LSIF only" || newMode === "Both") && !lsifStarted) {
                startLSIF(context);
                lsifStarted = true;
            }
        }
    });

    //  Register the load LSIF file command
    const loadCommand = commands.registerCommand('extension.loadLsifFile', async () => {
        //  Show the open file screen
        const uri = await window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Load LSIF File',
            filters: {
                'LSIF Files': ['lsif', 'json'],
                'All Files': ['*']
            }
        });

        if (uri && uri[0]) {
            let filePath = uri[0].fsPath;
            lsifBackend = new LSIFBackend(lsifChannel);
            lsifBackend.logger(`[Load LSIF Command] Attempting to load LSIF file: ${filePath}`);
            try {
                filePath = correctUniconRoot(filePath)
                lsifBackend.load(filePath);
                lsifChannel.appendLine('[Load LSIF Command] LSIF File successfully loaded.');
            } catch (error) {
                const errorMessage = (error instanceof Error) ? error.message : String(error);
                lsifChannel.appendLine(`[Load LSIF Command] Error loading LSIF file: ${errorMessage}`);
            }
        }
    });
    context.subscriptions.push(loadCommand);
}

//  Start up LSIF by automatically finding the file, ensuring the project root is the same
//  as the user's Unicon root directory, and then register providers for hover, definition,
//  and references.
function startLSIF(context: ExtensionContext) {
    const workspaceFolders = workspace.workspaceFolders;
    lsifBackend = new LSIFBackend(lsifChannel);
    lsifChannel.appendLine("[Activation] Starting LSIF backend.");
    const currentDebugLogs = workspace.getConfiguration("uniconHelper").get<boolean>("enableDebugLogs") ?? false;
    lsifBackend.updateDebugSetting(currentDebugLogs);

    if (!workspaceFolders) {
        lsifBackend.logger("[Activation] No workspace folder detected.");
        return;
    }

    //  Look through folders until we find a file with .lsif extension
    let lsifFilePath: string | null = null;
    for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        lsifFilePath = findLSIFFile(folderPath);

        if (lsifFilePath) {
            lsifBackend.logger(`[Activation] Found LSIF file: ${lsifFilePath}`);
            break;
        }
    }

    if (lsifFilePath) {
        //  Ensure the "projectRoot" matches the LSIF file path
        try {
            const updatedFilePath = correctUniconRoot(lsifFilePath);
            lsifBackend.load(updatedFilePath);
            lsifChannel.appendLine("[Activation] LSIF file loaded successfully.");
        } catch (error) {
            lsifChannel.appendLine(`[Activation] Failed to process LSIF file: ${error.message}`);
        }
    } else {
        lsifBackend.logger("[Activation] No LSIF file found in the current workspace. Using default instead.");
        try {
            lsifFilePath = path.join(context.extensionPath, "data", "unicon.lsif");
            try {
                const updatedFilePath = correctUniconRoot(lsifFilePath);
                lsifBackend.load(updatedFilePath);
                lsifChannel.appendLine("[Activation] LSIF file loaded successfully.");
            } catch (error) {
                lsifChannel.appendLine(`[Activation] Failed to process LSIF file: ${error.message}`);
            }
        } catch (error) {
            lsifChannel.appendLine(`[Activation] Failed to process LSIF file: ${error.message}`);
        }
    }

    //  Register hover provider and call getHoverData on backend
    const hoverProvider = languages.registerHoverProvider({ scheme: 'file' }, {
        provideHover(document, position) {
            const hoverData = lsifBackend.getHoverData(document.uri.toString(), {
                line: position.line,
                character: position.character
            });
            //  If hover data is found, return it. If not then send a request to LSP
            if (hoverData) {
                lsifBackend.logger(`[Hover Help] Hover information found: ${hoverData}`);
                return new Hover(hoverData);
            } else if (client && lspStartUp) {
                lsifBackend.logger(`[Hover Help] No LSIF result, falling back to ULSP.`);
                return client.sendRequest("textDocument/hover", {
                    textDocument: { uri: document.uri.toString() },
                    position
                }).then(response => response ? new Hover((response as { contents: string | MarkdownString[] }).contents) : undefined);
            }
            return undefined;
        }
    });

    //  Register definitionProvider and call getDefinitionData on backend
    const definitionProvider = languages.registerDefinitionProvider({ scheme: 'file' }, {
        provideDefinition(document, position) {
            const definitionLocations = lsifBackend.getDefinitionData(document.uri.toString(), {
                line: position.line,
                character: position.character
            });

            //  If a definition location is found, return it. If not, send the request to LSP
            if (definitionLocations && definitionLocations.length > 0) {
                lsifBackend.logger(`[Definition Help] Definition locations found: ${definitionLocations}`);
                return definitionLocations;
            } else if (client && lspStartUp) {
                lsifBackend.logger(`[Definition Help] No LSIF result, falling back to ULSP.`);
                return client.sendRequest("textDocument/definition", {
                    textDocument: { uri: document.uri.toString() },
                    position
                });
            }
            return undefined;
        }
    });

    // Register referencesProvider and call getReferencesData on backend
    const referencesProvider = languages.registerReferenceProvider({ scheme: 'file' }, {
        provideReferences(document, position) {
            const references = lsifBackend.getReferencesData(document.uri.toString(), {
                line: position.line,
                character: position.character
            });

            // If references are found, return them. If not then return undefined.
            if (references && references.length > 0) {
                lsifBackend.logger(`[References Help] Reference locations found: ${references}`);
                return references;
            } else {
                lsifBackend.logger('[References Help] No references found.');
                return undefined;
            }
        }
    });

    lsifProviders = [hoverProvider, definitionProvider, referencesProvider];
    context.subscriptions.push(...lsifProviders);
}

// Function to look in unicon/uni/ulsp folder for a .lsif file
function findLSIFFile(folderPath: string): string | null {
    const targetPath = path.join(folderPath, 'uni', 'ulsp');
    const files = fs.readdirSync(targetPath);
    for (const file of files) {
        if (file.endsWith('.lsif')) {
            return path.join(targetPath, file);
        }
    }
    return null;
}

// Function to ensure that the metaData vertex projectRoot field matches with the
// current workspace's unicon root folder, change it if not
function correctUniconRoot(lsifFilePath: string): string {
    const fileContent = fs.readFileSync(lsifFilePath, 'utf8');

    const workspaceFolders = workspace.workspaceFolders;
    let uniconRoot: string | null = null;

    if (workspaceFolders && workspaceFolders.length > 0) {
        uniconRoot = workspaceFolders[0].uri.fsPath;
    }

    if (!uniconRoot) {
        lsifBackend.logger("[Activation] No workspace detected. Unable to determine the Unicon root directory.");
        return lsifFilePath;
    }

    const formattedRoot = uniconRoot.replace(/\\/g, '/');
    const platformRoot = process.platform === 'win32' ? '/' : '';
    const correctRoot = `file://${platformRoot}${formattedRoot}/`;
    const rootRegex = /file:\/\/\/?.*\/unicon\//;
    const firstMatch = fileContent.match(rootRegex);

    if (firstMatch) {
        const currentRoot = firstMatch[0];
        if (currentRoot !== correctRoot) {
            const updatedContent = fileContent.replace(new RegExp(currentRoot, 'g'), correctRoot);
            const sanitizedContent = updatedContent.replace(new RegExp(`${correctRoot}(.+?)\\1`, 'g'), `${correctRoot}$1`);
            fs.writeFileSync(lsifFilePath, sanitizedContent, 'utf8');
            lsifBackend.logger(`[Activation] Updated Unicon root directory in LSIF file to the correct root: ${correctRoot}`);
        }
    } else {
        lsifBackend.logger(`[Activation] No references to "unicon/" found in the LSIF file. No changes made.`);
    }
    return lsifFilePath;
}

// Function to start LSP with a timer.
async function startLSP(logLevel = 7) {
    lspStartUp = false;
    const transport: SocketTransport = { kind: TransportKind.socket, port: 7979 };
    // const options: ExecutableOptions = { detached: true, shell: true };
    const unicon: Executable = { command: 'ulsp', transport: transport, args: ["-c", "--loglevel", logLevel.toString()] };
    const serverOptions: ServerOptions = {
        run: unicon,
        debug: unicon
    };
    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
         // Register the server for plain text documents
           documentSelector: [{ scheme: 'file', language: 'unicon' }],
        // outputChannel: lspChannel,
           synchronize: {
               // Notify the server about file changes to '.clientrc files contained in the workspace
               fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
           },
           middleware: {
            async provideHover(document, position, token, next) {
                if (!lspStartUp) return undefined;
                if (lsifStarted && lsifBackend.getHoverData(document.uri.toString(), { line: position.line, character: position.character })) {
                    return undefined;
                }
                return next(document, position, token);
            },
            async provideDefinition(document, position, token, next) {
                if (!lspStartUp) return undefined;
                if (lsifStarted && lsifBackend.getDefinitionData(document.uri.toString(), { line: position.line, character: position.character })) {
                    return undefined;
                }
                return next(document, position, token);
            }
        }
    };

    client = new LanguageClient(
        'uniconLanguageServer',
        'Unicon Language Server',
        serverOptions,
        clientOptions
    );

    lsifChannel.appendLine("[Activation] ULSP is starting, please wait...");
    client.start();

    client.onDidChangeState((event) => {
        if (event.newState === State.Running) {
            lspStartUp = true;
            lsifChannel.appendLine("[Activation] ULSP is now fully started!");
        }
    });
}


export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
