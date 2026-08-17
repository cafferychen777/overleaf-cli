import * as fs from 'fs';
import * as path from 'path';
import { BaseAPI } from '../api/base';
import { SocketIOAPI } from '../api/socketio';
import {
    Identity, DocumentEntity, FileEntity, FileType, FolderEntity,
    UpdateSchema,
} from '../api/types';
import { RemoteTree } from './remote-tree';
import { RemoteOperations } from './remote-ops';
import { DebounceManager } from './debounce';
import { LocalWatcher, shouldIgnore, shouldTreatAsText } from './watcher';
import { applyOtOps, MergeConflictError, mergeRemoteIntoLocalResult } from './merge';
import { logger } from '../utils/logger';
import { normalizeProjectPath, resolveProjectPath } from '../utils/paths';
import { decodeSocketText } from '../utils/socket-text';
import { hashBuffer } from '../config';
import { SyncStateStore } from './state-store';

export interface SyncEngineOptions {
    serverUrl: string;
    projectId: string;
    localDir: string;
    identity: Identity;
    ignorePatterns?: string[];
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'disconnected';

export interface PullResult {
    projectName: string;
    pulled: number;
    conflictsArchived: number;
    errors: number;
}

export function syncPathQueueKey(projectPath: string): string {
    return `path:${normalizeProjectPath(projectPath)}`;
}

export class SyncEngine {
    private api: BaseAPI;
    private socket!: SocketIOAPI;
    private ops!: RemoteOperations;
    private tree: RemoteTree;
    private debounce: DebounceManager;
    private watcher: LocalWatcher;
    private identity: Identity;
    private projectId: string;
    private localDir: string;
    private publicId?: string;
    private retryCount = 0;
    private stopped = false;
    private reconnecting = false;
    private _status: SyncStatus = 'idle';
    private joinedDocs: Map<string, DocumentEntity> = new Map();
    private recentLocalCreateIds: Map<string, NodeJS.Timeout> = new Map();
    private statusListeners: Array<(status: SyncStatus) => void> = [];
    private deferredReconcileTimers: Map<string, NodeJS.Timeout> = new Map();
    private localChangeRetryTimers: Map<string, NodeJS.Timeout> = new Map();
    private opQueues: Map<string, Promise<void>> = new Map();
    private pendingDocUpdates: Map<string, Array<{baseVersion: number; opSig: string}>> = new Map();
    private docPushInFlight: Set<string> = new Set();
    private docPushPendingPaths: Map<string, string> = new Map();
    private docConcurrentOps: Map<string, number> = new Map();
    private docAckTimers: Map<string, NodeJS.Timeout> = new Map();
    private stateStore: SyncStateStore;

    constructor(opts: SyncEngineOptions) {
        this.projectId = opts.projectId;
        this.localDir = path.resolve(opts.localDir);
        this.identity = opts.identity;
        this.stateStore = new SyncStateStore(this.localDir);

        this.api = new BaseAPI(opts.serverUrl);
        this.api.setIdentity(opts.identity);
        this.tree = new RemoteTree();
        this.debounce = new DebounceManager();
        this.watcher = new LocalWatcher(opts.localDir, opts.ignorePatterns);
    }

    get status(): SyncStatus { return this._status; }

    private setStatus(s: SyncStatus) {
        this._status = s;
        for (const cb of this.statusListeners) { cb(s); }
    }

    onStatusChange(cb: (status: SyncStatus) => void) {
        this.statusListeners.push(cb);
    }

    private initOps() {
        this.ops = new RemoteOperations(this.api, this.socket, this.tree, this.identity, this.projectId);
    }

    async start() {
        logger.info('Starting sync engine...');
        this.stopped = false;
        this.setStatus('syncing');

        // Connect socket (don't register disconnect handler until after join succeeds)
        this.socket = new SocketIOAPI(this.api, this.identity, this.projectId);
        this.initOps();

        try {
            const project = await this.socket.joinProject();

            // Now register remote handlers (including disconnect)
            this.setupRemoteHandlers();
            this.tree.setProject(project);
            logger.info(`Joined project: ${project.name}`);

            // Join all docs and preserve unsynced local edits.
            await this.joinAllDocs({preserveLocalEdits: true, reason: 'startup'});
        } catch (err) {
            this.socket.disconnect();
            this.setStatus('error');
            throw err;
        }

        // Start local watcher — route local and remote events through the same
        // queue namespace so operations for the same entity/path are serialized.
        this.watcher.on('change', (relPath: string) => this.enqueueLocalPathOp(relPath, () => this.handleLocalChange(relPath)));
        this.watcher.on('add', (relPath: string) => this.enqueueLocalPathOp(relPath, () => this.handleLocalAdd(relPath)));
        this.watcher.on('unlink', (relPath: string) => this.enqueueLocalPathOp(relPath, () => this.handleLocalUnlink(relPath)));
        this.watcher.on('addDir', (relPath: string) => this.enqueueLocalPathOp(relPath, () => this.handleLocalAddDir(relPath)));
        this.watcher.on('unlinkDir', (relPath: string) => this.enqueueLocalPathOp(relPath, () => this.handleLocalUnlinkDir(relPath)));
        this.watcher.start();

        this.retryCount = 0;
        if (this.status !== 'error') { this.setStatus('idle'); }
        logger.info('Sync engine started. Watching for changes...');
    }

    async stop() {
        logger.info('Stopping sync engine...');
        this.stopped = true;
        await this.watcher.stop();
        await Promise.all(Array.from(this.opQueues.values()));

        // Leave all joined docs
        for (const [docId] of this.joinedDocs) {
            try { await this.socket.leaveDoc(docId); } catch (err) {
                logger.debug(`Failed to leave doc ${docId} during stop:`, err);
            }
        }
        this.joinedDocs.clear();
        this.clearTransientState();
        this.socket.disconnect();
        this.setStatus('disconnected');
        logger.info('Sync engine stopped.');
    }

    private setupRemoteHandlers() {
        this.socket.updateEventHandlers({
            onDisconnected: () => {
                if (this.stopped || this.reconnecting) { return; }
                logger.warn('Socket disconnected');
                this.setStatus('disconnected');
                this.retryCount++;
                if (this.retryCount <= 3) {
                    logger.info(`Reconnecting (attempt ${this.retryCount})...`);
                    setTimeout(() => this.reconnect(), 1000 * this.retryCount);
                } else {
                    logger.error('Max reconnect attempts reached');
                    this.setStatus('error');
                }
            },
            onConnectionAccepted: (publicId: string) => {
                this.publicId = publicId;
                logger.info(`Connection accepted, publicId: ${publicId}`);
            },
            onFileCreated: (parentFolderId: string, type: FileType, entity: FileEntity) => {
                this.enqueueRemoteCreateOp(parentFolderId, entity.name, entity._id, () =>
                    this.handleRemoteCreate(parentFolderId, type, entity)
                );
            },
            onFileRenamed: (entityId: string, newName: string) => {
                this.enqueueEntityOp(entityId, () => this.handleRemoteRename(entityId, newName));
            },
            onFileRemoved: (entityId: string) => {
                this.enqueueEntityOp(entityId, () => this.handleRemoteRemove(entityId));
            },
            onFileMoved: (entityId: string, newParentFolderId: string) => {
                this.enqueueEntityOp(entityId, () => this.handleRemoteMove(entityId, newParentFolderId));
            },
            onFileChanged: (update: UpdateSchema) => {
                this.enqueueEntityOp(update.doc, () => this.handleRemoteChange(update));
            },
        });
    }

    private async reconnect() {
        if (this.stopped || this.reconnecting) { return; }
        this.reconnecting = true;
        try {
            this.socket.disconnect();
            this.joinedDocs.clear();
            await Promise.all(Array.from(this.opQueues.values()));
            this.clearTransientState();
            this.socket = new SocketIOAPI(this.api, this.identity, this.projectId);
            this.initOps();
            this.setupRemoteHandlers();
            const project = await this.socket.joinProject();
            this.tree.setProject(project);
            await this.joinAllDocs({preserveLocalEdits: true, reason: 'reconnect'});
            this.retryCount = 0;
            if (this.status !== 'error') { this.setStatus('idle'); }
            logger.info('Reconnected successfully');
        } catch (err) {
            logger.error('Reconnect failed:', err);
            this.socket.disconnect();
            this.retryCount++;
            if (this.retryCount <= 3) {
                setTimeout(() => this.reconnect(), 1000 * this.retryCount);
            } else {
                this.setStatus('error');
            }
        } finally {
            this.reconnecting = false;
        }
    }

    private async joinAllDocs(opts?: { preserveLocalEdits?: boolean; reason?: string }) {
        const docs = this.tree.walk((e) => e._type === 'doc');
        for (const {entity, path: docPath} of docs) {
            if (shouldIgnore(docPath, this.watcher.ignorePatterns)) { continue; }
            await this.joinDoc(entity as DocumentEntity, docPath, {
                preserveLocalEdits: opts?.preserveLocalEdits,
                reason: opts?.reason,
            });
        }
    }

    private async joinDoc(
        doc: DocumentEntity,
        docPath: string,
        opts?: { skipWrite?: boolean; preserveLocalEdits?: boolean; reason?: string },
    ) {
        if (this.joinedDocs.has(doc._id)) {
            logger.debug(`Doc ${doc._id} already joined, skipping`);
            return;
        }
        const {docLines, version} = await this.joinDocWithRetry(doc._id, docPath);
        const content = docLines.join('\n');
        doc.version = version;
        doc.localCache = content;
        doc.remoteCache = content;
        doc.lastVersion = version;
        this.joinedDocs.set(doc._id, doc);
        this.pendingDocUpdates.delete(doc._id);
        this.docPushInFlight.delete(doc._id);
        this.docPushPendingPaths.delete(doc._id);
        this.clearDocAckTimer(doc._id);

        if (opts?.skipWrite) { return; }

        // Write to local if not exists or different
        const localPath = resolveProjectPath(this.localDir, docPath);
        this.ensureDir(path.dirname(localPath));
        const existing = this.readLocalFile(localPath);
        if (existing !== content) {
            if (opts?.preserveLocalEdits && existing !== null) {
                // Local file has edits not on server. Use persisted cache as
                // merge base to distinguish "local never received remote edit"
                // from "local intentionally reverted remote edit".
                const cachedBase = this.stateStore.readDocCache(docPath);
                if (cachedBase !== null) {
                    const merge = mergeRemoteIntoLocalResult(cachedBase, content, existing);
                    doc.localCache = content;  // server is authoritative base
                    this.stateStore.persistDocCache(docPath, content);
                    if (merge.hasConflict) {
                        this.recordMergeConflict(docPath, content);
                    } else if (merge.mergedContent !== content) {
                        this.debounce.setBypassCache(docPath, merge.mergedContent, 'pull');
                        fs.writeFileSync(localPath, merge.mergedContent, 'utf-8');
                        this.scheduleDeferredReconcile(doc._id, docPath);
                        logger.info(`[pull] merge local edits for ${docPath} during ${opts.reason || 'join'} (cached base)`);
                    } else {
                        this.debounce.setBypassCache(docPath, content, 'pull');
                        fs.writeFileSync(localPath, content, 'utf-8');
                        logger.info(`[pull] local edits subsumed by server for ${docPath} during ${opts.reason || 'join'}`);
                    }
                    this.stateStore.trackPath(docPath);
                    return;
                }
                // Without a common base, automatically choosing either side
                // can destroy edits. Keep local visible and save remote aside.
                doc.localCache = content;
                this.stateStore.persistDocCache(docPath, content);
                this.stateStore.trackPath(docPath);
                this.recordMergeConflict(docPath, content);
                return;
            }
            this.debounce.setBypassCache(docPath, content, 'pull');
            fs.writeFileSync(localPath, content, 'utf-8');
        } else {
            this.debounce.setBypassCache(docPath, content);
        }
        this.stateStore.persistDocCache(docPath, content);
        this.stateStore.trackPath(docPath);
    }

    // --- Remote → Local handlers ---

    private async handleRemoteChange(update: UpdateSchema): Promise<void> {
        const res = this.tree.resolveById(update.doc);
        if (!res) { return; }
        if (shouldIgnore(res.path, this.watcher.ignorePatterns)) { return; }

        const doc = res.fileEntity as DocumentEntity;
        const opLen = update.op?.length ?? 0;
        if (doc.version === undefined) {
            await this.rejoinDoc(res.path, doc, 'version missing');
            return;
        }

        const isSelfSource = this.publicId !== undefined && update.meta?.source === this.publicId;
        if (isSelfSource) {
            const matchedPendingUpdate = this.ackPendingDocUpdate(doc._id, update, true);
            if (!matchedPendingUpdate) {
                if (update.v >= doc.version && (opLen > 0 || this.docPushInFlight.has(doc._id))) {
                    await this.rejoinDoc(res.path, doc, 'unmatched self update');
                }
                return;
            }
            await this.completeDocPushAck(doc, res.path, update, 'self echo ack');
            return;
        }

        // Some deployments omit meta.source. Prefer an exact pending-op match.
        // Overleaf can also acknowledge a successful applyOtUpdate RPC with an
        // empty event at the submitted base version. Accept that version-only
        // form only while this document has a known push in flight.
        const allowVersionOnlyAck = opLen === 0 && this.docPushInFlight.has(doc._id);
        if (!update.meta?.source && this.ackPendingDocUpdate(doc._id, update, allowVersionOnlyAck)) {
            const ackLabel = allowVersionOnlyAck ? 'version-only local echo ack' : 'pending local echo ack';
            await this.completeDocPushAck(doc, res.path, update, ackLabel);
            return;
        }

        // Server can emit version-bearing updates without OT payload.
        // We still need to advance local version cursor to stay aligned.
        if (opLen === 0) {
            if (update.v > doc.version) {
                await this.rejoinDoc(res.path, doc, 'noop version gap');
                return;
            }
            if (update.v === doc.version) {
                doc.version += 1;
                // Noops (opLen === 0) don't change document content — they are
                // self-echoes that the server didn't tag with meta.source, or
                // cursor/presence updates.  Don't count them as concurrent ops;
                // only real collaborator edits (with ops) should dirty a push ack.
            }
            doc.lastVersion = doc.version;
            logger.debug(`[pull] noop update for ${res.path} (v${update.v}, local v${doc.version})`);
            return;
        }
        if (update.v < doc.version) {
            logger.debug(`[pull] stale update ignored for ${res.path} (v${update.v}, local v${doc.version})`);
            return;
        }
        if (update.v > doc.version) {
            await this.rejoinDoc(res.path, doc, 'version mismatch');
            return;
        }

        doc.version += 1;
        doc.lastVersion = doc.version;
        // Track concurrent collaborator ops for clean/dirty ack detection
        if (this.docPushInFlight.has(doc._id)) {
            this.docConcurrentOps.set(doc._id, (this.docConcurrentOps.get(doc._id) ?? 0) + 1);
        }
        if (update.op && doc.remoteCache !== undefined) {
            try {
                const newContent = applyOtOps(doc.remoteCache, update.op);
                doc.remoteCache = newContent;
                this.applyRemoteSnapshotToLocal(doc, res.path, newContent);
            } catch (error) {
                logger.warn(`Rejected inconsistent OT update for ${res.path}:`, error);
                await this.rejoinDoc(res.path, doc, 'invalid OT payload');
            }
        }
    }

    private async completeDocPushAck(
        doc: DocumentEntity,
        docPath: string,
        update: UpdateSchema,
        ackLabel: string,
    ): Promise<void> {
        if (doc.version === undefined || update.v !== doc.version) {
            this.finishDocPush(doc._id);
            await this.rejoinDoc(docPath, doc, `${ackLabel} version mismatch`, {preserveLocalEdits: false});
            return;
        }

        doc.version += 1;
        doc.lastVersion = doc.version;
        if (!this.isCleanPushAck(doc._id)) {
            // The server confirmed our push, but collaborator operations also
            // arrived. Rejoin so every subsequent OT uses one canonical base.
            this.finishDocPush(doc._id);
            await this.rejoinDoc(docPath, doc, 'concurrent edit during push', {preserveLocalEdits: false});
            return;
        }

        if (doc.remoteCache !== undefined && doc.localCache !== undefined) {
            doc.remoteCache = doc.localCache;
        }
        this.finishDocPush(doc._id);
        if (doc.localCache !== undefined) {
            this.stateStore.persistDocCache(docPath, doc.localCache);
        }
        logger.debug(`[pull] ${ackLabel} for ${docPath} (local v${doc.version})`);
    }

    private async rejoinDoc(
        docPath: string,
        doc: DocumentEntity,
        reason: string,
        opts?: { preserveLocalEdits?: boolean },
    ): Promise<void> {
        logger.warn(`Rejoining ${docPath} (${reason})`);
        const preserveLocal = opts?.preserveLocalEdits ?? true;
        const oldLocalCache = doc.localCache;
        this.pendingDocUpdates.delete(doc._id);
        this.docPushInFlight.delete(doc._id);
        this.docPushPendingPaths.delete(doc._id);
        this.clearDocAckTimer(doc._id);
        this.joinedDocs.delete(doc._id);
        try {
            if (!preserveLocal && oldLocalCache !== undefined) {
                // Dirty push ack: server is authoritative, but local file may
                // have newer edits made after the push. Join with skipWrite,
                // then three-way merge to preserve those local edits.
                const localPath = resolveProjectPath(this.localDir, docPath);

                await this.joinDoc(doc, docPath, { skipWrite: true, reason });
                const serverContent = doc.localCache!;
                // Re-read file AFTER joinDoc (not before) to capture any
                // writes that happened during the network round-trip.
                const fileContent = this.readLocalFile(localPath);

                if (fileContent !== null && fileContent !== serverContent) {
                    const merge = mergeRemoteIntoLocalResult(oldLocalCache, serverContent, fileContent);
                    // Set localCache to server content (not merged) so subsequent
                    // remote ops continue through the merge path until the
                    // local delta is pushed.
                    doc.localCache = serverContent;
                    if (merge.hasConflict) {
                        this.recordMergeConflict(docPath, serverContent);
                    } else {
                        this.debounce.setBypassCache(docPath, merge.mergedContent, 'pull');
                        fs.writeFileSync(localPath, merge.mergedContent, 'utf-8');
                        logger.debug(`[rejoin] merge ${docPath}`);
                    }
                    if (!merge.hasConflict && merge.mergedContent !== serverContent) {
                        this.scheduleDeferredReconcile(doc._id, docPath);
                    }
                } else if (fileContent === null || fileContent !== serverContent) {
                    this.ensureDir(path.dirname(localPath));
                    this.debounce.setBypassCache(docPath, serverContent, 'pull');
                    fs.writeFileSync(localPath, serverContent, 'utf-8');
                    logger.debug(`[rejoin] write ${docPath}`);
                }
            } else {
                await this.joinDoc(doc, docPath, {
                    preserveLocalEdits: true,
                    reason,
                });
            }
        } catch (err) {
            logger.error(`Failed to rejoin doc ${docPath}:`, err);
        }
    }

    private applyRemoteSnapshotToLocal(doc: DocumentEntity, relPath: string, newContent: string): void {
        if (this.docPushInFlight.has(doc._id)) {
            // Push in-flight — local file contains our unacked changes.
            // remoteCache was already updated by handleRemoteChange.
            // Don't touch local; the ack handler will rejoin/reconcile.
            logger.debug(`[pull] defer write ${relPath} (push in-flight)`);
            return;
        }
        const localPath = resolveProjectPath(this.localDir, relPath);
        const localContent = this.readLocalFile(localPath);
        if (localContent === null || localContent === doc.localCache) {
            // No local changes — write remote content directly
            doc.localCache = newContent;
            this.debounce.setBypassCache(relPath, newContent, 'pull');
            this.ensureDir(path.dirname(localPath));
            fs.writeFileSync(localPath, newContent, 'utf-8');
            this.stateStore.persistDocCache(relPath, newContent);
            this.stateStore.trackPath(relPath);
            logger.debug(`[pull] update ${relPath}`);
            this.clearDeferredReconcile(doc._id);
        } else if (localContent === newContent) {
            // Local already matches remote
            doc.localCache = newContent;
            this.stateStore.persistDocCache(relPath, newContent);
            this.stateStore.trackPath(relPath);
            this.clearDeferredReconcile(doc._id);
        } else if (doc.localCache !== undefined) {
            // Local has pending changes AND remote has new content — merge
            const merge = mergeRemoteIntoLocalResult(doc.localCache, newContent, localContent);
            // Set localCache to remote content (not merged) so subsequent
            // remote ops continue through the merge path until the local
            // delta is pushed. threeWayMerge uses localCache as base —
            // when localCache === remoteCache, it correctly computes only
            // the local delta as OT ops.
            doc.localCache = newContent;
            if (merge.hasConflict) {
                this.recordMergeConflict(relPath, newContent);
            } else {
                this.debounce.setBypassCache(relPath, merge.mergedContent, 'pull');
                fs.writeFileSync(localPath, merge.mergedContent, 'utf-8');
                logger.debug(`[pull] merge ${relPath}`);
            }
            if (!merge.hasConflict && merge.mergedContent !== newContent) {
                // Merged content differs from remote — push the local delta
                this.scheduleDeferredReconcile(doc._id, relPath);
            } else {
                this.clearDeferredReconcile(doc._id);
            }
        } else {
            // No base for merge — write remote (best effort)
            doc.localCache = newContent;
            this.debounce.setBypassCache(relPath, newContent, 'pull');
            this.ensureDir(path.dirname(localPath));
            fs.writeFileSync(localPath, newContent, 'utf-8');
            logger.debug(`[pull] update ${relPath} (no merge base)`);
            this.clearDeferredReconcile(doc._id);
        }
    }

    private clearDeferredReconcile(docId: string): void {
        const timer = this.deferredReconcileTimers.get(docId);
        if (timer) {
            clearTimeout(timer);
            this.deferredReconcileTimers.delete(docId);
        }
    }

    private async handleRemoteCreate(parentFolderId: string, type: FileType, entity: FileEntity): Promise<void> {
        const parent = this.tree.resolveById(parentFolderId);
        if (!parent) { return; }
        if (parent.fileType !== 'folder') {
            throw new Error(`Remote create parent is not a folder: ${parentFolderId}`);
        }

        const entityPath = '/' + normalizeProjectPath(parent.path + entity.name);

        // If this is an echo of our own successful create, skip —
        // local push already handled tree insert and optional content upload.
        if (this.recentLocalCreateIds.has(entity._id)) {
            logger.debug(`[pull] skip ${entityPath} (created by local push)`);
            return;
        }

        // Always update tree to keep it consistent with remote, but skip local I/O for ignored paths
        this.tree.insertEntity(parent.fileEntity as FolderEntity, type, entity);

        if (shouldIgnore(entityPath, this.watcher.ignorePatterns)) {
            logger.debug(`[pull] skip ${entityPath} (ignored)`);
            return;
        }

        if (type === 'folder') {
            const localPath = resolveProjectPath(this.localDir, entityPath);
            if (fs.existsSync(localPath) && !fs.lstatSync(localPath).isDirectory()) {
                this.stateStore.archiveConflict(entityPath, 'remote folder creation collided with local content');
            }
            // Only suppress the folder addDir echo itself.
            // Suppressing descendants here can swallow immediate local file adds
            // (create folder + create file in one operation).
            this.debounce.suppressPath(entityPath, 2000, 'self');
            this.ensureDir(localPath);
            this.stateStore.trackPath(entityPath);
            logger.debug(`[pull] create folder ${entityPath}`);
        } else if (type === 'doc') {
            try {
                const localPath = resolveProjectPath(this.localDir, entityPath);
                if (fs.existsSync(localPath) && !fs.lstatSync(localPath).isFile()) {
                    this.stateStore.archiveConflict(entityPath, 'remote document creation collided with local content');
                }
                await this.joinDoc(entity as DocumentEntity, entityPath, {
                    preserveLocalEdits: true,
                    reason: 'remote create',
                });
            } catch (err) {
                logger.error(`Failed to join doc ${entityPath}:`, err);
            }
        } else if (type === 'file') {
            try {
                const localPath = resolveProjectPath(this.localDir, entityPath);
                if (fs.existsSync(localPath) && !fs.lstatSync(localPath).isFile()) {
                    this.stateStore.archiveConflict(entityPath, 'remote file creation collided with local content');
                }
                await this.downloadBinaryFile(entity._id, entityPath);
            } catch (err) {
                logger.error(`Failed to download binary ${entityPath}:`, err);
            }
        }
    }

    private async handleRemoteRename(entityId: string, newName: string): Promise<void> {
        const res = this.tree.resolveById(entityId);
        if (!res) { return; }
        if (res.path === '/') {
            throw new Error('Refusing to rename the remote project root.');
        }

        const oldLocalPath = resolveProjectPath(this.localDir, res.path);
        const oldName = res.fileEntity.name;
        if (newName === oldName) { return; }
        const wasIgnored = shouldIgnore(res.path, this.watcher.ignorePatterns);
        const hadUnsyncedLocalContent = fs.existsSync(oldLocalPath) && this.hasUnsyncedLocalContent(res.path);
        const parentDir = path.dirname(res.path);
        const newRelPath = '/' + normalizeProjectPath(parentDir === '/' ? newName : parentDir + '/' + newName);
        const newLocalPath = resolveProjectPath(this.localDir, newRelPath);
        this.tree.renameEntity(res.parentFolder, res.fileEntity, newName);
        this.moveStatePath(res.path, newRelPath);
        const nowIgnored = shouldIgnore(newRelPath, this.watcher.ignorePatterns);
        this.debounce.suppressPath(res.path);
        this.debounce.suppressPath(newRelPath);

        if (nowIgnored) {
            // Moved into ignored path — remove local copy if it exists
            if (fs.existsSync(oldLocalPath)) {
                if (hadUnsyncedLocalContent) {
                    this.stateStore.archiveConflict(res.path, 'remote rename moved local edits into an ignored path');
                } else {
                    fs.rmSync(oldLocalPath, {recursive: true, force: true});
                }
            }
            await this.unjoinDocsUnder(newRelPath);
        } else if (wasIgnored) {
            if (fs.existsSync(newLocalPath)) {
                this.stateStore.archiveConflict(newRelPath, 'remote rename collided with local content');
            }
            await this.materializeRemoteSubtree(newRelPath);
        } else if (fs.existsSync(oldLocalPath)) {
            if (oldLocalPath !== newLocalPath && fs.existsSync(newLocalPath)) {
                this.stateStore.archiveConflict(newRelPath, 'remote rename collided with local content');
            }
            this.ensureDir(path.dirname(newLocalPath));
            fs.renameSync(oldLocalPath, newLocalPath);
        } else {
            if (fs.existsSync(newLocalPath)) {
                this.stateStore.archiveConflict(newRelPath, 'remote rename collided with local content');
            }
            await this.materializeRemoteSubtree(newRelPath);
        }
        logger.debug(`[pull] rename ${oldName} → ${newName}`);
    }

    private async handleRemoteRemove(entityId: string): Promise<void> {
        const res = this.tree.resolveById(entityId);
        if (!res) { return; }
        if (res.path === '/') {
            throw new Error('Refusing to remove the remote project root.');
        }

        // Cancel any pending operations for this entity/path before removal
        this.clearLocalChangeRetry(res.path);
        const reconcileTimer = this.deferredReconcileTimers.get(entityId);
        if (reconcileTimer) {
            clearTimeout(reconcileTimer);
            this.deferredReconcileTimers.delete(entityId);
        }

        const localPath = resolveProjectPath(this.localDir, res.path);
        this.debounce.suppressPath(res.path);
        if (fs.existsSync(localPath) && this.hasUnsyncedLocalContent(res.path)) {
            this.stateStore.archiveConflict(res.path, 'remote deletion conflicted with local edits');
        }
        await this.unjoinDocsUnder(res.path);
        this.tree.removeEntity(res.parentFolder, res.fileType, res.fileEntity);
        if (fs.existsSync(localPath)) {
            fs.rmSync(localPath, {recursive: true, force: true});
        }

        if (this.joinedDocs.has(entityId)) {
            this.joinedDocs.delete(entityId);
        }
        this.pendingDocUpdates.delete(entityId);
        this.docPushInFlight.delete(entityId);
        this.docPushPendingPaths.delete(entityId);
        this.clearDocAckTimer(entityId);
        this.stateStore.removeDocCache(res.path);
        this.stateStore.untrackPath(res.path, res.fileType === 'folder');
        logger.debug(`[pull] remove ${res.path}`);
    }

    private async handleRemoteMove(entityId: string, newParentFolderId: string): Promise<void> {
        const oldRes = this.tree.resolveById(entityId);
        const newParentRes = this.tree.resolveById(newParentFolderId);
        if (!oldRes || !newParentRes) { return; }
        if (oldRes.path === '/') {
            throw new Error('Refusing to move the remote project root.');
        }
        if (newParentRes.fileType !== 'folder') {
            throw new Error(`Remote move parent is not a folder: ${newParentFolderId}`);
        }
        if (oldRes.parentFolder._id === newParentFolderId) { return; }

        const oldStatePath = normalizeProjectPath(oldRes.path);
        const newParentStatePath = normalizeProjectPath(newParentRes.path);
        if (oldRes.fileType === 'folder'
            && (newParentStatePath === oldStatePath || newParentStatePath.startsWith(oldStatePath + '/'))) {
            throw new Error(`Refusing to move remote folder ${oldRes.path} into itself.`);
        }

        const wasIgnored = shouldIgnore(oldRes.path, this.watcher.ignorePatterns);
        const oldLocalPath = resolveProjectPath(this.localDir, oldRes.path);
        const hadUnsyncedLocalContent = fs.existsSync(oldLocalPath) && this.hasUnsyncedLocalContent(oldRes.path);
        const newParentFolder = newParentRes.fileEntity as FolderEntity;
        this.tree.assertChildNameAvailable(newParentFolder, oldRes.fileEntity.name, oldRes.fileEntity._id);
        // Remove before insert — reversed order would cause same-parent moves
        // to lose the entity (insert skips existing _id, then remove deletes it)
        this.tree.removeEntity(oldRes.parentFolder, oldRes.fileType, oldRes.fileEntity);
        this.tree.insertEntity(newParentFolder, oldRes.fileType, oldRes.fileEntity);

        const newRelPath = '/' + normalizeProjectPath(newParentRes.path + oldRes.fileEntity.name);
        const newLocalPath = resolveProjectPath(this.localDir, newRelPath);
        this.moveStatePath(oldRes.path, newRelPath);
        const nowIgnored = shouldIgnore(newRelPath, this.watcher.ignorePatterns);
        this.debounce.suppressPath(oldRes.path);
        this.debounce.suppressPath(newRelPath);

        if (nowIgnored) {
            if (fs.existsSync(oldLocalPath)) {
                if (hadUnsyncedLocalContent) {
                    this.stateStore.archiveConflict(oldRes.path, 'remote move placed local edits in an ignored path');
                } else {
                    fs.rmSync(oldLocalPath, {recursive: true, force: true});
                }
            }
            await this.unjoinDocsUnder(newRelPath);
        } else if (wasIgnored) {
            if (fs.existsSync(newLocalPath)) {
                this.stateStore.archiveConflict(newRelPath, 'remote move collided with local content');
            }
            await this.materializeRemoteSubtree(newRelPath);
        } else if (fs.existsSync(oldLocalPath)) {
            if (oldLocalPath !== newLocalPath && fs.existsSync(newLocalPath)) {
                this.stateStore.archiveConflict(newRelPath, 'remote move collided with local content');
            }
            this.ensureDir(path.dirname(newLocalPath));
            fs.renameSync(oldLocalPath, newLocalPath);
        } else {
            if (fs.existsSync(newLocalPath)) {
                this.stateStore.archiveConflict(newRelPath, 'remote move collided with local content');
            }
            await this.materializeRemoteSubtree(newRelPath);
        }
        logger.debug(`[pull] move ${oldRes.path} → ${newRelPath}`);
    }

    // --- Local → Remote handlers ---

    /** Serialize async operations per entity/path across local and remote handlers. */
    private enqueueOp(queueKey: string, fn: () => Promise<void>): void {
        if (this.stopped) { return; }
        const prev = this.opQueues.get(queueKey) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        const chain = next.then(
            () => undefined,
            (error) => {
                logger.error(`Queued sync operation failed (${queueKey}):`, error);
            },
        );
        this.opQueues.set(queueKey, chain);
        chain.finally(() => {
            if (this.opQueues.get(queueKey) === chain) {
                this.opQueues.delete(queueKey);
            }
        });
    }

    private enqueueEntityOp(entityId: string, fn: () => Promise<void>): void {
        this.enqueueOp(this.getQueueKeyForEntity(entityId), fn);
    }

    private enqueueRemoteCreateOp(
        parentFolderId: string,
        entityName: string,
        entityId: string,
        fn: () => Promise<void>,
    ): void {
        const parent = this.tree.resolveById(parentFolderId);
        if (parent) {
            try {
                this.enqueueOp(syncPathQueueKey(parent.path + entityName), fn);
            } catch {
                this.enqueueEntityOp(entityId, fn);
            }
            return;
        }
        this.enqueueEntityOp(entityId, fn);
    }

    private enqueueLocalPathOp(relPath: string, fn: () => Promise<void>): void {
        this.enqueueOp(syncPathQueueKey(relPath), fn);
    }

    private getQueueKeyForEntity(entityId: string): string {
        const res = this.tree.resolveById(entityId);
        if (res) {
            return syncPathQueueKey(res.path);
        }
        return `id:${entityId}`;
    }

    private normalizeOpSignature(update: UpdateSchema): string {
        const normalized = (update.op ?? []).map((op) => ({
            p: op.p,
            i: op.i ? decodeSocketText(op.i) : '',
            d: op.d ? decodeSocketText(op.d) : '',
        }));
        return JSON.stringify(normalized);
    }

    private trackPendingDocUpdate(docId: string, update: UpdateSchema): void {
        const pending = this.pendingDocUpdates.get(docId) ?? [];
        pending.push({baseVersion: update.v, opSig: this.normalizeOpSignature(update)});
        if (pending.length > 64) {
            pending.splice(0, pending.length - 64);
        }
        this.pendingDocUpdates.set(docId, pending);
    }

    private ackPendingDocUpdate(docId: string, update: UpdateSchema, allowVersionOnly: boolean): boolean {
        const pending = this.pendingDocUpdates.get(docId);
        if (!pending || pending.length === 0) { return false; }

        const opSig = this.normalizeOpSignature(update);
        let matchIdx = pending.findIndex((p) => p.baseVersion === update.v && p.opSig === opSig);
        if (matchIdx < 0 && allowVersionOnly) {
            matchIdx = pending.findIndex((p) => p.baseVersion === update.v);
        }
        if (matchIdx < 0) { return false; }

        pending.splice(matchIdx, 1);
        if (pending.length === 0) {
            this.pendingDocUpdates.delete(docId);
        } else {
            this.pendingDocUpdates.set(docId, pending);
        }
        return true;
    }

    private finishDocPush(docId: string): void {
        this.docPushInFlight.delete(docId);
        this.docConcurrentOps.delete(docId);
        this.clearDocAckTimer(docId);
        const pendingPath = this.docPushPendingPaths.get(docId);
        if (!pendingPath) { return; }
        this.docPushPendingPaths.delete(docId);
        this.debounce.invalidate(pendingPath);
        this.enqueueLocalPathOp(pendingPath, () => this.handleLocalChange(pendingPath));
    }

    /**
     * Check if a push ack is clean (no concurrent collaborator ops between
     * push and ack). Uses a counter instead of version comparison, because
     * version-based checks fail when collaborator ops and self-echo share
     * the same base version.
     */
    private isCleanPushAck(docId: string): boolean {
        if (!this.docPushInFlight.has(docId)) { return false; }
        return (this.docConcurrentOps.get(docId) ?? 0) === 0;
    }

    private beginDocPush(docId: string, update: UpdateSchema, relPath: string): void {
        this.docPushInFlight.add(docId);
        this.docConcurrentOps.set(docId, 0);
        this.trackPendingDocUpdate(docId, update);
        this.clearDocAckTimer(docId);
        const timer = setTimeout(() => {
            this.docAckTimers.delete(docId);
            if (this.stopped || !this.docPushInFlight.has(docId)) { return; }
            this.enqueueEntityOp(docId, async () => {
                const resolved = this.tree.resolveById(docId);
                if (!resolved) {
                    this.finishDocPush(docId);
                    return;
                }
                await this.rejoinDoc(resolved.path || relPath, resolved.fileEntity as DocumentEntity, 'write acknowledgement timeout');
            });
        }, 30000);
        this.docAckTimers.set(docId, timer);
    }

    private clearDocAckTimer(docId: string): void {
        const timer = this.docAckTimers.get(docId);
        if (!timer) { return; }
        clearTimeout(timer);
        this.docAckTimers.delete(docId);
    }

    private clearTransientState(): void {
        const timerMaps = [
            this.recentLocalCreateIds,
            this.deferredReconcileTimers,
            this.localChangeRetryTimers,
            this.docAckTimers,
        ];
        for (const timerMap of timerMaps) {
            for (const timer of timerMap.values()) { clearTimeout(timer); }
            timerMap.clear();
        }
        this.opQueues.clear();
        this.pendingDocUpdates.clear();
        this.docPushInFlight.clear();
        this.docPushPendingPaths.clear();
        this.docConcurrentOps.clear();
    }

    private async handleLocalChange(relPath: string) {
        const localPath = resolveProjectPath(this.localDir, relPath);
        const pathParts = relPath.split('/').filter(Boolean);
        try {
            this.clearLocalChangeRetry(relPath);
            await this.ensureRemoteFolderPath(pathParts.slice(0, -1));
            const resolved = this.tree.resolveByPath(pathParts);
            if (resolved.fileType === 'doc' && resolved.fileEntity) {
                const content = this.readLocalFile(localPath);
                if (content === null) { return; }
                const doc = resolved.fileEntity as DocumentEntity;
                if (!this.joinedDocs.has(doc._id)) {
                    await this.joinDoc(doc, relPath, { skipWrite: true });
                }
                if (this.docPushInFlight.has(doc._id)) {
                    this.docPushPendingPaths.set(doc._id, relPath);
                    logger.debug(`[push] defer ${relPath} (awaiting server ack)`);
                    return;
                }
                if (!this.debounce.shouldPropagate('push', relPath, content)) { return; }
                logger.debug(`[push] change ${relPath}`);
                const updateRes = await this.ops.updateDoc(doc, content);
                if (!this.joinedDocs.has(doc._id)) {
                    logger.debug(`[push] ${relPath} removed during push, aborting`);
                    return;
                }
                if (updateRes.updated) {
                    if (updateRes.pushedUpdate) {
                        this.beginDocPush(doc._id, updateRes.pushedUpdate, relPath);
                    }
                    this.debounce.setBypassCache(relPath, doc.localCache!, 'push');
                }
            } else if (resolved.fileType === 'file' && resolved.fileEntity) {
                const fileContent = this.readLocalBinary(localPath);
                if (fileContent === null) { return; }
                if (!this.debounce.shouldPropagate('push', relPath, fileContent)) { return; }
                logger.debug(`[push] change ${relPath}`);
                await this.ops.updateBinary(resolved.parentFolder, resolved.fileEntity.name, fileContent);
                this.stateStore.trackPath(relPath, hashBuffer(fileContent));
            } else if (!resolved.fileEntity) {
                // Entity doesn't exist on remote — retry creation
                const fileContent = this.readLocalBinary(localPath);
                if (fileContent === null) { return; }
                const contentOrBytes = shouldTreatAsText(resolved.fileName, fileContent)
                    ? Buffer.from(fileContent).toString('utf-8')
                    : fileContent;
                if (!this.debounce.shouldPropagate('push', relPath, contentOrBytes)) { return; }
                logger.debug(`[push] change ${relPath} (missing remote, retry add)`);
                this.debounce.invalidate(relPath);
                await this.handleLocalAdd(relPath);
            } else {
                throw new Error(`Type conflict: local file maps to remote ${resolved.fileType}: ${relPath}`);
            }
        } catch (err) {
            logger.error(`Failed to push change for ${relPath}:`, err);
            this.debounce.invalidate(relPath);
            if (err instanceof MergeConflictError) {
                const resolved = this.tree.resolveByPath(pathParts);
                const doc = resolved.fileEntity as DocumentEntity | undefined;
                if (doc?.remoteCache !== undefined) {
                    doc.localCache = doc.remoteCache;
                    this.stateStore.persistDocCache(relPath, doc.remoteCache);
                    this.recordMergeConflict(relPath, doc.remoteCache);
                }
            } else if (this.isTransientError(err)) {
                this.scheduleLocalChangeRetry(relPath, 'change failed');
            }
        }
    }

    private async handleLocalAdd(relPath: string) {
        const localPath = resolveProjectPath(this.localDir, relPath);
        const pathParts = relPath.split('/').filter(Boolean);
        try {
            this.clearLocalChangeRetry(relPath);
            await this.ensureRemoteFolderPath(pathParts.slice(0, -1));
            const resolved = this.tree.resolveByPath(pathParts);
            const fileContent = this.readLocalBinary(localPath);
            if (fileContent === null) { return; }
            const contentOrBytes = shouldTreatAsText(resolved.fileName, fileContent)
                ? Buffer.from(fileContent).toString('utf-8')
                : fileContent;
            if (!this.debounce.shouldPropagate('push', relPath, contentOrBytes)) { return; }

            if (resolved.fileEntity) {
                this.debounce.invalidate(relPath);
                await this.handleLocalChange(relPath);
                return;
            }

            logger.debug(`[push] add ${relPath}`);

            try {
                if (typeof contentOrBytes === 'string') {
                    const doc = await this.ops.createDoc(resolved.parentFolder, resolved.fileName, contentOrBytes, {
                        onUpdate: (update) => this.beginDocPush(update.doc, update, relPath),
                    });
                    this.joinedDocs.set(doc._id, doc);
                    this.markRecentLocalCreate(doc._id);
                    this.stateStore.trackPath(relPath);
                } else {
                    const created = await this.ops.uploadBinary(resolved.parentFolder, resolved.fileName, contentOrBytes);
                    this.markRecentLocalCreate(created._id);
                    this.stateStore.trackPath(relPath, hashBuffer(contentOrBytes));
                }
            } catch (err) {
                if (this.isAlreadyExistsError(err)) {
                    logger.debug(`[push] add skipped (already exists): ${relPath}`);
                    this.debounce.invalidate(relPath);
                    // Remote create event will usually arrive shortly and join
                    // the canonical doc. Delay retry to avoid create/change
                    // racing on separate base snapshots.
                    this.scheduleLocalChangeRetry(relPath, 'entity exists race', 1500);
                    return;
                }
                logger.error(`Failed to create ${relPath}:`, err);
                this.debounce.invalidate(relPath);
                if (this.isTransientError(err)) {
                    this.scheduleLocalChangeRetry(relPath, 'add failed');
                }
            }
        } catch (err) {
            logger.error(`Failed to push add for ${relPath}:`, err);
            this.debounce.invalidate(relPath);
            if (this.isTransientError(err)) {
                this.scheduleLocalChangeRetry(relPath, 'add failed');
            }
        }
    }

    private async handleLocalUnlink(relPath: string) {
        if (!this.debounce.shouldPropagate('push', relPath, undefined)) { return; }
        logger.debug(`[push] unlink ${relPath}`);

        const pathParts = relPath.split('/').filter(Boolean);
        try {
            const resolved = this.tree.resolveByPath(pathParts);
            if (resolved.fileType && resolved.fileEntity) {
                const removedEntityId = resolved.fileEntity._id;
                const removedType = resolved.fileType;
                await this.ops.deleteEntity(resolved.parentFolder, resolved.fileType, resolved.fileEntity);
                if (removedType === 'doc' && this.joinedDocs.has(removedEntityId)) {
                    try { await this.socket.leaveDoc(removedEntityId); }
                    catch (error) { logger.debug(`Failed to leave deleted doc ${relPath}:`, error); }
                    this.joinedDocs.delete(removedEntityId);
                    this.pendingDocUpdates.delete(removedEntityId);
                    this.docPushInFlight.delete(removedEntityId);
                    this.docPushPendingPaths.delete(removedEntityId);
                    this.clearDocAckTimer(removedEntityId);
                    this.stateStore.removeDocCache(relPath);
                }
                this.stateStore.untrackPath(relPath, false);
            }
        } catch (err) {
            if (this.isTreeMissError(err)) {
                logger.debug(`[push] unlink skip ${relPath} (not in remote tree)`);
                return;
            }
            logger.error(`Failed to push unlink for ${relPath}:`, err);
        }
    }

    private async handleLocalAddDir(relPath: string) {
        if (!this.debounce.shouldPropagate('push', relPath, undefined)) { return; }
        logger.debug(`[push] addDir ${relPath}`);
        const pathParts = relPath.split('/').filter(Boolean);
        try {
            if (pathParts.length === 0) { return; }
            await this.ensureRemoteFolderPath(pathParts);
            this.stateStore.trackPath(relPath);
        } catch (err) {
            logger.error(`Failed to push addDir for ${relPath}:`, err);
        }
    }

    private async handleLocalUnlinkDir(relPath: string) {
        if (!this.debounce.shouldPropagate('push', relPath, undefined)) { return; }
        logger.debug(`[push] unlinkDir ${relPath}`);
        const pathParts = relPath.split('/').filter(Boolean);
        try {
            const resolved = this.tree.resolveByPath(pathParts);
            if (resolved.fileType === 'folder' && resolved.fileEntity) {
                const joinedDocIds = this.tree.walk((entity) => entity._type === 'doc')
                    .filter((entry) => {
                        const entryPath = normalizeProjectPath(entry.path);
                        const prefix = normalizeProjectPath(relPath) + '/';
                        return entryPath.startsWith(prefix);
                    })
                    .map((entry) => entry.entity._id);
                await this.ops.deleteEntity(resolved.parentFolder, 'folder', resolved.fileEntity);
                for (const docId of joinedDocIds) {
                    if (!this.joinedDocs.has(docId)) { continue; }
                    try { await this.socket.leaveDoc(docId); }
                    catch (error) { logger.debug(`Failed to leave deleted doc ${docId}:`, error); }
                    this.joinedDocs.delete(docId);
                    this.pendingDocUpdates.delete(docId);
                    this.docPushInFlight.delete(docId);
                    this.docPushPendingPaths.delete(docId);
                    this.clearDocAckTimer(docId);
                }
                this.stateStore.untrackPath(relPath, true);
                this.stateStore.removeDocCache(relPath);
            }
        } catch (err) {
            if (this.isTreeMissError(err)) {
                logger.debug(`[push] unlinkDir skip ${relPath} (not in remote tree)`);
                return;
            }
            logger.error(`Failed to push unlinkDir for ${relPath}:`, err);
        }
    }

    // --- Binary file download ---

    private async downloadBinaryFile(
        fileId: string,
        entityPath: string,
        attempt: number = 1,
        opts?: {force?: boolean},
    ): Promise<{conflictArchived: boolean}> {
        try {
            const res = await this.api.getFile(this.identity, this.projectId, fileId);
            if (res.type === 'success' && res.content) {
                const localPath = resolveProjectPath(this.localDir, entityPath);
                const remoteHash = hashBuffer(res.content);
                const statePath = normalizeProjectPath(entityPath);
                const existing = this.readLocalBinary(localPath);
                let conflictArchived = false;
                if (existing !== null) {
                    const existingHash = hashBuffer(existing);
                    const baseHash = this.stateStore.getBinaryHash(statePath);
                    if (!opts?.force && existingHash !== remoteHash && (baseHash === undefined || existingHash !== baseHash)) {
                        this.stateStore.archiveConflict(entityPath, 'remote binary update conflicted with local edits');
                        conflictArchived = true;
                    }
                }
                this.ensureDir(path.dirname(localPath));
                fs.writeFileSync(localPath, res.content);
                // Use byte-level bypass cache for binary files to avoid utf-8 lossy hashing.
                this.debounce.setBypassCache(entityPath, res.content, 'pull');
                this.stateStore.trackPath(entityPath, remoteHash);
                logger.debug(`[pull] download binary ${entityPath}`);
                return {conflictArchived};
            }
            throw new Error(`Failed to download binary ${entityPath}: empty response`);
        } catch (err) {
            if (this.isNotFoundError(err) && attempt < 3) {
                const delayMs = 180 * attempt;
                logger.debug(`[pull] retry binary download ${entityPath} (attempt ${attempt + 1})`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                const latestId = this.resolveBinaryIdByPath(entityPath) ?? fileId;
                return this.downloadBinaryFile(latestId, entityPath, attempt + 1, opts);
            }
            throw err;
        }
    }

    private scheduleDeferredReconcile(docId: string, relPath: string): void {
        const existing = this.deferredReconcileTimers.get(docId);
        if (existing) { clearTimeout(existing); }

        const timer = setTimeout(() => {
            this.deferredReconcileTimers.delete(docId);
            if (this.stopped) { return; }

            const current = this.tree.resolveById(docId);
            const currentPath = current?.path ?? relPath;
            const localPath = resolveProjectPath(this.localDir, currentPath);
            const localContent = this.readLocalFile(localPath);
            if (localContent === null) { return; }

            const doc = (current?.fileEntity ?? this.joinedDocs.get(docId)) as DocumentEntity | undefined;
            if (!doc) { return; }
            if (doc.remoteCache !== undefined && localContent === doc.remoteCache) {
                doc.localCache = localContent;
                return;
            }

            // Reconcile retries must bypass hash-based duplicate suppression:
            // local content may be unchanged while remote base has moved.
            this.debounce.invalidate(currentPath);
            this.enqueueLocalPathOp(currentPath, () => this.handleLocalChange(currentPath));
        }, 800);

        this.deferredReconcileTimers.set(docId, timer);
    }

    private clearLocalChangeRetry(relPath: string): void {
        const statePath = normalizeProjectPath(relPath);
        const existing = this.localChangeRetryTimers.get(statePath);
        if (!existing) { return; }
        clearTimeout(existing);
        this.localChangeRetryTimers.delete(statePath);
    }

    private scheduleLocalChangeRetry(relPath: string, reason: string, delayMs: number = 1200): void {
        const statePath = normalizeProjectPath(relPath);
        this.clearLocalChangeRetry(statePath);
        const timer = setTimeout(() => {
            this.localChangeRetryTimers.delete(statePath);
            if (this.stopped) { return; }
            const localPath = resolveProjectPath(this.localDir, statePath);
            try {
                if (!fs.existsSync(localPath) || fs.statSync(localPath).isDirectory()) { return; }
            } catch {
                return;
            }
            logger.debug(`[push] retry change ${statePath} (${reason})`);
            this.enqueueLocalPathOp(statePath, () => this.handleLocalChange(statePath));
        }, delayMs);
        this.localChangeRetryTimers.set(statePath, timer);
    }

    private isTransientError(err: unknown): boolean {
        const msg = typeof err === 'string'
            ? err
            : (err instanceof Error ? err.message : String(err));
        return /timeout|disconnect|socket|network|econn|epipe|etimedout|joinleaveepoch/i.test(msg);
    }

    private isAlreadyExistsError(err: unknown): boolean {
        const msg = typeof err === 'string'
            ? err
            : (err instanceof Error ? err.message : String(err));
        return /already exists/i.test(msg);
    }

    private isTreeMissError(err: unknown): boolean {
        const msg = typeof err === 'string'
            ? err
            : (err instanceof Error ? err.message : String(err));
        return /folder not found/i.test(msg);
    }

    private isNotFoundError(err: unknown): boolean {
        const msg = typeof err === 'string'
            ? err
            : (err instanceof Error ? err.message : String(err));
        return /404|not found/i.test(msg);
    }

    private resolveBinaryIdByPath(relPath: string): string | undefined {
        try {
            const pathParts = relPath.split('/').filter(Boolean);
            const resolved = this.tree.resolveByPath(pathParts);
            if (resolved.fileType === 'file' && resolved.fileEntity) {
                return resolved.fileEntity._id;
            }
        } catch {
            // best effort
        }
        return undefined;
    }

    private markRecentLocalCreate(entityId: string): void {
        const existing = this.recentLocalCreateIds.get(entityId);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.recentLocalCreateIds.delete(entityId);
        }, 4000);
        this.recentLocalCreateIds.set(entityId, timer);
    }

    private async joinDocWithRetry(
        docId: string,
        docPath: string,
        maxAttempts: number = 3,
    ): Promise<{ docLines: string[]; version: number }> {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await this.socket.joinDoc(docId);
            } catch (err) {
                lastErr = err;
                if (!this.isTransientError(err) || attempt === maxAttempts) {
                    throw err;
                }
                const delayMs = 200 * attempt;
                logger.warn(
                    `joinDoc retry ${attempt}/${maxAttempts} for ${docPath}:`,
                    err instanceof Error ? err.message : String(err)
                );
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
        throw lastErr;
    }

    // --- Pull: download full project ---

    async pullProject(opts?: {force?: boolean}): Promise<PullResult> {
        logger.info('Pulling project...');
        this.setStatus('syncing');

        this.socket = new SocketIOAPI(this.api, this.identity, this.projectId);
        try {
            const project = await this.socket.joinProject();
            this.tree.setProject(project);
            logger.info(`Joined project: ${project.name}`);

            // Walk tree and download everything
            const allEntities = this.tree.walk(() => true);
            let pullCount = 0;
            let conflictCount = 0;
            let errorCount = 0;
            for (const {entity, path: entityPath} of allEntities) {
                try {
                    const localPath = resolveProjectPath(this.localDir, entityPath);
                    if (entity._type === 'folder') {
                        if (fs.existsSync(localPath) && !fs.lstatSync(localPath).isDirectory()) {
                            if (opts?.force) {
                                fs.rmSync(localPath, {recursive: true, force: true});
                            } else {
                                this.stateStore.archiveConflict(entityPath, 'remote folder replaced local non-directory content');
                                conflictCount++;
                            }
                        }
                        this.ensureDir(localPath);
                        this.stateStore.trackPath(entityPath);
                    } else if (entity._type === 'doc') {
                        let joined = false;
                        try {
                            const {docLines} = await this.socket.joinDoc(entity._id);
                            joined = true;
                            const content = docLines.join('\n');
                            this.ensureDir(path.dirname(localPath));
                            if (fs.existsSync(localPath)) {
                                const localContent = this.readLocalFile(localPath);
                                if (localContent === null) {
                                    if (opts?.force) {
                                        fs.rmSync(localPath, {recursive: true, force: true});
                                    } else {
                                        this.stateStore.archiveConflict(entityPath, 'remote document replaced incompatible local content');
                                        conflictCount++;
                                    }
                                } else if (!opts?.force && localContent !== content) {
                                    this.stateStore.archiveConflict(entityPath, 'pull preserved differing local document');
                                    conflictCount++;
                                }
                            }
                            fs.writeFileSync(localPath, content, 'utf-8');
                            this.stateStore.persistDocCache(entityPath, content);
                            this.stateStore.trackPath(entityPath);
                            pullCount++;
                        } finally {
                            if (joined) { await this.socket.leaveDoc(entity._id); }
                        }
                    } else if (entity._type === 'file') {
                        const result = await this.downloadBinaryFile(entity._id, entityPath, 1, {force: opts?.force});
                        if (result.conflictArchived) { conflictCount++; }
                        pullCount++;
                    }
                } catch (err) {
                    logger.error(`Failed to pull ${entityPath}:`, err);
                    errorCount++;
                }
            }

            this.setStatus('idle');
            logger.info(`Pull complete. ${pullCount} file(s) pulled, ${conflictCount} local conflict(s) archived.`);
            return {
                projectName: project.name,
                pulled: pullCount,
                conflictsArchived: conflictCount,
                errors: errorCount,
            };
        } finally {
            this.socket.disconnect();
        }
    }

    // --- Helpers ---

    private recordMergeConflict(projectPath: string, remoteContent: string): void {
        const snapshotPath = this.stateStore.saveConflictSnapshot(projectPath, remoteContent, 'remote');
        this.setStatus('error');
        logger.error(
            `Merge conflict for ${projectPath}. Local content was kept and the remote snapshot was saved to ${snapshotPath}.`
        );
    }

    private async unjoinDocsUnder(projectPath: string): Promise<void> {
        const prefix = normalizeProjectPath(projectPath);
        const prefixWithSlash = prefix + '/';
        const docs = this.tree.walk((entity) => entity._type === 'doc')
            .filter((entry) => {
                const entryPath = normalizeProjectPath(entry.path);
                return entryPath === prefix || entryPath.startsWith(prefixWithSlash);
            });
        for (const {entity} of docs) {
            if (!this.joinedDocs.has(entity._id)) { continue; }
            try { await this.socket.leaveDoc(entity._id); }
            catch (error) { logger.debug(`Failed to leave ignored doc ${entity._id}:`, error); }
            this.joinedDocs.delete(entity._id);
            this.pendingDocUpdates.delete(entity._id);
            this.docPushInFlight.delete(entity._id);
            this.docPushPendingPaths.delete(entity._id);
            this.clearDocAckTimer(entity._id);
        }
    }

    private async materializeRemoteSubtree(projectPath: string): Promise<void> {
        const prefix = normalizeProjectPath(projectPath);
        const prefixWithSlash = prefix + '/';
        const entries = this.tree.walk(() => true)
            .filter((entry) => {
                const entryPath = normalizeProjectPath(entry.path);
                return entryPath === prefix || entryPath.startsWith(prefixWithSlash);
            })
            .sort((a, b) => a.path.length - b.path.length);

        for (const {entity, path: entryPath} of entries) {
            if (shouldIgnore(entryPath, this.watcher.ignorePatterns)) { continue; }
            if (entity._type === 'folder') {
                const localPath = resolveProjectPath(this.localDir, entryPath);
                if (fs.existsSync(localPath) && !fs.lstatSync(localPath).isDirectory()) {
                    this.stateStore.archiveConflict(entryPath, 'remote folder materialization collided with local content');
                }
                this.ensureDir(localPath);
                this.stateStore.trackPath(entryPath);
            } else if (entity._type === 'doc') {
                const doc = entity as DocumentEntity;
                if (this.joinedDocs.has(doc._id) && doc.remoteCache !== undefined) {
                    const localPath = resolveProjectPath(this.localDir, entryPath);
                    if (fs.existsSync(localPath)) {
                        const localContent = this.readLocalFile(localPath);
                        if (localContent === null || localContent !== doc.remoteCache) {
                            this.stateStore.archiveConflict(
                                entryPath,
                                'remote document materialization collided with local content',
                            );
                        }
                    }
                    this.ensureDir(path.dirname(localPath));
                    this.debounce.setBypassCache(entryPath, doc.remoteCache, 'pull');
                    fs.writeFileSync(localPath, doc.remoteCache, 'utf-8');
                    doc.localCache = doc.remoteCache;
                    this.stateStore.persistDocCache(entryPath, doc.remoteCache);
                    this.stateStore.trackPath(entryPath);
                } else {
                    await this.joinDoc(doc, entryPath, {
                        preserveLocalEdits: true,
                        reason: 'moved out of ignored path',
                    });
                }
            } else if (entity._type === 'file') {
                await this.downloadBinaryFile(entity._id, entryPath);
            }
        }
    }

    private moveStatePath(oldProjectPath: string, newProjectPath: string): void {
        const oldPath = normalizeProjectPath(oldProjectPath);
        const newPath = normalizeProjectPath(newProjectPath);
        const oldPrefix = oldPath + '/';

        for (const [docId, pendingPath] of this.docPushPendingPaths) {
            const normalizedPendingPath = normalizeProjectPath(pendingPath);
            if (normalizedPendingPath === oldPath || normalizedPendingPath.startsWith(oldPrefix)) {
                this.docPushPendingPaths.set(docId, newPath + normalizedPendingPath.slice(oldPath.length));
            }
        }
        this.stateStore.movePath(oldPath, newPath);
    }

    private hasUnsyncedLocalContent(projectPath: string): boolean {
        let localPath: string;
        try {
            localPath = resolveProjectPath(this.localDir, projectPath);
        } catch {
            return true;
        }

        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(localPath);
        } catch {
            return false;
        }
        if (stat.isSymbolicLink()) { return true; }

        const statePath = normalizeProjectPath(projectPath);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(localPath, {withFileTypes: true})) {
                const childPath = `${statePath}/${entry.name}`;
                if (shouldIgnore(childPath, this.watcher.ignorePatterns)) { continue; }
                if (this.hasUnsyncedLocalContent(childPath)) { return true; }
            }
            return false;
        }
        if (!stat.isFile()) { return true; }

        let resolved;
        try {
            resolved = this.tree.resolveByPath(statePath.split('/'));
        } catch {
            return true;
        }
        if (!resolved.fileEntity) { return true; }
        if (resolved.fileType === 'doc') {
            const localContent = this.readLocalFile(localPath);
            const doc = resolved.fileEntity as DocumentEntity;
            return localContent === null || doc.localCache === undefined || localContent !== doc.localCache;
        }
        if (resolved.fileType === 'file') {
            const localContent = this.readLocalBinary(localPath);
            const baseHash = this.stateStore.getBinaryHash(statePath);
            return localContent === null || baseHash === undefined || hashBuffer(localContent) !== baseHash;
        }
        return true;
    }

    private readLocalFile(localPath: string): string | null {
        try {
            const stat = fs.lstatSync(localPath);
            if (!stat.isFile() || stat.isSymbolicLink()) { return null; }
            return fs.readFileSync(localPath, 'utf-8');
        } catch {
            return null;
        }
    }

    private readLocalBinary(localPath: string): Uint8Array | null {
        try {
            const stat = fs.lstatSync(localPath);
            if (!stat.isFile() || stat.isSymbolicLink()) { return null; }
            return new Uint8Array(fs.readFileSync(localPath));
        } catch {
            return null;
        }
    }

    private async ensureRemoteFolderPath(folderParts: string[]): Promise<FolderEntity> {
        const root = this.tree.rootFolder;
        if (!root) {
            throw new Error('Project not loaded');
        }

        let current = root;
        for (const folderName of folderParts) {
            const existing = current.folders.find((f) => f.name === folderName);
            if (existing) {
                current = existing;
                continue;
            }

            try {
                current = await this.ops.createFolder(current, folderName);
            } catch (err) {
                // May have been created concurrently by another local event or remote event.
                const retry = current.folders.find((f) => f.name === folderName);
                if (retry) {
                    current = retry;
                    continue;
                }
                // Server says folder exists but tree doesn't have it yet —
                // the concurrent addDir handler's tree update may be pending.
                if (err instanceof Error && err.message.includes('already exists')) {
                    await new Promise(r => setTimeout(r, 1000));
                    const delayed = current.folders.find((f) => f.name === folderName);
                    if (delayed) {
                        current = delayed;
                        continue;
                    }
                }
                throw err;
            }
        }
        return current;
    }

    private ensureDir(dir: string) {
        fs.mkdirSync(dir, {recursive: true});
    }
}
