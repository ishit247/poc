import { test } from 'node:test';
import assert from 'node:assert/strict';

// i18n.ts reads localStorage and document when the language is set; give it small stand-ins.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  document: { documentElement: { lang: '' } },
});
const { HI, t, tn, setLang, getLang } = await import('../src/i18n.ts');

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',');

test('English is the default and a missing Hindi entry falls back to English', () => {
  assert.equal(getLang(), 'en');
  assert.equal(t('Sell'), 'Sell');
  setLang('hi');
  assert.equal(t('Sell'), 'बिक्री');
  assert.equal(t('A string nobody translated'), 'A string nobody translated');
  setLang('en');
});

test('variables are filled in, in both languages', () => {
  assert.equal(t('{n} orders', { n: 3 }), '3 orders');
  setLang('hi');
  assert.equal(t('{n} orders', { n: 3 }), '3 ऑर्डर');
  assert.equal(tn(1, '{n} order', '{n} orders'), '1 ऑर्डर');
  setLang('en');
  assert.equal(tn(1, '{n} order', '{n} orders'), '1 order');
  assert.equal(tn(2, '{n} order', '{n} orders'), '2 orders');
});

test('every Hindi entry keeps the same {variables} as its English key, and is not empty', () => {
  for (const [en, hi] of Object.entries(HI)) {
    assert.ok(hi.trim(), `empty Hindi for "${en}"`);
    assert.equal(vars(hi), vars(en), `variables differ for "${en}"`);
  }
});
