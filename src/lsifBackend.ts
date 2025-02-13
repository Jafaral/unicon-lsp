import * as fs from 'fs';
import { nextTick } from 'process';
import * as vscode from 'vscode';

interface LSIFDatabase {
    documents: Map<string, { vertices: any[]; edges: any[] }>; 
    vertexIdToDocument: Map<number, string>;
}

// Backend class for LSIF processing. Scans for the .lsif file and reads in data, saving
// vertices and edges per document for faster processing. Provides functions for parsing
// through saved database to return hover, definition, and references data. 
export class LSIFBackend {
    private database: LSIFDatabase;
    private lsifChannel: vscode.OutputChannel;
    private currentDocumentUri: string | null = null;
    private enableDebugLogs: boolean = false;

    constructor(lsifChannel: vscode.OutputChannel) {
        this.database = { documents: new Map(), vertexIdToDocument: new Map() };
        this.lsifChannel = lsifChannel;
    }

    // Updates whether or not logger messages go through
    updateDebugSetting(enabled: boolean): void {
        this.enableDebugLogs = enabled;
        this.lsifChannel.appendLine(`[Config] LSIF debug logging is ${enabled ? "ENABLED" : "DISABLED"}.`);
    }

    // If debug messages are enabled the logger will send them through
    private logger(message: string): void {
        if (this.enableDebugLogs) {
            this.lsifChannel.appendLine(message);
        }
    }

    // Reads in and loads the given file for LSIF JSON information and splits it up according
    // to connected document and by vertices and edges
    load(filePath: string): void {
        this.lsifChannel.appendLine(`[Database] Loading LSIF file into backend from: ${filePath}`);
        
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const lines = fileContent.split('\n').filter(line => line.trim() !== '');
        
        lines.forEach(line => {
            const obj = JSON.parse(line);
            
            if (obj.label === "document" && obj.type === "vertex") {
                this.currentDocumentUri = obj.uri;
                if (!this.database.documents.has(this.currentDocumentUri)) {
                    this.database.documents.set(this.currentDocumentUri, { vertices: [], edges: [] });
                    this.database.vertexIdToDocument.set(obj.id, this.currentDocumentUri);
                }
            }
            
            if (this.currentDocumentUri) {
                if (obj.type === "vertex") {
                    this.database.documents.get(this.currentDocumentUri)!.vertices.push(obj);
                } else if (obj.type === "edge") {
                    this.database.documents.get(this.currentDocumentUri)!.edges.push(obj);
                }
            }

            if (obj.label === "contains" && obj.type === "edge") {
                this.currentDocumentUri = "unsorted";
                if (!this.database.documents.has(this.currentDocumentUri)) {
                    this.database.documents.set(this.currentDocumentUri, { vertices: [], edges: [] });
                }
            }
        });
        
        const unsortedData = this.database.documents.get("unsorted");
        if (unsortedData) {
            for (const edge of unsortedData.edges) {
                if (edge.label === "item" && edge.shard) {
                    const targetDocUri = this.database.vertexIdToDocument.get(edge.shard);
                    if (targetDocUri) {
                        this.database.documents.get(targetDocUri)!.edges.push(edge);
                        //this.logger(`Edge added to ${targetDocUri}: ${JSON.stringify(edge)}`);
                        const edgeMinus1 = this.database.documents.get("unsorted")?.edges.find(e => e.id === edge.id - 1);
                        if (edgeMinus1) {
                            this.database.documents.get(targetDocUri)!.edges.push(edgeMinus1);
                            //this.logger(`Edge added to ${targetDocUri}: ${JSON.stringify(edgeMinus1)}`);
                        }
                        const vertexMinus2 = this.database.documents.get("unsorted")?.vertices.find(v => v.id === edge.id - 2);
                        if (vertexMinus2) {
                            this.database.documents.get(targetDocUri)!.vertices.push(vertexMinus2);
                            //this.logger(`Vertex added to ${targetDocUri}: ${JSON.stringify(vertexMinus2)}`);
                        }
                    }
                }
            }  
            this.database.documents.delete("unsorted");
        }
        
        this.lsifChannel.appendLine(`[Database] Finished loading LSIF data.`);
        this.database.documents.forEach((data, uri) => {
            this.logger(`[Database] Document: ${uri}, Vertices: ${data.vertices.length}, Edges: ${data.edges.length}`);
        });
    }

    // Function to retrieve hover data for a given document and position
    getHoverData(documentUri: string, position: { line: number; character: number }): string | null {
        documentUri = decodeURIComponent(documentUri);
        position.line += 1;
        position.character += 1;
        this.logger(`~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`);
        this.logger(`[Hover Help] Hover request for URI: ${documentUri} at position: ${position.line}:${position.character}`);
        
        // Find the correct document 
        const documentData = this.database.documents.get(documentUri);
        if (!documentData) {
            this.logger(`[Hover Help] No document found for URI: ${documentUri}`);
            return null;
        }
        
        // Find the contains edge that links all the ranges to the document
        let containsEdge = documentData.edges.find(edge => edge.label === 'contains');
        if (!containsEdge) {
            this.logger(`[Hover Help] No contains edge found for document: ${documentUri}`);
            return null;
        }
        
        // Loop through the ranges in the contains edge to find the matching range to our requested position
        for (const rangeId of containsEdge.inVs) {
            const range = documentData.vertices.find(vertex => vertex.id === rangeId);
            if (!range || range.label !== 'range') continue;
            
            if (position.line >= range.start.line && position.line <= range.end.line &&
                position.character >= range.start.character && position.character <= range.end.character) {
                
                this.logger(`[Hover Help] Position matched range: ${JSON.stringify(range)}`);
                
                // For matched range, loop through edges to find either a next edge or a textDocument/hover edge that matches
                for (const edge of documentData.edges) {
                    if (edge.label === 'next' && edge.outV === range.id) {
                        this.logger(`[Hover Help] Range matched next edge: ${JSON.stringify(edge)}`);
                        for (const edge2 of documentData.edges) {
                            if (edge2.label === 'textDocument/hover' && edge2.outV === edge.inV) {
                                this.logger(`[Hover Help] Next edge matched textDocument/hover edge: ${JSON.stringify(edge2)}`);
                                //get inV ID that matches to hoverResult vertex
                                const hoverResult = documentData.vertices.find(vertex2 => vertex2.id === edge2.inV);
                                if (hoverResult && hoverResult.label === 'hoverResult') {
                                    this.logger(`[Hover Help] Hover result found: ${JSON.stringify(hoverResult)}`);
                                    return hoverResult.result.contents.map((content: any) => content.value).join('\n');
                                }
                            }
                        }
                    } else if (edge.label === 'textDocument/hover' && edge.outV === range.id) {
                        this.logger(`[Hover Help] Range matched textDocument/hover edge without next: ${JSON.stringify(edge)}`);
                        //get inV ID that matches to hoverResult vertex
                        const hoverResult = documentData.vertices.find(vertex3 => vertex3.id === edge.inV);
                        this.logger(`[Hover Help] Hover result found: ${JSON.stringify(hoverResult)}`);
                        return hoverResult.result.contents.map((content: any) => content.value).join('\n');
                    }
                }
            }
        }
        
        this.logger('[Hover Help] No hover data matched.');
        return null;
    }

    // Function to retrieve definition data for a given document and position
    getDefinitionData(documentUri: string, position: { line: number; character: number }): vscode.Location[] | null {
        documentUri = decodeURIComponent(documentUri);
        position.line += 1;
        position.character += 1;
        this.logger(`~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`);
        this.logger(`[Definition Help] Definition requested for URI: ${documentUri} at position: ${position.line}:${position.character}`);
        
        // Find the correct document
        const documentData = this.database.documents.get(documentUri);
        if (!documentData) {
            this.logger(`[Definition Help] No document found for URI: ${documentUri}`);
            return null;
        }
        
        // Find the contains edge linked to that document
        const containsEdge = documentData.edges.find(edge => edge.label === 'contains');
        if (!containsEdge) {
            this.logger(`[Definition Help] No contains edge found for document: ${documentUri}`);
            return null;
        }
        
        const locations: vscode.Location[] = [];

        // Loop through the ranges in the contains edge to find one that matches the requested position
        for (const rangeId of containsEdge.inVs) {
            const range = documentData.vertices.find(vertex => vertex.id === rangeId);
            if (!range || range.label !== 'range') continue;
            
            if (position.line >= range.start.line && position.line <= range.end.line &&
                position.character >= range.start.character && position.character <= range.end.character) {
                
                this.logger(`[Definition Help] Position matched range: ${JSON.stringify(range)}`);
                
                // Loop through and search for an item edge that contains the range id of the reference
                for (const referenceItem of documentData.edges) {
                    if (referenceItem.label === "item" && referenceItem.inVs?.includes(range.id)) {
                        // Loop through all documents searching for definitions
                        for (const [docUri, definitionData] of this.database.documents.entries()) {
                            const definitionContainsEdge = definitionData.edges.find(edge => edge.label === 'contains');
                            if (!definitionContainsEdge) continue;

                            // Loop through and search for an item edge corresponding to the referenced item's outV field
                            for (const definedItem of definitionData.edges) {
                                if (definedItem.label === "item" && definedItem.outV === referenceItem.outV && definedItem.property === "definitions") {
                                    const definitionDocUri = this.database.vertexIdToDocument.get(definedItem.shard) || docUri;

                                    // Find the position of the definition and return it
                                    const rangeDefinedItem = definitionData.vertices.find(vertex => definedItem.inVs.includes(vertex.id));
                                    if (rangeDefinedItem) {
                                        locations.push(new vscode.Location(
                                            vscode.Uri.parse(definitionDocUri),
                                            new vscode.Range(new vscode.Position(rangeDefinedItem.start.line - 1, rangeDefinedItem.start.character - 1),
                                                             new vscode.Position(rangeDefinedItem.end.line - 1, rangeDefinedItem.end.character - 1))
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        if (locations.length === 0) {
            this.logger(`[Definition Help] No definition locations found.`);
            return null;
        }
        return locations;
    }

    // Function to retrieve references data for a given document and position
    getReferencesData(documentUri: string, position: { line: number; character: number }): vscode.Location[] | null {
        documentUri = decodeURIComponent(documentUri);
        position.line += 1;
        position.character += 1;
        this.logger(`~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`);
        this.logger(`[References Help] Reference requested for URI: ${documentUri} at position: ${position.line}:${position.character}`);
        
        // Find the correct document
        const documentData = this.database.documents.get(documentUri);
        if (!documentData) {
            this.logger(`[References Help] No document found for URI: ${documentUri}`);
            return null;
        }
        
        // Find the contains edge linked to that document
        const containsEdge = documentData.edges.find(edge => edge.label === 'contains');
        if (!containsEdge) {
            this.logger(`[References Help] No contains edge found for document: ${documentUri}`);
            return null;
        }
        
        // Loop through the ranges in the contains edge and look for the range with the requested position
        let rangeVertex: any | undefined;
        for (const rangeID of containsEdge.inVs) {
            const range = documentData.vertices.find(vertex => vertex.id === rangeID);
            if (range && range.label === 'range' &&
                position.line >= range.start.line && position.line <= range.end.line &&
                position.character >= range.start.character && position.character <= range.end.character) {
                rangeVertex = range;
                this.logger(`[References Help] Position matched range: ${JSON.stringify(range)}`);
                break;
            }
        }
        
        if (!rangeVertex) {
            this.logger('[References Help] No range vertex found for position.');
            return null;
        }
        
        // Find an edge vertex that links to the resultSet
        const resultSetEdge = documentData.edges.find(edge => edge.label === 'next' && edge.outV === rangeVertex.id);
        if (!resultSetEdge) {
            this.logger('[References Help] No resultSet edge found for range.');
            return null;
        }
        this.logger(`[References Help] Found resultSetEdge: ${JSON.stringify(resultSetEdge)}`);
        
        // Find the resultSet vertex from the edge
        const resultSetVertex = documentData.vertices.find(vertex => vertex.id === resultSetEdge.inV && vertex.label === 'resultSet');
        if (!resultSetVertex) {
            this.logger('[References Help] No resultSet vertex found for range.');
            return null;
        }
        this.logger(`[References Help] Found resultSetVertex: ${JSON.stringify(resultSetVertex)}`);

        // Find the textDocument/references edge
        const referenceEdge = documentData.edges.find(edge => edge.label === 'textDocument/references' && edge.outV === resultSetVertex.id);
        if (!referenceEdge) {
            this.logger('[References Help] No reference result found for resultSet.');
            return null;
        }
        this.logger(`[References Help] Found referenceEdge: ${JSON.stringify(referenceEdge)}`);

        // Find the corresponding referenceResult
        const referenceResult = documentData.vertices.find(vertex => vertex.id === referenceEdge.inV && vertex.label === 'referenceResult');
        if (!referenceResult) {
            this.logger('[References Help] No reference result vertex found.');
            return null;
        }
        this.logger(`[References Help] Found referenceResult: ${JSON.stringify(referenceResult)}`);

        // Loop through and find all possible reference edges for that referenceResult
        let referenceEdges: any[] = [];
        for (const [uri, docData] of this.database.documents.entries()) {
            const items = docData.edges.filter(edge => edge.label === "item" && edge.outV === referenceResult.id && edge.property === 'references');
            referenceEdges = referenceEdges.concat(items);
            this.logger(`[References Help] Current referenceEdges: ${JSON.stringify(referenceResult)}`);
        }
        
        if (referenceEdges.length === 0) {
            this.logger(`[References Help] No item edges found for reference result.`);
            return null;
        }

        // Loop through the reference edges for item edges in matched documents
        const locations: vscode.Location[] = [];
        for (const itemEdge of referenceEdges) {
            const targetDocumentUri = this.database.vertexIdToDocument.get(itemEdge.shard) || documentUri;
            const targetDocumentData = this.database.documents.get(targetDocumentUri);
            if (!targetDocumentData) continue;
    
            // Loop through the ranges of the item edges of the found references and save their position
            for (const rangeId of itemEdge.inVs) {
                const referenceRange = targetDocumentData.vertices.find(vertex => vertex.id === rangeId && vertex.label === 'range');
                if (referenceRange) {
                    locations.push(new vscode.Location(
                        vscode.Uri.parse(targetDocumentUri),
                        new vscode.Range(new vscode.Position(referenceRange.start.line - 1, referenceRange.start.character - 1),
                                         new vscode.Position(referenceRange.end.line - 1, referenceRange.end.character - 1))
                    ));
                }
            }
        }

        if (locations.length === 0) {
            this.logger('[References Help] No references found.');
            return null;
        }
        
        // Return all positions found for references if any
        return locations;
    }
}
