#!/usr/bin/env node
import { Command } from 'commander';
import { loginFromEnv } from './commands/login';
import { listProjects } from './commands/list';
import { pullProject } from './commands/pull';
import { watchProject } from './commands/watch';
import { compileProject, parseCompiler } from './commands/compile';
import { pushProject } from './commands/push';
import { diffProject } from './commands/diff';
import {
    diffHistoryFile,
    diffProjectHistory,
    exportProjectHistory,
    formatHistoryList,
    formatProjectHistoryDiff,
    listProjectHistory,
    restoreHistoryFile,
} from './commands/history';
import { initProject } from './commands/init';
import {
    formatShareList,
    inviteProjectCollaborator,
    listProjectSharing,
    removeProjectCollaborator,
    resendProjectInvite,
    revokeProjectInvite,
    setProjectCollaboratorRole,
} from './commands/share';
import { setLogLevel, LogLevel } from './utils/logger';
import { parseHistoryLimit } from './utils/history';
import { parseShareRole } from './utils/share';
import { DEFAULT_SERVER_URL } from './constants';

const packageMetadata = require('../package.json') as {version: string};
const program = new Command();

program
    .name('overleaf-cli')
    .description('CLI tool for syncing local files with Overleaf projects')
    .version(packageMetadata.version)
    .option('-v, --verbose', 'Enable verbose logging')
    .hook('preAction', (thisCommand) => {
        if (thisCommand.opts().verbose) {
            setLogLevel(LogLevel.DEBUG);
        }
    });

program
    .command('login')
    .description('Login using credentials from environment variables')
    .option('-s, --server <url>', 'Server URL', DEFAULT_SERVER_URL)
    .action(async (opts) => {
        await loginFromEnv(opts.server);
    });

program
    .command('list')
    .description('List all projects')
    .option('-s, --server <url>', 'Server URL', DEFAULT_SERVER_URL)
    .action(async (opts) => {
        const projects = await listProjects(opts.server);
        if (projects.length === 0) {
            console.log('No projects found.');
            return;
        }
        console.log(`Found ${projects.length} project(s):\n`);
        for (const project of projects) {
            const flags = [
                project.archived ? 'archived' : '',
                project.trashed ? 'trashed' : '',
            ].filter(Boolean).join(', ');
            console.log(
                `  ${project.id}  ${project.name}  [${project.accessLevel}]${flags ? ` (${flags})` : ''}`
            );
        }
    });

program
    .command('pull')
    .description('Pull a project to local directory')
    .argument('<projectId>', 'Project ID')
    .argument('[localDir]', 'Local directory', '.')
    .option('-s, --server <url>', 'Server URL', DEFAULT_SERVER_URL)
    .option('--force', 'Overwrite differing local files without archiving them')
    .action(async (projectId, localDir, opts) => {
        await pullProject(projectId, localDir, opts.server, {force: opts.force});
    });

program
    .command('watch')
    .description('Start real-time bidirectional sync')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .action(watchProject);

program
    .command('compile')
    .description('Trigger compilation and download PDF')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .option('--compiler <compiler>', 'Compiler to use (pdflatex, xelatex, lualatex)', parseCompiler)
    .action(async (localDir, opts) => {
        await compileProject(localDir, opts.compiler);
    });

program
    .command('push')
    .description('Push local changes to Overleaf')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .option('--prune-remote', 'Delete remote files that do not exist locally (destructive mirror mode)')
    .action(async (localDir, opts) => {
        await pushProject(localDir, {pruneRemote: opts.pruneRemote});
    });

program
    .command('diff')
    .description('Show differences between local files and remote Overleaf project')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .action(diffProject);

program
    .command('init')
    .description('Create a new Overleaf project from local directory and push all files')
    .argument('<projectName>', 'New Overleaf project name')
    .argument('[localDir]', 'Local directory to upload', '.')
    .option('-s, --server <url>', 'Server URL', DEFAULT_SERVER_URL)
    .action(async (projectName, localDir, opts) => {
        await initProject(localDir, projectName, opts.server);
    });

const share = program
    .command('share')
    .description('Manage project collaborators and invitations');

share
    .command('list')
    .description('List collaborators and pending invites')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .action(async (localDir) => {
        console.log(formatShareList(await listProjectSharing(localDir)));
    });

share
    .command('invite')
    .description('Invite a collaborator by email')
    .argument('<email>', 'Collaborator email')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .requiredOption('--role <role>', 'Role to grant (viewer, reviewer, editor)', parseShareRole)
    .action(async (email, localDir, opts) => {
        const invite = await inviteProjectCollaborator(localDir, email, opts.role);
        console.log(`Invite sent: ${invite._id}  ${invite.email}  [${opts.role}]`);
    });

share
    .command('revoke')
    .description('Revoke a pending invite')
    .argument('<inviteId>', 'Pending invite ID')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .action(async (inviteId, localDir) => {
        await revokeProjectInvite(localDir, inviteId);
        console.log(`Invite revoked: ${inviteId}`);
    });

share
    .command('resend')
    .description('Resend a pending invite')
    .argument('<inviteId>', 'Pending invite ID')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .action(async (inviteId, localDir) => {
        await resendProjectInvite(localDir, inviteId);
        console.log(`Invite resent: ${inviteId}`);
    });

share
    .command('set-role')
    .description('Change a collaborator role')
    .argument('<userId>', 'Collaborator user ID')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .requiredOption('--role <role>', 'Role to grant (viewer, reviewer, editor)', parseShareRole)
    .action(async (userId, localDir, opts) => {
        await setProjectCollaboratorRole(localDir, userId, opts.role);
        console.log(`Collaborator updated: ${userId}  [${opts.role}]`);
    });

share
    .command('remove')
    .description('Remove a collaborator from the project')
    .argument('<userId>', 'Collaborator user ID')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .action(async (userId, localDir) => {
        await removeProjectCollaborator(localDir, userId);
        console.log(`Collaborator removed: ${userId}`);
    });

const history = program
    .command('history')
    .description('Inspect and recover project history');

history
    .command('list')
    .description('List recent project history versions')
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .option('--limit <count>', 'Number of history entries to load', parseHistoryLimit, 20)
    .action(async (localDir, opts) => {
        console.log(formatHistoryList(await listProjectHistory(localDir, {limit: opts.limit})));
    });

function parseHistoryVersion(value: string): number {
    const version = Number(value);
    if (!Number.isInteger(version) || version < 0) {
        throw new Error('History version must be a non-negative integer.');
    }
    return version;
}

history
    .command('diff')
    .description('Compare two history versions')
    .argument('<fromVersion>', 'Older history version', parseHistoryVersion)
    .argument('<toVersion>', 'Newer history version', parseHistoryVersion)
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .option('--file <path>', 'Compare one text file instead of the whole project')
    .action(async (fromVersion, toVersion, localDir, opts) => {
        if (opts.file) {
            console.log(await diffHistoryFile(localDir, opts.file, fromVersion, toVersion));
            return;
        }
        const entries = await diffProjectHistory(localDir, fromVersion, toVersion);
        console.log(formatProjectHistoryDiff(entries, fromVersion, toVersion));
    });

history
    .command('export')
    .description('Download a project snapshot zip for one history version')
    .argument('<version>', 'History version to export', parseHistoryVersion)
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .option('--output <path>', 'Write zip to a specific output path')
    .action(async (version, localDir, opts) => {
        const outputPath = await exportProjectHistory(localDir, version, opts.output);
        console.log(`History export saved to ${outputPath}`);
    });

history
    .command('restore')
    .description('Restore one file from history as a new file on Overleaf')
    .argument('<version>', 'History version to restore from', parseHistoryVersion)
    .argument('[localDir]', 'Local directory with .overleaf-cli.json', '.')
    .requiredOption('--file <path>', 'Project file path to restore from that version')
    .action(async (version, localDir, opts) => {
        console.log(await restoreHistoryFile(localDir, opts.file, version));
        console.log('Local files are unchanged. Run pull or watch to sync the restored file locally.');
    });

async function main(): Promise<void> {
    await program.parseAsync();
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
