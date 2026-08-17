import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    loadFileHashes,
    loadTrackedPaths,
    saveFileHashes,
    saveTrackedPaths,
} from '../config';
import { logger } from '../utils/logger';
import { normalizeProjectPath, resolveProjectPath } from '../utils/paths';

function writeFileAtomic(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, content, 'utf-8');
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        try { fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
        throw error;
    }
}

export class SyncStateStore {
    private readonly cacheDir: string;
    private readonly fileHashes: Record<string, string>;
    private readonly trackedPaths: Set<string>;

    constructor(private readonly localDir: string) {
        this.cacheDir = resolveProjectPath(localDir, '.overleaf-cli-cache');
        this.fileHashes = loadFileHashes(localDir);
        this.trackedPaths = new Set(loadTrackedPaths(localDir));
    }

    getBinaryHash(projectPath: string): string | undefined {
        return this.fileHashes[normalizeProjectPath(projectPath)];
    }

    trackPath(projectPath: string, binaryHash?: string): void {
        const statePath = normalizeProjectPath(projectPath);
        if (!statePath) { return; }
        this.trackedPaths.add(statePath);
        if (binaryHash === undefined) {
            delete this.fileHashes[statePath];
        } else {
            this.fileHashes[statePath] = binaryHash;
        }
        this.persist();
    }

    untrackPath(projectPath: string, recursive: boolean): void {
        const statePath = normalizeProjectPath(projectPath);
        const prefix = statePath + '/';
        for (const trackedPath of Array.from(this.trackedPaths)) {
            if (trackedPath === statePath || (recursive && trackedPath.startsWith(prefix))) {
                this.trackedPaths.delete(trackedPath);
            }
        }
        for (const hashPath of Object.keys(this.fileHashes)) {
            if (hashPath === statePath || (recursive && hashPath.startsWith(prefix))) {
                delete this.fileHashes[hashPath];
            }
        }
        this.persist();
    }

    movePath(oldProjectPath: string, newProjectPath: string): void {
        const oldPath = normalizeProjectPath(oldProjectPath);
        const newPath = normalizeProjectPath(newProjectPath);
        const oldPrefix = oldPath + '/';

        const movedTrackedPaths: string[] = [];
        for (const trackedPath of Array.from(this.trackedPaths)) {
            if (trackedPath === oldPath || trackedPath.startsWith(oldPrefix)) {
                this.trackedPaths.delete(trackedPath);
                movedTrackedPaths.push(newPath + trackedPath.slice(oldPath.length));
            }
        }
        for (const movedPath of movedTrackedPaths) { this.trackedPaths.add(movedPath); }

        const movedHashes: Array<[string, string]> = [];
        for (const [hashPath, hash] of Object.entries(this.fileHashes)) {
            if (hashPath === oldPath || hashPath.startsWith(oldPrefix)) {
                delete this.fileHashes[hashPath];
                movedHashes.push([newPath + hashPath.slice(oldPath.length), hash]);
            }
        }
        for (const [movedPath, hash] of movedHashes) { this.fileHashes[movedPath] = hash; }

        const oldCachePath = resolveProjectPath(this.cacheDir, oldPath);
        const newCachePath = resolveProjectPath(this.cacheDir, newPath);
        if (fs.existsSync(oldCachePath)) {
            fs.mkdirSync(path.dirname(newCachePath), {recursive: true});
            fs.rmSync(newCachePath, {recursive: true, force: true});
            fs.renameSync(oldCachePath, newCachePath);
        }
        this.persist();
    }

    persistDocCache(projectPath: string, content: string): void {
        try {
            const cachePath = resolveProjectPath(this.cacheDir, projectPath);
            writeFileAtomic(cachePath, content);
        } catch (error) {
            logger.debug(`Failed to persist merge base for ${projectPath}:`, error);
        }
    }

    readDocCache(projectPath: string): string | null {
        try {
            return fs.readFileSync(resolveProjectPath(this.cacheDir, projectPath), 'utf-8');
        } catch {
            return null;
        }
    }

    removeDocCache(projectPath: string): void {
        try {
            fs.rmSync(resolveProjectPath(this.cacheDir, projectPath), {recursive: true, force: true});
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                logger.debug(`Failed to remove merge base for ${projectPath}:`, error);
            }
        }
    }

    archiveConflict(projectPath: string, reason: string): string {
        const statePath = normalizeProjectPath(projectPath);
        const sourcePath = resolveProjectPath(this.localDir, statePath);
        const conflictRoot = resolveProjectPath(this.localDir, '.overleaf-cli-conflicts');
        const conflictId = [
            new Date().toISOString().replace(/[:.]/g, '-'),
            process.pid,
            crypto.randomBytes(4).toString('hex'),
        ].join('-');
        const destinationPath = resolveProjectPath(conflictRoot, `${conflictId}/${statePath}`);
        fs.mkdirSync(path.dirname(destinationPath), {recursive: true});
        fs.renameSync(sourcePath, destinationPath);
        logger.warn(`Preserved local conflict at ${destinationPath} (${reason})`);
        return destinationPath;
    }

    saveConflictSnapshot(projectPath: string, content: string, label: string): string {
        const statePath = normalizeProjectPath(projectPath);
        const conflictRoot = resolveProjectPath(this.localDir, '.overleaf-cli-conflicts');
        const conflictId = [
            new Date().toISOString().replace(/[:.]/g, '-'),
            process.pid,
            crypto.randomBytes(4).toString('hex'),
        ].join('-');
        const destinationPath = resolveProjectPath(
            conflictRoot,
            `${conflictId}/${statePath}.${normalizeProjectPath(label)}`,
        );
        writeFileAtomic(destinationPath, content);
        logger.warn(`Saved conflict snapshot at ${destinationPath}`);
        return destinationPath;
    }

    private persist(): void {
        saveTrackedPaths(this.localDir, Array.from(this.trackedPaths));
        saveFileHashes(this.localDir, this.fileHashes);
    }
}
