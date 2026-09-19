'use strict';

const fs = require('node:fs');
const path = require('node:path');

const cache = new Map();

const escapeHtml = (value) =>
  String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Views, the shared stylesheet and the head partial are read once per container.
const load = (file) => {
  if (!cache.has(file)) {
    cache.set(file, fs.readFileSync(path.join(__dirname, 'views', file), 'utf8'));
  }
  return cache.get(file);
};

const fill = (template, values) =>
  template
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, key) => (values[key] === undefined ? '' : String(values[key])))
    .replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(values[key]));

// {{key}} is escaped; {{{key}}} is raw, for pre-built markup only.
const render = (name, values = {}) => {
  const head = fill(load('_head.html'), { styles: load('_styles.css') });
  const rail = load('_rail.html');
  return fill(load(`${name}.html`), { head, rail, ...values });
};

module.exports = { escapeHtml, render };
