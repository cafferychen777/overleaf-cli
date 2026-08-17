const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { BaseAPI } = require('../out/api/base.js');
const {
  formatMemberLabel,
  normalizeShareErrorMessage,
  parseShareRole,
  privilegeLevelToRole,
  roleToPrivilegeLevel,
} = require('../out/utils/share.js');

class TestAPI extends BaseAPI {
  withIdentity() {
    this.setIdentity({ cookies: 'sid=test', csrfToken: 'csrf-token' });
    return this;
  }

  requestPublic(type, route, body, callback, extraHeaders) {
    return this.request(type, route, body, callback, extraHeaders);
  }
}

test('share role helpers normalize user-facing roles', () => {
  assert.equal(parseShareRole('viewer'), 'viewer');
  assert.equal(parseShareRole('review'), 'reviewer');
  assert.equal(parseShareRole('read-write'), 'editor');
  assert.equal(roleToPrivilegeLevel('viewer'), 'readOnly');
  assert.equal(roleToPrivilegeLevel('reviewer'), 'review');
  assert.equal(roleToPrivilegeLevel('editor'), 'readAndWrite');
  assert.equal(privilegeLevelToRole('readOnly'), 'viewer');
  assert.equal(privilegeLevelToRole('review'), 'reviewer');
  assert.equal(privilegeLevelToRole('readAndWrite'), 'editor');
  assert.equal(formatMemberLabel({ first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com' }), 'Ada Lovelace <ada@example.com>');
  assert.equal(formatMemberLabel({ first_name: '', last_name: '', email: 'nobody@example.com' }), 'nobody@example.com');
});

test('share error normalization exposes actionable messages', () => {
  assert.equal(
    normalizeShareErrorMessage('400: {"errorReason":"cannot_verify_user_not_robot"}'),
    'This server requires CAPTCHA for project invites, so CLI invite is unavailable. Use the Overleaf web UI for this invite.'
  );
  assert.equal(
    normalizeShareErrorMessage('403: forbidden'),
    'This project sharing action requires owner or admin access.'
  );
  assert.equal(
    normalizeShareErrorMessage('429: too many requests'),
    'Project sharing rate limit exceeded. Try again later.'
  );
});

test('BaseAPI request supports PUT with 201 responses', async () => {
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
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const api = new TestAPI(`http://127.0.0.1:${port}`).withIdentity();

    const response = await api.requestPublic(
      'PUT',
      'project/123/users/user-1',
      { privilegeLevel: 'review' },
      (body) => ({ ok: JSON.parse(body).ok }),
      { 'X-Csrf-Token': 'csrf-token' }
    );

    assert.equal(response.type, 'success');
    assert.equal(response.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'PUT');
    assert.equal(requests[0].url, '/project/123/users/user-1');
    assert.equal(requests[0].headers['x-csrf-token'], 'csrf-token');
    assert.deepEqual(JSON.parse(requests[0].body), {
      _csrf: 'csrf-token',
      privilegeLevel: 'review',
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
