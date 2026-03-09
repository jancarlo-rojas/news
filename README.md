# User Auth

A minimal full-stack login and registration system built with Node.js, Express, MongoDB, and JWT.

---

## Project Structure

```
User Auth/
├── server.js            # Express app entry point
├── package.json
├── .env                 # Environment variables (create from .env.example)
├── models/
│   └── User.js          # Mongoose user schema
├── routes/
│   ├── auth.js          # POST /api/auth/register, /login, /logout
│   └── dashboard.js     # GET  /api/dashboard (protected)
└── public/
    ├── login.html        # Login page
    ├── register.html     # Registration page
    ├── dashboard.html    # Protected dashboard page
    └── styles.css        # Black & white minimal styles
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [MongoDB](https://www.mongodb.com/try/download/community) running locally, **or** a free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster

---

## Installation

### 1. Install dependencies

```bash
cd "User Auth"
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your values:

```bash
copy .env.example .env
```

Open `.env` and set:

| Variable     | Description                                     |
|--------------|-------------------------------------------------|
| `MONGO_URI`  | MongoDB connection string                       |
| `JWT_SECRET` | A long, random secret string (keep it private)  |
| `PORT`       | Port to run the server on (default: `3000`)     |
| `NODE_ENV`   | `development` or `production`                   |

### 3. Start the server

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Open your browser at **http://localhost:3000/login.html**

---

## How Authentication Works

1. **Registration** — The user submits a username, email, and password. The password is hashed with `bcrypt` (12 salt rounds) before being stored in MongoDB. The plain-text password is never saved.

2. **Login** — The server looks up the user by email and uses `bcrypt.compare` to verify the password. If valid, a JWT is signed with `jsonwebtoken` and sent to the browser as an **httpOnly cookie** (inaccessible to JavaScript, preventing XSS theft).

3. **Protected routes** — Every request to `/api/dashboard` must carry the JWT cookie. The `verifyToken` middleware calls `jwt.verify` to validate and decode it. If the token is missing or expired, the server returns `401` and the client is redirected to the login page.

4. **Logout** — The server clears the JWT cookie. The next request to a protected route will fail authentication and redirect to login.

---

## Switching to MongoDB Atlas (cloud)

1. Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/atlas).
2. Whitelist your IP address in **Network Access**.
3. Create a database user in **Database Access**.
4. Copy the connection string from **Connect → Drivers** and paste it into `.env`:

```
MONGO_URI=mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/userauth?retryWrites=true&w=majority
```

No other code changes are required.
