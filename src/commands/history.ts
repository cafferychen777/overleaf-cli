import * as fs from 'fs';
import * as path from 'path';
import { BaseAPI } from '../api/base';
import {
    Identity,
    ProjectHistoryTreeDiffChange,
    ProjectHistoryUpdate,
    RestoredHistoryFileEntity,
} from '../api/types';
import { SocketIOAPI } from '../api/socketio';
import { loadProjectContext } from '../project-context';
import { RemoteTree } from '../sync/remote-tree';
import { shouldTreatAsText } from '../sync/watcher';
import { renderUnifiedDiff } from '../utils/unified-diff';
import {
    extractHistoryFileContent,
    filterChangedTreeEntries,
    formatHistoryTimestamp,
    formatRestoredHistoryFileResult,
    formatTreeDiffEntry,
    summarizeHistoryPaths,
    summarizeHistoryUsers,
} from '../utils/history';
import { normalizeProjectPath, resolveProjectPath, sanitizeFileName } from '../utils/paths';

interface HistoryContext {
    localDir: string;
    projectId: string;
    projectName: string;
    identity: Identity;
    api: BaseAPI;
}

interface RemoteProjectSnapshot {
    socket: SocketIOAPI;
    tree: RemoteTree;
}

export interface HistoryListOptions {
    limit?: number;
}

function getHistoryContext(localDir: string): HistoryContext {
    const {localDir: resolvedDir, projectConfig, identity, api} = loadProjectContext(localDir);

    return {
        localDir: resolvedDir,
        projectId: projectConfig.projectId,
        projectName: projectConfig.projectName,
        identity,
        api,
    };
}

async function loadRemoteProjectSnapshot(context: HistoryContext): Promise<RemoteProjectSnapshot> {
    const socket = new SocketIOAPI(context.api, context.identity, context.projectId);
    try {
        const tree = new RemoteTree();
        tree.setProject(await socket.joinProject());
        return {socket, tree};
    } catch (error) {
        socket.disconnect();
        throw error;
    }
}

function normalizeHistoryFilePath(filePath: string): string {
    const normalizedPath = normalizeProjectPath(filePath);
    if (!normalizedPath) { throw new Error('History file path must not be empty.'); }
    return normalizedPath;
}

async function getHistoryFileContent(context: HistoryContext, filePath: string, version: number): Promise<string> {
    const res = await context.api.getHistoryFileDiff(context.identity, context.projectId, filePath, version, version);
    if (res.type !== 'success' || !res.historyFileDiff) {
        throw new Error(res.message || `Failed to read ${filePath} at history version ${version}.`);
    }
    const content = extractHistoryFileContent(res.historyFileDiff);
    if (content === undefined) {
        throw new Error(`No text snapshot available for ${filePath} at version ${version}.`);
    }
    return content;
}

export async function listProjectHistory(localDir: string, options?: HistoryListOptions): Promise<ProjectHistoryUpdate[]> {
    const context = getHistoryContext(localDir);
    const res = await context.api.getHistoryUpdates(context.identity, context.projectId, options?.limit);
    if (res.type !== 'success' || !res.historyUpdates) {
        throw new Error(res.message || 'Failed to load project history.');
    }
    const updates = res.historyUpdates.updates;
    return options?.limit ? updates.slice(0, options.limit) : updates;
}

export function formatHistoryList(updates: ProjectHistoryUpdate[]): string {
    if (updates.length === 0) {
        return 'No project history was returned.';
    }

    const lines: string[] = [];
    for (const update of updates) {
        lines.push(
            `v${update.toV}  from v${update.fromV}  ${formatHistoryTimestamp(update.meta.end_ts)}  ` +
            `${summarizeHistoryUsers(update)}`
        );
        lines.push(`  ${summarizeHistoryPaths(update)}`);
    }
    return lines.join('\n');
}

export async function diffProjectHistory(localDir: string, fromVersion: number, toVersion: number): Promise<ProjectHistoryTreeDiffChange[]> {
    const context = getHistoryContext(localDir);
    const res = await context.api.getHistoryTreeDiff(context.identity, context.projectId, fromVersion, toVersion);
    if (res.type !== 'success' || !res.historyTreeDiff) {
        throw new Error(res.message || `Failed to compare project history v${fromVersion} to v${toVersion}.`);
    }
    return filterChangedTreeEntries(res.historyTreeDiff.diff);
}

export function formatProjectHistoryDiff(entries: ProjectHistoryTreeDiffChange[], fromVersion: number, toVersion: number): string {
    if (entries.length === 0) {
        return `No project-level changes found between v${fromVersion} and v${toVersion}.`;
    }

    const lines = [`Changes v${fromVersion} -> v${toVersion}:`];
    for (const entry of entries) {
        lines.push(`  ${formatTreeDiffEntry(entry)}`);
    }
    return lines.join('\n');
}

export async function diffHistoryFile(localDir: string, filePath: string, fromVersion: number, toVersion: number): Promise<string> {
    const context = getHistoryContext(localDir);
    const normalizedPath = normalizeHistoryFilePath(filePath);

    if (!shouldTreatAsText(normalizedPath)) {
        throw new Error(`History diff currently supports text files only: ${normalizedPath}`);
    }

    const [oldContent, newContent] = await Promise.all([
        getHistoryFileContent(context, normalizedPath, fromVersion),
        getHistoryFileContent(context, normalizedPath, toVersion),
    ]);

    return renderUnifiedDiff(normalizedPath, oldContent, newContent, {
        oldLabel: `v${fromVersion}`,
        newLabel: `v${toVersion}`,
    });
}

export async function exportProjectHistory(localDir: string, version: number, outputPath?: string): Promise<string> {
    const context = getHistoryContext(localDir);
    const res = await context.api.downloadHistoryVersionZip(context.identity, context.projectId, version);
    if (res.type !== 'success' || !res.content) {
        throw new Error(res.message || `Failed to download project history v${version}.`);
    }

    const archiveName = `${sanitizeFileName(context.projectName)}-v${version}.zip`;
    const destination = outputPath
        ? path.resolve(outputPath)
        : resolveProjectPath(context.localDir, archiveName);
    try {
        if (fs.lstatSync(destination).isSymbolicLink()) {
            throw new Error(`Refusing to overwrite symbolic link: ${destination}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
    fs.writeFileSync(destination, Buffer.from(res.content));
    return destination;
}

async function resolveRestoredPath(context: HistoryContext, restored: RestoredHistoryFileEntity): Promise<string | undefined> {
    const {socket, tree} = await loadRemoteProjectSnapshot(context);
    try {
        return tree.resolveById(restored.id)?.path;
    } finally {
        socket.disconnect();
    }
}

export async function restoreHistoryFile(localDir: string, filePath: string, version: number): Promise<string> {
    const context = getHistoryContext(localDir);
    const normalizedPath = normalizeHistoryFilePath(filePath);

    let docId: string | undefined;
    const snapshot = await loadRemoteProjectSnapshot(context);
    try {
        try {
            const resolved = snapshot.tree.resolveByPath(normalizedPath.split('/'));
            if (resolved.fileType === 'doc' && resolved.fileId) {
                docId = resolved.fileId;
            }
        } catch {
            docId = undefined;
        }
    } finally {
        snapshot.socket.disconnect();
    }

    const res = await context.api.restoreHistoryFile(context.identity, context.projectId, normalizedPath, version, docId);
    if (res.type !== 'success' || !res.restoredHistoryFile) {
        throw new Error(res.message || `Failed to restore ${normalizedPath} from history version ${version}.`);
    }

    const restoredPath = await resolveRestoredPath(context, res.restoredHistoryFile);
    return formatRestoredHistoryFileResult(res.restoredHistoryFile, restoredPath);
}
