const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { BaseAPI } = require('../out/api/base.js');
const {
  collectHistoryPaths,
  extractHistoryFileContent,
  filterChangedTreeEntries,
  formatRestoredHistoryFileResult,
  formatTreeDiffEntry,
  parseHistoryLimit,
  summarizeHistoryPaths,
} = require('../out/utils/history.js');
const { renderUnifiedDiff } = require('../out/utils/unified-diff.js');

class TestAPI extends BaseAPI {
  withIdentity() {
    this.setIdentity({ cookies: 'sid=test', csrfToken: 'csrf-token' });
    return this;
  }
}

test('history utilities normalize limits, paths, and restored messages', () => {
  const update = {
    pathnames: ['main.tex'],
    project_ops: [
      { add: { pathname: 'figures/plot.pdf' }, atV: 3 },
      { remove: { pathname: 'old.tex' }, atV: 4 },
    ],
  };

  assert.equal(parseHistoryLimit('5'), 5);
  assert.throws(() => parseHistoryLimit('0'), /positive integer/);
  assert.deepEqual(collectHistoryPaths(update), ['figures/plot.pdf', 'main.tex', 'old.tex']);
  assert.equal(summarizeHistoryPaths(update, 2), 'figures/plot.pdf, main.tex (+1 more)');
  assert.equal(
    formatRestoredHistoryFileResult({ type: 'doc', id: '123' }, '/main restored.tex'),
    'Restored file created on Overleaf: /main restored.tex'
  );
});

test('history diff helpers keep only changed entries and extract file content', () => {
  const entries = [
    { pathname: 'main.tex', operation: 'edited' },
    { pathname: 'references.bib', editable: true },
    { pathname: 'old.tex', operation: 'renamed', newPathname: 'new.tex' },
  ];
  const diff = {
    diff: [
      { u: 'before' },
      { i: 'ignored insert chunk' },
    ],
  };

  assert.deepEqual(filterChangedTreeEntries(entries), [
    { pathname: 'main.tex', operation: 'edited' },
    { pathname: 'old.tex', operation: 'renamed', newPathname: 'new.tex' },
  ]);
  assert.equal(extractHistoryFileContent(diff), 'before');
  assert.equal(
    formatTreeDiffEntry({ pathname: 'old.tex', operation: 'renamed', newPathname: 'new.tex' }),
    'renamed  old.tex -> new.tex'
  );
});

test('renderUnifiedDiff emits unified diff headers and changed lines', () => {
  const rendered = renderUnifiedDiff('main.tex', 'old line\nsame\n', 'new line\nsame\n', {
    oldLabel: 'v1',
    newLabel: 'v3',
  });

  assert.match(rendered, /diff v1\/v3 main\.tex/);
  assert.match(rendered, /--- v1/);
  assert.match(rendered, /\+\+\+ v3/);
  assert.match(rendered, /-old line/);
  assert.match(rendered, /\+new line/);
});

test('BaseAPI history routes encode pathnames and restore body correctly', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });

      if (req.url.startsWith('/project/123/version/7/zip')) {
        res.writeHead(200, { 'Content-Type': 'application/zip' });
        res.end(Buffer.from('PK\x03\x04'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/project/123/restore_file')) {
        res.end(JSON.stringify({ type: 'doc', id: 'restored-doc' }));
      } else if (req.url.startsWith('/project/123/filetree/diff')) {
        res.end(JSON.stringify({ diff: [{ pathname: 'main.tex', operation: 'edited' }] }));
      } else if (req.url.startsWith('/project/123/diff')) {
        res.end(JSON.stringify({ diff: [{ u: 'snapshot' }] }));
      } else if (req.url.startsWith('/project/123/updates')) {
        res.end(JSON.stringify({ updates: [] }));
      } else {
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const identity = { cookies: 'sid=test', csrfToken: 'csrf-token' };
    const api = new TestAPI(`http://127.0.0.1:${port}`).withIdentity();

    const updates = await api.getHistoryUpdates(identity, '123', 15, 999);
    const fileDiff = await api.getHistoryFileDiff(identity, '123', 'sections/intro.tex', 1, 3);
    const treeDiff = await api.getHistoryTreeDiff(identity, '123', 1, 3);
    const restored = await api.restoreHistoryFile(identity, '123', 'sections/intro.tex', 3, 'doc-1');
    const archive = await api.downloadHistoryVersionZip(identity, '123', 7);

    assert.equal(updates.type, 'success');
    assert.equal(fileDiff.type, 'success');
    assert.equal(treeDiff.type, 'success');
    assert.equal(restored.type, 'success');
    assert.equal(restored.restoredHistoryFile.id, 'restored-doc');
    assert.equal(archive.type, 'success');
    assert.equal(Buffer.from(archive.content).toString('binary'), 'PK\x03\x04');

    assert.equal(requests[0].url, '/project/123/updates?min_count=15&before=999');
    assert.equal(requests[1].url, '/project/123/diff?pathname=sections%2Fintro.tex&from=1&to=3');
    assert.equal(requests[2].url, '/project/123/filetree/diff?from=1&to=3');
    assert.equal(requests[3].url, '/project/123/restore_file');
    assert.deepEqual(JSON.parse(requests[3].body), {
      _csrf: 'csrf-token',
      pathname: 'sections/intro.tex',
      version: 3,
      doc_id: 'doc-1',
    });
    assert.equal(requests[4].url, '/project/123/version/7/zip');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
