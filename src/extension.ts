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
} from 'vscode-languageclient/node';

let client: LanguageClient;
let lsifChannel: OutputChannel;
let lsifBackend: LSIFBackend;
let lsifProviders: Disposable[] = [];
let lsifStarted: Boolean;
let lspStartUp = false;


export function activate(context: ExtensionContext) {
	lsifChannel = window.createOutputChannel('Unicon LSIF Helper');
    lsifChannel.appendLine('Unicon LSIF Helper is now active!');

    //  Get current user settings and apply 
    lsifBackend = new LSIFBackend(lsifChannel);
    const config = workspace.getConfiguration("lspMain");
    const mode = config.get<string>("mode") || "Both";
    const enableDebugLogs = config.get<boolean>("enableDebugLogs") ?? false;
    const lspLogLevel = config.get<number>("logLevel") ?? 7;
    lsifStarted = true;
    lsifChannel.appendLine(`[Config] Mode set to: ${mode}.`);
    lsifBackend.updateDebugSetting(enableDebugLogs);

    //  Check whether or not to skip LSP startup
    if (mode === "LSP only" || mode === "Both") {
        lsifChannel.appendLine(`[Config] LSP log level set to ${lspLogLevel}.`);
        startLSP(lspLogLevel);
    } else {
        lsifChannel.appendLine("[Config] Skipping LSP client startup.");
    }
    //  Check whether or not to skip LSIF startup
    if (mode === "LSIF only" || mode === "Both") {
        startLSIF(context);
    } else {
        lsifChannel.appendLine("[Config] Skipping LSIF startup.");
        lsifStarted = false;
    }
    //  Listener for any change in user settings
    workspace.onDidChangeConfiguration(async event => {
        //  Listen for LSP Log Level change
        if (event.affectsConfiguration("lspMain.logLevel")) {
            const newLogLevel = workspace.getConfiguration("lspMain").get<number>("logLevel") ?? 7;
            lsifChannel.appendLine(`[Config] Updated log level to ${newLogLevel}`);
        
            //  Check if a client is already running
            if (client) {
                lsifChannel.appendLine("[Config] LSP client will restart to apply new log level.");
                try {
                    //  await commands.executeCommand("setContext", "config.lspMain.logLevelChangeAllowed", false);
                    client.stop(); 
                    //
                    lsifChannel.appendLine("[Config] LSP client stopped.");
                    client = undefined;
                    lsifChannel.appendLine("[Config] Restarting LSP client in 20 seconds...");
                    //  Wait 20 seconds after client stops to restart LSP
                    setTimeout(async () => {
                        startLSP(newLogLevel);
                        //  await commands.executeCommand("setContext", "config.lspMain.logLevelChangeAllowed", true);
                    }, 20000);
                } catch (error) {
                    lsifChannel.appendLine(`[Error] Failed to stop LSP client: ${error}`);
                }
            } else {
                lsifChannel.appendLine("[Config] LSP client is not running. Log level will be applied on next startup.");
            }
        } 
        
        //  Listen for LSIF Debug Logs change
        if (event.affectsConfiguration("lspMain.enableDebugLogs")) {
            const newDebugLogs = workspace.getConfiguration("lspMain").get<boolean>("enableDebugLogs") ?? false;
            lsifBackend.updateDebugSetting(newDebugLogs);
        }
        
        //  Listen for Mode change
        if (event.affectsConfiguration("lspMain.mode")) {
            const newMode = workspace.getConfiguration("lspMain").get<string>("mode") || "Both";
            lsifChannel.appendLine(`[Config] Mode changed to: ${newMode}`);
        
            //  If we don't want LSP and it is running then shut it down
            if ((newMode === "LSIF only" || newMode === "Neither") && client) {
                lsifChannel.appendLine("[Config] Stopping LSP client.");
                client.stop();
                lsifChannel.appendLine("[Config] LSP client stopped.");
                client = undefined;
            }
            //  If we don't want LSIF and it is running then shut it down
            if ((newMode === "LSP only" || newMode === "Neither") && lsifStarted) {
                lsifChannel.appendLine("[Config] Stopping LSIF backend.");
                lsifBackend = undefined;
                lsifBackend = new LSIFBackend(lsifChannel)
                lsifProviders.forEach(provider => provider.dispose());
                lsifProviders = [];
                lsifStarted = false;
            }
            //  If we want LSP and it is not running then start it up
            const currentLogLevel = workspace.getConfiguration("lspMain").get<number>("logLevel") ?? 7;
            if ((newMode === "LSP only" || newMode === "Both") && !client) {
                lsifChannel.appendLine("[Config] Starting LSP client.");
                startLSP(currentLogLevel);
            }
            //  If we want LSIF and it is not running then start it up
            if ((newMode === "LSIF only" || newMode === "Both") && !lsifStarted) {
                lsifChannel.appendLine("[Config] Starting LSIF backend.");
                startLSIF(context);
                lsifStarted = true;
            }   
        }
    });

	//  Register the load LSIF file command
    let loadCommand = commands.registerCommand('extension.loadLsifFile', async () => {
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
            const filePath = uri[0].fsPath;
            lsifChannel.appendLine(`[Load LSIF Command] Attempting to load LSIF file: ${filePath}`);
            lsifBackend = new LSIFBackend(lsifChannel);
            try {
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
    const currentDebugLogs = workspace.getConfiguration("lspMain").get<boolean>("enableDebugLogs") ?? false;
    lsifBackend.updateDebugSetting(currentDebugLogs);

    if (!workspaceFolders) {
        lsifChannel.appendLine("[Activation] No workspace folder detected.");
        return;
    }

	//  Look through folders until we find a file with .lsif extension
    let lsifFilePath: string | null = null;
    for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        lsifFilePath = findLSIFFile(folderPath);

        if (lsifFilePath) {
            lsifChannel.appendLine(`[Activation] Found LSIF file: ${lsifFilePath}`);
			lsifChannel.show();
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
        lsifChannel.appendLine("[Activation] No LSIF file found in the current workspace.");
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
				lsifChannel.appendLine(`[Hover Help] HoverData: ${hoverData}`);
                return new Hover(hoverData);
            } else if (client && lspStartUp) {
                lsifChannel.appendLine(`[Hover Help] No LSIF result, falling back to LSP.`);
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
				lsifChannel.appendLine(`[Definition Help] Definition locations found: ${JSON.stringify(definitionLocations)}`);
				return definitionLocations;
			} else if (client && lspStartUp) {
                lsifChannel.appendLine(`[Definition Help] No LSIF result, falling back to LSP.`);
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
        provideReferences(document, position, context, token) {
            const references = lsifBackend.getReferencesData(document.uri.toString(), {
                line: position.line,
                character: position.character
            });
            
            // If references are found, return them. If not then return undefined.
            if (references && references.length > 0) {
                lsifChannel.appendLine(`[References Help] References found: ${JSON.stringify(references)}`);
                return references;
            } else {
                lsifChannel.appendLine('[References Help] No references found.');
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
    const lsifDirectory = path.dirname(lsifFilePath).replace(/\\/g, '/');
    const platformRoot = process.platform === 'win32' ? '/' : '';
    const correctRoot = `file://${platformRoot}${lsifDirectory.split('/unicon/')[0]}/unicon/`;
    const rootRegex = /file:\/\/\/?.*\/unicon\//;
    const firstMatch = fileContent.match(rootRegex);

    if (firstMatch) {
        const currentRoot = firstMatch[0];
        if (currentRoot !== correctRoot) {
            const updatedContent = fileContent.replace(new RegExp(currentRoot, 'g'), correctRoot);
			const sanitizedContent = updatedContent.replace(new RegExp(`${correctRoot}(.+?)\\1`, 'g'), `${correctRoot}$1`);
            fs.writeFileSync(lsifFilePath, sanitizedContent, 'utf8');
            lsifChannel.appendLine(`[Activation] Updated Unicon root directory in LSIF file to the correct root: ${correctRoot}`);
        }
    } else {
        lsifChannel.appendLine(`[Activation] No references to "unicon/" found in the LSIF file. No changes made.`);
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
                if (lsifBackend && lsifBackend.getHoverData(document.uri.toString(), { line: position.line, character: position.character })) {
                    return undefined;
                }
                return next(document, position, token);
            },
            async provideDefinition(document, position, token, next) {
                if (!lspStartUp) return undefined;
                if (lsifBackend && lsifBackend.getDefinitionData(document.uri.toString(), { line: position.line, character: position.character })) {
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

    lsifChannel.appendLine("[Activation] LSP is starting, please wait...");
	await client.start();

    // Set a delay timer before enabling LSP requests
    setTimeout(() => {
        lspStartUp = true;
        lsifChannel.appendLine("[Activation] LSP is now fully started!");
    }, 10000);
}


export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
