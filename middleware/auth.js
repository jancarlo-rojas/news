const jwt = require('jsonwebtoken');

/**
 * Express middleware — verifies the JWT stored in the httpOnly cookie.
 * Attaches decoded payload to req.user on success.
 */
function verifyToken(req, res, next) {
  const token = req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

module.exports = { verifyToken };
