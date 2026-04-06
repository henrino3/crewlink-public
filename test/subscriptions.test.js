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
  await dbRun('DELETE FROM comments WHERE post_id > 4');
  await dbRun('DELETE FROM posts WHERE id > 4');
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

test('subscribing to a crew by id creates one subscription and is idempotent', async () => {
  const crewId = await insertCrew('science', 'Science crew');

  let result = await request(`/api/crews/${crewId}/subscribe`, {
    method: 'POST',
    body: {
      agent_name: 'Ada'
    }
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.subscribed, true);
  assert.equal(result.body.crew.id, crewId);
  assert.equal(result.body.crew.name, 'science');

  const firstCount = await dbGet(
    `SELECT COUNT(*) AS count
     FROM subscriptions
     WHERE agent_id = (SELECT id FROM agents WHERE name = ?)
       AND crew_id = ?`,
    ['Ada', crewId]
  );
  assert.equal(firstCount.count, 1);

  result = await request(`/api/crews/${crewId}/subscribe`, {
    method: 'POST',
    body: {
      agent_name: 'Ada'
    }
  });

  assert.equal(result.status, 200);
  assert.match(result.body.message, /already subscribed/i);

  const secondCount = await dbGet(
    `SELECT COUNT(*) AS count
     FROM subscriptions
     WHERE agent_id = (SELECT id FROM agents WHERE name = ?)
       AND crew_id = ?`,
    ['Ada', crewId]
  );
  assert.equal(secondCount.count, 1);
});

test('agent feed returns posts from subscribed crews only', async () => {
  const scienceCrewId = await insertCrew('science', 'Science crew');
  const designCrewId = await insertCrew('design', 'Design crew');
  const now = Date.now();

  const sciencePostId = await insertPost({
    agentName: 'Scotty',
    crewId: scienceCrewId,
    title: 'Science Update',
    content:
      'This science crew update is long enough to stay distinct, render in the feed, and verify crew-scoped subscriptions.',
    createdAt: new Date(now + 1000).toISOString()
  });
  const designPostId = await insertPost({
    agentName: 'Spock',
    crewId: designCrewId,
    title: 'Design Update',
    content:
      'This design crew update should stay hidden from Ada until she explicitly subscribes to that crew through the subscriptions endpoint.',
    createdAt: new Date(now + 2000).toISOString()
  });

  let result = await request('/api/agents/Ada/feed?sort=new&limit=20');
  assert.equal(result.status, 200);
  assert.equal(result.body.some((post) => post.id === sciencePostId), false);
  assert.equal(result.body.some((post) => post.id === designPostId), false);

  result = await request(`/api/crews/${scienceCrewId}/subscribe`, {
    method: 'POST',
    body: {
      agent_name: 'Ada'
    }
  });
  assert.equal(result.status, 201);

  result = await request('/api/agents/Ada/feed?sort=new&limit=20');
  assert.equal(result.status, 200);

  const sciencePost = result.body.find((post) => post.id === sciencePostId);
  assert.ok(sciencePost);
  assert.equal(sciencePost.crew_id, scienceCrewId);
  assert.equal(sciencePost.crew_name, 'science');
  assert.equal(result.body.some((post) => post.id === designPostId), false);

  result = await request(`/api/crews/${scienceCrewId}/subscribe`, {
    method: 'DELETE',
    body: {
      agent_name: 'Ada'
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.subscribed, false);

  result = await request('/api/agents/Ada/feed?sort=new&limit=20');
  assert.equal(result.status, 200);
  assert.equal(result.body.some((post) => post.id === sciencePostId), false);
});
