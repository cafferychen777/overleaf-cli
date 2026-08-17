/* eslint-disable @typescript-eslint/naming-convention */
import { promisify } from 'util';
import { BaseAPI } from './base';
import {
    Identity, DocumentEntity, FileRefEntity,
    FolderEntity, ProjectEntity, UpdateSchema, EventsHandler,
    OnlineUserSchema,
} from './types';
import { logger } from '../utils/logger';
import { decodeSocketText } from '../utils/socket-text';

const DEFAULT_SOCKET_TIMEOUT_MS = 20000;
const SOCKET_TIMEOUT_MS = (() => {
    const parsed = Number(process.env.OVERLEAF_CLI_SOCKET_TIMEOUT_MS);
    if (!Number.isFinite(parsed) || parsed < 1000) { return DEFAULT_SOCKET_TIMEOUT_MS; }
    return Math.floor(parsed);
})();

export class SocketIOAPI {
    private socket: any;
    private emit: any;
    private projectRecord: Promise<ProjectEntity>;
    private docRpcChain: Promise<void> = Promise.resolve();
    private connectionPublicId?: string;
    private connectionAcceptedHandler?: (publicId: string) => void;

    constructor(
        private readonly api: BaseAPI,
        private readonly identity: Identity,
        private readonly projectId: string,
    ) {
        const query = `?projectId=${this.projectId}&t=${Date.now()}`;
        this.socket = this.api._initSocketV0(this.identity, query);

        // Promisified emit with configurable timeout.
        // 5s is too aggressive for large docs and unstable networks.
        this.socket.emit[promisify.custom] = (event: string, ...args: any[]) => {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error(`Socket RPC timeout: ${event}`)),
                    SOCKET_TIMEOUT_MS,
                );
                try {
                    this.socket.emit(event, ...args, (err: unknown, ...data: unknown[]) => {
                        clearTimeout(timer);
                        err ? reject(err) : resolve(data);
                    });
                } catch (error) {
                    clearTimeout(timer);
                    reject(error);
                }
            });
        };
        this.emit = promisify(this.socket.emit).bind(this.socket);

        // Server sends joinProjectResponse with project data on connect
        this.projectRecord = new Promise((resolve, reject) => {
            this.socket.on('joinProjectResponse', (res: any) => {
                if (!res?.project || typeof res.publicId !== 'string') {
                    reject(new Error('Invalid joinProject response from server.'));
                    return;
                }
                this.connectionPublicId = res.publicId;
                this.connectionAcceptedHandler?.(res.publicId);
                resolve(res.project as ProjectEntity);
            });
        });

        this.initInternalHandlers();
    }

    private initInternalHandlers() {
        this.socket.on('connect', () => logger.debug('SocketIO: connected'));
        this.socket.on('connect_failed', () => logger.error('SocketIO: connect_failed'));
        this.socket.on('forceDisconnect', (msg: string) => logger.warn('SocketIO: forceDisconnect', msg));
        this.socket.on('error', (err: any) => logger.error('SocketIO: error', err));
    }

    disconnect() {
        this.connectionAcceptedHandler = undefined;
        this.socket.disconnect();
    }

    updateEventHandlers(handlers: EventsHandler) {
        if (handlers.onFileCreated) {
            const h = handlers.onFileCreated;
            this.socket.on('reciveNewDoc', (fid: string, doc: DocumentEntity) => h(fid, 'doc', doc));
            this.socket.on('reciveNewFile', (fid: string, file: FileRefEntity) => h(fid, 'file', file));
            this.socket.on('reciveNewFolder', (fid: string, folder: FolderEntity) => h(fid, 'folder', folder));
        }
        if (handlers.onFileRenamed) {
            const h = handlers.onFileRenamed;
            this.socket.on('reciveEntityRename', (eid: string, name: string) => h(eid, name));
        }
        if (handlers.onFileRemoved) {
            const h = handlers.onFileRemoved;
            this.socket.on('removeEntity', (eid: string) => h(eid));
        }
        if (handlers.onFileMoved) {
            const h = handlers.onFileMoved;
            this.socket.on('reciveEntityMove', (eid: string, fid: string) => h(eid, fid));
        }
        if (handlers.onFileChanged) {
            const h = handlers.onFileChanged;
            this.socket.on('otUpdateApplied', (update: UpdateSchema) => h(update));
        }
        if (handlers.onDisconnected) {
            const h = handlers.onDisconnected;
            this.socket.on('disconnect', () => h());
        }
        if (handlers.onConnectionAccepted) {
            this.connectionAcceptedHandler = handlers.onConnectionAccepted;
            if (this.connectionPublicId !== undefined) {
                handlers.onConnectionAccepted(this.connectionPublicId);
            }
        }
    }

    async joinProject(): Promise<ProjectEntity> {
        return this.withTimeout(this.projectRecord, 10000, 'joinProject');
    }

    async joinDoc(docId: string) {
        return this.enqueueDocRpc(async () => {
            const [docLinesAscii, version, updates, ranges] = await this.emit('joinDoc', docId, {encodeRanges: true}) as
                [string[], number, any[], any];
            const docLines = docLinesAscii.map(decodeSocketText);
            return {docLines, version, updates, ranges};
        });
    }

    async leaveDoc(docId: string) {
        await this.enqueueDocRpc(async () => {
            await this.emit('leaveDoc', docId);
        });
    }

    async applyOtUpdate(docId: string, update: UpdateSchema) {
        await this.enqueueDocRpc(async () => {
            await this.emit('applyOtUpdate', docId, update);
        });
    }

    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        const [users] = await this.emit('clientTracking.getConnectedUsers') as [OnlineUserSchema[]];
        return users;
    }

    private enqueueDocRpc<T>(task: () => Promise<T>): Promise<T> {
        const run = this.docRpcChain.then(task, task);
        this.docRpcChain = run.then(() => undefined, () => undefined);
        return run;
    }

    private withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Socket timeout: ${operation}`)),
                timeoutMs,
            );
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }
}
