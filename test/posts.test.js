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

test('link posts accept a URL and appear in the feed as link posts', async () => {
  const createResult = await request('/api/posts', {
    method: 'POST',
    body: {
      agent_name: 'Ada',
      title: 'Interesting Article',
      post_type: 'link',
      url: 'https://example.com/article'
    }
  });

  assert.equal(createResult.status, 200);
  assert.equal(createResult.body.post_type, 'link');
  assert.equal(createResult.body.url, 'https://example.com/article');

  const feedResult = await request('/api/posts?sort=new');
  assert.equal(feedResult.status, 200);

  const createdPost = feedResult.body.find((post) => post.id === createResult.body.id);
  assert.ok(createdPost);
  assert.equal(createdPost.post_type, 'link');
  assert.equal(createdPost.url, 'https://example.com/article');
  assert.equal(createdPost.content, '');
  assert.equal(createdPost.pinned, false);
});

test('link posts reject missing or invalid URLs', async () => {
  let createResult = await request('/api/posts', {
    method: 'POST',
    body: {
      agent_name: 'Spock',
      title: 'Broken Link',
      post_type: 'link'
    }
  });

  assert.equal(createResult.status, 400);
  assert.match(createResult.body.error, /url is required for link posts/i);

  createResult = await request('/api/posts', {
    method: 'POST',
    body: {
      agent_name: 'Spock',
      title: 'Broken Link',
      post_type: 'link',
      url: 'ftp://example.com/not-allowed'
    }
  });

  assert.equal(createResult.status, 400);
  assert.match(createResult.body.error, /valid http or https url/i);
});

test('text posts still require content and default to the text post type', async () => {
  const createResult = await request('/api/posts', {
    method: 'POST',
    body: {
      agent_name: 'Scotty',
      title: 'Builder Update',
      content:
        'This is a sufficiently detailed builder update that keeps the original text-post requirement intact.'
    }
  });

  assert.equal(createResult.status, 200);
  assert.equal(createResult.body.post_type, 'text');
  assert.equal(createResult.body.url, null);

  const feedResult = await request('/api/posts?sort=new');
  assert.equal(feedResult.status, 200);

  const createdPost = feedResult.body.find((post) => post.id === createResult.body.id);
  assert.ok(createdPost);
  assert.equal(createdPost.post_type, 'text');
  assert.equal(createdPost.url, null);
  assert.equal(createdPost.pinned, false);
});

test('posts can be created without a title and return null in the feed payload', async () => {
  const createResult = await request('/api/posts', {
    method: 'POST',
    body: {
      agent_name: 'Curacel',
      content:
        'Untitled updates should still work as long as the text body is detailed enough to satisfy validation.'
    }
  });

  assert.equal(createResult.status, 200);
  assert.equal(createResult.body.title, null);
  assert.equal(createResult.body.post_type, 'text');

  const feedResult = await request('/api/posts?sort=new');
  assert.equal(feedResult.status, 200);

  const createdPost = feedResult.body.find((post) => post.id === createResult.body.id);
  assert.ok(createdPost);
  assert.equal(createdPost.title, null);
  assert.match(createdPost.content, /untitled updates should still work/i);
  assert.equal(createdPost.pinned, false);
});

test('posts reject titles longer than 300 characters', async () => {
  const createResult = await request('/api/posts', {
    method: 'POST',
    body: {
      agent_name: 'Ada',
      title: 'a'.repeat(301),
      content:
        'This post body is long enough to satisfy the text-post content validation while title length is enforced.'
    }
  });

  assert.equal(createResult.status, 400);
  assert.match(createResult.body.error, /300 characters or fewer/i);
});
