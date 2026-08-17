import * as path from 'path';
import { BaseAPI } from '../api/base';
import { getServerIdentity, saveProjectConfig, loadProjectConfig } from '../config';
import { pushProject } from './push';
import { logger } from '../utils/logger';
import { DEFAULT_SERVER_URL } from '../constants';
import { normalizeServerUrl } from '../utils/paths';

/**
 * Create a new Overleaf project from a local directory.
 *
 * 1. Creates an empty project on Overleaf via the API.
 * 2. Writes .overleaf-cli.json to link local dir ↔ remote project.
 * 3. Pushes all local files to the new project.
 *
 * This is the inverse of pull: pull downloads remote → local,
 * init uploads local → remote.
 */
export async function initProject(
    localDir: string,
    projectName: string,
    serverUrl: string = DEFAULT_SERVER_URL,
): Promise<string> {
    const resolvedDir = path.resolve(localDir);
    serverUrl = normalizeServerUrl(serverUrl);

    // Guard: don't overwrite an existing sync config
    const existing = loadProjectConfig(resolvedDir);
    if (existing) {
        throw new Error(
            `Directory already linked to Overleaf project "${existing.projectName}" (${existing.projectId}). ` +
            `Use 'overleaf-cli push' to update, or delete .overleaf-cli.json to re-init.`
        );
    }

    const identity = getServerIdentity(serverUrl);
    if (!identity) {
        throw new Error(`Not logged in to ${serverUrl}. Run 'overleaf-cli login' first.`);
    }

    // Step 1: Create empty project on Overleaf
    const api = new BaseAPI(serverUrl);
    api.setIdentity(identity);
    const res = await api.createProject(identity, projectName);
    if (res.type !== 'success' || !res.projectId) {
        throw new Error(`Failed to create project: ${res.message || 'unknown error'}`);
    }
    const projectId = res.projectId;
    logger.info(`Created Overleaf project "${projectName}" (${projectId})`);

    // Step 2: Write sync config
    saveProjectConfig(resolvedDir, { serverUrl, projectId, projectName });

    // Step 3: Push all local files to the new project
    await pushProject(resolvedDir);

    return projectId;
}
