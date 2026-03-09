const mongoose = require('mongoose');

/**
 * Immutable audit trail — every significant user action is recorded here.
 * Documents are never updated in place; only new entries are created.
 */
const auditLogSchema = new mongoose.Schema(
  {
    // Who
    userId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    username: { type: String, default: 'anonymous' },

    // What
    action: {
      type: String,
      required: true,
      enum: [
        // Auth
        'register', 'register_failed',
        'login', 'login_failed',
        'logout',
        // News
        'source_added', 'source_deleted', 'feed_fetched', 'article_saved',
        // Chat
        'message_sent',
      ],
      index: true,
    },

    // Context
    ip:        { type: String },
    userAgent: { type: String },
    meta:      { type: mongoose.Schema.Types.Mixed },  // action-specific detail
    ok:        { type: Boolean, default: true },        // did it succeed?
  },
  {
    timestamps: true,
    // Prevent accidental modification
    strict: true,
  }
);

// TTL — auto-delete audit entries older than 1 year (adjust as needed)
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
