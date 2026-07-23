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

const { CategoriesQuery, CategoriesSubtreeQuery } = require('../queries');
const { Core, Files } = require('@adobe/aio-sdk');
const { requestSaaS, CATEGORY_FILE_PREFIX } = require('../utils');
const { Timings } = require('../lib/benchmark');
const { getRuntimeConfig } = require('../lib/runtimeConfig');
const { handleActionError } = require('../lib/errorHandler');

function normalizeCategory(category) {
  if (!category?.urlPath) return null;
  return {
    id: category.id,
    name: category.name || category.urlKey || category.urlPath,
    level: category.level,
    path: category.path,
    urlPath: String(category.urlPath).replace(/^\/+/, ''),
    urlKey: category.urlKey,
    parentId: category.parentId,
    position: category.position,
    roles: category.roles || [],
    children: category.children || [],
  };
}

/**
 * Prefer flat Catalog Service categories query (production PDP pattern).
 * Fall back to recursive subtree walk for deep catalogs when needed.
 */
async function getAllCategories(context) {
  const byId = new Map();

  try {
    const categoriesResp = await requestSaaS(CategoriesQuery, 'getCategories', {}, context);
    const items = categoriesResp.data?.categories || [];
    for (const item of items) {
      const normalized = normalizeCategory(item);
      if (!normalized) continue;
      if (String(normalized.id) === String(context.rootCategoryId)) continue;
      byId.set(normalized.id || normalized.urlPath, normalized);
    }
  } catch (e) {
    context.logger?.warn?.('Flat categories query failed, falling back to subtree walk', e);
  }

  // Ensure deep trees (L4+) are covered via chunked subtree queries
  const depth = Math.max(1, Number(context.categoryDepth || 4));
  const queue = [{ id: context.rootCategoryId, remainingDepth: depth }];
  const visited = new Set();

  while (queue.length) {
    const { id, remainingDepth } = queue.shift();
    if (!id || visited.has(id) || remainingDepth <= 0) continue;
    visited.add(id);

    const chunkDepth = Math.min(3, remainingDepth);
    let categories = [];
    try {
      const resp = await requestSaaS(
        CategoriesSubtreeQuery,
        'getCategoriesSubtree',
        {
          ids: [String(id)],
          roles: ['active'],
          subtree: { startLevel: 1, depth: chunkDepth },
        },
        context,
      );
      categories = resp.data?.categories || [];
    } catch (e) {
      context.logger?.warn?.(`Subtree query failed for category ${id}`, e);
      continue;
    }

    for (const category of categories) {
      const normalized = normalizeCategory(category);
      if (!normalized) continue;
      if (String(normalized.id) === String(context.rootCategoryId)) continue;
      byId.set(normalized.id || normalized.urlPath, normalized);

      if ((category.children || []).length > 0 && remainingDepth > chunkDepth) {
        queue.push({
          id: category.id,
          remainingDepth: remainingDepth - chunkDepth,
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.urlPath.localeCompare(b.urlPath));
}

async function main(params) {
  try {
    const cfg = getRuntimeConfig(params);
    const logger = Core.Logger('main', { level: cfg.logLevel });
    const sharedContext = {
      ...cfg,
      rootCategoryId: cfg.rootCategoryId,
      categoryDepth: cfg.categoryDepth,
      logger,
    };

    const results = await Promise.all(
      cfg.locales.map(async (locale) => {
        const context = { ...sharedContext };
        if (locale) context.locale = locale;

        const timings = new Timings();
        const stateFilePrefix = locale || 'default';
        const allCategories = await getAllCategories(context);
        timings.sample('getAllCategories');

        const filesLib = await Files.init(params.libInit || {});
        timings.sample('saveFile');
        const categoriesFileName = `${CATEGORY_FILE_PREFIX}/${stateFilePrefix}-categories.json`;
        await filesLib.write(categoriesFileName, JSON.stringify(allCategories));

        return {
          locale: stateFilePrefix,
          count: allCategories.length,
          timings: timings.measures,
        };
      }),
    );

    return {
      statusCode: 200,
      body: { status: 'completed', results },
    };
  } catch (error) {
    const logger = Core.Logger('main', { level: 'error' });
    return handleActionError(error, {
      logger,
      actionName: 'Fetch all categories',
    });
  }
}

exports.main = main;
exports.getAllCategories = getAllCategories;
