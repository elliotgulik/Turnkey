const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('function friendlyAuthError(msg){');
const end = html.indexOf('let currentUserId=null;', start);
assert.ok(start >= 0 && end > start, 'auth action functions should be present');
const source = html.slice(start, end);

function setup(method) {
  const elements = new Map([
    ['auth-email', { value: 'owner@example.com', disabled: false }],
    ['auth-password', { value: 'password123', disabled: false }],
    ['auth-signin-btn', { disabled: false }],
    ['auth-signup-btn', { disabled: false }],
    ['auth-new-password', { value: 'password123', disabled: false }],
    ['auth-recovery-btn', { disabled: false }],
  ]);
  const messages = [];
  const ctx = vm.createContext({
    sb: { auth: method },
    document: { getElementById: id => elements.get(id) },
    window: { TURNKEY_CONFIG:{allowSignup:true}, location: { origin: 'https://turnkeycrm.net', pathname: '/index.html', assign: url=>messages.push(url) } },
    setAuthMsg: message => messages.push(message),
    setRecoveryMsg: message => messages.push(message),
    toast() {},
    console,
    setTimeout,
  });
  vm.runInContext(source, ctx);
  return { ctx, elements, messages };
}

test('sign-in buttons unlock and explain network rejection', async () => {
  const { ctx, elements, messages } = setup({ signInWithPassword: async () => { throw Error('offline'); } });
  await ctx.handleSignIn();
  assert.equal(elements.get('auth-signin-btn').disabled, false);
  assert.equal(elements.get('auth-signup-btn').disabled, false);
  assert.match(messages.at(-1), /offline/i);
});

test('forgot-password opens the dedicated recovery page', async () => {
  const { ctx, elements, messages } = setup({ resetPasswordForEmail: async () => { throw Error('offline'); } });
  await ctx.handleForgotPassword();
  assert.equal(elements.get('auth-signin-btn').disabled, false);
  assert.equal(elements.get('auth-signup-btn').disabled, false);
  assert.equal(messages.at(-1), '/reset-password.html');
});

test('sign-up buttons unlock and explain network rejection', async () => {
  const { ctx, elements, messages } = setup({ signUp: async () => { throw Error('offline'); } });
  await ctx.handleSignUp();
  assert.equal(elements.get('auth-signin-btn').disabled, false);
  assert.equal(elements.get('auth-signup-btn').disabled, false);
  assert.match(messages.at(-1), /offline/i);
});

test('password recovery button unlocks when saving or session lookup rejects', async () => {
  const failingUpdate = setup({ updateUser: async () => { throw Error('offline'); } });
  await failingUpdate.ctx.handlePasswordRecoverySubmit();
  assert.equal(failingUpdate.elements.get('auth-recovery-btn').disabled, false);
  assert.match(failingUpdate.messages.at(-1), /offline/i);

  const failingSession = setup({ updateUser: async () => ({ error: null }), getSession: async () => { throw Error('offline'); } });
  await failingSession.ctx.handlePasswordRecoverySubmit();
  assert.equal(failingSession.elements.get('auth-recovery-btn').disabled, false);
  assert.match(failingSession.messages.at(-1), /offline/i);
});


test('signup is disabled unless explicitly enabled and rejects short new passwords',async()=>{
 let calls=0;const f=setup({signUp:async()=>{calls++;return {error:null};}});
 f.ctx.window.TURNKEY_CONFIG.allowSignup=false;await f.ctx.handleSignUp();assert.equal(calls,0);assert.match(f.messages.at(-1),/registration is closed/);
 f.ctx.window.TURNKEY_CONFIG.allowSignup=true;f.elements.get('auth-password').value='short';await f.ctx.handleSignUp();assert.equal(calls,0);assert.match(f.messages.at(-1),/10 characters/);
});
