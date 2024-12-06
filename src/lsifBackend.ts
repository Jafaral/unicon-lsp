import * as fs from 'fs';
import { nextTick } from 'process';
import * as vscode from 'vscode';

interface LSIFDatabase {
    vertices: Map<string, any>;
    edges: Map<string, any>;
}

export class LSIFBackend {
    private database: LSIFDatabase;
    private outputChannel: vscode.OutputChannel;

    constructor(outputChannel: vscode.OutputChannel) {
        this.database = { vertices: new Map(), edges: new Map() };
        this.outputChannel = outputChannel;
    }

    load(filePath: string): void {
        this.outputChannel.appendLine(`[Database] Loading LSIF file into backend from: ${filePath}`);
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n').filter(line => line.trim() !== '');
        lines.forEach(line => {
            const obj = JSON.parse(line);
            if (obj.type === 'vertex') {
                this.database.vertices.set(obj.id, obj);
            } else if (obj.type === 'edge') {
                this.database.edges.set(obj.id, obj);
            }
        });
        this.outputChannel.appendLine(`[Database] Loaded ${this.database.vertices.size} vertices and ${this.database.edges.size} edges.`);
    }

    getHoverData(documentUri: string, position: { line: number; character: number }): string | null {
        //fix the "%3A" thing
        documentUri = decodeURIComponent(documentUri);
        //Move line and character up by one because ulsp has it back one for each
        position.line += 1;
        position.character += 1;
        this.outputChannel.appendLine('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
        this.outputChannel.appendLine(`[Hover Help] Hover request for URI: ${documentUri} at position: ${position.line}:${position.character}`);

        //look for a document first that matches the request URI
        let documentVertex: any | undefined;
        for (const vertex of this.database.vertices.values()) {
            if (vertex.label === 'document' && vertex.uri === documentUri) {
                documentVertex = vertex;
                break;
            }
        }
        
        //if no document is found, cry
        if (!documentVertex) {
            this.outputChannel.appendLine(`[Hover Help] No Document vertex found for URI: ${documentUri}`);
            return null;
        }
        
        //this.outputChannel.appendLine(`[Hover Help] Document vertex found: ${JSON.stringify(documentVertex)}`);
        
        //look for a contains edge that has outV pointing out of document and inVs pointing to ranges
        let containsEdge: any | undefined;
        for (const edge of this.database.edges.values()) {
            if (edge.label === 'contains' && edge.outV === documentVertex.id) {
                containsEdge = edge;
                break;
            }
        }
        
        //if no contains edge, cry
        if (!containsEdge) {
            this.outputChannel.appendLine(`[Hover Help] No Contains edge found for document ID: ${documentVertex.id}`);
            return null;
        }
    
        //this.outputChannel.appendLine(`[Hover Help] Contains edge found: ${JSON.stringify(containsEdge)}`);
        
        //loop through every range that contains edge points to
        for (const rangeId of containsEdge.inVs) {
            const range = this.database.vertices.get(rangeId);
            //this.outputChannel.appendLine(`[Hover Help] Checking range: start(${range.start.line}, ${range.start.character}) - end(${range.end.line}, ${range.end.character})`);
            
            //if requested position is within start and end of range match it
            if (position.line >= range.start.line && position.line <= range.end.line &&
                position.character >= range.start.character && position.character <= range.end.character) {
                
                this.outputChannel.appendLine(`[Hover Help] Position matched range: ${JSON.stringify(range)}`);
                
                //for matched range, loop through edges to find either a next edge or a textDocument/hover edge that matches
                for (const edge of this.database.edges.values()) {
                    if (edge.label === 'next' && edge.outV === range.id) {
                        for (const edge2 of this.database.edges.values()) {
                            if (edge2.label === 'textDocument/hover' && edge2.outV === edge.inV) {
                                //get inV ID that matches to hoverResult vertex
                                const hoverResult = this.database.vertices.get(edge2.inV);
                                if (hoverResult && hoverResult.label === 'hoverResult') {
                                    this.outputChannel.appendLine(`[Hover Help] Hover result found: ${JSON.stringify(hoverResult)}`);
                                    return hoverResult.result.contents.map((content: any) => content.value).join('\n');
                                }
                            }
                        }
                    } else if (edge.label === 'textDocument/hover' && edge.outV === range.id) {
                        //get inV ID that matches to hoverResult vertex
                        const hoverResult = this.database.vertices.get(edge.inV);
                        if (hoverResult && hoverResult.label === 'hoverResult') {
                            this.outputChannel.appendLine(`[Hover Help] Hover result found: ${JSON.stringify(hoverResult)}`);
                            return hoverResult.result.contents.map((content: any) => content.value).join('\n');
                        }
                    }
                }
            }
        }
        this.outputChannel.appendLine('[Hover Help] No hover data matched.');
        return null;
    }

    getDefinitionData(documentUri: string, position: { line: number; character: number }): vscode.Location[] | null {
        //fix the "%3A" thing
        documentUri = decodeURIComponent(documentUri);
        //Move line and character up by one because ulsp has it back one for each
        position.line += 1;
        position.character += 1;
        this.outputChannel.appendLine('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
        this.outputChannel.appendLine(`[Definition Help] Definition requested for URI: ${documentUri} at position: ${position.line}:${position.character}`);
        
        //look for a document first that matches the request URI
        let documentVertex: any | undefined;
        for (const vertex of this.database.vertices.values()) {
            if (vertex.label === 'document' && vertex.uri === documentUri) {
                documentVertex = vertex;
                break;
            }
        }
        
        //if no document is found, cry
        if (!documentVertex) {
            this.outputChannel.appendLine(`[Definition Help] No Document vertex found for URI: ${documentUri}`);
            return null;
        }
        //this.outputChannel.appendLine(`[Definition Help] Document vertex found: ${JSON.stringify(documentVertex)}`);
        
        //look for a contains edge that has outV pointing out of document and inVs pointing to ranges
        let containsEdge: any | undefined;
        for (const edge of this.database.edges.values()) {
            if (edge.label === 'contains' && edge.outV === documentVertex.id) {
                containsEdge = edge;
                break;
            }
        }
        
        //if no contains edge, cry
        if (!containsEdge) {
            this.outputChannel.appendLine(`[Definition Help] No Contains edge found for document ID: ${documentVertex.id}`);
            return null;
        }
        //this.outputChannel.appendLine(`[Definition Help] Contains edge found: ${JSON.stringify(containsEdge)}`);
        
        const locations: vscode.Location[] = [];
        //loop through every range that contains edge points to
        for (const rangeID of containsEdge.inVs) {
            const range = this.database.vertices.get(rangeID);
            //this.outputChannel.appendLine(`[Definition Help] Checking range: start(${range.start.line}, ${range.start.character}) - end(${range.end.line}, ${range.end.character})`);
            
            //if requested position is within start and end of range match it
            if (position.line >= range.start.line && position.line <= range.end.line &&
                position.character >= range.start.character && position.character <= range.end.character) {
                
                this.outputChannel.appendLine(`[Definition Help] Position matched range: ${JSON.stringify(range)}`);

                for (const referenceItem of this.database.edges.values()) {
                    if (referenceItem.label === "item" && referenceItem.inVs !== undefined && referenceItem.inVs.includes(range.id)) {
                        this.outputChannel.appendLine(`[Definition Help] Found reference: ${JSON.stringify(referenceItem)}`);
                        for (const definedItem of this.database.edges.values()) {
                            if (definedItem.label === "item" && definedItem.outV === referenceItem.outV && definedItem.property === "definitions") {
                                this.outputChannel.appendLine(`[Definition Help] Found definition: ${JSON.stringify(definedItem)}`);
                                documentVertex = this.database.vertices.get(definedItem.shard)
                                for (const edge of this.database.edges.values()) {
                                    if (edge.label === 'contains' && edge.outV === documentVertex.id) {
                                        containsEdge = edge;
                                        break;
                                    }
                                }
                                if (!containsEdge) {
                                    this.outputChannel.appendLine(`[Definition Help] No Contains edge found for document ID: ${documentVertex.id}`);
                                    return null;
                                }
                                for (const rangeDefinedItemID of containsEdge.inVs) {
                                    if (definedItem.inVs.includes(rangeDefinedItemID)) {
                                        const rangeDefinedItem = this.database.vertices.get(rangeDefinedItemID);
                                        this.outputChannel.appendLine(`[Definition Help] Found range of definition: ${JSON.stringify(rangeDefinedItem)}`);
                                        locations.push(new vscode.Location(
                                            vscode.Uri.parse(documentVertex.uri),
                                            new vscode.Range(
                                                new vscode.Position(rangeDefinedItem.start.line-1, rangeDefinedItem.start.character-1),
                                                new vscode.Position(rangeDefinedItem.end.line-1, rangeDefinedItem.end.character-1)
                                            )
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
            this.outputChannel.appendLine(`[Definition Help] No definition locations found.`);
            return null;
        }
    
        //this.outputChannel.appendLine(`[Definition Help] Definition location found: ${JSON.stringify(locations)}`);
        return locations;
    }

    getReferencesData(documentUri: string, position: { line: number; character: number }): vscode.Location[] | null {
        //fix the "%3A" thing
        documentUri = decodeURIComponent(documentUri);
        //Move line and character up by one because ulsp has it back one for each
        position.line += 1;
        position.character += 1;
        this.outputChannel.appendLine('~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
        this.outputChannel.appendLine(`[References Help] Reference requested for URI: ${documentUri} at position: ${position.line}:${position.character}`);

        //look for a document first that matches the request URI
        let documentVertex: any | undefined;
        for (const vertex of this.database.vertices.values()) {
            if (vertex.label === 'document' && vertex.uri === documentUri) {
                documentVertex = vertex;
                break;
            }
        }
        
        //if no document is found, cry
        if (!documentVertex) {
            this.outputChannel.appendLine(`[References Help] No Document vertex found for URI: ${documentUri}`);
            return null;
        }
        
        //look for a contains edge that has outV pointing out of document and inVs pointing to ranges
        let containsEdge: any | undefined;
        for (const edge of this.database.edges.values()) {
            if (edge.label === 'contains' && edge.outV === documentVertex.id) {
                containsEdge = edge;
                break;
            }
        }
        
        //if no contains edge, cry
        if (!containsEdge) {
            this.outputChannel.appendLine(`[References Help] No Contains edge found for document ID: ${documentVertex.id}`);
            return null;
        }
        
        //loop through every range that contains edge points to
        let rangeVertex: any | undefined;
        for (const rangeID of containsEdge.inVs) {
            const range = this.database.vertices.get(rangeID);
            
            //if requested position is within start and end of range match it
            if (position.line >= range.start.line && position.line <= range.end.line &&
                position.character >= range.start.character && position.character <= range.end.character) {
                rangeVertex = range;
                this.outputChannel.appendLine(`[References Help] Position matched range: ${JSON.stringify(range)}`);
            }
        }
    
        //if no range vertex, cry
        if (!rangeVertex) {
            this.outputChannel.appendLine('[References Help] No range vertex found for position.');
            return null;
        }
        this.outputChannel.appendLine(`[References Help] Range vertex found: ${JSON.stringify(rangeVertex)}`);
    
        // look for a resultSet vertex that matches this range
        let resultSetVertex: any | undefined;
        for (const edge of this.database.edges.values()) {
            if (edge.label === 'next' && edge.outV === rangeVertex.id) {
                resultSetVertex = this.database.vertices.get(edge.inV);
                break;
            }
        }
    
        //if no resultSet, cry
        if (!resultSetVertex || resultSetVertex.label !== 'resultSet') {
            this.outputChannel.appendLine('[References Help] No resultSet vertex found for range.');
            return null;
        }
        this.outputChannel.appendLine(`[References Help] ResultSet vertex found: ${JSON.stringify(resultSetVertex)}`);
    
        //look for a referenceResult vertex
        let referenceResult: any | undefined;
        for (const edge of this.database.edges.values()) {
            if (edge.label === 'textDocument/references' && edge.outV === resultSetVertex.id) {
                referenceResult = this.database.vertices.get(edge.inV);
                break;
            }
        }
    
        //if no referenceResult, cry
        if (!referenceResult || referenceResult.label !== 'referenceResult') {
            this.outputChannel.appendLine('[References Help] No reference result found for resultSet.');
            return null;
        }
        this.outputChannel.appendLine(`[References Help] Reference result found: ${JSON.stringify(referenceResult)}`);
    
        //look for any item edges that link to the referenceResult
        const itemEdges: any[] = [];
        for (const edge of this.database.edges.values()) {
            if (edge.label === 'item' && edge.outV === referenceResult.id && edge.property !== undefined && edge.property === "references") {
                itemEdges.push(edge);
            }
        }
        
        //if no item edge, cry
        if (itemEdges.length === 0) {
            this.outputChannel.appendLine('[References Help] No item edges found for reference result.');
            return null;
        }
        this.outputChannel.appendLine(`[References Help] Item edge found: ${JSON.stringify(itemEdges)}`);
    
        const locations: vscode.Location[] = [];
        for (const itemEdge of itemEdges) {
            const documentVertex = this.database.vertices.get(itemEdge.shard);
            if (!documentVertex) {
                this.outputChannel.appendLine(`[References Help] No document vertex found for shard ${itemEdge.shard}.`);
                continue;
            }

            for (const rangeId of itemEdge.inVs) {
                const referenceRange = this.database.vertices.get(rangeId);
                if (referenceRange && referenceRange.label === 'range') {
                    locations.push(new vscode.Location(vscode.Uri.parse(documentVertex.uri),
                    new vscode.Range(new vscode.Position(referenceRange.start.line - 1, referenceRange.start.character - 1),
                    new vscode.Position(referenceRange.end.line - 1, referenceRange.end.character - 1))));
                }
            }
        }

        if (locations.length === 0) {
            this.outputChannel.appendLine('[References Help] No references found.');
            return null;
        }
    
        //this.outputChannel.appendLine(`[References Help] References found: ${JSON.stringify(locations)}`);
        return locations;
    }
}
