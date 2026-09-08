import test from 'node:test';
import assert from 'node:assert';
import { a11y } from '../dist/a11y.js';

test('a11y exports the expected ARIA role constants', () => {
  assert.strictEqual(a11y.roleDialog, 'dialog');
  assert.strictEqual(a11y.roleButton, 'button');
});
