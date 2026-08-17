import * as path from 'path';
import * as fs from 'fs';
import { SocketIOAPI } from '../api/socketio';
import {
    loadFileHashes, saveFileHashes, hashBuffer,
    loadTrackedPaths, saveTrackedPaths,
} from '../config';
import { loadProjectContext } from '../project-context';
import { DocumentEntity, FileEntity, FolderEntity } from '../api/types';
import { RemoteTree } from '../sync/remote-tree';
import { RemoteOperations } from '../sync/remote-ops';
import { shouldIgnore, shouldTreatAsText, loadSyncIgnore } from '../sync/watcher';
import { logger } from '../utils/logger';
import { normalizeProjectPath, resolveProjectPath } from '../utils/paths';
import { collectLocalSyncSnapshot } from '../sync/local-snapshot';

export async function pushProject(
    localDir: string,
    opts?: { pruneRemote?: boolean },
) {
    const pruneRemote = opts?.pruneRemote === true;
    const {localDir: resolvedDir, projectConfig, identity, api} = loadProjectContext(localDir);
    let socket: SocketIOAPI | undefined;

    try {
        socket = new SocketIOAPI(api, identity, projectConfig.projectId);
        const tree = new RemoteTree();
        const project = await socket.joinProject();
        tree.setProject(project);
        const ops = new RemoteOperations(api, socket, tree, identity, projectConfig.projectId);

        let pushCount = 0;
        let deleteCount = 0;
        let errorCount = 0;
        const fileHashes = loadFileHashes(resolvedDir);
        const extraIgnore = loadSyncIgnore(resolvedDir);
        const trackedPathsBeforePush = new Set(loadTrackedPaths(resolvedDir));
        const trackedPathsToRetry = new Set<string>();

        // Phase 1: Update existing docs (text files already on remote)
        const docs = tree.walk((e) => e._type === 'doc');
        for (const {entity, path: docPath} of docs) {
            if (shouldIgnore(docPath, extraIgnore)) { continue; }
            const localPath = resolveProjectPath(resolvedDir, docPath);
            if (!fs.existsSync(localPath)) { continue; }
            const doc = entity as DocumentEntity;
            try {
                const localBytes = fs.readFileSync(localPath);
                if (!shouldTreatAsText(docPath, localBytes)) {
                    throw new Error(`Type conflict: remote document has binary local content at ${docPath}`);
                }
                const localContent = localBytes.toString('utf-8');
                const {docLines, version} = await socket.joinDoc(doc._id);
                const remoteContent = docLines.join('\n');
                doc.version = version;
                doc.localCache = remoteContent;
                doc.remoteCache = remoteContent;
                doc.lastVersion = version;

                if (localContent !== remoteContent) {
                    if ((await ops.updateDoc(doc, localContent)).updated) {
                        logger.info(`Updated: ${docPath}`);
                        pushCount++;
                    }
                }
            } catch (err) {
                logger.error(`Failed to update doc ${docPath}:`, err);
                errorCount++;
            } finally {
                try {
                    await socket.leaveDoc(doc._id);
                } catch (err) {
                    logger.debug(`Failed to leave doc ${docPath}:`, err);
                }
            }
        }

        // Phase 2: Scan local directory for new/changed files and folders
        await syncLocalToRemote(resolvedDir, resolvedDir, tree, ops, fileHashes, extraIgnore,
            (count) => { pushCount += count; },
            () => { errorCount++; },
        );

        // Phase 3: Optional remote pruning (destructive mirror mode)
        if (pruneRemote) {
            const deletion = await deleteOrphansFromRemote(resolvedDir, tree, ops, fileHashes, extraIgnore);
            deleteCount = deletion.deleted;
            errorCount += deletion.errors;
        } else {
            const deletion = await deleteTrackedDeletionsFromRemote(
                resolvedDir,
                tree,
                ops,
                fileHashes,
                extraIgnore,
                trackedPathsBeforePush,
            );
            deleteCount = deletion.deleted;
            errorCount += deletion.errors;
            for (const retryPath of deletion.retryPaths) {
                trackedPathsToRetry.add(retryPath);
            }
            logger.info(`Safe mode: preserved untracked remote files. ${deleteCount} tracked deletion(s) applied.`);
        }

        const nextTrackedPaths = new Set(collectLocalSyncSnapshot(resolvedDir, extraIgnore).trackedPaths);
        for (const retryPath of trackedPathsToRetry) { nextTrackedPaths.add(retryPath); }
        saveTrackedPaths(resolvedDir, Array.from(nextTrackedPaths));
        saveFileHashes(resolvedDir, fileHashes);

        if (errorCount > 0) {
            throw new Error(`Push finished with ${errorCount} error(s). ${pushCount} file(s) pushed, ${deleteCount} deleted.`);
        }
        logger.info(`Push complete. ${pushCount} file(s) pushed, ${deleteCount} deleted.`);
    } finally {
        socket?.disconnect();
    }
}

/**
 * Phase 3: Walk the remote tree and delete entities that no longer exist locally.
 * Also cleans up orphaned hash entries.
 */
async function deleteOrphansFromRemote(
    baseDir: string,
    tree: RemoteTree,
    ops: RemoteOperations,
    fileHashes: Record<string, string>,
    extraIgnore: string[],
): Promise<{deleted: number; errors: number}> {
    // Collect all remote entities (except root), deepest first so folders are deleted after children.
    const remoteEntries = tree.walk((e) => e._type === 'doc' || e._type === 'file' || e._type === 'folder')
        .filter((x) => x.path !== '/')
        .sort((a, b) => b.path.length - a.path.length);
    let deleteCount = 0;
    let errorCount = 0;

    for (const {entity, path: remotePath} of remoteEntries) {
        if (shouldIgnore(remotePath, extraIgnore)) { continue; }

        // Remote tree paths start with '/', local relPaths don't
        const relPath = normalizeProjectPath(remotePath);
        const localPath = resolveProjectPath(baseDir, relPath);

        if (!fs.existsSync(localPath)) {
            // Resolve parent folder for deletion
            const resolved = tree.resolveById(entity._id);
            if (!resolved) { continue; }

            try {
                await ops.deleteEntity(resolved.parentFolder, resolved.fileType, entity as FileEntity);
                logger.info(`Deleted remote orphan: ${relPath}`);
                delete fileHashes[relPath];
                deleteCount++;
            } catch (err) {
                logger.error(`Failed to delete remote orphan ${relPath}:`, err);
                errorCount++;
            }
        }
    }

    cleanupStaleLocalHashes(baseDir, fileHashes);

    return {deleted: deleteCount, errors: errorCount};
}

/**
 * Safe-mode delete:
 * delete only remote entities that were previously tracked locally and are now missing locally.
 * Preserve remote-only additions that local has never synced before.
 */
async function deleteTrackedDeletionsFromRemote(
    baseDir: string,
    tree: RemoteTree,
    ops: RemoteOperations,
    fileHashes: Record<string, string>,
    extraIgnore: string[],
    trackedPathsBeforePush: Set<string>,
): Promise<{deleted: number; errors: number; retryPaths: Set<string>}> {
    const remoteEntries = tree.walk((e) => e._type === 'doc' || e._type === 'file' || e._type === 'folder')
        .filter((x) => x.path !== '/')
        .sort((a, b) => b.path.length - a.path.length);
    let deleteCount = 0;
    let errorCount = 0;
    const retryPaths = new Set<string>();

    for (const {entity, path: remotePath} of remoteEntries) {
        if (shouldIgnore(remotePath, extraIgnore)) { continue; }
        const relPath = normalizeProjectPath(remotePath);
        if (!trackedPathsBeforePush.has(relPath)) { continue; }

        const localPath = resolveProjectPath(baseDir, relPath);
        if (fs.existsSync(localPath)) { continue; }

        const resolved = tree.resolveById(entity._id);
        if (!resolved) { continue; }
        if (entity._type === 'folder') {
            const folder = entity as FolderEntity;
            if (folder.docs.length > 0 || folder.fileRefs.length > 0 || folder.folders.length > 0) {
                logger.debug(`Skipped tracked folder delete (non-empty): ${relPath}`);
                retryPaths.add(relPath);
                continue;
            }
        }

        try {
            await ops.deleteEntity(resolved.parentFolder, resolved.fileType, entity as FileEntity);
            logger.info(`Deleted tracked remote orphan: ${relPath}`);
            delete fileHashes[relPath];
            deleteCount++;
        } catch (err) {
            logger.error(`Failed to delete tracked remote orphan ${relPath}:`, err);
            retryPaths.add(relPath);
            errorCount++;
        }
    }

    cleanupStaleLocalHashes(baseDir, fileHashes);
    return {deleted: deleteCount, errors: errorCount, retryPaths};
}

function cleanupStaleLocalHashes(baseDir: string, fileHashes: Record<string, string>): void {
    for (const key of Object.keys(fileHashes)) {
        if (!fs.existsSync(resolveProjectPath(baseDir, key))) {
            delete fileHashes[key];
        }
    }
}

async function syncLocalToRemote(
    baseDir: string,
    currentDir: string,
    tree: RemoteTree,
    ops: RemoteOperations,
    fileHashes: Record<string, string>,
    extraIgnore: string[],
    onPush: (count: number) => void,
    onError: () => void,
) {
    const entries = fs.readdirSync(currentDir, {withFileTypes: true});

    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');

        if (shouldIgnore(relPath, extraIgnore)) { continue; }

        const pathParts = relPath.split('/');

        if (entry.isDirectory()) {
            let resolved;
            try {
                resolved = tree.resolveByPath(pathParts);
            } catch {
                logger.warn(`Skipping directory ${relPath}: parent not found on remote`);
                continue;
            }
            if (resolved.fileEntity && resolved.fileType !== 'folder') {
                logger.error(`Type conflict: local directory maps to remote ${resolved.fileType}: ${relPath}`);
                onError();
                continue;
            }
            if (!resolved.fileEntity) {
                try {
                    await ops.createFolder(resolved.parentFolder, resolved.fileName);
                    logger.info(`Created folder: ${relPath}`);
                } catch (err) {
                    logger.error(`Failed to create folder ${relPath}:`, err);
                    onError();
                    continue;
                }
            }
            await syncLocalToRemote(baseDir, fullPath, tree, ops, fileHashes, extraIgnore, onPush, onError);
        } else if (entry.isFile()) {
            try {
                const resolved = tree.resolveByPath(pathParts);
                if (resolved.fileEntity) {
                    if (resolved.fileType === 'folder') {
                        throw new Error(`Type conflict: local file maps to remote folder: ${relPath}`);
                    }
                    if (resolved.fileType === 'file') {
                        const fileContent = fs.readFileSync(fullPath);
                        const localHash = hashBuffer(fileContent);
                        if (fileHashes[relPath] === localHash) { continue; }
                        await ops.updateBinary(resolved.parentFolder, resolved.fileName, new Uint8Array(fileContent));
                        fileHashes[relPath] = localHash;
                        logger.info(`Updated binary: ${relPath}`);
                        onPush(1);
                    }
                } else {
                    const fileContent = fs.readFileSync(fullPath);
                    if (shouldTreatAsText(entry.name, new Uint8Array(fileContent))) {
                        const localContent = fileContent.toString('utf-8');
                        await ops.createDoc(resolved.parentFolder, resolved.fileName, localContent, {leaveAfter: true});
                        logger.info(`Created doc: ${relPath}`);
                        onPush(1);
                    } else {
                        await ops.uploadBinary(resolved.parentFolder, resolved.fileName, new Uint8Array(fileContent));
                        fileHashes[relPath] = hashBuffer(fileContent);
                        logger.info(`Uploaded: ${relPath}`);
                        onPush(1);
                    }
                }
            } catch (err) {
                logger.error(`Failed to push ${relPath}:`, err);
                onError();
            }
        }
    }
}
