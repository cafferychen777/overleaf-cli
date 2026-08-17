const DiffMatchPatch = require('diff-match-patch');
import { DocumentEntity, UpdateSchema } from '../api/types';
import { decodeSocketText } from '../utils/socket-text';

const dmp = new DiffMatchPatch();

interface Range {
    start: number;
    end: number;
}

export class MergeConflictError extends Error {
    constructor() {
        super('Concurrent local and remote edits overlap; automatic push was stopped.');
        this.name = 'MergeConflictError';
    }
}

function collectChangedRanges(base: string, next: string): Range[] {
    const diffs = dmp.diff_main(base, next);
    dmp.diff_cleanupEfficiency(diffs);
    const ranges: Range[] = [];
    let cursor = 0;
    for (const [diffType, text] of diffs) {
        if (diffType === 0) {
            cursor += text.length;
            continue;
        }
        if (diffType === -1) {
            ranges.push({start: cursor, end: cursor + text.length});
            cursor += text.length;
            continue;
        }
        if (diffType === 1) {
            ranges.push({start: cursor, end: cursor});
        }
    }
    return ranges;
}

function rangeOverlap(a: Range, b: Range): boolean {
    const aPoint = a.start === a.end;
    const bPoint = b.start === b.end;
    if (aPoint && bPoint) { return a.start === b.start; }
    if (aPoint) { return a.start >= b.start && a.start <= b.end; }
    if (bPoint) { return b.start >= a.start && b.start <= a.end; }
    return a.start < b.end && b.start < a.end;
}

function hasOverlappingEdits(base: string, local: string, remote: string): boolean {
    const localRanges = collectChangedRanges(base, local);
    const remoteRanges = collectChangedRanges(base, remote);
    for (const l of localRanges) {
        for (const r of remoteRanges) {
            if (rangeOverlap(l, r)) { return true; }
        }
    }
    return false;
}

/**
 * Three-way merge: produces OT ops to send to Overleaf.
 * Adapted from remoteFileSystemProvider.ts writeFile (lines 744-793).
 */
export function threeWayMerge(doc: DocumentEntity, newContent: string): {
    update: UpdateSchema;
    mergedContent: string;
    hasConflict: boolean;
} | null {
    if (doc.version === undefined || doc.localCache === undefined || doc.remoteCache === undefined) {
        return null;
    }

    // Apply remote changes to local content
    const patches = dmp.patch_make(doc.localCache, doc.remoteCache);
    const mergeResArray = dmp.patch_apply(patches, newContent);
    const mergeRes = mergeResArray[0] as string;
    const applied = (mergeResArray[1] as boolean[]) || [];
    // Same-base overlapping edits are conflict-prone for patch-based merges
    // and can produce garbled character interleaving.
    const overlapConflict = hasOverlappingEdits(doc.localCache, newContent, doc.remoteCache);
    // When patches fail or overlap exists, preserve local intent.
    const patchConflict = applied.length > 0 && applied.some((ok) => !ok);
    const hasConflict = overlapConflict || patchConflict;
    const mergedContent = hasConflict ? newContent : mergeRes;

    // Build OT ops from remote snapshot to merged content.
    // Fine-grained ops compose better with concurrent collaborators than
    // full-document delete+insert pairs.
    const ops: {p: number; i?: string; d?: string}[] = [];
    const diffs = dmp.diff_main(doc.remoteCache, mergedContent);
    let cursor = 0;
    for (const [diffType, text] of diffs) {
        if (diffType === 0) {
            cursor += text.length;
        } else if (diffType === 1) {
            if (text.length > 0) {
                ops.push({p: cursor, i: text});
                cursor += text.length;
            }
        } else if (diffType === -1) {
            if (text.length > 0) {
                ops.push({p: cursor, d: text});
            }
        }
    }

    const update: UpdateSchema = {
        doc: doc._id,
        lastV: doc.lastVersion,
        v: doc.version,
        op: ops,
    };

    return {update, mergedContent, hasConflict};
}

/**
 * Merge remote changes into local content using three-way merge.
 * base: last known common state (localCache)
 * remote: new remote content (after applying OT ops)
 * local: current local file content (may have pending edits)
 *
 * Returns merged content. On patch failure, preserves local to avoid data loss.
 */
export function mergeRemoteIntoLocal(base: string, remote: string, local: string): string {
    return mergeRemoteIntoLocalResult(base, remote, local).mergedContent;
}

export function mergeRemoteIntoLocalResult(base: string, remote: string, local: string): {
    mergedContent: string;
    hasConflict: boolean;
} {
    if (local === remote) { return {mergedContent: remote, hasConflict: false}; }
    if (local === base) { return {mergedContent: remote, hasConflict: false}; }
    if (remote === base) { return {mergedContent: local, hasConflict: false}; }
    if (hasOverlappingEdits(base, local, remote)) {
        return {mergedContent: local, hasConflict: true};
    }

    // Use line-level diffing for more reliable patch matching in text files.
    // Character-level patches can misalign when surrounding lines are edited
    // concurrently, causing truncation or corruption.
    const lineInfo = dmp.diff_linesToChars_(base, remote);
    const lineDiffs = dmp.diff_main(lineInfo.chars1, lineInfo.chars2, false);
    dmp.diff_charsToLines_(lineDiffs, lineInfo.lineArray);
    const patches = dmp.patch_make(base, lineDiffs);
    const [merged, applied] = dmp.patch_apply(patches, local) as [string, boolean[]];

    if (applied.length > 0 && applied.some((ok: boolean) => !ok)) {
        // Line-level patch failed — fall back to character-level attempt
        const charPatches = dmp.patch_make(base, remote);
        const [charMerged, charApplied] = dmp.patch_apply(charPatches, local) as [string, boolean[]];
        if (charApplied.length > 0 && charApplied.some((ok: boolean) => !ok)) {
            return {mergedContent: local, hasConflict: true};
        }
        return {mergedContent: charMerged, hasConflict: false};
    }
    return {mergedContent: merged, hasConflict: false};
}

/**
 * Apply incoming OT ops to content string.
 * Adapted from remoteFileSystemProvider.ts onFileChanged (lines 420-451).
 */
export function applyOtOps(content: string, ops: {p: number; i?: string; d?: string}[]): string {
    for (const op of ops) {
        if (!Number.isInteger(op.p) || op.p < 0 || op.p > content.length) {
            throw new Error(`Invalid OT position ${op.p} for document length ${content.length}.`);
        }
        const hasInsert = typeof op.i === 'string';
        const hasDelete = typeof op.d === 'string';
        if (hasInsert && hasDelete) {
            throw new Error(`OT operation at position ${op.p} cannot insert and delete simultaneously.`);
        }
        if (hasInsert && op.i) {
            const insertUtf8 = decodeSocketText(op.i);
            content = content.slice(0, op.p) + insertUtf8 + content.slice(op.p);
        } else if (hasDelete && op.d) {
            const deleteUtf8 = decodeSocketText(op.d);
            if (content.slice(op.p, op.p + deleteUtf8.length) !== deleteUtf8) {
                throw new Error(`OT delete mismatch at position ${op.p}.`);
            }
            content = content.slice(0, op.p) + content.slice(op.p + deleteUtf8.length);
        }
    }
    return content;
}
