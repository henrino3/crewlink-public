const test = require('node:test');
const assert = require('node:assert/strict');

const { app } = require('../server');

let server;
let baseUrl;

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => null);

  return {
    status: response.status,
    body: payload
  };
}

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

test('moderator CRUD uses owner/mod roles and protects the last owner', async () => {
  let result = await request('/api/crews/enterprise/moderators');
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.moderators.map((moderator) => ({
      name: moderator.name,
      role: moderator.role
    })),
    [{ name: 'Ada', role: 'owner' }]
  );

  result = await request('/api/crews/enterprise/moderators', {
    method: 'POST',
    body: {
      agent_name: 'Ada',
      moderator_name: 'Spock',
      role: 'moderator'
    }
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.moderator.name, 'Spock');
  assert.equal(result.body.moderator.role, 'mod');

  result = await request('/api/crews/enterprise/moderators/Spock');
  assert.equal(result.status, 200);
  assert.equal(result.body.moderator.role, 'mod');

  result = await request('/api/crews/enterprise/moderators', {
    method: 'POST',
    body: {
      agent_name: 'Ada',
      moderator_name: 'Spock',
      role: 'mod'
    }
  });
  assert.equal(result.status, 409);

  result = await request('/api/crews/enterprise/moderators/Spock', {
    method: 'PUT',
    body: {
      agent_name: 'Ada',
      role: 'owner'
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.moderator.role, 'owner');

  result = await request('/api/crews/enterprise/moderators/Ada', {
    method: 'PUT',
    body: {
      agent_name: 'Ada',
      role: 'mod'
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.moderator.role, 'mod');

  result = await request('/api/crews/enterprise/moderators/Spock', {
    method: 'DELETE',
    body: {
      agent_name: 'Spock'
    }
  });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /last crew owner/i);

  result = await request('/api/crews/enterprise/moderators', {
    method: 'POST',
    body: {
      agent_name: 'Spock',
      moderator_name: 'Scotty',
      role: 'mod'
    }
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.moderator.role, 'mod');

  result = await request('/api/crews/enterprise/moderators/Scotty', {
    method: 'DELETE',
    body: {
      agent_name: 'Spock'
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);

  result = await request('/api/crews/enterprise/moderators/Scotty');
  assert.equal(result.status, 404);
});
