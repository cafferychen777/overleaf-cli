import { BaseAPI } from '../api/base';
import { saveServerIdentity } from '../config';
import { logger } from '../utils/logger';
import { DEFAULT_SERVER_URL } from '../constants';
import { normalizeServerUrl } from '../utils/paths';

export async function loginFromEnv(serverUrl: string = DEFAULT_SERVER_URL) {
    const cookies = process.env.OVERLEAF_COOKIE;
    if (cookies) {
        return loginWithCookies(cookies, serverUrl);
    }

    const email = process.env.OVERLEAF_EMAIL;
    const password = process.env.OVERLEAF_PASSWORD;
    if (email && password) {
        return loginWithPassword(email, password, serverUrl);
    }

    throw new Error(
        'Set OVERLEAF_COOKIE, or set both OVERLEAF_EMAIL and OVERLEAF_PASSWORD, before logging in.'
    );
}

export async function loginWithCookies(cookies: string, serverUrl: string = DEFAULT_SERVER_URL) {
    serverUrl = normalizeServerUrl(serverUrl);
    logger.info(`Logging in to ${serverUrl} with cookies...`);
    const api = new BaseAPI(serverUrl);
    const res = await api.cookiesLogin(cookies);

    if (res.type === 'success' && res.identity) {
        saveServerIdentity(serverUrl, res.identity, res.userInfo);
        logger.info('Login successful.');
        return res;
    } else {
        logger.error(`Login failed: ${res.message}`);
        throw new Error(res.message || 'Login failed');
    }
}

export async function loginWithPassword(email: string, password: string, serverUrl: string = DEFAULT_SERVER_URL) {
    serverUrl = normalizeServerUrl(serverUrl);
    logger.info(`Logging in to ${serverUrl} with email/password...`);
    const api = new BaseAPI(serverUrl);
    const res = await api.passportLogin(email, password);

    if (res.type === 'success' && res.identity) {
        saveServerIdentity(serverUrl, res.identity, res.userInfo);
        logger.info('Login successful.');
        return res;
    } else {
        logger.error(`Login failed: ${res.message}`);
        throw new Error(res.message || 'Login failed');
    }
}
