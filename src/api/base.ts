/* eslint-disable @typescript-eslint/naming-convention */
import * as http from 'http';
import * as https from 'https';
import * as stream from 'stream';
const FormData = require('form-data');
import fetch, {RequestInit, Response} from 'node-fetch';
import {
    Identity, ResponseSchema, FileEntity, FolderEntity,
    CompileResponseSchema, ProjectSettingsSchema,
    FileType, MemberEntity, ProjectInviteEntity,
    SharePrivilegeLevel,
    ProjectHistoryUpdatesSchema, ProjectHistoryFileDiffSchema,
    ProjectHistoryTreeDiffSchema, RestoredHistoryFileEntity,
} from './types';

const DEFAULT_HTTP_TIMEOUT_MS = 30000;
const HTTP_TIMEOUT_MS = (() => {
    const parsed = Number(process.env.OVERLEAF_CLI_HTTP_TIMEOUT_MS);
    if (!Number.isFinite(parsed) || parsed < 1000) { return DEFAULT_HTTP_TIMEOUT_MS; }
    return Math.floor(parsed);
})();

export function mergeCookieHeader(existing: string, setCookieHeaders: string[]): string {
    const cookies = new Map<string, string>();
    for (const segment of existing.split(';')) {
        const cookie = segment.trim();
        const separator = cookie.indexOf('=');
        if (separator <= 0) { continue; }
        cookies.set(cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim());
    }
    for (const header of setCookieHeaders) {
        const cookie = header.split(';', 1)[0].trim();
        const separator = cookie.indexOf('=');
        if (separator <= 0) { continue; }
        cookies.set(cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim());
    }
    return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

export class BaseAPI {
    private url: string;
    private agent: http.Agent | https.Agent;
    private identity?: Identity;

    constructor(url: string) {
        this.url = url.endsWith('/') ? url : url + '/';
        this.agent = new URL(this.url).protocol === 'http:'
            ? new http.Agent({keepAlive: true})
            : new https.Agent({keepAlive: true});
    }

    private fetch(url: string, init: RequestInit): Promise<Response> {
        return fetch(url, {...init, timeout: HTTP_TIMEOUT_MS});
    }

    private async getCsrfToken(): Promise<Identity> {
        const res = await this.fetch(this.url + 'login', {
            method: 'GET', redirect: 'manual', agent: this.agent,
        });
        const body = await res.text();
        const match = body.match(/<input.*name="_csrf".*value="([^"]*)">/);
        if (!match) {
            throw new Error('Failed to get CSRF token.');
        }
        const csrfToken = match[1];
        const setCookies = res.headers.raw()['set-cookie'] ?? [];
        const cookies = mergeCookieHeader('', setCookies);
        if (!cookies) {
            throw new Error('No session cookie received from server.');
        }
        return {csrfToken, cookies};
    }

    private async getUserId(cookies: string) {
        const res = await this.fetch(this.url + 'project', {
            method: 'GET', redirect: 'manual', agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': cookies,
            }
        });
        const body = await res.text();
        const userIDMatch = body.match(/<meta\s+name="ol-user_id"\s+content="([^"]*)">/);
        const userEmailMatch = body.match(/<meta\s+name="ol-usersEmail"\s+content="([^"]*)">/);
        const csrfTokenMatch = body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)">/);
        if (userIDMatch !== null && csrfTokenMatch !== null) {
            const userId = userIDMatch[1];
            const csrfToken = csrfTokenMatch[1];
            const userEmail = userEmailMatch ? userEmailMatch[1] : '';
            return {userId, userEmail, csrfToken};
        }
        return undefined;
    }

    _initSocketV0(identity: Identity, query?: string) {
        const url = new URL(this.url).origin + (query ?? '');
        return (require('socket.io-client').connect as any)(url, {
            reconnect: false,
            'force new connection': true,
            extraHeaders: {
                'Origin': new URL(this.url).origin,
                'Cookie': identity.cookies,
            }
        });
    }

    async passportLogin(email: string, password: string): Promise<ResponseSchema> {
        const identity = await this.getCsrfToken();
        const res = await this.fetch(this.url + 'login', {
            method: 'POST', redirect: 'manual', agent: this.agent,
            headers: {
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Content-Type': 'application/json',
                'Cookie': identity.cookies,
                'X-Csrf-Token': identity.csrfToken,
            },
            body: JSON.stringify({_csrf: identity.csrfToken, email, password})
        });

        if (res.status === 302) {
            const location = res.headers.get('location') || '';
            if (location === '/project' || location.endsWith('/project')) {
                const setCookies = res.headers.raw()['set-cookie'] ?? [];
                if (setCookies.length === 0) {
                    return {type: 'error', message: 'Login succeeded but no session cookie received'};
                }
                const cookies = mergeCookieHeader(identity.cookies, setCookies);
                return await this.cookiesLogin(cookies);
            }
            return {type: 'error', message: location ? `Redirected to ${location}` : 'Unexpected 302 response'};
        } else if (res.status === 200) {
            return {type: 'error', message: (await res.json() as any).message.message};
        } else if (res.status === 401) {
            return {type: 'error', message: (await res.json() as any).message.text};
        } else {
            return {type: 'error', message: `${res.status}: ` + await res.text()};
        }
    }

    async cookiesLogin(cookies: string): Promise<ResponseSchema> {
        const res = await this.getUserId(cookies);
        if (res) {
            const {userId, userEmail, csrfToken} = res;
            const identity: Identity = await this.updateCookies({cookies, csrfToken});
            return {
                type: 'success',
                userInfo: {userId, userEmail},
                identity,
            };
        }
        return {type: 'error', message: 'Failed to get User ID.'};
    }

    async updateCookies(identity: Identity) {
        const res = await this.fetch(this.url + 'socket.io/socket.io.js', {
            method: 'GET', redirect: 'manual', agent: this.agent,
            headers: {
                'Connection': 'keep-alive',
                'Cookie': identity.cookies,
            }
        });
        const header = res.headers.raw()['set-cookie'];
        if (header !== undefined && header.length > 0) {
            identity.cookies = mergeCookieHeader(identity.cookies, header);
        }
        return identity;
    }

    setIdentity(identity: Identity) {
        this.identity = identity;
        return this;
    }

    protected async request(
        type: 'GET' | 'POST' | 'PUT' | 'DELETE',
        route: string,
        body?: FormData | object,
        callback?: (res?: string) => object | undefined,
        extraHeaders?: object
    ): Promise<ResponseSchema> {
        if (this.identity === undefined) { return Promise.reject(new Error('Not authenticated')); }

        let res = undefined;
        switch (type) {
            case 'GET':
                res = await this.fetch(this.url + route, {
                    method: 'GET', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        ...extraHeaders
                    }
                });
                break;
            case 'POST': {
                const isFormData = body instanceof FormData;
                const content_type = isFormData ? undefined : {'Content-Type': 'application/json'};
                res = await this.fetch(this.url + route, {
                    method: 'POST', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        ...content_type,
                        ...extraHeaders
                    },
                    body: isFormData
                        ? (body as NodeJS.ReadableStream)
                        : JSON.stringify({_csrf: this.identity.csrfToken, ...body}),
                });
                break;
            }
            case 'PUT':
                res = await this.fetch(this.url + route, {
                    method: 'PUT', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        'Content-Type': 'application/json',
                        ...extraHeaders
                    },
                    body: JSON.stringify({_csrf: this.identity.csrfToken, ...body}),
                });
                break;
            case 'DELETE':
                res = await this.fetch(this.url + route, {
                    method: 'DELETE', redirect: 'manual', agent: this.agent,
                    headers: {
                        'Connection': 'keep-alive',
                        'Cookie': this.identity.cookies,
                        'X-Csrf-Token': this.identity.csrfToken,
                        ...extraHeaders
                    }
                });
                break;
        }

        if (res && res.status >= 200 && res.status < 300) {
            const _res = (res.status === 204 || res.status === 205) ? undefined : await res.text();
            const response = callback && callback(_res);
            return {type: 'success', ...response} as ResponseSchema;
        } else {
            res = res || {status: 'undefined', text: () => ''};
            return {type: 'error', message: `${res.status}: ` + await res.text()};
        }
    }

    protected async download(route: string) {
        if (this.identity === undefined) { return Promise.reject(new Error('Not authenticated')); }

        const content: Buffer[] = [];
        const MAX_CHUNKS = 1000;
        let nextOffset = 0;
        let totalSize: number | undefined;

        for (let i = 0; i < MAX_CHUNKS; i++) {
            const res = await this.fetch(this.url + route, {
                method: 'GET', redirect: 'manual', agent: this.agent,
                headers: {
                    'Connection': 'keep-alive',
                    'Cookie': this.identity.cookies,
                    'Accept-Encoding': 'identity',
                    ...(nextOffset > 0 ? {'Range': `bytes=${nextOffset}-`} : {}),
                },
            });
            if (res.status === 200) {
                if (nextOffset > 0) {
                    throw new Error(`Download server ignored byte range at offset ${nextOffset}: ${route}`);
                }
                content.push(await res.buffer());
                return Buffer.concat(content);
            } else if (res.status === 206) {
                const contentRange = res.headers.get('content-range');
                const match = contentRange?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
                if (!match) {
                    throw new Error(`Download returned an invalid Content-Range header: ${route}`);
                }
                const start = Number(match[1]);
                const end = Number(match[2]);
                const declaredTotal = match[3] === '*' ? undefined : Number(match[3]);
                const chunk = await res.buffer();
                if (start !== nextOffset || end < start || chunk.length !== end - start + 1) {
                    throw new Error(`Download returned a non-contiguous byte range: ${contentRange}`);
                }
                if (totalSize !== undefined && declaredTotal !== undefined && declaredTotal !== totalSize) {
                    throw new Error(`Download size changed while reading: ${route}`);
                }
                totalSize = declaredTotal ?? totalSize;
                content.push(chunk);
                nextOffset = end + 1;
                if (totalSize !== undefined && nextOffset === totalSize) {
                    return Buffer.concat(content, totalSize);
                }
                if (totalSize !== undefined && nextOffset > totalSize) {
                    throw new Error(`Download exceeded declared size ${totalSize}: ${route}`);
                }
            } else {
                throw new Error(`Download failed: ${res.status} ${route}: ${await res.text()}`);
            }
        }
        throw new Error(`Download incomplete after ${MAX_CHUNKS} chunks: ${route}`);
    }

    async userProjectsJson(identity: Identity): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('GET', 'user/projects', undefined, (res) => {
            const projects = (JSON.parse(res!) as any).projects as any[];
            projects.forEach(project => {
                project.id = project._id;
                delete project._id;
            });
            return {projects};
        });
    }

    async getProjectsJson(identity: Identity): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('POST', 'api/project', {}, (res) => {
            const projects = (JSON.parse(res!) as any).projects;
            return {projects};
        });
    }

    async createProject(identity: Identity, projectName: string): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('POST', 'project/new', {projectName}, (res) => {
            const {project_id} = JSON.parse(res!) as any;
            return {projectId: project_id};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async getFile(identity: Identity, projectId: string, fileId: string) {
        this.setIdentity(identity);
        const content = await this.download(`project/${projectId}/file/${fileId}`);
        return {
            type: 'success' as const,
            content: new Uint8Array(content),
        };
    }

    async addDoc(identity: Identity, projectId: string, parentFolderId: string, filename: string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/doc`, {parent_folder_id: parentFolderId, name: filename}, (res) => {
            const {_id} = JSON.parse(res!) as any;
            const entity = {_type: 'doc', _id, name: filename} as FileEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async uploadFile(identity: Identity, projectId: string, parentFolderId: string, filename: string, fileContent: Uint8Array) {
        const fileStream = stream.Readable.from(Buffer.from(fileContent));
        const formData = new FormData() as any;
        const mimeType = require('mime-types').lookup(filename);
        formData.append('targetFolderId', parentFolderId);
        formData.append('name', filename);
        formData.append('type', mimeType ? mimeType : 'text/plain');
        formData.append('qqfile', fileStream, {filename});

        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/upload?folder_id=${parentFolderId}`, formData, (res) => {
            const {success, entity_id, entity_type} = JSON.parse(res!) as any;
            if (!success || typeof entity_id !== 'string' || !entity_id) {
                throw new Error('Upload response did not contain a valid file entity.');
            }
            const entity = {_type: entity_type, _id: entity_id, name: filename} as FileEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async addFolder(identity: Identity, projectId: string, folderName: string, parentFolderId: string) {
        const body = {name: folderName, parent_folder_id: parentFolderId};
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/folder`, body, (res) => {
            const entity = JSON.parse(res!) as FolderEntity;
            return {entity};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async deleteEntity(identity: Identity, projectId: string, fileType: FileType, fileId: string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/${fileType}/${fileId}`);
    }

    async renameEntity(identity: Identity, projectId: string, entityType: string, entityId: string, name: string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/rename`,
            {name}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async moveEntity(identity: Identity, projectId: string, entityType: string, entityId: string, newParentFolderId: string) {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/${entityType}/${entityId}/move`,
            {folder_id: newParentFolderId}, undefined, {'X-Csrf-Token': identity.csrfToken});
    }

    async compile(identity: Identity, projectId: string, rootDoc_id: string | null,
        draft: boolean = false, stopOnFirstError: boolean = false, compiler?: string,
    ) {
        const body: Record<string, any> = {
            check: 'silent',
            draft,
            incrementalCompilesEnabled: true,
            rootDoc_id,
            stopOnFirstError,
        };
        if (compiler) { body.compiler = compiler; }
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/compile?auto_compile=true`, body, (res) => {
            const compile = JSON.parse(res!) as CompileResponseSchema;
            return {compile};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async deleteAuxFiles(identity: Identity, projectId: string) {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/output`);
    }

    async getFileFromClsi(identity: Identity, url: string, _compileGroup: string) {
        url = url.replace(/^\/+/g, '');
        this.setIdentity(identity);
        const content = await this.download(url);
        return {
            type: 'success' as const,
            content: new Uint8Array(content),
        };
    }

    async getProjectSettings(identity: Identity, projectId: string) {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}`, undefined, (res) => {
            const body = res || '';
            const learnedWordsMatch = /<meta\s+name="ol-learnedWords"\s+data-type="json"\s+content="(\[.*?\])">/.exec(body);
            const learnedWords = (learnedWordsMatch !== null) ? JSON.parse(learnedWordsMatch[1].replace(/&quot;/g, '"')) : [];
            const languagesMatch = /<meta\s+name="ol-languages"\s+data-type="json"\s+content="(\[.*?\])">/.exec(body);
            const languages = (languagesMatch !== null) ? JSON.parse(languagesMatch[1].replace(/&quot;/g, '"')) as {code: string; name: string}[] : [];
            const compilers = [
                {code: 'pdflatex', name: 'pdfLaTex'},
                {code: 'latex', name: 'LaTex'},
                {code: 'xelatex', name: 'XeLaTex'},
                {code: 'lualatex', name: 'LuaLaTex'},
            ];
            const settings = {learnedWords, languages, compilers} as ProjectSettingsSchema;
            return {settings};
        });
    }

    async getHistoryUpdates(identity: Identity, projectId: string, minCount: number = 20, before?: number): Promise<ResponseSchema> {
        this.setIdentity(identity);
        const query = new URLSearchParams({min_count: String(minCount)});
        if (before !== undefined) {
            query.set('before', String(before));
        }
        return this.request('GET', `project/${projectId}/updates?${query.toString()}`, undefined, (res) => {
            const historyUpdates = JSON.parse(res!) as ProjectHistoryUpdatesSchema;
            return {historyUpdates};
        });
    }

    async getHistoryFileDiff(identity: Identity, projectId: string, pathname: string, from: number, to: number): Promise<ResponseSchema> {
        this.setIdentity(identity);
        const query = new URLSearchParams({
            pathname,
            from: String(from),
            to: String(to),
        });
        return this.request('GET', `project/${projectId}/diff?${query.toString()}`, undefined, (res) => {
            const historyFileDiff = JSON.parse(res!) as ProjectHistoryFileDiffSchema;
            return {historyFileDiff};
        });
    }

    async getHistoryTreeDiff(identity: Identity, projectId: string, from: number, to: number): Promise<ResponseSchema> {
        this.setIdentity(identity);
        const query = new URLSearchParams({
            from: String(from),
            to: String(to),
        });
        return this.request('GET', `project/${projectId}/filetree/diff?${query.toString()}`, undefined, (res) => {
            const historyTreeDiff = JSON.parse(res!) as ProjectHistoryTreeDiffSchema;
            return {historyTreeDiff};
        });
    }

    async downloadHistoryVersionZip(identity: Identity, projectId: string, version: number): Promise<ResponseSchema> {
        this.setIdentity(identity);
        const content = await this.download(`project/${projectId}/version/${version}/zip`);
        return {
            type: 'success' as const,
            content: new Uint8Array(content),
        };
    }

    async restoreHistoryFile(
        identity: Identity,
        projectId: string,
        pathname: string,
        version: number,
        docId?: string,
    ): Promise<ResponseSchema> {
        this.setIdentity(identity);
        const body: Record<string, string | number> = {
            pathname,
            version,
        };
        if (docId) {
            body.doc_id = docId;
        }
        return this.request('POST', `project/${projectId}/restore_file`, body, (res) => {
            const restoredHistoryFile = JSON.parse(res!) as RestoredHistoryFileEntity;
            return {restoredHistoryFile};
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async getProjectMembers(identity: Identity, projectId: string): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/members`, undefined, (res) => {
            const members = (JSON.parse(res!) as {members: MemberEntity[]}).members;
            return {members};
        });
    }

    async getProjectInvites(identity: Identity, projectId: string): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('GET', `project/${projectId}/invites`, undefined, (res) => {
            const invites = (JSON.parse(res!) as {invites: ProjectInviteEntity[]}).invites;
            return {invites};
        });
    }

    async inviteProjectMember(
        identity: Identity,
        projectId: string,
        email: string,
        privileges: Exclude<SharePrivilegeLevel, 'owner'>,
    ): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/invite`, {email, privileges}, (res) => {
            const body = JSON.parse(res!) as {
                invite?: ProjectInviteEntity | null;
                error?: string;
                errorReason?: string;
                message?: {text?: string};
            };
            if (body.invite) {
                return {invite: body.invite};
            }
            if (body.error === 'cannot_invite_self') {
                throw new Error('Cannot invite yourself to the project.');
            }
            if (body.error === 'cannot_invite_non_user') {
                throw new Error('This server only allows invites to existing users.');
            }
            if (body.errorReason === 'invalid_email') {
                throw new Error('Invalid email address.');
            }
            throw new Error(body.message?.text || body.errorReason || body.error || 'Invite rejected by the server.');
        }, {'X-Csrf-Token': identity.csrfToken});
    }

    async revokeProjectInvite(identity: Identity, projectId: string, inviteId: string): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/invite/${inviteId}`);
    }

    async resendProjectInvite(identity: Identity, projectId: string, inviteId: string): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('POST', `project/${projectId}/invite/${inviteId}/resend`, {}, undefined, {
            'X-Csrf-Token': identity.csrfToken,
        });
    }

    async updateProjectMemberPrivilege(
        identity: Identity,
        projectId: string,
        userId: string,
        privilegeLevel: Exclude<SharePrivilegeLevel, 'owner'>,
    ): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('PUT', `project/${projectId}/users/${userId}`, {privilegeLevel}, undefined, {
            'X-Csrf-Token': identity.csrfToken,
        });
    }

    async removeProjectMember(identity: Identity, projectId: string, userId: string): Promise<ResponseSchema> {
        this.setIdentity(identity);
        return this.request('DELETE', `project/${projectId}/users/${userId}`);
    }
}
