import * as path from 'path';
import * as fs from 'fs';
import {
    getServerIdentity, loadProjectConfig, saveProjectConfig, saveFileHashes, saveTrackedPaths,
} from '../config';
import { SyncEngine } from '../sync/engine';
import { loadSyncIgnore } from '../sync/watcher';
import { logger } from '../utils/logger';
import { DEFAULT_SERVER_URL } from '../constants';
import { normalizeServerUrl } from '../utils/paths';
import { collectLocalSyncSnapshot } from '../sync/local-snapshot';

export async function pullProject(
    projectId: string,
    localDir: string,
    serverUrl: string = DEFAULT_SERVER_URL,
    opts?: {force?: boolean},
) {
    serverUrl = normalizeServerUrl(serverUrl);
    const identity = getServerIdentity(serverUrl);
    if (!identity) {
        throw new Error(`Not logged in to ${serverUrl}. Run 'overleaf-cli login' first.`);
    }

    const resolvedLocal = path.resolve(localDir);
    const existingProject = loadProjectConfig(resolvedLocal);
    if (existingProject
        && (existingProject.serverUrl !== serverUrl || existingProject.projectId !== projectId)) {
        throw new Error(
            `Directory is already linked to Overleaf project "${existingProject.projectName}" ` +
            `(${existingProject.projectId}). Use a different directory for project ${projectId}.`
        );
    }

    fs.mkdirSync(resolvedLocal, {recursive: true});

    const engine = new SyncEngine({
        serverUrl,
        projectId,
        localDir: resolvedLocal,
        identity,
    });

    const result = await engine.pullProject({force: opts?.force});

    saveProjectConfig(resolvedLocal, {
        serverUrl,
        projectId,
        projectName: result.projectName,
    });

    // Record binary file hashes so push can skip unchanged files
    const extraIgnore = loadSyncIgnore(resolvedLocal);
    const snapshot = collectLocalSyncSnapshot(resolvedLocal, extraIgnore);
    saveTrackedPaths(resolvedLocal, snapshot.trackedPaths);
    saveFileHashes(resolvedLocal, snapshot.binaryHashes);

    if (result.errors > 0) {
        throw new Error(
            `Pull completed with ${result.errors} error(s). The project link was saved so the command can be retried safely.`
        );
    }
    logger.info(`Project pulled to ${resolvedLocal}`);
}
