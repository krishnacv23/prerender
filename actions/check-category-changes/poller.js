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

const crypto = require('crypto');
const { Timings } = require('../lib/benchmark');
const { AdminAPI } = require('../lib/aem');
const {
  isValidUrl,
  getCategoryUrl,
  getCategoryMarkupPath,
  createBatches,
  CATEGORY_FILE_PREFIX,
  STATE_FILE_EXT,
} = require('../utils');
const { generateCategoryHtml, buildBreadcrumbs } = require('../plp-renderer/render');
const { JobFailedError, ERROR_CODES } = require('../lib/errorHandler');
const BATCH_SIZE = 50;

function getFileLocation(stateKey, extension) {
  return `${CATEGORY_FILE_PREFIX}/${stateKey}.${extension}`;
}

async function loadState(locale, aioLibs) {
  const { filesLib } = aioLibs;
  const stateObj = { locale, categories: {} };
  try {
    const stateKey = locale || 'default';
    const fileLocation = getFileLocation(stateKey, STATE_FILE_EXT);
    const buffer = await filesLib.read(fileLocation);
    const stateData = buffer?.toString();
    if (stateData) {
      // urlPath,timestamp,hash
      stateObj.categories = stateData.split('\n').reduce((acc, line) => {
        if (!line.trim()) return acc;
        const [urlPath, time, hash] = line.split(',');
        acc[urlPath] = { lastRenderedAt: new Date(parseInt(time, 10)), hash };
        return acc;
      }, {});
    }
  } catch {
    stateObj.categories = {};
  }
  return stateObj;
}

async function saveState(state, aioLibs) {
  const { filesLib } = aioLibs;
  const stateKey = state.locale || 'default';
  const fileLocation = getFileLocation(stateKey, STATE_FILE_EXT);
  const csvData = Object.entries(state.categories)
    .filter(([, meta]) => Boolean(meta.lastRenderedAt))
    .map(([urlPath, { lastRenderedAt, hash }]) => `${urlPath},${lastRenderedAt.getTime()},${hash || ''}`)
    .join('\n');
  return filesLib.write(fileLocation, csvData);
}

function checkParams(params) {
  const requiredParams = [
    'site',
    'org',
    'categoryPathFormat',
    'adminAuthToken',
    'configName',
    'contentUrl',
    'storeUrl',
  ];
  const missingParams = requiredParams.filter((param) => !params[param]);
  if (missingParams.length > 0) {
    throw new JobFailedError(
      `Missing required parameters: ${missingParams.join(', ')}`,
      ERROR_CODES.VALIDATION_ERROR,
      400,
      { missingParams },
    );
  }
  if (params.storeUrl && !isValidUrl(params.storeUrl)) {
    throw new JobFailedError('Invalid storeUrl', ERROR_CODES.VALIDATION_ERROR, 400);
  }
}

function shouldPreviewAndPublish({ currentHash, newHash }) {
  return Boolean(newHash && currentHash !== newHash);
}

async function processPublishedBatch(publishedBatch, state, counts, categories) {
  const { records } = publishedBatch;
  records.forEach((record) => {
    if (record.previewedAt && record.publishedAt) {
      const category = categories.find((c) => c.urlPath === record.urlPath || c.path === record.path);
      state.categories[record.urlPath || category?.urlPath] = {
        lastRenderedAt: record.renderedAt || new Date(),
        hash: category?.newHash,
      };
      counts.published += 1;
    } else {
      counts.failed += 1;
    }
  });
}

async function processDeletedCategories(remainingUrlPaths, state, context, adminApi) {
  if (!remainingUrlPaths.length) return;
  const { locale, counts, logger, aioLibs, categoryPathFormat, storeUrl } = context;
  const { filesLib } = aioLibs;

  const deleted = remainingUrlPaths.map((urlPath) => {
    const path = getCategoryUrl({ urlPath }, { storeUrl, categoryPathFormat, locale }, false);
    return { urlPath, path, sku: urlPath };
  });

  const batches = createBatches(deleted);
  for (let batchNumber = 0; batchNumber < batches.length; batchNumber += 1) {
    const records = batches[batchNumber];
    try {
      const result = await adminApi.unpublishAndDelete(records, locale, batchNumber + 1);
      for (const record of result.records || records) {
        if (record.liveUnpublishedAt && record.previewUnpublishedAt) {
          try {
            await filesLib.delete(getCategoryMarkupPath(record.path));
          } catch (e) {
            logger.warn(`Error deleting category markup for ${record.urlPath || record.path}`, e);
          }
          delete state.categories[record.urlPath];
          counts.unpublished += 1;
        } else {
          counts.failed += 1;
        }
      }
    } catch (e) {
      logger.error('Error unpublishing deleted categories', e);
      counts.failed += records.length;
    }
  }
  await saveState(state, aioLibs);
}

async function poll(params, aioLibs, logger) {
  checkParams(params);

  const counts = {
    published: 0, unpublished: 0, ignored: 0, failed: 0, rendered: 0,
  };
  const {
    org,
    site,
    categoryPathFormat,
    siteToken,
    configName,
    configSheet,
    adminAuthToken,
    categoriesTemplate,
    storeUrl,
    contentUrl,
    logLevel,
    logIngestorEndpoint,
    locales: rawLocales,
  } = params;

  const locales = Array.isArray(rawLocales)
    ? rawLocales
    : (typeof rawLocales === 'string' && rawLocales.trim()
      ? rawLocales.split(',').map((s) => s.trim()).filter(Boolean)
      : [null]);

  const sharedContext = {
    siteToken,
    storeUrl,
    contentUrl,
    configName,
    configSheet,
    logger,
    counts,
    categoryPathFormat,
    categoriesTemplate,
    aioLibs,
    logLevel,
    logIngestorEndpoint,
  };

  const timings = new Timings();
  const adminApi = new AdminAPI({ org, site }, sharedContext, { authToken: adminAuthToken });
  const { filesLib } = aioLibs;

  logger.info(`Starting category poll from ${storeUrl} for locales ${locales}`);

  try {
    await adminApi.startProcessing();

    const results = await Promise.all(locales.map(async (locale) => {
      const localeTimings = new Timings();
      const context = { ...sharedContext, startTime: new Date() };
      if (locale) context.locale = locale;

      const state = await loadState(locale, aioLibs);
      const categoriesFileName = getFileLocation(`${locale || 'default'}-categories`, 'json');
      let discovered = [];
      try {
        discovered = JSON.parse((await filesLib.read(categoriesFileName)).toString());
      } catch (e) {
        throw new JobFailedError(
          `Missing categories list at ${categoriesFileName}. Run fetch-all-categories first.`,
          ERROR_CODES.VALIDATION_ERROR,
          400,
        );
      }

      discovered.forEach((category) => {
        if (!state.categories[category.urlPath]) {
          state.categories[category.urlPath] = { lastRenderedAt: new Date(0), hash: null };
        }
      });
      localeTimings.sample('get-discovered-categories');

      const byUrlPath = new Map(discovered.map((c) => [c.urlPath, c]));
      const remainingUrlPaths = Object.keys(state.categories);
      const pendingBatches = createBatches(discovered).map((batch, batchNumber) => {
        return Promise.all(batch.map(async (category) => {
          const path = getCategoryUrl(category, context, false);
          const currentHash = state.categories[category.urlPath]?.hash || null;
          let newHash = null;
          let renderedAt = null;
          try {
            const html = await generateCategoryHtml(category, context, { byUrlPath });
            renderedAt = new Date();
            newHash = crypto.createHash('sha256').update(html).digest('hex');
            counts.rendered += 1;

            if (shouldPreviewAndPublish({ currentHash, newHash }) && html) {
              try {
                const htmlPath = getCategoryMarkupPath(path);
                await filesLib.write(htmlPath, html);
                logger.debug(`Saved category HTML ${htmlPath}`);
              } catch (writeErr) {
                // Mirror PDP: do not preview/publish if overlay markup was not saved
                newHash = null;
                counts.failed += 1;
                logger.error(`Error saving HTML for category ${category.urlPath}:`, writeErr);
              }
            } else if (!shouldPreviewAndPublish({ currentHash, newHash })) {
              counts.ignored += 1;
            }
          } catch (e) {
            newHash = null;
            logger.error(`Error rendering category ${category.urlPath}`, e);
            counts.failed += 1;
          }

          // remove from remaining (= still exists)
          const idx = remainingUrlPaths.indexOf(category.urlPath);
          if (idx !== -1) remainingUrlPaths.splice(idx, 1);

          return {
            ...category,
            path,
            sku: category.urlPath, // AdminAPI records historically use sku
            urlPath: category.urlPath,
            currentHash,
            newHash,
            renderedAt,
          };
        })).then(async (enriched) => {
          const toPublish = enriched.filter(shouldPreviewAndPublish);
          // update ignored hashes/timestamps so we don't thrash
          const ignored = enriched.filter((c) => !shouldPreviewAndPublish(c) && c.newHash);
          if (ignored.length) {
            ignored.forEach((category) => {
              state.categories[category.urlPath] = {
                lastRenderedAt: category.renderedAt,
                hash: category.newHash,
              };
            });
            await saveState(state, aioLibs);
          }

          if (!toPublish.length) return null;

          const records = toPublish.map(({ sku, path, renderedAt, urlPath }) => ({
            sku, path, renderedAt, urlPath,
          }));

          try {
            const publishedBatch = await adminApi.previewAndPublish(records, locale, batchNumber + 1);
            await processPublishedBatch(publishedBatch, state, counts, toPublish);
            await saveState(state, aioLibs);
            return publishedBatch;
          } catch (error) {
            if (error.code === ERROR_CODES.BATCH_ERROR) {
              logger.warn(`Category batch ${batchNumber + 1} failed, continuing`, {
                error: error.message,
              });
              counts.failed += toPublish.length;
              return { failed: true };
            }
            throw error;
          }
        });
      });

      await Promise.all(pendingBatches);
      localeTimings.sample('published-categories');

      if (remainingUrlPaths.length) {
        await processDeletedCategories(remainingUrlPaths, state, context, adminApi);
        localeTimings.sample('unpublished-categories');
      } else {
        localeTimings.sample('unpublished-categories', 0);
      }

      return localeTimings.measures;
    }));

    await adminApi.stopProcessing();
    timings.sample('done');

    return {
      state: 'completed',
      counts,
      timings: {
        total: timings.measures,
        locales: results,
      },
    };
  } catch (e) {
    try {
      await adminApi.stopProcessing();
    } catch {
      // ignore
    }
    throw e;
  }
}

module.exports = {
  poll,
  loadState,
  saveState,
  BATCH_SIZE,
};
