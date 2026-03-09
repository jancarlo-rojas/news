const AuditLog = require('../models/AuditLog');

/**
 * Fire-and-forget audit logger.
 * Call this anywhere a significant action occurs — it never throws.
 *
 * @param {string} action  - One of the AuditLog action enum values
 * @param {object} req     - Express request (optional — pass null from sockets)
 * @param {object} extra   - { userId, username, meta, ok }
 */
async function audit(action, req, extra = {}) {
  try {
    await AuditLog.create({
      action,
      userId:    extra.userId   || null,
      username:  extra.username || 'anonymous',
      ip:        req ? (req.ip || req.connection?.remoteAddress) : extra.ip,
      userAgent: req ? req.get('User-Agent') : extra.userAgent,
      meta:      extra.meta  || undefined,
      ok:        extra.ok    !== undefined ? extra.ok : true,
    });
  } catch (err) {
    // Never let audit failure affect the main request
    console.error('[audit] Failed to write log:', err.message);
  }
}

module.exports = { audit };
