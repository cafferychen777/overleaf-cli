const assert = require('node:assert/strict');
const test = require('node:test');

const {
  selectPrimaryLogOutput,
  selectPrimaryPdfOutput,
  parseCompiler,
} = require('../out/commands/compile.js');

test('compiler parser accepts supported values only', () => {
  assert.equal(parseCompiler('XeLaTeX'), 'xelatex');
  assert.throws(() => parseCompiler('latex'), /Invalid compiler/);
});

test('compile output selection prefers canonical output artifacts', () => {
  const outputFiles = [
    { path: 'figures/plot.pdf', type: 'pdf', url: '/figures/plot.pdf', build: 'build-1' },
    { path: 'output.pdf', type: 'pdf', url: '/output.pdf', build: 'build-1' },
    { path: 'logs/other.log', type: 'log', url: '/logs/other.log', build: 'build-1' },
    { path: 'output.log', type: 'log', url: '/output.log', build: 'build-1' },
  ];

  assert.equal(selectPrimaryPdfOutput(outputFiles)?.path, 'output.pdf');
  assert.equal(selectPrimaryLogOutput(outputFiles)?.path, 'output.log');
});

test('compile output selection falls back when there is only one candidate', () => {
  const outputFiles = [
    { path: 'custom/build/result.pdf', type: 'pdf', url: '/result.pdf', build: 'build-2' },
    { path: 'custom/build/result.log', type: 'log', url: '/result.log', build: 'build-2' },
  ];

  assert.equal(selectPrimaryPdfOutput(outputFiles)?.path, 'custom/build/result.pdf');
  assert.equal(selectPrimaryLogOutput(outputFiles)?.path, 'custom/build/result.log');
});

test('compile output selection refuses ambiguous non-canonical artifacts', () => {
  const outputFiles = [
    { path: 'figures/a.pdf', type: 'pdf', url: '/a.pdf', build: 'build-3' },
    { path: 'figures/b.pdf', type: 'pdf', url: '/b.pdf', build: 'build-3' },
  ];

  assert.equal(selectPrimaryPdfOutput(outputFiles), undefined);
});
