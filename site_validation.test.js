const test = require('node:test');
const assert = require('node:assert/strict');
const { validateGeneratedSite } = require('./site_validation');

const VALID_SITE = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta property="og:title" content="Atelier"><title>Atelier</title><link href="/argent_ui.css" rel="stylesheet"></head><body><h1>Atelier</h1><main><a href="#devis">Contact</a><section id="devis"></section><img src="https://example.test/photo.jpg" alt="Atelier"><a href="https://example.test" target="_blank" rel="noopener noreferrer">Site</a><div class="sm:px-4"></div></main></body></html>';

test('accepts a responsive generated site with valid assets and anchors', () => {
  const result = validateGeneratedSite(VALID_SITE, true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('reports missing responsive metadata, broken anchors, insecure resources, and duplicate IDs', () => {
  const invalid = '<html><head><title>Atelier</title><link href="/argent_ui.css" rel="stylesheet"></head><body><h1>Atelier</h1><a href="#missing">Contact</a><div id="dup"></div><div id="dup"></div><img src="http://example.test/photo.jpg"><a href="https://example.test" target="_blank">Site</a></body></html>';
  const result = validateGeneratedSite(invalid, false);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'missing_mobile_viewport',
    'missing_main_landmark',
    'missing_open_graph_title',
    'missing_stylesheet',
    'duplicate_ids',
    'broken_internal_links',
    'insecure_http_resource',
    'image_missing_alt',
    'missing_responsive_styles',
    'unsafe_external_link'
  ]);
});
