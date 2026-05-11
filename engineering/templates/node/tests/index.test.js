import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../src/index.js';

test('greet returns expected string', () => {
  assert.equal(greet('World'), 'Hello, World!');
});
