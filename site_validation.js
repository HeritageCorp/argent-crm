function validateGeneratedSite(html, stylesheetAvailable) {
  const errors = [];
  const checks = [];
  const source = String(html || '');
  const ids = new Set();
  const duplicateIds = new Set();
  let match;

  if (!/<title\b[^>]*>[^<]+\s*<\/title>/i.test(source)) errors.push('missing_title');
  else checks.push('title');

  if (!/<h1\b[^>]*>[\s\S]+?<\/h1>/i.test(source)) errors.push('missing_h1');
  else checks.push('primary_heading');

  if (!/<meta\b(?=[^>]*\bname=["']viewport["'])(?=[^>]*\bcontent=["'][^"']*width=device-width)[^>]*>/i.test(source)) {
    errors.push('missing_mobile_viewport');
  } else checks.push('mobile_viewport');

  if (!/<main\b[^>]*>[\s\S]+?<\/main>/i.test(source)) errors.push('missing_main_landmark');
  else checks.push('main_landmark');

  if (!/<meta\b(?=[^>]*\bproperty=["']og:title["'])(?=[^>]*\bcontent=["'][^"']+["'])[^>]*>/i.test(source)) {
    errors.push('missing_open_graph_title');
  } else checks.push('open_graph_title');

  if (!/href=["']\/argent_ui\.css["']/i.test(source) || stylesheetAvailable === false) {
    errors.push('missing_stylesheet');
  } else checks.push('local_stylesheet');

  const idPattern = /\bid=["']([^"']+)["']/gi;
  while ((match = idPattern.exec(source)) !== null) {
    if (ids.has(match[1])) duplicateIds.add(match[1]);
    ids.add(match[1]);
  }
  if (duplicateIds.size) errors.push('duplicate_ids');
  else checks.push('unique_ids');

  const missingAnchors = new Set();
  const anchorPattern = /\bhref=["']#([^"']+)["']/gi;
  while ((match = anchorPattern.exec(source)) !== null) {
    if (!ids.has(match[1])) missingAnchors.add(match[1]);
  }
  if (missingAnchors.size) errors.push('broken_internal_links');
  else checks.push('internal_links');

  const remotePattern = /\b(?:href|src)=["'](http:\/\/[^"']+)["']/gi;
  if (remotePattern.test(source)) errors.push('insecure_http_resource');
  else checks.push('https_resources');

  const imagePattern = /<img\b([^>]*)>/gi;
  let imageWithoutAlt = false;
  while ((match = imagePattern.exec(source)) !== null) {
    if (!/\balt=["'][^"']+["']/i.test(match[1])) imageWithoutAlt = true;
  }
  if (imageWithoutAlt) errors.push('image_missing_alt');
  else checks.push('image_alternatives');

  if (!/\b(?:sm|md|lg|xl):[a-z0-9-]+/i.test(source)) errors.push('missing_responsive_styles');
  else checks.push('responsive_styles');

  const unsafeBlankLinks = /<a\b(?=[^>]*\btarget=["']_blank["'])(?![^>]*\brel=["'][^"']*\bnoopener\b)[^>]*>/gi;
  if (unsafeBlankLinks.test(source)) errors.push('unsafe_external_link');
  else checks.push('safe_external_links');

  return { ok: errors.length === 0, errors, checks };
}

module.exports = { validateGeneratedSite };
