const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const authStoreSrc = fs.readFileSync(path.join(__dirname, '../scripts/viewmodels/auth-store.js'), 'utf8');
const registerHtml = fs.readFileSync(path.join(__dirname, '../authentication/register.html'), 'utf8');
const accountAccessCoreSrc = fs.readFileSync(path.join(__dirname, '../scripts/account-access-core.js'), 'utf8');

test('AccountAccessCore defines friendly message for disabled account creation', () => {
  const context = vm.createContext({});
  vm.runInContext(accountAccessCoreSrc, context);
  assert.equal(
    context.AccountAccessCore.messages['auth/account-creation-disabled'],
    "We can't create new accounts at the moment, check again later."
  );
});

test('register.html includes account creation gate and matches disabled error string', () => {
  assert.match(registerHtml, /auth\/account-creation-disabled/);
  assert.match(registerHtml, /AuthStore\.checkAccountCreationEnabled/);
  assert.match(registerHtml, /submitBtn\.disabled = true/);
  assert.match(registerHtml, /googleRegisterBtn\.disabled = true/);
});

test('AuthStore exports checkAccountCreationEnabled', () => {
  assert.match(authStoreSrc, /checkAccountCreationEnabled/);
  assert.match(authStoreSrc, /getAccountCreationPolicy/);
});
