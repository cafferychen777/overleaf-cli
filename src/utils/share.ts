import { MemberEntity, SharePrivilegeLevel } from '../api/types';

export type ShareRole = 'viewer' | 'reviewer' | 'editor';

const ROLE_TO_PRIVILEGE: Record<ShareRole, Exclude<SharePrivilegeLevel, 'owner'>> = {
    viewer: 'readOnly',
    reviewer: 'review',
    editor: 'readAndWrite',
};

const PRIVILEGE_TO_ROLE: Record<SharePrivilegeLevel, 'viewer' | 'reviewer' | 'editor' | 'owner'> = {
    readOnly: 'viewer',
    review: 'reviewer',
    readAndWrite: 'editor',
    owner: 'owner',
};

export function parseShareRole(input: string): ShareRole {
    const normalized = input.trim().toLowerCase();
    switch (normalized) {
        case 'viewer':
        case 'view':
        case 'read-only':
        case 'readonly':
        case 'read_only':
        case 'read':
            return 'viewer';
        case 'reviewer':
        case 'review':
            return 'reviewer';
        case 'editor':
        case 'edit':
        case 'read-write':
        case 'readandwrite':
        case 'read_and_write':
        case 'write':
            return 'editor';
        default:
            throw new Error(`Invalid role "${input}". Use viewer, reviewer, or editor.`);
    }
}

export function roleToPrivilegeLevel(role: ShareRole): Exclude<SharePrivilegeLevel, 'owner'> {
    return ROLE_TO_PRIVILEGE[role];
}

export function privilegeLevelToRole(privilege: SharePrivilegeLevel | string | undefined): string {
    if (!privilege) { return 'unknown'; }
    if (privilege in PRIVILEGE_TO_ROLE) {
        return PRIVILEGE_TO_ROLE[privilege as SharePrivilegeLevel];
    }
    return privilege;
}

export function formatMemberLabel(member: Pick<MemberEntity, 'first_name' | 'last_name' | 'email'>): string {
    const name = [member.first_name, member.last_name].filter(Boolean).join(' ').trim();
    return name ? `${name} <${member.email}>` : member.email;
}

function extractJsonPayload(message: string): Record<string, any> | null {
    const match = message.match(/^\d+:\s*(\{[\s\S]*\})$/);
    if (!match) { return null; }
    try {
        return JSON.parse(match[1]) as Record<string, any>;
    } catch {
        return null;
    }
}

export function isPermissionErrorMessage(message: string): boolean {
    return /^403:/.test(message) || /forbidden|not authorized|admin project/i.test(message);
}

export function normalizeShareErrorMessage(message: string): string {
    const payload = extractJsonPayload(message);
    if (payload?.errorReason === 'cannot_verify_user_not_robot' || /captcha|g-recaptcha/i.test(message)) {
        return 'This server requires CAPTCHA for project invites, so CLI invite is unavailable. Use the Overleaf web UI for this invite.';
    }
    if (payload?.errorReason === 'invalid_email') {
        return 'Invalid email address.';
    }
    if (payload?.error === 'cannot_invite_self' || /cannot invite yourself/i.test(message)) {
        return 'Cannot invite yourself to the project.';
    }
    if (payload?.error === 'cannot_invite_non_user') {
        return 'This server only allows invites to existing users.';
    }
    if (/^429:/.test(message) || /rate limit/i.test(message)) {
        return 'Project sharing rate limit exceeded. Try again later.';
    }
    if (isPermissionErrorMessage(message)) {
        return 'This project sharing action requires owner or admin access.';
    }
    if (/^404:/.test(message)) {
        return 'The requested collaborator or invite was not found.';
    }
    return message;
}
