/* eslint-disable @typescript-eslint/naming-convention */

// --- Entity types (from remoteFileSystemProvider.ts) ---

export type FileType = 'doc' | 'file' | 'folder';
export type FolderKey = 'docs' | 'fileRefs' | 'folders';

export const FolderKeys: {[_type: string]: FolderKey} = {
    'folder': 'folders',
    'doc': 'docs',
    'file': 'fileRefs',
};

export interface FileEntity {
    _id: string;
    name: string;
    _type?: FileType;
    readonly?: boolean;
}

export interface DocumentEntity extends FileEntity {
    version?: number;
    mtime?: number;
    lastVersion?: number;
    localCache?: string;
    remoteCache?: string;
}

export interface FileRefEntity extends FileEntity {
    linkedFileData: any;
    created: string;
}

export interface OutputFileEntity extends FileEntity {
    path: string;
    url: string;
    type: string;
    build: string;
}

export interface FolderEntity extends FileEntity {
    docs: Array<DocumentEntity>;
    fileRefs: Array<FileRefEntity>;
    folders: Array<FolderEntity>;
}

export type SharePrivilegeLevel = 'readOnly' | 'readAndWrite' | 'review' | 'owner';

export interface ProjectInviteEntity {
    _id: string;
    email: string;
    privileges: Exclude<SharePrivilegeLevel, 'owner'>;
}

export interface ProjectEntity {
    _id: string;
    name: string;
    rootDoc_id: string;
    rootFolder: Array<FolderEntity>;
    publicAccessLevel: string;
    compiler: string;
    spellCheckLanguage: string;
    deletedDocs: Array<{
        _id: string;
        name: string;
        deletedAt: string;
    }>;
    members: Array<MemberEntity>;
    invites: Array<ProjectInviteEntity>;
    owner: MemberEntity;
    features: {[key: string]: any};
    settings: ProjectSettingsSchema;
}

// --- API types (from base.ts) ---

export interface Identity {
    csrfToken: string;
    cookies: string;
}

export interface MemberEntity {
    _id: string;
    first_name: string;
    last_name?: string;
    email: string;
    privileges?: SharePrivilegeLevel;
    signUpDate?: string;
}

export interface ProjectPersist {
    id: string;
    userId: string;
    name: string;
    lastUpdated?: string;
    lastUpdatedBy?: MemberEntity;
    source?: 'owner' | 'collaborator' | 'readOnly';
    accessLevel: 'owner' | 'collaborator' | 'readOnly';
    archived?: boolean;
    trashed?: boolean;
}

export interface CompileResponseSchema {
    status: 'success' | 'failure' | 'error';
    compileGroup: string;
    outputFiles: Array<OutputFileEntity>;
    stats: {
        'latexmk-errors': number;
        'pdf-size': number;
        'latex-runs': number;
        'latex-runs-with-errors': number;
        'latex-runs-0': number;
        'latex-runs-with-error-0s': number;
    };
    timings: {
        sync: number;
        compile: number;
        output: number;
        compileE2E: number;
    };
    enableHybridPdfDownload: boolean;
}

export interface ProjectHistoryUser {
    id: string;
    first_name: string;
    last_name?: string;
    email: string;
}

export interface ProjectHistoryLabel {
    id: string;
    comment: string;
    version: number;
}

export interface ProjectHistoryUpdate {
    fromV: number;
    toV: number;
    meta: {
        users: ProjectHistoryUser[];
        start_ts: number;
        end_ts: number;
        origin?: {
            kind?: string;
        };
    };
    labels: ProjectHistoryLabel[];
    pathnames: string[];
    project_ops: Array<{
        add?: {pathname: string};
        remove?: {pathname: string};
        atV: number;
    }>;
}

export interface ProjectHistoryUpdatesSchema {
    updates: ProjectHistoryUpdate[];
    nextBeforeTimestamp?: number;
}

export interface ProjectHistoryFileDiffChunk {
    u?: string;
    i?: string;
    d?: string;
}

export interface ProjectHistoryFileDiffSchema {
    diff: ProjectHistoryFileDiffChunk[];
}

export interface ProjectHistoryTreeDiffChange {
    pathname: string;
    newPathname?: string;
    operation?: 'added' | 'removed' | 'edited' | 'renamed';
    editable?: boolean;
}

export interface ProjectHistoryTreeDiffSchema {
    diff: ProjectHistoryTreeDiffChange[];
}

export interface RestoredHistoryFileEntity {
    type: string;
    id: string;
}

export interface ProjectSettingsSchema {
    learnedWords: string[];
    languages: {code: string; name: string}[];
    compilers: {code: string; name: string}[];
}

export interface ResponseSchema {
    type: 'success' | 'error';
    raw?: ArrayBuffer;
    message?: string;
    userInfo?: {userId: string; userEmail: string};
    identity?: Identity;
    projects?: ProjectPersist[];
    projectId?: string;
    members?: MemberEntity[];
    invites?: ProjectInviteEntity[];
    invite?: ProjectInviteEntity;
    entity?: FileEntity;
    entities?: {path: string; type: string}[];
    compile?: CompileResponseSchema;
    historyUpdates?: ProjectHistoryUpdatesSchema;
    historyFileDiff?: ProjectHistoryFileDiffSchema;
    historyTreeDiff?: ProjectHistoryTreeDiffSchema;
    restoredHistoryFile?: RestoredHistoryFileEntity;
    content?: Uint8Array;
}

// --- Socket types (from socketio.ts) ---

export interface UpdateSchema {
    doc: string;
    op?: {
        p: number;
        i?: string;
        d?: string;
        u?: boolean;
    }[];
    v: number;
    lastV?: number;
    hash?: string;
    meta?: {
        source: string;
        ts: number;
        user_id: string;
    };
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId: string, type: FileType, entity: FileEntity) => void;
    onFileRenamed?: (entityId: string, newName: string) => void;
    onFileRemoved?: (entityId: string) => void;
    onFileMoved?: (entityId: string, newParentFolderId: string) => void;
    onFileChanged?: (update: UpdateSchema) => void;
    onDisconnected?: () => void;
    onConnectionAccepted?: (publicId: string) => void;
}

export interface OnlineUserSchema {
    client_age: number;
    client_id: string;
    connected: boolean;
    cursorData?: {
        column: number;
        doc_id: string;
        row: number;
    };
    email: string;
    first_name: string;
    last_name?: string;
    last_updated_at: string;
    user_id: string;
}
