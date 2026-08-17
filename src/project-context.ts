import * as path from 'path';
import { BaseAPI } from './api/base';
import { Identity } from './api/types';
import { getServerIdentity, loadProjectConfig, ProjectConfig } from './config';

export interface ProjectContext {
    localDir: string;
    projectConfig: ProjectConfig;
    identity: Identity;
    api: BaseAPI;
}

export function loadProjectContext(localDir: string): ProjectContext {
    const resolvedDir = path.resolve(localDir);
    const projectConfig = loadProjectConfig(resolvedDir);
    if (!projectConfig) {
        throw new Error(`No .overleaf-cli.json found in ${resolvedDir}. Run 'overleaf-cli pull' first.`);
    }

    const identity = getServerIdentity(projectConfig.serverUrl);
    if (!identity) {
        throw new Error(`Not logged in to ${projectConfig.serverUrl}. Run 'overleaf-cli login' first.`);
    }

    const api = new BaseAPI(projectConfig.serverUrl);
    api.setIdentity(identity);
    return {localDir: resolvedDir, projectConfig, identity, api};
}
