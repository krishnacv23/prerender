require('dotenv').config();
const { main } = require('../actions/mark-up-category-clean-up/index');

(async () => {
  try {
    console.log(new Date().toISOString(), 'Starting mark-up-category-clean-up');
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
      STORE_URL: process.env.STORE_URL,
      LOG_LEVEL: 'info',
      LOG_INGESTOR_ENDPOINT: process.env.LOG_INGESTOR_ENDPOINT,
      LOCALES: process.env.LOCALES,
      CATEGORY_PAGE_URL_FORMAT: process.env.CATEGORY_PAGE_URL_FORMAT || '/categories/{urlPath}',
      CATEGORIES_TEMPLATE: process.env.CATEGORIES_TEMPLATE,
      AEM_ADMIN_API_AUTH_TOKEN: process.env.AEM_ADMIN_API_AUTH_TOKEN,
      SITE_TOKEN: process.env.SITE_TOKEN,
    });
    console.log(JSON.stringify(resp, null, 2));
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    console.log(new Date().toISOString(), 'Finishing mark-up-category-clean-up');
  }
})();
