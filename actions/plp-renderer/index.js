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

const { Core } = require('@adobe/aio-sdk');
const { getRuntimeConfig } = require('../lib/runtimeConfig');
const { handleActionError } = require('../lib/errorHandler');
const { generateCategoryHtml } = require('./render');
const { extractPathDetails } = require('../pdp-renderer/lib');

/**
 * Web action to render a single category page (mirrors pdp-renderer).
 * Path example: /categories/gear or /categories/women/tops/tees
 */
async function main(params) {
  try {
    const cfg = getRuntimeConfig(params);
    const logger = Core.Logger('main', { level: cfg.logLevel });
    const context = {
      ...cfg,
      categoryPathFormat: cfg.categoryPathFormat,
      logger,
    };

    const path = params.__ow_path || params.path || '';
    let urlPath = params.urlPath;
    if (!urlPath && path) {
      try {
        // For nested paths, strip the static /categories prefix
        const format = cfg.categoryPathFormat || '/categories/{urlPath}';
        const prefix = format.split('{urlPath}')[0];
        if (path.startsWith(prefix.replace(/\/$/, '')) || path.startsWith('/categories')) {
          urlPath = path
            .replace(/^\/+/, '')
            .replace(/^([^/]+\/)?categories\//, '')
            .replace(/\/$/, '');
        } else {
          const details = extractPathDetails(path, format);
          urlPath = details.urlPath;
        }
      } catch (e) {
        logger.warn('Unable to parse category path', e);
      }
    }

    if (!urlPath) {
      return {
        statusCode: 400,
        body: { error: 'Missing category urlPath' },
      };
    }

    const html = await generateCategoryHtml({
      name: params.name || urlPath.split('/').pop(),
      urlPath,
      metaTitle: params.metaTitle,
      metaDescription: params.metaDescription,
    }, context);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: html,
    };
  } catch (error) {
    const logger = Core.Logger('main', { level: 'error' });
    return handleActionError(error, {
      logger,
      actionName: 'PLP renderer',
    });
  }
}

exports.main = main;
