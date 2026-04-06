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

test('post-scoped comment creation supports threaded replies', async () => {
  const topLevel = await request('/api/posts/1/comments', {
    method: 'POST',
    body: {
      agent_name: 'Ada',
      content: 'Thread root created from the post-scoped comment endpoint.'
    }
  });

  assert.equal(topLevel.status, 201);
  assert.equal(topLevel.body.post_id, 1);
  assert.equal(topLevel.body.parent_id, null);

  const reply = await request('/api/posts/1/comments', {
    method: 'POST',
    body: {
      agent_name: 'Spock',
      content: 'Nested reply attached to the new root comment.',
      parent_id: topLevel.body.id
    }
  });

  assert.equal(reply.status, 201);
  assert.equal(reply.body.parent_id, topLevel.body.id);

  const comments = await request('/api/posts/1/comments?sort=top');
  assert.equal(comments.status, 200);

  const createdRoot = comments.body.find((comment) => comment.id === topLevel.body.id);
  assert.ok(createdRoot);
  assert.deepEqual(
    createdRoot.replies.map((comment) => ({
      id: comment.id,
      parent_id: comment.parent_id
    })),
    [{ id: reply.body.id, parent_id: topLevel.body.id }]
  );
  assert.equal(createdRoot.children[0].id, reply.body.id);
});

test('comment creation rejects parent comments from another post', async () => {
  const result = await request('/api/posts/1/comments', {
    method: 'POST',
    body: {
      agent_name: 'Ada',
      content: 'This reply points at a different post and should fail.',
      parent_id: 3
    }
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /same post/i);
});

test('comment listing supports new and controversial sort orders', async () => {
  const controversial = await request('/api/posts/1/comments', {
    method: 'POST',
    body: {
      agent_name: 'Curacel',
      content: 'Balanced votes should make this the controversial leader.'
    }
  });

  assert.equal(controversial.status, 201);

  const fresh = await request('/api/posts/1/comments', {
    method: 'POST',
    body: {
      agent_name: 'Scotty',
      content: 'Newest root comment should lead the new sort.'
    }
  });

  assert.equal(fresh.status, 201);

  let result = await request(`/api/comments/${controversial.body.id}/upvote`, {
    method: 'POST',
    body: { agent_name: 'Ada' }
  });
  assert.equal(result.status, 200);

  result = await request(`/api/comments/${controversial.body.id}/downvote`, {
    method: 'POST',
    body: { agent_name: 'Spock' }
  });
  assert.equal(result.status, 200);

  const controversialList = await request('/api/posts/1/comments?sort=controversial');
  assert.equal(controversialList.status, 200);
  assert.equal(controversialList.body[0].id, controversial.body.id);

  const newList = await request('/api/posts/1/comments?sort=new');
  assert.equal(newList.status, 200);
  assert.equal(newList.body[0].id, fresh.body.id);
});

test('comment listing rejects unsupported sort values', async () => {
  const result = await request('/api/posts/1/comments?sort=oldest');
  assert.equal(result.status, 400);
  assert.match(result.body.error, /top, new, or controversial/i);
});
