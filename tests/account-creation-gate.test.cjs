const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const authStoreSrc = fs.readFileSync(path.join(__dirname, '../scripts/viewmodels/auth-store.js'), 'utf8');
const registerHtml = fs.readFileSync(path.join(__dirname, '../authentication/register.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(__dirname, '../authentication/login.html'), 'utf8');
const accountAccessCoreSrc = fs.readFileSync(path.join(__dirname, '../scripts/account-access-core.js'), 'utf8');

test('AccountAccessCore defines friendly message for disabled account creation', () => {
  const context = vm.createContext({});
  vm.runInContext(accountAccessCoreSrc, context);
  assert.equal(
    context.AccountAccessCore.messages['auth/account-creation-disabled'],
    "We can't create new accounts at the moment, check again later."
  );
});

test('register.html includes account creation gate, loader, and auto-redirects on disabled', () => {
  assert.match(registerHtml, /id="register-loader"/);
  assert.match(registerHtml, /id="register-card"[^>]*hidden/);
  assert.match(registerHtml, /AuthStore\.checkAccountCreationEnabled/);
  assert.match(registerHtml, /window\.location\.replace\('login'/);
  assert.doesNotMatch(registerHtml, /firebase-functions-compat\.js/);
});

test('login.html adjusts UI when account creation is disabled', () => {
  assert.match(loginHtml, /id="google-login-btn"/);
  assert.match(loginHtml, /id="google-login-divider"/);
  assert.match(loginHtml, /id="register-prompt"/);
  assert.match(loginHtml, /AuthStore\.checkAccountCreationEnabled/);
  assert.doesNotMatch(loginHtml, /firebase-functions-compat\.js/);
});

test('AuthStore exports checkAccountCreationEnabled using direct Firestore reads', () => {
  assert.match(authStoreSrc, /checkAccountCreationEnabled/);
  assert.match(authStoreSrc, /collection\('globalConfig'\)\.doc\('featureToggles'\)/);
  assert.match(authStoreSrc, /accountCreation === true/);
  assert.doesNotMatch(authStoreSrc, /getAccountCreationPolicy/);
});
