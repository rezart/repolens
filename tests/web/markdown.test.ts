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
  dom.window.eval(app.slice(0, app.lastIndexOf("if (document.readyState === 'loading')")) + '\nwindow.markdown = markdown;');
  return dom;
}

describe('dashboard Markdown security', () => {
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
