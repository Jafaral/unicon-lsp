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
    commands
} from 'vscode';

import { LSIFBackend } from './lsifBackend';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	SocketTransport,
	Executable
} from 'vscode-languageclient/node';

let client: LanguageClient;
let outputChannel: OutputChannel;
let lsifBackend: LSIFBackend;

export function activate(context: ExtensionContext) {
	const transport: SocketTransport = { kind: TransportKind.socket, port: 7979 };
	// const options: ExecutableOptions = { detached: true, shell: true };
	const unicon: Executable = { command: 'ulsp', transport: transport, args: ["-c"] };
	const serverOptions: ServerOptions = {
		run: unicon,
		debug: unicon
	};


	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'unicon' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'uniconLanguageServer',
		'Unicon Language Server',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();

	outputChannel = window.createOutputChannel('Unicon LSIF Helper');
    outputChannel.appendLine('Unicon LSIF Helper is now active!');

    lsifBackend = new LSIFBackend(outputChannel);

	//Register the load LSIF file command
    let loadCommand = commands.registerCommand('extension.loadLsifFile', async () => {
        // Show the open file screen
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
            outputChannel.appendLine(`[Load LSIF Command] Attempting to load LSIF file: ${filePath}`);

            try {
                lsifBackend.load(filePath);
                outputChannel.appendLine('[Load LSIF Command] LSIF File successfully loaded.');
            } catch (error) {
                const errorMessage = (error instanceof Error) ? error.message : String(error);
                outputChannel.appendLine(`[Load LSIF Command] Error loading LSIF file: ${errorMessage}`);
            }
        }
    });

	//set the current open workspace
	const workspaceFolders = workspace.workspaceFolders;

    if (!workspaceFolders) {
        outputChannel.appendLine("[Activation] No workspace folder detected.");
        return;
    }

	//look through folders until we find a file with .lsif extension
    let lsifFilePath: string | null = null;
    for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        lsifFilePath = findLSIFFile(folderPath);

        if (lsifFilePath) {
            outputChannel.appendLine(`[Activation] Found LSIF file: ${lsifFilePath}`);
			outputChannel.show();
            break;
        }
    }

    if (lsifFilePath) {
        // Ensure the `projectRoot` matches the LSIF file path
        try {
            const updatedFilePath = correctUniconRoot(lsifFilePath);
            lsifBackend.load(updatedFilePath);
            outputChannel.appendLine("[Activation] LSIF file loaded successfully.");
        } catch (error) {
            outputChannel.appendLine(`[Activation] Failed to process LSIF file: ${error.message}`);
        }
    } else {
        outputChannel.appendLine("[Activation] No LSIF file found in the current workspace.");
    }

    //Register hover provider and call getHoverData on backend
    const hoverProvider = languages.registerHoverProvider({ scheme: 'file' }, {
		provideHover(document, position) {
            const hoverData = lsifBackend.getHoverData(document.uri.toString(), {
                line: position.line,
                character: position.character
            });
			//if hover data is found, return it 
            if (hoverData) {
				outputChannel.appendLine(`[hoverProvider] HoverData: ${hoverData}`);
                return new Hover(hoverData);
            }
        }
    });
    context.subscriptions.push(loadCommand, hoverProvider);

    //Register definitionProvider and call getDefinitionData on backend
	const definitionProvider = languages.registerDefinitionProvider({ scheme: 'file' }, {
		provideDefinition(document, position) {
			const definitionLocations = lsifBackend.getDefinitionData(document.uri.toString(), {
				line: position.line,
				character: position.character
			});
	
			if (definitionLocations && definitionLocations.length > 0) {
				outputChannel.appendLine(`[Definition Help] Definition locations found: ${JSON.stringify(definitionLocations)}`);
				return definitionLocations;
			} else {
				outputChannel.appendLine('[Definition Help] No definition locations found.');
				return undefined;
			}
		}
	});
	context.subscriptions.push(definitionProvider);

    //register referencesProvider and call getReferencesData on backend
    const referencesProvider = languages.registerReferenceProvider({ scheme: 'file' }, {
        provideReferences(document, position, context, token) {
            const references = lsifBackend.getReferencesData(document.uri.toString(), {
                line: position.line,
                character: position.character
            });
    
            if (references && references.length > 0) {
                outputChannel.appendLine(`[Reference Help] References found: ${JSON.stringify(references)}`);
                return references;
            } else {
                outputChannel.appendLine('[Reference Help] No references found.');
                return undefined;
            }
        }
    });
    
    context.subscriptions.push(referencesProvider);
}

//function to look in unicon/uni/ulsp folder for a .lsif file
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

//function to ensure that the metaData vertex projectRoot field matches with the 
//current workspace's unicon root folder, change it if not
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
            outputChannel.appendLine(`[Activation] Updated Unicon root directory in LSIF file to the correct root: ${correctRoot}`);
        }
    } else {
        outputChannel.appendLine(`[Activation] No references to "unicon/" found in the LSIF file. No changes made.`);
    }
    return lsifFilePath;
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
