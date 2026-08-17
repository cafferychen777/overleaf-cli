import { BaseAPI } from '../api/base';
import { Identity, MemberEntity, ProjectInviteEntity, ResponseSchema } from '../api/types';
import { loadProjectContext } from '../project-context';
import {
    ShareRole, formatMemberLabel, isPermissionErrorMessage,
    normalizeShareErrorMessage, privilegeLevelToRole, roleToPrivilegeLevel,
} from '../utils/share';

interface ShareContext {
    projectId: string;
    identity: Identity;
    api: BaseAPI;
}

export interface ShareListResult {
    members: MemberEntity[];
    invites?: ProjectInviteEntity[];
    invitesUnavailableReason?: string;
}

function getShareContext(localDir: string): ShareContext {
    const {projectConfig, identity, api} = loadProjectContext(localDir);

    return {
        projectId: projectConfig.projectId,
        identity,
        api,
    };
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toShareError(error: unknown): Error {
    return new Error(normalizeShareErrorMessage(toErrorMessage(error)));
}

function requireField<T>(
    response: ResponseSchema,
    field: T | undefined,
    fallbackMessage: string,
): T {
    if (response.type === 'success' && field !== undefined) {
        return field;
    }
    throw new Error(response.message || fallbackMessage);
}

export async function listProjectSharing(localDir: string): Promise<ShareListResult> {
    const {api, identity, projectId} = getShareContext(localDir);

    try {
        const membersRes = await api.getProjectMembers(identity, projectId);
        const members = requireField(membersRes, membersRes.members, 'Failed to load project collaborators.');

        try {
            const invitesRes = await api.getProjectInvites(identity, projectId);
            const invites = requireField(invitesRes, invitesRes.invites, 'Failed to load project invites.');
            return {members, invites};
        } catch (err) {
            const message = toErrorMessage(err);
            if (isPermissionErrorMessage(message)) {
                return {
                    members,
                    invitesUnavailableReason: 'Pending invites require owner or admin access.',
                };
            }
            throw err;
        }
    } catch (err) {
        throw toShareError(err);
    }
}

export async function inviteProjectCollaborator(localDir: string, email: string, role: ShareRole): Promise<ProjectInviteEntity> {
    const {api, identity, projectId} = getShareContext(localDir);
    try {
        const res = await api.inviteProjectMember(identity, projectId, email, roleToPrivilegeLevel(role));
        return requireField(res, res.invite, 'Failed to create invite.');
    } catch (err) {
        throw toShareError(err);
    }
}

export async function revokeProjectInvite(localDir: string, inviteId: string): Promise<void> {
    const {api, identity, projectId} = getShareContext(localDir);
    try {
        const res = await api.revokeProjectInvite(identity, projectId, inviteId);
        requireField(res, true, 'Failed to revoke invite.');
    } catch (err) {
        throw toShareError(err);
    }
}

export async function resendProjectInvite(localDir: string, inviteId: string): Promise<void> {
    const {api, identity, projectId} = getShareContext(localDir);
    try {
        const res = await api.resendProjectInvite(identity, projectId, inviteId);
        requireField(res, true, 'Failed to resend invite.');
    } catch (err) {
        throw toShareError(err);
    }
}

export async function setProjectCollaboratorRole(localDir: string, userId: string, role: ShareRole): Promise<void> {
    const {api, identity, projectId} = getShareContext(localDir);
    try {
        const res = await api.updateProjectMemberPrivilege(identity, projectId, userId, roleToPrivilegeLevel(role));
        requireField(res, true, 'Failed to update collaborator role.');
    } catch (err) {
        throw toShareError(err);
    }
}

export async function removeProjectCollaborator(localDir: string, userId: string): Promise<void> {
    const {api, identity, projectId} = getShareContext(localDir);
    try {
        const res = await api.removeProjectMember(identity, projectId, userId);
        requireField(res, true, 'Failed to remove collaborator.');
    } catch (err) {
        throw toShareError(err);
    }
}

export function formatShareList(result: ShareListResult): string {
    const lines: string[] = [];

    lines.push(`Collaborators (${result.members.length}):`);
    if (result.members.length === 0) {
        lines.push('  none');
    } else {
        for (const member of result.members) {
            const label = formatMemberLabel(member);
            const role = privilegeLevelToRole(member.privileges);
            lines.push(`  ${member._id}  ${label}  [${role}]`);
        }
    }

    lines.push('');

    if (result.invites) {
        lines.push(`Pending Invites (${result.invites.length}):`);
        if (result.invites.length === 0) {
            lines.push('  none');
        } else {
            for (const invite of result.invites) {
                lines.push(`  ${invite._id}  ${invite.email}  [${privilegeLevelToRole(invite.privileges)}]`);
            }
        }
    } else {
        lines.push('Pending Invites:');
        lines.push(`  unavailable (${result.invitesUnavailableReason || 'unknown reason'})`);
    }

    return lines.join('\n');
}
