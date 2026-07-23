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

const { Core, Files } = require('@adobe/aio-sdk');
const { ObservabilityClient } = require('../lib/observability');
const { getRuntimeConfig } = require('../lib/runtimeConfig');
const { AdminAPI } = require('../lib/aem');
const {
  createBatches,
  getCategoryUrl,
  getCategoryMarkupPath,
  CATEGORY_FILE_PREFIX,
} = require('../utils');

/**
 * Cleanup unpublished/deleted category markup.
 * Mirrors mark-up-clean-up for products, using the discovered categories list
 * as the source of truth.
 */
async function markUpCategoryCleanUp(context, filesLib, logger, adminApi) {
  const localePrefix = context.locale || 'default';
  const categoriesFileName = `${CATEGORY_FILE_PREFIX}/${localePrefix}-categories.json`;

  let liveCategories = [];
  try {
    liveCategories = JSON.parse((await filesLib.read(categoriesFileName)).toString());
  } catch (e) {
    logger.warn(`No categories list found at ${categoriesFileName}; skipping cleanup`);
    return { ...context.counts };
  }

  const livePaths = new Set(
    liveCategories.map((category) => getCategoryUrl(category, context, false)),
  );

  // List stored category markup under shared overlay root
  let storedFiles = [];
  try {
    storedFiles = await filesLib.list('/public/pdps/categories');
  } catch (e) {
    logger.warn('Unable to list /public/pdps/categories', e);
    return { ...context.counts };
  }

  const redundant = [];
  for (const file of storedFiles || []) {
    const name = file.name || file;
    if (!String(name).endsWith('.html')) continue;

    // Convert storage path -> content path
    // /public/pdps/categories/gear/bags.html -> /categories/gear/bags
    const relative = String(name)
      .replace(/^\/public\/pdps/, '')
      .replace(/\.html$/, '');
    if (!livePaths.has(relative)) {
      redundant.push({
        path: relative,
        sku: relative.replace(/^\/categories\//, ''),
        urlPath: relative.replace(/^\/categories\//, ''),
        storagePath: name.startsWith('/') ? name : `/${name}`,
      });
    }
  }

  context.counts.detected = redundant.length;

  for (const item of redundant) {
    try {
      const result = await filesLib.delete(item.storagePath || getCategoryMarkupPath(item.path));
      if (result?.length > 0 || result === undefined) {
        logger.info(`Deleted redundant category markup at ${item.path}`);
        context.counts.deleted += 1;
      }
    } catch (e) {
      if (e.code !== 'ERROR_FILE_NOT_EXISTS') {
        logger.error('Error while cleaning category markup storage', e);
      }
    }
  }

  const pendingJobs = [];
  const batches = createBatches(redundant);
  for (let batchNumber = 0; batchNumber < batches.length; batchNumber += 1) {
    const batch = batches[batchNumber].map((item) => ({
      sku: item.sku,
      path: item.path,
      urlPath: item.urlPath,
    }));
    pendingJobs.push(adminApi.unpublishAndDelete(batch, context.locale, batchNumber));
    context.counts.unpublished += batch.length;
  }
  await Promise.all(pendingJobs);

  return { ...context.counts };
}

async function main(params) {
  const cfg = getRuntimeConfig(params, { validateToken: true });
  const logger = Core.Logger('main', { level: cfg.logLevel || 'info' });
  const observabilityClient = new ObservabilityClient(logger, {
    token: cfg.adminAuthToken,
    endpoint: cfg.logIngestorEndpoint,
    org: cfg.org,
    site: cfg.site,
  });
  const filesLib = await Files.init(params.libInit || {});

  const counts = { detected: 0, deleted: 0, unpublished: 0 };
  const sharedContext = {
    storeUrl: cfg.storeUrl,
    contentUrl: cfg.contentUrl,
    configName: cfg.configName,
    configSheet: cfg.configSheet,
    logger,
    counts,
    categoryPathFormat: cfg.categoryPathFormat,
    categoriesTemplate: cfg.categoriesTemplate,
    logLevel: cfg.logLevel,
    logIngestorEndpoint: cfg.logIngestorEndpoint,
  };

  const adminApi = new AdminAPI(
    { org: params.ORG || cfg.org, site: params.SITE || cfg.site },
    sharedContext,
    { authToken: cfg.adminAuthToken },
  );

  const activationResult = { status: {} };

  try {
    adminApi.startProcessing();

    for (const locale of cfg.locales) {
      const context = { ...sharedContext, startTime: new Date() };
      let tempLocale = 'default';
      if (locale) {
        context.locale = locale;
        tempLocale = locale;
      }
      activationResult.status[tempLocale] = await markUpCategoryCleanUp(
        context,
        filesLib,
        logger,
        adminApi,
      );
    }

    await observabilityClient.sendActivationResult(activationResult);
    return activationResult;
  } catch (e) {
    logger.error(e);
    throw e;
  } finally {
    await adminApi.stopProcessing();
  }
}

exports.main = main;
