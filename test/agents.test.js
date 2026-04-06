const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');

const { app, db, constants } = require('../server');

let server;
let baseUrl;

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function cleanupUploadedAvatars() {
  await dbRun('UPDATE agents SET avatar_url = NULL');
  await fs.rm(constants.avatarUploadDir, { recursive: true, force: true });
}

function createAvatarFormData({ size = 32, type = 'image/png', filename = 'avatar.png' } = {}) {
  const formData = new FormData();
  formData.set('file', new Blob([Buffer.alloc(size, 1)], { type }), filename);
  return formData;
}

function toPublicFilePath(avatarUrl) {
  return path.join(__dirname, '..', 'public', avatarUrl.replace(/^\//, ''));
}

async function request(path, { method = 'GET', body, formData } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: formData || (body ? JSON.stringify(body) : undefined)
  });

  const payload = await response.json().catch(() => null);

  return {
    status: response.status,
    body: payload
  };
}

test.before(async () => {
  await cleanupUploadedAvatars();

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await cleanupUploadedAvatars();

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

test.afterEach(async () => {
  await cleanupUploadedAvatars();
});

test('agent profiles can update description and metadata together', async () => {
  const result = await request('/api/agents/Ada', {
    method: 'PATCH',
    body: {
      description: 'Coordinates launches and partner conversations.',
      metadata: {
        website: 'https://example.com/ada',
        focus: ['sales', 'orchestration']
      }
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.name, 'Ada');
  assert.equal(result.body.bio, 'Coordinates launches and partner conversations.');
  assert.equal(result.body.description, 'Coordinates launches and partner conversations.');
  assert.deepEqual(result.body.metadata, {
    website: 'https://example.com/ada',
    focus: ['sales', 'orchestration']
  });

  const listResult = await request('/api/agents');
  assert.equal(listResult.status, 200);

  const updatedAda = listResult.body.find((agent) => agent.name === 'Ada');
  assert.ok(updatedAda);
  assert.equal(updatedAda.description, 'Coordinates launches and partner conversations.');
  assert.deepEqual(updatedAda.metadata, {
    website: 'https://example.com/ada',
    focus: ['sales', 'orchestration']
  });
});

test('agent profile patch preserves untouched fields and supports clearing metadata', async () => {
  let result = await request('/api/agents/Spock', {
    method: 'PATCH',
    body: {
      metadata: {
        expertise: 'analysis'
      }
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.bio, 'Logical analysis and operations');
  assert.equal(result.body.description, 'Logical analysis and operations');
  assert.deepEqual(result.body.metadata, { expertise: 'analysis' });

  result = await request('/api/agents/spock', {
    method: 'PATCH',
    body: {
      metadata: null
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.description, 'Logical analysis and operations');
  assert.equal(result.body.metadata, null);
});

test('agent profile patch rejects unsupported payloads', async () => {
  let result = await request('/api/agents/Scotty', {
    method: 'PATCH',
    body: {}
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /description or metadata is required/i);

  result = await request('/api/agents/Scotty', {
    method: 'PATCH',
    body: {
      metadata: ['builder']
    }
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /metadata must be an object or null/i);

  result = await request('/api/agents/Scotty', {
    method: 'PATCH',
    body: {
      role: 'Captain'
    }
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /only description and metadata can be updated/i);
});

test('agent profile patch returns 404 for unknown agents', async () => {
  const result = await request('/api/agents/Unknown', {
    method: 'PATCH',
    body: {
      description: 'Missing profile'
    }
  });

  assert.equal(result.status, 404);
  assert.match(result.body.error, /agent not found/i);
});

test('agent avatar upload stores an allowed image and returns the updated profile', async () => {
  const result = await request('/api/agents/Ada/avatar', {
    method: 'POST',
    formData: createAvatarFormData()
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.name, 'Ada');
  assert.match(result.body.avatar_url, /^\/uploads\/avatars\/ada-\d+-[a-f0-9]+\.png$/i);

  await assert.doesNotReject(fs.access(toPublicFilePath(result.body.avatar_url)));

  const listResult = await request('/api/agents');
  assert.equal(listResult.status, 200);

  const updatedAda = listResult.body.find((agent) => agent.name === 'Ada');
  assert.ok(updatedAda);
  assert.equal(updatedAda.avatar_url, result.body.avatar_url);
});

test('agent avatar upload rejects missing files, unsupported types, and oversized files', async () => {
  let result = await request('/api/agents/Spock/avatar', {
    method: 'POST',
    formData: new FormData()
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /file field is required/i);

  result = await request('/api/agents/Spock/avatar', {
    method: 'POST',
    formData: createAvatarFormData({
      type: 'text/plain',
      filename: 'avatar.txt'
    })
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /jpeg, png, gif, or webp/i);

  result = await request('/api/agents/Spock/avatar', {
    method: 'POST',
    formData: createAvatarFormData({
      size: constants.maxAvatarSizeBytes + 1
    })
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /500kb or smaller/i);
});

test('agent avatar upload returns 404 for unknown agents', async () => {
  const result = await request('/api/agents/Unknown/avatar', {
    method: 'POST',
    formData: createAvatarFormData({
      type: 'image/webp',
      filename: 'avatar.webp'
    })
  });

  assert.equal(result.status, 404);
  assert.match(result.body.error, /agent not found/i);
});
