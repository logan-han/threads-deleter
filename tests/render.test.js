import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { escapeHtml, render } = require('../src/render.js');

describe('escapeHtml', () => {
  it('escapes every character that could break out of markup or an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>Tom & Jerry</a>`))
      .toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;');
  });

  it('renders a missing value as nothing rather than the word "undefined"', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(0)).toBe('0');
  });
});

describe('render', () => {
  it('escapes {{value}} slots', () => {
    const page = render('error', { message: '<img src=x onerror=alert(1)>' });
    expect(page).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(page).not.toContain('<img src=x');
  });

  it('inserts {{{value}}} slots as markup', () => {
    const page = render('index', { warning: '<div class="notice bad">careful</div>' });
    expect(page).toContain('<div class="notice bad">careful</div>');
  });

  it('leaves slots it was given nothing for empty', () => {
    const page = render('status', {});
    expect(page).not.toContain('undefined');
    expect(page).not.toContain('{{');
  });
});
