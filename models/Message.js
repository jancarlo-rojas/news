const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    from:   { type: String, required: true },
    to:     { type: String, required: true },
    roomId: { type: String, required: true, index: true },
    text:   { type: String, required: true, maxlength: 2000 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Message', messageSchema);
