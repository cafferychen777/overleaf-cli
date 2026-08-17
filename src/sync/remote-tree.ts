import {
    FileEntity, FileType, FolderKey, FolderKeys, FolderEntity,
    ProjectEntity,
} from '../api/types';
import { normalizeProjectPath } from '../utils/paths';

export function assertValidEntityName(name: string): void {
    let normalized: string;
    try {
        normalized = normalizeProjectPath(name);
    } catch {
        throw new Error(`Invalid remote entity name: ${JSON.stringify(name)}`);
    }
    if (!normalized || normalized !== name || name.includes('/') || name.includes('\\')) {
        throw new Error(`Invalid remote entity name: ${JSON.stringify(name)}`);
    }
}

function validateFolder(folder: FolderEntity, entityIds: Set<string>): void {
    assertValidEntityName(folder.name);
    if (typeof folder._id !== 'string' || !folder._id) {
        throw new Error(`Invalid remote folder ID: ${folder.name}`);
    }
    if (entityIds.has(folder._id)) { throw new Error(`Duplicate remote entity ID: ${folder._id}`); }
    entityIds.add(folder._id);
    if (!Array.isArray(folder.docs) || !Array.isArray(folder.fileRefs) || !Array.isArray(folder.folders)) {
        throw new Error(`Invalid remote folder payload: ${folder.name}`);
    }
    const childNames = new Set<string>();
    for (const entity of [...folder.docs, ...folder.fileRefs, ...folder.folders]) {
        assertValidEntityName(entity.name);
        if (childNames.has(entity.name)) {
            throw new Error(`Duplicate remote entity name in ${folder.name}: ${entity.name}`);
        }
        childNames.add(entity.name);
        if (typeof entity._id !== 'string' || !entity._id) {
            throw new Error(`Invalid remote entity ID: ${entity.name}`);
        }
    }
    for (const entity of [...folder.docs, ...folder.fileRefs]) {
        if (entityIds.has(entity._id)) { throw new Error(`Duplicate remote entity ID: ${entity._id}`); }
        entityIds.add(entity._id);
    }
    for (const child of folder.folders) {
        validateFolder(child, entityIds);
    }
}

function getChildren(folder: FolderEntity, key: FolderKey): FileEntity[] {
    switch (key) {
        case 'docs': return folder.docs;
        case 'fileRefs': return folder.fileRefs;
        case 'folders': return folder.folders;
    }
}

export class RemoteTree {
    private root?: ProjectEntity;

    get project(): ProjectEntity | undefined {
        return this.root;
    }

    setProject(project: ProjectEntity) {
        if (!Array.isArray(project.rootFolder) || project.rootFolder.length === 0) {
            throw new Error('Remote project has no root folder.');
        }
        validateFolder(project.rootFolder[0], new Set());
        this.root = project;
    }

    get rootFolder(): FolderEntity | undefined {
        return this.root?.rootFolder[0];
    }

    resolveByPath(pathParts: string[]): {
        parentFolder: FolderEntity;
        fileName: string;
        fileEntity?: FileEntity;
        fileType?: FileType;
        fileId?: string;
    } {
        if (!this.root) {
            throw new Error('Project not loaded');
        }

        const normalizedPath = normalizeProjectPath(pathParts.join('/'));
        if (!normalizedPath) { throw new Error('Project path must identify an entity.'); }
        const normalizedParts = normalizedPath.split('/');

        let currentFolder = this.root.rootFolder[0];
        for (let i = 0; i < normalizedParts.length - 1; i++) {
            const folderName = normalizedParts[i];
            const folder = currentFolder.folders.find((f) => f.name === folderName);
            if (folder) {
                currentFolder = folder;
            } else {
                throw new Error(`Folder not found: ${folderName}`);
            }
        }
        const fileName = normalizedParts[normalizedParts.length - 1];

        // resolve file
        for (const _type of Object.keys(FolderKeys)) {
            const key = FolderKeys[_type];
            const entity = getChildren(currentFolder, key).find((e) => e.name === fileName);
            if (entity) {
                return {parentFolder: currentFolder, fileName, fileEntity: entity, fileType: _type as FileType, fileId: entity._id};
            }
        }
        return {parentFolder: currentFolder, fileName};
    }

    resolveById(entityId: string, root?: FolderEntity, path?: string): {
        parentFolder: FolderEntity;
        fileEntity: FileEntity;
        fileType: FileType;
        path: string;
    } | undefined {
        if (!this.root) { return undefined; }
        root = root || this.root.rootFolder[0];
        path = path || '/';

        if (root._id === entityId) {
            return {parentFolder: root, fileType: 'folder', fileEntity: root, path};
        }

        // search files in root
        for (const _type of Object.keys(FolderKeys)) {
            const key = FolderKeys[_type];
            if (key === 'folders') { continue; }
            const entity = getChildren(root, key).find((e) => e._id === entityId);
            if (entity) {
                return {parentFolder: root, fileType: _type as FileType, fileEntity: entity, path: path + entity.name};
            }
        }

        // recursive search
        for (const folder of root.folders) {
            const res = this.resolveById(entityId, folder, path + folder.name + '/');
            if (res) { return res; }
        }
        return undefined;
    }

    walk(filter: (entity: FileEntity) => boolean): {entity: FileEntity; path: string}[] {
        const result: {entity: FileEntity; path: string}[] = [];
        if (!this.root) { return result; }
        const folders: {entity: FolderEntity; path: string}[] = [{entity: this.root.rootFolder[0], path: '/'}];

        if (filter(folders[0].entity)) { result.push(folders[0]); }

        for (const folder of folders) {
            for (const [key, value] of Object.entries(FolderKeys)) {
                if (value === 'folders') {
                    (getChildren(folder.entity, value) as FolderEntity[]).forEach((entity) => {
                        folders.push({entity, path: folder.path + entity.name + '/'});
                    });
                }
                getChildren(folder.entity, value).forEach((entity) => {
                    entity._type = key as FileType;
                    if (filter(entity)) {
                        result.push({entity, path: folder.path + entity.name});
                    }
                });
            }
        }
        return result;
    }

    insertEntity(parentFolder: FolderEntity, fileType: FileType, entity: FileEntity) {
        assertValidEntityName(entity.name);
        if (typeof entity._id !== 'string' || !entity._id) {
            throw new Error(`Invalid remote entity ID: ${entity.name}`);
        }
        if (fileType === 'folder') {
            const folder = entity as FolderEntity;
            if (!Array.isArray(folder.docs) || !Array.isArray(folder.fileRefs) || !Array.isArray(folder.folders)) {
                throw new Error(`Invalid remote folder payload: ${folder.name}`);
            }
        }
        this.assertChildNameAvailable(parentFolder, entity.name, entity._id);
        const key = FolderKeys[fileType];
        const arr = getChildren(parentFolder, key);
        const index = arr.findIndex((e) => e._id === entity._id);
        if (index < 0) {
            arr.push(entity);
        }
    }

    renameEntity(parentFolder: FolderEntity, entity: FileEntity, newName: string): void {
        assertValidEntityName(newName);
        this.assertChildNameAvailable(parentFolder, newName, entity._id);
        entity.name = newName;
    }

    assertChildNameAvailable(parentFolder: FolderEntity, name: string, entityId?: string): void {
        assertValidEntityName(name);
        for (const key of Object.values(FolderKeys)) {
            const conflict = getChildren(parentFolder, key)
                .find((candidate) => candidate.name === name && candidate._id !== entityId);
            if (conflict) {
                throw new Error(`Remote entity name already exists: ${name}`);
            }
        }
    }

    removeEntity(parentFolder: FolderEntity, fileType: FileType, entity: FileEntity): boolean {
        const key = FolderKeys[fileType];
        const arr = getChildren(parentFolder, key);
        const index = arr.findIndex((e) => e._id === entity._id);
        if (index >= 0) {
            arr.splice(index, 1);
            return true;
        }
        return false;
    }
}
