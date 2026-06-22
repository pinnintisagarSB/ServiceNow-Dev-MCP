import 'dotenv/config';

function require_env(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}. Check your .env file.`);
  return val;
}

// Use getters so every connector constructor reads process.env at call time,
// not at module load time. This lets getJira()/getSn()/getSf() inject
// per-session credentials via process.env before constructing a connector.
export const config = {
  get servicenow() {
    return {
      instanceUrl:  process.env.SN_INSTANCE_URL,
      username:     process.env.SN_USERNAME,
      password:     process.env.SN_PASSWORD,
      useSdkAuth:   process.env.SN_USE_SDK_AUTH === 'true',
      scopeType:    process.env.SN_SCOPE_TYPE ?? 'global',
      scopePrefix:  process.env.SN_SCOPE_PREFIX ?? 'u',
      scopeAppName: process.env.SN_SCOPE_APP_NAME ?? '',
    };
  },
  get salesforce() {
    return {
      loginUrl:      process.env.SF_LOGIN_URL ?? 'https://login.salesforce.com',
      clientId:      process.env.SF_CLIENT_ID,
      clientSecret:  process.env.SF_CLIENT_SECRET,
      username:      process.env.SF_USERNAME,
      password:      process.env.SF_PASSWORD,
      securityToken: process.env.SF_SECURITY_TOKEN ?? '',
      apiVersion:    process.env.SF_API_VERSION ?? 'v59.0',
      jwtKey:        process.env.SF_JWT_PRIVATE_KEY ?? '',
      jwtSubject:    process.env.SF_JWT_SUBJECT ?? '',
      bulkThreshold: parseInt(process.env.SF_BULK_THRESHOLD ?? '50000', 10),
    };
  },
  get jira() {
    return {
      baseUrl:  process.env.JIRA_BASE_URL,
      email:    process.env.JIRA_EMAIL,
      apiToken: process.env.JIRA_API_TOKEN,
      pageSize: parseInt(process.env.JIRA_PAGE_SIZE ?? '50', 10),
    };
  },
  get migration() {
    return {
      pageSize:             parseInt(process.env.MIGRATION_PAGE_SIZE ?? '200', 10),
      testLimit:            parseInt(process.env.MIGRATION_TEST_LIMIT ?? '10', 10),
      stopOnError:          process.env.MIGRATION_STOP_ON_ERROR === 'true',
      runBusinessRules:     process.env.MIGRATION_RUN_BUSINESS_RULES !== 'false',
      enforceMandatory:     process.env.MIGRATION_ENFORCE_MANDATORY !== 'false',
      maxParallelImportSets: parseInt(process.env.SN_MAX_PARALLEL_IMPORT_SETS ?? '5', 10),
    };
  },
};

export function validateConfig(platform) {
  if (platform === 'salesforce') {
    ['SF_CLIENT_ID','SF_CLIENT_SECRET','SF_USERNAME','SF_PASSWORD'].forEach(require_env);
  }
  if (platform === 'jira') {
    ['JIRA_BASE_URL','JIRA_EMAIL','JIRA_API_TOKEN'].forEach(require_env);
  }
  if (!process.env.SN_INSTANCE_URL) {
    throw new Error('SN_INSTANCE_URL is required in .env');
  }
}
