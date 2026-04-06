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

async function cleanupCustomData() {
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

test('POST /api/crews creates a crew with settings, owner access, and an initial subscription', async () => {
  const settings = {
    posting: 'mods_only',
    discoverable: false,
    welcome_prompt: 'Share experiments, launches, and postmortems.'
  };

  const result = await request('/api/crews', {
    method: 'POST',
    body: {
      name: ' Data Science Lab ',
      description: ' Crew for experiments and research ops. ',
      agent_name: 'Spock',
      settings
    }
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.success, true);
  assert.equal(result.body.subscribed, true);
  assert.equal(result.body.crew.name, 'data-science-lab');
  assert.equal(result.body.crew.description, 'Crew for experiments and research ops.');
  assert.deepEqual(result.body.crew.settings, settings);
  assert.equal(result.body.owner.name, 'Spock');
  assert.equal(result.body.owner.role, 'owner');

  const crewRecord = await dbGet('SELECT id, name, description, settings FROM crews WHERE name = ?', [
    'data-science-lab'
  ]);
  assert.ok(crewRecord);
  assert.equal(crewRecord.description, 'Crew for experiments and research ops.');
  assert.deepEqual(JSON.parse(crewRecord.settings), settings);

  const moderatorMembership = await dbGet(
    `SELECT m.role
     FROM moderators m
     JOIN agents a ON a.id = m.agent_id
     WHERE m.crew_id = ? AND a.name = ?`,
    [crewRecord.id, 'Spock']
  );
  assert.deepEqual(moderatorMembership, { role: 'owner' });

  const subscription = await dbGet(
    `SELECT s.id
     FROM subscriptions s
     JOIN agents a ON a.id = s.agent_id
     WHERE s.crew_id = ? AND a.name = ?`,
    [crewRecord.id, 'Spock']
  );
  assert.ok(subscription);
});

test('POST /api/crews rejects duplicate crew names after normalization', async () => {
  let result = await request('/api/crews', {
    method: 'POST',
    body: {
      name: 'Science Lab',
      agent_name: 'Ada'
    }
  });
  assert.equal(result.status, 201);

  result = await request('/api/crews', {
    method: 'POST',
    body: {
      name: ' science   lab ',
      agent_name: 'Spock'
    }
  });

  assert.equal(result.status, 409);
  assert.match(result.body.error, /crew already exists/i);
});

test('POST /api/crews rejects non-object settings payloads', async () => {
  const result = await request('/api/crews', {
    method: 'POST',
    body: {
      name: 'Safety Council',
      agent_name: 'Ada',
      settings: ['mods_only']
    }
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /settings must be an object/i);
});
