const DiffMatchPatch = require('diff-match-patch');
import { colors } from './colors';
const dmp = new DiffMatchPatch();

const {red: RED, green: GREEN, cyan: CYAN, dim: DIM, bold: BOLD, reset: RESET} = colors;

interface RenderUnifiedDiffOptions {
    oldLabel?: string;
    newLabel?: string;
}

interface HunkLine {
    type: 'context' | 'add' | 'remove';
    text: string;
    oldLine?: number;
    newLine?: number;
}

export function renderUnifiedDiff(
    filePath: string,
    oldText: string,
    newText: string,
    options?: RenderUnifiedDiffOptions,
): string {
    const oldLabel = options?.oldLabel || 'old';
    const newLabel = options?.newLabel || 'new';

    const lines: string[] = [];
    lines.push(`${BOLD}diff ${oldLabel}/${newLabel} ${filePath}${RESET}`);
    lines.push(`${DIM}--- ${oldLabel}${RESET}`);
    lines.push(`${DIM}+++ ${newLabel}${RESET}`);

    const lineInfo = dmp.diff_linesToChars_(oldText, newText);
    const diffs = dmp.diff_main(lineInfo.chars1, lineInfo.chars2, false);
    dmp.diff_charsToLines_(diffs, lineInfo.lineArray);

    let oldLine = 1;
    let newLine = 1;
    const allLines: HunkLine[] = [];

    for (const [diffType, text] of diffs) {
        const diffLines = text.split('\n');
        if (diffLines[diffLines.length - 1] === '') { diffLines.pop(); }

        if (diffType === 0) {
            for (const line of diffLines) {
                allLines.push({type: 'context', text: line, oldLine, newLine});
                oldLine++;
                newLine++;
            }
        } else if (diffType === -1) {
            for (const line of diffLines) {
                allLines.push({type: 'remove', text: line, oldLine});
                oldLine++;
            }
        } else if (diffType === 1) {
            for (const line of diffLines) {
                allLines.push({type: 'add', text: line, newLine});
                newLine++;
            }
        }
    }

    const changeIndices: number[] = [];
    for (let i = 0; i < allLines.length; i++) {
        if (allLines[i].type !== 'context') {
            changeIndices.push(i);
        }
    }

    if (changeIndices.length === 0) {
        return lines.join('\n');
    }

    const CONTEXT = 3;
    const hunks: {start: number; end: number}[] = [];
    let hunkStart = Math.max(0, changeIndices[0] - CONTEXT);
    let hunkEnd = Math.min(allLines.length - 1, changeIndices[0] + CONTEXT);

    for (let i = 1; i < changeIndices.length; i++) {
        const nextStart = Math.max(0, changeIndices[i] - CONTEXT);
        if (nextStart <= hunkEnd + 1) {
            hunkEnd = Math.min(allLines.length - 1, changeIndices[i] + CONTEXT);
        } else {
            hunks.push({start: hunkStart, end: hunkEnd});
            hunkStart = nextStart;
            hunkEnd = Math.min(allLines.length - 1, changeIndices[i] + CONTEXT);
        }
    }
    hunks.push({start: hunkStart, end: hunkEnd});

    for (const hunk of hunks) {
        let oldStart = 0;
        let oldCount = 0;
        let newStart = 0;
        let newCount = 0;

        for (let i = hunk.start; i <= hunk.end; i++) {
            const line = allLines[i];
            if (line.type === 'context' || line.type === 'remove') {
                if (oldStart === 0 && line.oldLine) { oldStart = line.oldLine; }
                oldCount++;
            }
            if (line.type === 'context' || line.type === 'add') {
                if (newStart === 0 && line.newLine) { newStart = line.newLine; }
                newCount++;
            }
        }

        oldStart = oldStart || 1;
        newStart = newStart || 1;
        lines.push(`${CYAN}@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${RESET}`);

        for (let i = hunk.start; i <= hunk.end; i++) {
            const line = allLines[i];
            switch (line.type) {
                case 'context':
                    lines.push(` ${line.text}`);
                    break;
                case 'remove':
                    lines.push(`${RED}-${line.text}${RESET}`);
                    break;
                case 'add':
                    lines.push(`${GREEN}+${line.text}${RESET}`);
                    break;
            }
        }
    }

    return lines.join('\n');
}
