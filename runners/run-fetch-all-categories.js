require('dotenv').config();
const { main } = require('../actions/fetch-all-categories/index');

(async () => {
  try {
    console.log(new Date().toISOString(), 'Starting fetch-all-categories');
    const resp = await main({
      libInit: {
        ow: {
          namespace: process.env.AIO_runtime_namespace,
          auth: process.env.AIO_runtime_auth,
        },
      },
      SITE: process.env.SITE,
      ORG: process.env.ORG,
      CONTENT_URL: process.env.CONTENT_URL,
      CONFIG_NAME: process.env.CONFIG_NAME || 'config',
      CONFIG_SHEET: process.env.CONFIG_SHEET,
      STORE_URL: process.env.STORE_URL,
      LOG_LEVEL: 'info',
      LOG_INGESTOR_ENDPOINT: process.env.LOG_INGESTOR_ENDPOINT,
      LOCALES: process.env.LOCALES,
      CATEGORY_PAGE_URL_FORMAT: process.env.CATEGORY_PAGE_URL_FORMAT || '/categories/{urlPath}',
      CATEGORIES_TEMPLATE: process.env.CATEGORIES_TEMPLATE,
      ROOT_CATEGORY_ID: process.env.ROOT_CATEGORY_ID || '2',
      CATEGORY_DEPTH: process.env.CATEGORY_DEPTH || '4',
    });
    console.log(JSON.stringify(resp, null, 2));
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    console.log(new Date().toISOString(), 'Finishing fetch-all-categories');
  }
})();
