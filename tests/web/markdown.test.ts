import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');

function dashboard(withSanitizer = true) {
  const dom = new JSDOM('', { url: 'https://repolens.test', runScripts: 'outside-only' });
  dom.window.eval(readFileSync(new URL('../../node_modules/marked/lib/marked.umd.js', import.meta.url), 'utf8'));
  if (withSanitizer) dom.window.eval(readFileSync(new URL('../../node_modules/dompurify/dist/purify.js', import.meta.url), 'utf8'));
  // Load the real renderer without starting network requests or mounting the dashboard.
  dom.window.eval(app.slice(0, app.lastIndexOf("if (document.readyState === 'loading')")) + `
    window.markdown = markdown;
    window.renderHealthForTest = (health) => {
      state.health = health;
      dom.health = document.getElementById('health');
      dom.version = document.getElementById('version');
      renderHealth();
    };
  `);
  return dom;
}

describe('dashboard Markdown security', () => {
  it('preserves semantic Markdown without application data or ARIA attributes', () => {
    const dom = dashboard();
    try {
      const node = dom.window.markdown([
        '# Review',
        '- **Important** change',
        '```ts\ncheckAuth();\n```',
        '| File | Status |\n| --- | --- |\n| auth.ts | reviewed |',
        '<p data-action="delete" aria-hidden="true">Visible finding</p>',
      ].join('\n\n'));
      expect(node.querySelector('h1')?.textContent).toBe('Review');
      expect(node.querySelector('li strong')?.textContent).toBe('Important');
      expect(node.querySelector('pre code')?.textContent).toBe('checkAuth();\n');
      expect(node.querySelector('td')?.textContent).toBe('auth.ts');
      expect(node.textContent).toContain('Visible finding');
      expect(node.querySelector('[data-action], [aria-hidden]')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('keeps Markdown formatting but strips active HTML, obfuscated URLs and remote images', () => {
    const dom = dashboard();
    try {
      const node = dom.window.markdown([
        '**Safe text** and [safe link](https://example.com).',
        '<svg><a><animate attributeName="href" values="javascript:alert(1)" /></a></svg>',
        '<a href="java&#x09;script:alert(1)">bad link</a>',
        '<img src="https://attacker.test/track" onerror="alert(1)">',
        '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
        '<p style="position:fixed" onclick="alert(1)">content</p>',
        '[data](data:text/html,test) [relative](/api/repositories)',
      ].join('\n\n'));
      expect(node.querySelector('strong')?.textContent).toBe('Safe text');
      expect(node.querySelector('svg, animate, img, iframe, script, [style], [onclick], [onerror]')).toBeNull();
      const links = Array.from(node.querySelectorAll('a[href]')) as Array<{ getAttribute(name: string): string }>;
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
      expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    } finally {
      dom.window.close();
    }
  });

  it('falls back to literal text when the sanitizer is unavailable', () => {
    const dom = dashboard(false);
    try {
      const payload = '<img src=x onerror=alert(1)>';
      const node = dom.window.markdown(payload);
      expect(node.querySelector('img')).toBeNull();
      expect(node.textContent).toBe(payload);
    } finally {
      dom.window.close();
    }
  });
});

describe('dashboard version', () => {
  it('shows the running revision as the version tooltip', () => {
    const dom = dashboard();
    try {
      dom.window.document.body.innerHTML = '<div id="health"></div><span id="version"></span>';
      const health = { ok: true, version: '0.1.0', revision: 'abc123', llm: {}, chat: {} };
      dom.window.renderHealthForTest(health);
      const version = dom.window.document.getElementById('version');
      expect(version?.textContent).toBe('v0.1.0');
      expect(version?.getAttribute('title')).toBe('abc123');

      dom.window.renderHealthForTest({ ...health, revision: null });
      expect(version?.hasAttribute('title')).toBe(false);
    } finally {
      dom.window.close();
    }
  });
});
