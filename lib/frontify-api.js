const https = require('https');
const {
  ASSET_PAGE_SIZE,
  LIBRARY_PAGE_SIZE,
  DEFAULT_GUIDELINE_SEARCH_MAX_N,
  HTTP_TIMEOUT_MS
} = require('./constants');
const { guidelineIdFromN } = require('./guideline-id');
const { exitWithError } = require('./errors');

async function probeGraphQLEndpoint(domain, token) {
  console.log('Probing GraphQL endpoint at /graphql...');
  const data = await graphqlRequest(domain, token, 'query Probe { __typename }');
  const typename = data && data.__typename;
  if (!typename) {
    throw new Error('Probe succeeded but __typename was missing in response data.');
  }
  console.log(`GraphQL probe succeeded (root type: ${typename})\n`);
}

async function graphqlRequest(domain, token, query, variables = {}) {
  const payload = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: domain,
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-frontify-beta': 'enabled',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const statusCode = res.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP ${statusCode} from /graphql: ${String(data).slice(0, 500)}`));
            return;
          }

          try {
            const parsed = JSON.parse(data);
            if (parsed.errors) {
              const messages = Array.isArray(parsed.errors)
                ? parsed.errors.map((err) => (err && err.message ? err.message : JSON.stringify(err))).join('; ')
                : JSON.stringify(parsed.errors);
              reject(new Error(`GraphQL errors: ${messages}`));
            } else {
              resolve(parsed.data);
            }
          } catch (_error) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`Request timeout after ${HTTP_TIMEOUT_MS}ms`));
    });
    req.write(payload);
    req.end();
  });
}

function getAssetFragmentFields() {
  return `
    ... on Image {
      filename
      extension
      downloadUrl
      previewUrl
      width
      height
    }
    ... on Video {
      filename
      extension
      downloadUrl
      previewUrl
      width
      height
      duration
    }
    ... on Document {
      filename
      extension
      downloadUrl
      previewUrl
      pageCount
    }
    ... on Audio {
      filename
      extension
      downloadUrl
      previewUrl
    }
    ... on File {
      filename
      extension
      downloadUrl
      previewUrl
    }
  `;
}

function isMissingNodeError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /could not resolve|not found|no such|invalid id|cannot query field/i.test(message);
}

async function fetchGuidelineName(domain, token, n) {
  const id = guidelineIdFromN(n);
  const query = `
    query GuidelineName($id: ID!) {
      node(id: $id) {
        ... on Guideline {
          name
        }
      }
    }
  `;

  try {
    const data = await graphqlRequest(domain, token, query, { id });
    const name = data && data.node && data.node.name;
    return name ? { n, id, name } : null;
  } catch (error) {
    if (isMissingNodeError(error)) {
      return null;
    }
    throw error;
  }
}

async function resolveGuidelineIdByName(domain, token, targetName) {
  const normalizedTarget = targetName.trim().toLowerCase();
  const found = [];

  console.log(`Searching for guideline named "${targetName}"...\n`);

  for (let n = 1; n <= DEFAULT_GUIDELINE_SEARCH_MAX_N; n++) {
    const result = await fetchGuidelineName(domain, token, n);
    if (result) {
      found.push(result);
      if (result.name.trim().toLowerCase() === normalizedTarget) {
        console.log(`Found: "${result.name}" (identifier=${n})\n`);
        return result.id;
      }
    }
  }

  const foundList = found.length
    ? `\nGuidelines found during search:\n${found.map((r) => `  ${r.n}: "${r.name}"`).join('\n')}`
    : '\nNo guidelines were found during search.';

  exitWithError(`Error: No guideline named "${targetName}" found.${foundList}`);
}

async function fetchGuidelineLibraries(domain, token, guidelineId, maxLibraries) {
  const query = `
    query GuidelineLibraries($guidelineId: ID!, $page: Int!, $limit: Int!) {
      node(id: $guidelineId) {
        ... on Guideline {
          id
          name
          url
          defaultLanguage {
            name
            code
          }
          libraryPages(limit: $limit, page: $page) {
            total
            hasNextPage
            items {
              id
              title
              type
              assets(limit: 1, page: 1) {
                total
              }
            }
          }
        }
      }
    }
  `;

  let page = 1;
  let hasNextPage = true;
  let guidelineInfo = null;
  const libraries = [];

  while (hasNextPage && (!maxLibraries || libraries.length < maxLibraries)) {
    const data = await graphqlRequest(domain, token, query, {
      guidelineId,
      page,
      limit: LIBRARY_PAGE_SIZE
    });
    const guideline = data.node;

    if (!guideline) {
      throw new Error('Guideline not found');
    }

    if (!guidelineInfo) {
      guidelineInfo = {
        id: guideline.id,
        name: guideline.name,
        url: guideline.url,
        defaultLanguage: guideline.defaultLanguage,
        libraryTotal: guideline.libraryPages.total
      };
    }

    const mapped = (guideline.libraryPages.items || []).map((item) => ({
      id: item.id,
      title: item.title || 'Untitled Library',
      type: item.type || 'UNKNOWN',
      assetTotal: item.assets && typeof item.assets.total === 'number' ? item.assets.total : 0
    }));

    libraries.push(...mapped);
    hasNextPage = Boolean(guideline.libraryPages.hasNextPage);
    page++;
  }

  if (maxLibraries && libraries.length > maxLibraries) {
    libraries.length = maxLibraries;
  }

  return {
    guidelineInfo,
    libraries
  };
}

async function fetchLibraryAssets(domain, token, libraryId, maxAssetsPerLibrary) {
  const query = `
    query LibraryAssets($libraryId: ID!, $page: Int!, $limit: Int!) {
      node(id: $libraryId) {
        __typename
        ... on LibraryPage {
          id
          title
          type
          assets(page: $page, limit: $limit) {
            total
            page
            limit
            hasNextPage
            items {
              __typename
              id
              title
              ${getAssetFragmentFields()}
              attachments {
                id
                filename
                extension
                size
                downloadUrl
              }
            }
          }
        }
      }
    }
  `;

  let page = 1;
  let hasNextPage = true;
  let assets = [];
  let libraryMeta = null;

  while (hasNextPage && (!maxAssetsPerLibrary || assets.length < maxAssetsPerLibrary)) {
    const data = await graphqlRequest(domain, token, query, {
      libraryId,
      page,
      limit: ASSET_PAGE_SIZE
    });

    const node = data.node;
    if (!node || node.__typename !== 'LibraryPage') {
      throw new Error(`Node ${libraryId} is not a LibraryPage`);
    }

    if (!libraryMeta) {
      libraryMeta = {
        id: node.id,
        title: node.title,
        type: node.type
      };
    }

    assets = assets.concat(node.assets.items || []);
    if (maxAssetsPerLibrary && assets.length >= maxAssetsPerLibrary) {
      assets = assets.slice(0, maxAssetsPerLibrary);
      hasNextPage = false;
      break;
    }

    hasNextPage = Boolean(node.assets.hasNextPage);
    page++;
  }

  return { libraryMeta, assets };
}

module.exports = {
  probeGraphQLEndpoint,
  graphqlRequest,
  fetchGuidelineName,
  resolveGuidelineIdByName,
  fetchGuidelineLibraries,
  fetchLibraryAssets
};
