const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BaseAPI, mergeCookieHeader } = require('../out/api/base.js');
const { SocketIOAPI } = require('../out/api/socketio.js');
const {
  loadFileHashes,
  loadProjectConfig,
  loadTrackedPaths,
  saveProjectConfig,
} = require('../out/config.js');
const { DebounceManager } = require('../out/sync/debounce.js');
const { collectLocalSyncSnapshot } = require('../out/sync/local-snapshot.js');
const {
  applyOtOps,
  mergeRemoteIntoLocalResult,
  MergeConflictError,
  threeWayMerge,
} = require('../out/sync/merge.js');
const { RemoteOperations } = require('../out/sync/remote-ops.js');
const { RemoteTree } = require('../out/sync/remote-tree.js');
const { SyncStateStore } = require('../out/sync/state-store.js');
const { SyncEngine, syncPathQueueKey } = require('../out/sync/engine.js');
const {
  normalizeProjectPath,
  normalizeServerUrl,
  resolveProjectPath,
  sanitizeFileName,
} = require('../out/utils/paths.js');
const { decodeSocketText } = require('../out/utils/socket-text.js');

class DownloadTestAPI extends BaseAPI {
  withIdentity() {
    this.setIdentity({ cookies: 'sid=test', csrfToken: 'csrf-token' });
    return this;
  }

  downloadPublic(route) {
    return this.download(route);
  }
}

class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.disconnected = false;
    this.emit = (event, ...args) => {
      const callback = args.at(-1);
      if (event === 'joinDoc' && typeof callback === 'function') {
        callback(null, ['cafÃ©'], 7, [], []);
      } else if (typeof callback === 'function') {
        callback(null);
      }
    };
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) || [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  trigger(event, ...args) {
    for (const handler of this.handlers.get(event) || []) {
      handler(...args);
    }
  }

  disconnect() {
    this.disconnected = true;
  }
}

function projectFixture() {
  return {
    _id: 'project-1',
    name: 'Project',
    rootDoc_id: 'doc-1',
    rootFolder: [{
      _id: 'root',
      name: 'root',
      docs: [{ _id: 'doc-1', name: 'main.tex' }],
      fileRefs: [],
      folders: [],
    }],
    publicAccessLevel: 'private',
    compiler: 'pdflatex',
    spellCheckLanguage: 'en',
    deletedDocs: [],
    members: [],
    invites: [],
    owner: { _id: 'owner', first_name: 'Owner', email: 'owner@example.com' },
    features: {},
    settings: { learnedWords: [], languages: [], compilers: [] },
  };
}

test('path helpers normalize identities and reject traversal or symlink escapes', (t) => {
  assert.equal(normalizeServerUrl('https://www.overleaf.com/'), 'https://www.overleaf.com');
  assert.equal(normalizeProjectPath('/sections/main.tex/'), 'sections/main.tex');
  assert.throws(() => normalizeProjectPath('../outside.tex'), /Unsafe project path/);
  assert.throws(() => normalizeServerUrl('file:///tmp/overleaf'), /http or https/);
  assert.equal(sanitizeFileName('../Paper / Draft'), '.._Paper _ Draft');
  assert.equal(syncPathQueueKey('/sections/main.tex'), syncPathQueueKey('sections/main.tex'));

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-cli-paths-'));
  t.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
  assert.equal(
    resolveProjectPath(temporaryDir, '/sections/main.tex'),
    path.join(temporaryDir, 'sections', 'main.tex')
  );

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-cli-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  fs.symlinkSync(outsideDir, path.join(temporaryDir, 'linked'));
  assert.throws(() => resolveProjectPath(temporaryDir, 'linked/secret.tex'), /symbolic link/);
});

test('project config and sync state are normalized and written atomically', (t) => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-cli-state-'));
  t.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));

  const projectDir = path.join(temporaryDir, 'new-project');
  saveProjectConfig(projectDir, {
    serverUrl: 'https://www.overleaf.com/',
    projectId: 'project-1',
    projectName: 'Project',
  });
  assert.deepEqual(loadProjectConfig(projectDir), {
    serverUrl: 'https://www.overleaf.com',
    projectId: 'project-1',
    projectName: 'Project',
  });
  assert.deepEqual(
    fs.readdirSync(projectDir).filter((name) => name.endsWith('.tmp')),
    []
  );

  const store = new SyncStateStore(projectDir);
  const binaryContent = Buffer.from([0, 1, 2, 3]);
  store.trackPath('figures');
  store.trackPath('figures/plot.bin', 'binary-hash');
  store.trackPath('sections/main.tex');
  store.persistDocCache('sections/main.tex', 'base content');
  store.movePath('sections', 'chapters');

  assert.deepEqual(loadTrackedPaths(projectDir), ['chapters/main.tex', 'figures', 'figures/plot.bin']);
  assert.deepEqual(loadFileHashes(projectDir), { 'figures/plot.bin': 'binary-hash' });
  assert.equal(
    fs.readFileSync(path.join(projectDir, '.overleaf-cli-cache', 'chapters', 'main.tex'), 'utf8'),
    'base content'
  );
  assert.deepEqual(
    fs.readdirSync(path.join(projectDir, '.overleaf-cli-cache', 'chapters'))
      .filter((name) => name.endsWith('.tmp')),
    []
  );

  fs.writeFileSync(path.join(projectDir, 'local.bin'), binaryContent);
  const archivedPath = store.archiveConflict('local.bin', 'test conflict');
  assert.equal(fs.existsSync(path.join(projectDir, 'local.bin')), false);
  assert.deepEqual(fs.readFileSync(archivedPath), binaryContent);
});

test('local snapshot applies one classification and ignores hidden files and symlinks', (t) => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-cli-snapshot-'));
  t.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temporaryDir, 'sections'));
  fs.writeFileSync(path.join(temporaryDir, 'sections', 'main.tex'), 'text');
  fs.writeFileSync(path.join(temporaryDir, 'plot.bin'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(temporaryDir, '.secret'), 'ignored');
  fs.symlinkSync(path.join(temporaryDir, 'sections', 'main.tex'), path.join(temporaryDir, 'linked.tex'));

  const snapshot = collectLocalSyncSnapshot(temporaryDir, []);
  assert.deepEqual(snapshot.trackedPaths, ['plot.bin', 'sections', 'sections/main.tex']);
  assert.deepEqual(Object.keys(snapshot.binaryHashes), ['plot.bin']);
});

test('socket text decoding preserves direct Unicode and decodes latin1-transported UTF-8', () => {
  assert.equal(decodeSocketText('café'), 'café');
  assert.equal(decodeSocketText('cafÃ©'), 'café');
  assert.equal(decodeSocketText('你好'), '你好');
});

test('cookie merging replaces rotated values without forwarding Set-Cookie attributes', () => {
  assert.equal(
    mergeCookieHeader('session=old; csrf=one', [
      'session=new; Path=/; HttpOnly',
      'socket=two; Path=/',
    ]),
    'session=new; csrf=one; socket=two'
  );
});

test('OT application validates positions and deleted content', () => {
  assert.equal(
    applyOtOps('hello world', [{ p: 6, d: 'world' }, { p: 6, i: 'Overleaf' }]),
    'hello Overleaf'
  );
  assert.throws(() => applyOtOps('hello', [{ p: 1, d: 'x' }]), /delete mismatch/);
  assert.throws(() => applyOtOps('hello', [{ p: 10, i: 'x' }]), /Invalid OT position/);
});

test('overlapping three-way edits stop automatic remote writes', async () => {
  const doc = {
    _id: 'doc-1',
    name: 'main.tex',
    version: 3,
    lastVersion: 3,
    localCache: 'abc',
    remoteCache: 'axc',
  };
  const merge = threeWayMerge(doc, 'ayc');
  assert.equal(merge.hasConflict, true);
  assert.deepEqual(mergeRemoteIntoLocalResult('abc', 'axc', 'ayc'), {
    mergedContent: 'ayc',
    hasConflict: true,
  });

  let updateCount = 0;
  const operations = new RemoteOperations(
    {},
    { applyOtUpdate: async () => { updateCount += 1; } },
    {},
    {},
    'project-1'
  );
  await assert.rejects(() => operations.updateDoc(doc, 'ayc'), MergeConflictError);
  assert.equal(updateCount, 0);
});

test('debounce uses collision-resistant content identities', () => {
  const debounce = new DebounceManager();
  assert.equal(debounce.shouldPropagate('push', '/main.tex', 'Aa'), true);
  assert.equal(debounce.shouldPropagate('push', '/main.tex', 'BB'), true);
  assert.equal(debounce.shouldPropagate('push', '/main.tex', 'BB'), false);
});

test('version-only server echo completes an in-flight document push', async (t) => {
  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-cli-ack-'));
  t.after(() => fs.rmSync(temporaryDir, { recursive: true, force: true }));

  const engine = new SyncEngine({
    serverUrl: 'https://www.overleaf.com',
    projectId: 'project-1',
    localDir: temporaryDir,
    identity: { cookies: 'sid=test', csrfToken: 'csrf-token' },
  });
  const project = projectFixture();
  engine.tree.setProject(project);
  const doc = project.rootFolder[0].docs[0];
  doc.version = 5;
  doc.lastVersion = 5;
  doc.remoteCache = 'before';
  doc.localCache = 'after';
  engine.pendingDocUpdates.set('doc-1', [{ baseVersion: 5, opSig: 'non-empty-update' }]);
  engine.docPushInFlight.add('doc-1');
  engine.docConcurrentOps.set('doc-1', 0);

  await engine.handleRemoteChange({ doc: 'doc-1', v: 5, op: [] });

  assert.equal(doc.version, 6);
  assert.equal(doc.lastVersion, 6);
  assert.equal(doc.remoteCache, 'after');
  assert.equal(engine.docPushInFlight.has('doc-1'), false);
  assert.equal(engine.pendingDocUpdates.has('doc-1'), false);
  assert.equal(
    fs.readFileSync(path.join(temporaryDir, '.overleaf-cli-cache', 'main.tex'), 'utf8'),
    'after'
  );
});

test('remote tree rejects unsafe entity names', () => {
  for (const unsafeName of ['../outside.tex', 'sections/main.tex', 'sections\\main.tex']) {
    const tree = new RemoteTree();
    const project = projectFixture();
    project.rootFolder[0].docs[0].name = unsafeName;
    assert.throws(() => tree.setProject(project), /Invalid remote entity name/);
  }

  const tree = new RemoteTree();
  const project = projectFixture();
  tree.setProject(project);
  const root = project.rootFolder[0];
  assert.throws(
    () => tree.renameEntity(root, root.docs[0], 'sections/main.tex'),
    /Invalid remote entity name/
  );
  assert.equal(root.docs[0].name, 'main.tex');
});

test('SocketIO replays connection identity registered after project join', async () => {
  const fakeSocket = new FakeSocket();
  const api = {
    _initSocketV0: () => fakeSocket,
  };
  const socket = new SocketIOAPI(
    api,
    { cookies: 'sid=test', csrfToken: 'csrf-token' },
    'project-1'
  );

  const joined = socket.joinProject();
  fakeSocket.trigger('joinProjectResponse', { publicId: 'client-123', project: projectFixture() });
  assert.equal((await joined).name, 'Project');

  let publicId;
  socket.updateEventHandlers({ onConnectionAccepted: (value) => { publicId = value; } });
  assert.equal(publicId, 'client-123');

  const doc = await socket.joinDoc('doc-1');
  assert.deepEqual(doc.docLines, ['café']);
  socket.disconnect();
  assert.equal(fakeSocket.disconnected, true);
});

test('BaseAPI assembles validated HTTP byte ranges', async (t) => {
  const ranges = [];
  const server = http.createServer((req, res) => {
    ranges.push(req.headers.range);
    if (!req.headers.range) {
      res.writeHead(206, { 'Content-Range': 'bytes 0-2/6' });
      res.end('abc');
      return;
    }
    assert.equal(req.headers.range, 'bytes=3-');
    res.writeHead(206, { 'Content-Range': 'bytes 3-5/6' });
    res.end('def');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const api = new DownloadTestAPI(`http://127.0.0.1:${address.port}`).withIdentity();
  const content = await api.downloadPublic('artifact');
  assert.equal(content.toString(), 'abcdef');
  assert.deepEqual(ranges, [undefined, 'bytes=3-']);
});

test('BaseAPI rejects semantically failed upload responses', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  const api = new BaseAPI(`http://127.0.0.1:${address.port}`);
  const identity = { cookies: 'sid=test', csrfToken: 'csrf-token' };
  await assert.rejects(
    () => api.uploadFile(identity, 'project-1', 'root', 'plot.bin', Buffer.from([1, 2, 3])),
    /valid file entity/
  );
});
