import { BaseAPI } from '../api/base';
import { SocketIOAPI } from '../api/socketio';
import { RemoteTree } from './remote-tree';
import { MergeConflictError, threeWayMerge } from './merge';
import {
    Identity, DocumentEntity, FileEntity, FileType, FolderEntity,
    UpdateSchema,
} from '../api/types';
import { logger } from '../utils/logger';

/**
 * Local→remote operations with unified exception error model.
 * Callers never check res.type — failures are always exceptions.
 *
 * Tree consistency: the tree always reflects remote reality.
 * - createDoc inserts into tree as soon as addDoc succeeds (even if
 *   subsequent joinDoc/applyOtUpdate fails), because the entity exists
 *   on remote. Callers handle uninitialized docs via joinedDocs checks.
 * - All other methods update tree only on full success.
 */
export class RemoteOperations {
    constructor(
        private api: BaseAPI,
        private socket: SocketIOAPI,
        private tree: RemoteTree,
        private identity: Identity,
        private projectId: string,
    ) {}

    /** Create a text doc on remote, push content via OT. Returns the initialized doc. */
    async createDoc(
        parentFolder: FolderEntity,
        fileName: string,
        content: string,
        opts?: { leaveAfter?: boolean; onUpdate?: (update: UpdateSchema) => void },
    ): Promise<DocumentEntity> {
        const res = await this.api.addDoc(this.identity, this.projectId, parentFolder._id, fileName);
        if (res.type !== 'success' || !res.entity) {
            throw new Error(`createDoc failed: ${res.message}`);
        }
        const doc = res.entity as DocumentEntity;
        doc._type = 'doc';

        // Insert immediately — addDoc succeeded so entity exists on remote.
        // Tree must always reflect remote reality; callers handle uninitialized docs
        // by checking joinedDocs before calling updateDoc.
        this.tree.insertEntity(parentFolder, 'doc', doc);

        let joined = false;
        try {
            const {docLines, version} = await this.socket.joinDoc(doc._id);
            joined = true;
            doc.version = version;
            doc.localCache = docLines.join('\n');
            doc.remoteCache = doc.localCache;
            doc.lastVersion = version;

            if (content.length > 0) {
                const result = threeWayMerge(doc, content);
                if (result?.update.op?.length) {
                    await this.socket.applyOtUpdate(doc._id, result.update);
                    doc.localCache = result.mergedContent;
                    // remoteCache advances only after the server echo confirms
                    // the update. This keeps incoming concurrent OT positions
                    // relative to a confirmed snapshot.
                    doc.lastVersion = doc.version;
                    opts?.onUpdate?.(result.update);
                }
            }

            if (opts?.leaveAfter) {
                await this.socket.leaveDoc(doc._id);
            }
            return doc;
        } catch (err) {
            if (joined) {
                try { await this.socket.leaveDoc(doc._id); } catch { /* best-effort cleanup */ }
            }
            throw err;
        }
    }

    /** Upload a new binary file to remote. Returns the created entity. */
    async uploadBinary(
        parentFolder: FolderEntity,
        fileName: string,
        content: Uint8Array,
    ): Promise<FileEntity> {
        const res = await this.api.uploadFile(this.identity, this.projectId, parentFolder._id, fileName, content);
        if (res.type !== 'success' || !res.entity) {
            throw new Error(`uploadBinary failed: ${res.message}`);
        }
        res.entity._type = 'file';
        this.tree.insertEntity(parentFolder, 'file', res.entity);
        return res.entity;
    }

    /** Update an existing binary file on remote (re-upload). */
    async updateBinary(
        parentFolder: FolderEntity,
        fileName: string,
        content: Uint8Array,
    ): Promise<void> {
        const res = await this.api.uploadFile(this.identity, this.projectId, parentFolder._id, fileName, content);
        if (res.type !== 'success') {
            throw new Error(`updateBinary failed: ${res.message}`);
        }
    }

    /** Three-way merge + OT push for an already-joined doc. */
    async updateDoc(doc: DocumentEntity, content: string): Promise<{
        updated: boolean;
        pushedUpdate?: UpdateSchema;
        hasConflict?: boolean;
    }> {
        const result = threeWayMerge(doc, content);
        if (result?.update.op?.length) {
            if (result.hasConflict) {
                logger.warn('Merge conflict detected; automatic push stopped');
                throw new MergeConflictError();
            }
            await this.socket.applyOtUpdate(doc._id, result.update);
            doc.localCache = result.mergedContent;
            // Don't update remoteCache here — it must reflect the server's
            // confirmed state. Incoming collaborator OT ops are positioned
            // relative to remoteCache; optimistically advancing it causes
            // ops to be applied at wrong byte offsets. The caller replays
            // our ops onto remoteCache after the server ack arrives.
            doc.lastVersion = doc.version;
            return {
                updated: true,
                pushedUpdate: result.update,
                hasConflict: result.hasConflict,
            };
        }
        return {updated: false};
    }

    /** Create a folder on remote. Returns the created entity. */
    async createFolder(
        parentFolder: FolderEntity,
        folderName: string,
    ): Promise<FolderEntity> {
        const res = await this.api.addFolder(this.identity, this.projectId, folderName, parentFolder._id);
        if (res.type !== 'success' || !res.entity) {
            throw new Error(`createFolder failed: ${res.message}`);
        }
        this.tree.insertEntity(parentFolder, 'folder', res.entity);
        return res.entity as FolderEntity;
    }

    /** Delete an entity on remote. Only removes from tree on success. */
    async deleteEntity(
        parentFolder: FolderEntity,
        fileType: FileType,
        entity: FileEntity,
    ): Promise<void> {
        const res = await this.api.deleteEntity(this.identity, this.projectId, fileType, entity._id);
        if (res.type !== 'success') {
            throw new Error(`deleteEntity failed: ${res.message}`);
        }
        this.tree.removeEntity(parentFolder, fileType, entity);
    }
}
