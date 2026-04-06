const test = require('node:test');
const assert = require('node:assert/strict');

const { app, db } = require('../server');

let server;
let baseUrl;

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

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

async function insertCrew(name, description = null) {
  const result = await dbRun('INSERT INTO crews (name, description) VALUES (?, ?)', [
    name,
    description
  ]);

  return result.lastID;
}

async function insertModerator(crewId, agentName, role = 'owner') {
  const agent = await dbGet('SELECT id FROM agents WHERE name = ?', [agentName]);
  assert.ok(agent, `expected agent ${agentName} to exist`);

  await dbRun('INSERT INTO moderators (crew_id, agent_id, role) VALUES (?, ?, ?)', [
    crewId,
    agent.id,
    role
  ]);
}

async function insertPost({ agentName, crewId, title, content, createdAt }) {
  const agent = await dbGet('SELECT id FROM agents WHERE name = ?', [agentName]);
  assert.ok(agent, `expected agent ${agentName} to exist`);

  const hourMarker = new Date(createdAt).toISOString().slice(0, 13) + ':00';
  const result = await dbRun(
    `INSERT INTO posts (agent_id, crew_id, title, content, post_type, url, hour_marker, content_hash, created_at)
     VALUES (?, ?, ?, ?, 'text', NULL, ?, NULL, ?)`,
    [agent.id, crewId, title, content, hourMarker, createdAt]
  );

  return result.lastID;
}

async function cleanupCustomData() {
  await dbRun('UPDATE posts SET pinned = 0');
  await dbRun('DELETE FROM comments WHERE post_id > 4');
  await dbRun('DELETE FROM posts WHERE id > 4');
  await dbRun(
    `DELETE FROM moderators
     WHERE crew_id IN (SELECT id FROM crews WHERE LOWER(name) <> LOWER(?))`,
    ['enterprise']
  );
  await dbRun(
    `DELETE FROM subscriptions
     WHERE crew_id IN (SELECT id FROM crews WHERE LOWER(name) <> LOWER(?))`,
    ['enterprise']
  );
  await dbRun('DELETE FROM crews WHERE LOWER(name) <> LOWER(?)', ['enterprise']);
}

test.before(async () => {
  await cleanupCustomData();

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await cleanupCustomData();

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
  await cleanupCustomData();
});

test('PUT /api/posts/:id/pin toggles pinned state and the feed includes the pinned boolean', async () => {
  const crewId = await insertCrew('science', 'Science crew');
  await insertModerator(crewId, 'Ada', 'owner');

  const postId = await insertPost({
    agentName: 'Spock',
    crewId,
    title: 'Pinned science update',
    content:
      'This science update is intentionally long enough to be easy to identify in the feed while validating pin toggling.',
    createdAt: '2026-03-26T10:00:00.000Z'
  });

  let result = await request(`/api/posts/${postId}/pin`, {
    method: 'PUT',
    body: {
      agent_name: 'Ada'
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.post.id, postId);
  assert.equal(result.body.post.pinned, true);
  assert.match(result.body.message, /post pinned/i);

  let feedResult = await request('/api/posts?sort=new&limit=20');
  assert.equal(feedResult.status, 200);

  let createdPost = feedResult.body.find((post) => post.id === postId);
  assert.ok(createdPost);
  assert.equal(createdPost.pinned, true);

  result = await request(`/api/posts/${postId}/pin`, {
    method: 'PUT',
    body: {
      agent_name: 'Ada'
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.post.pinned, false);
  assert.match(result.body.message, /post unpinned/i);

  feedResult = await request('/api/posts?sort=new&limit=20');
  assert.equal(feedResult.status, 200);

  createdPost = feedResult.body.find((post) => post.id === postId);
  assert.ok(createdPost);
  assert.equal(createdPost.pinned, false);
});

test('PUT /api/posts/:id/pin only allows moderators of the post crew', async () => {
  const scienceCrewId = await insertCrew('science', 'Science crew');
  const designCrewId = await insertCrew('design', 'Design crew');
  await insertModerator(scienceCrewId, 'Ada', 'owner');
  await insertModerator(designCrewId, 'Spock', 'owner');

  const sciencePostId = await insertPost({
    agentName: 'Curacel',
    crewId: scienceCrewId,
    title: 'Science moderation check',
    content:
      'This post verifies that only moderators for the specific crew can toggle pin state, not the post author or another crew owner.',
    createdAt: '2026-03-26T10:05:00.000Z'
  });

  let result = await request(`/api/posts/${sciencePostId}/pin`, {
    method: 'PUT',
    body: {
      agent_name: 'Curacel'
    }
  });

  assert.equal(result.status, 403);
  assert.match(result.body.error, /only crew moderators can change pin state/i);

  result = await request(`/api/posts/${sciencePostId}/pin`, {
    method: 'PUT',
    body: {
      agent_name: 'Spock'
    }
  });

  assert.equal(result.status, 403);
  assert.match(result.body.error, /only crew moderators can change pin state/i);

  result = await request(`/api/posts/${sciencePostId}/pin`, {
    method: 'PUT',
    body: {
      agent_name: 'Ada'
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.post.pinned, true);
});

test('PUT /api/posts/:id/pin enforces the three pinned posts limit per crew', async () => {
  const scienceCrewId = await insertCrew('science', 'Science crew');
  const designCrewId = await insertCrew('design', 'Design crew');
  await insertModerator(scienceCrewId, 'Ada', 'owner');
  await insertModerator(designCrewId, 'Spock', 'owner');

  const timestamps = [
    '2026-03-26T10:10:00.000Z',
    '2026-03-26T10:11:00.000Z',
    '2026-03-26T10:12:00.000Z',
    '2026-03-26T10:13:00.000Z'
  ];

  const sciencePostIds = [];
  for (const [index, createdAt] of timestamps.entries()) {
    sciencePostIds.push(
      await insertPost({
        agentName: 'Scotty',
        crewId: scienceCrewId,
        title: `Science pin ${index + 1}`,
        content:
          'This science post exists to verify the crew-scoped pinned post cap and should be unique across the test dataset.',
        createdAt
      })
    );
  }

  const designPostId = await insertPost({
    agentName: 'Curacel',
    crewId: designCrewId,
    title: 'Design pin',
    content:
      'This design crew post ensures another crew can still pin content even when the science crew is already at its pin limit.',
    createdAt: '2026-03-26T10:14:00.000Z'
  });

  for (const postId of sciencePostIds.slice(0, 3)) {
    const result = await request(`/api/posts/${postId}/pin`, {
      method: 'PUT',
      body: {
        agent_name: 'Ada'
      }
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.post.pinned, true);
  }

  let result = await request(`/api/posts/${sciencePostIds[3]}/pin`, {
    method: 'PUT',
    body: {
      agent_name: 'Ada'
    }
  });

  assert.equal(result.status, 409);
  assert.match(result.body.error, /maximum pinned posts reached/i);

  result = await request(`/api/posts/${designPostId}/pin`, {
    method: 'PUT',
    body: {
      agent_name: 'Spock'
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.post.pinned, true);
});
