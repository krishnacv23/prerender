/*
Copyright 2025 Adobe. All rights reserved.
This file is licensed to you under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License. You may obtain a copy
of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under
the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
OF ANY KIND, either express or implied. See the License for the specific language
governing permissions and limitations under the License.
*/

const Handlebars = require('handlebars');
const { prepareBaseTemplate, sanitize } = require('../pdp-renderer/lib');
const { getCategoryUrl } = require('../utils');

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildBreadcrumbs(category, byUrlPath) {
  const crumbs = [];
  const segments = String(category.urlPath || '').replace(/^\/+/, '').split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    const urlPath = segments.slice(0, i + 1).join('/');
    const match = byUrlPath?.get(urlPath);
    crumbs.push({
      name: match?.name || segments[i],
      urlPath,
    });
  }
  return crumbs;
}

function buildJsonLd(category, breadcrumbs, context) {
  const pagePath = getCategoryUrl(category, context, false);
  const pageUrl = `${context.storeUrl}${pagePath}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: category.name,
        url: pageUrl,
        description: `${category.name} products`,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'Home',
            item: context.storeUrl,
          },
          ...breadcrumbs.map((crumb, index) => ({
            '@type': 'ListItem',
            position: index + 2,
            name: crumb.name,
            item: `${context.storeUrl}${getCategoryUrl({ urlPath: crumb.urlPath }, context, false)}`,
          })),
        ],
      },
    ],
  };
}

const DEFAULT_PLP_PARTIAL = `
<div class="product-list-page">
  <div>
    <div>urlpath</div>
    <div>{{urlPath}}</div>
  </div>
  <div>
    <div>pageSize</div>
    <div>12</div>
  </div>
</div>
`;

// Mirrors PDP page.hbs: SEO head is fixed; body content comes from authored
// /categories/default ({{> content}}) or the built-in fallback partial.
const PAGE_TEMPLATE = `<!DOCTYPE html>
<html>
  <head>
    <title>{{metaTitle}}</title>
    <meta name="description" content="{{metaDescription}}">
    <meta name="robots" content="index, follow">
    <meta name="urlpath" content="{{urlPath}}">
    <link rel="canonical" href="{{canonical}}">
    <meta property="og:title" content="{{metaTitle}}">
    <meta property="og:description" content="{{metaDescription}}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="{{canonical}}">
    <script type="application/ld+json">{{{ldJson}}}</script>
  </head>
  <body>
    <header></header>
    <main>
      {{> content}}
    </main>
    <footer></footer>
  </body>
</html>
`;

const DEFAULT_CONTENT_PARTIAL = `
<div>
  <p>{{{breadcrumbHtml}}}</p>
  <h1>{{name}}</h1>
  <p>{{metaDescription}}</p>
  {{> product-list-page }}
  <div class="metadata">
    <div>
      <div>Title</div>
      <div>{{metaTitle}}</div>
    </div>
    <div>
      <div>Description</div>
      <div>{{metaDescription}}</div>
    </div>
    <div>
      <div>Robots</div>
      <div>index, follow</div>
    </div>
  </div>
</div>
`;

const categoryTemplateCache = {};

/**
 * Generate SEO-ready category HTML for BYOM overlay publishing.
 * Mirrors PDP renderer: optionally merges authored /categories/default template.
 */
async function generateCategoryHtml(category, context, options = {}) {
  if (!category?.urlPath) {
    const error = new Error('Category urlPath is required');
    error.statusCode = 404;
    throw error;
  }

  const byUrlPath = options.byUrlPath || new Map();
  const breadcrumbs = buildBreadcrumbs(category, byUrlPath);
  const contentPath = getCategoryUrl(category, context, false);
  const canonical = `${context.storeUrl}${contentPath}`;
  const name = sanitize(category.name, 'inline') || category.urlPath;
  const metaTitle = sanitize(category.metaTitle || category.name, 'no') || name;
  const metaDescription = sanitize(
    category.metaDescription || `${category.name} – shop products online`,
    'no',
  );

  const breadcrumbHtml = [
    '<a href="/">Home</a>',
    ...breadcrumbs.map((crumb, index) => {
      const href = getCategoryUrl({ urlPath: crumb.urlPath }, context, false);
      const isLast = index === breadcrumbs.length - 1;
      return isLast
        ? `<span>${escapeHtml(crumb.name)}</span>`
        : `<a href="${href}">${escapeHtml(crumb.name)}</a>`;
    }),
  ].join(' / ');

  Handlebars.registerPartial('product-list-page', DEFAULT_PLP_PARTIAL);

  const localeKey = context.locale || 'default';
  let usedAuthoredTemplate = false;
  if (context.categoriesTemplate) {
    const categoriesTemplateURL = context.categoriesTemplate
      .replace(/\s+/g, '')
      .replace('{locale}', localeKey);
    if (!categoryTemplateCache[localeKey]) categoryTemplateCache[localeKey] = {};
    if (!categoryTemplateCache[localeKey].baseTemplate) {
      categoryTemplateCache[localeKey].baseTemplate = prepareBaseTemplate(
        categoriesTemplateURL,
        ['product-list-page'],
        context,
      ).catch((err) => {
        context.logger?.warn?.(
          `Failed to load categories template ${categoriesTemplateURL}, using built-in markup`,
          err,
        );
        return null;
      });
    }
    const baseTemplate = await categoryTemplateCache[localeKey].baseTemplate;
    if (baseTemplate) {
      // Authored /categories/default HTML with product-list-page swapped for {{> product-list-page}}
      Handlebars.registerPartial('content', baseTemplate);
      usedAuthoredTemplate = true;
    }
  }

  if (!usedAuthoredTemplate) {
    Handlebars.registerPartial('content', DEFAULT_CONTENT_PARTIAL);
  }

  // Prefer full page template with SEO head (production crawler requirement)
  const pageTemplate = Handlebars.compile(PAGE_TEMPLATE);
  return pageTemplate({
    name,
    metaTitle,
    metaDescription,
    canonical,
    urlPath: String(category.urlPath).replace(/^\/+/, ''),
    breadcrumbHtml,
    ldJson: JSON.stringify(buildJsonLd(category, breadcrumbs, context)),
  });
}

module.exports = {
  generateCategoryHtml,
  buildBreadcrumbs,
};
