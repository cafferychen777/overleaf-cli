import { BaseAPI } from '../api/base';
import { getServerIdentity } from '../config';
import { DEFAULT_SERVER_URL } from '../constants';
import { normalizeServerUrl } from '../utils/paths';

export async function listProjects(serverUrl: string = DEFAULT_SERVER_URL) {
    serverUrl = normalizeServerUrl(serverUrl);
    const identity = getServerIdentity(serverUrl);
    if (!identity) {
        throw new Error(`Not logged in to ${serverUrl}. Run 'overleaf-cli login' first.`);
    }

    const api = new BaseAPI(serverUrl);
    let res = await api.getProjectsJson(identity);
    if (res.type === 'error') {
        res = await api.userProjectsJson(identity);
    }

    if (res.type === 'success' && res.projects) {
        return res.projects;
    }

    throw new Error(res.message || 'Failed to list projects');
}
