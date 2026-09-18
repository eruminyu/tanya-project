import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  APP_URL,
  isRendererDocument,
  resolveAsset,
  validText,
} from '../dist-electron/main/window-policy.js';
const root = resolve('dist');
test('assets are restricted to the packaged renderer directory and app host', () => {
  assert.equal(resolveAsset(root, APP_URL), resolve(root, 'index.html'));
  assert.equal(
    resolveAsset(root, 'kirian://app/assets/app-A1.js'),
    resolve(root, 'assets/app-A1.js')
  );
  assert.equal(resolveAsset(root, 'kirian://app/live2d/kirian/Kirian_UpperBody_Rig_v001.model3.json'), resolve(root, 'live2d/kirian/Kirian_UpperBody_Rig_v001.model3.json'));
  assert.equal(resolveAsset(root, 'kirian://app/live2d/kirian/%ED%82%A4%EB%A6%AC%EC%95%88.model3.json'), resolve(root, 'live2d/kirian/키리안.model3.json'));
  assert.equal(resolveAsset(root, 'kirian://app/live2d/framework/Shaders/WebGL/vertshadersrc.vert'), resolve(root, 'live2d/framework/Shaders/WebGL/vertshadersrc.vert'));
  for (const url of [
    'https://app/index.html',
    'kirian://other/index.html',
    'kirian://app/%2e%2e%5cpackage.json',
    'kirian://app/%252e%252e/package.json',
    'kirian://app/C:/Windows/win.ini',
    'kirian://user@app/index.html',
    'kirian://app/package.json',
    'kirian://app/live2d/%2e%2e/package.json',
    'kirian://app/%00.js',
  ])
    assert.equal(resolveAsset(root, url), null, url);
});
test('IPC sender document must be the exact trusted page', () => {
  assert.equal(isRendererDocument(APP_URL + '#settings', APP_URL), true);
  for (const url of [
    'kirian://other/index.html',
    'kirian://app/other.html',
    'kirian://app/index.html?untrusted',
    'file:///index.html',
    'https://app/index.html',
  ])
    assert.equal(isRendererDocument(url, APP_URL), false);
  assert.equal(
    isRendererDocument('http://127.0.0.1:5178/', 'http://127.0.0.1:5178/'),
    true
  );
  assert.equal(
    isRendererDocument('http://localhost:5178/', 'http://127.0.0.1:5178/'),
    false
  );
});
test('text command has bounded nonempty string input', () => {
  assert.equal(validText('안녕'), true);
  for (const value of ['', '  ', null, {}, 1, 'a'.repeat(32769)])
    assert.equal(validText(value), false);
});
