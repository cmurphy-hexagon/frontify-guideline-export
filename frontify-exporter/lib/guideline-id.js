const { exitWithError } = require('./errors');

function guidelineIdFromN(n) {
  return Buffer.from(JSON.stringify({ identifier: n, type: 'guideline' })).toString('base64');
}

function validateGuidelineIdOrExit(guidelineId) {
  let decoded;
  try {
    decoded = Buffer.from(String(guidelineId), 'base64').toString('utf8');
  } catch (_error) {
    exitWithError('Error: --guideline must be a valid base64 string.');
  }

  try {
    const parsed = JSON.parse(decoded);
    if (!parsed || parsed.type !== 'guideline' || !Number.isInteger(parsed.identifier) || parsed.identifier <= 0) {
      throw new Error('invalid shape');
    }
  } catch (_error) {
    exitWithError('Error: --guideline must decode to JSON like {"identifier": <positive int>, "type": "guideline"}.');
  }
}

module.exports = {
  guidelineIdFromN,
  validateGuidelineIdOrExit
};
